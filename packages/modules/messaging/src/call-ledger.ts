// The worker's side of the call ledger: placing a requested call, ending one, recording
// each progress report, and the legs a call adds. The provider is reached only through the
// CallProvider port the worker composes; this file never opens credentials. Every paid
// request is preceded by a reservation, and a reservation whose answer was lost becomes
// "unknown": the call is never placed a second time by itself.
import { defineTask, type Task } from '@repo/commands';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import type { Permission } from '@repo/contracts';
import { sql } from 'kysely';

import { checkCall, endCallReference, placeCallReference } from './call-requests.js';
import { lockBusiness } from './outbound.js';
import type { VoiceCallStatus } from './voice/twilio-voice.js';
import { advanceVoiceProgress, type VoiceProgress } from './voice/voice-progress.js';
import { voiceIdentity } from './voice/voice-identity.js';
import type { VoiceTerminal } from './voice/voice-terminal.js';

/**
 * What the worker hands the provider for a reserved call: the person's browser is rung first
 * (the root leg), and once it answers, the other party (the child leg) is dialed.
 */
export interface PlacedCall {
  readonly callId: string;
  /** The root leg, to the person's browser. */
  readonly legId: string;
  /** The child leg, to the other party; stored before the call so its reports can name it. */
  readonly remoteLegId: string;
  readonly connectionId: string;
  /** The business's number, E.164. */
  readonly from: string;
  /** The other party, E.164. */
  readonly to: string;
  /** The member who asked for the call. */
  readonly userId: string;
  /** The browser identity the root leg rings. */
  readonly identity: string;
}
export interface EndedCall {
  readonly callId: string;
  readonly connectionId: string;
  readonly providerCallId: string;
  /** Twilio: canceled ends a queued or ringing call, completed one in progress. */
  readonly status: 'canceled' | 'completed';
}
export type CallProviderResult =
  | {
      readonly outcome: 'accepted';
      readonly providerCallId: string;
      readonly status: VoiceCallStatus;
    }
  | { readonly outcome: 'rejected'; readonly code: number | null }
  | { readonly outcome: 'unknown' };

/**
 * Worker-only port to the provider (twilio-voice.ts behind it). A thrown error counts as
 * unknown: the provider may have acted, so nothing is repeated.
 */
export interface CallProvider {
  place(call: PlacedCall, context: TenantContext): Promise<CallProviderResult>;
  end(call: EndedCall, context: TenantContext): Promise<CallProviderResult>;
}

/** Composition supplies the canonical tenancy reader; a queued command is not a grant. */
export type ReadCallGrants = (
  trx: DatabaseTransaction,
  context: TenantContext,
  userId: string,
) => Promise<ReadonlySet<Permission> | undefined>;

const terminal = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const outcomeOf = {
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
} as const;
const providerStatuses: readonly string[] = [
  'queued',
  'initiated',
  'ringing',
  'in-progress',
  ...terminal,
];
const isProviderStatus = (status: string): status is VoiceProgress['status'] =>
  providerStatuses.includes(status);
const isOutcomeStatus = (status: string): status is keyof typeof outcomeOf =>
  Object.hasOwn(outcomeOf, status);

/** The call's own row, locked for the rest of the transaction. */
function lockCall(trx: DatabaseTransaction, callId: string) {
  return trx
    .selectFrom('messaging.calls')
    .selectAll()
    .where('id', '=', callId)
    .forUpdate()
    .executeTakeFirst();
}
/** The same, for a call a leg or a reservation already proves exists. */
const lockKnownCall = (trx: DatabaseTransaction, callId: string) =>
  trx
    .selectFrom('messaging.calls')
    .selectAll()
    .where('id', '=', callId)
    .forUpdate()
    .executeTakeFirstOrThrow();

const active = ['reserved', 'unknown', 'dialing', 'ringing', 'connected'];

