import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PRICES,
  dollarsToMicros,
  estimateCostMicros,
  HIDDEN_INPUT_TOKENS,
  microsToDollars,
  priceKey,
  pricesCover,
  worstCaseMicros,
} from './pricing.js';

describe('AI cost estimates', () => {
  it('prices fresh input, output and cache usage independently with no float arithmetic', () => {
    // Synthetic fixture prices, not a provider price claim. All rates are USD micros/million tokens.
    expect(
      estimateCostMicros(
        { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 2000, cacheWriteTokens: 500 },
        { input: 2_000_000n, output: 10_000_000n, cacheRead: 200_000n, cacheWrite: 2_500_000n },
      ),
    ).toBe(5650n);
  });
  it('rounds sub-micro totals upward once and supports zero-priced local models', () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 };
    expect(
      estimateCostMicros(usage, { input: 1n, output: 1n, cacheRead: 1n, cacheWrite: 1n }),
    ).toBe(1n);
    expect(
      estimateCostMicros(usage, { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n }),
    ).toBe(0n);
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid usage %s before metering',
    (inputTokens) => {
      expect(() =>
        estimateCostMicros(
          { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          { input: 1n, output: 1n, cacheRead: 1n, cacheWrite: 1n },
        ),
      ).toThrow('Invalid AI usage');
    },
  );
  it('prices writes to the hour’s cache at their own price, and the rest at the five minutes’', () => {
    // Claude Opus 5.5's list prices: $4 input, $5 five-minute write, $8 one-hour write.
    const opus = {
      input: 4_000_000n,
      output: 20_000_000n,
      cacheRead: 200_000n,
      cacheWrite: 5_000_000n,
      cacheWrite1h: 8_000_000n,
    };
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 20_000,
    };
    expect(estimateCostMicros(usage, opus)).toBe(100_000n);
    expect(estimateCostMicros({ ...usage, cacheWrite1hTokens: 20_000 }, opus)).toBe(160_000n);
    // 15,000 for five minutes ($0.075) and 5,000 for an hour ($0.04).
    expect(estimateCostMicros({ ...usage, cacheWrite1hTokens: 5000 }, opus)).toBe(115_000n);
    expect(pricesCover({ ...usage, cacheWrite1hTokens: 5000 }, opus)).toBe(true);
  });
  it('cannot count a write to the hour’s cache without its price, and refuses to guess one', () => {
    const fiveMinutesOnly = { input: 4n, output: 20n, cacheRead: 1n, cacheWrite: 5n };
    const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10 };
    expect(pricesCover(usage, fiveMinutesOnly)).toBe(true);
    expect(pricesCover({ ...usage, cacheWrite1hTokens: 0 }, fiveMinutesOnly)).toBe(true);
    expect(pricesCover({ ...usage, cacheWrite1hTokens: 10 }, fiveMinutesOnly)).toBe(false);
    expect(() => estimateCostMicros({ ...usage, cacheWrite1hTokens: 10 }, fiveMinutesOnly)).toThrow(
      'Invalid AI prices',
    );
    // More written to the hour's cache than was written at all is not usage.
    expect(() =>
      estimateCostMicros(
        { ...usage, cacheWrite1hTokens: 11 },
        { ...fiveMinutesOnly, cacheWrite1h: 8n },
      ),
    ).toThrow('Invalid AI usage');
    expect(() =>
      estimateCostMicros(
        { ...usage, cacheWrite1hTokens: 10 },
        { ...fiveMinutesOnly, cacheWrite1h: -1n },
      ),
    ).toThrow('Invalid AI prices');
  });
  it('refuses negative price tables instead of lowering recorded spend', () => {
    expect(() =>
      estimateCostMicros(
        { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { input: -1n, output: 0n, cacheRead: 0n, cacheWrite: 0n },
      ),
    ).toThrow('Invalid AI prices');
  });
});

