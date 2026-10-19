import { describe, expect, it } from 'vitest';

import { amountFromStripe, isStripeCurrency, stripeAmountOf } from './stripe-amounts.js';

describe('stripeAmountOf', () => {
  it('charges a two-place currency in its minor unit, lowercased', () => {
    expect(stripeAmountOf('10.9900', 'USD')).toEqual({
      outcome: 'ok',
      currency: 'usd',
      unitAmount: '1099',
    });
    expect(stripeAmountOf('1250.0000', 'EUR')).toEqual({
      outcome: 'ok',
      currency: 'eur',
      unitAmount: '125000',
    });
  });

  it('refuses a currency the docs do not show with two places', () => {
    for (const currency of ['JPY', 'KRW', 'KWD', 'KES', 'UGX'])
      expect(stripeAmountOf('1000.0000', currency)).toEqual({
        outcome: 'refused',
        reason: 'unsupported_currency',
      });
    expect(isStripeCurrency('USD')).toBe(true);
    expect(isStripeCurrency('JPY')).toBe(false);
  });

  it("refuses less than Stripe's minimum charge", () => {
    expect(stripeAmountOf('0.4900', 'USD')).toEqual({
      outcome: 'refused',
      reason: 'below_minimum',
    });
    expect(stripeAmountOf('0.5000', 'USD')).toMatchObject({ outcome: 'ok', unitAmount: '50' });
    expect(stripeAmountOf('174.9900', 'HUF')).toEqual({
      outcome: 'refused',
      reason: 'below_minimum',
    });
  });

  it('refuses an amount smaller than a cent, or more than twelve digits', () => {
    expect(stripeAmountOf('10.0050', 'USD')).toEqual({ outcome: 'refused', reason: 'not_payable' });
    expect(stripeAmountOf('9999999999.9900', 'USD')).toMatchObject({ outcome: 'ok' });
    expect(stripeAmountOf('10000000000.0000', 'USD')).toEqual({
      outcome: 'refused',
      reason: 'not_payable',
    });
  });
});

describe('amountFromStripe', () => {
  it('turns minor units back into a stored amount', () => {
    expect(amountFromStripe(1099)).toBe('10.9900');
    expect(amountFromStripe(5)).toBe('0.0500');
    expect(amountFromStripe(0)).toBe('0.0000');
  });

  it('refuses what is not a whole, non-negative number', () => {
    expect(() => amountFromStripe(-1)).toThrow();
    expect(() => amountFromStripe(1.5)).toThrow();
  });
});
