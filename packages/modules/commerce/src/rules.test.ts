import { computeDocumentTotals, MAX_SEQUENCE_NUMBER } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  dueBeforeIssue,
  fourPlaces,
  invoiceStatusOf,
  issueDates,
  kindOf,
  likePattern,
  lineTotal,
  methodOf,
  nextNumberRefusal,
  numbersLeft,
  paidAfter,
  pricedLines,
  receiptSeller,
  sellerOf,
  shownTotals,
  statusOf,
  storedSeller,
} from './rules.js';

describe('searching', () => {
  it('finds the text anywhere, whatever its capitals, and takes its wildcards as letters', () => {
    expect(likePattern('Plan')).toBe('%plan%');
    expect(likePattern('50%_off\\')).toBe(String.raw`%50\%\_off\\%`);
  });
});

describe('the dates a document is issued with', () => {
  const terms = { paymentTermsDays: 14, quoteValidityDays: 30 };

  it('are today and the payment terms after it for an invoice that names none', () => {
    expect(issueDates('invoice', { issueDate: null, dueDate: null }, '2026-10-12', terms)).toEqual({
      issueDate: '2026-10-12',
      dueDate: '2026-10-26',
    });
  });

  it('are today and the quote validity after it for a quote that names none', () => {
    expect(issueDates('quote', { issueDate: null, dueDate: null }, '2026-10-12', terms)).toEqual({
      issueDate: '2026-10-12',
      dueDate: '2026-11-11',
    });
  });

  it('are the ones the document names, and the terms count from its own issue date', () => {
    expect(
      issueDates('invoice', { issueDate: '2026-01-31', dueDate: null }, '2026-10-12', terms),
    ).toEqual({ issueDate: '2026-01-31', dueDate: '2026-02-14' });
    expect(
      issueDates('quote', { issueDate: null, dueDate: '2026-12-01' }, '2026-10-12', terms),
    ).toEqual({ issueDate: '2026-10-12', dueDate: '2026-12-01' });
    // Due on receipt.
    expect(
      issueDates('invoice', { issueDate: null, dueDate: null }, '2026-10-12', {
        ...terms,
        paymentTermsDays: 0,
      }),
    ).toEqual({ issueDate: '2026-10-12', dueDate: '2026-10-12' });
  });

  it('cannot have the due date before the issue date, when both are named', () => {
    expect(dueBeforeIssue('2026-10-12', '2026-10-11')).toBe(true);
    expect(dueBeforeIssue('2026-10-12', '2026-10-12')).toBe(false);
    expect(dueBeforeIssue(null, '2026-10-11')).toBe(false);
    expect(dueBeforeIssue('2026-10-12', null)).toBe(false);
  });
});

describe('the totals shown', () => {
  it('are the stored amounts, with the discounts and each rate’s tax summed from the lines', () => {
    // What the arithmetic returns for two lines at two rates with both kinds of discount.
    const computed = computeDocumentTotals({
      currency: 'KES',
      lines: [
        {
          quantity: '2',
          unitPrice: '1500',
          discount: { kind: 'percent', value: '10' },
          taxRate: '16',
        },
        { quantity: '1', unitPrice: '999.99', taxRate: '16' },
        { quantity: '3', unitPrice: '100' },
      ],
      discount: { kind: 'amount', value: '100' },
    });
    if (!computed.ok) throw new Error('The example is refused.');
    const { totals } = computed;
    const shown = shownTotals(
      {
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        amountPaid: '1000',
        balanceDue: '3000.5',
      },
      totals.lines.map((line, index) => ({
        taxRate: index === 2 ? '0.0000' : '16.0000',
        discountAmount: line.discount,
        taxableAmount: line.taxable,
        taxAmount: line.tax,
      })),
    );
    expect(shown).toEqual({
      subtotal: totals.subtotal,
      lineDiscountTotal: totals.lineDiscountTotal,
      documentDiscount: totals.documentDiscount,
      discountTotal: totals.discountTotal,
      taxes: totals.taxes,
      taxTotal: totals.taxTotal,
      total: totals.total,
      amountPaid: '1000.0000',
      balanceDue: '3000.5000',
    });
    expect(shown.taxes.map((tax) => tax.rate)).toEqual(['0.0000', '16.0000']);
  });

  it('are all zero for a draft with no lines', () => {
    const zero = '0.0000';
    expect(
      shownTotals(
        {
          subtotal: '0',
          discountTotal: '0',
          taxTotal: '0',
          total: '0',
          amountPaid: '0',
          balanceDue: '0',
        },
        [],
      ),
    ).toEqual({
      subtotal: zero,
      lineDiscountTotal: zero,
      documentDiscount: zero,
      discountTotal: zero,
      taxes: [],
      taxTotal: zero,
      total: zero,
      amountPaid: zero,
      balanceDue: zero,
    });
  });

  it('give a line as what tax is charged on plus the tax, to four places', () => {
    expect(lineTotal('3000.0000', '480.0000')).toBe('3480.0000');
    expect(fourPlaces('16')).toBe('16.0000');
    expect(fourPlaces('0.5')).toBe('0.5000');
  });
});

