// Delivering a webhook.call step. A step never holds its transaction open across a network
// call, so it only arms: the enrolment waits at the step and a delivery job is queued. The
// job calls out with no transaction open, then records what happened under the enrolment's
// lock, and the step runs again to take the result. A crash between the call and the record
// means the call is made again, so delivery is at least once; every attempt of one delivery
// carries the same delivery id for the receiver to tell.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Command,
  type Task,
  type TaskReference,
} from '@repo/commands';
import {
  automationDocument,
  renderMessageTemplate,
  type AutomationStep,
  type ConditionValues,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError, toPublicId, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import type { StepPlan } from './steps.js';
import { callWebhook, webhookRetryDelay, type WebhookHeaderValue } from './webhook.js';
import { openWebhookHeaderSecret } from './webhook-secrets.js';
import {
  openWebhookSecret,
  readWebhookSigningStatus,
  type SecretOpener,
} from './webhook-signing.js';

type WebhookStep = Extract<AutomationStep, { type: 'webhook.call' }>;

/**
 * How long after a delivery was due the step checks on it. A delivery job that was lost,
 * such as when a worker died, is queued again then.
 */
export const WEBHOOK_RECOVERY_MS = 5 * 60_000;

/** The deepest a body template may nest. */
const MAX_BODY_DEPTH = 32;

const outcome = z.union([
  z.strictObject({ ok: z.literal(true), status: z.int() }),
  z.strictObject({ ok: z.literal(false), code: z.string(), explanation: z.string() }),
]);

/** What an enrolment keeps while it waits on a webhook. */
const webhookState = z.strictObject({
  step: z.string(),
  /** How many attempts have been made. */
  attempt: z.int().min(0),
  /** The request body, fixed when the step armed, so every attempt sends the same. */
  body: z.string(),
  /**
   * The step's written header values, filled in when it armed. A header that sends a
   * stored secret is not here: the worker opens the secret as it sends, and nothing keeps it.
   */
  headers: z.array(z.strictObject({ name: z.string(), value: z.string() })).optional(),
  result: outcome.optional(),
});
type WebhookState = z.output<typeof webhookState>;

export const callWebhookReference = {
  name: 'automations.call_webhook',
  data: z.strictObject({
    enrolmentId: z.uuid(),
    /** The enrolment's sequence while it waits on this delivery. */
    sequence: z.int().min(0),
    attempt: z.int().min(0),
  }),
} satisfies TaskReference<z.ZodType>;

export type WebhookBody =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly code: string; readonly explanation: string };

/**
 * The request body. Without a template it is the standard envelope. A template must be JSON:
 * merge fields are filled in inside its text values only, after it is read, so a contact's
 * value can never change the body's structure. A field with no value refuses the step.
 */
