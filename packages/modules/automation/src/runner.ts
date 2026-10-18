// Runs an enrolment's steps. Each step is one job, in one transaction that records the step
// and moves the enrolment, so after a crash or an upgrade the enrolment continues from its
// saved step, and no visit of a step runs twice.
import { randomUUID } from 'node:crypto';

import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Command,
  type CommandContext,
  type Services,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { ForbiddenError, toPublicId } from '@repo/kernel';
import {
  automationDocument,
  LOOP_MIN_WAIT_MS,
  MAX_RUN_STEPS,
  MAX_STEP_VISITS,
  type AutomationStep,
  type ConditionValues,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';
import * as z from 'zod';

import { runAction, type ActionOptions } from './actions.js';
import { comparedFields } from './compared-fields.js';
import { lockRecordRuns } from './enrolment.js';
import type { GoalMet } from './goals.js';
import { isManualStep, manualWait, visitManualAction } from './manual-actions.js';
import { queueStep } from './queue-step.js';
import { startAgainReference, startsAgain } from './reentry-mark.js';
import { cancelRuns, settleWaitingSteps } from './settle.js';
import { failurePath, planSendingHold, planStep, retryTime, WINDOWED_STEPS } from './steps.js';
import { clearWaits } from './stops.js';
import { addEventWaits, readWaitedAppointment, RECHECKED_WAITS } from './waits.js';
import { timeZoneOf } from './time-zone.js';
import { endTrashedRuns, inTrash } from './trashed.js';
import { visitWebhook } from './webhook-task.js';
import { visitEmailCheck } from './email-verify-task.js';
import { redactWebhookUrl } from './webhook.js';
import { runValues } from './run-values.js';

export const runStepReference = {
  name: 'automations.run_step',
  data: z.strictObject({
    enrolmentId: z.uuid(),
    /** How many steps the enrolment had run when this job was queued. */
    sequence: z.int().min(0),
  }),
} satisfies TaskReference<z.ZodType>;

const runStepInput = runStepReference.data.extend({ now: z.iso.datetime().optional() });

interface EnrolmentState {
  readonly sequence?: number;
  /** A wait.event step waiting, and the event that arrived for it. */
  readonly armed?: {
    readonly step: string;
    /** What the step's plan asked to keep for its next visit: a deadline, a decision held. */
    readonly carry?: Readonly<Record<string, unknown>>;
  };
  readonly received?: string;
  /** A message step held until the sending window opens. */
  readonly held?: { readonly step: string };
  /** The goal was met and moved the run to its goal step, which has not run yet (goals.ts). */
  readonly goal?: GoalMet;
  /** The run has been through its goal step. */
  readonly goalPassed?: boolean;
  /**
   * A step that failed for a reason that can pass, waiting to be tried again: how many
   * times it has been tried, and the sequence of its first try, which every try's
   * idempotency key is made from.
   */
  readonly retrying?: { readonly step: string; readonly tries: number; readonly visit: number };
  readonly [key: string]: unknown;
}

// The step an enrolment waits at and will run again: a wait for an event, a webhook out for
// delivery, an email address being checked, a message held for the sending window, or a manual action in the queue. The row
// its next run writes continues that visit; any other step begins a new one.
function waitingAt(state: EnrolmentState): string | undefined {
  const webhook = z.looseObject({ step: z.string() }).safeParse(state['webhook']);
  const emailCheck = z.looseObject({ step: z.string() }).safeParse(state['emailCheck']);
  return (
    state.armed?.step ??
    state.held?.step ??
    (webhook.success ? webhook.data.step : undefined) ??
    (emailCheck.success ? emailCheck.data.step : undefined) ??
    manualWait(state)?.step ??
    state.retrying?.step
  );
}

/**
 * What a step was given, kept with its run for the run history: its settings in the
 * version that ran and, for a condition, the values it compared, as they were then. The
 * sequence is the engine's own: which visit to the step this was.
 */
function stepInput(
  step: AutomationStep,
  sequence: number,
  values: ConditionValues | undefined,
  held?: 'sending_window' | 'loop_interval',
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    sequence,
    type: step.type,
    // A webhook's query values may hold a key, which the run's history must not show.
    config:
      step.type === 'webhook.call'
        ? { ...step.config, url: redactWebhookUrl(step.config.url) }
        : step.config,
  };
  // What held the step back, when the row is only the wait before it ran.
  if (held !== undefined) input['held'] = held;
  if ((step.type === 'condition' || step.type === 'wait.condition') && values !== undefined)
    input['values'] = Object.fromEntries(
      [
        ...comparedFields(
          'branches' in step.config ? step.config.branches.map((each) => each.if) : step.config.if,
        ),
      ].map((field) => [field, values[field] ?? null]),
    );
  return input;
}

