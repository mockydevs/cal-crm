import type { CacheTtl, ModelPrices, TokenUsage } from './provider.js';

/**
 * Whether these prices can count this usage: a write to the one-hour cache needs that
 * cache's price. Without it the cost is unknown, never the five-minute price.
 */
export function pricesCover(usage: TokenUsage, prices: ModelPrices): boolean {
  return (usage.cacheWrite1hTokens ?? 0) === 0 || prices.cacheWrite1h !== undefined;
}

/** Round the total up once to the USD micro used by ai.requests.cost_estimate. */
export function estimateCostMicros(usage: TokenUsage, prices: ModelPrices): bigint {
  const write1h = usage.cacheWrite1hTokens ?? 0;
  if (
    Object.values(usage).some((tokens) => !Number.isSafeInteger(tokens) || tokens < 0) ||
    write1h > usage.cacheWriteTokens
  ) {
    throw new Error('Invalid AI usage');
  }
  if (Object.values(prices).some((rate) => rate < 0n) || !pricesCover(usage, prices)) {
    throw new Error('Invalid AI prices');
  }
  const numerator =
    BigInt(usage.inputTokens) * prices.input +
    BigInt(usage.outputTokens) * prices.output +
    BigInt(usage.cacheReadTokens) * prices.cacheRead +
    BigInt(usage.cacheWriteTokens - write1h) * prices.cacheWrite +
    BigInt(write1h) * (prices.cacheWrite1h ?? 0n);
  return (numerator + 999_999n) / 1_000_000n;
}

/** A model's prices, with where they came from and the day they were checked. */
export interface PriceSource {
  readonly prices: ModelPrices;
  readonly source: string;
  /** YYYY-MM-DD. */
  readonly checkedOn: string;
}

export function priceKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

const AMOUNT = /^(\d+)(?:\.(\d{1,6}))?$/;

/**
 * A decimal amount of dollars as whole millionths: a price for a million tokens becomes the
 * rate estimateCostMicros takes, and a cost becomes USD micros. Exact, with no floats.
 */
export function dollarsToMicros(value: string): bigint {
  const match = AMOUNT.exec(value);
  if (match === null) throw new Error('Invalid AI amount');
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** USD micros as the decimal the database keeps: six places. */
export function microsToDollars(micros: bigint): string {
  if (micros < 0n) throw new Error('Invalid AI amount');
  return `${String(micros / 1_000_000n)}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

/** What a provider may add to a request that the request's own bytes don't show. */
export const HIDDEN_INPUT_TOKENS = 1024;

/**
 * The most a call is expected to cost, held against the spending limit while it is in
 * flight. It errs high on purpose. Text is rarely less than a byte a token, so the
 * request's bytes stand for its input tokens, plus an allowance for what a provider adds
 * around them (message framing, its own instructions for tools), priced at the dearer of
 * fresh input and a write to the cache the call asks for. The output is priced as if every
 * token allowed were written.
 */
export function worstCaseMicros(
  requestBytes: number,
  maxOutputTokens: number,
  prices: ModelPrices,
  cacheTtl: CacheTtl = '5m',
): bigint {
  const write =
    cacheTtl === '1h' &&
    prices.cacheWrite1h !== undefined &&
    prices.cacheWrite1h > prices.cacheWrite
      ? prices.cacheWrite1h
      : prices.cacheWrite;
  const input = prices.input > write ? prices.input : write;
  return estimateCostMicros(
    {
      inputTokens: requestBytes + HIDDEN_INPUT_TOKENS,
      outputTokens: maxOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    { ...prices, input },
  );
}

const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
const perMillion = (
  input: string,
  output: string,
  cacheRead: string,
  cacheWrite: string,
  cacheWrite1h: string,
): PriceSource => ({
  prices: {
    input: dollarsToMicros(input),
    output: dollarsToMicros(output),
    cacheRead: dollarsToMicros(cacheRead),
    cacheWrite: dollarsToMicros(cacheWrite),
    cacheWrite1h: dollarsToMicros(cacheWrite1h),
  },
  source: ANTHROPIC_PRICING,
  checkedOn: '2026-10-14',
});
const HAIKU_4_5 = perMillion('1', '5', '0.10', '1.25', '2');

/**
 * The prices shipped with the adapters: Anthropic's list prices in US dollars for a million
 * tokens, read from its pricing page on the day named ("Base input tokens", "Output
 * tokens", "Cache hits and refreshes", "5m cache writes", "1h cache writes"). An install's
 * own row in ai.model_prices overrides any of them. A model that is not here and has no row
 * has no price: its cost is unknown, not zero.
 */
export const BUILT_IN_PRICES: Readonly<Record<string, PriceSource>> = {
  [priceKey('anthropic', 'claude-fable-5-1')]: perMillion('10', '50', '0.25', '12.50', '20'),
  [priceKey('anthropic', 'claude-opus-5-5')]: perMillion('4', '20', '0.20', '5', '8'),
  [priceKey('anthropic', 'claude-sonnet-5-5')]: perMillion('2', '10', '0.10', '2.50', '4'),
  [priceKey('anthropic', 'claude-haiku-4-5')]: HAIKU_4_5,
  [priceKey('anthropic', 'claude-haiku-4-5-20251001')]: HAIKU_4_5,
};
