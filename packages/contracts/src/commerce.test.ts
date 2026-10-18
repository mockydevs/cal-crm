import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  commerceEndpoints,
  commerceSettings,
  createProductInput,
  createSalesDocumentInput,
  listProductsQuery,
  listSalesDocumentsQuery,
  payment,
  product,
  receipt,
  recordPaymentInput,
  reversePaymentInput,
  salesDocument,
  updateCommerceSettingsInput,
  updateProductInput,
  updateSalesDocumentInput,
  voidInvoiceInput,
} from './commerce.js';
import { parseInput } from './validation.js';
import { ValidationError } from '@repo/kernel';

const CONTACT = 'con_01h455vb4pex5vsknk084sn02q';
const DEAL = 'deal_01h455vb4pex5vsknk084sn02q';
const PRODUCT = 'prod_01h455vb4pex5vsknk084sn02q';
const DOCUMENT = 'sdoc_01h455vb4pex5vsknk084sn02q';
const LINE = 'sdl_01h455vb4pex5vsknk084sn02q';
const PAYMENT = 'pay_01h455vb4pex5vsknk084sn02q';
const NOW = '2026-10-12T09:30:00.000Z';

const line = (change: Record<string, unknown> = {}) => ({
  name: 'Event planning',
  quantity: '2',
  unitPrice: '1500',
  ...change,
});
const values = (change: Record<string, unknown> = {}) => ({
  contactId: CONTACT,
  currency: 'KES',
  lines: [line()],
  ...change,
});
const draft = (change: Record<string, unknown> = {}) => values({ kind: 'invoice', ...change });
const issuesOf = (work: () => unknown): string[] => {
  try {
    work();
  } catch (error) {
    if (error instanceof ValidationError)
      return error.issues.map((issue) => `${issue.path}:${issue.code}`);
    throw error;
  }
  throw new Error('Nothing was refused.');
};

describe('the commerce endpoints', () => {
  it('are all part of the API, each once, under their own paths', () => {
    expect(commerceEndpoints.map((endpoint) => endpoint.operationId)).toEqual([
      'listProducts',
      'createProduct',
      'getProduct',
      'updateProduct',
      'archiveProduct',
      'restoreProduct',
      'deleteProduct',
      'listSalesDocuments',
      'createSalesDocument',
      'getSalesDocument',
      'updateSalesDocument',
      'deleteSalesDocument',
      'issueSalesDocument',
      'reviseSalesDocument',
      'acceptQuote',
      'declineQuote',
      'convertQuoteToInvoice',
      'voidInvoice',
      'duplicateSalesDocument',
      'setSalesDocumentNote',
      'listPayments',
      'recordPayment',
      'getReceipt',
      'reversePayment',
      'getCommerceSettings',
      'updateCommerceSettings',
      // Stage 2: printing, sharing and sending.
      'getSalesDocumentPdf',
      'getReceiptPdf',
      'createSalesDocumentLink',
      'sendSalesDocument',
      'sendReceipt',
    ]);
    for (const endpoint of commerceEndpoints)
      expect(endpoints.filter((each) => each.operationId === endpoint.operationId)).toEqual([
        endpoint,
      ]);
    const routes = endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    for (const endpoint of commerceEndpoints)
      expect(
        routes.filter((route) => route === `${endpoint.method} ${endpoint.path}`),
      ).toHaveLength(1);
  });
});