export function webhookBody(
  template: string | undefined,
  values: ConditionValues,
  envelope: Readonly<Record<string, unknown>>,
): WebhookBody {
  if (template === undefined) return { ok: true, body: JSON.stringify(envelope) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch {
    return { ok: false, code: 'invalid_body', explanation: "The step's body is not JSON." };
  }
  const missing = new Set<string>();
  const seen = { tooDeep: false };
  const fill = (node: unknown, depth: number): unknown => {
    if (depth > MAX_BODY_DEPTH) {
      seen.tooDeep = true;
      return null;
    }
    if (typeof node === 'string') {
      // As a message body, so a value's own line breaks are kept.
      const rendered = renderMessageTemplate({ subject: '', body: node }, values);
      if (rendered.ok) return rendered.body;
      for (const field of rendered.fields) missing.add(field);
      return node;
    }
    if (Array.isArray(node)) return node.map((item: unknown) => fill(item, depth + 1));
    if (typeof node === 'object' && node !== null)
      return Object.fromEntries(
        Object.entries(node).map(([key, value]: [string, unknown]) => [
          key,
          fill(value, depth + 1),
        ]),
      );
    return node;
  };
  const filled = fill(parsed, 0);
  if (seen.tooDeep)
    return {
      ok: false,
      code: 'invalid_body',
      explanation: "The step's body is nested too deeply.",
    };
  if (missing.size > 0)
    return {
      ok: false,
      code: 'missing_values',
      explanation: `There is no value for ${[...missing].join(', ')}.`,
    };
  return { ok: true, body: JSON.stringify(filled) };
}

/**
 * The step's written header values, with merge fields filled in as the body's are. A field
 * with no value refuses the step. Headers that send a stored secret are left out.
 */
export function webhookHeaderValues(
  headers: WebhookStep['config']['headers'],
  values: ConditionValues,
):
  | { readonly ok: true; readonly headers: readonly WebhookHeaderValue[] }
  | { readonly ok: false; readonly code: string; readonly explanation: string } {
  const filled: WebhookHeaderValue[] = [];
  const missing = new Set<string>();
  for (const header of headers ?? []) {
    if (!('value' in header)) continue;
    const rendered = renderMessageTemplate({ subject: '', body: header.value }, values);
    if (rendered.ok) filled.push({ name: header.name, value: rendered.body });
    else for (const field of rendered.fields) missing.add(field);
  }
  return missing.size > 0
    ? {
        ok: false,
        code: 'missing_values',
        explanation: `There is no value for ${[...missing].join(', ')}.`,
      }
    : { ok: true, headers: filled };
}

const stateOf = (state: unknown): { sequence: number; webhook: WebhookState | undefined } => {
  const parsed = z
    .looseObject({ sequence: z.int().min(0).optional(), webhook: webhookState.optional() })
    .safeParse(state);
  return parsed.success
    ? { sequence: parsed.data.sequence ?? 0, webhook: parsed.data.webhook }
    : { sequence: 0, webhook: undefined };
};

async function enqueueDelivery(
  trx: DatabaseTransaction,
  enrolmentId: string,
  runAt: Date,
): Promise<void> {
  await sql`select private.enqueue_automation_webhook(${enrolmentId}::uuid, ${runAt}::timestamptz)`.execute(
    trx,
  );
}

// Runs the step again at a time: to take a result, or to check on a delivery whose job may
// be lost. The runner has the same call; importing it here would make the two files circular.
async function queueCheck(trx: DatabaseTransaction, enrolmentId: string, at: Date): Promise<void> {
  await sql`select private.enqueue_automation_step(${enrolmentId}::uuid, ${at}::timestamptz)`.execute(
    trx,
  );
}

/**
 * A visit to a webhook.call step. The first arms the delivery and waits; a later one takes
 * the result as the step's plan, or, when it woke with no result yet, queues the delivery
 * again. Returns 'waiting' when the enrolment stays at the step.
 */
export async function visitWebhook(
  trx: DatabaseTransaction,
  input: {
    readonly businessId: string;
    readonly enrolmentId: string;
    readonly recordId: string;
    readonly recordKind: string;
    readonly stepKey: string;
    readonly step: WebhookStep;
    readonly state: Readonly<Record<string, unknown>>;
    readonly sequence: number;
    readonly now: Date;
    readonly values: ConditionValues;
  },
): Promise<StepPlan | 'waiting'> {
  const waiting = stateOf(input.state).webhook;
  const next = typeof input.step.next === 'string' ? input.step.next : null;
  const checkAt = new Date(input.now.getTime() + WEBHOOK_RECOVERY_MS);

  if (waiting?.step === input.stepKey) {
    if (waiting.result === undefined) {
      // Woken with nothing recorded: the delivery job was lost, or is very late.
      await trx
        .updateTable('automation.enrolments')
        .set({ wake_at: checkAt, updated_at: sql<Date>`now()` })
        .where('id', '=', input.enrolmentId)
        .execute();
      await enqueueDelivery(trx, input.enrolmentId, input.now);
      await queueCheck(trx, input.enrolmentId, checkAt);
      return 'waiting';
    }
    return waiting.result.ok
      ? {
          kind: 'next',
          next,
          branch: null,
          output: { status: waiting.result.status },
          explanation: `The webhook answered ${String(waiting.result.status)}.`,
        }
      : { kind: 'fail', error: waiting.result.code, explanation: waiting.result.explanation };
  }

  if (!(await readWebhookSigningStatus(trx)).configured)
    return {
      kind: 'fail',
      error: 'no_webhook_secret',
      explanation: 'There is no webhook signing secret, and an unsigned webhook is never sent.',
    };
  const enrolment = await trx
    .selectFrom('automation.enrolments')
    .select(['automation_id', 'version_id'])
    .where('id', '=', input.enrolmentId)
    .executeTakeFirstOrThrow();
  const armedSequence = input.sequence + 1;
  const runId = toPublicId('automation_enrolment', input.enrolmentId);
  const body = webhookBody(input.step.config.body, input.values, {
    event: 'automation.webhook',
    deliveryId: `${runId}:${String(armedSequence)}`,
    automationId: toPublicId('automation', enrolment.automation_id),
    runId,
    step: input.stepKey,
    record: { kind: input.recordKind, id: input.recordId },
    queuedAt: input.now.toISOString(),
  });
  if (!body.ok) return { kind: 'fail', error: body.code, explanation: body.explanation };
  const headers = webhookHeaderValues(input.step.config.headers, input.values);
  if (!headers.ok) return { kind: 'fail', error: headers.code, explanation: headers.explanation };

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
      // Waiting, and unfinished, until the step runs again with the delivery's result.
      explanation: 'The webhook was queued to send.',
    })
    .execute();
  const armed: WebhookState = {
    step: input.stepKey,
    attempt: 0,
    body: body.body,
    ...(headers.headers.length === 0 ? {} : { headers: [...headers.headers] }),
  };
  await trx
    .updateTable('automation.enrolments')
    .set({
      status: 'waiting',
      wake_at: checkAt,
      updated_at: sql<Date>`now()`,
      state: JSON.stringify({ ...input.state, sequence: armedSequence, webhook: armed }),
    })
    .where('id', '=', input.enrolmentId)
    .execute();
  await enqueueDelivery(trx, input.enrolmentId, input.now);
  await queueCheck(trx, input.enrolmentId, checkAt);
  return 'waiting';
}

