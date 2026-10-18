// The AI gateway: every model call the product makes goes through generate. It is the one
// place that
//   * sends a job to the model chosen for it, and to the backup model when that one fails;
//   * holds a business to its monthly spending limit, counting calls still in flight;
//   * masks phone numbers and email addresses when the business asks, before any adapter
//     sees the request;
//   * writes ai.requests for every call, before the call and after it.
//
// Settings' "Test" comes through here too: testConnection makes one short call on a
// business's account, by the same admission; checkConnection asks a provider only whether
// it accepts the key, where there is no business to charge.
//
// It runs in the worker, which alone can open a provider's key. A call is made outside any
// database transaction: one short transaction admits it and records that it started,
// another records how it ended.
import { randomUUID } from 'node:crypto';

import { requireBusiness } from '@repo/commands';
import { withTenant, type Database, type DatabaseTransaction, type Json } from '@repo/db';
import type { TenantContext } from '@repo/kernel';

import { createAnthropicProvider } from './anthropic.js';
import { logOf, maskOutbound, partsLog, type LoggedRequest } from './masking.js';
import { createOpenAiProvider, OPENAI_BASE_URL } from './openai.js';
import {
  BUILT_IN_PRICES,
  dollarsToMicros,
  estimateCostMicros,
  microsToDollars,
  priceKey,
  pricesCover,
  worstCaseMicros,
  type PriceSource,
} from './pricing.js';
import {
  textOf,
  type AiMessage,
  type AiProvider,
  type AiProviderName,
  type AssistantPart,
  type CacheTtl,
  type ModelPrices,
  type ProviderErrorCode,
  type ProviderRequest,
  type ProviderResponse,
  type StopReason,
  type TokenUsage,
  type ToolDefinition,
} from './provider.js';
import type { LocalServer } from './addresses.js';
import { createAiTransport, type AiTransport } from './transport.js';
import { waitForRetry } from './assistant-cancellation.js';

/** What a provider's key is sealed for in the vault: the only purpose the gateway opens. */
export const AI_KEY_PURPOSE = 'ai.provider_key';

/** The jobs a text model does (ai.job_models.job, without `search`, which is embeddings). */
export const AI_JOBS = ['automation_builder', 'replies', 'briefings', 'sorting'] as const;
export type AiJob = (typeof AI_JOBS)[number];

/** What a test of a connection is recorded as in ai.requests.job. */
export const CONNECTION_TEST_JOB = 'connection_test';
/** Every job a call can be recorded under. */
export type RecordedJob = AiJob | typeof CONNECTION_TEST_JOB;

/**
 * The model each job uses until Settings chooses another. Model ids are Anthropic's own
 * (https://platform.claude.com/docs/en/api/messages, `Model`).
 */
export const DEFAULT_JOB_MODELS: Readonly<
  Record<AiJob, { readonly provider: AiProviderName; readonly model: string }>
> = {
  automation_builder: { provider: 'anthropic', model: 'claude-opus-5-5' },
  replies: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  briefings: { provider: 'anthropic', model: 'claude-opus-5-5' },
  sorting: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
};

/**
 * How long each job asks for its shared prefix to be cached (which has the arithmetic). An
 * hour where the next call of the same prompt usually comes more than five minutes but less
 * than an hour later: a person's next message to the assistant, the next draft or the next
 * message to sort on a small install. Five minutes for briefings, which run for every
 * business together once a day, and for a test, too short to be cached at all. A job asks
 * for the hour only where the model has a price for it.
 */
export const JOB_CACHE_TTL: Readonly<Record<RecordedJob, CacheTtl>> = {
  automation_builder: '1h',
  replies: '1h',
  sorting: '1h',
  briefings: '5m',
  connection_test: '5m',
};

/** The part of the worker's vault the gateway needs: opening a secret for a purpose. */
export interface SecretReader {
  read(trx: DatabaseTransaction, secretId: string, purpose: string): Promise<string>;
}

export interface GatewayRequest {
  readonly job: AiJob;
  /** Which version of the job's prompt this is, such as `replies/3`: kept with the call. */
  readonly promptVersion: string;
  readonly system: string;
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly maxOutputTokens: number;
}

export interface GatewayCallOptions {
  readonly signal?: AbortSignal;
  /** One provider call, in milliseconds: 100 to 900,000. Five minutes when left out. */
  readonly timeoutMs?: number;
  readonly onTextDelta?: (text: string) => void;
}

