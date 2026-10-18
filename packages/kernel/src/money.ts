/**
 * An amount of money. The amount is a decimal string, never a float, so cents are never
 * lost to rounding; the database stores it as numeric(19, 4).
 */
export interface Money {
  readonly amount: string;
  /** An ISO 4217 code, such as USD or KES. */
  readonly currency: string;
}

// Up to 15 digits before the point and 4 after: what numeric(19, 4) holds.
const AMOUNT = /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$/;

// ICU's list of ISO 4217 currencies in use, which updates with Node.
const currencies = new Set(Intl.supportedValuesOf('currency'));

/** Whether the value is a plain decimal amount that fits numeric(19, 4). */
export function isAmount(value: string): boolean {
  return AMOUNT.test(value);
}

/** Whether the value is the ISO 4217 code of a currency in use. */
export function isCurrencyCode(value: string): boolean {
  return currencies.has(value);
}
