// An Email verification step. A step never holds its transaction open across a network
// call, so it only arms: the enrolment waits at the step and a check job is queued. The job
// asks email verification to check the contact's primary address now (messaging's
// checkEmailAddressNow, which reuses a result that is recent enough and keeps the daily
// limit), with no transaction open, then records what it found under the enrolment's lock,
// and the step runs again to take the result. A check that has to wait, because another run
// of it is calling or the provider asked to, is asked again a few times, and the run then
// goes on with what verification holds.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Command,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { automationDocument, type AutomationStep } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';
import {
  checkEmailAddressNow,
  emailVerificationState,
  readVerificationSettings,
  type VerificationTaskOptions,
} from '@repo/module-messaging';
import { sql } from 'kysely';
import * as z from 'zod';

import type { StepPlan } from './steps.js';

type EmailVerifyStep = Extract<AutomationStep, { type: 'email.verify' }>;

/**
 * How long after a check was due the step looks in on it. A check job that was lost, such
 * as when a worker died, is queued again then.
 */
export const EMAIL_CHECK_RECOVERY_MS = 5 * 60_000;

/** How often a check that has to wait is asked again before the run goes on without it. */
export const EMAIL_CHECK_MAX_ATTEMPTS = 6;

/** The shortest and the longest wait before a check that has to wait is asked again. */
const SOONEST_RETRY_MS = 5_000;
const LATEST_RETRY_MS = 60 * 60_000;

const statuses = ['valid', 'risky', 'invalid', 'unknown'] as const;

const found = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('checked'),
    reused: z.boolean(),
    status: z.enum(statuses),
    depth: z.enum(['domain', 'mailbox']),
  }),
  z.strictObject({ kind: z.literal('excluded') }),
  z.strictObject({ kind: z.literal('off') }),
  z.strictObject({ kind: z.literal('no_email') }),
  /** Asked again and again, it still had to wait. */
  z.strictObject({ kind: z.literal('gave_up') }),
]);
type Found = z.output<typeof found>;

/** What an enrolment keeps while it waits on an email check. */
const emailCheckState = z.strictObject({
  step: z.string(),
  /** How many times the check has been asked. */
  attempt: z.int().min(0),
  result: found.optional(),
});
type EmailCheckState = z.output<typeof emailCheckState>;

export const checkEmailReference = {
  name: 'automations.check_email',
  data: z.strictObject({
    enrolmentId: z.uuid(),
    /** The enrolment's sequence while it waits on this check. */
    sequence: z.int().min(0),
    attempt: z.int().min(0),
  }),
} satisfies TaskReference<z.ZodType>;

const stateOf = (state: unknown): { sequence: number; check: EmailCheckState | undefined } => {
  const parsed = z
    .looseObject({ sequence: z.int().min(0).optional(), emailCheck: emailCheckState.optional() })
    .safeParse(state);
  return parsed.success
    ? { sequence: parsed.data.sequence ?? 0, check: parsed.data.emailCheck }
    : { sequence: 0, check: undefined };
};

async function enqueueCheck(trx: DatabaseTransaction, enrolmentId: string, runAt: Date) {
  await sql`select private.enqueue_automation_email_check(${enrolmentId}::uuid, ${runAt}::timestamptz)`.execute(
    trx,
  );
}

// Runs the step again at a time: to take a result, or to look in on a check whose job may
// be lost. The runner has the same call; importing it here would make the two files circular.
async function queueStep(trx: DatabaseTransaction, enrolmentId: string, at: Date) {
  await sql`select private.enqueue_automation_step(${enrolmentId}::uuid, ${at}::timestamptz)`.execute(
    trx,
  );
}

/** The contact's primary email address, as crm keeps it, or nothing. */
async function primaryEmail(trx: DatabaseTransaction, contactId: string) {
  const row = await trx
    .selectFrom('crm.contact_identities')
    .select('value_normalized')
    .where('contact_id', '=', contactId)
    .where('kind', '=', 'email')
    .where('is_primary', '=', true)
    .executeTakeFirst();
  return row?.value_normalized;
}

const goOn = (
  next: string | null,
  output: Readonly<Record<string, unknown>>,
  explanation: string,
): StepPlan => ({ kind: 'next', next, branch: null, output, explanation });

/** The step's plan from what the check found. */
async function planOf(
  trx: DatabaseTransaction,
  result: Found,
  next: string | null,
  contactId: string,
  maxAgeDays: number,
): Promise<StepPlan> {
  switch (result.kind) {
    case 'checked':
      return goOn(
        next,
        { status: result.status, depth: result.depth },
        result.reused
          ? `The address was checked in the last ${String(maxAgeDays)} days, so that result was used: ${result.status}.`
          : `The address was checked: ${result.status} (${result.depth === 'mailbox' ? 'the mailbox' : 'the domain only'}).`,
      );
    case 'excluded':
      return goOn(
        next,
        { status: 'excluded' },
        'The address is excluded from email verification, so it was not checked.',
      );
    case 'no_email':
      return goOn(next, {}, 'The contact has no email address, so nothing was checked.');
    case 'off':
    case 'gave_up': {
      const address = await primaryEmail(trx, contactId);
      const status = address === undefined ? null : await emailVerificationState(trx, address);
      return goOn(
        next,
        status === null ? {} : { status },
        result.kind === 'off'
          ? 'Email verification is off, so the address was not checked.'
          : 'The check could not be made in time, so the run went on with the result there was.',
      );
    }
  }
}

