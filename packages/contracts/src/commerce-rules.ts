// The rules of quotes, invoices and payments that need no database: which status allows
// what, what a payment does to an invoice, when a document is overdue or expired, and how a
// number is written. The commerce module decides by them, and a screen can ask them the
// same questions before it offers a button.
import { isAmount } from '@repo/kernel';

import { smallestUnit, toUnits } from './commerce-money.js';

export const salesDocumentKinds = ['quote', 'invoice'] as const;
export type SalesDocumentKind = (typeof salesDocumentKinds)[number];

export const quoteStatuses = ['draft', 'sent', 'accepted', 'declined'] as const;
export const invoiceStatuses = ['draft', 'sent', 'partly_paid', 'paid', 'void'] as const;
export const salesDocumentStatuses = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'partly_paid',
  'paid',
  'void',
] as const;
export type SalesDocumentStatus = (typeof salesDocumentStatuses)[number];

export const paymentMethods = [
  'cash',
  'bank_transfer',
  'mobile_money',
  'card',
  'cheque',
  'other',
] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

/** The kinds of number a business gives out, each with a counter of its own. */
export const numberKinds = ['quote', 'invoice', 'receipt'] as const;
export type NumberKind = (typeof numberKinds)[number];

/** What a number starts with until the business chooses otherwise. */
export const DEFAULT_NUMBER_PREFIXES: Readonly<Record<NumberKind, string>> = {
  quote: 'QUO-',
  invoice: 'INV-',
  receipt: 'RCT-',
};

/** The digits a number has at least: INV-0001. A larger number simply grows. */
export const NUMBER_MIN_DIGITS = 4;
/** The largest number a counter reaches, as commerce.sequences holds it. */
export const MAX_SEQUENCE_NUMBER = 999_999_999_999;

/** A document's or a receipt's number as it is printed: the prefix, then the counter. */
export function formatDocumentNumber(prefix: string, sequence: number): string {
  return `${prefix}${String(sequence).padStart(NUMBER_MIN_DIGITS, '0')}`;
}

/** What can be done to a quote or an invoice. */
export const salesDocumentActions = [
  'update',
  'delete',
  'issue',
  'revise',
  'accept',
  'decline',
  'convert',
  'void',
  'record_payment',
  'duplicate',
] as const;
export type SalesDocumentAction = (typeof salesDocumentActions)[number];

/** As much of a document as its rules read. */
export interface DocumentState {
  readonly kind: SalesDocumentKind;
  readonly status: SalesDocumentStatus;
  /** Null until the document is first issued. */
  readonly number: string | null;
  /** A decimal: what has been paid and not reversed. */
  readonly amountPaid: string;
  /** For a quote: whether an invoice was made from it. */
  readonly converted: boolean;
}

const isPaid = (state: DocumentState): boolean => toUnits(state.amountPaid) > 0n;

/**
 * Why the action cannot be taken on the document as it stands, in words for the person, or
 * undefined when it can.
 *
 * A draft is edited freely. Issuing gives a document its number and freezes it: after
 * that only its status, its payments and the team's own note change. To correct an issued
 * quote, or an invoice nothing has been paid on, it is revised: back to a draft with the
 * same number, then issued again. An invoice with a payment on it is corrected by
 * reversing the payment first, or by voiding it and duplicating it.
 */
export function documentActionRefusal(
  action: SalesDocumentAction,
  state: DocumentState,
): string | undefined {
  const { kind, status } = state;
  const noun = kind === 'quote' ? 'quote' : 'invoice';
  switch (action) {
    case 'duplicate':
      return undefined;
    case 'update':
    case 'issue':
      return status === 'draft'
        ? undefined
        : `This ${noun} has been issued. Revise it to change it.`;
    case 'delete':
      if (status !== 'draft') return `An issued ${noun} is kept. It cannot be deleted.`;
      return state.number === null
        ? undefined
        : `This ${noun} already has a number, so it is kept. Issue it again${kind === 'invoice' ? ' or void it' : ''}.`;
    case 'revise':
      if (status === 'draft') return `This ${noun} is already a draft.`;
      if (kind === 'quote')
        return state.converted
          ? 'An invoice was made from this quote, so it can no longer change.'
          : undefined;
      if (status === 'void') return 'A void invoice cannot change. Duplicate it instead.';
      return isPaid(state)
        ? 'This invoice has a payment on it. Reverse the payment before changing the invoice.'
        : undefined;
    case 'accept':
    case 'decline':
      if (kind !== 'quote') return 'Only a quote is accepted or declined.';
      return status === 'sent' ? undefined : 'Only a quote that was sent can be answered.';
    case 'convert':
      if (kind !== 'quote') return 'Only a quote becomes an invoice.';
      if (state.converted) return 'An invoice was already made from this quote.';
      return status === 'sent' || status === 'accepted'
        ? undefined
        : 'Only a quote that was sent or accepted becomes an invoice.';
    case 'void':
      if (kind !== 'invoice') return 'Only an invoice is voided.';
      if (status === 'void') return 'This invoice is already void.';
      if (state.number === null) return 'This draft was never issued. Delete it instead.';
      return isPaid(state)
        ? 'This invoice has a payment on it. Reverse the payment before voiding the invoice.'
        : undefined;
    case 'record_payment':
      if (kind !== 'invoice') return 'A payment is recorded against an invoice.';
      if (status === 'draft') return 'Issue this invoice before recording a payment.';
      if (status === 'void') return 'This invoice is void.';
      return status === 'paid' ? 'This invoice is already paid in full.' : undefined;
  }
}

