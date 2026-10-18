// Asking for a call and ending one. A request stores a call in state "requested" and queues
// the worker's placing task; nothing reaches the provider here, and the app never opens
// provider credentials. The checks that refuse a request run again when the worker reserves
// the call, so a contact who opts out in between is never rung.
import { createHash } from 'node:crypto';

import { defineCommand, requireBusiness, type Command, type TaskReference } from '@repo/commands';
import {
  hangUpCall,
  requestCallInput,
  type Call,
  type CallFailureCode,
  type CallRequestRefusalCode,
  type PhoneCalling,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { readCallRecord, uuidOf } from './call-records.js';
import { addressConsentStatus } from './consent-state.js';
import { lockBusiness } from './outbound.js';

/** The worker places a requested call: reserve, ask the provider once, record the answer. */
export const placeCallReference = {
  name: 'calls.place',
  data: z.strictObject({ callId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;
/** The worker asks the provider to end a call whose hang-up was requested. */
export const endCallReference = {
  name: 'calls.end',
  data: z.strictObject({ callId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/**
 * Whether calls can be made at all. Phone System's readPhoneCalling answers this;
 * requests are refused when calling is not available.
 */
export type CallingAvailability = (trx: DatabaseTransaction) => Promise<PhoneCalling>;

const refuse = (code: CallRequestRefusalCode, message: string, path = '') =>
  new ValidationError([{ path, code, message }]);

const messages: Readonly<Record<CallFailureCode, string>> = {
  contact_unavailable: 'This contact is in the trash or gone.',
  do_not_call: 'This contact asked not to be called.',
  call_consent_withdrawn: 'This number withdrew its consent to calls.',
  number_unavailable: 'Choose a number of this business that can make calls.',
  connection_unavailable: 'The Twilio account behind this number is not connected.',
  member_unavailable: 'The person calling can no longer make calls here.',
  provider_rejected: 'The provider refused the call.',
};

/** Why a call is refused before it is placed: every failure but the provider's. */
export type CallRefusal = Exclude<CallFailureCode, 'provider_rejected'>;

export interface CallFacts {
  readonly contactId: string;
  readonly userId: string;
  readonly remoteE164: string;
  readonly connectionId: string;
  readonly localE164: string;
}

/**
 * Why a call from this number to this phone identity, for this user, can't be placed now,
 * or the facts it is placed with. Runs in the tenant transaction, so RLS hides every
 * other business's identities and numbers; a null id (its row since deleted) matches
 * nothing. With `expected`, a call whose numbers or connection changed since it was
 * requested is refused: it goes where it was asked to, or nowhere.
 */
export async function checkCall(
  trx: DatabaseTransaction,
  call: {
    readonly contactIdentityId: string | null;
    readonly phoneNumberId: string | null;
    readonly userId: string | null;
  },
  expected?: Pick<CallFacts, 'remoteE164' | 'localE164' | 'connectionId'>,
): Promise<{ readonly refusal: CallRefusal } | { readonly facts: CallFacts }> {
  const contact = await sql<{
    contact_id: string;
    e164: string;
    deleted: boolean;
    do_not_call: boolean;
    withdrawn: boolean;
  }>`select c.id as contact_id, i.value_normalized as e164, c.deleted_at is not null as deleted,
      (c.do_not_contact or 'call'=any(c.dnd_channels)) as do_not_call,
      (${addressConsentStatus(sql`c.business_id`, sql`c.id`, sql`i.value_normalized`, 'call', 'marketing')}='withdrawn'
        or ${addressConsentStatus(sql`c.business_id`, sql`c.id`, sql`i.value_normalized`, 'call', 'transactional')}='withdrawn') as withdrawn
    from crm.contact_identities i
    join crm.contacts c on c.business_id=i.business_id and c.id=i.contact_id
    where i.id=${call.contactIdentityId}::uuid and i.kind='phone'`
    .execute(trx)
    .then(({ rows }) => rows[0]);
  if (contact === undefined || contact.deleted) return { refusal: 'contact_unavailable' };
  if (contact.do_not_call) return { refusal: 'do_not_call' };
  if (contact.withdrawn) return { refusal: 'call_consent_withdrawn' };
  const number = await trx
    .selectFrom('messaging.phone_numbers as n')
    .innerJoin('messaging.channel_accounts as a', (join) =>
      join.onRef('a.business_id', '=', 'n.business_id').onRef('a.id', '=', 'n.id'),
    )
    .innerJoin('messaging.provider_connections as p', (join) =>
      join
        .onRef('p.id', '=', 'n.provider_connection_id')
        .onRef('p.business_id', '=', 'n.business_id'),
    )
    .select([
      'n.e164',
      'n.capabilities',
      'a.status as account_status',
      'p.id',
      'p.status',
      'p.provider',
    ])
    .where('n.id', '=', call.phoneNumberId)
    .executeTakeFirst();
  if (
    number === undefined ||
    !number.capabilities.includes('voice') ||
    number.account_status !== 'active'
  )
    return { refusal: 'number_unavailable' };
  if (number.status !== 'connected' || number.provider !== 'twilio')
    return { refusal: 'connection_unavailable' };
  const user = await trx
    .selectFrom('auth.users')
    .select('id')
    .where('id', '=', call.userId)
    .where('disabled_at', 'is', null)
    .executeTakeFirst();
  if (user === undefined) return { refusal: 'member_unavailable' };
  const facts = {
    contactId: contact.contact_id,
    userId: user.id,
    remoteE164: contact.e164,
    connectionId: number.id,
    localE164: number.e164,
  };
  if (
    expected !== undefined &&
    (expected.remoteE164 !== facts.remoteE164 ||
      expected.localE164 !== facts.localE164 ||
      expected.connectionId !== facts.connectionId)
  )
    return { refusal: 'number_unavailable' };
  return { facts };
}

export function createRequestCallCommand(
  availability: CallingAvailability,
): Command<typeof requestCallInput, Call> {
  return defineCommand({
    name: 'call.request',
    permission: 'calls.place',
    input: requestCallInput,
    async handle(trx, input, command): Promise<Call> {
      const { context } = command;
      const businessId = requireBusiness(context);
      // The person on the business's side is the one asking; a key or a workflow has no
      // phone to ring, so it can't ask for a call.
      if (context.actorKind !== 'user' || context.userId === undefined)
        throw refuse('user_required', 'Only a person can ask for a call.');
      await lockBusiness(trx, context);
      const identityId = uuidOf('contact_identity', input.contactIdentityId);
      const chosen =
        input.phoneNumberId === null ? null : uuidOf('phone_number', input.phoneNumberId);
      const requestHash = createHash('sha256')
        .update(JSON.stringify([context.userId, identityId, chosen]))
        .digest('hex');
      const existing = await trx
        .selectFrom('messaging.calls')
        .select(['id', 'request_hash'])
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash)
          throw new ConflictError('This idempotency key already identifies a different call.');
        return readCallRecord(trx, existing.id);
      }
      if (!(await availability(trx)).available)
        throw refuse('calling_unavailable', 'Calls can’t be made from this business yet.');
      const phoneNumberId =
        chosen ??
        (
          await trx
            .selectFrom('messaging.phone_system_settings')
            .select('default_phone_number_id')
            .executeTakeFirst()
        )?.default_phone_number_id ??
        null;
      if (phoneNumberId === null)
        throw refuse(
          'number_required',
          'Choose a number to call from, or set a default number in Phone System.',
          'phoneNumberId',
        );
      const checked = await checkCall(trx, {
        contactIdentityId: identityId,
        phoneNumberId,
        userId: context.userId,
      });
      if ('refusal' in checked)
        throw refuse(
          checked.refusal,
          messages[checked.refusal],
          checked.refusal === 'number_unavailable' || checked.refusal === 'connection_unavailable'
            ? 'phoneNumberId'
            : 'contactIdentityId',
        );
      const { facts } = checked;
      const row = await trx
        .insertInto('messaging.calls')
        .values({
          business_id: businessId,
          direction: 'outbound',
          phone_number_id: phoneNumberId,
          provider_connection_id: facts.connectionId,
          local_e164: facts.localE164,
          remote_e164: facts.remoteE164,
          contact_id: facts.contactId,
          contact_identity_id: identityId,
          user_id: context.userId,
          requested_by_kind: context.actorKind,
          requested_by_id: context.userId,
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({
            calls_idempotency_unique: () =>
              new ConflictError('This idempotency key already identifies a call.'),
          }),
        );
      await command.emit({
        type: 'call.requested',
        subject: { kind: 'call', id: row.id },
        payload: { direction: 'outbound' },
        records: [facts.contactId],
      });
      command.enqueue(placeCallReference, { callId: row.id });
      return readCallRecord(trx, row.id);
    },
  });
}

const hangUpInput = z.strictObject({ id: hangUpCall.params.shape.id });

/**
 * Ends a call. One not yet reserved is canceled here and never reaches the provider. One
 * the provider may have is asked of the worker; the call ends when the provider reports
 * it. A person ends their own calls; ending anyone's also needs phone.manage.
 */
export const hangUpCallCommand = defineCommand({
  name: 'call.hang_up',
  permission: 'calls.place',
  input: hangUpInput,
  async handle(trx, input, command): Promise<Call> {
    const { context, permissions } = command;
    requireBusiness(context);
    await lockBusiness(trx, context);
    const row = await trx
      .selectFrom('messaging.calls')
      .select(['id', 'state', 'user_id', 'contact_id', 'hangup_requested_at'])
      .where('id', '=', uuidOf('call', input.id))
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('call', input.id);
    const anyone = permissions === 'all' || permissions.has('phone.manage');
    if (context.actorKind === 'user' && !anyone && row.user_id !== context.userId)
      throw new ForbiddenError('You can hang up only your own calls.');
    const records = row.contact_id === null ? [] : [row.contact_id];
    if (row.state === 'requested') {
      await trx
        .updateTable('messaging.calls')
        .set({
          state: 'canceled',
          ended_at: sql<Date>`now()`,
          hangup_requested_at: sql<Date>`now()`,
          hangup_requested_by: context.userId ?? null,
          hangup_result: 'not_needed',
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({ type: 'call.canceled', subject: { kind: 'call', id: row.id }, records });
    } else if (
      row.hangup_requested_at === null &&
      ['reserved', 'unknown', 'dialing', 'ringing', 'connected'].includes(row.state)
    ) {
      await trx
        .updateTable('messaging.calls')
        .set({
          hangup_requested_at: sql<Date>`now()`,
          hangup_requested_by: context.userId ?? null,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'call.hang_up_requested',
        subject: { kind: 'call', id: row.id },
        records,
      });
      command.enqueue(endCallReference, { callId: row.id });
    }
    return readCallRecord(trx, row.id);
  },
});
