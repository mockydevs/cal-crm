// Publishing a version, and starting automations from events: one event enrols each
// matching record once, and re-entry follows the automation's setting.
import { withDealClosePlace } from './deal-close-place.js';
import {
  automationDocument,
  evaluateCondition,
  type AutomationDocument,
  type AutomationTrigger,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';

import { arrivalOf, hasArrival, readEventTouch, touchValues } from './attribution-values.js';
import { hasSubmission, readSubmissionValues } from './submission-values.js';
import { chainOf, chainRefusal } from './chain.js';
import { comparedFields } from './compared-fields.js';
import { addGoalWaits, applyGoals } from './goals.js';
import { queueStep } from './queue-step.js';
import { automationRepliedTo } from './replied-to.js';
import { publishEmailContent } from './email-content-publication.js';
import { queueReentry, type Queued } from './reentry-mark.js';
import { refusalDetail, startRefusal } from './run-guards.js';
import { endTrashedRuns, inTrash, trashedContactsRuns } from './trashed.js';
import { timeZoneOf } from './time-zone.js';
import { isFieldChangeEvent, readFieldChanges } from './field-changes.js';
import { addStopWaits, applyStops, type EmitEvent } from './stops.js';
import type { ValuesOf } from './values.js';
import { applyEventWaits } from './waits.js';
import { writeTriggerEvaluations, type EvaluationNote } from './trigger-evaluations.js';
import {
  ARRIVAL,
  eventPassesTrigger,
  FIELD_CHANGES,
  TRIGGER_EVENTS,
  triggerMismatch,
} from './triggers.js';

/**
 * Makes a validated, normalized document the automation's live version: an immutable
 * version row, and the trigger subscriptions that let one index lookup find it for an event.
 * Running enrolments stay on the version they began with.
 */
export async function publishAutomationVersion(
  trx: DatabaseTransaction,
  context: TenantContext,
  automationId: string,
  document: AutomationDocument,
  summary: string,
): Promise<{ versionId: string; version: number }> {
  const businessId = context.businessId;
  if (businessId === undefined) throw new Error('Publishing needs a business.');
  const automation = await trx
    .selectFrom('automation.automations')
    .select(['id'])
    .where('id', '=', automationId)
    .where('status', '<>', 'archived')
    .forUpdate()
    .executeTakeFirstOrThrow();
  await forgetRemovedTriggers(trx, automation.id, document);
  const latest = await trx
    .selectFrom('automation.versions')
    .select(sql<number>`coalesce(max(version), 0)`.as('version'))
    .where('automation_id', '=', automation.id)
    .executeTakeFirstOrThrow();
  const version = latest.version + 1;
  const { id: versionId } = await trx
    .insertInto('automation.versions')
    .values({
      business_id: businessId,
      automation_id: automation.id,
      version,
      document: sql`${JSON.stringify(document)}::jsonb`,
      change_summary: summary,
      published_by_kind: context.actorKind,
      published_by_id: context.actorId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await publishEmailContent(trx, context, automation.id, versionId, document);
  await trx
    .deleteFrom('automation.trigger_subscriptions')
    .where('automation_id', '=', automation.id)
    .execute();
  const subscriptions = document.triggers.flatMap((trigger) =>
    TRIGGER_EVENTS[trigger.type].events.map((eventType) => ({
      business_id: businessId,
      automation_id: automation.id,
      version_id: versionId,
      event_type: eventType,
      conditions: JSON.stringify({ triggerId: trigger.id }),
    })),
  );
  if (subscriptions.length > 0)
    await trx.insertInto('automation.trigger_subscriptions').values(subscriptions).execute();
  await trx
    .updateTable('automation.automations')
    // A paused automation stays paused: publishing changes what runs, not whether it does.
    .set({
      published_version_id: versionId,
      status: sql<string>`case when status = 'paused' then 'paused' else 'active' end`,
      updated_at: sql`now()`,
    })
    .where('id', '=', automation.id)
    .execute();
  return { versionId, version };
}

/**
 * The clock triggers' cursors and firings belong to a trigger as it was published. One the
 * new version removes, or gives another type, loses them now, at publish: a trigger added
 * back later under the same id starts its clock afresh, as a new one does, and fires
 * nothing behind it.
 */
async function forgetRemovedTriggers(
  trx: DatabaseTransaction,
  automationId: string,
  document: AutomationDocument,
): Promise<void> {
  const previous = await trx
    .selectFrom('automation.automations as automation')
    .innerJoin('automation.versions as version', 'version.id', 'automation.published_version_id')
    .select('version.document')
    .where('automation.id', '=', automationId)
    .executeTakeFirst();
  const before = new Map<string, unknown>();
  const stored: unknown = previous?.document;
  const triggers: unknown =
    typeof stored === 'object' && stored !== null && 'triggers' in stored
      ? stored.triggers
      : undefined;
  if (Array.isArray(triggers))
    for (const trigger of triggers as unknown[])
      if (typeof trigger === 'object' && trigger !== null && 'id' in trigger && 'type' in trigger)
        before.set(String(trigger.id), trigger.type);
  const kept = document.triggers
    .filter((trigger) => before.get(trigger.id) === trigger.type)
    .map((trigger) => trigger.id);
  await sql`
    delete from automation.trigger_cursors
    where automation_id = ${automationId} and not (trigger_id = any(${kept}::text[]))
  `.execute(trx);
  await sql`
    delete from automation.trigger_firings
    where automation_id = ${automationId} and not (trigger_id = any(${kept}::text[]))
  `.execute(trx);
}

export interface MatchResult {
  /** Enrolments started, by automation. */
  readonly enrolled: readonly {
    readonly automationId: string;
    readonly recordId: string;
    readonly enrolmentId: string;
  }[];
  /** Live enrolments the event ended through a stop condition. */
  readonly exited: readonly string[];
  /** Enrolments whose wait.event step the event woke. */
  readonly woken?: readonly string[];
  /** Live enrolments whose goal the event met: each moved to its goal step. */
  readonly moved?: readonly string[];
}

/**
 * Starts every active automation a stored event triggers, for each record the event is on
 * (its timeline records). Safe to run twice for one event: an enrolment already live, or a
 * record that already went through an automation that never re-enrols, is skipped. The
 * engine's own task passes its command's `emit`, so each run a stop condition ends is told
 * of as automation.run.stopped.
 */
export async function matchEvent(
  trx: DatabaseTransaction,
  context: TenantContext,
  eventId: string,
  valuesOf: ValuesOf,
  now: Date = new Date(),
  emit?: EmitEvent,
): Promise<MatchResult> {
  const businessId = context.businessId;
  if (businessId === undefined) return { enrolled: [], exited: [] };
  const event = await trx
    .selectFrom('events.events')
    .select([
      'id',
      'type',
      'payload',
      'correlation_id',
      'recorded_at',
      'actor_kind',
      'subject_kind',
      'subject_id',
    ])
    .where('id', '=', eventId)
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  if (event === undefined) return { enrolled: [], exited: [] };
  // A deal's close recorded before it said which pipeline is given the deal's own.
  const stored = await withDealClosePlace(
    trx,
    event,
    (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Readonly<
      Record<string, unknown>
    >,
  );
  // An event that says a field changed names the field by id, or lists a contact's own by
  // name, and carries no value. Which fields, by the paths documents use, and what each
  // holds are read once here and judged beside the payload.
  const changes = isFieldChangeEvent(event.type)
    ? await readFieldChanges(trx, { ...event, payload: stored }, (recordId) =>
        valuesOf(trx, recordId),
      )
    : undefined;
  // It changed nothing a document can name, such as a contact's time zone or a company's
  // field: no stop, wait, goal or trigger that listens for a field change means it.
  if (changes?.length === 0) return { enrolled: [], exited: [] };
  const records = await trx
    .selectFrom('crm.timeline_entries')
    .select('record_id')
    .distinct()
    .where('event_id', '=', event.id)
    .orderBy('record_id')
    .execute();
  // A form submission and a booking come with a touch of their own: how this lead arrived.
  // The event carries ids only, so the touch is read once here, by the event's subject, and
  // judged beside the payload (a trigger's filters by lead source) and as the values a
  // trigger's condition reads under trigger.attribution.
  const touch = hasArrival(event.type)
    ? await readEventTouch(
        trx,
        event,
        records.map((row) => row.record_id),
      )
    : undefined;
  // A form submission's own answers and page, for a trigger's condition on them
  // (trigger.answers.<key>, trigger.pageUrl): read once, by the same subject.
  const arrived = {
    ...(hasArrival(event.type) ? touchValues('trigger', touch) : {}),
    ...(hasSubmission(event.type) ? await readSubmissionValues(trx, event) : {}),
  };
  const payload: Readonly<Record<string, unknown>> = {
    ...stored,
    ...(changes === undefined ? {} : { [FIELD_CHANGES]: changes }),
    ...(hasArrival(event.type) ? { [ARRIVAL]: arrivalOf(touch) } : {}),
  };
  // What this event ends, wakes and starts for a record is decided with the record's runs
  // held still, in the order every such decision takes them (lockRecordRuns).
  for (const { record_id: recordId } of records) await lockRecordRuns(trx, recordId);
  // A contact moved to the trash leaves its workflows, and starts none (trashed.ts).
  const trashed = new Set<string>();
  for (const { record_id: recordId } of records)
    if (await inTrash(trx, recordId)) trashed.add(recordId);
  if (event.type === 'contact.trashed' && trashed.size > 0) {
    const ended = await endTrashedRuns(trx, trashedContactsRuns([...trashed]), emit);
    return { enrolled: [], exited: ended };
  }
  // Stops first, so an enrolment this event starts isn't ended by the same event.
  const exited = await applyStops(
    trx,
    { id: event.id, type: event.type, payload, recordedAt: event.recorded_at },
    records.map((row) => row.record_id),
    valuesOf,
    now,
    emit,
  );
  // Then goals: a run the event stopped is over and is not moved, and a run the goal moves
  // out of a wait for this same event is not also woken by it.
  const goals = await applyGoals(
    trx,
    { id: event.id, type: event.type, payload },
    records.map((row) => row.record_id),
  );
  const moved = goals.length > 0 ? { moved: goals } : {};
  const woken = await applyEventWaits(
    trx,
    { id: event.id, type: event.type, recordedAt: event.recorded_at, payload },
    records.map((row) => row.record_id),
  );
  // A contact an import made starts no automation by having been created: a file of
  // thousands must not set off a welcome sequence nobody chose to send. Its stop conditions
  // and waits were applied above, and whatever else the import did to the contact, such as
  // adding a tag, is an event of its own that matches as anyone's does.
  const imported = event.type === 'contact.created' && event.actor_kind === 'import';
  // A paused automation is read too, though it starts for nobody: that it was paused is
  // why, and is kept as such (trigger-evaluations.ts).
  const subscriptions = await trx
    .selectFrom('automation.trigger_subscriptions as subscription')
    .innerJoin('automation.automations as automation', (join) =>
      join
        .onRef('automation.id', '=', 'subscription.automation_id')
        .onRef('automation.published_version_id', '=', 'subscription.version_id'),
    )
    .innerJoin('automation.versions as version', 'version.id', 'subscription.version_id')
    .select([
      'subscription.automation_id',
      'subscription.version_id',
      'subscription.conditions',
      'automation.status',
      'version.document',
    ])
    .where('subscription.event_type', '=', event.type)
    .where('automation.status', 'in', ['active', 'paused'])
    .orderBy('subscription.automation_id')
    .execute();
  if (subscriptions.length === 0) return { enrolled: [], exited, woken, ...moved };
  const repliedTo = async (recordId: string, channel: unknown) => {
    const known = replies.get(recordId);
    if (known !== undefined || typeof channel !== 'string') return known?.automationId;
    const automationId = await automationRepliedTo(trx, {
      recordId,
      channel,
      at: event.recorded_at,
    });
    replies.set(recordId, { automationId });
    return automationId;
  };
  // An event that says a run ended: what it starts carries the chain that led to it, so
  // automations whose runs' endings start one another cannot go round without end.
  const endedRun =
    event.subject_kind === 'automation_run' && event.type.startsWith('automation.run.')
      ? await trx
          .selectFrom('automation.enrolments')
          .select(['id', 'automation_id', 'state'])
          .where('id', '=', event.subject_id)
          .executeTakeFirst()
      : undefined;
  const chain =
    endedRun === undefined ? undefined : [...chainOf(endedRun.state), endedRun.automation_id];
  const enrolled: { automationId: string; recordId: string; enrolmentId: string }[] = [];
  const seen = new Set<string>();
  const replies = new Map<string, { automationId: string | undefined }>();
  // Why each automation that was judged did not start for a record: written once, at the
  // end, and only for automations that listen for this event.
  const notes: EvaluationNote[] = [];
  const recordIds: readonly (string | null)[] =
    records.length === 0 ? [null] : records.map((row) => row.record_id);
  for (const subscription of subscriptions) {
    const document = automationDocument.parse(subscription.document);
    const triggerId = (subscription.conditions as { triggerId?: unknown }).triggerId;
    const listening = document.triggers.filter(
      (trigger: AutomationTrigger) => triggerId === undefined || trigger.id === triggerId,
    );
    const triggers = listening.filter((trigger) =>
      eventPassesTrigger(trigger, event.type, payload),
    );
    const note = (
      trigger: AutomationTrigger | undefined,
      recordId: string | null,
      reason: EvaluationNote['reason'],
      detail: EvaluationNote['detail'] = {},
    ) =>
      notes.push({
        automationId: subscription.automation_id,
        triggerId: trigger?.id ?? null,
        recordId,
        reason,
        detail,
      });
    if (triggers.length === 0) {
      // The event is one the trigger listens for, and one of its own filters refused it.
      for (const trigger of listening) {
        const mismatch = triggerMismatch(trigger, event.type, payload);
        if (mismatch !== undefined && mismatch.filter !== 'event')
          for (const recordId of recordIds)
            note(trigger, recordId, 'filter_mismatch', { ...mismatch });
      }
      continue;
    }
    const [first] = triggers;
    // The reasons that stop an automation whatever the record: each is said once a record.
    const stopped: readonly [EvaluationNote['reason'], EvaluationNote['detail']] | undefined =
      records.length === 0
        ? ['contact_missing', {}]
        : imported
          ? ['stopped_by_rule', { rule: 'imported_contact' }]
          : subscription.status === 'paused'
            ? ['paused', {}]
            : // Already in the chain that led to this ending, or the chain is at its limit.
              chain !== undefined && chainRefusal(chain, subscription.automation_id) !== undefined
              ? ['refused_loop', {}]
              : undefined;
    if (stopped !== undefined) {
      for (const recordId of recordIds) note(first, recordId, stopped[0], stopped[1]);
      continue;
    }
    for (const { record_id: recordId } of records) {
      // An automation hearing an event through more than one trigger starts a record once,
      // through the first trigger the record passes.
      const started = `${subscription.automation_id}:${recordId}`;
      if (seen.has(started)) continue;
      if (trashed.has(recordId)) {
        seen.add(started);
        note(first, recordId, 'stopped_by_rule', { rule: 'contact_trashed' });
        continue;
      }
      const values = triggers.some((trigger) => trigger.if !== undefined)
        ? { ...(await valuesOf(trx, recordId)), ...arrived }
        : {};
      // Which automation the message replies to, read once per record and only when a
      // trigger asks. The stops above may have just ended that automation's run: the
      // answer comes from the message it sent, so it is the same either way.
      const replied = triggers.some(limitsReplies)
        ? await repliedTo(recordId, payload['channel'])
        : undefined;
      const repliesPass = (each: AutomationTrigger) =>
        !limitsReplies(each) ||
        (replied !== undefined &&
          each.config.repliedTo.some(
            (reference) => parsePublicId('automation', reference) === replied,
          ));
      // A date with no time of day is judged as that day in the run's zone.
      const timeZone = triggers.some((each) => each.if !== undefined)
        ? await timeZoneOf(trx, businessId, recordId, document.settings.timezone)
        : undefined;
      const trigger = triggers.find(
        (each) =>
          repliesPass(each) &&
          (each.if === undefined || evaluateCondition(each.if, values, now, timeZone)),
      );
      if (trigger === undefined) {
        // Each trigger that passed its filters and still did not start the record says why.
        for (const each of triggers)
          if (!repliesPass(each))
            note(each, recordId, 'filter_mismatch', {
              filter: 'repliedTo',
              expected: limitsReplies(each) ? each.config.repliedTo : [],
              actual: replied === undefined ? null : toPublicId('automation', replied),
            });
          else
            note(each, recordId, 'condition_false', {
              values: Object.fromEntries(
                [...comparedFields(each.if)].map((field) => [field, values[field] ?? null]),
              ),
            });
        continue;
      }
      seen.add(started);
      // The run's own change, or a loop the breaker stops, starts nothing (run-guards.ts).
      const refusal = await startRefusal(trx, {
        automationId: subscription.automation_id,
        recordId,
        correlationId: event.correlation_id,
        eventId: event.id,
        now,
      });
      if (refusal?.cause === 'same_event') continue;
      if (refusal !== undefined) {
        note(trigger, recordId, 'refused_loop', refusalDetail(refusal));
        if (refusal.cause === 'run_limit' && refusal.first && emit !== undefined)
          await emit({
            type: 'automation.loop_stopped',
            subject: { kind: 'automation', id: subscription.automation_id },
            records: [recordId],
            payload: {
              automationId: toPublicId('automation', subscription.automation_id),
              eventType: event.type,
              starts: refusal.starts,
              windowMinutes: refusal.windowMinutes,
            },
          });
        continue;
      }
      const state = {
        triggerId: trigger.id,
        ...(endedRun === undefined || chain === undefined
          ? {}
          : {
              chain,
              endedRun: { enrolmentId: endedRun.id, automationId: endedRun.automation_id },
            }),
      };
      const start = () =>
        enrol(
          trx,
          businessId,
          subscription.automation_id,
          subscription.version_id,
          recordId,
          document,
          { eventId: event.id, correlationId: event.correlation_id, triggerId: trigger.id, state },
        );
      let result = await start();
      // The record is in the automation now. One that lets a record in again keeps the
      // event for when that run ends (reentry-mark.ts), unless it ended while it was being
      // read: then it starts now. (A run this same event started was passed over above.)
      let queued: Queued | undefined;
      if (
        result.outcome === 'already_running' &&
        document.settings.reEnrollment === 'after_finished'
      ) {
        queued = await queueReentry(trx, {
          automationId: subscription.automation_id,
          recordId,
          event: {
            id: event.id,
            type: event.type,
            recordedAt: event.recorded_at,
            correlationId: event.correlation_id,
          },
          triggerId: trigger.id,
          state,
        });
        if (queued.outcome === 'ended') result = await start();
      }
      if (result.outcome === 'started')
        enrolled.push({
          automationId: subscription.automation_id,
          recordId,
          enrolmentId: result.enrolmentId,
        });
      else
        note(
          trigger,
          recordId,
          result.outcome === 'already_running' ? 'already_enrolled' : 'reentry_not_allowed',
          queued?.outcome === 'queued' ? { queued: true } : {},
        );
    }
  }
  // A record one trigger of an automation started has nothing to explain for its others.
  const startedFor = new Set(enrolled.map((each) => `${each.automationId}:${each.recordId}`));
  await writeTriggerEvaluations(
    trx,
    businessId,
    { id: event.id, type: event.type },
    notes.filter((each) => !startedFor.has(`${each.automationId}:${String(each.recordId)}`)),
  );
  return { enrolled, exited, woken, ...moved };
}

type RepliesTrigger = Extract<AutomationTrigger, { type: 'message.received' }> & {
  readonly config: { readonly repliedTo: readonly string[] };
};

/** Whether a trigger starts only on a reply to the automations it names. */
const limitsReplies = (trigger: AutomationTrigger): trigger is RepliesTrigger =>
  trigger.type === 'message.received' && trigger.config.repliedTo !== undefined;

/**
 * Holds a record's runs still for one transaction: whatever starts or ends more than one
 * run of a record takes this first, before any run's row. An event being matched, a step
 * that starts another automation and a step that removes the record from automations each
 * touch several runs of one record, and each would otherwise hold one while waiting for
 * another the other way round. An ordinary step holds only its own run and never takes it.
 */
export async function lockRecordRuns(trx: DatabaseTransaction, recordId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`automation-runs:${recordId}`}, 0))`.execute(
    trx,
  );
}

/** What enrolling a record came to. */
export type EnrolOutcome =
  | { readonly outcome: 'started'; readonly enrolmentId: string }
  /** The record is in the automation now, or went through it and it enrols a record once. */
  | { readonly outcome: 'already_running' | 'already_went_through' };

/** Why a record is being enrolled. */
export interface EnrolCause {
  /** The event that began it all: the trigger's, also for a run another run started. */
  readonly eventId: string | null;
  readonly correlationId: string;
  /** The trigger that enrolled the record; null when a step of another automation did. */
  readonly triggerId: string | null;
  /** What the run's state begins with, beside its sequence. */
  readonly state: Readonly<Record<string, unknown>>;
}

/**
 * Enrols a record in an automation on a version of it, by the rules every enrolment keeps:
 * one decision per automation and record at a time, never again where the automation
 * enrols a record once, and one live run per record. It adds the run's stop waits and
 * queues its first step. An event enrols through it, and so does a step that starts
 * another automation.
 */
export async function enrol(
  trx: DatabaseTransaction,
  businessId: string,
  automationId: string,
  versionId: string,
  recordId: string,
  document: AutomationDocument,
  cause: EnrolCause,
): Promise<EnrolOutcome> {
  // One decision per automation and record at a time, so "never re-enrol" can't race.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`enrol:${automationId}:${recordId}`}, 0))`.execute(
    trx,
  );
  if (document.settings.reEnrollment === 'never') {
    const before = await sql<{ live: boolean }>`
      select coalesce(bool_or(status in ('running', 'waiting')), false) as live
      from automation.enrolments
      where automation_id = ${automationId} and record_id = ${recordId}
      having count(*) > 0
    `.execute(trx);
    const [earlier] = before.rows;
    if (earlier !== undefined)
      return { outcome: earlier.live ? 'already_running' : 'already_went_through' };
  }
  // The live index on (automation, reentry_key) keeps one running enrolment per record.
  const inserted = await sql<{ id: string }>`
    insert into automation.enrolments
      (business_id, automation_id, version_id, record_id, reentry_key, current_step, state,
       trigger_key, trigger_event_id, correlation_id)
    values (${businessId}, ${automationId}, ${versionId}, ${recordId}, ${recordId}, ${document.start},
       ${JSON.stringify({ ...cause.state, sequence: 0 })}::jsonb, ${cause.triggerId},
       ${cause.eventId}, ${cause.correlationId})
    on conflict (business_id, automation_id, reentry_key) where status in ('running', 'waiting') do nothing
    returning id
  `.execute(trx);
  const enrolmentId = inserted.rows[0]?.id;
  if (enrolmentId === undefined) return { outcome: 'already_running' };
  await addStopWaits(trx, businessId, enrolmentId, recordId, document);
  await addGoalWaits(trx, businessId, enrolmentId, recordId, document);
  // The first step runs as soon as the transaction that enrolled it commits.
  await queueStep(trx, enrolmentId);
  return { outcome: 'started', enrolmentId };
}
