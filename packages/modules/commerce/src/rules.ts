// What the commerce module decides without the database: how the amounts stored on a
// document and its lines are shown as its totals, the dates a document gets when it names
// none, who it is from, and what a counter may be moved to. The arithmetic itself is the
// contract's (commerce-money.ts): nothing here works an amount out a second way.
import {
  addDays,
  computeDocumentTotals,
  fromUnits,
  invoiceStatuses,
  MAX_SEQUENCE_NUMBER,
  paymentMethods,
  salesDocumentStatuses,
  sellerSnapshot,
  toUnits,
  type PaymentMethod,
  type SalesDocument,
  type SalesDocumentKind,
  type SalesDocumentStatus,
  type DocumentTotals,
  type LineTotals,
  type SellerSnapshot,
  type TotalsInput,
  type TotalsIssue,
  type TotalsLineInput,
} from '@repo/contracts';
import { jsonPointer, ValidationError, type Issue } from '@repo/kernel';

/** A pattern for LIKE that finds the text anywhere, whatever its capitals. */
export function likePattern(text: string): string {
  return `%${text.toLowerCase().replaceAll(/[\\%_]/g, String.raw`\$&`)}%`;
}

/** The settings a business has before it saves any: the columns' own defaults (0079). */
export const DEFAULT_SETTINGS = {
  paymentTermsDays: 14,
  quoteValidityDays: 30,
  defaultNotes: '',
  defaultTerms: '',
  paymentInstructions: '',
  taxNumber: null,
  defaultTaxRate: null,
  revision: 1,
} as const;

/** As much of the settings as dates a document. */
export interface TermDays {
  readonly paymentTermsDays: number;
  readonly quoteValidityDays: number;
}

/**
 * The dates a document is issued with: the ones it names, else today for the issue date,
 * and the business's payment terms (an invoice) or quote validity (a quote) after it for
 * the due date.
 */
export function issueDates(
  kind: SalesDocumentKind,
  stored: { readonly issueDate: string | null; readonly dueDate: string | null },
  today: string,
  terms: TermDays,
): { readonly issueDate: string; readonly dueDate: string } {
  const issueDate = stored.issueDate ?? today;
  const days = kind === 'invoice' ? terms.paymentTermsDays : terms.quoteValidityDays;
  return { issueDate, dueDate: stored.dueDate ?? addDays(issueDate, days) };
}

/** Whether the due date, when both are named, is before the issue date. */
export function dueBeforeIssue(issueDate: string | null, dueDate: string | null): boolean {
  return issueDate !== null && dueDate !== null && dueDate < issueDate;
}

/** The amounts a document's row holds, each a decimal with four places. */
export interface StoredAmounts {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
}

/** The amounts a line's row holds. */
export interface StoredLineAmounts {
  readonly taxRate: string;
  readonly discountAmount: string;
  readonly taxableAmount: string;
  readonly taxAmount: string;
}

const sum = (values: readonly string[]): bigint =>
  values.reduce((all, one) => all + toUnits(one), 0n);

/** A stored decimal with exactly four places, whatever scale its column has. */
export const fourPlaces = (amount: string): string => fromUnits(toUnits(amount));

/**
 * A document's totals as the API shows them, from what is stored: nothing is worked out
 * again. The lines' own discounts are summed; the document's discount is what is left of
 * the stored discount total; each rate's tax is the sum of that rate's lines.
 */
export function shownTotals(
  stored: StoredAmounts,
  lines: readonly StoredLineAmounts[],
): SalesDocument['totals'] {
  const lineDiscountTotal = sum(lines.map((line) => line.discountAmount));
  const byRate = new Map<bigint, { taxable: bigint; tax: bigint }>();
  for (const line of lines) {
    const rate = toUnits(line.taxRate);
    const each = byRate.get(rate) ?? { taxable: 0n, tax: 0n };
    byRate.set(rate, {
      taxable: each.taxable + toUnits(line.taxableAmount),
      tax: each.tax + toUnits(line.taxAmount),
    });
  }
  return {
    subtotal: fourPlaces(stored.subtotal),
    lineDiscountTotal: fromUnits(lineDiscountTotal),
    documentDiscount: fromUnits(toUnits(stored.discountTotal) - lineDiscountTotal),
    discountTotal: fourPlaces(stored.discountTotal),
    taxes: [...byRate.entries()]
      .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
      .map(([rate, each]) => ({
        rate: fromUnits(rate),
        taxable: fromUnits(each.taxable),
        tax: fromUnits(each.tax),
      })),
    taxTotal: fourPlaces(stored.taxTotal),
    total: fourPlaces(stored.total),
    amountPaid: fourPlaces(stored.amountPaid),
    balanceDue: fourPlaces(stored.balanceDue),
  };
}