async function markConflict(trx: DatabaseTransaction, callId: string, legId: string) {
  await trx
    .updateTable('messaging.call_legs')
    .set({ conflict_at: sql<Date>`coalesce(conflict_at, now())` })
    .where('id', '=', legId)
    .execute();
  await trx
    .updateTable('messaging.calls')
    .set({ needs_reconciliation: true })
    .where('id', '=', callId)
    .execute();
}

/**
 * Brings a call's state in line with its legs. A call connects only when the party it is
 * for answers: the other party for an outbound call, a member for an inbound one (the
 * provider answers an inbound call itself to give it instructions). It ends, with its
 * outcome, when its first leg ends. Delayed child reports can correct a missed outcome.
 */
export async function deriveCallState(trx: DatabaseTransaction, callId: string): Promise<void> {
  const call = await lockKnownCall(trx, callId);
  if (!active.includes(call.state) && call.state !== 'ended') return;
  const legs = await trx
    .selectFrom('messaging.call_legs')
    .select(['parent_leg_id', 'party', 'status', 'answered_at', 'provider_call_sid'])
    .where('call_id', '=', callId)
    .execute();
  const root = legs.find((leg) => leg.parent_leg_id === null);
  const wanted = call.direction === 'outbound' ? 'remote' : 'member';
  const answering = legs.filter((leg) => leg.party === wanted);
  const connected =
    call.connected_at !== null ||
    // Completed proves a connection even when the answered callback was lost or delayed.
    // https://www.twilio.com/docs/voice/api/call-resource#notice-about-completed-calls
    answering.some(
      (leg) => ['in-progress', 'completed'].includes(leg.status) || leg.answered_at !== null,
    );
  const status = root?.status ?? 'reserved';
  let next: { state: string; outcome?: string };
  if (isOutcomeStatus(status)) {
    // An outbound call that never connected ends as the other party's leg did (busy, no
    // answer); if they were never dialed, a browser leg that "completed" still failed.
    // Only a leg the provider reported on counts: one closed here was never dialed.
    const remoteEnd = answering
      .filter((leg) => leg.provider_call_sid !== null)
      .map((leg) => leg.status)
      .find(isOutcomeStatus);
    const outbound =
      remoteEnd !== undefined
        ? outcomeOf[remoteEnd]
        : status === 'completed'
          ? 'failed'
          : outcomeOf[status];
    next = {
      state: 'ended',
      // An inbound call nobody here answered was missed, however the caller left it.
      outcome: connected
        ? 'completed'
        : call.direction === 'outbound'
          ? outbound
          : status === 'failed'
            ? outcomeOf[status]
            : 'no_answer',
    };
  } else if (connected) next = { state: 'connected' };
  else if (call.direction === 'inbound' || answering.some((leg) => leg.status === 'ringing'))
    next = { state: 'ringing' };
  else if (isProviderStatus(status)) next = { state: 'dialing' };
  else next = { state: call.state };
  await trx
    .updateTable('messaging.calls')
    .set({
      state: next.state,
      outcome: next.outcome ?? null,
      connected_at: connected ? sql<Date>`coalesce(connected_at, now())` : null,
      ended_at: next.state === 'ended' ? sql<Date>`coalesce(ended_at, now())` : null,
    })
    .where('id', '=', callId)
    .execute();
  // A leg stored for a dial that never happened is closed with the call.
  if (next.state === 'ended')
    await trx
      .updateTable('messaging.call_legs')
      .set({ status: 'canceled', ended_at: sql<Date>`now()` })
      .where('call_id', '=', callId)
      .where('parent_leg_id', 'is not', null)
      .where('status', '=', 'reserved')
      .where('provider_call_sid', 'is', null)
      .execute();
}

