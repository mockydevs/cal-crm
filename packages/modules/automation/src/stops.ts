// Stop conditions (stopWhen, AUTOMATIONS.md section 2): events that end an automation for a
// record at any point, also mid-wait. Each live enrolment keeps one waiting row per stop, so
// an incoming event finds the enrolments it ends with one index lookup (event_waits).
import type { CommandContext } from '@repo/commands';
import { automationDocument, evaluateCondition, type AutomationDocument } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { comparedFields } from './compared-fields.js';
import { runWroteOn } from './replied-to.js';
import { settleWaitingSteps } from './settle.js';
import { runTriggerValues } from './trigger-values.js';
import { TRIGGER_EVENTS } from './triggers.js';
import type { ValuesOf } from './values.js';

/** Records the waiting rows for an enrolment's stop conditions, as it starts. */
export async function addStopWaits(
  trx: DatabaseTransaction,
  businessId: string,
  enrolmentId: string,
  recordId: string,
  document: AutomationDocument,
): Promise<void> {
  const rows = document.stopWhen.flatMap((stop, index) =>
    TRIGGER_EVENTS[stop.event].events.map((eventType) => ({
      business_id: businessId,
      enrolment_id: enrolmentId,
      kind: 'stop',
      event_type: eventType,
      record_id: recordId,
      conditions: JSON.stringify({ stop: index }),
    })),
  );
  if (rows.length > 0) await trx.insertInto('automation.event_waits').values(rows).execute();
}

/** Removes an enrolment's waiting rows: all once it has finished, or one kind of them. */
export async function clearWaits(
  trx: DatabaseTransaction,
  enrolmentId: string,
  kind?: 'stop' | 'event' | 'goal',
): Promise<void> {
  await trx
    .deleteFrom('automation.event_waits')
    .where('enrolment_id', '=', enrolmentId)
    .$if(kind !== undefined, (query) => query.where('kind', '=', kind ?? 'stop'))
    .execute();
}

/** How a stop tells of a run it ended: the command's own emit, so the event is its command's. */
export type EmitEvent = CommandContext['emit'];

/**
 * Ends the live enrolments of these records that this event stops, with the stop as the
 * reason, and closes the wait each was in as skipped. With `emit` it says so once per run,
 * as automation.run.stopped on the record's timeline, beside automation.run.completed and
 * automation.run.failed. Returns the enrolments ended.
 */
export async function applyStops(
  trx: DatabaseTransaction,
  event: {
    readonly id: string;
    readonly type: string;
    /** What a stop on a reply to the run's own messages reads: the channel, and when. */
    readonly payload: Readonly<Record<string, unknown>>;
    readonly recordedAt: Date;
  },
  recordIds: readonly string[],
  valuesOf: ValuesOf,
  now: Date,
  emit?: EmitEvent,
): Promise<readonly string[]> {
  if (recordIds.length === 0) return [];
  const waits = await trx
    .selectFrom('automation.event_waits as wait')
    .innerJoin('automation.enrolments as enrolment', 'enrolment.id', 'wait.enrolment_id')
    .innerJoin('automation.versions as version', 'version.id', 'enrolment.version_id')
    .select([
      'wait.enrolment_id',
      'wait.record_id',
      'wait.conditions',
      'version.document',
      'enrolment.automation_id',
    ])
    .where('wait.kind', '=', 'stop')
    .where('wait.event_type', '=', event.type)
    .where('wait.record_id', 'in', [...recordIds])
    .where('enrolment.status', 'in', ['running', 'waiting'])
    .orderBy('wait.enrolment_id')
    .execute();
  const ended: string[] = [];
  for (const wait of waits) {
    if (ended.includes(wait.enrolment_id) || wait.record_id === null) continue;
    const document = automationDocument.parse(wait.document);
    const index = (wait.conditions as { stop?: unknown }).stop;
    const stop = typeof index === 'number' ? document.stopWhen[index] : undefined;
    if (stop === undefined) continue;
    // message.received is always the contact writing in; nothing the team sends is one.
    if (stop.event === 'message.received' && stop.from === 'team') continue;
    // Only a reply to this run's own messages: it has written on the reply's channel.
    if (
      stop.event === 'message.received' &&
      stop.repliedTo === 'this_run' &&
      !(await runWroteOn(trx, {
        enrolmentId: wait.enrolment_id,
        recordId: wait.record_id,
        channel: event.payload['channel'],
        at: event.recordedAt,
      }))
    )
      continue;
    if (
      stop.if !== undefined &&
      !evaluateCondition(
        stop.if,
        {
          ...(await valuesOf(trx, wait.record_id)),
          // How the run's own lead arrived, only for a stop that asks.
          ...([...comparedFields(stop.if)].some((field) => field.startsWith('trigger.'))
            ? await runTriggerValues(trx, wait.record_id, wait.enrolment_id)
            : {}),
        },
        now,
      )
    )
      continue;
    const exited = await trx
      .updateTable('automation.enrolments')
      .set({
        status: 'exited',
        exit_reason: `stop:${stop.event}`,
        current_step: null,
        wake_at: null,
        finished_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', wait.enrolment_id)
      .where('status', 'in', ['running', 'waiting'])
      .returning('id')
      .executeTakeFirst();
    if (exited === undefined) continue;
    await clearWaits(trx, wait.enrolment_id);
    // The rest of the wait it was in never happened.
    await settleWaitingSteps(trx, wait.enrolment_id, 'skipped');
    await emit?.({
      type: 'automation.run.stopped',
      subject: { kind: 'automation_run', id: wait.enrolment_id },
      records: [wait.record_id],
      payload: {
        automationId: toPublicId('automation', wait.automation_id),
        reason: `stop:${stop.event}`,
      },
    });
    ended.push(wait.enrolment_id);
  }
  return ended;
}
