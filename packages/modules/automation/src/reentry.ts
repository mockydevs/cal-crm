// Starting a record again once its marked run has ended (reentry-mark.ts says why and
// what holds).
import { defineCommand, defineTask, requireBusiness, runCommand } from '@repo/commands';
import { automationDocument } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { enrol, lockRecordRuns, type EnrolOutcome } from './enrolment.js';
import { startAgainReference, startsAgain } from './reentry-mark.js';
import { refusalDetail, startRefusal } from './run-guards.js';
import { writeTriggerEvaluations, type EvaluationNote } from './trigger-evaluations.js';

/** What starting a record again came to. */
export type StartAgainOutcome =
  | EnrolOutcome['outcome']
  | 'nothing_marked'
  | 'still_running'
  | 'deleted'
  | 'paused'
  | 'refused_loop'
  | 'trigger_removed';

/**
 * Starts the record of a run that ended with a mark once more, on the automation's live
 * version, by the rules every enrolment keeps. What came of it is written on the ended
 * run, so the job run twice does nothing more. A record that could not be started is said
 * so, as a trigger evaluation of the event that marked the run.
 */
export async function startAgain(
  trx: DatabaseTransaction,
  businessId: string,
  enrolmentId: string,
  now: Date = new Date(),
): Promise<{ readonly outcome: StartAgainOutcome; readonly enrolmentId?: string }> {
  const ended = await trx
    .selectFrom('automation.enrolments')
    .select(['id', 'automation_id', 'record_id', 'status'])
    .where('id', '=', enrolmentId)
    .executeTakeFirst();
  if (ended === undefined) return { outcome: 'nothing_marked' };
  // The record's runs held still, as every start takes them, then the run read again.
  await lockRecordRuns(trx, ended.record_id);
  const row = await trx
    .selectFrom('automation.enrolments')
    .select(['status', 'state'])
    .where('id', '=', ended.id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (row.status === 'running' || row.status === 'waiting') return { outcome: 'still_running' };
  const mark = startsAgain(row.state);
  if (mark === undefined) return { outcome: 'nothing_marked' };
  const automation = await trx
    .selectFrom('automation.automations as automation')
    .leftJoin('automation.versions as version', (join) =>
      join
        .onRef('version.business_id', '=', 'automation.business_id')
        .onRef('version.id', '=', 'automation.published_version_id'),
    )
    .select(['automation.status', 'automation.published_version_id', 'version.document'])
    .where('automation.id', '=', ended.automation_id)
    .executeTakeFirst();
  const document =
    automation?.document === undefined || automation.document === null
      ? undefined
      : automationDocument.parse(automation.document);
  // What the marking event came to in the end: it replaces what its match first said (that
  // the record would go through again), so the evaluation of that event is the last word.
  const note = async (reason: EvaluationNote['reason'], detail: EvaluationNote['detail'] = {}) => {
    await trx
      .deleteFrom('automation.trigger_evaluations')
      .where('automation_id', '=', ended.automation_id)
      .where('event_id', '=', mark.eventId)
      .where('record_id', '=', ended.record_id)
      .where('trigger_id', '=', mark.triggerId)
      .execute();
    await writeTriggerEvaluations(trx, businessId, { id: mark.eventId, type: mark.eventType }, [
      {
        automationId: ended.automation_id,
        triggerId: mark.triggerId,
        recordId: ended.record_id,
        reason,
        detail: { ...detail, after: toPublicId('automation_enrolment', ended.id) },
      },
    ]);
  };
  // The circuit breaker holds here too: a loop through the outside comes back as a change
  // during a run as often as after one (run-guards.ts).
  const refusal =
    document === undefined
      ? undefined
      : await startRefusal(trx, {
          automationId: ended.automation_id,
          recordId: ended.record_id,
          correlationId: mark.correlationId,
          eventId: null,
          now,
        });
  let result: { readonly outcome: StartAgainOutcome; readonly enrolmentId?: string };
  if (
    automation === undefined ||
    automation.status === 'archived' ||
    automation.published_version_id === null ||
    document === undefined
  )
    result = { outcome: 'deleted' };
  else if (automation.status === 'paused') {
    await note('paused');
    result = { outcome: 'paused' };
  } else if (refusal !== undefined && refusal.cause !== 'same_event') {
    await note('refused_loop', refusalDetail(refusal));
    result = { outcome: 'refused_loop' };
  } else if (!document.triggers.some((trigger) => trigger.id === mark.triggerId))
    // Published again without the trigger the event came through: it no longer starts.
    result = { outcome: 'trigger_removed' };
  else {
    const enrolled = await enrol(
      trx,
      businessId,
      ended.automation_id,
      automation.published_version_id,
      ended.record_id,
      document,
      {
        eventId: mark.eventId,
        correlationId: mark.correlationId,
        triggerId: mark.triggerId,
        state: {
          ...mark.state,
          // The run this one follows, and how many events it stands for.
          reentered: { after: ended.id, events: mark.events },
        },
      },
    );
    if (enrolled.outcome === 'already_went_through') await note('reentry_not_allowed');
    // A run started since the mark was made reads the record as new as this one would.
    result =
      enrolled.outcome === 'started'
        ? { outcome: 'started', enrolmentId: enrolled.enrolmentId }
        : { outcome: enrolled.outcome };
  }
  await trx
    .updateTable('automation.enrolments')
    .set({
      state: sql`state || ${JSON.stringify({ reentry: { ...mark, ...result } })}::jsonb`,
    })
    .where('id', '=', ended.id)
    .execute();
  return result;
}

/** Starting a record again as a command: only the engine runs it. */
export const startAgainCommand = defineCommand({
  name: 'automation.start_again',
  permission: 'automations.manage',
  input: startAgainReference.data,
  async handle(trx, input, command) {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the automation engine starts a record again.');
    return startAgain(trx, requireBusiness(command.context), input.enrolmentId);
  },
});

/** The worker's task: the run started again carries the marked event's correlation. */
export const startAgainTask = defineTask({
  ...startAgainReference,
  async run(data, { invocation, services }) {
    await runCommand(services, startAgainCommand, data, {
      ...invocation,
      context: { ...invocation.context, correlationId: data.correlationId },
    });
  },
});
