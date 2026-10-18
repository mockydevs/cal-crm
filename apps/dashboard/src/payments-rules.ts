// What the Payments pages work out before they draw: which page the address names, how an
// amount is written, what a quote or an invoice being written holds and what it sends, and
// which chip a status gets. Amounts are decimal strings from end to end: the arithmetic is
// the contract's own (computeDocumentTotals), and nothing here is a float.
import {
  addDays,
  computeDocumentTotals,
  currencyDigits,
  formatDocumentNumber,
  MAX_SEQUENCE_NUMBER,
  type BusinessProfile,
  type CommerceSettings,
  type CreateProductInput,
  type Discount,
  type Product,
  type ProductKind,
  type SalesDocument,
  type SalesDocumentKind,
  type SalesDocumentStatus,
  type SellerSnapshot,
  type TotalsResult,
  type UpdateCommerceSettingsInput,
} from '@repo/contracts';

import type { Issue, Rejection } from './problems';

// Where a page is -------------------------------------------------------------------------------

/** The word a kind of document has in the address, and as its tab. */
export const kindSplat: Readonly<Record<SalesDocumentKind, string>> = {
  invoice: 'invoices',
  quote: 'quotes',
};

export type PaymentsPlace =
  | { readonly at: 'documents'; readonly kind: SalesDocumentKind }
  /** A document's own page; `id` is undefined for one being started. */
  | { readonly at: 'document'; readonly kind: SalesDocumentKind; readonly id: string | undefined }
  | { readonly at: 'receipts' }
  | { readonly at: 'receipt'; readonly id: string }
  | { readonly at: 'products' }
  | { readonly at: 'settings' }
  | { readonly at: 'nowhere' };

const NOWHERE: PaymentsPlace = { at: 'nowhere' };
const NEW = 'new';

/** The page that what follows /payments/ in the address names. */
export function placeOf(splat: string | undefined): PaymentsPlace {
  const [first = '', second, ...rest] = (splat ?? '').split('/').filter((part) => part !== '');
  if (rest.length > 0) return NOWHERE;
  const kind = first === 'invoices' ? 'invoice' : first === 'quotes' ? 'quote' : undefined;
  if (kind !== undefined) {
    if (second === undefined) return { at: 'documents', kind };
    return { at: 'document', kind, id: second === NEW ? undefined : second };
  }
  if (first === 'receipts')
    return second === undefined ? { at: 'receipts' } : { at: 'receipt', id: second };
  if (second !== undefined) return NOWHERE;
  if (first === 'products') return { at: 'products' };
  if (first === 'settings') return { at: 'settings' };
  return NOWHERE;
}

/** What follows /payments/ for a document's page, or for the page that starts one. */
export function documentSplat(kind: SalesDocumentKind, id?: string): string {
  return `${kindSplat[kind]}/${id ?? NEW}`;
}

export const receiptSplat = (id: string): string => `receipts/${id}`;

// How numbers are written ------------------------------------------------------------------------

/**
 * A decimal string with at least `least` places and no zeros it does not need after them:
 * "1500.0000" is "1500.00" with two, "2.5000" is "2.5" with none. Nothing is rounded.
 */
export function plainDecimal(value: string, least = 0): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const kept = fraction.replace(/0+$/, '').padEnd(least, '0');
  return `${negative ? '-' : ''}${whole === '' ? '0' : whole}${kept === '' ? '' : `.${kept}`}`;
}