export type GatewayResult =
  | {
      readonly outcome: 'ok';
      readonly parts: readonly AssistantPart[];
      readonly text: string;
      readonly stop: StopReason;
      readonly provider: AiProviderName;
      readonly model: string;
      readonly usedBackup: boolean;
      readonly usage: TokenUsage | null;
      /** USD micros, or null when the cost is unknown (no price, or no usage reported). */
      readonly costMicros: bigint | null;
      /** The call's row in ai.requests. */
      readonly requestId: string;
    }
  | {
      readonly outcome: 'refused';
      readonly category: string | null;
      readonly provider: AiProviderName;
      readonly model: string;
      readonly requestId: string;
    }
  /** Every model that could be tried failed; `code` is the last failure. */
  | { readonly outcome: 'failed'; readonly code: ProviderErrorCode; readonly requestId: string }
  /** The spending limit: reached, or unenforceable because the model has no known price. */
  | { readonly outcome: 'paused'; readonly reason: 'limit_reached' | 'price_unknown' }
  /** AI is turned off for the business. */
  | { readonly outcome: 'off' }
  | {
      readonly outcome: 'not_configured';
      readonly reason: 'no_key' | 'key_unreadable' | 'provider_not_supported';
    };

type SkipReason = 'no_key' | 'key_unreadable' | 'provider_not_supported' | 'price_unknown';

/** Why a test could not be made at all: nothing was sent anywhere. */
export type ConnectionProblem =
  'no_connection' | 'no_model' | 'key_unreadable' | 'provider_not_supported';

/** What one short call to a connection's model found (Settings → AI models, "Test"). */
export type ConnectionTestResult =
  /** The model answered. A model that declined to answer still answered. */
  | {
      readonly outcome: 'ok';
      readonly latencyMs: number;
      readonly requestId: string;
      readonly costMicros: bigint | null;
    }
  | {
      readonly outcome: 'failed';
      readonly code: ProviderErrorCode;
      readonly latencyMs: number;
      readonly requestId: string;
    }
  | { readonly outcome: 'paused'; readonly reason: 'limit_reached' | 'price_unknown' }
  | { readonly outcome: 'off' }
  | { readonly outcome: 'not_configured'; readonly reason: ConnectionProblem };

/** What asking a provider for its models found: whether it takes the key. No model is called. */
export type KeyCheckResult =
  | { readonly outcome: 'ok'; readonly latencyMs: number }
  | { readonly outcome: 'failed'; readonly code: ProviderErrorCode; readonly latencyMs: number }
  | { readonly outcome: 'not_configured'; readonly reason: ConnectionProblem };

/**
 * What the gateway tells the logs. Never a prompt, an answer, a key or an address: ids,
 * names of models, counts and categories only.
 */
export type GatewayEvent =
  | {
      readonly type: 'request';
      readonly agencyId: string;
      readonly businessId: string;
      readonly correlationId: string;
      readonly callId: string;
      readonly requestId: string;
      readonly job: RecordedJob;
      readonly promptVersion: string;
      readonly provider: AiProviderName;
      readonly model: string;
      readonly keySource: 'agency' | 'own';
      readonly attempt: number;
      readonly status: 'ok' | 'refused' | 'error';
      readonly errorCode: ProviderErrorCode | null;
      readonly latencyMs: number;
      readonly usage: TokenUsage | null;
      /** USD micros as text, or null when unknown. */
      readonly costMicros: string | null;
    }
  | {
      readonly type: 'skipped';
      readonly agencyId: string;
      readonly businessId: string;
      readonly correlationId: string;
      readonly job: RecordedJob;
      readonly reason: SkipReason | ConnectionProblem;
    }
  /** A provider was asked whether it takes a key (checkConnection): no model was called. */
  | {
      readonly type: 'key_check';
      readonly agencyId: string;
      readonly businessId: string | null;
      readonly correlationId: string;
      readonly provider: AiProviderName;
      readonly status: 'ok' | 'error';
      readonly errorCode: ProviderErrorCode | null;
      readonly latencyMs: number;
    }
  | {
      readonly type: 'limit_reached';
      readonly agencyId: string;
      readonly businessId: string;
      readonly atLimit: 'pause' | 'continue';
      readonly limitMicros: string;
      readonly spentMicros: string;
    };

export interface AiGatewayOptions {
  readonly db: Database;
  readonly secrets: SecretReader;
  /**
   * The install's own model servers (AI_LOCAL_SERVERS): the only private or plain-http
   * addresses a call may go to.
   */
  readonly localServers?: readonly LocalServer[];
  /** Stands in for the network in a test. An install leaves it out. */
  readonly transport?: AiTransport;
  /**
   * Trusted composition only (a test's stand-ins): where the hosted providers are. An
   * install leaves it out, and no setting or row can change it.
   */
  readonly baseUrls?: { readonly anthropic?: string; readonly openai?: string };
  /** The prices shipped with the adapters; ai.model_prices overrides them. */
  readonly prices?: Readonly<Record<string, PriceSource>>;
  /** Calls of one model before the backup is tried: 2 unless said otherwise. */
  readonly maxCallsPerModel?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 0 to 1, spreading out retries; Math.random unless said otherwise. */
  readonly jitter?: () => number;
  readonly onEvent?: (event: GatewayEvent) => void;
}

