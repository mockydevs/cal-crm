// Continuing a waiting run now: a person's command that ends a run's wait early. A wait for
// a time (`wait`, `wait.until`) simply wakes. A wait that stays at its step and ends down
// one of several branches (`wait.event`, `wait.condition`, `wait.appointment`) is told
// which branch to take, since nothing happened to choose one. It is refused whenever the
// run is not in such a wait: a message held for the sending window, a manual action, a
// webhook out for delivery, a retry and a goal are not waits a person ends this way.
//
// It takes the locks the scheduler's own wake takes, in the same order: the record's runs,
// then the run's row. Whichever of the two comes second finds the run already moved on:
// the timer's job does nothing (its sequence has passed), and this command answers 409.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  automationBranchNames,
  automationDocument,
  continueAutomationRunInput,
  type AutomationRun,
  type AutomationStep,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import type { TaskOptions } from '@repo/module-crm';
import { sql } from 'kysely';
import * as z from 'zod';

import { lockRecordRuns } from './enrolment.js';
import { readRun, runRevisionOf } from './history.js';
import { queueStep } from './queue-step.js';

export const continueRunInput = continueAutomationRunInput.extend({ runId: z.string() });

/** The waits a person may end early: the timing steps, and no other kind of waiting. */
const TIME_WAITS: ReadonlySet<AutomationStep['type']> = new Set(['wait', 'wait.until']);
const BRANCHING_WAITS: ReadonlySet<AutomationStep['type']> = new Set([
  'wait.event',
  'wait.condition',
  'wait.appointment',
]);

/** Whether a run waiting at a step of this type can be continued, and how. */
export function continuableWait(type: string | null | undefined): 'time' | 'branch' | undefined {
  return TIME_WAITS.has(type as AutomationStep['type'])
    ? 'time'
    : BRANCHING_WAITS.has(type as AutomationStep['type'])
      ? 'branch'
      : undefined;
}

// Why a run that waits at a step of another kind cannot be continued, in words.
function notAWait(type: string): string {
  if (type === 'manual.call' || type === 'manual.sms')
    return 'This run is waiting for a person to complete a manual action. Complete or skip it in Manual Actions instead.';
  if (type === 'webhook.call')
    return 'This run is waiting for a webhook to be delivered, which has its own attempts.';
  if (type === 'email.verify')
    return 'This run is waiting for its email address to be checked, which goes on by itself.';
  if (type === 'goal')
    return 'This run is waiting at its goal step, which goes on when the goal is met.';
  if (type === 'email.send' || type === 'sms.send')
    return 'This run is holding a message until it may be sent (the sending window, or a retry), not waiting in a wait step.';
  return 'This run is waiting to try a step again, not waiting in a wait step.';
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  user: 'a team member',
  api_key: 'an app with an API key',
  ai_agent: 'the assistant',
  system: 'the system',
};

/** Who is acting, by name where the names are known, for the run's history. */
async function actorWords(
  trx: DatabaseTransaction,
  context: TenantContext,
  names: TaskOptions['actorNames'] | undefined,
): Promise<string> {
  const lookup = names?.[context.actorKind];
  const named =
    lookup === undefined || context.actorId === undefined
      ? undefined
      : (await lookup(trx, [context.actorId])).get(context.actorId);
  return named ?? KIND_WORDS[context.actorKind] ?? 'someone';
}

/**
 * The command behind POST /automation-runs/{runId}/continue. `actorNames` is how the
 * server names people (the CRM's own lookups); without it the history says what kind of
 * actor continued the run.
 */