/** Every action the document allows as it stands, in the catalogue's order. */
export function allowedDocumentActions(state: DocumentState): SalesDocumentAction[] {
  return salesDocumentActions.filter(
    (action) => documentActionRefusal(action, state) === undefined,
  );
}

/**
 * The status of an issued invoice that is not void, from its total and what has been paid:
 * paid once nothing is owed (so an invoice that comes to nothing is paid the moment it is
 * issued), partly paid once something is, else sent.
 */
export function invoiceStatusFor(
  total: string,
  amountPaid: string,
): 'sent' | 'partly_paid' | 'paid' {
  const owed = toUnits(total);
  const paid = toUnits(amountPaid);
  if (paid >= owed) return 'paid';
  return paid > 0n ? 'partly_paid' : 'sent';
}

export interface PaymentRefusal {
  readonly code: 'invalid_amount' | 'amount_precision' | 'overpayment';
  readonly message: string;
}

/**
 * Why a payment of this amount cannot be recorded against that balance, or undefined when
 * it can: it is above zero, in the currency's own units, and no more than what is owed.
 * Nothing is ever recorded beyond the balance; money paid on top is another invoice's.
 */
export function paymentRefusal(
  amount: string,
  balanceDue: string,
  currency: string,
): PaymentRefusal | undefined {
  if (!isAmount(amount) || toUnits(amount) <= 0n)
    return { code: 'invalid_amount', message: 'Enter an amount above zero.' };
  const units = toUnits(amount);
  if (units % smallestUnit(currency) !== 0n)
    return {
      code: 'amount_precision',
      message: "Enter the amount in the currency's own units, without smaller fractions.",
    };
  if (units > toUnits(balanceDue))
    return {
      code: 'overpayment',
      message: 'This is more than is still owed on the invoice.',
    };
  return undefined;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date it is in the time zone at that moment, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date): string {
  // The Canadian English form of a date is YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The calendar date that many days after the one given. */
export function addDays(date: string, days: number): string {
  if (!CALENDAR_DATE.test(date)) throw new TypeError(`Not a calendar date: ${date}`);
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** As much of a document as says whether it is late. */
export interface DueState {
  readonly kind: SalesDocumentKind;
  readonly status: SalesDocumentStatus;
  readonly dueDate: string | null;
  readonly balanceDue: string;
}

/**
 * Whether an invoice is overdue on that day: issued, not void, something still owed, and
 * its due date gone by. It is due through the whole of its due date. Read, never stored.
 */
export function isOverdue(state: DueState, today: string): boolean {
  return (
    state.kind === 'invoice' &&
    (state.status === 'sent' || state.status === 'partly_paid') &&
    state.dueDate !== null &&
    state.dueDate < today &&
    toUnits(state.balanceDue) > 0n
  );
}

/**
 * Whether a quote has expired on that day: sent, not answered, and its last day gone by.
 * It can be accepted through the whole of that day. Read, never stored.
 */
export function isExpired(state: Omit<DueState, 'balanceDue'>, today: string): boolean {
  return (
    state.kind === 'quote' &&
    state.status === 'sent' &&
    state.dueDate !== null &&
    state.dueDate < today
  );
}

/**
 * Why the document cannot be emailed to its customer as it stands, in words for the
 * person, or undefined when it can. A draft has no number yet: it is issued first, in the
 * same step when the caller asks for that (`issueIfDraft`). A void invoice is not sent.
 */
export function documentSendRefusal(
  state: Pick<DocumentState, 'kind' | 'status'>,
  issueIfDraft = false,
): string | undefined {
  const noun = state.kind === 'quote' ? 'quote' : 'invoice';
  if (state.status === 'void') return 'A void invoice is not sent.';
  if (state.status === 'draft' && !issueIfDraft)
    return `This ${noun} is a draft. Issue it first, or send it with issueIfDraft.`;
  return undefined;
}

/** What a quote's customer may answer on its public page. */
export const quoteAnswers = ['accept', 'decline'] as const;
export type QuoteAnswer = (typeof quoteAnswers)[number];

/**
 * Why the customer cannot answer the quote on its public page, or undefined when they can:
 * only a quote that was sent, has no answer yet, and whose last day has not gone by.
 */
export function quoteAnswerRefusal(
  state: Pick<DocumentState, 'kind' | 'status'>,
  expired: boolean,
): string | undefined {
  if (state.kind !== 'quote') return 'Only a quote is accepted or declined.';
  if (state.status === 'accepted') return 'This quote was already accepted.';
  if (state.status === 'declined') return 'This quote was already declined.';
  if (state.status !== 'sent') return 'This quote is not open for an answer.';
  return expired ? 'This quote has expired. Ask for a new one.' : undefined;
}

/** A document's or a receipt's PDF file name: its number, or what it is while it has none. */
export function printedFileName(number: string | null, fallback: string): string {
  // A number is letters, digits, hyphens, underscores and slashes; a slash cannot be in a name.
  const name = (number ?? fallback).replaceAll(/[^A-Za-z0-9_-]+/g, '-');
  return `${name === '' ? fallback : name}.pdf`;
}