const recordInput = callWebhookReference.data.extend({
  result: z.union([
    z.strictObject({ ok: z.literal(true), status: z.int() }),
    z.strictObject({
      ok: z.literal(false),
      code: z.string().max(100),
      retryable: z.boolean(),
      message: z.string().max(1000),
      retryAfterMs: z.number().min(0).optional(),
    }),
  ]),
  now: z.iso.datetime().optional(),
});

/**
 * Records one attempt's result, if the enrolment still waits on that attempt: a result, or
 * a failure with no attempts left, wakes the step to take it; a failure worth retrying
 * queues the next attempt. Only the engine runs it.
 */
export const recordWebhookResultCommand: Command<typeof recordInput, 'recorded' | 'stale'> =
  defineCommand({
    name: 'automation.record_webhook',
    permission: 'automations.manage',
    input: recordInput,
    // The response's text comes from outside and stays out of the audit log.
    audit: ({ enrolmentId, sequence, attempt, result }) => ({
      enrolmentId,
      sequence,
      attempt,
      ok: result.ok,
      ...(result.ok ? { status: result.status } : { code: result.code }),
    }),
    async handle(trx, input, command): Promise<'recorded' | 'stale'> {
      if (command.context.actorKind !== 'system')
        throw new ForbiddenError('Only the automation engine records webhook results.');
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
      const { sequence, webhook } = stateOf(enrolment.state);
      if (
        webhook === undefined ||
        webhook.result !== undefined ||
        sequence !== input.sequence ||
        webhook.attempt !== input.attempt
      )
        return 'stale';
      const save = async (next: WebhookState, wakeAt: Date | null) => {
        await trx
          .updateTable('automation.enrolments')
          .set({
            state: sql`state || ${JSON.stringify({ webhook: next })}::jsonb`,
            wake_at: wakeAt,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', enrolment.id)
          .execute();
      };
      const made = input.attempt + 1;
      const delay =
        input.result.ok || !input.result.retryable
          ? undefined
          : webhookRetryDelay(made, input.result.retryAfterMs);
      if (delay !== undefined) {
        const retryAt = new Date(now.getTime() + delay);
        const checkAt = new Date(retryAt.getTime() + WEBHOOK_RECOVERY_MS);
        await save({ ...webhook, attempt: made }, checkAt);
        await enqueueDelivery(trx, enrolment.id, retryAt);
        await queueCheck(trx, enrolment.id, checkAt);
        return 'recorded';
      }
      await save(
        {
          ...webhook,
          attempt: made,
          result: input.result.ok
            ? { ok: true, status: input.result.status }
            : {
                ok: false,
                code: input.result.code,
                explanation: `The webhook failed after ${String(made)} ${made === 1 ? 'attempt' : 'attempts'}: ${input.result.message}`,
              },
        },
        now,
      );
      await queueCheck(trx, enrolment.id, now);
      return 'recorded';
    },
  });

/** What the delivery needs, read in one short transaction before the call. */
async function prepare(
  trx: DatabaseTransaction,
  vault: SecretOpener,
  data: z.output<typeof callWebhookReference.data>,
): Promise<
  | {
      readonly config: WebhookStep['config'];
      readonly body: unknown;
      readonly secret: string | undefined;
      /** Every header the step sends, or the stored secret one names that is gone. */
      readonly headers:
        | { readonly ok: true; readonly values: readonly WebhookHeaderValue[] }
        | { readonly ok: false; readonly missing: string };
    }
  | undefined
> {
  const enrolment = await trx
    .selectFrom('automation.enrolments as enrolment')
    .innerJoin('automation.versions as version', 'version.id', 'enrolment.version_id')
    .select(['enrolment.current_step', 'enrolment.state', 'version.document'])
    .where('enrolment.id', '=', data.enrolmentId)
    .where('enrolment.status', '=', 'waiting')
    .executeTakeFirst();
  const stepKey = enrolment?.current_step ?? undefined;
  if (enrolment === undefined || stepKey === undefined) return undefined;
  const { sequence, webhook } = stateOf(enrolment.state);
  if (
    webhook === undefined ||
    webhook.result !== undefined ||
    webhook.step !== stepKey ||
    sequence !== data.sequence ||
    webhook.attempt !== data.attempt
  )
    return undefined;
  const step = automationDocument.parse(enrolment.document).steps[stepKey];
  if (step?.type !== 'webhook.call') return undefined;
  const body: unknown = JSON.parse(webhook.body);
  return {
    config: step.config,
    body,
    secret: await openWebhookSecret(trx, vault),
    headers: await stepHeaders(trx, vault, step.config.headers ?? [], webhook.headers ?? []),
  };
}

/** The step's headers in its order: written values as they were filled in, secrets opened. */
async function stepHeaders(
  trx: DatabaseTransaction,
  vault: SecretOpener,
  headers: NonNullable<WebhookStep['config']['headers']>,
  filled: readonly WebhookHeaderValue[],
): Promise<
  | { readonly ok: true; readonly values: readonly WebhookHeaderValue[] }
  | { readonly ok: false; readonly missing: string }
> {
  const values: WebhookHeaderValue[] = [];
  for (const header of headers) {
    if ('value' in header) {
      const value = filled.find((each) => each.name === header.name)?.value ?? header.value;
      values.push({ name: header.name, value });
      continue;
    }
    const secret = await openWebhookHeaderSecret(trx, vault, header.secret);
    if (secret === undefined) return { ok: false, missing: header.secret };
    values.push({ name: header.name, value: secret });
  }
  return { ok: true, values };
}

/**
 * The worker's task for one delivery attempt, made with the worker's vault, which alone
 * opens the signing secret. `call` is the network; tests pass their own.
 */
export function createCallWebhookTask({
  vault,
  call = callWebhook,
}: {
  vault: SecretOpener;
  call?: typeof callWebhook;
}): Task<typeof callWebhookReference.data> {
  return defineTask({
    ...callWebhookReference,
    async run(data, { invocation, services }) {
      const context: TenantContext = invocation.context;
      const prepared = await withTenant(services.db, context, (trx) => prepare(trx, vault, data));
      if (prepared === undefined) return;
      const record = (result: z.input<typeof recordInput>['result']) =>
        runCommand(services, recordWebhookResultCommand, { ...data, result }, invocation);
      // The secret was removed after the step armed: nothing is sent unsigned.
      if (prepared.secret === undefined) {
        await record({
          ok: false,
          code: 'no_webhook_secret',
          retryable: false,
          message: 'There is no webhook signing secret.',
        });
        return;
      }
      // A header's stored secret was deleted: the step fails rather than send without it.
      if (!prepared.headers.ok) {
        await record({
          ok: false,
          code: 'secret_missing',
          retryable: false,
          message: `There is no webhook secret named ${prepared.headers.missing}.`,
        });
        return;
      }
      // No transaction is open while the request is out.
      const result = await call(prepared.config, prepared.body, {
        secret: prepared.secret,
        headers: prepared.headers.values,
        deliveryId: `${toPublicId('automation_enrolment', data.enrolmentId)}:${String(data.sequence)}`,
      });
      await record(
        result.ok
          ? { ok: true, status: result.status }
          : {
              ok: false,
              code: result.code,
              retryable: result.retryable,
              message: result.message.slice(0, 1000),
              ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
            },
      );
    },
  });
}