/** The same decimal with its thousands grouped and its point as the locale writes them. */
export function localDecimal(value: string, least: number, locale: string): string {
  // What is not a number yet, as someone is still typing it, is shown as it was typed.
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const plain = plainDecimal(value, least);
  const negative = plain.startsWith('-');
  const [whole = '0', fraction] = (negative ? plain.slice(1) : plain).split('.');
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const point = format.formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.';
  const grouped = format.format(BigInt(whole));
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `${point}${fraction}`}`;
}

/** An amount of money with its currency and the currency's own decimals: "KES 1,500.00". */
export function formatMoney(amount: string, currency: string, locale: string): string {
  return `${currency} ${localDecimal(amount, currencyDigits(currency), locale)}`;
}

/** A percentage as it is read: "16.0000" is "16%". */
export function formatPercent(rate: string, locale: string): string {
  return `${localDecimal(rate, 0, locale)}%`;
}

/** A calendar date (YYYY-MM-DD) as the locale writes a day. It is no moment: no zone moves it. */
export function formatDay(date: string, locale: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

// Status chips ----------------------------------------------------------------------------------

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
/** What a document's chip says: its status, or that its day has gone by. */
export type DocumentMark = SalesDocumentStatus | 'overdue' | 'expired';

/** The chip of a quote or an invoice. Overdue and expired are read from dates, and win. */
export function documentMark(document: {
  readonly status: SalesDocumentStatus;
  readonly overdue: boolean;
  readonly expired: boolean;
}): { readonly mark: DocumentMark; readonly tone: Tone } {
  if (document.overdue) return { mark: 'overdue', tone: 'danger' };
  if (document.expired) return { mark: 'expired', tone: 'warning' };
  const tones: Readonly<Record<SalesDocumentStatus, Tone>> = {
    draft: 'neutral',
    sent: 'info',
    accepted: 'success',
    declined: 'danger',
    partly_paid: 'warning',
    paid: 'success',
    void: 'neutral',
  };
  return { mark: document.status, tone: tones[document.status] };
}

/** What each tab's list can be narrowed to, in the order its chips show. */
export const statusFilters = {
  quote: ['all', 'draft', 'sent', 'accepted', 'declined', 'expired'],
  invoice: ['all', 'draft', 'sent', 'partly_paid', 'paid', 'overdue', 'void'],
} as const satisfies Readonly<Record<SalesDocumentKind, readonly ('all' | DocumentMark)[]>>;
export type StatusFilter = (typeof statusFilters)[SalesDocumentKind][number];

// Refusals --------------------------------------------------------------------------------------

/**
 * Issues sorted for a form whose fields are nested: each under its whole path
 * ("lines/0/quantity", "numbering/quote/prefix"), the first for each, and the rest above
 * the buttons.
 */
export function deepRejection(issues: readonly Issue[]): Rejection {
  const fields: Record<string, string> = {};
  let form: string | undefined;
  for (const issue of issues) {
    const field = issue.path.replace(/^\//, '');
    if (field === '') form ??= issue.message;
    else fields[field] ??= issue.message;
  }
  return { fields, form };
}

// Products --------------------------------------------------------------------------------------

export interface ProductDraft {
  readonly kind: ProductKind;
  readonly name: string;
  readonly description: string;
  readonly sku: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly currency: string;
  readonly taxRate: string;
}

/** What the product panel starts with: the product as it is, or an empty one in the currency. */
export function productDraftOf(product: Product | undefined, currency: string): ProductDraft {
  if (product === undefined)
    return {
      kind: 'product',
      name: '',
      description: '',
      sku: '',
      unit: '',
      unitPrice: '',
      currency,
      taxRate: '',
    };
  return {
    kind: product.kind,
    name: product.name,
    description: product.description,
    sku: product.sku ?? '',
    unit: product.unit,
    unitPrice: plainDecimal(product.unitPrice, currencyDigits(product.currency)),
    currency: product.currency,
    taxRate: product.taxRate === null ? '' : plainDecimal(product.taxRate),
  };
}

/** What the panel sends. An empty code or tax rate is none; the server checks the rest. */
export function productInput(draft: ProductDraft): CreateProductInput {
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    description: draft.description.trim(),
    sku: draft.sku.trim() === '' ? null : draft.sku.trim(),
    unit: draft.unit.trim(),
    unitPrice: draft.unitPrice.trim(),
    currency: draft.currency.trim().toUpperCase(),
    taxRate: draft.taxRate.trim() === '' ? null : draft.taxRate.trim(),
  };
}

// A quote or an invoice being written -----------------------------------------------------------

export type DiscountKind = Discount['kind'];

export interface LineDraft {
  /** Tells the rows apart while they move; never sent. */
  readonly key: string;
  readonly productId: string | null;
  readonly name: string;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly discountKind: DiscountKind;
  /** Empty: no discount. */
  readonly discountValue: string;
  /** Percent. Empty: no tax. */
  readonly taxRate: string;
}

export interface DocumentDraft {
  readonly contact: { readonly id: string; readonly name: string } | null;
  readonly dealId: string | null;
  readonly currency: string;
  /** Empty: the day it is issued. */
  readonly issueDate: string;
  /** Empty: worked out when it is issued. */
  readonly dueDate: string;
  readonly lines: readonly LineDraft[];
  readonly discountKind: DiscountKind;
  readonly discountValue: string;
  readonly notes: string;
  readonly terms: string;
  readonly billTo: string;
  readonly customerTaxNumber: string;
}

const rateText = (rate: string | null): string => (rate === null ? '' : plainDecimal(rate));

/** A line with nothing on it but one of something, taxed at the business's usual rate. */
export function emptyLine(key: string, defaultTaxRate: string | null): LineDraft {
  return {
    key,
    productId: null,
    name: '',
    description: '',
    quantity: '1',
    unit: '',
    unitPrice: '',
    discountKind: 'percent',
    discountValue: '',
    taxRate: rateText(defaultTaxRate),
  };
}

/**
 * A line taken from the catalogue: one of the product at its rate. A product with no tax
 * rate of its own takes the business's. The line keeps its own copy of everything.
 */
export function lineFromProduct(
  key: string,
  product: Product,
  defaultTaxRate: string | null,
): LineDraft {
  return {
    ...emptyLine(key, product.taxRate ?? defaultTaxRate),
    productId: product.id,
    name: product.name,
    description: product.description,
    unit: product.unit,
    unitPrice: plainDecimal(product.unitPrice, currencyDigits(product.currency)),
  };
}

/** The lines with the one at `index` moved one place up (-1) or down (1), if there is room. */
export function moveLine(
  lines: readonly LineDraft[],
  index: number,
  by: -1 | 1,
): readonly LineDraft[] {
  const to = index + by;
  const moved = lines[index];
  const other = lines[to];
  if (moved === undefined || other === undefined) return lines;
  const next = [...lines];
  next[index] = other;
  next[to] = moved;
  return next;
}

/** A new draft: the business's currency, default notes and terms, and one empty line. */
export function newDraft({
  currency,
  settings,
  contact,
  dealId,
  lineKey,
}: {
  readonly currency: string;
  readonly settings: Pick<CommerceSettings, 'defaultNotes' | 'defaultTerms' | 'defaultTaxRate'>;
  readonly contact: DocumentDraft['contact'];
  readonly dealId: string | null;
  readonly lineKey: string;
}): DocumentDraft {
  return {
    contact,
    dealId,
    currency,
    issueDate: '',
    dueDate: '',
    lines: [emptyLine(lineKey, settings.defaultTaxRate)],
    discountKind: 'percent',
    discountValue: '',
    notes: settings.defaultNotes,
    terms: settings.defaultTerms,
    billTo: '',
    customerTaxNumber: '',
  };
}

const discountText = (discount: Discount | null, digits: number): string =>
  discount === null ? '' : plainDecimal(discount.value, discount.kind === 'amount' ? digits : 0);

/** A saved draft as the form holds it. */
export function draftOf(document: SalesDocument): DocumentDraft {
  const digits = currencyDigits(document.currency);
  return {
    contact:
      document.contactId === null ? null : { id: document.contactId, name: document.customer.name },
    dealId: document.dealId,
    currency: document.currency,
    issueDate: document.issueDate ?? '',
    dueDate: document.dueDate ?? '',
    lines: document.lines.map((line) => ({
      key: line.id,
      productId: line.productId,
      name: line.name,
      description: line.description,
      quantity: plainDecimal(line.quantity),
      unit: line.unit,
      unitPrice: plainDecimal(line.unitPrice, digits),
      discountKind: line.discount?.kind ?? 'percent',
      discountValue: discountText(line.discount, digits),
      taxRate: plainDecimal(line.taxRate) === '0' ? '' : plainDecimal(line.taxRate),
    })),
    discountKind: document.discount?.kind ?? 'percent',
    discountValue: discountText(document.discount, digits),
    notes: document.notes,
    terms: document.terms,
    billTo: document.customer.billTo,
    customerTaxNumber: document.customer.taxNumber ?? '',
  };
}

const discountOf = (kind: DiscountKind, value: string): Discount | null =>
  value.trim() === '' ? null : { kind, value: value.trim() };

/** A line as it is sent. A line with nothing typed on it is not a line yet. */
const lineInput = (line: LineDraft) => ({
  productId: line.productId,
  name: line.name.trim(),
  description: line.description.trim(),
  quantity: line.quantity.trim(),
  unit: line.unit.trim(),
  unitPrice: line.unitPrice.trim() === '' ? '0' : line.unitPrice.trim(),
  discount: discountOf(line.discountKind, line.discountValue),
  taxRate: line.taxRate.trim() === '' ? null : line.taxRate.trim(),
});

/** Whether nothing was written on the line: it is left out of what is worked out and sent. */
export function isBlankLine(line: LineDraft): boolean {
  return (
    line.name.trim() === '' &&
    line.description.trim() === '' &&
    line.unitPrice.trim() === '' &&
    line.discountValue.trim() === ''
  );
}

/**
 * The draft's lines as they are sent, each with its place in the form: blank ones are left
 * out, so a refusal that names "lines/1" is shown on the row it came from.
 */
export function sentLines(
  draft: DocumentDraft,
): readonly { readonly index: number; readonly input: ReturnType<typeof lineInput> }[] {
  return draft.lines.flatMap((line, index) =>
    isBlankLine(line) ? [] : [{ index, input: lineInput(line) }],
  );
}

/** The draft's totals, by the contract's arithmetic, or why its numbers cannot be. */
export function draftTotals(draft: DocumentDraft): TotalsResult {
  return computeDocumentTotals({
    currency: draft.currency,
    lines: sentLines(draft).map(({ input }) => input),
    discount: discountOf(draft.discountKind, draft.discountValue),
  });
}

/**
 * A refusal's paths, which count the lines that were sent, as paths of the form's own
 * rows: with a blank second row left out, "lines/1/quantity" is the form's third row.
 */
export function formPath(draft: DocumentDraft, path: string): string {
  const match = /^\/?lines\/(\d+)(\/.*)?$/.exec(path);
  if (match === null) return path.replace(/^\//, '');
  const sent = sentLines(draft)[Number(match[1])];
  return `lines/${String(sent?.index ?? Number(match[1]))}${match[2] ?? ''}`;
}

/** What is wrong with the draft's numbers, under the form's own fields. */
export function draftProblems(draft: DocumentDraft): Record<string, string> {
  const result = draftTotals(draft);
  if (result.ok) return {};
  const fields: Record<string, string> = {};
  for (const issue of result.issues)
    fields[formPath(draft, issue.path.map(String).join('/'))] ??= issue.message;
  return fields;
}

/** A server's refusal of a draft, under the form's own fields. */
export function draftRejection(draft: DocumentDraft, issues: readonly Issue[]): Rejection {
  return deepRejection(
    issues.map((issue) => ({ ...issue, path: `/${formPath(draft, issue.path)}` })),
  );
}

/** What a draft sends, without its kind or revision. Undefined until it is for someone. */
export function documentInput(draft: DocumentDraft):
  | {
      readonly contactId: string;
      readonly dealId: string | null;
      readonly currency: string;
      readonly issueDate: string | null;
      readonly dueDate: string | null;
      readonly lines: ReturnType<typeof lineInput>[];
      readonly discount: Discount | null;
      readonly notes: string;
      readonly terms: string;
      readonly billTo: string;
      readonly customerTaxNumber: string | null;
    }
  | undefined {
  if (draft.contact === null) return undefined;
  return {
    contactId: draft.contact.id,
    dealId: draft.dealId,
    currency: draft.currency,
    issueDate: draft.issueDate === '' ? null : draft.issueDate,
    dueDate: draft.dueDate === '' ? null : draft.dueDate,
    lines: sentLines(draft).map(({ input }) => input),
    discount: discountOf(draft.discountKind, draft.discountValue),
    notes: draft.notes.trim(),
    terms: draft.terms.trim(),
    billTo: draft.billTo.trim(),
    customerTaxNumber:
      draft.customerTaxNumber.trim() === '' ? null : draft.customerTaxNumber.trim(),
  };
}

/** Whether the form holds anything the saved draft does not. */
export function draftChanged(draft: DocumentDraft, saved: DocumentDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

/**
 * The day a document issued on `issueDate` falls due when it names none: the business's
 * payment terms for an invoice, its quote validity for a quote.
 */
export function dueDateFor(
  kind: SalesDocumentKind,
  issueDate: string,
  settings: Pick<CommerceSettings, 'paymentTermsDays' | 'quoteValidityDays'>,
): string {
  return addDays(
    issueDate,
    kind === 'invoice' ? settings.paymentTermsDays : settings.quoteValidityDays,
  );
}

// Who a document is from ------------------------------------------------------------------------

/** Who a document is from, as its paper prints it. */
export interface SellerView {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly taxNumber: string | null;
  readonly logoFileId: string | null;
  readonly paymentInstructions: string;
}

/** An address as lines of print: the street, the town with its region and code, the country. */
export function addressLines(address: BusinessProfile['address']): string[] {
  if (address === null) return [];
  const town = [address.city, address.region, address.postalCode]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(', ');
  return [address.line1, address.line2, town, address.country]
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** An issued document's seller, as it was when the document was issued. */
export function sellerOfSnapshot(seller: SellerSnapshot): SellerView {
  return {
    name: seller.name,
    addressLines: addressLines(seller.address),
    taxNumber: seller.taxNumber,
    logoFileId: seller.logoFileId,
    paymentInstructions: seller.paymentInstructions,
  };
}

/** A draft's seller: the business profile and the settings as they are now. */
export function sellerOfProfile(
  profile: Pick<BusinessProfile, 'name' | 'address' | 'logoFileId'>,
  settings: Pick<CommerceSettings, 'taxNumber' | 'paymentInstructions'>,
): SellerView {
  return {
    name: profile.name,
    addressLines: addressLines(profile.address),
    taxNumber: settings.taxNumber,
    logoFileId: profile.logoFileId,
    paymentInstructions: settings.paymentInstructions,
  };
}

// Settings --------------------------------------------------------------------------------------

export const numberedKinds = ['quote', 'invoice', 'receipt'] as const;
export type NumberedKind = (typeof numberedKinds)[number];

export interface SettingsDraft {
  readonly numbering: Readonly<
    Record<NumberedKind, { readonly prefix: string; readonly nextNumber: string }>
  >;
  readonly paymentTermsDays: string;
  readonly quoteValidityDays: string;
  readonly defaultNotes: string;
  readonly defaultTerms: string;
  readonly paymentInstructions: string;
  readonly taxNumber: string;
  readonly defaultTaxRate: string;
}

export function settingsDraftOf(settings: CommerceSettings): SettingsDraft {
  const numbering = (kind: NumberedKind) => ({
    prefix: settings.numbering[kind].prefix,
    nextNumber: String(settings.numbering[kind].nextNumber),
  });
  return {
    numbering: {
      quote: numbering('quote'),
      invoice: numbering('invoice'),
      receipt: numbering('receipt'),
    },
    paymentTermsDays: String(settings.paymentTermsDays),
    quoteValidityDays: String(settings.quoteValidityDays),
    defaultNotes: settings.defaultNotes,
    defaultTerms: settings.defaultTerms,
    paymentInstructions: settings.paymentInstructions,
    taxNumber: settings.taxNumber ?? '',
    defaultTaxRate: rateText(settings.defaultTaxRate),
  };
}

const WHOLE = /^\d{1,12}$/;
/** What was typed as a whole number, or undefined when it is not one. */
export function wholeNumber(text: string): number | undefined {
  return WHOLE.test(text.trim()) ? Number(text.trim()) : undefined;
}

/**
 * How the next number of a kind will be printed, as the settings form stands, or undefined
 * while the number typed is not one a counter can hold.
 */
export function numberExample(prefix: string, nextNumber: string): string | undefined {
  const next = wholeNumber(nextNumber);
  return next === undefined || next < 1 || next > MAX_SEQUENCE_NUMBER
    ? undefined
    : formatDocumentNumber(prefix, next);
}

/** The fields of the settings form that must hold a whole number and do not, by their paths. */
export function unwholeFields(draft: SettingsDraft): string[] {
  const fields: [string, string][] = [
    ...numberedKinds.map((kind): [string, string] => [
      `numbering/${kind}/nextNumber`,
      draft.numbering[kind].nextNumber,
    ]),
    ['paymentTermsDays', draft.paymentTermsDays],
    ['quoteValidityDays', draft.quoteValidityDays],
  ];
  return fields.filter(([, text]) => wholeNumber(text) === undefined).map(([path]) => path);
}

/**
 * What the settings form sends, once unwholeFields finds nothing: the server's own schema
 * says what else is wrong, under each field, in its own words.
 */
export function settingsInput(draft: SettingsDraft, revision: number): UpdateCommerceSettingsInput {
  const numbering = (kind: NumberedKind) => ({
    prefix: draft.numbering[kind].prefix,
    nextNumber: wholeNumber(draft.numbering[kind].nextNumber) ?? 0,
  });
  return {
    numbering: {
      quote: numbering('quote'),
      invoice: numbering('invoice'),
      receipt: numbering('receipt'),
    },
    paymentTermsDays: wholeNumber(draft.paymentTermsDays) ?? 0,
    quoteValidityDays: wholeNumber(draft.quoteValidityDays) ?? 0,
    defaultNotes: draft.defaultNotes.trim(),
    defaultTerms: draft.defaultTerms.trim(),
    paymentInstructions: draft.paymentInstructions.trim(),
    taxNumber: draft.taxNumber.trim() === '' ? null : draft.taxNumber.trim(),
    defaultTaxRate: draft.defaultTaxRate.trim() === '' ? null : draft.defaultTaxRate.trim(),
    revision,
  };
}

// Sending ---------------------------------------------------------------------------------------

/**
 * The subject the server gives an email that names none (the commerce module's
 * mail-text.ts): what is sent, its number and who it is from, on one line. In the server's
 * own words, which are not translated, so the dialog can say what will be used.
 */
export function defaultSubject(
  what: SalesDocumentKind | 'receipt',
  number: string,
  seller: string,
): string {
  // Quote, Invoice or Receipt: the server's word for it is its kind with a capital.
  const noun = `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
  return `${noun} ${number}${seller === '' ? '' : ` from ${seller}`}`
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Where a document or a receipt can be sent: the contact's own addresses, and the one the
 * dialog starts on. That is the customer's address on the document when the contact still
 * has it, else the contact's first; empty when the contact has none.
 */
