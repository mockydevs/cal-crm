import { computeDocumentTotals, type Product, type SalesDocument } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  addressLines,
  deepRejection,
  documentInput,
  documentMark,
  documentSplat,
  draftChanged,
  draftOf,
  draftProblems,
  draftRejection,
  draftTotals,
  dueDateFor,
  emptyLine,
  formatDay,
  formatMoney,
  formatPercent,
  formPath,
  isBlankLine,
  lineFromProduct,
  localDecimal,
  moveLine,
  newDraft,
  numberExample,
  placeOf,
  plainDecimal,
  productDraftOf,
  productInput,
  receiptSplat,
  sellerOfProfile,
  sellerOfSnapshot,
  sentLines,
  settingsDraftOf,
  settingsInput,
  statusFilters,
  unwholeFields,
  wholeNumber,
  type DocumentDraft,
  type LineDraft,
  defaultSubject,
  noSendRefusal,
  sendAddresses,
  sendRefusal,
  sendValues,
} from './payments-rules';

const settings = {
  numbering: {
    quote: { prefix: 'QUO-', nextNumber: 3, lastNumber: 2, example: 'QUO-0003' },
    invoice: { prefix: 'INV-', nextNumber: 1, lastNumber: 0, example: 'INV-0001' },
    receipt: { prefix: 'RCT-', nextNumber: 12, lastNumber: 11, example: 'RCT-0012' },
  },
  paymentTermsDays: 14,
  quoteValidityDays: 30,
  defaultNotes: 'Thank you.',
  defaultTerms: 'Pay within 14 days.',
  paymentInstructions: 'Paybill 123456',
  taxNumber: 'P051234567X',
  defaultTaxRate: '16.0000',
  revision: 4,
  canManage: true,
};

