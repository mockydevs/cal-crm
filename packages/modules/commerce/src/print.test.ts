import { describe, expect, it } from 'vitest';

import { invoice, quote, receipt, SELLER } from '../test/print-fixtures.js';
import { printedDate, printedDocument, printedReceipt } from './print.js';

const labels = (rows: readonly { readonly label: string }[]): string[] =>
  rows.map((row) => row.label);
const valueOf = (
  rows: readonly { readonly label: string; readonly value: string }[],
  label: string,
) => rows.find((row) => row.label === label)?.value;

describe('what an invoice says when it is printed', () => {
  it('names itself, who it is from and for, and its dates', () => {
    const printed = printedDocument(invoice());
    expect(printed).toMatchObject({
      title: 'Invoice',
      number: 'INV-0007',
      mark: null,
      fileName: 'INV-0007.pdf',
    });
    expect(printed.seller).toEqual({
      name: 'Harbor Lights Events',
      lines: ['12 Riverside Drive', 'Nairobi, 00100', 'Kenya', 'Tax number: P051234567X'],
    });
    expect(printed.customer).toEqual({
      heading: 'Bill to',
      name: 'Maya Thompson',
      lines: [
        'Thompson & Daughters Ltd',
        'PO Box 4410',
        'Mombasa',
        'maya@example.com',
        '+254712345678',
        'Tax number: A009988776B',
      ],
    });
    expect(printed.facts).toEqual([
      { label: 'Issue date', value: '12 Oct 2026' },
      { label: 'Due date', value: '26 Oct 2026' },
      { label: 'Status', value: 'Partly paid' },
    ]);
  });

  it('prints each line with its quantity, rate, discount, tax and amount as they are stored', () => {
    const printed = printedDocument(invoice());
    expect(printed.columns).toEqual([
      'Description',
      'Quantity',
      'Rate (KES)',
      'Discount (KES)',
      'Tax',
      'Amount (KES)',
    ]);
    expect(printed.lines).toEqual([
      {
        name: 'Event planning',
        description: 'Site visits, vendor calls and the run of show.',
        quantity: '3 hour',
        // A rate keeps the places it has: nothing is rounded for print.
        rate: '333.335',
        discount: '125.00',
        tax: '16%',
        amount: '1,000.01',
      },
      {
        name: 'Venue deposit',
        description: '',
        quantity: '1',
        rate: '5,000.00',
        discount: '',
        tax: '',
        amount: '5,000.00',
      },
    ]);
  });

  it('prints the totals with the currency code, tax by rate, what was paid and what is owed', () => {
    const printed = printedDocument(invoice());
    expect(printed.totals).toEqual([
      { label: 'Subtotal', value: 'KES 6,000.01', strong: false },
      { label: 'Line discounts', value: '-KES 125.00', strong: false },
      { label: 'Tax 16% on 875.01', value: 'KES 140.00', strong: false },
      { label: 'Total', value: 'KES 6,015.01', strong: true },
      { label: 'Paid', value: '-KES 2,000.00', strong: false },
      { label: 'Balance due', value: 'KES 4,015.01', strong: true },
    ]);
  });

  it('prints the notes, how to pay and the terms, and never the team’s own note', () => {
    const printed = printedDocument(invoice());
    expect(printed.sections).toEqual([
      { heading: 'Notes', text: 'Thank you for choosing us.' },
      { heading: 'How to pay', text: SELLER.paymentInstructions },
      { heading: 'Terms', text: 'Payment within 14 days.' },
    ]);
    expect(JSON.stringify(printed)).not.toContain('Margin is thin');
    expect(
      printedDocument(invoice({ notes: '  ', terms: '' })).sections.map((each) => each.heading),
    ).toEqual(['How to pay']);
  });

  it('names a discount on the whole document, by its percentage when it is one', () => {
    const totals = { ...invoice().totals, documentDiscount: '600.0000', discountTotal: '725.0000' };
    expect(
      labels(
        printedDocument(invoice({ totals, discount: { kind: 'percent', value: '10.0000' } }))
          .totals,
      ),
    ).toContain('Discount (10%)');
    const flat = printedDocument(
      invoice({ totals, discount: { kind: 'amount', value: '600.0000' } }),
    );
    expect(valueOf(flat.totals, 'Discount')).toBe('-KES 600.00');
  });

  it('says paid in full, and owes nothing, once it is', () => {
    const totals = { ...invoice().totals, amountPaid: '6015.0100', balanceDue: '0.0000' };
    const printed = printedDocument(invoice({ status: 'paid', totals }));
    expect(printed.facts.at(-1)).toEqual({ label: 'Status', value: 'Paid' });
    expect(valueOf(printed.totals, 'Balance due')).toBe('KES 0.00');
  });

  it('shows no payment line on an invoice nothing was paid on', () => {
    const totals = { ...invoice().totals, amountPaid: '0.0000', balanceDue: '6015.0100' };
    const printed = printedDocument(invoice({ status: 'sent', totals }));
    expect(labels(printed.totals)).not.toContain('Paid');
    expect(valueOf(printed.totals, 'Balance due')).toBe('KES 6,015.01');
    expect(labels(printed.facts)).toEqual(['Issue date', 'Due date']);
  });

  it('prints a currency with no smaller unit without decimal places', () => {
    const printed = printedDocument(
      invoice({
        currency: 'JPY',
        totals: { ...invoice().totals, total: '6015.0000', balanceDue: '4015.0000' },
      }),
    );
    expect(valueOf(printed.totals, 'Total')).toBe('JPY 6,015');
    expect(printed.columns[5]).toBe('Amount (JPY)');
  });

  it('marks a void invoice, and prints no balance on it', () => {
    const printed = printedDocument(invoice({ status: 'void' }));
    expect(printed.mark).toBe('VOID');
    expect(labels(printed.totals)).not.toContain('Balance due');
  });
});

