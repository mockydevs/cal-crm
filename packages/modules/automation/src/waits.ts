// Waits that stay at their step: a step that waits for something to happen for the enrolled
// record, such as a reply, until a timeout. A matching event wakes only that enrolment; the
// timeout and the event can't both win. A wait for an event hears only what came after it
// began. A wait for a condition or for an appointment is judged again on waking, so it
// hears every matching event whose match job runs while it listens, whenever the event was
// recorded.
import type { AutomationStep, AutomationTrigger, AutomationTriggerType } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { queueStep } from './queue-step.js';
import type { WaitedAppointment } from './steps.js';
import { eventPassesTrigger, FIELD_CHANGE_EVENTS, TRIGGER_EVENTS } from './triggers.js';

/** What says a contact changed in a way a condition can read: its fields and its tags. */
export const RECORD_CHANGE_EVENTS = [...FIELD_CHANGE_EVENTS, 'tag.assigned', 'tag.removed'];

/** What says an appointment was moved, cancelled or otherwise changed. */
export const APPOINTMENT_CHANGE_EVENTS = [
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.status_changed',
];

/**
 * The steps whose wait reads the record's own state, and so holds the record's runs still.
 * A wait until a date field is one: a change to the field moves it.
 */
export const RECHECKED_WAITS: ReadonlySet<string> = new Set([
  'wait.condition',
  'wait.appointment',
  'wait.until',
]);

/**
 * What a wait at this step listens for: the event types, and what its rows keep. `event` is
 * the event a wait.event plan names; null for a plan that names none.
 */
function listeningFor(
  step: AutomationStep,
  event: string | null,
): { readonly types: readonly string[]; readonly conditions: Readonly<Record<string, unknown>> } {
  if (step.type === 'wait.condition')
    return { types: RECORD_CHANGE_EVENTS, conditions: { recheck: true } };
  if (step.type === 'wait.appointment')
    return { types: APPOINTMENT_CHANGE_EVENTS, conditions: { recheck: true } };
  // Only a wait on a date field arms; one until a fixed instant sleeps without listening.
  if (step.type === 'wait.until')
    return { types: FIELD_CHANGE_EVENTS, conditions: { recheck: true } };
  if (step.type !== 'wait.event' || event === null) return { types: [], conditions: {} };
  const { channel, link } = step.config;
  const config = {
    ...(channel === undefined ? {} : { channel }),
    ...(link === undefined ? {} : { link }),
  };
  return {
    types: TRIGGER_EVENTS[event as AutomationTriggerType].events,
    // Judged as the event's trigger judges its own filters.
    conditions: Object.keys(config).length === 0 ? {} : { filter: { type: event, config } },
  };
}

/** Records the waiting rows for a step that waits where it stands, one per event type heard. */
export async function addEventWaits(
  trx: DatabaseTransaction,
  businessId: string,
  enrolmentId: string,
  recordId: string,
  step: AutomationStep,
  event: string | null,
  expiresAt: Date,
): Promise<void> {
  const { types, conditions } = listeningFor(step, event);
  if (types.length === 0) return;
  await trx
    .insertInto('automation.event_waits')
    .values(
      types.map((eventType) => ({
        business_id: businessId,
        enrolment_id: enrolmentId,
        kind: 'event',
        event_type: eventType,
        record_id: recordId,
        conditions: JSON.stringify(conditions),
        expires_at: expiresAt,
      })),
    )
    .execute();
}

/**
 * Wakes the enrolments of these records whose step waits for this event. The enrolment row
 * is locked first, then its job queued, as everywhere else. Returns the enrolments woken.
 */