/** What a line comes to: what tax is charged on, plus the tax. */
export const lineTotal = (taxableAmount: string, taxAmount: string): string =>
  fromUnits(toUnits(taxableAmount) + toUnits(taxAmount));

/** What is paid and what is owed once a payment is added to, or taken off, an invoice. */
export function paidAfter(
  total: string,
  amountPaid: string,
  change: string,
  direction: 'record' | 'reverse',
): { readonly amountPaid: string; readonly balanceDue: string } {
  const paid = toUnits(amountPaid) + (direction === 'record' ? 1n : -1n) * toUnits(change);
  return { amountPaid: fromUnits(paid), balanceDue: fromUnits(toUnits(total) - paid) };
}

/** As much of the business profile as a document prints. */
export interface SellerProfile {
  readonly name: string;
  readonly address: SellerSnapshot['address'];
  readonly logoFileId: string | null;
}

/** Who a document is from, as the business and its settings are now. */
export function sellerOf(
  profile: SellerProfile,
  settings: { readonly taxNumber: string | null; readonly paymentInstructions: string },
): SellerSnapshot {
  return {
    name: profile.name,
    address: profile.address,
    taxNumber: settings.taxNumber,
    logoFileId: profile.logoFileId,
    paymentInstructions: settings.paymentInstructions,
  };
}

/** The snapshot a document's row holds, or null when it holds none that can be read. */
export function storedSeller(value: unknown): SellerSnapshot | null {
  const read = sellerSnapshot.safeParse(value);
  return read.success ? read.data : null;
}

/**
 * Who a receipt is from: what the invoice's issue wrote down. Every invoice a payment was
 * recorded against was issued, so a row that holds nothing readable is shown blank rather
 * than failing the receipt.
 */
export function receiptSeller(value: unknown): SellerSnapshot {
  return (
    storedSeller(value) ?? {
      name: '',
      address: null,
      taxNumber: null,
      logoFileId: null,
      paymentInstructions: '',
    }
  );
}

/** A line with the amounts it comes to. */
export interface PricedLine<Line> {
  readonly line: Line;
  readonly amounts: LineTotals;
}

/**
 * A document's lines, each with what the one arithmetic says it comes to, and the
 * document's totals; or that arithmetic's refusal, as the API reports one. The contract
 * runs the same function on the way in, so a refusal here means a caller skipped it.
 */
export function pricedLines<Line extends TotalsLineInput>(values: {
  readonly currency: string;
  readonly lines: readonly Line[];
  readonly discount?: TotalsInput['discount'];
}): { readonly totals: DocumentTotals; readonly lines: readonly PricedLine<Line>[] } {
  const result = computeDocumentTotals(values);
  if (!result.ok) {
    const asIssue = (issue: TotalsIssue): Issue => ({
      path: jsonPointer(issue.path),
      code: issue.code,
      message: issue.message,
    });
    const [first, ...rest] = result.issues;
    throw new ValidationError([asIssue(first), ...rest.map(asIssue)]);
  }
  return {
    totals: result.totals,
    // The arithmetic answers with one entry a line, in the lines' order.
    lines: result.totals.lines.flatMap((amounts, index) => {
      const line = values.lines[index];
      return line === undefined ? [] : [{ line, amounts }];
    }),
  };
}

/**
 * Why a counter cannot be moved to that number, or undefined when it can: a number is
 * given out once, so the next one is above every number given out so far.
 */
export function nextNumberRefusal(nextNumber: number, lastNumber: number): string | undefined {
  if (nextNumber <= lastNumber)
    return `Numbers up to ${String(lastNumber)} were already given out. Choose a number above ${String(lastNumber)}.`;
  return undefined;
}

/** Whether a counter has a number left to give out. */
export const numbersLeft = (nextNumber: number): boolean => nextNumber < MAX_SEQUENCE_NUMBER;

/** A stored status, or draft for one this release does not know. */
export const statusOf = (status: string): SalesDocumentStatus =>
  salesDocumentStatuses.find((each) => each === status) ?? 'draft';

/** A stored invoice status, as a receipt names it. */
export const invoiceStatusOf = (status: string): (typeof invoiceStatuses)[number] =>
  invoiceStatuses.find((each) => each === status) ?? 'draft';

export const kindOf = (kind: string): SalesDocumentKind => (kind === 'quote' ? 'quote' : 'invoice');

export const methodOf = (method: string): PaymentMethod =>
  paymentMethods.find((each) => each === method) ?? 'other';