describe('what a draft says when it is printed', () => {
  const draft = invoice({
    status: 'draft',
    number: null,
    seller: null,
    issueDate: null,
    dueDate: null,
  });

  it('is marked DRAFT, has no number, and is from the business as it is now', () => {
    const printed = printedDocument(draft, SELLER);
    expect(printed).toMatchObject({ mark: 'DRAFT', number: null, fileName: 'invoice-draft.pdf' });
    expect(printed.seller.name).toBe('Harbor Lights Events');
    expect(printed.facts).toEqual([]);
    expect(labels(printed.totals)).toEqual([
      'Subtotal',
      'Line discounts',
      'Tax 16% on 875.01',
      'Total',
    ]);
  });

  it('is printed with a blank seller when nobody says who the business is', () => {
    expect(printedDocument(draft).seller).toEqual({ name: '', lines: [] });
  });
});

describe('what a quote says when it is printed', () => {
  it('is prepared for its customer, valid until its last day, and asks for no payment', () => {
    const printed = printedDocument(quote());
    expect(printed).toMatchObject({ title: 'Quote', number: 'QUO-0003', fileName: 'QUO-0003.pdf' });
    expect(printed.customer.heading).toBe('Prepared for');
    expect(printed.facts).toEqual([
      { label: 'Issue date', value: '12 Oct 2026' },
      { label: 'Valid until', value: '11 Nov 2026' },
    ]);
    expect(labels(printed.totals)).toEqual(['Subtotal', 'Total']);
    expect(printed.sections.map((each) => each.heading)).toEqual(['Notes', 'Terms']);
  });

  it('says how it was answered', () => {
    expect(printedDocument(quote({ status: 'accepted' })).facts.at(-1)).toEqual({
      label: 'Status',
      value: 'Accepted',
    });
    expect(printedDocument(quote({ status: 'declined' })).facts.at(-1)).toEqual({
      label: 'Status',
      value: 'Declined',
    });
    expect(printedDocument(quote({ status: 'draft', number: null })).fileName).toBe(
      'quote-draft.pdf',
    );
  });
});

describe('what a receipt says when it is printed', () => {
  it('names the payment, how it was made, its invoice and what was owed after it', () => {
    const printed = printedReceipt(receipt());
    expect(printed).toMatchObject({
      title: 'Receipt',
      number: 'RCT-0003',
      mark: null,
      fileName: 'RCT-0003.pdf',
      lines: [],
    });
    expect(printed.customer.heading).toBe('Received from');
    expect(printed.facts).toEqual([
      { label: 'Date', value: '13 Oct 2026' },
      { label: 'Method', value: 'Mobile money' },
      { label: 'Reference', value: 'SJK4H7T2QW' },
      { label: 'Invoice', value: 'INV-0007' },
    ]);
    expect(printed.totals).toEqual([
      { label: 'Amount received', value: 'KES 2,000.00', strong: true },
      { label: 'Invoice total', value: 'KES 6,015.01', strong: false },
      { label: 'Balance after this payment', value: 'KES 4,015.01', strong: false },
    ]);
    expect(printed.sections).toEqual([]);
  });

  it('leaves a reference out when the payment has none', () => {
    expect(labels(printedReceipt(receipt({ reference: null, method: 'cash' })).facts)).toEqual([
      'Date',
      'Method',
      'Invoice',
    ]);
  });

  it('marks a reversed payment and says why', () => {
    const reversed = printedReceipt(
      receipt({ status: 'reversed', reversalReason: 'Recorded on the wrong invoice.' }),
    );
    expect(reversed.mark).toBe('REVERSED');
    expect(reversed.sections).toEqual([
      { heading: 'Reversed', text: 'This payment was reversed: Recorded on the wrong invoice.' },
    ]);
    expect(printedReceipt(receipt({ status: 'reversed' })).sections[0]?.text).toBe(
      'This payment was reversed.',
    );
  });
});

describe('a printed address and date', () => {
  it('leaves out the parts an address does not have, and keeps a country it cannot name', () => {
    const seller = (address: NonNullable<typeof SELLER.address>) =>
      printedDocument(invoice({ seller: { ...SELLER, address, taxNumber: null } })).seller.lines;
    expect(
      seller({
        line1: '',
        line2: 'Suite 4',
        city: '',
        region: 'Nairobi County',
        postalCode: '',
        country: '',
      }),
    ).toEqual(['Suite 4', 'Nairobi County']);
    expect(
      seller({
        line1: '1 Main St',
        line2: '',
        city: 'Austin',
        region: 'TX',
        postalCode: '73301',
        country: 'US',
      }),
    ).toEqual(['1 Main St', 'Austin, TX 73301', 'United States']);
    expect(
      printedDocument(invoice({ seller: { ...SELLER, address: null, taxNumber: null } })).seller
        .lines,
    ).toEqual([]);
  });

  it('prints a calendar date as it is, whatever the server’s time zone', () => {
    expect(printedDate('2026-01-01')).toBe('1 Jan 2026');
    expect(printedDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('prints a customer with nothing but a name', () => {
    const printed = printedDocument(
      invoice({ customer: { name: 'Sam', email: null, phone: null, billTo: '', taxNumber: null } }),
    );
    expect(printed.customer.lines).toEqual([]);
  });
});