export async function applyEventWaits(
  trx: DatabaseTransaction,
  event: {
    readonly id: string;
    readonly type: string;
    readonly recordedAt: Date;
    /** What a wait's filter reads, such as the channel a message came in on. */
    readonly payload: Readonly<Record<string, unknown>>;
  },
  recordIds: readonly string[],
): Promise<readonly string[]> {
  if (recordIds.length === 0) return [];
  const waiting = await trx
    .selectFrom('automation.event_waits as wait')
    .innerJoin('automation.enrolments as enrolment', 'enrolment.id', 'wait.enrolment_id')
    .select(['enrolment.id', 'enrolment.state', 'wait.conditions', 'wait.created_at'])
    .where('wait.kind', '=', 'event')
    .where('wait.event_type', '=', event.type)
    .where('wait.record_id', 'in', [...recordIds])
    .where('enrolment.status', '=', 'waiting')
    .orderBy('enrolment.id')
    .forUpdate('enrolment')
    .execute();
  const woken: string[] = [];
  for (const enrolment of waiting) {
    // An enrolment waiting for more than one event type has a row for each.
    if (woken.includes(enrolment.id)) continue;
    const conditions = (enrolment.conditions ?? {}) as {
      readonly recheck?: unknown;
      readonly filter?: { readonly type?: unknown; readonly config?: unknown };
    };
    // Only events after the wait began: one that came before it is not the one awaited.
    // A wait that judges the record again on waking takes any, and so misses no change.
    if (conditions.recheck !== true && enrolment.created_at.getTime() >= event.recordedAt.getTime())
      continue;
    if (
      conditions.filter !== undefined &&
      !eventPassesTrigger(
        // A wait's filter is a trigger's type and config; only a trigger's id is missing.
        { id: 'wait', ...conditions.filter } as AutomationTrigger,
        event.type,
        event.payload,
      )
    )
      continue;
    const state = (enrolment.state ?? {}) as Readonly<Record<string, unknown>>;
    if (state['received'] !== undefined) continue;
    await trx
      .updateTable('automation.enrolments')
      .set({
        state: JSON.stringify({ ...state, received: event.id }),
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', enrolment.id)
      .execute();
    await trx
      .deleteFrom('automation.event_waits')
      .where('enrolment_id', '=', enrolment.id)
      .where('kind', '=', 'event')
      .execute();
    // The step runs now, replacing its timeout job.
    await queueStep(trx, enrolment.id);
    woken.push(enrolment.id);
  }
  return woken;
}

/**
 * The appointment a wait.appointment step waits for, as it is now. While the run waits it
 * is the one the wait began with (`kept`, the id the API shows). Before that it is the
 * appointment that started the run, when an appointment's event did; otherwise the contact's
 * next one that is booked or confirmed and has not started. null when there is none, or it
 * is no longer there.
 */
export async function readWaitedAppointment(
  trx: DatabaseTransaction,
  input: {
    readonly recordId: string;
    readonly now: Date;
    readonly enrolmentId?: string | undefined;
    readonly kept?: unknown;
  },
): Promise<WaitedAppointment | null> {
  const appointments = trx
    .selectFrom('calendar.appointments')
    .select(['id', 'starts_at', 'status'])
    .where('contact_id', '=', input.recordId);
  const shown = (row: { id: string; starts_at: Date; status: string } | undefined) =>
    row === undefined
      ? null
      : { id: toPublicId('appointment', row.id), startsAt: row.starts_at, status: row.status };
  if (typeof input.kept === 'string') {
    const id = parsePublicId('appointment', input.kept);
    return id === undefined
      ? null
      : shown(await appointments.where('id', '=', id).executeTakeFirst());
  }
  if (input.enrolmentId !== undefined) {
    const started = await trx
      .selectFrom('automation.enrolments as run')
      .innerJoin('events.events as event', 'event.id', 'run.trigger_event_id')
      .select('event.subject_id')
      .where('run.id', '=', input.enrolmentId)
      .where('event.subject_kind', '=', 'appointment')
      .executeTakeFirst();
    if (started !== undefined)
      return shown(await appointments.where('id', '=', started.subject_id).executeTakeFirst());
  }
  return shown(
    await appointments
      .where('status', 'in', ['booked', 'confirmed'])
      .where('starts_at', '>', input.now)
      .orderBy('starts_at')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst(),
  );
}
