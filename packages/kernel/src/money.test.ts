import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isAmount, isCurrencyCode } from './index.js';

// Amounts are stored as numeric(19, 4): up to 15 digits before the point and 4 after.
describe('isAmount', () => {
  it.each(['0', '7', '1250', '1250.5', '1250.5000', '-3.25', '999999999999999.9999'])(
    'accepts %j',
    (amount) => {
      expect(isAmount(amount)).toBe(true);
    },
  );

  it.each([
    ['nothing', ''],
    ['a number too big for the column', '1000000000000000'],
    ['more than 4 decimals', '1.23456'],
    ['a trailing point', '1.'],
    ['no digit before the point', '.5'],
    ['a leading zero', '0125'],
    ['an exponent', '1e3'],
    ['a thousands separator', '1,000'],
    ['spaces', ' 1'],
    ['a plus sign', '+1'],
    ['words', 'NaN'],
  ])('rejects %s: %j', (_case, amount) => {
    expect(isAmount(amount)).toBe(false);
  });

  it('accepts every whole part of up to 15 digits with up to 4 decimals', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n - 1n }),
        fc.stringMatching(/^(\.[0-9]{1,4})?$/),
        fc.boolean(),
        (whole, fraction, negative) => {
          expect(isAmount(`${negative ? '-' : ''}${String(whole)}${fraction}`)).toBe(true);
        },
      ),
    );
  });
});

describe('isCurrencyCode', () => {
  it.each(['USD', 'KES', 'EUR', 'JPY', 'GBP'])('accepts %s', (code) => {
    expect(isCurrencyCode(code)).toBe(true);
  });

  it.each([
    ['lowercase', 'usd'],
    ['too short', 'US'],
    ['too long', 'USDT'],
    ['the ISO 4217 code for no currency', 'XXX'],
    ['a currency that no longer exists', 'ADP'],
    ['nothing', ''],
  ])('rejects %s: %j', (_case, code) => {
    expect(isCurrencyCode(code)).toBe(false);
  });
});
