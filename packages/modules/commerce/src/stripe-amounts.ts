// An invoice's balance as Stripe charges it, and back. Stripe takes an amount in the currency's
// minor unit: 1099 is 10.99 USD (https://docs.stripe.com/currencies.md, "Specify amounts in API
// requests"). Its own list of currencies without a minor unit, and of those with three places,
// isn't part of what the docs page gives in text, so card payments take only the currencies that
// page shows with two places: its minimum charge amounts and its maximum charge examples. Any
// other currency is refused rather than charged a hundred times too much or too little.
import { toUnits } from '@repo/contracts';

/** Two-place currencies and Stripe's minimum charge in each, in minor units (same page). */
const MINIMUM_CHARGE: Readonly<Record<string, bigint>> = {
  USD: 50n,
  AED: 200n,
  ARS: 50n,
  AUD: 50n,
  BRL: 50n,
  CAD: 50n,
  CHF: 50n,
  COP: 50n,
  CZK: 1500n,
  DKK: 250n,
  EUR: 50n,
  GBP: 30n,
  HKD: 400n,
  HUF: 17500n,
  IDR: 50n,
  ILS: 50n,
  INR: 50n,
  MYR: 200n,
  NOK: 300n,
  NZD: 50n,
  PHP: 50n,
  PLN: 200n,
  RON: 200n,
  RUB: 50n,
  SEK: 300n,
  SGD: 50n,
  ZAR: 50n,
};

/** The most a card payment's amount may be: 12 digits in minor units (same page). */
const MAX_MINOR = 999_999_999_999n;

/** Ten-thousandths in one minor unit of a two-place currency. */
const PER_MINOR = 100n;

export type StripeAmountRefusal = 'unsupported_currency' | 'below_minimum' | 'not_payable';

export type StripeAmount =
  | { readonly outcome: 'ok'; readonly currency: string; readonly unitAmount: string }
  | { readonly outcome: 'refused'; readonly reason: StripeAmountRefusal };

/** Whether an invoice in this currency can be paid by card at all. */
export const isStripeCurrency = (currency: string): boolean =>
  Object.hasOwn(MINIMUM_CHARGE, currency);

/**
 * A stored amount (numeric(19, 4), as "1250.5000") as Stripe's currency and unit_amount. An
 * amount with a part smaller than the minor unit can't be charged exactly, so it is refused.
 */
export function stripeAmountOf(amount: string, currency: string): StripeAmount {
  const minimum = MINIMUM_CHARGE[currency];
  if (minimum === undefined) return { outcome: 'refused', reason: 'unsupported_currency' };
  const units = toUnits(amount);
  if (units % PER_MINOR !== 0n) return { outcome: 'refused', reason: 'not_payable' };
  const minor = units / PER_MINOR;
  if (minor < minimum) return { outcome: 'refused', reason: 'below_minimum' };
  if (minor > MAX_MINOR) return { outcome: 'refused', reason: 'not_payable' };
  return { outcome: 'ok', currency: currency.toLowerCase(), unitAmount: String(minor) };
}

/** What Stripe charged, in minor units of a two-place currency, as a stored amount. */
export function amountFromStripe(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Not a Stripe amount.');
  const whole = BigInt(minor);
  return `${String(whole / PER_MINOR)}.${String(whole % PER_MINOR).padStart(2, '0')}00`;
}