describe('prices, in dollars for a million tokens', () => {
  it('reads a price exactly, to a millionth of a dollar', () => {
    expect(dollarsToMicros('4')).toBe(4_000_000n);
    expect(dollarsToMicros('12.50')).toBe(12_500_000n);
    expect(dollarsToMicros('0.100000')).toBe(100_000n);
    expect(dollarsToMicros('0.000001')).toBe(1n);
    expect(dollarsToMicros('0')).toBe(0n);
    expect(dollarsToMicros('1234567890123.000000')).toBe(1_234_567_890_123_000_000n);
  });

  it.each(['', '-1', '1.2345678', '1e3', ' 4', '4.', '.5', 'four', '1,5'])(
    'refuses %j rather than round or guess',
    (value) => {
      expect(() => dollarsToMicros(value)).toThrow('Invalid AI amount');
    },
  );

  it('writes an amount back the way the database keeps it', () => {
    expect(microsToDollars(0n)).toBe('0.000000');
    expect(microsToDollars(1n)).toBe('0.000001');
    expect(microsToDollars(5650n)).toBe('0.005650');
    expect(microsToDollars(12_500_000n)).toBe('12.500000');
    expect(() => microsToDollars(-1n)).toThrow('Invalid AI amount');
  });

  it('ships Claude’s prices with where each came from and when it was checked', () => {
    const page = 'https://platform.claude.com/docs/en/about-claude/pricing';
    expect(BUILT_IN_PRICES).toEqual({
      'anthropic/claude-fable-5-1': {
        prices: {
          input: 10_000_000n,
          output: 50_000_000n,
          cacheRead: 250_000n,
          cacheWrite: 12_500_000n,
          cacheWrite1h: 20_000_000n,
        },
        source: page,
        checkedOn: '2026-10-14',
      },
      'anthropic/claude-opus-5-5': {
        prices: {
          input: 4_000_000n,
          output: 20_000_000n,
          cacheRead: 200_000n,
          cacheWrite: 5_000_000n,
          cacheWrite1h: 8_000_000n,
        },
        source: page,
        checkedOn: '2026-10-14',
      },
      'anthropic/claude-sonnet-5-5': {
        prices: {
          input: 2_000_000n,
          output: 10_000_000n,
          cacheRead: 100_000n,
          cacheWrite: 2_500_000n,
          cacheWrite1h: 4_000_000n,
        },
        source: page,
        checkedOn: '2026-10-14',
      },
      'anthropic/claude-haiku-4-5': {
        prices: {
          input: 1_000_000n,
          output: 5_000_000n,
          cacheRead: 100_000n,
          cacheWrite: 1_250_000n,
          cacheWrite1h: 2_000_000n,
        },
        source: page,
        checkedOn: '2026-10-14',
      },
      'anthropic/claude-haiku-4-5-20251001': {
        prices: {
          input: 1_000_000n,
          output: 5_000_000n,
          cacheRead: 100_000n,
          cacheWrite: 1_250_000n,
          cacheWrite1h: 2_000_000n,
        },
        source: page,
        checkedOn: '2026-10-14',
      },
    });
    expect(priceKey('openai_compatible', 'llama3.2')).toBe('openai_compatible/llama3.2');
  });

  it('holds enough for the most a call should cost: every byte a token, every output token used', () => {
    const prices = {
      input: 4_000_000n,
      output: 20_000_000n,
      cacheRead: 200_000n,
      cacheWrite: 5_000_000n,
    };
    expect(HIDDEN_INPUT_TOKENS).toBe(1024);
    // 1,000 bytes and the allowance at the dearer of fresh input and a cache write ($5),
    // plus 2,000 output tokens at $20.
    expect(worstCaseMicros(1000, 2000, prices)).toBe(10_120n + 40_000n);
    expect(worstCaseMicros(0, 0, prices)).toBe(5120n);
    expect(
      worstCaseMicros(976, 0, { input: 4_000_000n, output: 0n, cacheRead: 0n, cacheWrite: 1n }),
    ).toBe(8000n);
    // A model that costs nothing holds nothing.
    expect(
      worstCaseMicros(5000, 5000, { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n }),
    ).toBe(0n);
  });

  it('holds the hour’s dearer write for a call that asks for that cache, and only then', () => {
    const prices = {
      input: 4_000_000n,
      output: 0n,
      cacheRead: 200_000n,
      cacheWrite: 5_000_000n,
      cacheWrite1h: 8_000_000n,
    };
    // 976 bytes and the 1,024-token allowance: 2,000 tokens.
    expect(worstCaseMicros(976, 0, prices)).toBe(10_000n);
    expect(worstCaseMicros(976, 0, prices, '5m')).toBe(10_000n);
    expect(worstCaseMicros(976, 0, prices, '1h')).toBe(16_000n);
    // An hour's price below the five minutes' does not lower the hold.
    expect(worstCaseMicros(976, 0, { ...prices, cacheWrite1h: 1n }, '1h')).toBe(10_000n);
    const unpriced = { input: 4_000_000n, output: 0n, cacheRead: 0n, cacheWrite: 5_000_000n };
    expect(worstCaseMicros(976, 0, unpriced, '1h')).toBe(10_000n);
  });
});