export interface AiGateway {
  generate(
    context: TenantContext,
    request: GatewayRequest,
    options?: GatewayCallOptions,
  ): Promise<GatewayResult>;
  /**
   * Asks a connection's model for one short answer, on the business's account: admitted
   * under the same limit as any call, recorded in ai.requests as `connection_test`, with
   * no retry and no backup model. The connection is the business's own or its agency's.
   */
  testConnection(
    context: TenantContext,
    connectionId: string,
    options?: Pick<GatewayCallOptions, 'timeoutMs'>,
  ): Promise<ConnectionTestResult>;
  /**
   * Asks a connection's provider which models the key can use, which costs nothing and
   * calls no model. For the agency, which has no account of its own to put a call on.
   */
  checkConnection(
    context: TenantContext,
    connectionId: string,
    options?: Pick<GatewayCallOptions, 'timeoutMs'>,
  ): Promise<KeyCheckResult>;
}

const DEFAULT_TIMEOUT_MS = 300_000;
/** A test is someone waiting at a screen: it gets half a minute, not five. */
const TEST_TIMEOUT_MS = 30_000;
/**
 * What a test asks. Short on purpose: a test proves the key, the address and the model's
 * name, not the model's wit, and it is paid for like any call.
 */
const TEST_PROMPT = {
  promptVersion: 'connection_test/1',
  system: 'This is a connection test.',
  messages: [{ role: 'user', text: 'Reply with the word OK.' }],
  maxOutputTokens: 16,
} as const;
/**
 * The model a test calls when the connection names none. Claude Haiku 4.5 is the cheapest
 * model in the shipped price table, and it does not think unless a request asks it to, so
 * sixteen tokens are room enough for its answer.
 */
const TEST_MODELS: Readonly<Partial<Record<SupportedProvider, string>>> = {
  anthropic: 'claude-haiku-4-5-20251001',
};
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 900_000;
/** How long past its deadline a call's hold on the budget lasts. */
const HOLD_MARGIN_MS = 60_000;
const RETRY_BASE_MS = 1000;
/** A provider that asks for longer than this is not waited for: the backup is tried. */
const MAX_RETRY_WAIT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const DAY_MS = 86_400_000;
// What both providers accept: Anthropic allows 128 characters, OpenAI 64.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Refuses a request no provider would take, before anything is admitted or sent. The eval
 * gateway (evals/eval-gateway.ts) refuses the same requests, so a job that passes its evals
 * is not one the product's gateway would turn away.
 */
export function checkRequest(request: GatewayRequest, options: GatewayCallOptions): void {
  const refuse = (problem: string): never => {
    throw new RangeError(`An AI request ${problem}.`);
  };
  if (!AI_JOBS.includes(request.job)) refuse('names a job the gateway does not know');
  if (request.promptVersion.length < 1 || request.promptVersion.length > 100)
    refuse('needs a prompt version of 1 to 100 characters');
  if (
    !Number.isInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1 ||
    request.maxOutputTokens > MAX_OUTPUT_TOKENS
  )
    refuse(`needs a token limit from 1 to ${String(MAX_OUTPUT_TOKENS)}`);
  const [first] = request.messages;
  if (first?.role !== 'user') refuse('must start with a message from a person');
  if (request.messages.some((message) => message.role === 'user' && message.text === ''))
    refuse('has an empty message');
  const names = new Set<string>();
  for (const tool of request.tools ?? []) {
    if (!TOOL_NAME.test(tool.name)) refuse('has a tool with a name no provider takes');
    if (names.has(tool.name)) refuse('has two tools with one name');
    if (tool.inputSchema['type'] !== 'object') refuse('has a tool whose input is not an object');
    names.add(tool.name);
  }
  deadline(options.timeoutMs, DEFAULT_TIMEOUT_MS);
}

/** The deadline of one provider call, in milliseconds, checked. */
function deadline(asked: number | undefined, usual: number): number {
  const timeoutMs = asked ?? usual;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)
    throw new RangeError(
      `An AI request needs a deadline of ${String(MIN_TIMEOUT_MS)} to ${String(MAX_TIMEOUT_MS)} milliseconds.`,
    );
  return timeoutMs;
}

/** The providers there is an adapter for. */
type SupportedProvider = 'anthropic' | 'openai' | 'openai_compatible';
const isProvider = (provider: string): provider is SupportedProvider =>
  provider === 'anthropic' || provider === 'openai' || provider === 'openai_compatible';

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** A call that was admitted: its row is written and its provider is ready. */
interface Admitted {
  readonly kind: 'go';
  readonly requestId: string;
  readonly provider: AiProvider;
  readonly providerName: AiProviderName;
  readonly model: string;
  readonly keySource: 'agency' | 'own';
  readonly prices: ModelPrices | null;
  /** The job's cache lifetime, or five minutes where the model has no price for an hour. */
  readonly cacheTtl: CacheTtl;
  readonly mask: boolean;
  /** The masked request for the log, or null when the business keeps no log. */
  readonly logged: LoggedRequest | null;
}
type Admission =
  | Admitted
  /** The spending limit was reached, and the business pauses at it. */
  | {
      readonly kind: 'stop';
      readonly result: { readonly outcome: 'paused'; readonly reason: 'limit_reached' };
    }
  | { readonly kind: 'skip'; readonly reason: SkipReason };
