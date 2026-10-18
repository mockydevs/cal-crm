// The arithmetic of a quote or an invoice. One function works out every amount, and both
// sides use it: the contract refuses a document whose numbers cannot be (a discount larger
// than its line, a quantity of zero), and the commerce module stores what it returns.
// Nothing here is a float: an amount is a whole number of ten-thousandths, as numeric(19,
// 4) holds it.
//
// The rounding rule. Unit prices, quantities and rates keep four decimal places. Every
// amount of money a document shows is rounded half up to the currency's smallest unit
// (two places for KES or USD, none for JPY or UGX), line by line, and the totals are the
// sums of the rounded lines. So the lines a customer reads add up to the total they pay,
// and tax for a rate is the sum of that rate's lines. Amounts are never negative, so half
// up and half away from zero are the same thing.
import { isAmount, isCurrencyCode } from '@repo/kernel';

/** Ten-thousandths in one whole unit of money. */
const SCALE = 10_000n;
/** The largest amount numeric(19, 4) holds, in ten-thousandths. */
const MAX_UNITS = 10n ** 19n - 1n;
const HUNDRED_PERCENT = 100n * SCALE;

/** A decimal string of at most four places as ten-thousandths. Callers check its form first. */
export function toUnits(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
  return negative ? -units : units;
}

/** Ten-thousandths as a decimal string, always with four places: 1250000 is "125.0000". */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const text = `${String(absolute / SCALE)}.${String(absolute % SCALE).padStart(4, '0')}`;
  return negative ? `-${text}` : text;
}

/**
 * How many decimal places the currency's smallest unit has: 2 for KES, 0 for JPY, 3 for
 * KWD. From the runtime's ISO 4217 data, and never more than the four places stored.
 */
export function currencyDigits(currency: string): number {
  if (!isCurrencyCode(currency)) return 2;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits;
  return Math.min(digits ?? 2, 4);
}

/** The currency's smallest unit, in ten-thousandths: 100 for KES, 10000 for JPY. */
export function smallestUnit(currency: string): bigint {
  return 10n ** BigInt(4 - currencyDigits(currency));
}

/**
 * A stored decimal as a document prints it: thousands grouped with commas, and as many
 * decimal places as it needs, never fewer than asked: "1250.5000" is "1,250.5", and with
 * two places "1,250.50". No float is involved, so nothing is rounded: a unit price of
 * 333.3350 prints as 333.335 whatever the currency. Callers pass a decimal of at most four
 * places, as the API returns every amount.
 */
export function formatDecimal(amount: string, minimumPlaces = 0): string {
  const units = toUnits(amount);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = String(absolute / SCALE).replaceAll(/\B(?=(?:\d{3})+$)/g, ',');
  const places = String(absolute % SCALE).padStart(4, '0');
  let kept = 4;
  while (kept > minimumPlaces && places[kept - 1] === '0') kept -= 1;
  return `${negative ? '-' : ''}${whole}${kept === 0 ? '' : `.${places.slice(0, kept)}`}`;
}

/**
 * An amount of money as a quote, an invoice or a receipt prints it: the currency's code,
 * then the amount with the currency's own decimal places: "KES 1,015.01", "JPY 1,200". The
 * code and not a symbol, so a document reads the same in every font and every country.
 */
export function formatMoney(amount: string, currency: string): string {
  return `${currency} ${formatDecimal(amount, currencyDigits(currency))}`;
}

/**
 * numerator / denominator to the nearest multiple of step, halves up. All three are
 * nonnegative and the last two positive.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint, step: bigint): bigint {
  const divisor = denominator * step;
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  return (remainder * 2n >= divisor ? quotient + 1n : quotient) * step;
}

/** Money off: a percentage, or an amount in the document's currency. */
export interface DiscountInput {
  readonly kind: 'percent' | 'amount';
  /** A decimal: 0 to 100 for a percentage, else an amount of money. */
  readonly value: string;
}

export interface TotalsLineInput {
  /** A decimal above zero, to four places. */
  readonly quantity: string;
  /** A nonnegative decimal, to four places. */
  readonly unitPrice: string;
  readonly discount?: DiscountInput | null | undefined;
  /** Percent, 0 to 100, to four places. Left out or null: no tax. */
  readonly taxRate?: string | null | undefined;
}

export interface TotalsInput {
  readonly currency: string;
  readonly lines: readonly TotalsLineInput[];
  /** Money off the whole document, after the lines' own discounts and before tax. */
  readonly discount?: DiscountInput | null | undefined;
}