export function sendAddresses(
  own: readonly string[],
  customerEmail: string | null,
): { readonly options: readonly string[]; readonly chosen: string } {
  const wanted = customerEmail?.trim().toLowerCase();
  return {
    options: own,
    chosen: own.find((each) => each.toLowerCase() === wanted) ?? own[0] ?? '',
  };
}

export interface SendDraft {
  readonly to: string;
  /** Empty: the business's default mailbox. */
  readonly mailboxId: string;
  /** Empty: the server's own subject. */
  readonly subject: string;
  /** Empty: the server's one line saying what is sent. */
  readonly message: string;
  readonly attachPdf: boolean;
}

/** What the dialog sends: what was left empty is left out, for the server to fill. */
export function sendValues(draft: SendDraft): {
  to?: string;
  mailboxId?: string;
  subject?: string;
  message?: string;
  attachPdf: boolean;
} {
  const subject = draft.subject.replaceAll(/\s+/g, ' ').trim();
  const message = draft.message.trim();
  return {
    ...(draft.to === '' ? {} : { to: draft.to }),
    ...(draft.mailboxId === '' ? {} : { mailboxId: draft.mailboxId }),
    ...(subject === '' ? {} : { subject }),
    ...(message === '' ? {} : { message }),
    attachPdf: draft.attachPdf,
  };
}

