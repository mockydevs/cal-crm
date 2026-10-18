// Settings → AI models: which model does which job, whose keys, the spending limit,
// privacy, and what the month has cost. These are the rows the gateway reads for every call
// (gateway.ts); nothing here calls a model.
import { createHash } from 'node:crypto';

import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  AI_LIMITS,
  aiJobs,
  updateAiSettingsInput,
  type AiJobKey,
  type AiModelChoice,
  type AiProviderKey,
  type AiReadiness,
  type AiSettings,
  type AiUsage,
  type UpdateAiSettingsInput,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, toPublicId } from '@repo/kernel';

import { isConnectable } from './connections.js';
import { isTested } from './evals/tested.js';
import { DEFAULT_JOB_MODELS } from './gateway.js';
import { sortKeys } from './json.js';
import { BUILT_IN_PRICES, dollarsToMicros, microsToDollars, priceKey } from './pricing.js';

/**
 * Claude's models, offered once a Claude key is connected. The ids are Anthropic's own
 * (pricing.ts has each one's price and where it was read). Any other model is offered by
 * being named on a connection, or priced by the agency.
 */
const CLAUDE_MODELS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
] as const;

/** What is stored for a business, or what holds until something is (0010's defaults). */
interface Stored {
  readonly enabled: boolean;
  readonly keySource: 'agency' | 'own';
  readonly monthlyLimit: string | null;
  readonly atLimit: 'pause' | 'continue';
  readonly maskContactDetails: boolean;
  readonly requestLogDays: number;
  readonly backup: { readonly provider: string; readonly model: string } | null;
  readonly jobs: Readonly<
    Partial<Record<AiJobKey, { readonly provider: string; readonly model: string }>>
  >;
  readonly limitReachedAt: Date | null;
}

const isJob = (job: string): job is AiJobKey => (aiJobs as readonly string[]).includes(job);

async function stored(trx: DatabaseTransaction, businessId: string): Promise<Stored> {
  const row = await trx
    .selectFrom('ai.settings')
    .selectAll()
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  const chosen = await trx
    .selectFrom('ai.job_models')
    .select(['job', 'provider', 'model'])
    .where('business_id', '=', businessId)
    .execute();
  const jobs: Partial<Record<AiJobKey, { provider: string; model: string }>> = {};
  for (const each of chosen)
    if (isJob(each.job)) jobs[each.job] = { provider: each.provider, model: each.model };
  const backupProvider = row?.backup_provider ?? null;
  const backupModel = row?.backup_model ?? null;
  return {
    enabled: row?.enabled ?? true,
    keySource: row?.key_source === 'own' ? 'own' : 'agency',
    monthlyLimit: row?.monthly_limit ?? null,
    atLimit: row?.at_limit === 'continue' ? 'continue' : 'pause',
    maskContactDetails: row?.mask_contact_details ?? false,
    requestLogDays: row?.request_log_days ?? 30,
    backup:
      backupProvider === null || backupModel === null
        ? null
        : { provider: backupProvider, model: backupModel },
    jobs,
    limitReachedAt: row?.limit_reached_at ?? null,
  };
}

/**
 * What a save is checked against: every value a person can set, in one order. Two amounts
 * that are the same money are the same revision, however they were written.
 */
function revisionOf(values: Stored): string {
  const { limitReachedAt: _reached, monthlyLimit, ...rest } = values;
  return createHash('sha256')
    .update(
      JSON.stringify(
        sortKeys({
          ...rest,
          monthlyLimit: monthlyLimit === null ? null : String(dollarsToMicros(monthlyLimit)),
        }),
      ),
    )
    .digest('hex');
}