/** Records the provider's answer to placing the call's first leg. */
async function settlePlacement(
  trx: DatabaseTransaction,
  placed: PlacedCall,
  result: CallProviderResult,
): Promise<void> {
  await lockKnownCall(trx, placed.callId);
  const leg = await trx
    .selectFrom('messaging.call_legs')
    .select(['id', 'status', 'provider_call_sid'])
    .where('id', '=', placed.legId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  // A progress report that came first is the later word on the leg's status.
  const untouched = leg.status === 'reserved' || leg.status === 'unknown';
  if (result.outcome === 'unknown') {
    if (!untouched) return;
    await trx
      .updateTable('messaging.call_legs')
      .set({ status: 'unknown' })
      .where('id', '=', leg.id)
      .execute();
    await trx
      .updateTable('messaging.calls')
      .set({ state: 'unknown' })
      .where('id', '=', placed.callId)
      .where('state', '=', 'reserved')
      .execute();
    return;
  }
  if (result.outcome === 'rejected') {
    // The provider reported progress for a leg it now says it never created: check it.
    if (!untouched) {
      await markConflict(trx, placed.callId, leg.id);
      return;
    }
    await trx
      .updateTable('messaging.call_legs')
      .set({ status: 'rejected', ended_at: sql<Date>`now()` })
      .where('id', '=', leg.id)
      .execute();
    await trx
      .updateTable('messaging.calls')
      .set({
        state: 'rejected',
        failure_code: 'provider_rejected',
        provider_error_code: result.code,
        ended_at: sql<Date>`now()`,
      })
      .where('id', '=', placed.callId)
      .execute();
    return;
  }
  const taken = await trx
    .selectFrom('messaging.call_legs')
    .select('id')
    .where('provider_connection_id', '=', placed.connectionId)
    .where('provider_call_sid', '=', result.providerCallId)
    .where('id', '<>', leg.id)
    .executeTakeFirst();
  if (
    taken !== undefined ||
    (leg.provider_call_sid !== null && leg.provider_call_sid !== result.providerCallId)
  ) {
    await markConflict(trx, placed.callId, leg.id);
    return;
  }
  await trx
    .updateTable('messaging.call_legs')
    .set({
      provider_call_sid: result.providerCallId,
      provider_direction: sql<string>`coalesce(provider_direction, 'outbound-api')`,
      status: untouched ? result.status : sql<string>`status`,
      ended_at: sql<Date | null>`case when status in ('reserved','unknown') and ${terminal.has(result.status)} then now() else ended_at end`,
    })
    .where('id', '=', leg.id)
    .execute();
  await deriveCallState(trx, placed.callId);
}

export function createPlaceCallTask(
  provider: CallProvider,
  readGrants: ReadCallGrants,
): Task<typeof placeCallReference.data> {
  return defineTask({
    ...placeCallReference,
    async run({ callId }, { invocation, services }) {
      const placed = await withTenant(services.db, invocation.context, async (trx) => {
        const businessId = await lockBusiness(trx, invocation.context);
        const call = await lockCall(trx, callId);
        if (call === undefined) return null;
        if (call.state === 'reserved') {
          // A run before this one reserved the call and never recorded the answer. The
          // provider may have it, so it is unknown, and it is not placed again.
          await trx
            .updateTable('messaging.call_legs')
            .set({ status: 'unknown' })
            .where('call_id', '=', call.id)
            .where('status', '=', 'reserved')
            .execute();
          await trx
            .updateTable('messaging.calls')
            .set({ state: 'unknown' })
            .where('id', '=', call.id)
            .execute();
          return null;
        }
        if (call.state !== 'requested' || call.direction !== 'outbound') return null;
        const checked = await checkCall(
          trx,
          {
            contactIdentityId: call.contact_identity_id,
            phoneNumberId: call.phone_number_id,
            userId: call.user_id,
          },
          {
            remoteE164: call.remote_e164 ?? '',
            localE164: call.local_e164,
            connectionId: call.provider_connection_id,
          },
        );
        const permitted =
          !('refusal' in checked) &&
          (await readGrants(trx, invocation.context, checked.facts.userId))?.has('calls.place') ===
            true;
        if ('refusal' in checked || !permitted) {
          await trx
            .updateTable('messaging.calls')
            .set({
              state: 'refused',
              failure_code: 'refusal' in checked ? checked.refusal : 'member_unavailable',
              ended_at: sql<Date>`now()`,
            })
            .where('id', '=', call.id)
            .execute();
          return null;
        }
        await trx
          .updateTable('messaging.calls')
          .set({ state: 'reserved', reserved_at: sql<Date>`now()` })
          .where('id', '=', call.id)
          .execute();
        const identity = voiceIdentity(businessId, checked.facts.userId);
        const leg = await trx
          .insertInto('messaging.call_legs')
          .values({
            business_id: businessId,
            call_id: call.id,
            party: 'member',
            user_id: checked.facts.userId,
            provider_connection_id: call.provider_connection_id,
            from_address: call.local_e164,
            to_address: `client:${identity}`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const remote = await trx
          .insertInto('messaging.call_legs')
          .values({
            business_id: businessId,
            call_id: call.id,
            parent_leg_id: leg.id,
            party: 'remote',
            provider_connection_id: call.provider_connection_id,
            from_address: call.local_e164,
            to_address: checked.facts.remoteE164,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return {
          callId: call.id,
          legId: leg.id,
          remoteLegId: remote.id,
          connectionId: call.provider_connection_id,
          from: call.local_e164,
          to: checked.facts.remoteE164,
          userId: checked.facts.userId,
          identity,
        } satisfies PlacedCall;
      });
      if (placed === null) return;
      let result: CallProviderResult;
      try {
        result = await provider.place(placed, invocation.context);
      } catch {
        result = { outcome: 'unknown' };
      }
      await withTenant(services.db, invocation.context, async (trx) => {
        await lockBusiness(trx, invocation.context);
        await settlePlacement(trx, placed, result);
      });
    },
  });
}

export function createEndCallTask(provider: CallProvider): Task<typeof endCallReference.data> {
  return defineTask({
    ...endCallReference,
    async run({ callId }, { invocation, services }) {
      const ending = await withTenant(services.db, invocation.context, async (trx) => {
        await lockBusiness(trx, invocation.context);
        const call = await lockCall(trx, callId);
        if (call === undefined) return null;
        if (
          call.hangup_requested_at === null ||
          call.hangup_result === 'accepted' ||
          !active.includes(call.state)
        )
          return null;
        const root = await trx
          .selectFrom('messaging.call_legs')
          .select(['provider_call_sid', 'status'])
          .where('call_id', '=', call.id)
          .where('parent_leg_id', 'is', null)
          .executeTakeFirst();
        // Without the provider's id there is nothing to end yet. The first progress report
        // brings it, and recordCallProgress then answers that a hang-up is waiting.
        const providerCallId = root?.provider_call_sid ?? null;
        if (providerCallId === null) return null;
        return {
          callId: call.id,
          connectionId: call.provider_connection_id,
          providerCallId,
          status: root?.status === 'in-progress' ? 'completed' : 'canceled',
        } satisfies EndedCall;
      });
      if (ending === null) return;
      let result: CallProviderResult;
      try {
        result = await provider.end(ending, invocation.context);
      } catch {
        result = { outcome: 'unknown' };
      }
      await withTenant(services.db, invocation.context, async (trx) => {
        await lockBusiness(trx, invocation.context);
        const call = await lockCall(trx, ending.callId);
        if (call === undefined) return;
        const root = await trx
          .selectFrom('messaging.call_legs')
          .select(['id', 'provider_call_sid', 'status'])
          .where('call_id', '=', call.id)
          .where('parent_leg_id', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (root === undefined) return;
        const wrongCall =
          result.outcome === 'accepted' &&
          (result.providerCallId !== ending.providerCallId ||
            root.provider_call_sid !== result.providerCallId);
        await trx
          .updateTable('messaging.calls')
          .set({ hangup_result: wrongCall ? 'unknown' : result.outcome })
          .where('id', '=', ending.callId)
          .execute();
        if (wrongCall) {
          await markConflict(trx, call.id, root.id);
          return;
        }
        if (result.outcome !== 'accepted' || !terminal.has(result.status)) return;
        if (terminal.has(root.status) && root.status !== result.status) {
          await markConflict(trx, call.id, root.id);
          return;
        }
        // Canceling a queued call may produce no callback. The bound terminal REST
        // resource is evidence too; preserve its status without inventing a sequence.
        // https://www.twilio.com/docs/voice/twiml#callstatus-values
        await trx
          .updateTable('messaging.call_legs')
          .set({ status: result.status, ended_at: sql<Date>`coalesce(ended_at, now())` })
          .where('id', '=', root.id)
          .execute();
        await deriveCallState(trx, call.id);
      });
    },
  });
}

export type CallProgressResult = 'advanced' | 'duplicate' | 'stale' | 'conflict' | 'unknown_leg';

/** Final IncomingPhoneNumber notification: it has no vendor progress sequence. */
export async function recordInboundTerminal(
  trx: DatabaseTransaction,
  report: { readonly connectionId: string; readonly terminal: VoiceTerminal },
): Promise<{ readonly result: CallProgressResult; readonly callId: string | null }> {
  const { terminal: incoming } = report;
  const found = await trx
    .selectFrom('messaging.call_legs as l')
    .innerJoin('messaging.provider_connections as c', (join) =>
      join
        .onRef('c.business_id', '=', 'l.business_id')
        .onRef('c.id', '=', 'l.provider_connection_id'),
    )
    .select(['l.id', 'l.call_id'])
    .where('c.id', '=', report.connectionId)
    .where('c.account_ref', '=', incoming.accountSid)
    .where('c.status', '=', 'connected')
    .where('l.provider_call_sid', '=', incoming.callSid)
    .where('l.parent_leg_id', 'is', null)
    .executeTakeFirst();
  const unknown = { result: 'unknown_leg', callId: null } as const;
  if (found === undefined) return unknown;
  const call = await lockCall(trx, found.call_id);
  if (call?.direction !== 'inbound') return unknown;
  const leg = await trx
    .selectFrom('messaging.call_legs')
    .select(['id', 'status', 'duration_seconds', 'from_address', 'to_address'])
    .where('id', '=', found.id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (leg.from_address !== incoming.from || leg.to_address !== incoming.to) return unknown;
  const answer = (result: CallProgressResult) => ({ result, callId: call.id });
  if (
    (terminal.has(leg.status) && leg.status !== incoming.status) ||
    (leg.duration_seconds !== null &&
      incoming.durationSeconds !== null &&
      leg.duration_seconds !== incoming.durationSeconds)
  ) {
    await markConflict(trx, call.id, leg.id);
    return answer('conflict');
  }
  if (
    leg.status === incoming.status &&
    (incoming.durationSeconds === null || incoming.durationSeconds === leg.duration_seconds)
  )
    return answer('duplicate');
  await trx
    .updateTable('messaging.call_legs')
    .set({
      status: incoming.status,
      duration_seconds: incoming.durationSeconds ?? leg.duration_seconds,
      ended_at: sql<Date>`coalesce(ended_at, now())`,
    })
    .where('id', '=', leg.id)
    .execute();
  await deriveCallState(trx, call.id);
  return answer('advanced');
}

/**
 * Records one verified progress report for a leg, by the leg id its callback URL carried
 * and the connection whose signature verified it. A repeated report changes nothing; an
 * older one is kept but moves nothing back; one that contradicts what was recorded marks
 * the call for reconciliation. `hangUpWaiting` says the worker should now end the call.
 */
export async function recordCallProgress(
  trx: DatabaseTransaction,
  report: {
    readonly legId: string;
    readonly connectionId: string;
    readonly progress: VoiceProgress;
  },
): Promise<{
  readonly result: CallProgressResult;
  readonly callId: string | null;
  readonly hangUpWaiting: boolean;
}> {
  const { progress } = report;
  const found = await trx
    .selectFrom('messaging.call_legs')
    .select(['id', 'call_id', 'provider_connection_id'])
    .where('id', '=', report.legId)
    .executeTakeFirst();
  if (found?.provider_connection_id !== report.connectionId)
    return { result: 'unknown_leg', callId: null, hangUpWaiting: false };
  const call = await lockKnownCall(trx, found.call_id);
  const leg = await trx
    .selectFrom('messaging.call_legs as l')
    .leftJoin('messaging.call_legs as p', (join) =>
      join.onRef('p.business_id', '=', 'l.business_id').onRef('p.id', '=', 'l.parent_leg_id'),
    )
    .select([
      'l.id',
      'l.status',
      'l.sequence',
      'l.provider_call_sid',
      'l.answered_at',
      'p.provider_call_sid as parent_sid',
    ])
    .where('l.id', '=', found.id)
    .forUpdate('l')
    .executeTakeFirstOrThrow();
  const answer = async (result: CallProgressResult) => {
    if (result === 'conflict') await markConflict(trx, call.id, leg.id);
    else if (result === 'advanced') await deriveCallState(trx, call.id);
    const now = await lockKnownCall(trx, call.id);
    return {
      result,
      callId: call.id,
      hangUpWaiting:
        now.hangup_requested_at !== null &&
        now.hangup_result !== 'accepted' &&
        active.includes(now.state),
    };
  };
  if (
    (leg.provider_call_sid !== null && leg.provider_call_sid !== progress.callSid) ||
    (leg.parent_sid !== null && progress.parentSid !== leg.parent_sid) ||
    leg.status === 'rejected'
  )
    return answer('conflict');
  if (leg.provider_call_sid === null) {
    const taken = await trx
      .selectFrom('messaging.call_legs')
      .select('id')
      .where('provider_connection_id', '=', report.connectionId)
      .where('provider_call_sid', '=', progress.callSid)
      .executeTakeFirst();
    if (taken !== undefined) return answer('conflict');
  }
  const stored = await trx
    .insertInto('messaging.call_progress')
    .values({
      business_id: call.business_id,
      leg_id: leg.id,
      sequence: progress.sequence,
      status: progress.status,
      duration_seconds: progress.durationSeconds,
    })
    .onConflict((oc) => oc.columns(['business_id', 'leg_id', 'sequence']).doNothing())
    .returning('sequence')
    .executeTakeFirst();
  if (stored === undefined) {
    const earlier = await trx
      .selectFrom('messaging.call_progress')
      .select('status')
      .where('leg_id', '=', leg.id)
      .where('sequence', '=', progress.sequence)
      .executeTakeFirstOrThrow();
    return answer(earlier.status === progress.status ? 'duplicate' : 'conflict');
  }
  // Reserved and unknown are ours: the first report from the provider settles them.
  const current = leg.status;
  const verdict = advanceVoiceProgress(
    !isProviderStatus(current) || leg.sequence === null
      ? null
      : {
          accountSid: progress.accountSid,
          callSid: progress.callSid,
          status: current,
          sequence: leg.sequence,
        },
    progress,
  );
  if (verdict === 'ignore') return answer('stale');
  if (verdict === 'conflict') return answer('conflict');
  await trx
    .updateTable('messaging.call_legs')
    .set({
      provider_call_sid: progress.callSid,
      provider_direction: progress.direction,
      status: progress.status,
      sequence: progress.sequence,
      duration_seconds: progress.durationSeconds,
      answered_at:
        progress.status === 'in-progress' && leg.answered_at === null
          ? sql<Date>`now()`
          : leg.answered_at,
      ended_at: terminal.has(progress.status) ? sql<Date>`coalesce(ended_at, now())` : null,
    })
    .where('id', '=', leg.id)
    .execute();
  return answer('advanced');
}

/**
 * A leg a <Dial> adds to a call, stored before the instruction is sent so its progress
 * callback can name it. Refused for a call that has ended or never had a first leg.
 */
export async function addCallLeg(
  trx: DatabaseTransaction,
  leg: {
    readonly callId: string;
    readonly parentLegId: string;
    readonly party: 'remote' | 'member';
    readonly userId: string | null;
    readonly to: string;
  },
): Promise<string | null> {
  const call = await lockCall(trx, leg.callId);
  if (call === undefined || !['dialing', 'ringing', 'connected'].includes(call.state)) return null;
  const parent = await trx
    .selectFrom('messaging.call_legs')
    .select('id')
    .where('id', '=', leg.parentLegId)
    .where('call_id', '=', call.id)
    .executeTakeFirst();
  if (parent === undefined || (leg.party === 'member' && leg.userId === null)) return null;
  const added = await trx
    .insertInto('messaging.call_legs')
    .values({
      business_id: call.business_id,
      call_id: call.id,
      parent_leg_id: parent.id,
      party: leg.party,
      user_id: leg.userId,
      provider_connection_id: call.provider_connection_id,
      from_address: call.local_e164,
      to_address: leg.to,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return added.id;
}

/**
 * An inbound call, the first time its provider id is seen on one of the business's
 * numbers; the same call after that. The caller is matched to a contact by phone.
 */
export async function recordInboundCall(
  trx: DatabaseTransaction,
  context: TenantContext,
  inbound: {
    readonly phoneNumberId: string;
    readonly connectionId: string;
    readonly providerCallId: string;
    readonly from: string;
    readonly to: string;
  },
): Promise<{ readonly callId: string; readonly legId: string } | null> {
  const businessId = await lockBusiness(trx, context);
  const existing = await trx
    .selectFrom('messaging.call_legs')
    .select(['id', 'call_id'])
    .where('provider_connection_id', '=', inbound.connectionId)
    .where('provider_call_sid', '=', inbound.providerCallId)
    .executeTakeFirst();
  if (existing !== undefined) return { callId: existing.call_id, legId: existing.id };
  const number = await trx
    .selectFrom('messaging.phone_numbers')
    .select(['e164'])
    .where('id', '=', inbound.phoneNumberId)
    .where('provider_connection_id', '=', inbound.connectionId)
    .executeTakeFirst();
  if (number?.e164 !== inbound.to) return null;
  const remote = /^\+[1-9][0-9]{6,14}$/.test(inbound.from) ? inbound.from : null;
  const identity =
    remote === null
      ? undefined
      : await trx
          .selectFrom('crm.contact_identities')
          .select(['id', 'contact_id'])
          .where('kind', '=', 'phone')
          .where('value_normalized', '=', remote)
          .executeTakeFirst();
  const call = await trx
    .insertInto('messaging.calls')
    .values({
      business_id: businessId,
      direction: 'inbound',
      phone_number_id: inbound.phoneNumberId,
      provider_connection_id: inbound.connectionId,
      local_e164: number.e164,
      remote_e164: remote,
      contact_id: identity?.contact_id ?? null,
      contact_identity_id: identity?.id ?? null,
      requested_by_kind: 'contact',
      requested_by_id: identity?.contact_id ?? null,
      state: 'ringing',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const leg = await trx
    .insertInto('messaging.call_legs')
    .values({
      business_id: businessId,
      call_id: call.id,
      party: 'remote',
      provider_connection_id: inbound.connectionId,
      provider_call_sid: inbound.providerCallId,
      provider_direction: 'inbound',
      from_address: inbound.from.slice(0, 512) || 'anonymous',
      to_address: inbound.to,
      status: 'ringing',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { callId: call.id, legId: leg.id };
}