/**
 * Why a run may not begin another visit to a step, if it may not: the bound that keeps a
 * path which leads back from running for ever. A run takes MAX_RUN_STEPS step jobs at most,
 * and visits one step MAX_STEP_VISITS times at most. A step's earlier visits are its rows
 * that began one; they are counted only once the run has taken that many jobs, so a run
 * that loops nowhere is never counted.
 */
async function visitRefusal(
  trx: DatabaseTransaction,
  enrolmentId: string,
  stepKey: string,
  sequence: number,
): Promise<{ readonly code: string; readonly explanation: string } | undefined> {
  if (sequence >= MAX_RUN_STEPS)
    return {
      code: 'run_step_limit',
      explanation: `This run had taken ${String(MAX_RUN_STEPS)} steps, the most a run may take, so it was ended here. A path of the workflow leads back on itself.`,
    };
  if (sequence < MAX_STEP_VISITS) return undefined;
  const { visits } = await trx
    .selectFrom('automation.step_runs')
    .select(sql<number>`count(*)::int`.as('visits'))
    .where('enrolment_id', '=', enrolmentId)
    .where('step_key', '=', stepKey)
    .where('resumes', '=', false)
    .executeTakeFirstOrThrow();
  return visits >= MAX_STEP_VISITS
    ? {
        code: 'step_visit_limit',
        explanation: `This step had already run ${String(MAX_STEP_VISITS)} times in this run, the most a run may visit one step, so the run was ended here. A Go To, or a next, leads back to it.`,
      }
    : undefined;
}

/**
 * When a new visit to a step may run, if not now: an hour after the step last ran in this
 * run, when that is still to come. Every row of the step counts, a held visit's resumed row
 * too, so a held visit's time is when it ran, not when it was held.
 */
async function loopHold(
  trx: DatabaseTransaction,
  enrolmentId: string,
  stepKey: string,
  now: Date,
): Promise<Date | undefined> {
  const { last } = await trx
    .selectFrom('automation.step_runs')
    .select(sql<Date | null>`max(started_at)`.as('last'))
    .where('enrolment_id', '=', enrolmentId)
    .where('step_key', '=', stepKey)
    .executeTakeFirstOrThrow();
  if (last === null) return undefined;
  const at = new Date(last.getTime() + LOOP_MIN_WAIT_MS);
  return at.getTime() > now.getTime() ? at : undefined;
}

/**
 * Runs one step of one enrolment, if the job is still the current one: a job queued for an
 * earlier visit (its sequence has passed), or one that woke before its wait ended, does
 * nothing. Pausing an automation stops new enrolments only; running ones go on. Deleting it
 * ends them: a run found still going in a deleted automation is cancelled here, before
 * anything of the step is done.
 */