/**
 * A visit to an Email verification step. The first arms the check and waits, unless there
 * is nothing to check; a later one takes the result as the step's plan, or, when it woke
 * with no result yet, queues the check again. Returns 'waiting' when the enrolment stays at
 * the step.
 */
export async function visitEmailCheck(
  trx: DatabaseTransaction,
  input: {
    readonly businessId: string;
    readonly enrolmentId: string;
    readonly recordId: string;
    readonly recordKind: string;
    readonly stepKey: string;
    readonly step: EmailVerifyStep;
    readonly state: Readonly<Record<string, unknown>>;
    readonly sequence: number;
    readonly now: Date;
  },
): Promise<StepPlan | 'waiting'> {
  const next = typeof input.step.next === 'string' ? input.step.next : null;
  const { maxAgeDays } = input.step.config;
  if (input.recordKind !== 'contact')
    return {
      kind: 'fail',
      error: 'unsupported_record',
      explanation: `A ${input.recordKind} has no email address to check.`,
    };
  const checkAt = new Date(input.now.getTime() + EMAIL_CHECK_RECOVERY_MS);
  const waiting = stateOf(input.state).check;
  if (waiting?.step === input.stepKey) {
    if (waiting.result !== undefined)
      return planOf(trx, waiting.result, next, input.recordId, maxAgeDays);
    // Woken with nothing recorded: the check job was lost, or is very late.
    await trx
      .updateTable('automation.enrolments')
      .set({ wake_at: checkAt, updated_at: sql<Date>`now()` })
      .where('id', '=', input.enrolmentId)
      .execute();
    await enqueueCheck(trx, input.enrolmentId, input.now);
    await queueStep(trx, input.enrolmentId, checkAt);
    return 'waiting';
  }

  // Nothing to check, or nothing that would be checked: the run goes on at once.
  const address = await primaryEmail(trx, input.recordId);
  if (address === undefined) return planOf(trx, { kind: 'no_email' }, next, input.recordId, 0);
  if ((await emailVerificationState(trx, address)) === 'excluded')
    return planOf(trx, { kind: 'excluded' }, next, input.recordId, maxAgeDays);
  if (!(await readVerificationSettings(trx)).enabled)
    return planOf(trx, { kind: 'off' }, next, input.recordId, maxAgeDays);

  const enrolment = await trx
    .selectFrom('automation.enrolments')
    .select(['automation_id', 'version_id'])
    .where('id', '=', input.enrolmentId)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('automation.step_runs')
    .values({
      business_id: input.businessId,
      enrolment_id: input.enrolmentId,
      automation_id: enrolment.automation_id,
      version_id: enrolment.version_id,
      step_key: input.stepKey,
      status: 'waiting',
      input: JSON.stringify({ sequence: input.sequence, type: input.step.type }),
      output: JSON.stringify({}),
      // Waiting, and unfinished, until the step runs again with what the check found.
      explanation: 'The email address was queued to be checked.',
    })
    .execute();
  const armed: EmailCheckState = { step: input.stepKey, attempt: 0 };
  await trx
    .updateTable('automation.enrolments')
    .set({
      status: 'waiting',
      wake_at: checkAt,
      updated_at: sql<Date>`now()`,
      state: JSON.stringify({ ...input.state, sequence: input.sequence + 1, emailCheck: armed }),
    })
    .where('id', '=', input.enrolmentId)
    .execute();
  await enqueueCheck(trx, input.enrolmentId, input.now);
  await queueStep(trx, input.enrolmentId, checkAt);
  return 'waiting';
}

const recordInput = checkEmailReference.data.extend({
  result: z.union([
    found,
    z.strictObject({ kind: z.literal('waiting'), retryAt: z.iso.datetime() }),
  ]),
  now: z.iso.datetime().optional(),
});

/**
 * Records what one check found, if the enrolment still waits on that check: a result wakes
 * the step to take it; a check that has to wait is asked again then, until it has been
 * asked EMAIL_CHECK_MAX_ATTEMPTS times. Only the engine runs it.
 */
