// What a quote, an invoice or a receipt says when it is printed: one plain description of
// the page, made from the document as the API returns it and nothing else. The PDF
// (print-pdf.ts) and the public page (print-html.ts) both draw this, so the two always say
// the same thing. Every amount is the stored string, printed by the contract's own helpers:
// nothing here does arithmetic, and nothing is a float.
import {
  formatDecimal,
  formatMoney,
  currencyDigits,
  printedFileName,
  toUnits,
  type Receipt,
  type SalesDocument,
  type SellerSnapshot,
} from '@repo/contracts';

/** A label and its value, such as "Due date" and "26 Oct 2026". */
export interface PrintedFact {
  readonly label: string;
  readonly value: string;
}

export interface PrintedLine {
  readonly name: string;
  /** The line's longer text, under its name. Empty when it has none. */
  readonly description: string;
  readonly quantity: string;
  readonly rate: string;
  readonly discount: string;
  readonly tax: string;
  readonly amount: string;
}

export interface PrintedTotal extends PrintedFact {
  /** The lines a reader looks for first: the total, the balance, the amount received. */
  readonly strong: boolean;
}

export interface Printed {
  /** Quote, Invoice or Receipt. */
  readonly title: string;
  /** Its number, or null on a draft that never had one. */
  readonly number: string | null;
  /** Printed large across the page: DRAFT, VOID or REVERSED. Null on a document in force. */
  readonly mark: 'DRAFT' | 'VOID' | 'REVERSED' | null;
  readonly seller: { readonly name: string; readonly lines: readonly string[] };
  readonly customer: {
    readonly heading: string;
    readonly name: string;
    readonly lines: readonly string[];
  };
  readonly facts: readonly PrintedFact[];
  /** The lines of a quote or an invoice; a receipt has none. */
  readonly lines: readonly PrintedLine[];
  /** The headings of the lines' columns, the last four naming the currency once. */
  readonly columns: readonly [string, string, string, string, string, string];
  readonly totals: readonly PrintedTotal[];
  /** Notes, terms and how to pay, each left out when it is empty. */
  readonly sections: readonly { readonly heading: string; readonly text: string }[];
  /** INV-0007.pdf. */
  readonly fileName: string;
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A calendar date as a document prints it: 26 Oct 2026. Never through a time zone. */
export function printedDate(date: string): string {
  return DAY.format(new Date(`${date}T00:00:00Z`));
}

const COUNTRY = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });

/** A business's address, a line for each part it has. */
function addressLines(address: SellerSnapshot['address']): string[] {
  if (address === null) return [];
  const place = [address.city, [address.region, address.postalCode].filter(Boolean).join(' ')]
    .filter((part) => part !== '')
    .join(', ');
  return [
    address.line1,
    address.line2,
    place,
    address.country === '' ? '' : (COUNTRY.of(address.country) ?? address.country),
  ].filter((line) => line !== '');
}

const sellerOf = (seller: SellerSnapshot): Printed['seller'] => ({
  name: seller.name,
  lines: [
    ...addressLines(seller.address),
    ...(seller.taxNumber === null ? [] : [`Tax number: ${seller.taxNumber}`]),
  ],
});

/** Text as its lines, without the empty ones: a billing address is typed as it is printed. */
const linesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

function customerOf(heading: string, customer: SalesDocument['customer']): Printed['customer'] {
  return {
    heading,
    name: customer.name,
    lines: [
      ...linesOf(customer.billTo),
      ...(customer.email === null ? [] : [customer.email]),
      ...(customer.phone === null ? [] : [customer.phone]),
      ...(customer.taxNumber === null ? [] : [`Tax number: ${customer.taxNumber}`]),
    ],
  };
}

const isZero = (amount: string): boolean => toUnits(amount) === 0n;
const percent = (rate: string): string => `${formatDecimal(rate)}%`;

const sectionsOf = (sections: readonly (readonly [string, string])[]): Printed['sections'] =>
  sections
    .filter(([, text]) => text.trim() !== '')
    .map(([heading, text]) => ({ heading, text: text.trim() }));

const METHODS: Readonly<Record<Receipt['method'], string>> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  mobile_money: 'Mobile money',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};

/**
 * A quote or an invoice as it is printed. A draft has no seller written down yet, so the
 * caller hands over the business as it is now (`sellerNow`), and the page is marked DRAFT.
 */