export async function runStep(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: ActionOptions,
  enrolmentId: string,
  sequence: number,
  now: Date = new Date(),
): Promise<'ran' | 'skipped'> {
  const businessId = requireBusiness(command.context);
  // A step that starts or ends other runs of its record holds the record's runs still, and
  // takes that hold before its own row: two runs removing each other then go one after the
  // other, and the second finds itself removed, where each holding its own row and
  // waiting for the other's would end one of them in a deadlock.
  const ahead = await sql<{ record_id: string; step_type: string | null }>`
    select e.record_id, v.document -> 'steps' -> e.current_step ->> 'type' as step_type
    from automation.enrolments e
    join automation.versions v on v.business_id = e.business_id and v.id = e.version_id
    where e.id = ${enrolmentId} and e.status in ('running', 'waiting')
  `.execute(trx);
  const [found] = ahead.rows;
  if (found === undefined) return 'skipped';
  // A wait that reads the record and then listens for its changes holds them too: an event
  // being matched waits for the listening rows, so no change falls between the two.
  if (
    found.step_type === 'automation.run' ||
    found.step_type === 'automation.remove' ||
    RECHECKED_WAITS.has(found.step_type ?? '')
  )
    await lockRecordRuns(trx, found.record_id);
  const enrolment = await trx
    .selectFrom('automation.enrolments as enrolment')
    .innerJoin('automation.versions as version', 'version.id', 'enrolment.version_id')
    .innerJoin('automation.automations as automation', 'automation.id', 'enrolment.automation_id')
    .innerJoin('crm.records as record', 'record.id', 'enrolment.record_id')
    .select([
      'record.kind as record_kind',
      'automation.status as automation_status',
      'enrolment.id',
      'enrolment.automation_id',
      'enrolment.version_id',
      'enrolment.status',
      'enrolment.record_id',
      'enrolment.current_step',
      'enrolment.state',
      'enrolment.wake_at',
      'version.document',
    ])
    .where('enrolment.id', '=', enrolmentId)
    .where('enrolment.status', 'in', ['running', 'waiting'])
    .forUpdate('enrolment')
    .executeTakeFirst();
  if (enrolment === undefined) return 'skipped';
  // The delete cancels every run it can see; one that was being started as it committed is
  // ended here instead, whichever of its jobs comes first.
  if (enrolment.automation_status === 'archived') {
    await cancelRuns(trx, { enrolmentId: enrolment.id });
    return 'skipped';
  }
  const state = (enrolment.state ?? {}) as EnrolmentState;
  if ((state.sequence ?? 0) !== sequence) return 'skipped';
  // A contact moved to the trash leaves the workflow before anything of the step is done,
  // whichever comes first, the trash's own event or this job (trashed.ts).
  if (enrolment.record_kind === 'contact' && (await inTrash(trx, enrolment.record_id))) {
    await endTrashedRuns(trx, sql`e.id = ${enrolment.id}`, (event) => command.emit(event));
    return 'ran';
  }
  // Woken before its wait is over, it does nothing, unless the event it waits for arrived.
  if (
    enrolment.status === 'waiting' &&
    enrolment.wake_at !== null &&
    enrolment.wake_at.getTime() > now.getTime() &&
    state.received === undefined
  )
    return 'skipped';

  const finish = async (
    status: 'completed' | 'failed',
    reason: string | null,
    /** The step a failed run failed at, for whoever is told of the failure. */
    failedAt?: string,
  ) => {
    // Whatever it waited at is over: the run went on from it to its end.
    await settleWaitingSteps(trx, enrolment.id, 'succeeded');
    await trx
      .updateTable('automation.enrolments')
      .set({
        status,
        current_step: null,
        wake_at: null,
        exit_reason: reason,
        finished_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
        state: JSON.stringify({ ...state, sequence: sequence + 1 }),
      })
      .where('id', '=', enrolment.id)
      .execute();
    await clearWaits(trx, enrolment.id);
    // For the record's timeline and for outside listeners (AUTOMATIONS.md section 5).
    await command.emit({
      type: status === 'completed' ? 'automation.run.completed' : 'automation.run.failed',
      subject: { kind: 'automation_run', id: enrolment.id },
      records: [enrolment.record_id],
      payload: {
        automationId: toPublicId('automation', enrolment.automation_id),
        ...(reason === null ? {} : { reason }),
        ...(failedAt === undefined ? {} : { step: failedAt }),
      },
    });
    // An event came for the record while it ran: it starts once more (reentry-mark.ts).
    const mark = startsAgain(state);
    if (mark !== undefined)
      command.enqueue(startAgainReference, {
        enrolmentId: enrolment.id,
        correlationId: mark.correlationId,
      });
    return 'ran' as const;
  };

  // A path that ended right after a wait has nothing left to run.
  if (enrolment.current_step === null) return finish('completed', null);
  // The version the enrolment began on; later edits and publishes never change it.
  const document = automationDocument.parse(enrolment.document);
  const step = document.steps[enrolment.current_step];
  if (step === undefined) return finish('failed', 'missing_step');
  // Run again at the step it waits at, this visit goes on where the waiting row left it;
  // at any other step the run has moved on, and what it waited at before is over.
  const resumes = waitingAt(state) === enrolment.current_step;
  if (!resumes) await settleWaitingSteps(trx, enrolment.id, 'succeeded');
  // A new visit to a step is refused once the run has looped as far as a run may.
  const refusal = resumes
    ? undefined
    : await visitRefusal(trx, enrolment.id, enrolment.current_step, sequence);
  if (refusal !== undefined) {
    await trx
      .insertInto('automation.step_runs')
      .values({
        business_id: businessId,
        enrolment_id: enrolment.id,
        automation_id: enrolment.automation_id,
        version_id: enrolment.version_id,
        step_key: enrolment.current_step,
        status: 'failed',
        input: JSON.stringify(stepInput(step, sequence, undefined)),
        explanation: refusal.explanation,
        error: JSON.stringify({ code: refusal.code }),
        finished_at: sql<Date>`now()`,
      })
      .execute();
    return finish('failed', refusal.code, enrolment.current_step);
  }
  // A loop goes round once an hour at most: a step visited again sooner waits at the step
  // until an hour has passed since its last visit, then runs.
  const spaced =
    resumes || state['rerunFrom'] === enrolment.current_step
      ? undefined
      : await loopHold(trx, enrolment.id, enrolment.current_step, now);
  if (spaced !== undefined) {
    await trx
      .insertInto('automation.step_runs')
      .values({
        business_id: businessId,
        enrolment_id: enrolment.id,
        automation_id: enrolment.automation_id,
        version_id: enrolment.version_id,
        step_key: enrolment.current_step,
        status: 'waiting',
        input: JSON.stringify(stepInput(step, sequence, undefined, 'loop_interval')),
        output: JSON.stringify({ wakeAt: spaced.toISOString() }),
        explanation: `This step ran less than an hour ago in this run, and a loop goes round once an hour at most, so it waits until ${spaced.toISOString()}.`,
      })
      .execute();
    await trx
      .updateTable('automation.enrolments')
      .set({
        status: 'waiting',
        wake_at: spaced,
        updated_at: sql<Date>`now()`,
        state: JSON.stringify({
          ...state,
          sequence: sequence + 1,
          held: { step: enrolment.current_step },
        }),
      })
      .where('id', '=', enrolment.id)
      .execute();
    await queueStep(trx, enrolment.id, spaced);
    return 'ran';
  }
  const timeZone = await timeZoneOf(
    trx,
    businessId,
    enrolment.record_id,
    document.settings.timezone,
  );
  // The sending window (settings.sendingWindow): a message step reached outside it waits at
  // the step until the window opens, in the zone the automation's settings name. Messaging's
  // own rules still apply to the message once it is queued: quiet hours in the contact's
  // zone, consent and the daily limit can hold or refuse it after this lets it through.
  const window = document.settings.sendingWindow;
  const hold =
    window !== undefined && WINDOWED_STEPS.has(step.type)
      ? planSendingHold(window, now, timeZone)
      : undefined;
  if (hold?.kind === 'hold') {
    const wakeAt = hold.wakeAt;
    const output = JSON.stringify({ wakeAt: wakeAt.toISOString() });
    if (state.held?.step === enrolment.current_step) {
      // Woken after the window had closed again, as after an outage: the same wait goes on.
      await trx
        .updateTable('automation.step_runs')
        .set({ output, explanation: hold.explanation })
        .where('enrolment_id', '=', enrolment.id)
        .where('status', '=', 'waiting')
        .execute();
      await trx
        .updateTable('automation.enrolments')
        .set({ wake_at: wakeAt, updated_at: sql<Date>`now()` })
        .where('id', '=', enrolment.id)
        .execute();
      await queueStep(trx, enrolment.id, wakeAt);
      return 'ran';
    }
    await trx
      .insertInto('automation.step_runs')
      .values({
        business_id: businessId,
        enrolment_id: enrolment.id,
        automation_id: enrolment.automation_id,
        version_id: enrolment.version_id,
        step_key: enrolment.current_step,
        status: 'waiting',
        input: JSON.stringify(stepInput(step, sequence, undefined, 'sending_window')),
        output,
        explanation: hold.explanation,
      })
      .execute();
    await trx
      .updateTable('automation.enrolments')
      .set({
        status: 'waiting',
        wake_at: wakeAt,
        updated_at: sql<Date>`now()`,
        state: JSON.stringify({
          ...state,
          sequence: sequence + 1,
          held: { step: enrolment.current_step },
        }),
      })
      .where('id', '=', enrolment.id)
      .execute();
    await queueStep(trx, enrolment.id, wakeAt);
    return 'ran';
  }
  // A step being tried again after a failure that can pass: this is another try of the
  // same visit.
  const retrying = state.retrying?.step === enrolment.current_step ? state.retrying : undefined;
  // A webhook is the one action that leaves the database, so it has a visit of its own.
  const webhook =
    step.type === 'webhook.call'
      ? await visitWebhook(trx, {
          businessId,
          enrolmentId: enrolment.id,
          recordId: enrolment.record_id,
          recordKind: enrolment.record_kind,
          stepKey: enrolment.current_step,
          step,
          state,
          sequence,
          now,
          values: await runValues(trx, enrolment.record_id, enrolment.id),
        })
      : undefined;
  if (webhook === 'waiting') return 'ran';
  // An email check is made outside the step's transaction too (email-verify-task.ts).
  const emailCheck =
    step.type === 'email.verify'
      ? await visitEmailCheck(trx, {
          businessId,
          enrolmentId: enrolment.id,
          recordId: enrolment.record_id,
          recordKind: enrolment.record_kind,
          stepKey: enrolment.current_step,
          step,
          state,
          sequence,
          now,
        })
      : undefined;
  if (emailCheck === 'waiting') return 'ran';
  // A manual action waits for a person, so it too has a visit of its own.
  const manual = isManualStep(step)
    ? await visitManualAction(
        trx,
        command,
        {
          assignees: options.tasks.assignees,
          actorNames: options.tasks.actorNames,
          publicUrl: options.publicUrl,
        },
        {
          businessId,
          enrolmentId: enrolment.id,
          automationId: enrolment.automation_id,
          versionId: enrolment.version_id,
          recordId: enrolment.record_id,
          recordKind: enrolment.record_kind,
          stepKey: enrolment.current_step,
          step,
          state,
          sequence,
          values: await runValues(trx, enrolment.record_id, enrolment.id),
        },
      )
    : undefined;
  if (manual === 'waiting') return 'ran';
  // Woken while its action is still open: nothing has been decided, so nothing is done.
  if (manual === 'idle') return 'skipped';
  const action =
    hold ??
    webhook ??
    emailCheck ??
    manual ??
    (await runAction(
      trx,
      command,
      step,
      { id: enrolment.record_id, kind: enrolment.record_kind },
      {
        enrolmentId: enrolment.id,
        automationId: enrolment.automation_id,
        stepKey: enrolment.current_step,
        // Every try of one visit carries the first try's key: what is sent is sent once.
        sequence: retrying?.visit ?? sequence,
        now,
        timeZone,
      },
      options,
    ));
  // What the planner reads: only a step the engine didn't run itself is planned.
  const values =
    action === undefined ? await runValues(trx, enrolment.record_id, enrolment.id) : undefined;
  const waitedAt = state.armed?.step === enrolment.current_step ? state.armed : undefined;
  // The appointment a wait is for, read anew at each visit: it may have been moved.
  const appointment =
    action === undefined && step.type === 'wait.appointment'
      ? await readWaitedAppointment(trx, {
          recordId: enrolment.record_id,
          enrolmentId: enrolment.id,
          now,
          kept: waitedAt?.carry?.['appointment'],
        })
      : undefined;
  const plan =
    action ??
    planStep({
      key: enrolment.current_step,
      step,
      values: values ?? {},
      now,
      timeZone,
      enrolmentId: enrolment.id,
      ...(waitedAt === undefined
        ? {}
        : { armed: { receivedEventId: state.received ?? null, carry: waitedAt.carry } }),
      ...(appointment === undefined ? {} : { appointment }),
      ...(step.type === 'goal'
        ? {
            goal: {
              ...(state.goal?.step === enrolment.current_step ? { met: state.goal } : {}),
              passed: state.goalPassed === true,
            },
          }
        : {}),
    });
  // Whatever a wait.event, webhook or held step decided, its waiting is over once it runs
  // again: its waiting row closes as this row, which continues the visit, is written.
  const {
    armed,
    received,
    webhook: delivered,
    emailCheck: checkedEmail,
    held,
    manual: closed,
    goal: _met,
    retrying: _tried,
    rerunFrom: _rerun,
    ...rest
  } = state;
  const tries = (retrying?.tries ?? 0) + 1;
  const retryAt = plan.kind === 'fail' ? retryTime(step, plan.error, tries, now) : undefined;
  if (plan.kind === 'fail' && retryAt !== undefined) {
    // It failed for a reason that can pass: the run waits at the step and tries it again.
    // One waiting row covers the tries, saying which failed, why, and when the next is.
    const waitingRow = {
      output: JSON.stringify({ wakeAt: retryAt.toISOString() }),
      explanation: `Try ${String(tries)} failed (${plan.error}): ${plan.explanation} It will be tried again at ${retryAt.toISOString()} (retry ${String(tries)} of ${String(step.retry?.times ?? tries)}).`,
    };
    if (retrying === undefined) {
      if (resumes) await settleWaitingSteps(trx, enrolment.id, 'succeeded');
      await trx
        .insertInto('automation.step_runs')
        .values({
          business_id: businessId,
          enrolment_id: enrolment.id,
          automation_id: enrolment.automation_id,
          version_id: enrolment.version_id,
          step_key: enrolment.current_step,
          resumes,
          status: 'waiting',
          input: JSON.stringify(stepInput(step, sequence, values)),
          ...waitingRow,
        })
        .execute();
    } else
      await trx
        .updateTable('automation.step_runs')
        .set(waitingRow)
        .where('enrolment_id', '=', enrolment.id)
        .where('status', '=', 'waiting')
        .execute();
    await trx
      .updateTable('automation.enrolments')
      .set({
        status: 'waiting',
        wake_at: retryAt,
        updated_at: sql<Date>`now()`,
        state: JSON.stringify({
          ...rest,
          sequence: sequence + 1,
          retrying: {
            step: enrolment.current_step,
            tries,
            visit: retrying?.visit ?? sequence,
          },
        }),
      })
      .where('id', '=', enrolment.id)
      .execute();
    await queueStep(trx, enrolment.id, retryAt);
    return 'ran';
  }
  // What a step that failed for good does to the run: stop it, or let it go on.
  const failed = plan.kind === 'fail' ? failurePath(step) : undefined;
  const tried =
    retrying === undefined
      ? ''
      : plan.kind === 'fail'
        ? ` It was tried ${String(tries)} times.`
        : ` It took ${String(tries)} tries.`;
  const explanation = `${plan.explanation}${tried}${failed === undefined ? '' : ` ${failed.words}`}`;
  // A goal step that lets the run through is over for the run: it listens for the goal no
  // more, and a path that leads back to the step finds it passed.
  const through = step.type === 'goal' && plan.kind === 'next';
  const settled: EnrolmentState = through ? { ...rest, goalPassed: true } : rest;
  if (armed !== undefined) await clearWaits(trx, enrolment.id, 'event');
  if (through) await clearWaits(trx, enrolment.id, 'goal');
  // The same wait going on (its appointment moved, its condition judged again, a decision
  // held for the resume window) keeps its one waiting row, which is brought up to date.
  const goesOn = plan.kind === 'arm' && plan.again === true && resumes;
  if (goesOn)
    await trx
      .updateTable('automation.step_runs')
      .set({
        output: JSON.stringify({ wakeAt: plan.wakeAt.toISOString() }),
        explanation: plan.explanation,
      })
      .where('enrolment_id', '=', enrolment.id)
      .where('status', '=', 'waiting')
      .execute();
  if (resumes && !goesOn) await settleWaitingSteps(trx, enrolment.id, 'succeeded');
  const waits = plan.kind === 'wait' || plan.kind === 'arm';
  if (!goesOn)
    await trx
      .insertInto('automation.step_runs')
      .values({
        business_id: businessId,
        enrolment_id: enrolment.id,
        automation_id: enrolment.automation_id,
        version_id: enrolment.version_id,
        step_key: enrolment.current_step,
        resumes,
        status: plan.kind === 'fail' ? 'failed' : waits ? 'waiting' : 'succeeded',
        input: JSON.stringify(stepInput(step, sequence, values)),
        output: JSON.stringify(
          plan.kind === 'next' || plan.kind === 'exit'
            ? plan.output
            : plan.kind === 'wait' || plan.kind === 'arm'
              ? { wakeAt: plan.wakeAt.toISOString() }
              : {},
        ),
        branch: plan.kind === 'next' ? plan.branch : (failed?.branch ?? null),
        explanation,
        error: plan.kind === 'fail' ? JSON.stringify({ code: plan.error }) : null,
        // A wait is finished when the run goes on from it, not when it begins.
        finished_at: waits ? null : sql<Date>`now()`,
      })
      .execute();

  if (plan.kind === 'fail') {
    if (failed === undefined) return finish('failed', plan.error, enrolment.current_step);
    // The step failed and the run goes on: it has not failed, and nothing says it has.
    if (failed.next === null) return finish('completed', null);
    await trx
      .updateTable('automation.enrolments')
      .set({
        status: 'running',
        current_step: failed.next,
        wake_at: null,
        updated_at: sql<Date>`now()`,
        state: JSON.stringify({ ...settled, sequence: sequence + 1 }),
      })
      .where('id', '=', enrolment.id)
      .execute();
    await queueStep(trx, enrolment.id);
    return 'ran';
  }
  if (plan.kind === 'exit') {
    // The step removed the record from this automation too: the run ends here, as the
    // runs it removed ended, and is told of the same way. No later step of it runs.
    await trx
      .updateTable('automation.enrolments')
      .set({
        status: 'exited',
        current_step: null,
        wake_at: null,
        exit_reason: plan.reason,
        finished_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
        state: JSON.stringify({ ...settled, sequence: sequence + 1 }),
      })
      .where('id', '=', enrolment.id)
      .execute();
    await clearWaits(trx, enrolment.id);
    await command.emit({
      type: 'automation.run.stopped',
      subject: { kind: 'automation_run', id: enrolment.id },
      records: [enrolment.record_id],
      payload: {
        automationId: toPublicId('automation', enrolment.automation_id),
        reason: plan.reason,
      },
    });
    return 'ran';
  }
  if (plan.kind === 'next' && plan.next === null) return finish('completed', null);
  if (plan.kind === 'arm') {
    // It waits at this same step: an arriving event or the timeout runs it again. A goal
    // step has listened for its events since the run began, and adds none; neither does a
    // wait whose decision is only held until its resume window opens.
    if (plan.carry?.['decided'] === undefined)
      await addEventWaits(
        trx,
        businessId,
        enrolment.id,
        enrolment.record_id,
        step,
        plan.event,
        plan.wakeAt,
      );
    await trx
      .updateTable('automation.enrolments')
      .set({
        status: 'waiting',
        wake_at: plan.wakeAt,
        updated_at: sql<Date>`now()`,
        state: JSON.stringify({
          ...settled,
          sequence: sequence + 1,
          armed: {
            step: enrolment.current_step,
            ...(plan.carry === undefined ? {} : { carry: plan.carry }),
          },
        }),
      })
      .where('id', '=', enrolment.id)
      .execute();
    await queueStep(trx, enrolment.id, plan.wakeAt);
    return 'ran';
  }
  const waiting = plan.kind === 'wait';
  await trx
    .updateTable('automation.enrolments')
    .set({
      status: waiting ? 'waiting' : 'running',
      current_step: plan.next,
      wake_at: waiting ? plan.wakeAt : null,
      updated_at: sql<Date>`now()`,
      state: JSON.stringify({ ...settled, sequence: sequence + 1 }),
    })
    .where('id', '=', enrolment.id)
    .execute();
  await queueStep(trx, enrolment.id, waiting ? plan.wakeAt : undefined);
  return 'ran';
}