/** The business's AI settings as Settings shows them, with what each choice can do now. */
export async function readAiSettings(
  trx: DatabaseTransaction,
  invocation: Pick<Invocation, 'context'>,
): Promise<AiSettings> {
  const { context } = invocation;
  const businessId = requireBusiness(context);
  const values = await stored(trx, businessId);

  // The connections the business's calls would use: its own, or its agency's.
  const usable = await trx
    .selectFrom('ai.provider_keys')
    .select(['provider', 'default_model'])
    .where('agency_id', '=', context.agencyId)
    .where((eb) =>
      values.keySource === 'own'
        ? eb('business_id', '=', businessId)
        : eb('business_id', 'is', null),
    )
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const connected = new Set(usable.map((row) => row.provider));
  const priced = new Set(
    (
      await trx
        .selectFrom('ai.model_prices')
        .select(['provider', 'model'])
        .where('agency_id', '=', context.agencyId)
        .orderBy('provider')
        .orderBy('model')
        .execute()
    ).map((row) => priceKey(row.provider, row.model)),
  );
  const hasPrice = (provider: string, model: string): boolean =>
    priced.has(priceKey(provider, model)) || priceKey(provider, model) in BUILT_IN_PRICES;

  // A limit that pauses cannot be kept for a model whose cost nobody can count.
  const needsPrice = values.monthlyLimit !== null && values.atLimit === 'pause';
  const readiness = (provider: string, model: string): AiReadiness =>
    !connected.has(provider) || !isConnectable(provider)
      ? 'no_key'
      : needsPrice && !hasPrice(provider, model)
        ? 'price_needed'
        : 'ready';

  const models = new Map<string, { provider: AiProviderKey; model: string; priced: boolean }>();
  const offer = (provider: string, model: string): void => {
    if (!isConnectable(provider) || !connected.has(provider)) return;
    models.set(priceKey(provider, model), { provider, model, priced: hasPrice(provider, model) });
  };
  if (connected.has('anthropic')) for (const model of CLAUDE_MODELS) offer('anthropic', model);
  for (const row of usable) if (row.default_model !== null) offer(row.provider, row.default_model);
  for (const key of priced) {
    const [provider = '', ...rest] = key.split('/');
    offer(provider, rest.join('/'));
  }

  return {
    enabled: values.enabled,
    keySource: values.keySource,
    monthlyLimit: values.monthlyLimit,
    atLimit: values.atLimit,
    maskContactDetails: values.maskContactDetails,
    requestLogDays: values.requestLogDays,
    backup:
      values.backup === null
        ? null
        : { ...values.backup, readiness: readiness(values.backup.provider, values.backup.model) },
    jobs: aiJobs.map((job) => {
      const chosen = values.jobs[job];
      const { provider, model } = chosen ?? DEFAULT_JOB_MODELS[job];
      return {
        job,
        provider,
        model,
        isDefault: chosen === undefined,
        tested: isTested(job, provider, model),
        readiness: readiness(provider, model),
      };
    }),
    models: [...models.values()],
    limitReachedAt: values.limitReachedAt?.toISOString() ?? null,
    revision: revisionOf(values),
  };
}

const sameChoice = (left: AiModelChoice | null, right: Stored['backup']): boolean =>
  left === null || right === null
    ? left === right
    : left.provider === right.provider && left.model === right.model;

/** The same money, whether it was written 50 or 50.0000. */
const sameAmount = (left: string | null, right: string | null): boolean =>
  left === null || right === null
    ? left === right
    : dollarsToMicros(left) === dollarsToMicros(right);

/**
 * Saves the business's AI settings whole, if they are still what the person was looking
 * at. The lock is the settings row the gateway also locks to admit a call under a limit,
 * so a call is admitted under the old settings or the new ones, never half of each.
 */