export function printedDocument(document: SalesDocument, sellerNow?: SellerSnapshot): Printed {
  const { currency, totals } = document;
  const digits = currencyDigits(currency);
  const money = (amount: string) => formatMoney(amount, currency);
  const plain = (amount: string) => formatDecimal(amount, digits);
  const quote = document.kind === 'quote';
  const seller = document.seller ??
    sellerNow ?? {
      name: '',
      address: null,
      taxNumber: null,
      logoFileId: null,
      paymentInstructions: '',
    };
  const facts: PrintedFact[] = [];
  if (document.issueDate !== null)
    facts.push({ label: 'Issue date', value: printedDate(document.issueDate) });
  if (document.dueDate !== null)
    facts.push({
      label: quote ? 'Valid until' : 'Due date',
      value: printedDate(document.dueDate),
    });
  if (document.status === 'accepted') facts.push({ label: 'Status', value: 'Accepted' });
  if (document.status === 'declined') facts.push({ label: 'Status', value: 'Declined' });
  if (document.status === 'paid') facts.push({ label: 'Status', value: 'Paid' });
  if (document.status === 'partly_paid') facts.push({ label: 'Status', value: 'Partly paid' });

  const taxed = totals.taxes.filter((each) => !isZero(each.tax) || !isZero(each.rate));
  const rows: PrintedTotal[] = [
    { label: 'Subtotal', value: money(totals.subtotal), strong: false },
    ...(isZero(totals.lineDiscountTotal)
      ? []
      : [
          {
            label: 'Line discounts',
            value: `-${money(totals.lineDiscountTotal)}`,
            strong: false,
          },
        ]),
    ...(isZero(totals.documentDiscount)
      ? []
      : [
          {
            label:
              document.discount?.kind === 'percent'
                ? `Discount (${percent(document.discount.value)})`
                : 'Discount',
            value: `-${money(totals.documentDiscount)}`,
            strong: false,
          },
        ]),
    ...taxed.map((each) => ({
      label: `Tax ${percent(each.rate)} on ${plain(each.taxable)}`,
      value: money(each.tax),
      strong: false,
    })),
    { label: 'Total', value: money(totals.total), strong: true },
    // Only an invoice is paid; a draft and a void one owe nothing yet or any more.
    ...(quote || document.status === 'draft' || document.status === 'void'
      ? []
      : [
          ...(isZero(totals.amountPaid)
            ? []
            : [{ label: 'Paid', value: `-${money(totals.amountPaid)}`, strong: false }]),
          { label: 'Balance due', value: money(totals.balanceDue), strong: true },
        ]),
  ];

  return {
    title: quote ? 'Quote' : 'Invoice',
    number: document.number,
    mark: document.status === 'draft' ? 'DRAFT' : document.status === 'void' ? 'VOID' : null,
    seller: sellerOf(seller),
    customer: customerOf(quote ? 'Prepared for' : 'Bill to', document.customer),
    facts,
    columns: [
      'Description',
      'Quantity',
      `Rate (${currency})`,
      `Discount (${currency})`,
      'Tax',
      `Amount (${currency})`,
    ],
    lines: document.lines.map((line) => ({
      name: line.name,
      description: line.description,
      quantity: [formatDecimal(line.quantity), line.unit].filter((part) => part !== '').join(' '),
      rate: plain(line.unitPrice),
      discount: isZero(line.discountAmount) ? '' : plain(line.discountAmount),
      tax: isZero(line.taxRate) ? '' : percent(line.taxRate),
      amount: plain(line.amount),
    })),
    totals: rows,
    sections: sectionsOf([
      ['Notes', document.notes],
      // How to pay is an invoice's: a quote asks for no money yet.
      ['How to pay', quote ? '' : seller.paymentInstructions],
      ['Terms', document.terms],
    ]),
    fileName: printedFileName(document.number, quote ? 'quote-draft' : 'invoice-draft'),
  };
}

/** A payment as its receipt is printed. */
export function printedReceipt(receipt: Receipt): Printed {
  const money = (amount: string) => formatMoney(amount, receipt.currency);
  return {
    title: 'Receipt',
    number: receipt.number,
    mark: receipt.status === 'reversed' ? 'REVERSED' : null,
    seller: sellerOf(receipt.seller),
    customer: customerOf('Received from', receipt.customer),
    facts: [
      { label: 'Date', value: printedDate(receipt.paidOn) },
      { label: 'Method', value: METHODS[receipt.method] },
      ...(receipt.reference === null ? [] : [{ label: 'Reference', value: receipt.reference }]),
      { label: 'Invoice', value: receipt.invoiceNumber },
    ],
    columns: ['', '', '', '', '', ''],
    lines: [],
    totals: [
      { label: 'Amount received', value: money(receipt.amount), strong: true },
      { label: 'Invoice total', value: money(receipt.invoice.total), strong: false },
      {
        label: 'Balance after this payment',
        value: money(receipt.balanceAfter),
        strong: false,
      },
    ],
    sections: sectionsOf([
      [
        'Reversed',
        receipt.status === 'reversed'
          ? `This payment was reversed${receipt.reversalReason === null ? '.' : `: ${receipt.reversalReason}`}`
          : '',
      ],
    ]),
    fileName: printedFileName(receipt.number, 'receipt'),
  };
}