/** What routing a job can also find: AI turned off, or no backup model to try. */
type Routed = Admission | { readonly kind: 'off' } | { readonly kind: 'no_backup' };
/** A connection that cannot be tested: nothing is sent anywhere. */
interface Unusable {
  readonly kind: 'unusable';
  readonly reason: ConnectionProblem;
}

/** One piece of work for a model: what every call made for it has in common. */
interface Work {
  readonly context: TenantContext;
  readonly businessId: string;
  readonly job: RecordedJob;
  readonly promptVersion: string;
  readonly callId: string;
  readonly request: Pick<GatewayRequest, 'system' | 'messages' | 'tools' | 'maxOutputTokens'>;
  readonly requestBytes: number;
  readonly timeoutMs: number;
  /** What an admission has to tell, held until its transaction has committed. */
  readonly told: GatewayEvent[];
}

/** Where one call goes: a model, and the row that holds its key. */
interface Target {
  readonly provider: SupportedProvider;
  readonly model: string;
  readonly keySource: 'agency' | 'own';
  readonly key: { readonly secret_id: string | null; readonly base_url: string | null };
}

export function createAiGateway(options: AiGatewayOptions): AiGateway {
  const { db, secrets } = options;
  const transport =
    options.transport ?? createAiTransport({ localServers: options.localServers ?? [] });
  const builtIn = options.prices ?? BUILT_IN_PRICES;
  const maxCalls = options.maxCallsPerModel ?? 2;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep;
  const jitter = options.jitter ?? Math.random;
  const tell = (event: GatewayEvent): void => options.onEvent?.(event);

  /** A price the install entered for the model, or the one shipped, or none. */
  async function pricesOf(
    trx: DatabaseTransaction,
    agencyId: string,
    provider: string,
    model: string,
  ): Promise<ModelPrices | null> {
    const row = await trx
      .selectFrom('ai.model_prices')
      .select([
        'input_per_mtok',
        'output_per_mtok',
        'cache_read_per_mtok',
        'cache_write_per_mtok',
        'cache_write_1h_per_mtok',
      ])
      .where('agency_id', '=', agencyId)
      .where('provider', '=', provider)
      .where('model', '=', model)
      .executeTakeFirst();
    if (row === undefined) return builtIn[priceKey(provider, model)]?.prices ?? null;
    return {
      input: dollarsToMicros(row.input_per_mtok),
      output: dollarsToMicros(row.output_per_mtok),
      cacheRead: dollarsToMicros(row.cache_read_per_mtok),
      cacheWrite: dollarsToMicros(row.cache_write_per_mtok),
      // A row without it does not borrow the shipped price: the row is the agency's word.
      ...(row.cache_write_1h_per_mtok === null
        ? {}
        : { cacheWrite1h: dollarsToMicros(row.cache_write_1h_per_mtok) }),
    };
  }

  /** The month's spend so far plus what calls in flight hold, in USD micros. */
  async function spentThisMonth(
    trx: DatabaseTransaction,
    businessId: string,
    at: Date,
  ): Promise<bigint> {
    const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const done = await trx
      .selectFrom('ai.requests')
      .select((eb) => eb.fn.sum<string | null>('cost_estimate').as('total'))
      .where('business_id', '=', businessId)
      .where('started_at', '>=', monthStart)
      .executeTakeFirstOrThrow();
    const held = await trx
      .selectFrom('ai.requests')
      .select((eb) => eb.fn.sum<string | null>('reserved_estimate').as('total'))
      .where('business_id', '=', businessId)
      .where('status', '=', 'started')
      .executeTakeFirstOrThrow();
    return dollarsToMicros(done.total ?? '0') + dollarsToMicros(held.total ?? '0');
  }

  function providerFor(
    name: SupportedProvider,
    apiKey: string | undefined,
    baseUrl: string | null,
  ): AiProvider | undefined {
    if (name === 'openai_compatible')
      return baseUrl === null
        ? undefined
        : createOpenAiProvider({
            transport,
            baseUrl,
            ...(apiKey === undefined ? {} : { apiKey }),
          });
    // A hosted provider's key goes to that provider's address, whatever a row says.
    if (apiKey === undefined) return undefined;
    if (name === 'anthropic')
      return createAnthropicProvider({
        transport,
        apiKey,
        ...(options.baseUrls?.anthropic === undefined
          ? {}
          : { baseUrl: options.baseUrls.anthropic }),
      });
    return createOpenAiProvider({
      transport,
      apiKey,
      baseUrl: options.baseUrls?.openai ?? OPENAI_BASE_URL,
      tokenLimitField: 'max_completion_tokens',
    });
  }

  /** A call whose worker died never settled: once its hold has lapsed, say so. */
  async function closeAbandoned(
    trx: DatabaseTransaction,
    businessId: string,
    at: Date,
  ): Promise<void> {
    await trx
      .updateTable('ai.requests')
      .set({
        status: 'error',
        error_code: 'abandoned',
        finished_at: at,
        reserved_estimate: '0',
        reserved_until: null,
      })
      .where('business_id', '=', businessId)
      .where('status', '=', 'started')
      .where('reserved_until', '<', at)
      .execute();
  }

  const settingsOf = (trx: DatabaseTransaction, businessId: string) =>
    trx
      .selectFrom('ai.settings')
      .selectAll()
      .where('business_id', '=', businessId)
      .executeTakeFirst();
  type Settings = Awaited<ReturnType<typeof settingsOf>>;

  /**
   * The part of an admission that is the same wherever the call goes: checks the spending
   * limit under the business's lock, opens the key, and writes the call's row with its hold
   * on the budget. `fellBackFrom` is the failed call this one takes over.
   */
  async function admitTarget(
    trx: DatabaseTransaction,
    at: Date,
    saved: Settings,
    work: Work,
    target: Target,
    attempt: number,
    fellBackFrom: string | undefined,
  ): Promise<Admission> {
    const { context, businessId, request } = work;
    const { agencyId, correlationId } = context;
    const prices = await pricesOf(trx, agencyId, target.provider, target.model);
    if ((saved?.monthly_limit ?? null) !== null) {
      // The business's lock: admissions of one business run one at a time, so two
      // calls cannot both find the last room under the limit.
      const locked = await trx
        .selectFrom('ai.settings')
        .select(['monthly_limit', 'at_limit', 'limit_reached_at'])
        .where('business_id', '=', businessId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (locked.monthly_limit !== null) {
        const limit = dollarsToMicros(locked.monthly_limit);
        const spent = await spentThisMonth(trx, businessId, at);
        const pause = locked.at_limit === 'pause';
        if (spent >= limit) {
          const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
          if (
            locked.limit_reached_at === null ||
            locked.limit_reached_at.getTime() < monthStart.getTime()
          ) {
            await trx
              .updateTable('ai.settings')
              .set({ limit_reached_at: at })
              .where('business_id', '=', businessId)
              .execute();
            // The event the people who manage AI are told by (the notifications job reads
            // it): written with limit_reached_at or not at all, so once in a month. Nobody
            // did this, whoever's call met the limit: the actor is the system.
            await trx
              .insertInto('events.events')
              .values({
                agency_id: agencyId,
                business_id: businessId,
                type: 'ai_settings.limit_reached',
                actor_kind: 'system',
                actor_id: null,
                correlation_id: correlationId,
                subject_kind: 'business',
                subject_id: businessId,
                payload: asJson({
                  atLimit: pause ? 'pause' : 'continue',
                  limitMicros: String(limit),
                  spentMicros: String(spent),
                }),
              })
              .execute();
            work.told.push({
              type: 'limit_reached',
              agencyId,
              businessId,
              atLimit: pause ? 'pause' : 'continue',
              limitMicros: String(limit),
              spentMicros: String(spent),
            });
          }
          if (pause)
            return { kind: 'stop', result: { outcome: 'paused', reason: 'limit_reached' } };
        }
        // A limit that pauses cannot be kept for a model whose cost nobody can count.
        if (pause && prices === null) return { kind: 'skip', reason: 'price_unknown' };
      }
    }

    let apiKey: string | undefined;
    if (target.key.secret_id !== null) {
      try {
        apiKey = await secrets.read(trx, target.key.secret_id, AI_KEY_PURPOSE);
      } catch {
        // Not found for this purpose, or not openable: either way there is no key.
        return { kind: 'skip', reason: 'key_unreadable' };
      }
    }
    const provider = providerFor(target.provider, apiKey, target.key.base_url);
    if (provider === undefined) return { kind: 'skip', reason: 'no_key' };

    // An hour's write is dearer, and is asked for only when it can be counted.
    const cacheTtl: CacheTtl =
      JOB_CACHE_TTL[work.job] === '1h' && prices?.cacheWrite1h !== undefined ? '1h' : '5m';
    const logDays = saved?.request_log_days ?? 30;
    const logged = logDays > 0 ? logOf(request) : null;
    const { id: requestId } = await trx
      .insertInto('ai.requests')
      .values({
        business_id: businessId,
        job: work.job,
        provider: target.provider,
        model: target.model,
        key_source: target.keySource,
        status: 'started',
        cost_estimate: null,
        actor_kind: context.actorKind,
        actor_id: context.actorId ?? null,
        correlation_id: correlationId,
        call_id: work.callId,
        attempt,
        prompt_version: work.promptVersion,
        reserved_estimate:
          prices === null
            ? '0'
            : microsToDollars(
                worstCaseMicros(work.requestBytes, request.maxOutputTokens, prices, cacheTtl),
              ),
        reserved_until: new Date(at.getTime() + work.timeoutMs + HOLD_MARGIN_MS),
        log: logged === null ? null : asJson({ request: logged }),
        log_expires_at: logged === null ? null : new Date(at.getTime() + logDays * DAY_MS),
        started_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (fellBackFrom !== undefined)
      await trx
        .updateTable('ai.requests')
        .set({ status: 'fell_back' })
        .where('business_id', '=', businessId)
        .where('id', '=', fellBackFrom)
        .where('status', '=', 'error')
        .execute();
    return {
      kind: 'go',
      requestId,
      provider,
      providerName: target.provider,
      model: target.model,
      keySource: target.keySource,
      prices,
      cacheTtl,
      mask: saved?.mask_contact_details ?? false,
      logged,
    };
  }

  /** One transaction: records how the call ended and lets go of its hold. */
  async function settle(
    work: Work,
    admitted: Admitted,
    attempt: number,
    response: ProviderResponse,
    startedAt: Date,
  ): Promise<{ readonly costMicros: bigint | null; readonly latencyMs: number }> {
    const { context, businessId } = work;
    const { usage } = response;
    const costMicros =
      usage === null || admitted.prices === null || !pricesCover(usage, admitted.prices)
        ? null
        : estimateCostMicros(usage, admitted.prices);
    const finishedAt = now();
    const latencyMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const errorCode = response.status === 'error' ? response.code : null;
    const answer =
      response.status === 'ok'
        ? partsLog(response.parts)
        : response.status === 'refused'
          ? { refused: response.category }
          : { error: response.code };
    await withTenant(db, context, (trx) =>
      trx
        .updateTable('ai.requests')
        .set({
          status: response.status,
          input_tokens: usage?.inputTokens ?? 0,
          output_tokens: usage?.outputTokens ?? 0,
          cache_read_tokens: usage?.cacheReadTokens ?? 0,
          cache_write_tokens: usage?.cacheWriteTokens ?? 0,
          cache_write_1h_tokens: usage?.cacheWrite1hTokens ?? 0,
          usage_reported: usage !== null,
          cost_estimate: costMicros === null ? null : microsToDollars(costMicros),
          latency_ms: latencyMs,
          error_code: errorCode,
          finished_at: finishedAt,
          reserved_estimate: '0',
          reserved_until: null,
          ...(admitted.logged === null
            ? {}
            : { log: asJson({ request: admitted.logged, response: answer }) }),
        })
        .where('business_id', '=', businessId)
        .where('id', '=', admitted.requestId)
        .where('status', '=', 'started')
        .execute(),
    );
    tell({
      type: 'request',
      agencyId: context.agencyId,
      businessId,
      correlationId: context.correlationId,
      callId: work.callId,
      requestId: admitted.requestId,
      job: work.job,
      promptVersion: work.promptVersion,
      provider: admitted.providerName,
      model: admitted.model,
      keySource: admitted.keySource,
      attempt,
      status: response.status,
      errorCode,
      latencyMs,
      usage,
      costMicros: costMicros === null ? null : String(costMicros),
    });
    return { costMicros, latencyMs };
  }

  /**
   * The one place a request leaves for a provider: masked here, by the business's setting
   * as it was read for this call, before any adapter sees it.
   */
  function send(
    work: Work,
    admitted: Admitted,
    onTextDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const { request } = work;
    const outbound: ProviderRequest = {
      model: admitted.model,
      system: request.system,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      cacheTtl: admitted.cacheTtl,
    };
    return admitted.provider.generate(admitted.mask ? maskOutbound(outbound) : outbound, {
      timeoutMs: work.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      ...(onTextDelta === undefined ? {} : { onTextDelta }),
    });
  }

  function workOf(
    context: TenantContext,
    job: RecordedJob,
    promptVersion: string,
    request: Work['request'],
    timeoutMs: number,
  ): Work {
    return {
      context,
      businessId: requireBusiness(context),
      job,
      promptVersion,
      callId: randomUUID(),
      request,
      requestBytes: Buffer.byteLength(
        JSON.stringify([request.system, request.messages, request.tools ?? []]),
      ),
      timeoutMs,
      told: [],
    };
  }

  /**
   * A connection the context may use: in a business, its own or its agency's; at the
   * agency, the agency's. Row-level security alone would show the agency every business's.
   */
  function connectionOf(trx: DatabaseTransaction, context: TenantContext, connectionId: string) {
    const { businessId } = context;
    return trx
      .selectFrom('ai.provider_keys')
      .select(['provider', 'business_id', 'default_model', 'secret_id', 'base_url'])
      .where('agency_id', '=', context.agencyId)
      .where('id', '=', connectionId)
      .where((eb) =>
        businessId === undefined
          ? eb('business_id', 'is', null)
          : eb.or([eb('business_id', 'is', null), eb('business_id', '=', businessId)]),
      )
      .executeTakeFirst();
  }

  return {
    async generate(context, request, call = {}) {
      checkRequest(request, call);
      const work = workOf(
        context,
        request.job,
        request.promptVersion,
        request,
        call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const { businessId } = work;
      const { agencyId, correlationId } = context;
      const flush = (): void => {
        for (const event of work.told.splice(0)) tell(event);
      };

      /**
       * One transaction: reads the business's settings, finds the model and its key, and
       * admits the call. Route 0 is the job's model, route 1 the backup.
       */
      const admit = (route: 0 | 1, attempt: number, fellBackFrom: string | undefined) =>
        withTenant(db, context, async (trx): Promise<Routed> => {
          const at = now();
          await closeAbandoned(trx, businessId, at);
          const saved = await settingsOf(trx, businessId);
          if (saved?.enabled === false) return { kind: 'off' };
          const keySource = saved?.key_source === 'own' ? 'own' : 'agency';

          const chosen = await trx
            .selectFrom('ai.job_models')
            .select(['provider', 'model'])
            .where('business_id', '=', businessId)
            .where('job', '=', request.job)
            .executeTakeFirst();
          const main = chosen ?? DEFAULT_JOB_MODELS[request.job];
          const backupProvider = saved?.backup_provider ?? null;
          const backupModel = saved?.backup_model ?? null;
          const backup =
            backupProvider === null || backupModel === null
              ? undefined
              : { provider: backupProvider, model: backupModel };
          const target = route === 0 ? main : backup;
          if (
            target === undefined ||
            (route === 1 && target.provider === main.provider && target.model === main.model)
          )
            return { kind: 'no_backup' };
          const { provider, model } = target;
          if (!isProvider(provider)) return { kind: 'skip', reason: 'provider_not_supported' };

          const scoped = trx
            .selectFrom('ai.provider_keys')
            .select(['secret_id', 'base_url'])
            .where('agency_id', '=', agencyId)
            .where('provider', '=', provider);
          const key = await (
            keySource === 'own'
              ? scoped.where('business_id', '=', businessId)
              : scoped.where('business_id', 'is', null)
          )
            // One key for a provider is the rule; with several, always the same one.
            .orderBy('label')
            .orderBy('id')
            .limit(1)
            .executeTakeFirst();
          if (key === undefined) return { kind: 'skip', reason: 'no_key' };
          return admitTarget(
            trx,
            at,
            saved,
            work,
            { provider, model, keySource, key },
            attempt,
            fellBackFrom,
          );
        });

      /** How long to wait before calling the same model again, or undefined: don't. */
      const retryWait = (
        response: Extract<ProviderResponse, { readonly status: 'error' }>,
        callsMade: number,
      ): number | undefined => {
        if (callsMade >= maxCalls) return undefined;
        // A rate limit that names no end (a spend cap) is not waited out.
        if (response.code === 'rate_limited' && response.retryAfterMs === undefined)
          return undefined;
        if (response.code !== 'rate_limited' && response.code !== 'unavailable') return undefined;
        const backoff = RETRY_BASE_MS * 2 ** (callsMade - 1);
        const wait = Math.ceil((response.retryAfterMs ?? backoff) * (1 + jitter() / 4));
        return wait > MAX_RETRY_WAIT_MS ? undefined : wait;
      };

      let attempt = 0;
      let failed: { readonly code: ProviderErrorCode; readonly requestId: string } | undefined;
      let skipped: SkipReason | undefined;

      for (const route of [0, 1] as const) {
        for (let callsMade = 0; ;) {
          if (call.signal?.aborted === true && failed !== undefined)
            return { outcome: 'failed', ...failed };
          // Only the first call of the backup takes over from the main model's last one.
          const admission = await admit(
            route,
            attempt + 1,
            route === 1 && callsMade === 0 ? failed?.requestId : undefined,
          );
          flush();
          if (admission.kind === 'off') return { outcome: 'off' };
          if (admission.kind === 'stop') return admission.result;
          if (admission.kind === 'no_backup') break;
          if (admission.kind === 'skip') {
            skipped ??= admission.reason;
            tell({
              type: 'skipped',
              agencyId,
              businessId,
              correlationId,
              job: request.job,
              reason: admission.reason,
            });
            break;
          }
          attempt += 1;
          callsMade += 1;
          const startedAt = now();
          const response = await send(work, admission, call.onTextDelta, call.signal);
          const { costMicros } = await settle(work, admission, attempt, response, startedAt);
          const { requestId, providerName: provider, model } = admission;
          if (response.status === 'ok')
            return {
              outcome: 'ok',
              parts: response.parts,
              text: textOf(response.parts),
              stop: response.stop,
              provider,
              model,
              usedBackup: route === 1,
              usage: response.usage,
              costMicros,
              requestId,
            };
          // A refusal is the model's answer, not a failure: no other model is asked.
          if (response.status === 'refused')
            return { outcome: 'refused', category: response.category, provider, model, requestId };
          failed = { code: response.code, requestId };
          if (call.signal?.aborted === true) return { outcome: 'failed', ...failed };
          const wait = retryWait(response, callsMade);
          if (wait === undefined) break;
          await waitForRetry(wait, call.signal, sleep);
        }
      }
      if (failed !== undefined) return { outcome: 'failed', ...failed };
      if (skipped === 'price_unknown') return { outcome: 'paused', reason: 'price_unknown' };
      return { outcome: 'not_configured', reason: skipped ?? 'no_key' };
    },

    async testConnection(context, connectionId, call = {}) {
      const work = workOf(
        context,
        CONNECTION_TEST_JOB,
        TEST_PROMPT.promptVersion,
        TEST_PROMPT,
        deadline(call.timeoutMs, TEST_TIMEOUT_MS),
      );
      const { businessId } = work;
      const admission = await withTenant(
        db,
        context,
        async (trx): Promise<Admission | { kind: 'off' } | Unusable> => {
          const at = now();
          await closeAbandoned(trx, businessId, at);
          const saved = await settingsOf(trx, businessId);
          if (saved?.enabled === false) return { kind: 'off' };
          const row = await connectionOf(trx, context, connectionId);
          if (row === undefined) return { kind: 'unusable', reason: 'no_connection' };
          const { provider } = row;
          if (!isProvider(provider)) return { kind: 'unusable', reason: 'provider_not_supported' };
          const model = row.default_model ?? TEST_MODELS[provider];
          if (model === undefined) return { kind: 'unusable', reason: 'no_model' };
          return admitTarget(
            trx,
            at,
            saved,
            work,
            // The call is on the account of whoever's key it is made with.
            { provider, model, keySource: row.business_id === null ? 'agency' : 'own', key: row },
            1,
            undefined,
          );
        },
      );
      for (const event of work.told.splice(0)) tell(event);
      if (admission.kind === 'off') return { outcome: 'off' };
      if (admission.kind === 'stop') return admission.result;
      if (admission.kind === 'unusable' || admission.kind === 'skip') {
        tell({
          type: 'skipped',
          agencyId: context.agencyId,
          businessId,
          correlationId: context.correlationId,
          job: CONNECTION_TEST_JOB,
          reason: admission.reason,
        });
        if (admission.reason === 'price_unknown')
          return { outcome: 'paused', reason: 'price_unknown' };
        return {
          outcome: 'not_configured',
          // A hosted provider's row without a key: there is nothing to test with.
          reason: admission.reason === 'no_key' ? 'key_unreadable' : admission.reason,
        };
      }
      const startedAt = now();
      const response = await send(work, admission);
      const { costMicros, latencyMs } = await settle(work, admission, 1, response, startedAt);
      const { requestId } = admission;
      return response.status === 'error'
        ? { outcome: 'failed', code: response.code, latencyMs, requestId }
        : { outcome: 'ok', latencyMs, requestId, costMicros };
    },

    async checkConnection(context, connectionId, call = {}) {
      const timeoutMs = deadline(call.timeoutMs, TEST_TIMEOUT_MS);
      const found = await withTenant(db, context, async (trx) => {
        const row = await connectionOf(trx, context, connectionId);
        if (row === undefined) return { reason: 'no_connection' } as const;
        const { provider: name } = row;
        if (!isProvider(name)) return { reason: 'provider_not_supported' } as const;
        let apiKey: string | undefined;
        if (row.secret_id !== null) {
          try {
            apiKey = await secrets.read(trx, row.secret_id, AI_KEY_PURPOSE);
          } catch {
            return { reason: 'key_unreadable' } as const;
          }
        }
        const provider = providerFor(name, apiKey, row.base_url);
        return provider === undefined
          ? ({ reason: 'key_unreadable' } as const)
          : { name, provider };
      });
      if ('reason' in found) return { outcome: 'not_configured', reason: found.reason };
      const startedAt = now();
      const listed = await found.provider.listModels({ timeoutMs });
      const latencyMs = Math.max(0, now().getTime() - startedAt.getTime());
      const errorCode = listed.status === 'error' ? listed.code : null;
      tell({
        type: 'key_check',
        agencyId: context.agencyId,
        businessId: context.businessId ?? null,
        correlationId: context.correlationId,
        provider: found.name,
        status: errorCode === null ? 'ok' : 'error',
        errorCode,
        latencyMs,
      });
      return errorCode === null
        ? { outcome: 'ok', latencyMs }
        : { outcome: 'failed', code: errorCode, latencyMs };
    },
  };
}