export const updateAiSettingsCommand = defineCommand({
  name: 'ai.update_settings',
  permission: 'ai.manage',
  input: updateAiSettingsInput,
  // Nothing here is a secret, and what the limit was changed to is worth keeping.
  audit: ({ revision: _revision, ...settings }: UpdateAiSettingsInput) => settings,
  async handle(trx, input, command): Promise<AiSettings> {
    const { context } = command;
    const businessId = requireBusiness(context);
    // A row to lock, with the defaults it would have had anyway.
    await trx
      .insertInto('ai.settings')
      .values({ business_id: businessId })
      .onConflict((conflict) => conflict.column('business_id').doNothing())
      .execute();
    await trx
      .selectFrom('ai.settings')
      .select('business_id')
      .where('business_id', '=', businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const before = await stored(trx, businessId);
    if (revisionOf(before) !== input.revision)
      throw new ConflictError(
        'These settings changed after you opened them. Reload the page and try again.',
      );

    const limitChanged =
      !sameAmount(input.monthlyLimit, before.monthlyLimit) || input.atLimit !== before.atLimit;
    await trx
      .updateTable('ai.settings')
      .set({
        enabled: input.enabled,
        key_source: input.keySource,
        monthly_limit: input.monthlyLimit,
        at_limit: input.atLimit,
        mask_contact_details: input.maskContactDetails,
        request_log_days: input.requestLogDays,
        backup_provider: input.backup?.provider ?? null,
        backup_model: input.backup?.model ?? null,
        // A new limit is a new line to cross: reaching it tells the owner again.
        ...(limitChanged ? { limit_reached_at: null } : {}),
      })
      .where('business_id', '=', businessId)
      .execute();
    for (const job of aiJobs) {
      const choice = input.jobs[job];
      if (choice === null)
        await trx
          .deleteFrom('ai.job_models')
          .where('business_id', '=', businessId)
          .where('job', '=', job)
          .execute();
      else {
        const row = { ...choice, updated_by_id: context.userId ?? null };
        await trx
          .insertInto('ai.job_models')
          .values({ business_id: businessId, job, ...row })
          .onConflict((conflict) => conflict.columns(['business_id', 'job']).doUpdateSet(row))
          .execute();
      }
    }
    const changed = [
      ...(input.enabled === before.enabled ? [] : ['enabled']),
      ...(input.keySource === before.keySource ? [] : ['keySource']),
      ...(sameAmount(input.monthlyLimit, before.monthlyLimit) ? [] : ['monthlyLimit']),
      ...(input.atLimit === before.atLimit ? [] : ['atLimit']),
      ...(input.maskContactDetails === before.maskContactDetails ? [] : ['maskContactDetails']),
      ...(input.requestLogDays === before.requestLogDays ? [] : ['requestLogDays']),
      ...(sameChoice(input.backup, before.backup) ? [] : ['backup']),
      ...aiJobs.flatMap((job) =>
        sameChoice(input.jobs[job], before.jobs[job] ?? null) ? [] : [`jobs.${job}`],
      ),
    ];
    await command.emit({
      type: 'ai_settings.updated',
      subject: { kind: 'business', id: businessId },
      payload: {
        changed,
        enabled: input.enabled,
        keySource: input.keySource,
        monthlyLimit: input.monthlyLimit,
        atLimit: input.atLimit,
        maskContactDetails: input.maskContactDetails,
        requestLogDays: input.requestLogDays,
      },
    });
    return readAiSettings(trx, command);
  },
});

/** Six places, as ai.requests keeps a cost. */
const exact = (sum: string | null): string => microsToDollars(dollarsToMicros(sum ?? '0'));

/**
 * This calendar month's spend (UTC), by job, and the latest calls. A call whose cost is
 * unknown is counted apart, never as nothing. What was said in a call is not read.
 */
export async function readAiUsage(
  trx: DatabaseTransaction,
  invocation: Pick<Invocation, 'context'>,
  now: () => Date,
): Promise<AiUsage> {
  const businessId = requireBusiness(invocation.context);
  const at = now();
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const byJob = await trx
    .selectFrom('ai.requests')
    .select((eb) => [
      'job',
      eb.fn.sum<string | null>('cost_estimate').as('spent'),
      eb.fn.countAll<string>().as('calls'),
      eb.fn
        .countAll<string>()
        .filterWhere((filter) =>
          filter.and([filter('cost_estimate', 'is', null), filter('status', '<>', 'started')]),
        )
        .as('unknown'),
    ])
    .where('business_id', '=', businessId)
    .where('started_at', '>=', monthStart)
    .groupBy('job')
    .orderBy('job')
    .execute();
  const recent = await trx
    .selectFrom('ai.requests')
    .select([
      'id',
      'started_at',
      'job',
      'provider',
      'model',
      'key_source',
      'status',
      'error_code',
      'cost_estimate',
      'latency_ms',
      'input_tokens',
      'output_tokens',
    ])
    .where('business_id', '=', businessId)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(AI_LIMITS.recentCalls)
    .execute();
  const limit = await trx
    .selectFrom('ai.settings')
    .select('monthly_limit')
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  const jobs = byJob.map((row) => ({
    job: row.job,
    spent: exact(row.spent),
    calls: Number(row.calls),
    unknownCostCalls: Number(row.unknown),
  }));
  return {
    month: `${String(monthStart.getUTCFullYear())}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`,
    spent: microsToDollars(jobs.reduce((total, job) => total + dollarsToMicros(job.spent), 0n)),
    calls: jobs.reduce((total, job) => total + job.calls, 0),
    unknownCostCalls: jobs.reduce((total, job) => total + job.unknownCostCalls, 0),
    limit: limit?.monthly_limit ?? null,
    byJob: jobs,
    recent: recent.map((row) => ({
      id: toPublicId('ai_request', row.id),
      startedAt: row.started_at.toISOString(),
      job: row.job,
      provider: row.provider,
      model: row.model,
      keySource: row.key_source === 'own' ? 'own' : 'agency',
      status:
        row.status === 'started' ||
        row.status === 'error' ||
        row.status === 'refused' ||
        row.status === 'fell_back'
          ? row.status
          : 'ok',
      errorCode: row.error_code,
      costEstimate: row.cost_estimate,
      latencyMs: row.latency_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    })),
  };
}
