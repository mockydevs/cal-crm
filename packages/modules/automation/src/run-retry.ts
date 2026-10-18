// Running a failed run again: a person's command that puts a run that failed back at the
// step it failed at, on the version it began on, as a new visit to that step. It is refused
// whenever the run could not honestly go on: it did not fail, its automation is deleted or
// was published again since, its contact is gone or already back in the automation, or it
// has been run again too often.
import { defineCommand, requireBusiness } from '@repo/commands';
import { automationDocument, MAX_RUN_RETRIES, type AutomationRun } from '@repo/contracts';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { lockRecordRuns } from './enrolment.js';
import { addGoalWaits } from './goals.js';
import { readRun } from './history.js';
import { queueStep } from './queue-step.js';
import { addStopWaits } from './stops.js';

/** The failures that end a run because its path leads back on itself: the same again. */
const LOOP_BOUNDS: ReadonlySet<string> = new Set(['step_visit_limit', 'run_step_limit']);

export const retryRunInput = z.strictObject({ runId: z.string() });

export const retryRunCommand = defineCommand({
  name: 'automation.retry_run',
  permission: 'automations.manage',
  input: retryRunInput,
  audit: ({ runId }) => ({ runId }),
  async handle(trx, input, command): Promise<AutomationRun> {
    const businessId = requireBusiness(command.context);
    const runId = parsePublicId('automation_enrolment', input.runId);
    const found =
      runId === undefined
        ? undefined
        : await trx
            .selectFrom('automation.enrolments')
            .select(['id', 'record_id'])
            .where('id', '=', runId)
            .executeTakeFirst();
    if (found === undefined) throw new NotFoundError('automation_run', input.runId);
    // It starts a run of the record again, so the record's runs are held first, as for
    // every decision that starts or ends one; then the run's own row.
    await lockRecordRuns(trx, found.record_id);
    const run = await trx
      .selectFrom('automation.enrolments as run')
      .innerJoin('automation.automations as automation', 'automation.id', 'run.automation_id')
      .innerJoin('automation.versions as version', 'version.id', 'run.version_id')
      .select([
        'run.id',
        'run.status',
        'run.exit_reason',
        'run.state',
        'run.record_id',
        'run.automation_id',
        'run.version_id',
        'automation.status as automation_status',
        'automation.published_version_id',
        'version.document',
      ])
      .where('run.id', '=', found.id)
      .forUpdate('run')
      .executeTakeFirstOrThrow();
    if (run.status !== 'failed')
      throw new ConflictError(
        `Only a run that failed can be run again; this one is ${run.status}.`,
      );
    if (run.automation_status === 'archived')
      throw new ConflictError('The automation was deleted, so its runs cannot be run again.');
    if (run.published_version_id !== run.version_id)
      throw new ConflictError(
        'The automation has been published again since this run began, so the run cannot go on from its failed step. Enrol the contact again instead.',
      );
    if (LOOP_BOUNDS.has(run.exit_reason ?? ''))
      throw new ConflictError(
        'This run was ended because a path of the workflow leads back on itself; running it again would end the same way.',
      );
    const state = (run.state ?? {}) as Readonly<Record<string, unknown>>;
    const retried = typeof state['retried'] === 'number' ? state['retried'] : 0;
    if (retried >= MAX_RUN_RETRIES)
      throw new ConflictError(
        `This run has been run again ${String(MAX_RUN_RETRIES)} times, the most a run may be.`,
      );
    const record = await trx
      .selectFrom('crm.contacts')
      .select('id')
      .where('id', '=', run.record_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (record === undefined)
      throw new ConflictError('The contact is in the trash or gone, so the run cannot go on.');
    // The step it failed at: its last row that failed.
    const failed = await trx
      .selectFrom('automation.step_runs')
      .select('step_key')
      .where('enrolment_id', '=', run.id)
      .where('status', '=', 'failed')
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const document = automationDocument.parse(run.document);
    if (failed === undefined || document.steps[failed.step_key] === undefined)
      throw new ConflictError('This run has no failed step to go on from.');
    // What it waited on when it failed is over; the new visit begins with none of it.
    const {
      armed: _armed,
      received: _received,
      webhook: _webhook,
      emailCheck: _emailCheck,
      held: _held,
      manual: _manual,
      retrying: _retrying,
      goal: _goal,
      ...kept
    } = state;
    const sequence = typeof state['sequence'] === 'number' ? state['sequence'] : 0;
    // One live run per record and automation: the index refuses a second.
    const resumed = await sql<{ id: string }>`
      update automation.enrolments
      set status = 'running', current_step = ${failed.step_key}, wake_at = null,
          exit_reason = null, finished_at = null, updated_at = now(),
          state = ${JSON.stringify({
            ...kept,
            sequence: sequence + 1,
            retried: retried + 1,
            // A person ran it again: the loop's hourly spacing does not hold it.
            rerunFrom: failed.step_key,
          })}::jsonb
      where id = ${run.id}
        and not exists (
          select 1 from automation.enrolments other
          where other.business_id = ${businessId} and other.automation_id = ${run.automation_id}
            and other.record_id = ${run.record_id} and other.id <> ${run.id}
            and other.status in ('running', 'waiting'))
      returning id
    `.execute(trx);
    if (resumed.rows.length === 0)
      throw new ConflictError(
        'The contact is in this automation again already, and is in it once at a time.',
      );
    // It listens for its stop conditions and its goal again, as a run does from its start.
    await addStopWaits(trx, businessId, run.id, run.record_id, document);
    if (state['goalPassed'] !== true)
      await addGoalWaits(trx, businessId, run.id, run.record_id, document);
    await queueStep(trx, run.id);
    await command.emit({
      type: 'automation.run.retried',
      subject: { kind: 'automation_run', id: run.id },
      records: [run.record_id],
      payload: {
        automationId: toPublicId('automation', run.automation_id),
        step: failed.step_key,
        retry: retried + 1,
      },
    });
    return readRun(trx, input.runId);
  },
});