export const recordEmailCheckCommand: Command<typeof recordInput, 'recorded' | 'stale'> =
  defineCommand({
    name: 'automation.record_email_check',
    permission: 'automations.manage',
    input: recordInput,
    audit: ({ enrolmentId, sequence, attempt, result }) => ({
      enrolmentId,
      sequence,
      attempt,
      kind: result.kind,
      ...(result.kind === 'checked' ? { status: result.status } : {}),
    }),
    async handle(trx, input, command): Promise<'recorded' | 'stale'> {
      if (command.context.actorKind !== 'system')
        throw new ForbiddenError('Only the automation engine records email checks.');
      requireBusiness(command.context);
      const now = input.now === undefined ? new Date() : new Date(input.now);
      const enrolment = await trx
        .selectFrom('automation.enrolments')
        .select(['id', 'state'])
        .where('id', '=', input.enrolmentId)
        .where('status', '=', 'waiting')
        .forUpdate()
        .executeTakeFirst();
      if (enrolment === undefined) return 'stale';
      const { sequence, check } = stateOf(enrolment.state);
      if (
        check === undefined ||
        check.result !== undefined ||
        sequence !== input.sequence ||
        check.attempt !== input.attempt
      )
        return 'stale';
      const save = async (state: EmailCheckState, wakeAt: Date) => {
        await trx
          .updateTable('automation.enrolments')
          .set({
            state: sql`state || ${JSON.stringify({ emailCheck: state })}::jsonb`,
            wake_at: wakeAt,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', enrolment.id)
          .execute();
      };
      const made = input.attempt + 1;
      const { result } = input;
      if (result.kind === 'waiting' && made < EMAIL_CHECK_MAX_ATTEMPTS) {
        const asked = new Date(result.retryAt).getTime() - now.getTime();
        const retryAt = new Date(
          now.getTime() + Math.min(Math.max(asked, SOONEST_RETRY_MS), LATEST_RETRY_MS),
        );
        const checkAt = new Date(retryAt.getTime() + EMAIL_CHECK_RECOVERY_MS);
        await save({ ...check, attempt: made }, checkAt);
        await enqueueCheck(trx, enrolment.id, retryAt);
        await queueStep(trx, enrolment.id, checkAt);
        return 'recorded';
      }
      await save(
        {
          ...check,
          attempt: made,
          result: result.kind === 'waiting' ? { kind: 'gave_up' } : result,
        },
        now,
      );
      await queueStep(trx, enrolment.id, now);
      return 'recorded';
    },
  });

/** What the check needs, read in one short transaction before it is made. */
async function prepare(
  trx: DatabaseTransaction,
  data: z.output<typeof checkEmailReference.data>,
): Promise<{ readonly address: string | undefined; readonly maxAgeDays: number } | undefined> {
  const enrolment = await trx
    .selectFrom('automation.enrolments as enrolment')
    .innerJoin('automation.versions as version', 'version.id', 'enrolment.version_id')
    .select([
      'enrolment.current_step',
      'enrolment.state',
      'enrolment.record_id',
      'version.document',
    ])
    .where('enrolment.id', '=', data.enrolmentId)
    .where('enrolment.status', '=', 'waiting')
    .executeTakeFirst();
  const stepKey = enrolment?.current_step ?? undefined;
  if (enrolment === undefined || stepKey === undefined) return undefined;
  const { sequence, check } = stateOf(enrolment.state);
  if (
    check === undefined ||
    check.result !== undefined ||
    check.step !== stepKey ||
    sequence !== data.sequence ||
    check.attempt !== data.attempt
  )
    return undefined;
  const step = automationDocument.parse(enrolment.document).steps[stepKey];
  if (step?.type !== 'email.verify') return undefined;
  return {
    address: await primaryEmail(trx, enrolment.record_id),
    maxAgeDays: step.config.maxAgeDays,
  };
}

/**
 * The worker's task for one check of an Email verification step. `emailChecks` is what
 * email verification checks with: the worker's vault for the provider's key, and in tests
 * a stand-in provider and DNS.
 */
export function createCheckEmailTask(
  emailChecks: VerificationTaskOptions = {},
): Task<typeof checkEmailReference.data> {
  return defineTask({
    ...checkEmailReference,
    async run(data, { invocation, services }) {
      const prepared = await withTenant(services.db, invocation.context, (trx) =>
        prepare(trx, data),
      );
      if (prepared === undefined) return;
      const record = (result: z.input<typeof recordInput>['result']) =>
        runCommand(services, recordEmailCheckCommand, { ...data, result }, invocation);
      // The contact's address was removed after the step armed.
      if (prepared.address === undefined) {
        await record({ kind: 'no_email' });
        return;
      }
      // No transaction is open while the address is checked.
      const checked = await checkEmailAddressNow(
        services,
        invocation,
        { address: prepared.address, maxAgeDays: prepared.maxAgeDays },
        emailChecks,
      );
      await record(
        checked.kind === 'waiting'
          ? { kind: 'waiting', retryAt: checked.retryAt.toISOString() }
          : checked,
      );
    },
  });
}