const product: Product = {
  id: 'prod_1',
  kind: 'service',
  name: 'Site visit',
  description: 'Half a day on site',
  sku: 'VISIT',
  unit: 'visit',
  unitPrice: '1500.0000',
  currency: 'KES',
  taxRate: null,
  archived: false,
  archivedAt: null,
  used: false,
  revision: 2,
  canManage: true,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

const line = (changes: Partial<LineDraft> = {}): LineDraft => ({
  ...emptyLine('k', null),
  name: 'Design',
  unitPrice: '1000',
  ...changes,
});

const draft = (changes: Partial<DocumentDraft> = {}): DocumentDraft => ({
  ...newDraft({
    currency: 'KES',
    settings,
    contact: { id: 'con_1', name: 'Amina Otieno' },
    dealId: null,
    lineKey: 'new-0',
  }),
  ...changes,
});

describe('placeOf', () => {
  it('reads each page of the module from what follows /payments/', () => {
    expect(placeOf('invoices')).toEqual({ at: 'documents', kind: 'invoice' });
    expect(placeOf('quotes/')).toEqual({ at: 'documents', kind: 'quote' });
    expect(placeOf('quotes/new')).toEqual({ at: 'document', kind: 'quote', id: undefined });
    expect(placeOf('invoices/sdoc_1')).toEqual({ at: 'document', kind: 'invoice', id: 'sdoc_1' });
    expect(placeOf('receipts')).toEqual({ at: 'receipts' });
    expect(placeOf('receipts/pay_1')).toEqual({ at: 'receipt', id: 'pay_1' });
    expect(placeOf('products')).toEqual({ at: 'products' });
    expect(placeOf('settings')).toEqual({ at: 'settings' });
  });

  it('knows no other page', () => {
    for (const splat of [undefined, '', 'orders', 'products/x', 'invoices/a/b', 'settings/tax'])
      expect(placeOf(splat)).toEqual({ at: 'nowhere' });
  });

  it('writes the addresses it reads', () => {
    expect(placeOf(documentSplat('quote'))).toEqual({
      at: 'document',
      kind: 'quote',
      id: undefined,
    });
    expect(placeOf(documentSplat('invoice', 'sdoc_9'))).toEqual({
      at: 'document',
      kind: 'invoice',
      id: 'sdoc_9',
    });
    expect(placeOf(receiptSplat('pay_2'))).toEqual({ at: 'receipt', id: 'pay_2' });
  });
});

describe('writing numbers', () => {
  it('keeps the places asked for and drops zeros it does not need', () => {
    expect(plainDecimal('1500.0000', 2)).toBe('1500.00');
    expect(plainDecimal('2.5000')).toBe('2.5');
    expect(plainDecimal('16.0000')).toBe('16');
    expect(plainDecimal('0.1250', 2)).toBe('0.125');
    expect(plainDecimal('7')).toBe('7');
    expect(plainDecimal('7', 2)).toBe('7.00');
    expect(plainDecimal('-3.1000', 2)).toBe('-3.10');
    expect(plainDecimal('.5')).toBe('0.5');
  });

  it('groups thousands without ever making a float of the amount', () => {
    expect(localDecimal('1234567.5000', 2, 'en')).toBe('1,234,567.50');
    expect(localDecimal('9007199254740993.0100', 2, 'en')).toBe('9,007,199,254,740,993.01');
    expect(localDecimal('1234.5000', 2, 'de')).toBe('1.234,50');
    expect(localDecimal('-1200.0000', 0, 'en')).toBe('-1,200');
  });

  it('shows what is not a number yet as it was typed', () => {
    expect(localDecimal('12a', 2, 'en')).toBe('12a');
    expect(localDecimal('', 2, 'en')).toBe('');
  });

  it("writes money with its currency and the currency's own decimals", () => {
    expect(formatMoney('1500.0000', 'KES', 'en')).toBe('KES 1,500.00');
    expect(formatMoney('1500.0000', 'JPY', 'en')).toBe('JPY 1,500');
    expect(formatMoney('0.1250', 'USD', 'en')).toBe('USD 0.125');
    expect(formatMoney('12.5000', 'KWD', 'en')).toBe('KWD 12.500');
  });

  it('writes a rate and a day', () => {
    expect(formatPercent('16.0000', 'en')).toBe('16%');
    expect(formatPercent('7.5000', 'en')).toBe('7.5%');
    expect(formatDay('2026-10-12', 'en')).toBe('Oct 12, 2026');
    // A calendar date is no moment: it is the same day west of Greenwich.
    expect(formatDay('2026-01-01', 'en-US')).toBe('Jan 1, 2026');
  });
});

describe('documentMark', () => {
  const base = { status: 'sent' as const, overdue: false, expired: false };
  it('gives each status its colour', () => {
    expect(documentMark({ ...base, status: 'draft' })).toEqual({ mark: 'draft', tone: 'neutral' });
    expect(documentMark(base)).toEqual({ mark: 'sent', tone: 'info' });
    expect(documentMark({ ...base, status: 'accepted' }).tone).toBe('success');
    expect(documentMark({ ...base, status: 'declined' }).tone).toBe('danger');
    expect(documentMark({ ...base, status: 'partly_paid' }).tone).toBe('warning');
    expect(documentMark({ ...base, status: 'paid' }).tone).toBe('success');
    expect(documentMark({ ...base, status: 'void' }).tone).toBe('neutral');
  });

  it('shows overdue and expired in place of the status', () => {
    expect(documentMark({ ...base, status: 'partly_paid', overdue: true })).toEqual({
      mark: 'overdue',
      tone: 'danger',
    });
    expect(documentMark({ ...base, expired: true })).toEqual({ mark: 'expired', tone: 'warning' });
  });

  it('offers each kind its own filters', () => {
    expect(statusFilters.quote).toEqual([
      'all',
      'draft',
      'sent',
      'accepted',
      'declined',
      'expired',
    ]);
    expect(statusFilters.invoice).toContain('overdue');
    expect(statusFilters.invoice).not.toContain('accepted');
  });
});

describe('deepRejection', () => {
  it('keeps each issue under its whole path, the first for each', () => {
    expect(
      deepRejection([
        { path: '/numbering/quote/prefix', message: 'Use letters.' },
        { path: '/numbering/quote/prefix', message: 'Second.' },
        { path: '/paymentTermsDays', message: 'Too many.' },
        { path: '', message: 'Whole form.' },
        { path: '/', message: 'Also whole.' },
      ]),
    ).toEqual({
      fields: { 'numbering/quote/prefix': 'Use letters.', paymentTermsDays: 'Too many.' },
      form: 'Whole form.',
    });
  });
});

describe('products', () => {
  it('starts a new product in the currency of the business', () => {
    expect(productDraftOf(undefined, 'KES')).toMatchObject({
      kind: 'product',
      currency: 'KES',
      unitPrice: '',
      taxRate: '',
    });
  });

  it('shows a saved product as it is typed, and sends it back as the contract takes it', () => {
    const shown = productDraftOf({ ...product, taxRate: '16.0000' }, 'USD');
    expect(shown).toEqual({
      kind: 'service',
      name: 'Site visit',
      description: 'Half a day on site',
      sku: 'VISIT',
      unit: 'visit',
      unitPrice: '1500.00',
      currency: 'KES',
      taxRate: '16',
    });
    expect(
      productInput({ ...shown, name: ' Site visit ', sku: ' ', taxRate: '', currency: 'kes' }),
    ).toEqual({
      kind: 'service',
      name: 'Site visit',
      description: 'Half a day on site',
      sku: null,
      unit: 'visit',
      unitPrice: '1500.00',
      currency: 'KES',
      taxRate: null,
    });
    expect(productInput(shown)).toMatchObject({ sku: 'VISIT', taxRate: '16' });
  });

  it('shows a product with no code or tax rate with both empty', () => {
    expect(productDraftOf({ ...product, sku: null }, 'KES')).toMatchObject({
      sku: '',
      taxRate: '',
    });
  });
});

describe('a draft', () => {
  it('starts with the defaults of the business and one empty line', () => {
    const fresh = draft();
    expect(fresh).toMatchObject({
      currency: 'KES',
      notes: 'Thank you.',
      terms: 'Pay within 14 days.',
      issueDate: '',
      dueDate: '',
      discountValue: '',
    });
    expect(fresh.lines).toEqual([{ ...emptyLine('new-0', '16.0000') }]);
    expect(fresh.lines[0]?.taxRate).toBe('16');
    expect(isBlankLine(fresh.lines[0] ?? line())).toBe(true);
  });

  it('takes a line from a product, with the default tax rate when it has none', () => {
    expect(lineFromProduct('k1', product, '16.0000')).toEqual({
      key: 'k1',
      productId: 'prod_1',
      name: 'Site visit',
      description: 'Half a day on site',
      quantity: '1',
      unit: 'visit',
      unitPrice: '1500.00',
      discountKind: 'percent',
      discountValue: '',
      taxRate: '16',
    });
    expect(lineFromProduct('k1', { ...product, taxRate: '8.0000' }, '16.0000').taxRate).toBe('8');
    expect(lineFromProduct('k1', product, null).taxRate).toBe('');
  });

  it('moves a line up or down, and leaves it where there is no room', () => {
    const lines = [line({ key: 'a' }), line({ key: 'b' }), line({ key: 'c' })];
    expect(moveLine(lines, 0, 1).map((each) => each.key)).toEqual(['b', 'a', 'c']);
    expect(moveLine(lines, 2, -1).map((each) => each.key)).toEqual(['a', 'c', 'b']);
    expect(moveLine(lines, 0, -1)).toBe(lines);
    expect(moveLine(lines, 2, 1)).toBe(lines);
    expect(moveLine(lines, 7, -1)).toBe(lines);
  });

  it('leaves blank rows out of what it sends, and remembers where the others were', () => {
    const written = draft({
      lines: [line({ key: 'a' }), emptyLine('b', '16'), line({ key: 'c', name: 'Print' })],
    });
    expect(sentLines(written).map((each) => each.index)).toEqual([0, 2]);
    expect(formPath(written, '/lines/1/quantity')).toBe('lines/2/quantity');
    expect(formPath(written, 'lines/0/name')).toBe('lines/0/name');
    expect(formPath(written, '/lines/1')).toBe('lines/2');
    expect(formPath(written, '/lines/9/name')).toBe('lines/9/name');
    expect(formPath(written, '/discount/value')).toBe('discount/value');
  });

  it("works its totals out with the contract's own arithmetic", () => {
    const written = draft({
      lines: [
        line({ key: 'a', quantity: '2', unitPrice: '1500', discountValue: '10', taxRate: '16' }),
        emptyLine('b', '16'),
        line({ key: 'c', quantity: '1.5', unitPrice: '800', taxRate: '' }),
      ],
      discountKind: 'amount',
      discountValue: '100',
    });
    const expected = computeDocumentTotals({
      currency: 'KES',
      lines: [
        {
          quantity: '2',
          unitPrice: '1500',
          discount: { kind: 'percent', value: '10' },
          taxRate: '16',
        },
        { quantity: '1.5', unitPrice: '800', discount: null, taxRate: null },
      ],
      discount: { kind: 'amount', value: '100' },
    });
    expect(expected.ok).toBe(true);
    expect(draftTotals(written)).toEqual(expected);
    expect(draftProblems(written)).toEqual({});
  });

  it("puts what is wrong with its numbers under the form's own rows", () => {
    const written = draft({
      lines: [emptyLine('a', null), line({ key: 'b', quantity: '0' })],
      discountValue: '120',
    });
    expect(draftProblems(written)).toEqual({
      'lines/1/quantity': 'Enter a quantity above zero, with at most four decimal places.',
    });
    expect(draftProblems(draft({ lines: [line()], discountValue: '120' }))).toEqual({
      'discount/value': 'A discount is at most 100 percent.',
    });
  });

  it("puts the server's refusal under the form's own rows too", () => {
    const written = draft({ lines: [emptyLine('a', null), line({ key: 'b', name: '' })] });
    expect(
      draftRejection(written, [
        { path: '/lines/0/name', message: 'Say what the line is for.' },
        { path: '/contactId', message: 'Not a contact id.' },
        { path: '', message: 'Refused.' },
      ]),
    ).toEqual({
      fields: { 'lines/1/name': 'Say what the line is for.', contactId: 'Not a contact id.' },
      form: 'Refused.',
    });
  });

  it('sends nothing until it is for someone', () => {
    expect(documentInput(draft({ contact: null }))).toBeUndefined();
  });

  it('sends what was typed, with empty boxes as none', () => {
    expect(
      documentInput(
        draft({
          dealId: 'deal_1',
          issueDate: '2026-10-12',
          lines: [line({ unitPrice: '', description: ' Logo ', unit: ' hour ' })],
          discountValue: ' 5 ',
          notes: ' Thanks ',
          billTo: ' PO Box 1 ',
          customerTaxNumber: ' A1 ',
        }),
      ),
    ).toEqual({
      contactId: 'con_1',
      dealId: 'deal_1',
      currency: 'KES',
      issueDate: '2026-10-12',
      dueDate: null,
      lines: [
        {
          productId: null,
          name: 'Design',
          description: 'Logo',
          quantity: '1',
          unit: 'hour',
          unitPrice: '0',
          discount: null,
          taxRate: null,
        },
      ],
      discount: { kind: 'percent', value: '5' },
      notes: 'Thanks',
      terms: 'Pay within 14 days.',
      billTo: 'PO Box 1',
      customerTaxNumber: 'A1',
    });
    expect(documentInput(draft({ dueDate: '2026-11-01' }))).toMatchObject({
      issueDate: null,
      dueDate: '2026-11-01',
      discount: null,
      customerTaxNumber: null,
      lines: [],
    });
  });

  it('knows when the form holds something the saved draft does not', () => {
    const saved = draft();
    expect(draftChanged(saved, draft())).toBe(false);
    expect(draftChanged({ ...saved, notes: 'Other' }, saved)).toBe(true);
  });

  it('works out the due date from the terms of the business', () => {
    expect(dueDateFor('invoice', '2026-10-12', settings)).toBe('2026-10-26');
    expect(dueDateFor('quote', '2026-10-12', settings)).toBe('2026-11-11');
  });
});

describe('draftOf', () => {
  const saved = {
    contactId: 'con_1',
    dealId: 'deal_1',
    currency: 'KES',
    issueDate: null,
    dueDate: '2026-11-01',
    customer: {
      name: 'Amina Otieno',
      email: null,
      phone: null,
      billTo: 'PO Box 1',
      taxNumber: null,
    },
    lines: [
      {
        id: 'sdl_1',
        position: 0,
        productId: 'prod_1',
        name: 'Site visit',
        description: '',
        quantity: '2.0000',
        unit: 'visit',
        unitPrice: '1500.0000',
        discount: { kind: 'amount', value: '250.0000' },
        taxRate: '16.0000',
      },
      {
        id: 'sdl_2',
        position: 1,
        productId: null,
        name: 'Travel',
        description: 'By road',
        quantity: '1.5000',
        unit: '',
        unitPrice: '800.5000',
        discount: null,
        taxRate: '0.0000',
      },
    ],
    discount: { kind: 'percent', value: '10.0000' },
    notes: 'Thanks',
    terms: '',
  } as unknown as SalesDocument;

  it('shows a saved draft as it is typed', () => {
    expect(draftOf(saved)).toEqual({
      contact: { id: 'con_1', name: 'Amina Otieno' },
      dealId: 'deal_1',
      currency: 'KES',
      issueDate: '',
      dueDate: '2026-11-01',
      lines: [
        {
          key: 'sdl_1',
          productId: 'prod_1',
          name: 'Site visit',
          description: '',
          quantity: '2',
          unit: 'visit',
          unitPrice: '1500.00',
          discountKind: 'amount',
          discountValue: '250.00',
          taxRate: '16',
        },
        {
          key: 'sdl_2',
          productId: null,
          name: 'Travel',
          description: 'By road',
          quantity: '1.5',
          unit: '',
          unitPrice: '800.50',
          discountKind: 'percent',
          discountValue: '',
          taxRate: '',
        },
      ],
      discountKind: 'percent',
      discountValue: '10',
      notes: 'Thanks',
      terms: '',
      billTo: 'PO Box 1',
      customerTaxNumber: '',
    });
  });

  it('shows a draft whose contact was deleted, or with no discount, without them', () => {
    const orphan = draftOf({
      ...saved,
      contactId: null,
      discount: null,
      issueDate: '2026-10-12',
      dueDate: null,
      customer: { ...saved.customer, taxNumber: 'A1' },
    });
    expect(orphan).toMatchObject({
      contact: null,
      discountKind: 'percent',
      discountValue: '',
      issueDate: '2026-10-12',
      dueDate: '',
      customerTaxNumber: 'A1',
    });
  });
});

describe('who a document is from', () => {
  const address = {
    line1: '12 Harbour Road',
    line2: '',
    city: 'Mombasa',
    region: '',
    postalCode: '80100',
    country: 'KE',
  };
  it('prints an address as lines, without its empty parts', () => {
    expect(addressLines(address)).toEqual(['12 Harbour Road', 'Mombasa, 80100', 'KE']);
    expect(addressLines(null)).toEqual([]);
  });

  it('draws a draft from the profile and the settings, and an issued one from its snapshot', () => {
    expect(
      sellerOfProfile({ name: 'Harbor Lights', address, logoFileId: 'file_1' }, settings),
    ).toEqual({
      name: 'Harbor Lights',
      addressLines: ['12 Harbour Road', 'Mombasa, 80100', 'KE'],
      taxNumber: 'P051234567X',
      logoFileId: 'file_1',
      paymentInstructions: 'Paybill 123456',
    });
    expect(
      sellerOfSnapshot({
        name: 'Old name',
        address: null,
        taxNumber: null,
        logoFileId: null,
        paymentInstructions: '',
      }),
    ).toEqual({
      name: 'Old name',
      addressLines: [],
      taxNumber: null,
      logoFileId: null,
      paymentInstructions: '',
    });
  });
});

describe('settings', () => {
  it('shows the settings as they are typed', () => {
    expect(settingsDraftOf(settings)).toEqual({
      numbering: {
        quote: { prefix: 'QUO-', nextNumber: '3' },
        invoice: { prefix: 'INV-', nextNumber: '1' },
        receipt: { prefix: 'RCT-', nextNumber: '12' },
      },
      paymentTermsDays: '14',
      quoteValidityDays: '30',
      defaultNotes: 'Thank you.',
      defaultTerms: 'Pay within 14 days.',
      paymentInstructions: 'Paybill 123456',
      taxNumber: 'P051234567X',
      defaultTaxRate: '16',
    });
    expect(settingsDraftOf({ ...settings, taxNumber: null, defaultTaxRate: null })).toMatchObject({
      taxNumber: '',
      defaultTaxRate: '',
    });
  });

  it('reads a whole number, and nothing else', () => {
    expect(wholeNumber(' 14 ')).toBe(14);
    expect(wholeNumber('0')).toBe(0);
    for (const text of ['', '1.5', '-2', 'ten', '1e3', '1234567890123'])
      expect(wholeNumber(text)).toBeUndefined();
  });

  it('prints the next number as the form stands', () => {
    expect(numberExample('INV-', '7')).toBe('INV-0007');
    expect(numberExample('2026/', '12345')).toBe('2026/12345');
    expect(numberExample('INV-', '0')).toBeUndefined();
    expect(numberExample('INV-', 'x')).toBeUndefined();
    expect(numberExample('INV-', '999999999999')).toBe('INV-999999999999');
  });

  it('names the boxes that do not hold a whole number', () => {
    const typed = settingsDraftOf(settings);
    expect(unwholeFields(typed)).toEqual([]);
    expect(
      unwholeFields({
        ...typed,
        numbering: { ...typed.numbering, invoice: { prefix: 'INV-', nextNumber: 'x' } },
        paymentTermsDays: '',
        quoteValidityDays: '1.5',
      }),
    ).toEqual(['numbering/invoice/nextNumber', 'paymentTermsDays', 'quoteValidityDays']);
  });

  it('sends the settings back with the revision they were read at', () => {
    const typed = settingsDraftOf(settings);
    expect(
      settingsInput({ ...typed, taxNumber: ' ', defaultTaxRate: '', defaultNotes: ' Hi ' }, 4),
    ).toEqual({
      numbering: {
        quote: { prefix: 'QUO-', nextNumber: 3 },
        invoice: { prefix: 'INV-', nextNumber: 1 },
        receipt: { prefix: 'RCT-', nextNumber: 12 },
      },
      paymentTermsDays: 14,
      quoteValidityDays: 30,
      defaultNotes: 'Hi',
      defaultTerms: 'Pay within 14 days.',
      paymentInstructions: 'Paybill 123456',
      taxNumber: null,
      defaultTaxRate: null,
      revision: 4,
    });
    expect(settingsInput(typed, 4)).toMatchObject({
      taxNumber: 'P051234567X',
      defaultTaxRate: '16',
    });
    expect(
      settingsInput(
        {
          ...typed,
          numbering: { ...typed.numbering, quote: { prefix: 'Q', nextNumber: '' } },
          paymentTermsDays: 'x',
          quoteValidityDays: 'y',
        },
        4,
      ),
    ).toMatchObject({
      numbering: { quote: { prefix: 'Q', nextNumber: 0 } },
      paymentTermsDays: 0,
      quoteValidityDays: 0,
    });
  });
});

describe('sending', () => {
  it("writes the subject the server gives an email that names none, in the server's words", () => {
    expect(defaultSubject('invoice', 'INV-0007', 'Harbor Lights Events')).toBe(
      'Invoice INV-0007 from Harbor Lights Events',
    );
    expect(defaultSubject('quote', 'QUO-0001', '')).toBe('Quote QUO-0001');
    expect(defaultSubject('receipt', 'RCT-0003', 'Harbor\n Lights')).toBe(
      'Receipt RCT-0003 from Harbor Lights',
    );
    expect(defaultSubject('invoice', 'INV-1', 'x'.repeat(300))).toHaveLength(200);
  });

  it("starts on the customer's address when the contact still has it, else on the first", () => {
    const own = ['amina@example.com', 'accounts@example.com'];
    expect(sendAddresses(own, 'Accounts@Example.com ')).toEqual({
      options: own,
      chosen: 'accounts@example.com',
    });
    expect(sendAddresses(own, 'old@example.com').chosen).toBe('amina@example.com');
    expect(sendAddresses(own, null).chosen).toBe('amina@example.com');
    expect(sendAddresses([], 'amina@example.com')).toEqual({ options: [], chosen: '' });
  });

  it('leaves out what was left empty, for the server to fill', () => {
    expect(
      sendValues({ to: '', mailboxId: '', subject: '  ', message: ' \n', attachPdf: true }),
    ).toEqual({ attachPdf: true });
    expect(
      sendValues({
        to: 'amina@example.com',
        mailboxId: 'mbx_1',
        subject: ' Your  invoice\n',
        message: ' Thank you.\nSee you soon. ',
        attachPdf: false,
      }),
    ).toEqual({
      to: 'amina@example.com',
      mailboxId: 'mbx_1',
      subject: 'Your invoice',
      message: 'Thank you.\nSee you soon.',
      attachPdf: false,
    });
  });

  it('puts each issue of a 422 under the box it names, with the code it has words for', () => {
    expect(
      sendRefusal(
        {
          status: 422,
          errors: [
            { path: '/to', code: 'consent_required', message: 'No consent is recorded.' },
            { path: '/to', code: 'suppressed', message: 'Second for the same box.' },
            { path: '/mailboxId', code: 'no_mailbox', message: 'There is no mailbox.' },
            { path: '/subject', code: 'too_long', message: 'Use at most 200 characters.' },
            { path: '/revision', code: 'invalid', message: 'Not a revision.' },
          ],
        },
        'fallback',
      ),
    ).toEqual({
      fields: {
        to: { code: 'consent_required', message: 'No consent is recorded.' },
        mailboxId: { code: 'no_mailbox', message: 'There is no mailbox.' },
        subject: { code: undefined, message: 'Use at most 200 characters.' },
      },
      form: 'Not a revision.',
      conflict: false,
    });
  });

  it("shows a 409's sentence above the buttons, and says it is a conflict", () => {
    expect(
      sendRefusal({ status: 409, detail: 'This install cannot send email.' }, 'fallback'),
    ).toEqual({ fields: {}, form: 'This install cannot send email.', conflict: true });
    expect(sendRefusal({ status: 409, errors: [] }, 'fallback')).toEqual({
      fields: {},
      form: 'fallback',
      conflict: true,
    });
  });

  it("says the page's own words when the server said nothing", () => {
    expect(sendRefusal(undefined, 'Check your connection.')).toEqual({
      fields: {},
      form: 'Check your connection.',
      conflict: false,
    });
    expect(sendRefusal({ status: 500 }, 'Check your connection.').form).toBe(
      'Check your connection.',
    );
    expect(noSendRefusal).toEqual({ fields: {}, form: undefined, conflict: false });
  });
});