export function createContinueRunCommand(
  options: { readonly actorNames?: TaskOptions['actorNames'] | undefined } = {},
): Command<typeof continueRunInput, AutomationRun> {
  return defineCommand({
    name: 'automation.continue_run',
    permission: 'automations.manage',
    input: continueRunInput,
    audit: ({ runId, branch }) => ({ runId, branch: branch ?? null }),
    async handle(trx, input, command): Promise<AutomationRun> {
      requireBusiness(command.context);
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
      // The locks the scheduler's wake takes, in its order: the record's runs, then the run.
      await lockRecordRuns(trx, found.record_id);
      const run = await trx
        .selectFrom('automation.enrolments as run')
        .innerJoin('automation.versions as version', 'version.id', 'run.version_id')
        .select([
          'run.id',
          'run.status',
          'run.state',
          'run.record_id',
          'run.automation_id',
          'version.document',
        ])
        .where('run.id', '=', found.id)
        .forUpdate('run')
        .executeTakeFirstOrThrow();
      if (run.status !== 'waiting')
        throw new ConflictError(
          `Only a run that is waiting can be continued; this one is ${run.status}.`,
        );
      const state = (run.state ?? {}) as Readonly<Record<string, unknown>>;
      if (input.revision !== undefined && input.revision !== runRevisionOf(state))
        throw new ConflictError(
          'This run has moved on since it was read. Read it again before continuing it.',
        );
      // Where it waits: the one step row that is still waiting.
      const waiting = await trx
        .selectFrom('automation.step_runs')
        .select(['id', 'step_key', 'explanation'])
        .where('enrolment_id', '=', run.id)
        .where('status', '=', 'waiting')
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      const document = automationDocument.parse(run.document);
      const step = waiting === undefined ? undefined : document.steps[waiting.step_key];
      if (waiting === undefined || step === undefined)
        throw new ConflictError('This run is not waiting at a step that can be continued.');
      const kind = continuableWait(step.type);
      if (kind === undefined) throw new ConflictError(notAWait(step.type));
      const who = await actorWords(trx, command.context, options.actorNames);
      const now = new Date();
      const continued = { continuedBy: who, continuedAt: now.toISOString() };
      let branch: string | undefined;
      if (kind === 'time') {
        if (input.branch !== undefined)
          throw new ValidationError([
            {
              path: '/branch',
              code: 'no_branches',
              message: 'A wait for a time has no branches: leave branch out.',
            },
          ]);
        // The row says who ended the wait; it closes as the run goes on from it.
        await sql`
          update automation.step_runs
          set explanation = ${`${waiting.explanation} Continued by ${who} at ${now.toISOString()}, before the wait was over.`},
              output = output || ${JSON.stringify(continued)}::jsonb
          where id = ${waiting.id}
        `.execute(trx);
        await trx
          .updateTable('automation.enrolments')
          .set({ wake_at: now, updated_at: sql<Date>`now()` })
          .where('id', '=', run.id)
          .execute();
      } else {
        const armed = z
          .looseObject({
            step: z.string(),
            carry: z.record(z.string(), z.unknown()).optional(),
          })
          .safeParse(state['armed']);
        if (!armed.success || armed.data.step !== waiting.step_key)
          throw new ConflictError('This run is not waiting at a step that can be continued.');
        const names = automationBranchNames(step.type, step.config) ?? [];
        // A branch the wait had already decided, held only until its resume window opens.
        const held = z
          .looseObject({ branch: z.string(), output: z.record(z.string(), z.unknown()) })
          .safeParse(armed.data.carry?.['decided']);
        branch = input.branch ?? (held.success ? held.data.branch : undefined);
        if (branch === undefined)
          throw new ValidationError([
            {
              path: '/branch',
              code: 'required',
              message: `Say which branch the run takes: ${names.join(', ')}.`,
            },
          ]);
        if (!names.includes(branch))
          throw new ValidationError([
            {
              path: '/branch',
              code: 'unknown_branch',
              message: `${branch} is not a branch of this step: ${names.join(', ')}.`,
            },
          ]);
        const decided = {
          branch,
          // What the wait itself had found stays with the branch it found it for.
          output: {
            ...(held.success && held.data.branch === branch ? held.data.output : {}),
            ...continued,
          },
          explanation: `Continued by ${who}: the ${branch} branch was taken before the wait was over.`,
          continued: true,
        };
        await trx
          .updateTable('automation.enrolments')
          .set({
            wake_at: now,
            updated_at: sql<Date>`now()`,
            state: JSON.stringify({
              ...state,
              armed: { step: armed.data.step, carry: { ...armed.data.carry, decided } },
            }),
          })
          .where('id', '=', run.id)
          .execute();
        // Nothing more is waited for: the branch is chosen.
        await trx
          .deleteFrom('automation.event_waits')
          .where('enrolment_id', '=', run.id)
          .where('kind', '=', 'event')
          .execute();
      }
      // Its step runs as soon as this commits, in place of the job its timer had queued.
      await queueStep(trx, run.id);
      await command.emit({
        type: 'automation.run.continued',
        subject: { kind: 'automation_run', id: run.id },
        records: [run.record_id],
        payload: {
          automationId: toPublicId('automation', run.automation_id),
          step: waiting.step_key,
          ...(branch === undefined ? {} : { branch }),
        },
      });
      return readRun(trx, input.runId);
    },
  });
}
