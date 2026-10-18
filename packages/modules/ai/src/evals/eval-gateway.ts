// The eval gateway: the gateway's one function over ONE provider and model, with no
// database, for a person running the evals from a terminal. It keeps what the product's
// gateway keeps, by other means:
//
//   * the address rule of AI_LOCAL_SERVERS: it calls through the module's own transport, so a
//     model server on a private address is called only when the person running the
//     command, who is the operator here, named it;
//   * a hard cap in US dollars instead of a monthly limit: before each call the call's
//     worst case is added to what is spent, and a call that would pass the cap is not made;
//   * no price, no run: a model whose cost nobody can count cannot be held to a cap;
//   * masking, the same function, when asked.
//
// There is no backup model: an eval is of one model. It records every call for the report.
import type { LocalServer } from '../addresses.js';
import { checkBaseUrl } from '../addresses.js';
import { createAnthropicProvider } from '../anthropic.js';
import { checkRequest, type GatewayResult } from '../gateway.js';
import { maskOutbound } from '../masking.js';
import { createOpenAiProvider, OPENAI_BASE_URL } from '../openai.js';
import {
  BUILT_IN_PRICES,
  estimateCostMicros,
  microsToDollars,
  priceKey,
  worstCaseMicros,
  type PriceSource,
} from '../pricing.js';
import type { AiProvider, ModelPrices, ProviderRequest, ProviderResponse } from '../provider.js';
import { createAiTransport, type AiTransport } from '../transport.js';
import { MODEL_ID } from './read.js';
import {
  requestHash,
  toGatewayResult,
  type EvalSession,
  type RecordedCall,
  type RecordedResult,
} from './recording.js';

/** The providers there is an adapter for. */
export const EVAL_PROVIDERS = ['anthropic', 'openai', 'openai_compatible'] as const;
export type EvalProvider = (typeof EVAL_PROVIDERS)[number];

/** The run cannot start as it was asked for. The message is for the person running it. */
export class EvalConfigError extends Error {
  override readonly name = 'EvalConfigError';
}