/** One line's amounts, each a decimal with four places. */
export interface LineTotals {
  /** Quantity times unit price. */
  readonly amount: string;
  /** The line's own discount. */
  readonly discount: string;
  /** The amount less the line's discount. */
  readonly net: string;
  /** What tax is charged on: the net less the line's share of the document's discount. */
  readonly taxable: string;
  readonly tax: string;
  /** Taxable plus tax. The lines' totals add up to the document's. */
  readonly total: string;
}

export interface TaxTotal {
  /** Percent, with four places: "16.0000". */
  readonly rate: string;
  readonly taxable: string;
  readonly tax: string;
}

export interface DocumentTotals {
  readonly lines: readonly LineTotals[];
  /** The lines' amounts, before any discount. */
  readonly subtotal: string;
  /** The lines' own discounts together. */
  readonly lineDiscountTotal: string;
  /** The document's discount, as money. */
  readonly documentDiscount: string;
  /** Both kinds of discount together. */
  readonly discountTotal: string;
  /** One entry for each tax rate on the document, lowest rate first. */
  readonly taxes: readonly TaxTotal[];
  readonly taxTotal: string;
  /** Subtotal less discounts plus tax. */
  readonly total: string;
}

export interface TotalsIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export type TotalsResult =
  | { readonly ok: true; readonly totals: DocumentTotals }
  | { readonly ok: false; readonly issues: readonly [TotalsIssue, ...TotalsIssue[]] };

const nonnegative = (value: string): boolean => isAmount(value) && !value.startsWith('-');

/**
 * A discount as money off `base`, or the issue that refuses it. A percentage is rounded to
 * the currency's smallest unit; an amount must already be in whole smallest units and no
 * more than what it comes off.
 */
function discountOf(
  discount: DiscountInput | null | undefined,
  base: bigint,
  step: bigint,
  path: readonly (string | number)[],
  what: string,
): bigint | TotalsIssue {
  if (discount === null || discount === undefined) return 0n;
  if (!nonnegative(discount.value))
    return {
      path: [...path, 'value'],
      code: 'invalid_discount',
      message: 'Enter a discount of zero or more, with at most four decimal places.',
    };
  const value = toUnits(discount.value);
  if (discount.kind === 'percent') {
    if (value > HUNDRED_PERCENT)
      return {
        path: [...path, 'value'],
        code: 'discount_too_large',
        message: 'A discount is at most 100 percent.',
      };
    return roundHalfUp(base * value, HUNDRED_PERCENT, step);
  }
  if (value % step !== 0n)
    return {
      path: [...path, 'value'],
      code: 'amount_precision',
      message: "Enter the discount in the currency's own units, without smaller fractions.",
    };
  if (value > base)
    return {
      path: [...path, 'value'],
      code: 'discount_too_large',
      message: `The discount is larger than the ${what} it comes off.`,
    };
  return value;
}

/**
 * The document's discount shared over the lines in proportion to what each comes to, in
 * whole smallest units, so tax is charged on what is really paid for each line. What
 * division leaves over goes, one smallest unit each, to the lines that lost the largest
 * fraction, earlier lines first: the shares add up to the discount exactly.
 */
function shareDiscount(discount: bigint, nets: readonly bigint[], step: bigint): bigint[] {
  const whole = nets.reduce((sum, net) => sum + net, 0n);
  if (discount === 0n || whole === 0n) return nets.map(() => 0n);
  const divisor = whole * step;
  const shares = nets.map((net) => ((discount * net) / divisor) * step);
  const lost = nets.map((net, index) => ({ index, remainder: (discount * net) % divisor }));
  let left = (discount - shares.reduce((sum, share) => sum + share, 0n)) / step;
  lost.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of lost) {
    if (left === 0n) break;
    shares[index] = (shares[index] ?? 0n) + step;
    left -= 1n;
  }
  return shares;
}

interface CheckedLine {
  readonly amount: bigint;
  readonly discount: bigint;
  readonly net: bigint;
  readonly rate: bigint;
}