/** Why the server did not take an email, as its 422 names it. */
export const sendRefusalCodes = [
  'no_address',
  'not_contacts_address',
  'contact_inactive',
  'do_not_contact',
  'suppressed',
  'consent_withdrawn',
  'consent_required',
  'timing_unknown',
  'no_mailbox',
  'sender_inactive',
] as const;
export type SendRefusalCode = (typeof sendRefusalCodes)[number];

export const sendFields = ['to', 'mailboxId', 'subject', 'message'] as const;
export type SendField = (typeof sendFields)[number];

export interface SendRefusal {
  /** What is wrong under each box: the code when it is one the dialog has words for. */
  readonly fields: Partial<
    Readonly<
      Record<SendField, { readonly code: SendRefusalCode | undefined; readonly message: string }>
    >
  >;
  /** What is wrong with the send as a whole: the server's sentence, or the page's. */
  readonly form: string | undefined;
  /** A 409: the document changed, or cannot be sent as it stands. */
  readonly conflict: boolean;
}

export const noSendRefusal: SendRefusal = { fields: {}, form: undefined, conflict: false };

/**
 * A refused send, sorted for the dialog: a 422's issues under the box each names (the first
 * for each), and anything else, such as a 409's sentence, above the buttons.
 */
export function sendRefusal(
  problem:
    | {
        readonly status: number;
        readonly detail?: string | undefined;
        readonly errors?:
          | readonly { readonly path: string; readonly code: string; readonly message: string }[]
          | undefined;
      }
    | undefined,
  fallback: string,
): SendRefusal {
  if (problem === undefined) return { fields: {}, form: fallback, conflict: false };
  const fields: Partial<Record<SendField, { code: SendRefusalCode | undefined; message: string }>> =
    {};
  let form: string | undefined;
  for (const issue of problem.errors ?? []) {
    const named = issue.path.replace(/^\//, '').split('/')[0];
    const field = sendFields.find((each) => each === named);
    if (field === undefined) form ??= issue.message;
    else
      fields[field] ??= {
        code: sendRefusalCodes.find((each) => each === issue.code),
        message: issue.message,
      };
  }
  if (form === undefined && Object.keys(fields).length === 0) form = problem.detail ?? fallback;
  return { fields, form, conflict: problem.status === 409 };
}