export interface EvalGatewayOptions {
  readonly provider: EvalProvider;
  readonly model: string;
  /** The most the run may cost, in USD micros. */
  readonly budgetMicros: bigint;
  /** From EVAL_API_KEY. A model server of one's own may ask for none. */
  readonly apiKey?: string | undefined;
  /** For `openai_compatible` only: the model server's address, up to and including /v1. */
  readonly baseUrl?: string | undefined;
  /** The servers the person running the command named with --local-server. */
  readonly localServers?: readonly LocalServer[];
  /** For a model with no built-in price: USD millionths for a million tokens. */
  readonly prices?: ModelPrices | undefined;
  /** Mask phone numbers and email addresses before anything is sent, as a business may. */
  readonly mask?: boolean;
  /** One provider call, in milliseconds. Five minutes when left out. */
  readonly callTimeoutMs?: number;
  /** The prices shipped with the adapters. */
  readonly builtInPrices?: Readonly<Record<string, PriceSource>>;
  /**
   * Trusted composition only (a test's stand-ins): where the hosted providers are. No flag
   * of the command line sets it.
   */
  readonly baseUrls?: { readonly anthropic?: string; readonly openai?: string } | undefined;
  /** Stands in for the network in a test. */
  readonly transport?: AiTransport;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** A model handle over a real model, which also says what the run has cost so far. */
export interface LiveSession extends EvalSession {
  /** What is counted against the budget so far, in USD micros. */
  spentMicros(): bigint;
}

const DEFAULT_CALL_TIMEOUT_MS = 300_000;
/** A busy provider is asked again this often for one call, and no more. */
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
/** A provider that asks for longer than this is not waited for. */
const MAX_RETRY_WAIT_MS = 30_000;

function pricesFor(options: EvalGatewayOptions): ModelPrices {
  const { provider, model, prices } = options;
  const name = priceKey(provider, model);
  const builtIn = (options.builtInPrices ?? BUILT_IN_PRICES)[name];
  if (builtIn !== undefined) {
    if (prices !== undefined)
      throw new EvalConfigError(
        `The price of ${name} is built in (src/pricing.ts) and cannot be given on the command line.`,
      );
    return builtIn.prices;
  }
  if (prices === undefined)
    throw new EvalConfigError(
      `No price is known for ${name}. Give --price-input and --price-output (US dollars for a million tokens); without them the run cannot be held to its budget.`,
    );
  if (Object.values(prices).some((rate) => rate < 0n))
    throw new EvalConfigError('A price must be an amount from 0.');
  return prices;
}

function providerFor(options: EvalGatewayOptions, transport: AiTransport): AiProvider {
  const { provider, baseUrl } = options;
  const apiKey = options.apiKey === '' ? undefined : options.apiKey;
  if (provider === 'openai_compatible') {
    if (baseUrl === undefined)
      throw new EvalConfigError(
        'openai_compatible needs --base-url, the address of the model server.',
      );
    const checked = checkBaseUrl(baseUrl, options.localServers ?? []);
    // The reason is a category: the address itself is not repeated.
    if (!checked.ok)
      throw new EvalConfigError(
        `The address is not one this run may call (${checked.reason}). A model server on a private address or on plain http must be named with --local-server host:port.`,
      );
    return createOpenAiProvider({
      transport,
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
  }
  // A hosted provider's key goes to that provider's address and nowhere else.
  if (baseUrl !== undefined)
    throw new EvalConfigError(
      `--base-url is only for openai_compatible: ${provider} is called at its own address.`,
    );
  if (apiKey === undefined)
    throw new EvalConfigError(`EVAL_API_KEY is not set: ${provider} needs a key.`);
  if (provider === 'anthropic')
    return createAnthropicProvider({
      transport,
      apiKey,
      ...(options.baseUrls?.anthropic === undefined ? {} : { baseUrl: options.baseUrls.anthropic }),
    });
  return createOpenAiProvider({
    transport,
    apiKey,
    baseUrl: options.baseUrls?.openai ?? OPENAI_BASE_URL,
    tokenLimitField: 'max_completion_tokens',
  });
}

/** How long to wait before asking a busy provider again, or undefined: don't. */
function retryWait(
  response: Extract<ProviderResponse, { readonly status: 'error' }>,
  attempts: number,
): number | undefined {
  if (attempts > MAX_RETRIES) return undefined;
  if (response.code !== 'rate_limited' && response.code !== 'unavailable') return undefined;
  // A rate limit that names no end (a spend cap) is not waited out.
  if (response.code === 'rate_limited' && response.retryAfterMs === undefined) return undefined;
  const wait = response.retryAfterMs ?? RETRY_BASE_MS * 2 ** (attempts - 1);
  return wait > MAX_RETRY_WAIT_MS ? undefined : wait;
}

function recorded(response: ProviderResponse): RecordedResult {
  if (response.status === 'ok')
    return { outcome: 'ok', parts: response.parts, stop: response.stop };
  if (response.status === 'refused') return { outcome: 'refused', category: response.category };
  return { outcome: 'failed', code: response.code };
}

export function createEvalGateway(options: EvalGatewayOptions): LiveSession {
  const { provider: providerName, model, budgetMicros } = options;
  if (!MODEL_ID.test(model))
    throw new EvalConfigError(
      "The model's id must be 1 to 200 of letters, digits and . _ : / @ + -, starting with a letter or a digit.",
    );
  if (budgetMicros < 0n) throw new EvalConfigError('The budget must be an amount from 0.');
  const prices = pricesFor(options);
  const transport =
    options.transport ?? createAiTransport({ localServers: options.localServers ?? [] });
  const provider = providerFor(options, transport);
  const timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  /** Known costs, and the worst case of every call whose cost nobody reported. */
  let counted = 0n;
  let stopped = false;
  // Asked through a function: stop() may be called while a call waits.
  const isStopped = (): boolean => stopped;
  let current: { readonly id: string; readonly calls: RecordedCall[]; cost: bigint } | undefined;

  return {
    async generate(_context, request, call = {}): Promise<GatewayResult> {
      if (isStopped()) return { outcome: 'off' };
      // Held from here on: an answer that arrives late belongs to the case that asked.
      const mine = current;
      if (mine === undefined) throw new Error('The eval gateway was called outside a case.');
      // What the product's gateway refuses, an eval refuses too.
      checkRequest(request, call);
      // The gateway's own measure of a request (gateway.ts), so the two caps count alike.
      const requestBytes = Buffer.byteLength(
        JSON.stringify([request.system, request.messages, request.tools ?? []]),
      );
      const worst = worstCaseMicros(requestBytes, request.maxOutputTokens, prices);
      const outbound: ProviderRequest = {
        model,
        system: request.system,
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
      };
      const hash = requestHash(request);
      const finish = (entry: RecordedCall): GatewayResult => {
        mine.calls.push(entry);
        return toGatewayResult(entry, {
          provider: providerName,
          model,
          requestId: `eval-${mine.id}-${String(mine.calls.length)}`,
        });
      };

      let last: RecordedCall | undefined;
      for (let attempts = 0, wait: number | undefined; ;) {
        // The cap, before every attempt: this one's worst case must still fit under it.
        if (counted + worst > budgetMicros)
          return finish({
            request: hash,
            attempts,
            usage: last?.usage ?? null,
            cost: last?.cost ?? null,
            result: { outcome: 'paused', reason: 'limit_reached' },
          });
        if (wait !== undefined) {
          await sleep(wait);
          // Stopped while it waited: the case is over, and nobody is asked again.
          if (isStopped()) return { outcome: 'off' };
        }
        attempts += 1;
        const response = await provider.generate(
          options.mask === true ? maskOutbound(outbound) : outbound,
          {
            timeoutMs,
            ...(call.onTextDelta === undefined ? {} : { onTextDelta: call.onTextDelta }),
          },
        );
        const cost = response.usage === null ? null : estimateCostMicros(response.usage, prices);
        // With no usage reported the cost is unknown, so the worst case stays counted. The
        // one exception is our own refusal to connect: nothing left this machine.
        const spent =
          cost ?? (response.status === 'error' && response.code === 'blocked_address' ? 0n : worst);
        counted += spent;
        mine.cost += spent;
        last = {
          request: hash,
          attempts,
          usage: response.usage,
          cost: cost === null ? null : microsToDollars(cost),
          result: recorded(response),
        };
        wait = response.status === 'error' ? retryWait(response, attempts) : undefined;
        if (wait === undefined) return finish(last);
      }
    },
    begin(caseId) {
      current = { id: caseId, calls: [], cost: 0n };
    },
    end() {
      const done = current ?? { calls: [], cost: 0n };
      current = undefined;
      // A copy: an answer that arrives after its case ended must not change what was kept.
      return { calls: [...done.calls], stale: false, costMicros: done.cost };
    },
    stop() {
      stopped = true;
    },
    spentMicros: () => counted,
  };
}