function checkLine(
  line: TotalsLineInput,
  index: number,
  step: bigint,
  issues: TotalsIssue[],
): CheckedLine | undefined {
  const before = issues.length;
  if (!nonnegative(line.quantity) || toUnits(line.quantity) === 0n)
    issues.push({
      path: ['lines', index, 'quantity'],
      code: 'invalid_quantity',
      message: 'Enter a quantity above zero, with at most four decimal places.',
    });
  if (!nonnegative(line.unitPrice))
    issues.push({
      path: ['lines', index, 'unitPrice'],
      code: 'invalid_price',
      message: 'Enter a price of zero or more, with at most four decimal places.',
    });
  const rateText = line.taxRate ?? '0';
  if (!nonnegative(rateText) || toUnits(rateText) > HUNDRED_PERCENT)
    issues.push({
      path: ['lines', index, 'taxRate'],
      code: 'invalid_tax_rate',
      message: 'Enter a tax rate from 0 to 100 percent, with at most four decimal places.',
    });
  if (issues.length > before) return undefined;
  const amount = roundHalfUp(toUnits(line.quantity) * toUnits(line.unitPrice), SCALE, step);
  const discount = discountOf(line.discount, amount, step, ['lines', index, 'discount'], 'line');
  if (typeof discount !== 'bigint') {
    issues.push(discount);
    return undefined;
  }
  return { amount, discount, net: amount - discount, rate: toUnits(rateText) };
}

/**
 * Every amount of a quote or an invoice, or why its numbers cannot be. The same call
 * validates a document in the contract and gives the commerce module what it stores.
 */
export function computeDocumentTotals(input: TotalsInput): TotalsResult {
  const issues: TotalsIssue[] = [];
  if (!isCurrencyCode(input.currency))
    issues.push({
      path: ['currency'],
      code: 'invalid_currency',
      message: 'Enter a currency code, such as KES.',
    });
  const step = smallestUnit(input.currency);
  const checked = input.lines.map((line, index) => checkLine(line, index, step, issues));
  const lines = checked.filter((line) => line !== undefined);
  const refuse = (): TotalsResult => {
    const [first, ...rest] = issues;
    if (first === undefined) throw new TypeError('A refusal needs an issue.');
    return { ok: false, issues: [first, ...rest] };
  };
  if (lines.length !== checked.length || issues.length > 0) return refuse();

  const sum = (values: readonly bigint[]): bigint => values.reduce((all, one) => all + one, 0n);
  const subtotal = sum(lines.map((line) => line.amount));
  const lineDiscountTotal = sum(lines.map((line) => line.discount));
  const netTotal = subtotal - lineDiscountTotal;
  const documentDiscount = discountOf(input.discount, netTotal, step, ['discount'], 'document');
  if (typeof documentDiscount !== 'bigint') {
    issues.push(documentDiscount);
    return refuse();
  }
  const shares = shareDiscount(
    documentDiscount,
    lines.map((line) => line.net),
    step,
  );
  const byRate = new Map<bigint, { taxable: bigint; tax: bigint }>();
  const lineTotals = lines.map((line, index): LineTotals => {
    const taxable = line.net - (shares[index] ?? 0n);
    const tax = roundHalfUp(taxable * line.rate, HUNDRED_PERCENT, step);
    const rate = byRate.get(line.rate) ?? { taxable: 0n, tax: 0n };
    byRate.set(line.rate, { taxable: rate.taxable + taxable, tax: rate.tax + tax });
    return {
      amount: fromUnits(line.amount),
      discount: fromUnits(line.discount),
      net: fromUnits(line.net),
      taxable: fromUnits(taxable),
      tax: fromUnits(tax),
      total: fromUnits(taxable + tax),
    };
  });
  const taxes = [...byRate.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([rate, each]) => ({
      rate: fromUnits(rate),
      taxable: fromUnits(each.taxable),
      tax: fromUnits(each.tax),
    }));
  const taxTotal = sum([...byRate.values()].map((each) => each.tax));
  const discountTotal = lineDiscountTotal + documentDiscount;
  const total = subtotal - discountTotal + taxTotal;
  if (subtotal > MAX_UNITS || total > MAX_UNITS) {
    issues.push({
      path: ['lines'],
      code: 'too_large',
      message: 'This document comes to more than an amount can hold.',
    });
    return refuse();
  }
  return {
    ok: true,
    totals: {
      lines: lineTotals,
      subtotal: fromUnits(subtotal),
      lineDiscountTotal: fromUnits(lineDiscountTotal),
      documentDiscount: fromUnits(documentDiscount),
      discountTotal: fromUnits(discountTotal),
      taxes,
      taxTotal: fromUnits(taxTotal),
      total: fromUnits(total),
    },
  };
}