/**
 * One step as a command, so its actions run through the command layer and its policies, with
 * their events and jobs kept with the step or not at all. Only the engine runs it. now is
 * there for test runs and tests, which fast-forward time; the worker's jobs never carry it.
 * It is made with what its actions need from other modules, which the server composes, so
 * the worker's steps resolve a task's assignee exactly as the API's task routes do.
 */
export function createRunStepCommand(
  options: ActionOptions,
): Command<typeof runStepInput, 'ran' | 'skipped'> {
  return defineCommand({
    name: 'automation.run_step',
    permission: 'automations.manage',
    input: runStepInput,
    audit: ({ enrolmentId, sequence }) => ({ enrolmentId, sequence }),
    async handle(trx, input, command): Promise<'ran' | 'skipped'> {
      if (command.context.actorKind !== 'system')
        throw new ForbiddenError('Only the automation engine runs steps.');
      const now = input.now === undefined ? undefined : new Date(input.now);
      return runStep(trx, command, options, input.enrolmentId, input.sequence, now);
    },
  });
}

/** The worker's task for one step, running the step command made with the same options. */
export function createRunStepTask(options: ActionOptions): Task<typeof runStepReference.data> {
  const command = createRunStepCommand(options);
  return defineTask({
    ...runStepReference,
    async run(data, { invocation, services }) {
      await runCommand(services, command, data, invocation);
    },
  });
}

/**
 * The sweeper: queues every enrolment whose wait is over, in case its job was lost, such as
 * when a worker died. Identifiers are listed first; each enrolment is then queued in its
 * own tenant transaction, enrolment row before job.
 */
export async function scheduleDueEnrolments(services: Services, limit = 1000): Promise<number> {
  const { rows } = await sql<{ agency_id: string; business_id: string; enrolment_id: string }>`
    select * from private.due_automation_enrolments(${limit})
  `.execute(services.db);
  for (const row of rows)
    await withTenant(
      services.db,
      {
        agencyId: row.agency_id,
        businessId: row.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      },
      (trx) => queueStep(trx, row.enrolment_id),
    );
  return rows.length;
}