describe('a product', () => {
  it('needs a kind, a name, a price and a currency; the rest has defaults', () => {
    expect(
      parseInput(createProductInput, {
        kind: 'service',
        name: '  Event planning ',
        unitPrice: '1500.50',
        currency: 'KES',
      }),
    ).toEqual({
      kind: 'service',
      name: 'Event planning',
      description: '',
      sku: null,
      unit: '',
      unitPrice: '1500.50',
      currency: 'KES',
      taxRate: null,
    });
  });

  it('refuses a negative or float-like price, an unknown currency, a rate above 100 and an empty code', () => {
    const base = { kind: 'product', name: 'Chair', unitPrice: '10', currency: 'KES' };
    expect(issuesOf(() => parseInput(createProductInput, { ...base, unitPrice: '-1' }))).toEqual([
      '/unitPrice:custom',
    ]);
    expect(issuesOf(() => parseInput(createProductInput, { ...base, unitPrice: 10 }))).toEqual([
      '/unitPrice:invalid_type',
    ]);
    expect(
      issuesOf(() => parseInput(createProductInput, { ...base, unitPrice: '1.00001' })),
    ).toEqual(['/unitPrice:custom']);
    expect(issuesOf(() => parseInput(createProductInput, { ...base, currency: 'KSH' }))).toEqual([
      '/currency:custom',
    ]);
    expect(issuesOf(() => parseInput(createProductInput, { ...base, taxRate: '100.01' }))).toEqual([
      '/taxRate:custom',
    ]);
    expect(issuesOf(() => parseInput(createProductInput, { ...base, sku: '  ' }))).toEqual([
      '/sku:too_small',
    ]);
    expect(issuesOf(() => parseInput(createProductInput, { ...base, kind: 'bundle' }))).toEqual([
      '/kind:invalid_value',
    ]);
    expect(issuesOf(() => parseInput(updateProductInput, base))).toEqual([
      '/revision:invalid_type',
    ]);
  });

  it('is listed by name, in use unless asked for the archive', () => {
    expect(parseInput(listProductsQuery, {})).toEqual({ archived: 'false', limit: 50 });
    expect(parseInput(listProductsQuery, { q: ' plan ', kind: 'service', limit: '10' })).toEqual({
      q: 'plan',
      kind: 'service',
      archived: 'false',
      limit: 10,
    });
    expect(issuesOf(() => parseInput(listProductsQuery, { limit: '201' }))).toEqual([
      '/limit:too_big',
    ]);
  });

  it('is returned with its rate to four places and whether a document uses it', () => {
    expect(
      product.parse({
        id: PRODUCT,
        kind: 'service',
        name: 'Event planning',
        description: '',
        sku: 'PLAN-01',
        unit: 'hour',
        unitPrice: '1500.5000',
        currency: 'KES',
        taxRate: '16.0000',
        archived: false,
        archivedAt: null,
        used: true,
        revision: 1,
        canManage: true,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ id: PRODUCT, unitPrice: '1500.5000', used: true });
  });
});

describe('a quote or an invoice as it is written', () => {
  it('fills in what a draft leaves out, and leaves notes and terms to the server', () => {
    expect(parseInput(createSalesDocumentInput, draft())).toEqual({
      kind: 'invoice',
      contactId: CONTACT,
      dealId: null,
      currency: 'KES',
      issueDate: null,
      dueDate: null,
      lines: [
        {
          productId: null,
          name: 'Event planning',
          description: '',
          quantity: '2',
          unit: '',
          unitPrice: '1500',
          discount: null,
          taxRate: null,
        },
      ],
      discount: null,
      billTo: '',
      customerTaxNumber: null,
    });
  });

  it('may be a draft with no lines yet, a deal, dates and every kind of discount', () => {
    expect(parseInput(createSalesDocumentInput, draft({ kind: 'quote', lines: [] })).lines).toEqual(
      [],
    );
    const full = parseInput(
      updateSalesDocumentInput,
      values({
        dealId: DEAL,
        issueDate: '2026-10-12',
        dueDate: '2026-10-26',
        lines: [
          line({
            productId: PRODUCT,
            unit: 'hour',
            discount: { kind: 'percent', value: '10' },
            taxRate: '16',
          }),
        ],
        discount: { kind: 'amount', value: '100' },
        notes: ' Thank you. ',
        terms: '',
        billTo: 'PO Box 1, Nairobi',
        customerTaxNumber: 'P051234567X',
        revision: 3,
      }),
    );
    expect(full).toMatchObject({
      dealId: DEAL,
      discount: { kind: 'amount', value: '100' },
      notes: 'Thank you.',
      terms: '',
      revision: 3,
    });
  });

  it('refuses numbers that cannot be, each where it was typed', () => {
    const refused = (lines: unknown[], more: Record<string, unknown> = {}) =>
      issuesOf(() => parseInput(createSalesDocumentInput, draft({ lines, ...more })));
    // The arithmetic's own refusals, under its codes: it is the one judge of these numbers.
    expect(refused([line({ quantity: '0' })])).toEqual(['/lines/0/quantity:invalid_quantity']);
    expect(refused([line({ unitPrice: '-5' })])).toEqual(['/lines/0/unitPrice:invalid_price']);
    expect(refused([line(), line({ quantity: '1.00001' })])).toEqual([
      '/lines/1/quantity:invalid_quantity',
    ]);
    expect(refused([line({ quantity: 2 })])).toEqual(['/lines/0/quantity:invalid_type']);
    expect(refused([line({ discount: { kind: 'amount', value: '3000.01' } })])).toEqual([
      '/lines/0/discount/value:discount_too_large',
    ]);
    expect(refused([line({ discount: { kind: 'percent', value: '101' } })])).toEqual([
      '/lines/0/discount/value:discount_too_large',
    ]);
    expect(refused([line({ discount: { kind: 'amount', value: '0.005' } })])).toEqual([
      '/lines/0/discount/value:amount_precision',
    ]);
    expect(refused([line()], { discount: { kind: 'amount', value: '3000.01' } })).toEqual([
      '/discount/value:discount_too_large',
    ]);
    expect(refused([line({ taxRate: '100.5' })])).toEqual(['/lines/0/taxRate:invalid_tax_rate']);
    expect(refused([line({ name: ' ' })])).toEqual(['/lines/0/name:too_small']);
    expect(refused(Array.from({ length: 201 }, () => line()))).toEqual(['/lines:too_big']);
  });

  it('refuses a document without a contact, with an unknown kind, or with a date that is none', () => {
    expect(
      issuesOf(() => parseInput(createSalesDocumentInput, draft({ contactId: undefined }))),
    ).toEqual(['/contactId:invalid_type']);
    expect(
      issuesOf(() => parseInput(createSalesDocumentInput, draft({ contactId: DEAL }))),
    ).toEqual(['/contactId:invalid_format']);
    expect(
      issuesOf(() => parseInput(createSalesDocumentInput, draft({ kind: 'receipt' }))),
    ).toEqual(['/kind:invalid_value']);
    expect(
      issuesOf(() => parseInput(createSalesDocumentInput, draft({ dueDate: '2026-02-30' }))),
    ).toEqual(['/dueDate:invalid_format']);
    expect(issuesOf(() => parseInput(updateSalesDocumentInput, values()))).toEqual([
      '/revision:invalid_type',
    ]);
    // An edit cannot change what kind of document it is.
    expect(
      issuesOf(() => parseInput(updateSalesDocumentInput, { ...draft(), revision: 1 })),
    ).toEqual(['/kind:unrecognized_keys']);
  });

  it('is listed newest first, both kinds unless one is named, by any status or lateness', () => {
    expect(parseInput(listSalesDocumentsQuery, {})).toEqual({ status: 'all', limit: 50 });
    expect(
      parseInput(listSalesDocumentsQuery, {
        kind: 'invoice',
        status: 'overdue',
        contactId: CONTACT,
        q: ' INV-00 ',
        issuedFrom: '2026-10-01',
        issuedTo: '2026-10-31',
      }),
    ).toMatchObject({ kind: 'invoice', status: 'overdue', q: 'INV-00', issuedTo: '2026-10-31' });
    expect(issuesOf(() => parseInput(listSalesDocumentsQuery, { status: 'late' }))).toEqual([
      '/status:invalid_value',
    ]);
  });
});

const seller = {
  name: 'Harbor Lights Events',
  address: {
    line1: '1 Quay Road',
    line2: '',
    city: 'Mombasa',
    region: '',
    postalCode: '80100',
    country: 'KE',
  },
  taxNumber: 'P051234567X',
  logoFileId: null,
  paymentInstructions: 'M-Pesa till 123456',
};
const customer = {
  name: 'Maya Thompson',
  email: 'maya@example.com',
  phone: '+254712345678',
  billTo: '',
  taxNumber: null,
};
const paid = {
  id: PAYMENT,
  number: 'RCT-0001',
  invoiceId: DOCUMENT,
  invoiceNumber: 'INV-0001',
  contactId: CONTACT,
  customerName: 'Maya Thompson',
  amount: '1000.0000',
  currency: 'KES',
  paidOn: '2026-10-12',
  method: 'mobile_money',
  reference: 'QJK2XY7Z9A',
  note: '',
  balanceAfter: '2480.0000',
  status: 'recorded',
  reversedAt: null,
  reversalReason: null,
  createdAt: NOW,
};

describe('a quote or an invoice as it is read', () => {
  it('carries its lines, totals, snapshots, payments and what it allows', () => {
    const read = salesDocument.parse({
      id: DOCUMENT,
      kind: 'invoice',
      status: 'partly_paid',
      number: 'INV-0001',
      contactId: CONTACT,
      dealId: null,
      quoteId: null,
      invoiceId: null,
      currency: 'KES',
      issueDate: '2026-10-12',
      dueDate: '2026-10-26',
      customer,
      seller,
      lines: [
        {
          id: LINE,
          position: 0,
          productId: null,
          name: 'Event planning',
          description: '',
          quantity: '2.0000',
          unit: 'hour',
          unitPrice: '1500.0000',
          discount: null,
          taxRate: '16.0000',
          amount: '3000.0000',
          discountAmount: '0.0000',
          taxableAmount: '3000.0000',
          taxAmount: '480.0000',
          total: '3480.0000',
        },
      ],
      discount: null,
      notes: '',
      terms: '',
      internalNote: '',
      totals: {
        subtotal: '3000.0000',
        lineDiscountTotal: '0.0000',
        documentDiscount: '0.0000',
        discountTotal: '0.0000',
        taxes: [{ rate: '16.0000', taxable: '3000.0000', tax: '480.0000' }],
        taxTotal: '480.0000',
        total: '3480.0000',
        amountPaid: '1000.0000',
        balanceDue: '2480.0000',
      },
      overdue: false,
      expired: false,
      issuedAt: NOW,
      acceptedAt: null,
      declinedAt: null,
      voidedAt: null,
      voidReason: null,
      payments: [paid],
      actions: ['record_payment', 'duplicate'],
      revision: 4,
      canManage: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(read.totals.balanceDue).toBe('2480.0000');
    expect(read.payments[0]?.number).toBe('RCT-0001');
    expect(() => salesDocument.parse({ ...read, status: 'overdue' })).toThrow();
    expect(() => salesDocument.parse({ ...read, actions: ['pay'] })).toThrow();
  });
});

describe('a payment', () => {
  it('needs an amount above zero and a method; the day defaults on the server', () => {
    expect(parseInput(recordPaymentInput, { amount: '1000', method: 'mobile_money' })).toEqual({
      amount: '1000',
      method: 'mobile_money',
      reference: null,
      note: '',
    });
    expect(
      parseInput(recordPaymentInput, {
        amount: '0.01',
        method: 'cheque',
        paidOn: '2026-10-10',
        reference: ' 000123 ',
        note: ' Deposit ',
      }),
    ).toEqual({
      amount: '0.01',
      method: 'cheque',
      paidOn: '2026-10-10',
      reference: '000123',
      note: 'Deposit',
    });
    expect(issuesOf(() => parseInput(recordPaymentInput, { amount: '0', method: 'cash' }))).toEqual(
      ['/amount:custom'],
    );
    expect(
      issuesOf(() => parseInput(recordPaymentInput, { amount: '-5', method: 'cash' })),
    ).toEqual(['/amount:custom']);
    expect(
      issuesOf(() => parseInput(recordPaymentInput, { amount: '5', method: 'crypto' })),
    ).toEqual(['/method:invalid_value']);
    // Nothing lets a caller ask for an overpayment.
    expect(
      issuesOf(() =>
        parseInput(recordPaymentInput, { amount: '5', method: 'cash', allowOverpayment: true }),
      ),
    ).toEqual(['/allowOverpayment:unrecognized_keys']);
  });

  it('is reversed, and an invoice voided, only with a reason', () => {
    expect(parseInput(reversePaymentInput, { reason: ' Entered twice ' })).toEqual({
      reason: 'Entered twice',
    });
    expect(issuesOf(() => parseInput(reversePaymentInput, { reason: ' ' }))).toEqual([
      '/reason:too_small',
    ]);
    expect(issuesOf(() => parseInput(voidInvoiceInput, {}))).toEqual(['/reason:invalid_type']);
    expect(issuesOf(() => parseInput(voidInvoiceInput, { reason: 'x'.repeat(501) }))).toEqual([
      '/reason:too_big',
    ]);
  });

  it('is read as a receipt with who it is from and for and where the invoice stands', () => {
    expect(payment.parse(paid).balanceAfter).toBe('2480.0000');
    const read = receipt.parse({
      ...paid,
      seller,
      customer,
      invoice: {
        id: DOCUMENT,
        number: 'INV-0001',
        status: 'partly_paid',
        issueDate: '2026-10-12',
        dueDate: '2026-10-26',
        total: '3480.0000',
        amountPaid: '1000.0000',
        balanceDue: '2480.0000',
      },
      canManage: false,
    });
    expect(read.seller.paymentInstructions).toBe('M-Pesa till 123456');
    expect(() => receipt.parse({ ...read, seller: null })).toThrow();
  });
});

describe('the settings', () => {
  const numbering = (prefix: string, more: Record<string, unknown> = {}) => ({ prefix, ...more });
  const values = {
    numbering: {
      quote: numbering('QUO-'),
      invoice: numbering('INV-', { nextNumber: 120 }),
      receipt: numbering(''),
    },
    paymentTermsDays: 14,
    quoteValidityDays: 30,
    defaultNotes: ' Thank you for your business. ',
    defaultTerms: '',
    paymentInstructions: 'M-Pesa till 123456',
    taxNumber: null,
    defaultTaxRate: '16',
    revision: 1,
  };

  it('take a prefix for each kind of number and, when moving it, the next number', () => {
    expect(parseInput(updateCommerceSettingsInput, values)).toMatchObject({
      numbering: { quote: { prefix: 'QUO-' }, invoice: { prefix: 'INV-', nextNumber: 120 } },
      defaultNotes: 'Thank you for your business.',
      defaultTaxRate: '16',
    });
  });

  it('refuse a prefix with other characters, a next number below one and terms out of range', () => {
    const refused = (change: Record<string, unknown>) =>
      issuesOf(() => parseInput(updateCommerceSettingsInput, { ...values, ...change }));
    expect(refused({ numbering: { ...values.numbering, quote: numbering('QUO #') } })).toEqual([
      '/numbering/quote/prefix:invalid_format',
    ]);
    expect(
      refused({ numbering: { ...values.numbering, quote: numbering('QUOTATION-NO-') } }),
    ).toEqual(['/numbering/quote/prefix:too_big']);
    expect(
      refused({ numbering: { ...values.numbering, receipt: numbering('R', { nextNumber: 0 }) } }),
    ).toEqual(['/numbering/receipt/nextNumber:too_small']);
    expect(refused({ paymentTermsDays: 366 })).toEqual(['/paymentTermsDays:too_big']);
    expect(refused({ quoteValidityDays: 0 })).toEqual(['/quoteValidityDays:too_small']);
    expect(refused({ defaultTaxRate: '120' })).toEqual(['/defaultTaxRate:custom']);
    expect(refused({ taxNumber: '' })).toEqual(['/taxNumber:too_small']);
  });

  it('are read with each counter, the last number given out and how the next will look', () => {
    const counter = (prefix: string, next: number) => ({
      prefix,
      nextNumber: next,
      lastNumber: next - 1,
      example: `${prefix}${String(next).padStart(4, '0')}`,
    });
    const read = commerceSettings.parse({
      ...values,
      numbering: {
        quote: counter('QUO-', 1),
        invoice: counter('INV-', 120),
        receipt: counter('RCT-', 8),
      },
      defaultTaxRate: '16.0000',
      canManage: true,
    });
    expect(read.numbering.invoice).toEqual({
      prefix: 'INV-',
      nextNumber: 120,
      lastNumber: 119,
      example: 'INV-0120',
    });
  });
});