describe('the lines with what they come to', () => {
  it('pairs each line with the arithmetic’s amounts for it, in order', () => {
    const lines = [
      { name: 'Planning', quantity: '2', unitPrice: '1500', taxRate: '16' },
      { name: 'Chairs', quantity: '10', unitPrice: '50' },
    ];
    const priced = pricedLines({ currency: 'KES', lines, discount: null });
    expect(priced.lines.map(({ line, amounts }) => [line.name, amounts.total])).toEqual([
      ['Planning', '3480.0000'],
      ['Chairs', '500.0000'],
    ]);
    expect(priced.totals.total).toBe('3980.0000');
    expect(pricedLines({ currency: 'KES', lines: [] })).toMatchObject({
      lines: [],
      totals: { total: '0.0000' },
    });
  });

  it('refuses numbers that cannot be as the API reports them, each where it was typed', () => {
    const refused = (): unknown => {
      try {
        pricedLines({
          currency: 'KES',
          lines: [
            { quantity: '0', unitPrice: '-1' },
            { quantity: '1', unitPrice: '10', discount: { kind: 'amount', value: '11' } },
          ],
        });
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const error = refused();
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues.map((issue) => `${issue.path}:${issue.code}`)).toEqual(
      [
        '/lines/0/quantity:invalid_quantity',
        '/lines/0/unitPrice:invalid_price',
        '/lines/1/discount/value:discount_too_large',
      ],
    );
  });
});

describe('a payment', () => {
  it('adds to what is paid and takes off what is owed, and a reversal does the opposite', () => {
    expect(paidAfter('3480.0000', '0.0000', '1000', 'record')).toEqual({
      amountPaid: '1000.0000',
      balanceDue: '2480.0000',
    });
    expect(paidAfter('3480.0000', '1000.0000', '2480.00', 'record')).toEqual({
      amountPaid: '3480.0000',
      balanceDue: '0.0000',
    });
    expect(paidAfter('3480.0000', '3480.0000', '2480.0000', 'reverse')).toEqual({
      amountPaid: '1000.0000',
      balanceDue: '2480.0000',
    });
  });
});

describe('who a document is from', () => {
  const address = {
    line1: '1 Quay Road',
    line2: '',
    city: 'Mombasa',
    region: '',
    postalCode: '80100',
    country: 'KE',
  };

  it('is the business profile with the tax number and payment instructions of the settings', () => {
    expect(
      sellerOf(
        { name: 'Harbor Lights Events', address, logoFileId: null },
        { taxNumber: 'P051234567X', paymentInstructions: 'M-Pesa till 123456' },
      ),
    ).toEqual({
      name: 'Harbor Lights Events',
      address,
      taxNumber: 'P051234567X',
      logoFileId: null,
      paymentInstructions: 'M-Pesa till 123456',
    });
  });

  it('is read back from a row, and is nothing when the row holds none that can be read', () => {
    const snapshot = sellerOf(
      { name: 'Harbor Lights Events', address: null, logoFileId: null },
      { taxNumber: null, paymentInstructions: '' },
    );
    expect(storedSeller(snapshot)).toEqual(snapshot);
    expect(storedSeller(null)).toBeNull();
    expect(storedSeller({ name: 5 })).toBeNull();
    // A receipt is always from someone: blank rather than failing when nothing can be read.
    expect(receiptSeller(snapshot)).toEqual(snapshot);
    expect(receiptSeller(null)).toEqual({
      name: '',
      address: null,
      taxNumber: null,
      logoFileId: null,
      paymentInstructions: '',
    });
  });
});

describe('a counter', () => {
  it('moves only above every number already given out', () => {
    expect(nextNumberRefusal(1, 0)).toBeUndefined();
    expect(nextNumberRefusal(120, 119)).toBeUndefined();
    expect(nextNumberRefusal(119, 119)).toBe(
      'Numbers up to 119 were already given out. Choose a number above 119.',
    );
    expect(nextNumberRefusal(5, 119)).toContain('above 119');
  });

  it('has numbers left until its last', () => {
    expect(numbersLeft(1)).toBe(true);
    expect(numbersLeft(MAX_SEQUENCE_NUMBER - 1)).toBe(true);
    expect(numbersLeft(MAX_SEQUENCE_NUMBER)).toBe(false);
  });
});

describe('what a row holds', () => {
  it('is read as the contract names it, and as the safest thing when it is unknown', () => {
    expect(statusOf('partly_paid')).toBe('partly_paid');
    expect(statusOf('archived')).toBe('draft');
    expect(invoiceStatusOf('void')).toBe('void');
    expect(invoiceStatusOf('accepted')).toBe('draft');
    expect(kindOf('quote')).toBe('quote');
    expect(kindOf('invoice')).toBe('invoice');
    expect(methodOf('mobile_money')).toBe('mobile_money');
    expect(methodOf('barter')).toBe('other');
  });

  it('starts from the defaults of the settings table', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      paymentTermsDays: 14,
      quoteValidityDays: 30,
      defaultNotes: '',
      defaultTerms: '',
      paymentInstructions: '',
      taxNumber: null,
      defaultTaxRate: null,
      revision: 1,
    });
  });
});
