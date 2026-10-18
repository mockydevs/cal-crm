// Documents as the API returns them, for the tests of what is printed and emailed: an
// issued invoice in Kenyan shillings with a discount, two tax rates and a payment, and the
// receipt of that payment. Every amount is what the one arithmetic gives for these lines.
import type { Receipt, SalesDocument, SalesDocumentLine } from '@repo/contracts';

type Line = Partial<SalesDocumentLine> & Pick<SalesDocumentLine, 'name'>;

const lineOf = (line: Line, position: number): SalesDocumentLine => ({
  id: `sdl_01h455vb4pex5vsknk084sn0${String(position).padStart(2, '0')}`,
  position,
  productId: null,
  description: '',
  quantity: '1.0000',
  unit: '',
  unitPrice: '100.0000',
  discount: null,
  taxRate: '0.0000',
  amount: '100.0000',
  discountAmount: '0.0000',
  taxableAmount: '100.0000',
  taxAmount: '0.0000',
  total: '100.0000',
  ...line,
});

export const SELLER: NonNullable<SalesDocument['seller']> = {
  name: 'Harbor Lights Events',
  address: {
    line1: '12 Riverside Drive',
    line2: '',
    city: 'Nairobi',
    region: '',
    postalCode: '00100',
    country: 'KE',
  },
  taxNumber: 'P051234567X',
  logoFileId: null,
  paymentInstructions: 'M-Pesa paybill 522522, account HARBOR.\nOr bank: KCB 1100223344.',
};

/** An issued invoice: 3 × 333.335 less 12.5% and tax at 16%, and a second line without tax. */
export function invoice(changes: Partial<SalesDocument> = {}): SalesDocument {
  return {
    id: 'sdoc_01h455vb4pex5vsknk084sn02q',
    kind: 'invoice',
    status: 'partly_paid',
    number: 'INV-0007',
    contactId: 'con_01h455vb4pex5vsknk084sn02q',
    dealId: null,
    quoteId: null,
    invoiceId: null,
    currency: 'KES',
    issueDate: '2026-10-12',
    dueDate: '2026-10-26',
    customer: {
      name: 'Maya Thompson',
      email: 'maya@example.com',
      phone: '+254712345678',
      billTo: 'Thompson & Daughters Ltd\nPO Box 4410\nMombasa',
      taxNumber: 'A009988776B',
    },
    seller: SELLER,
    lines: [
      lineOf(
        {
          name: 'Event planning',
          description: 'Site visits, vendor calls and the run of show.',
          quantity: '3.0000',
          unit: 'hour',
          unitPrice: '333.3350',
          discount: { kind: 'percent', value: '12.5000' },
          taxRate: '16.0000',
          amount: '1000.0100',
          discountAmount: '125.0000',
          taxableAmount: '875.0100',
          taxAmount: '140.0000',
          total: '1015.0100',
        },
        0,
      ),
      lineOf(
        {
          name: 'Venue deposit',
          amount: '5000.0000',
          unitPrice: '5000.0000',
          taxableAmount: '5000.0000',
          total: '5000.0000',
        },
        1,
      ),
    ],
    discount: null,
    notes: 'Thank you for choosing us.',
    terms: 'Payment within 14 days.',
    internalNote: 'Chase on the 20th. Margin is thin.',
    totals: {
      subtotal: '6000.0100',
      lineDiscountTotal: '125.0000',
      documentDiscount: '0.0000',
      discountTotal: '125.0000',
      taxes: [
        { rate: '0.0000', taxable: '5000.0000', tax: '0.0000' },
        { rate: '16.0000', taxable: '875.0100', tax: '140.0000' },
      ],
      taxTotal: '140.0000',
      total: '6015.0100',
      amountPaid: '2000.0000',
      balanceDue: '4015.0100',
    },
    overdue: false,
    expired: false,
    issuedAt: '2026-10-12T09:30:00.000Z',
    acceptedAt: null,
    declinedAt: null,
    voidedAt: null,
    voidReason: null,
    sentAt: null,
    lastSentAt: null,
    sendCount: 0,
    publicLink: null,
    payments: [],
    actions: ['revise', 'record_payment', 'duplicate'],
    revision: 3,
    canManage: true,
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:30:00.000Z',
    ...changes,
  };
}

/** A sent quote of one line, open for an answer. */
export function quote(changes: Partial<SalesDocument> = {}): SalesDocument {
  return invoice({
    id: 'sdoc_01h455vb4pex5vsknk084sn03q',
    kind: 'quote',
    status: 'sent',
    number: 'QUO-0003',
    dueDate: '2026-11-11',
    lines: [
      lineOf(
        {
          name: 'Wedding day coordination',
          amount: '1500.0000',
          unitPrice: '1500.0000',
          taxableAmount: '1500.0000',
          total: '1500.0000',
        },
        0,
      ),
    ],
    totals: {
      subtotal: '1500.0000',
      lineDiscountTotal: '0.0000',
      documentDiscount: '0.0000',
      discountTotal: '0.0000',
      taxes: [{ rate: '0.0000', taxable: '1500.0000', tax: '0.0000' }],
      taxTotal: '0.0000',
      total: '1500.0000',
      amountPaid: '0.0000',
      balanceDue: '1500.0000',
    },
    actions: ['revise', 'accept', 'decline', 'convert', 'duplicate'],
    ...changes,
  });
}

/** The receipt of 2,000.00 paid by mobile money against the invoice above. */
export function receipt(changes: Partial<Receipt> = {}): Receipt {
  return {
    id: 'pay_01h455vb4pex5vsknk084sn02q',
    number: 'RCT-0003',
    invoiceId: 'sdoc_01h455vb4pex5vsknk084sn02q',
    invoiceNumber: 'INV-0007',
    contactId: 'con_01h455vb4pex5vsknk084sn02q',
    customerName: 'Maya Thompson',
    amount: '2000.0000',
    currency: 'KES',
    paidOn: '2026-10-13',
    method: 'mobile_money',
    reference: 'SJK4H7T2QW',
    note: '',
    balanceAfter: '4015.0100',
    status: 'recorded',
    reversedAt: null,
    reversalReason: null,
    lastSentAt: null,
    sendCount: 0,
    createdAt: '2026-10-13T08:00:00.000Z',
    seller: SELLER,
    customer: invoice().customer,
    invoice: {
      id: 'sdoc_01h455vb4pex5vsknk084sn02q',
      number: 'INV-0007',
      status: 'partly_paid',
      issueDate: '2026-10-12',
      dueDate: '2026-10-26',
      total: '6015.0100',
      amountPaid: '2000.0000',
      balanceDue: '4015.0100',
    },
    canManage: true,
    ...changes,
  };
}

/** A one-pixel PNG: the smallest logo a PDF embeds. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Many lines, so the table runs over several pages. */
export function manyLines(count: number): SalesDocument['lines'] {
  return Array.from({ length: count }, (_, index) =>
    lineOf({ name: `Line ${String(index + 1)} of the long list` }, index),
  );
}
