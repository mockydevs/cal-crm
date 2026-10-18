// Quotes and invoices against Postgres, through the module's own routes: drafts, issuing
// with its numbering and snapshots, what is frozen afterwards, a quote's answers and its
// one invoice, voiding, copying and the lists.
import {
  commerceSettings,
  computeDocumentTotals,
  salesDocument,
  salesDocumentList,
  type SalesDocument,
  type TotalsInput,
} from '@repo/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, beforeEach, expect, it } from 'vitest';

import {
  commerceSuite,
  NOW,
  refusalOf,
  settled,
  type CommerceFixture,
} from '../test/commerce-fixtures.js';

const suite = commerceSuite();
const { fixture, api } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});
beforeEach(() => {
  suite.at(NOW);
});

const line = (change: Record<string, unknown> = {}) => ({
  name: 'Event planning',
  quantity: '2',
  unitPrice: '1500',
  taxRate: '16',
  ...change,
});
const input = (f: CommerceFixture, change: Record<string, unknown> = {}) => ({
  contactId: f.contactId,
  currency: 'KES',
  lines: [line()],
  ...change,
});
const draft = async (
  f: CommerceFixture,
  kind: 'quote' | 'invoice' = 'invoice',
  change: Record<string, unknown> = {},
): Promise<SalesDocument> =>
  salesDocument.parse(await api(f, 'createSalesDocument', { body: { kind, ...input(f, change) } }));
const read = async (f: CommerceFixture, id: string, invocation = f.manager) =>
  salesDocument.parse(await api(f, 'getSalesDocument', { params: { id } }, invocation));
const issue = async (f: CommerceFixture, current: Pick<SalesDocument, 'id' | 'revision'>) =>
  salesDocument.parse(
    await api(f, 'issueSalesDocument', {
      params: { id: current.id },
      body: { revision: current.revision },
    }),
  );
const act = async (f: CommerceFixture, operationId: string, id: string, body?: unknown) =>
  salesDocument.parse(await api(f, operationId, { params: { id }, body }));
const issued = async (
  f: CommerceFixture,
  kind: 'quote' | 'invoice' = 'invoice',
  change: Record<string, unknown> = {},
) => issue(f, await draft(f, kind, change));
const list = async (
  f: CommerceFixture,
  query: Record<string, unknown> = {},
  invocation = f.manager,
) => salesDocumentList.parse(await api(f, 'listSalesDocuments', { query }, invocation));
const events = (f: CommerceFixture) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ type: string }>(
      `select type from events.events
       where type like 'quote.%' or type like 'invoice.%' order by recorded_at, id`,
    ),
  );
/** The document's values as an edit sends them back. */
const edit = (
  f: CommerceFixture,
  current: SalesDocument,
  change: Record<string, unknown> = {},
) => ({
  contactId: current.contactId ?? f.contactId,
  dealId: current.dealId,
  currency: current.currency,
  issueDate: current.issueDate,
  dueDate: current.dueDate,
  lines: current.lines.map((each) => ({
    productId: each.productId,
    name: each.name,
    description: each.description,
    quantity: each.quantity,
    unit: each.unit,
    unitPrice: each.unitPrice,
    discount: each.discount,
    taxRate: each.taxRate,
  })),
  discount: current.discount,
  billTo: current.customer.billTo,
  customerTaxNumber: current.customer.taxNumber,
  revision: current.revision,
  ...change,
});
const save = async (f: CommerceFixture, current: SalesDocument, change: Record<string, unknown>) =>
  salesDocument.parse(
    await api(f, 'updateSalesDocument', {
      params: { id: current.id },
      body: edit(f, current, change),
    }),
  );

it('starts a draft with its totals worked out, the contact as they are and the default wording', async () => {
  const f = await fixture();
  const settings = commerceSettings.parse(await api(f, 'getCommerceSettings'));
  await api(f, 'updateCommerceSettings', {
    body: {
      numbering: {
        quote: { prefix: 'QUO-' },
        invoice: { prefix: 'INV-' },
        receipt: { prefix: 'RCT-' },
      },
      paymentTermsDays: 14,
      quoteValidityDays: 30,
      defaultNotes: 'Thank you.',
      defaultTerms: 'Fourteen days.',
      paymentInstructions: '',
      taxNumber: null,
      defaultTaxRate: null,
      revision: settings.revision,
    },
  });
  const made = await draft(f, 'invoice', {
    billTo: ' PO Box 1, Nairobi ',
    customerTaxNumber: 'A1',
  });
  expect(made).toMatchObject({
    kind: 'invoice',
    status: 'draft',
    number: null,
    contactId: f.contactId,
    dealId: null,
    quoteId: null,
    invoiceId: null,
    currency: 'KES',
    issueDate: null,
    dueDate: null,
    customer: {
      name: 'Maya Thompson',
      email: 'maya@example.com',
      phone: null,
      billTo: 'PO Box 1, Nairobi',
      taxNumber: 'A1',
    },
    seller: null,
    discount: null,
    notes: 'Thank you.',
    terms: 'Fourteen days.',
    internalNote: '',
    totals: {
      subtotal: '3000.0000',
      lineDiscountTotal: '0.0000',
      documentDiscount: '0.0000',
      discountTotal: '0.0000',
      taxes: [{ rate: '16.0000', taxable: '3000.0000', tax: '480.0000' }],
      taxTotal: '480.0000',
      total: '3480.0000',
      amountPaid: '0.0000',
      balanceDue: '3480.0000',
    },
    overdue: false,
    expired: false,
    issuedAt: null,
    payments: [],
    actions: ['update', 'delete', 'issue', 'duplicate'],
    revision: 1,
    canManage: true,
  });
  expect(made.lines).toEqual([
    {
      id: expect.stringMatching(/^sdl_/) as string,
      position: 0,
      productId: null,
      name: 'Event planning',
      description: '',
      quantity: '2.0000',
      unit: '',
      unitPrice: '1500.0000',
      discount: null,
      taxRate: '16.0000',
      amount: '3000.0000',
      discountAmount: '0.0000',
      taxableAmount: '3000.0000',
      taxAmount: '480.0000',
      total: '3480.0000',
    },
  ]);
  // Notes and terms a draft names are its own; a draft may have no lines yet.
  const bare = await draft(f, 'quote', { lines: [], notes: '', terms: 'Half up front.' });
  expect(bare).toMatchObject({ notes: '', terms: 'Half up front.', lines: [] });
  expect(bare.totals.total).toBe('0.0000');
  expect((await events(f)).map((event) => event.type)).toEqual([
    'invoice.created',
    'quote.created',
  ]);
});

it('stores exactly what the one arithmetic returns, line by line and in total', async () => {
  const f = await fixture();
  const values = {
    currency: 'KES',
    lines: [
      line({ quantity: '3', unitPrice: '333.335', discount: { kind: 'percent', value: '12.5' } }),
      line({ name: 'Chairs', quantity: '0.3333', unitPrice: '1000', taxRate: '8' }),
      line({ name: 'Delivery', quantity: '1', unitPrice: '250.55', taxRate: null }),
      line({
        name: 'Tip',
        quantity: '7',
        unitPrice: '0.07',
        discount: { kind: 'amount', value: '0.05' },
      }),
    ],
    discount: { kind: 'percent', value: '7.5' },
  };
  const computed = computeDocumentTotals(values as TotalsInput);
  if (!computed.ok) throw new Error('The example is refused.');
  const made = await draft(f, 'invoice', values);

  expect(made.totals).toEqual({
    ...computed.totals,
    lines: undefined,
    amountPaid: '0.0000',
    balanceDue: computed.totals.total,
  });
  expect(
    made.lines.map((each) => ({
      amount: each.amount,
      discount: each.discountAmount,
      taxable: each.taxableAmount,
      tax: each.taxAmount,
      total: each.total,
    })),
  ).toEqual(computed.totals.lines.map(({ net: _net, ...rest }) => rest));
  // And what the rows hold is what was shown: nothing is worked out again on the way out.
  const stored = await database.withTenant(f.business.context, async (sql) => ({
    document: await sql.one<Record<string, string>>(
      `select subtotal::text, discount_total::text, tax_total::text, total::text, balance_due::text
       from commerce.documents`,
    ),
    lines: await sql.query<Record<string, string>>(
      `select amount::text, discount_amount::text, taxable_amount::text, tax_amount::text
       from commerce.document_lines order by position`,
    ),
  }));
  expect(stored.document).toEqual({
    subtotal: computed.totals.subtotal,
    discount_total: computed.totals.discountTotal,
    tax_total: computed.totals.taxTotal,
    total: computed.totals.total,
    balance_due: computed.totals.total,
  });
  expect(stored.lines).toEqual(
    computed.totals.lines.map((each) => ({
      amount: each.amount,
      discount_amount: each.discount,
      taxable_amount: each.taxable,
      tax_amount: each.tax,
    })),
  );
  // The same holds after an edit, and after the document is issued.
  const edited = await save(f, made, { discount: { kind: 'amount', value: '100' } });
  const again = computeDocumentTotals({
    ...values,
    discount: { kind: 'amount', value: '100' },
  });
  if (!again.ok) throw new Error('The example is refused.');
  expect(edited.totals.total).toBe(again.totals.total);
  expect(edited.totals.documentDiscount).toBe('100.0000');
  const sent = await issue(f, edited);
  expect(sent.totals).toEqual({
    ...again.totals,
    lines: undefined,
    amountPaid: '0.0000',
    balanceDue: again.totals.total,
  });
});

it('refuses numbers that cannot be, a contact or a deal the business lacks, and dates the wrong way round', async () => {
  const f = await fixture();
  const other = await fixture();
  const refused = async (change: Record<string, unknown>) =>
    (await refusalOf(() => draft(f, 'invoice', change), ValidationError)).issues.map(
      (each) => `${each.path}:${each.code}`,
    );
  expect(await refused({ lines: [line({ quantity: '0' })] })).toEqual([
    '/lines/0/quantity:invalid_quantity',
  ]);
  expect(
    await refused({ lines: [line({ discount: { kind: 'amount', value: '3000.01' } })] }),
  ).toEqual(['/lines/0/discount/value:discount_too_large']);
  expect(await refused({ contactId: other.contactId })).toEqual(['/contactId:unknown_contact']);
  expect(await refused({ dealId: 'deal_01h455vb4pex5vsknk084sn02q' })).toEqual([
    '/dealId:unknown_deal',
  ]);
  expect(await refused({ issueDate: '2026-10-12', dueDate: '2026-10-11' })).toEqual([
    '/dueDate:before_issue',
  ]);
  // A contact in the trash is not written to.
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [f.contact.id]),
  );
  expect(await refused({})).toEqual(['/contactId:contact_trashed']);
  expect((await list(f)).items).toEqual([]);
});

it('saves a draft from the revision it was read at: its lines replace the ones it had', async () => {
  const f = await fixture();
  const made = await draft(f, 'quote', { notes: 'Kept', terms: 'Kept too' });
  const saved = await save(f, made, {
    lines: [line({ name: 'Chairs', quantity: '10', unitPrice: '50', taxRate: null }), line()],
    discount: { kind: 'percent', value: '10' },
    issueDate: '2026-10-01',
    dueDate: '2026-10-31',
    billTo: 'Quay Road',
  });
  expect(saved).toMatchObject({
    revision: 2,
    issueDate: '2026-10-01',
    dueDate: '2026-10-31',
    discount: { kind: 'percent', value: '10.0000' },
    // Left out of the edit, the notes and terms stay.
    notes: 'Kept',
    terms: 'Kept too',
    customer: { billTo: 'Quay Road' },
  });
  expect(saved.lines.map((each) => [each.position, each.name, each.taxRate])).toEqual([
    [0, 'Chairs', '0.0000'],
    [1, 'Event planning', '16.0000'],
  ]);
  expect(saved.totals).toMatchObject({
    subtotal: '3500.0000',
    documentDiscount: '350.0000',
    taxes: [
      { rate: '0.0000', taxable: '450.0000', tax: '0.0000' },
      { rate: '16.0000', taxable: '2700.0000', tax: '432.0000' },
    ],
    total: '3582.0000',
  });
  const cleared = await save(f, saved, { notes: '' });
  expect(cleared).toMatchObject({ notes: '', terms: 'Kept too', revision: 3 });
  const stale = await refusalOf(() => save(f, made, { billTo: 'Late' }), ConflictError);
  expect(stale.message).toBe('This document changed since you opened it. Reload before saving.');
  expect((await read(f, made.id)).customer.billTo).toBe('Quay Road');
});

it('issues a draft: its number, its dates, who it is from and for, and nothing sent', async () => {
  const f = await fixture();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `update tenancy.businesses set name = 'Harbor Lights Events', timezone = 'Africa/Nairobi',
         address = '{"line1":"1 Quay Road","line2":"","city":"Mombasa","region":"","postalCode":"80100","country":"KE"}'
       where id = $1`,
      [f.business.id],
    ),
  );
  const settings = commerceSettings.parse(await api(f, 'getCommerceSettings'));
  await api(f, 'updateCommerceSettings', {
    body: {
      numbering: {
        quote: { prefix: 'QUO-' },
        invoice: { prefix: 'INV-' },
        receipt: { prefix: 'RCT-' },
      },
      paymentTermsDays: 7,
      quoteValidityDays: 21,
      defaultNotes: '',
      defaultTerms: '',
      paymentInstructions: 'M-Pesa till 123456',
      taxNumber: 'P051234567X',
      defaultTaxRate: null,
      revision: settings.revision,
    },
  });
  // Late on the 12th in UTC is already the 13th in Nairobi: the business's day counts.
  suite.at('2026-10-12T22:30:00.000Z');
  const made = await draft(f);
  // The contact changes after the draft was saved: the issue writes down who they are now.
  await database.withTenant(f.business.context, (sql) =>
    sql.query(`update crm.contacts set first_name = 'Maya', last_name = 'Okafor' where id = $1`, [
      f.contact.id,
    ]),
  );
  const sent = await issue(f, made);
  expect(sent).toMatchObject({
    status: 'sent',
    number: 'INV-0001',
    issueDate: '2026-10-13',
    dueDate: '2026-10-20',
    customer: { name: 'Maya Okafor', email: 'maya@example.com' },
    seller: {
      name: 'Harbor Lights Events',
      address: { line1: '1 Quay Road', city: 'Mombasa', country: 'KE' },
      taxNumber: 'P051234567X',
      logoFileId: null,
      paymentInstructions: 'M-Pesa till 123456',
    },
    actions: ['revise', 'void', 'record_payment', 'duplicate'],
    revision: 2,
    overdue: false,
  });
  expect(sent.issuedAt).not.toBeNull();
  const quote = await issued(f, 'quote');
  expect(quote).toMatchObject({
    status: 'sent',
    number: 'QUO-0001',
    issueDate: '2026-10-13',
    dueDate: '2026-11-03',
    actions: ['revise', 'accept', 'decline', 'convert', 'duplicate'],
  });
  // A later change to the business or the contact rewrites nothing that was issued.
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set name = 'Renamed' where id = $1`, [f.business.id]),
  );
  await database.withTenant(f.business.context, (sql) =>
    sql.query(`update crm.contacts set last_name = 'Later' where id = $1`, [f.contact.id]),
  );
  const later = await read(f, sent.id);
  expect(later.seller?.name).toBe('Harbor Lights Events');
  expect(later.customer.name).toBe('Maya Okafor');
  // Both are on the contact's timeline, and no message was written.
  const timeline = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ event_type: string }>(
      'select event_type from crm.timeline_entries where record_id = $1 order by occurred_at, event_id',
      [f.contact.id],
    ),
  );
  expect(timeline.map((entry) => entry.event_type)).toEqual(['invoice.issued', 'quote.issued']);
  expect((await events(f)).map((event) => event.type)).toEqual([
    'invoice.created',
    'invoice.issued',
    'quote.created',
    'quote.issued',
  ]);
});

it('issues only a draft with a line, at its revision, for a contact who is still there', async () => {
  const f = await fixture();
  const empty = await draft(f, 'quote', { lines: [] });
  expect((await refusalOf(() => issue(f, empty), ConflictError)).message).toBe(
    'Add at least one line before issuing this quote.',
  );
  const made = await draft(f);
  await refusalOf(() => issue(f, { id: made.id, revision: 9 }), ConflictError);
  const sent = await issue(f, made);
  expect((await refusalOf(() => issue(f, sent), ConflictError)).message).toBe(
    'This invoice has been issued. Revise it to change it.',
  );
  // A refused issue takes no number: the next one issued is the next number.
  expect((await issued(f)).number).toBe('INV-0002');
  expect((await read(f, empty.id)).number).toBeNull();
  const waiting = await draft(f);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [f.contact.id]),
  );
  expect((await refusalOf(() => issue(f, waiting), ConflictError)).message).toBe(
    'This contact is in the trash. Restore it first.',
  );
});

it('gives documents issued at once consecutive numbers: none twice, none missing', async () => {
  const f = await fixture();
  const drafts = await Promise.all(Array.from({ length: 8 }, () => draft(f)));
  const quotes = await Promise.all(Array.from({ length: 3 }, () => draft(f, 'quote')));
  // All at once: each issue waits for the counter of its kind, and takes the next number.
  const sent = await Promise.all([...drafts, ...quotes].map((each) => issue(f, each)));
  const numbers = (kind: string) =>
    sent
      .filter((each) => each.kind === kind)
      .map((each) => each.number)
      .sort();
  expect(numbers('invoice')).toEqual([
    'INV-0001',
    'INV-0002',
    'INV-0003',
    'INV-0004',
    'INV-0005',
    'INV-0006',
    'INV-0007',
    'INV-0008',
  ]);
  expect(numbers('quote')).toEqual(['QUO-0001', 'QUO-0002', 'QUO-0003']);
  const stored = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ kind: string; sequences: string }>(
      `select kind, string_agg(sequence_number::text, ',' order by sequence_number) as sequences
       from commerce.documents group by kind order by kind`,
    ),
  );
  expect(stored).toEqual([
    { kind: 'invoice', sequences: '1,2,3,4,5,6,7,8' },
    { kind: 'quote', sequences: '1,2,3' },
  ]);
  const settings = commerceSettings.parse(await api(f, 'getCommerceSettings'));
  expect(settings.numbering.invoice).toMatchObject({ nextNumber: 9, lastNumber: 8 });
  expect(settings.numbering.quote).toMatchObject({ nextNumber: 4, lastNumber: 3 });
  // Two issues of the same draft at once: one wins, the other is told it was issued.
  const one = await draft(f);
  const both = await Promise.all([settled(issue(f, one)), settled(issue(f, one))]);
  expect(both.filter((each) => each.ok)).toHaveLength(1);
  expect(both.find((each) => !each.ok)).toMatchObject({
    error: expect.any(ConflictError) as unknown,
  });
  expect((await read(f, one.id)).number).toBe('INV-0009');
  expect((await issued(f)).number).toBe('INV-0010');
});

it('gives a number back when the issue that took it fails, so there is no gap', async () => {
  const f = await fixture();
  const settings = commerceSettings.parse(await api(f, 'getCommerceSettings'));
  const numbered = (quote: { prefix: string; nextNumber?: number }, revision: number) =>
    api(f, 'updateCommerceSettings', {
      body: {
        numbering: { quote, invoice: { prefix: 'INV-' }, receipt: { prefix: 'RCT-' } },
        paymentTermsDays: 14,
        quoteValidityDays: 30,
        defaultNotes: '',
        defaultTerms: '',
        paymentInstructions: '',
        taxNumber: null,
        defaultTaxRate: null,
        revision,
      },
    });
  // "1" then 0001 prints as 10001; so does no prefix and the number 10001.
  await numbered({ prefix: '1' }, settings.revision);
  expect((await issued(f, 'quote')).number).toBe('10001');
  await numbered({ prefix: '', nextNumber: 10001 }, settings.revision + 1);
  const clash = await draft(f, 'quote');
  expect((await refusalOf(() => issue(f, clash), ConflictError)).message).toBe(
    'Another document already has the next number. Change the prefix or the next number in the settings.',
  );
  // The failed issue left the draft a draft and the counter where it was.
  expect(await read(f, clash.id)).toMatchObject({ status: 'draft', number: null, revision: 1 });
  const after = commerceSettings.parse(await api(f, 'getCommerceSettings'));
  expect(after.numbering.quote).toMatchObject({ nextNumber: 10001, lastNumber: 1 });
  await numbered({ prefix: 'Q-', nextNumber: 2 }, after.revision);
  expect((await issue(f, clash)).number).toBe('Q-0002');
});

it('freezes an issued document: no edit, no delete, and the database refuses its lines too', async () => {
  const f = await fixture();
  const sent = await issued(f);
  expect((await refusalOf(() => save(f, sent, { billTo: 'Changed' }), ConflictError)).message).toBe(
    'This invoice has been issued. Revise it to change it.',
  );
  expect(
    (
      await refusalOf(
        () => api(f, 'deleteSalesDocument', { params: { id: sent.id } }),
        ConflictError,
      )
    ).message,
  ).toBe('An issued invoice is kept. It cannot be deleted.');
  expect(await read(f, sent.id)).toEqual(sent);
  // Whoever writes to the tables directly meets the same rules (0079).
  const forbidden = async (statement: string) =>
    settled(database.withTenant(f.business.context, (sql) => sql.query(statement)));
  for (const statement of [
    `update commerce.document_lines set quantity = 99`,
    `delete from commerce.document_lines`,
    `insert into commerce.document_lines (business_id, document_id, position, name, quantity, unit_price, amount, taxable_amount)
       select business_id, id, 5, 'Extra', 1, 1, 1, 1 from commerce.documents`,
    `update commerce.documents set number = 'INV-9999'`,
    `update commerce.documents set kind = 'quote', status = 'sent'`,
  ])
    expect(await forbidden(statement)).toMatchObject({ ok: false });
  // A delete of an issued document removes nothing: the policy hides it from the delete.
  await database.withTenant(f.business.context, (sql) =>
    sql.query('delete from commerce.documents'),
  );
  expect((await read(f, sent.id)).lines).toHaveLength(1);
  // The team's own note is the one text that still changes.
  const noted = await act(f, 'setSalesDocumentNote', sent.id, {
    internalNote: ' Call before delivery. ',
  });
  expect(noted).toMatchObject({
    internalNote: 'Call before delivery.',
    revision: sent.revision + 1,
  });
  expect({ ...noted, internalNote: '', revision: 0, updatedAt: '' }).toEqual({
    ...sent,
    internalNote: '',
    revision: 0,
    updatedAt: '',
  });
});

it('revises an issued document back to a draft that keeps its number and issue date', async () => {
  const f = await fixture();
  const sent = await issued(f);
  const revised = await act(f, 'reviseSalesDocument', sent.id);
  expect(revised).toMatchObject({
    status: 'draft',
    number: 'INV-0001',
    seller: null,
    issueDate: '2026-10-12',
    // It has a number now, so it is kept: voided, not deleted.
    actions: ['update', 'issue', 'void', 'duplicate'],
  });
  expect(
    (
      await refusalOf(
        () => api(f, 'deleteSalesDocument', { params: { id: sent.id } }),
        ConflictError,
      )
    ).message,
  ).toBe('This invoice already has a number, so it is kept. Issue it again or void it.');
  expect(
    (await refusalOf(() => act(f, 'reviseSalesDocument', sent.id), ConflictError)).message,
  ).toBe('This invoice is already a draft.');
  // An edit that names no issue date leaves the one it was issued with.
  suite.at('2026-10-20T09:00:00.000Z');
  const edited = await save(f, revised, {
    issueDate: null,
    dueDate: null,
    lines: [line({ quantity: '3' })],
  });
  expect(edited).toMatchObject({ issueDate: '2026-10-12', dueDate: null });
  const again = await issue(f, edited);
  expect(again).toMatchObject({
    status: 'sent',
    number: 'INV-0001',
    issueDate: '2026-10-12',
    dueDate: '2026-10-26',
    totals: { total: '5220.0000' },
  });
  // The number was not taken twice.
  expect((await issued(f)).number).toBe('INV-0002');
  expect((await events(f)).map((event) => event.type)).toEqual([
    'invoice.created',
    'invoice.issued',
    'invoice.revised',
    'invoice.updated',
    'invoice.issued',
    'invoice.created',
    'invoice.issued',
  ]);
});

it('deletes a draft that was never issued, with its lines', async () => {
  const f = await fixture();
  const made = await draft(f);
  expect(await api(f, 'deleteSalesDocument', { params: { id: made.id } })).toBeUndefined();
  await refusalOf(() => read(f, made.id), NotFoundError);
  const left = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ n: number }>('select count(*)::integer as n from commerce.document_lines'),
  );
  expect(left.n).toBe(0);
});

it('marks a sent quote accepted or declined, once, and only a quote', async () => {
  const f = await fixture();
  const quote = await issued(f, 'quote');
  const accepted = await act(f, 'acceptQuote', quote.id);
  expect(accepted).toMatchObject({
    status: 'accepted',
    declinedAt: null,
    actions: ['revise', 'convert', 'duplicate'],
  });
  expect(accepted.acceptedAt).not.toBeNull();
  for (const operationId of ['acceptQuote', 'declineQuote'])
    expect((await refusalOf(() => act(f, operationId, quote.id), ConflictError)).message).toBe(
      'Only a quote that was sent can be answered.',
    );
  const declined = await act(f, 'declineQuote', (await issued(f, 'quote')).id);
  expect(declined).toMatchObject({
    status: 'declined',
    acceptedAt: null,
    actions: ['revise', 'duplicate'],
  });
  expect(declined.declinedAt).not.toBeNull();
  // Revising takes the answer back with it.
  const revised = await act(f, 'reviseSalesDocument', declined.id);
  expect(revised).toMatchObject({ status: 'draft', declinedAt: null, number: 'QUO-0002' });
  const invoice = await issued(f);
  expect((await refusalOf(() => act(f, 'acceptQuote', invoice.id), ConflictError)).message).toBe(
    'Only a quote is accepted or declined.',
  );
  const unsent = await draft(f, 'quote');
  expect((await refusalOf(() => act(f, 'acceptQuote', unsent.id), ConflictError)).message).toBe(
    'Only a quote that was sent can be answered.',
  );
});

it('makes one draft invoice from a quote, with its lines and a link each way, and refuses a second', async () => {
  const f = await fixture();
  const quote = await issued(f, 'quote', {
    lines: [
      line(),
      line({
        name: 'Chairs',
        quantity: '10',
        unitPrice: '50',
        discount: { kind: 'percent', value: '10' },
      }),
    ],
    discount: { kind: 'amount', value: '100' },
    notes: 'As discussed.',
    terms: 'Half up front.',
    billTo: 'Quay Road',
  });
  const invoice = await act(f, 'convertQuoteToInvoice', quote.id);
  expect(invoice).toMatchObject({
    kind: 'invoice',
    status: 'draft',
    number: null,
    quoteId: quote.id,
    invoiceId: null,
    contactId: f.contactId,
    issueDate: null,
    dueDate: null,
    discount: quote.discount,
    notes: 'As discussed.',
    terms: 'Half up front.',
    customer: quote.customer,
    totals: quote.totals,
    seller: null,
  });
  expect(invoice.lines.map(({ id: _id, ...rest }) => rest)).toEqual(
    quote.lines.map(({ id: _id, ...rest }) => rest),
  );
  const linked = await read(f, quote.id);
  expect(linked).toMatchObject({
    invoiceId: invoice.id,
    status: 'sent',
    actions: ['accept', 'decline', 'duplicate'],
  });
  const second = await refusalOf(() => act(f, 'convertQuoteToInvoice', quote.id), ConflictError);
  expect(second.message).toBe('An invoice was already made from this quote.');
  expect(
    (await refusalOf(() => act(f, 'reviseSalesDocument', quote.id), ConflictError)).message,
  ).toBe('An invoice was made from this quote, so it can no longer change.');
  // Two at once on another quote: one invoice.
  const other = await act(f, 'acceptQuote', (await issued(f, 'quote')).id);
  const both = await Promise.all([
    settled(act(f, 'convertQuoteToInvoice', other.id)),
    settled(act(f, 'convertQuoteToInvoice', other.id)),
  ]);
  expect(both.filter((each) => each.ok)).toHaveLength(1);
  expect((await list(f, { kind: 'invoice' })).items).toHaveLength(2);
  // The invoice is its own document: issued, it takes an invoice number.
  expect((await issue(f, invoice)).number).toBe('INV-0001');
  for (const refused of [await draft(f, 'quote'), await issued(f)])
    await refusalOf(() => act(f, 'convertQuoteToInvoice', refused.id), ConflictError);
});

it('voids an unpaid invoice with a reason and keeps it; a void invoice changes no more', async () => {
  const f = await fixture();
  const sent = await issued(f);
  const voided = await act(f, 'voidInvoice', sent.id, { reason: ' Sent to the wrong customer. ' });
  expect(voided).toMatchObject({
    status: 'void',
    number: 'INV-0001',
    voidReason: 'Sent to the wrong customer.',
    actions: ['duplicate'],
    totals: sent.totals,
    overdue: false,
  });
  expect(voided.voidedAt).not.toBeNull();
  for (const [operationId, body, message] of [
    ['voidInvoice', { reason: 'Again' }, 'This invoice is already void.'],
    ['reviseSalesDocument', undefined, 'A void invoice cannot change. Duplicate it instead.'],
  ] as const)
    expect((await refusalOf(() => act(f, operationId, sent.id, body), ConflictError)).message).toBe(
      message,
    );
  const neverIssued = await draft(f);
  expect(
    (await refusalOf(() => act(f, 'voidInvoice', neverIssued.id, { reason: 'x' }), ConflictError))
      .message,
  ).toBe('This draft was never issued. Delete it instead.');
  const quote = await issued(f, 'quote');
  expect(
    (await refusalOf(() => act(f, 'voidInvoice', quote.id, { reason: 'x' }), ConflictError))
      .message,
  ).toBe('Only an invoice is voided.');
  // A draft that has a number is voided too.
  const revised = await act(f, 'reviseSalesDocument', (await issued(f)).id);
  expect(await act(f, 'voidInvoice', revised.id, { reason: 'Replaced.' })).toMatchObject({
    status: 'void',
    number: 'INV-0002',
  });
});

it('copies any document into a new draft of its kind, with nothing of its issue', async () => {
  const f = await fixture();
  const sent = await issued(f, 'invoice', { notes: 'Thanks', dueDate: '2026-12-01' });
  const voided = await act(f, 'voidInvoice', sent.id, { reason: 'Wrong amount.' });
  const copy = await act(f, 'duplicateSalesDocument', voided.id);
  expect(copy.id).not.toBe(sent.id);
  expect(copy).toMatchObject({
    kind: 'invoice',
    status: 'draft',
    number: null,
    issueDate: null,
    dueDate: null,
    quoteId: null,
    seller: null,
    notes: 'Thanks',
    voidReason: null,
    totals: sent.totals,
    revision: 1,
  });
  expect(copy.lines.map(({ id: _id, ...rest }) => rest)).toEqual(
    sent.lines.map(({ id: _id, ...rest }) => rest),
  );
  expect((await act(f, 'duplicateSalesDocument', (await draft(f, 'quote')).id)).kind).toBe('quote');
});

it('lists newest first, by kind, status, lateness, contact, number or name, and issue date', async () => {
  const f = await fixture({ firstName: 'Maya', lastName: 'Thompson' });
  const second = await database.fixtures.contact(f.business.context, {
    firstName: 'Omar',
    lastName: 'Ali',
  });
  const omar = toPublicId('contact', second.id);
  const quoteDraft = await draft(f, 'quote');
  const invoice = await issued(f, 'invoice', { issueDate: '2026-10-01', dueDate: '2026-10-05' });
  const quote = await issued(f, 'quote', {
    contactId: omar,
    issueDate: '2026-10-10',
    dueDate: '2026-10-11',
  });
  const fresh = await issued(f, 'invoice', { contactId: omar });
  const ids = async (query: Record<string, unknown>) =>
    (await list(f, query)).items.map((each) => each.id);

  expect(await ids({})).toEqual([fresh.id, quote.id, invoice.id, quoteDraft.id]);
  expect(await ids({ kind: 'invoice' })).toEqual([fresh.id, invoice.id]);
  expect(await ids({ status: 'draft' })).toEqual([quoteDraft.id]);
  expect(await ids({ status: 'sent', kind: 'quote' })).toEqual([quote.id]);
  // The 12th: the invoice due on the 5th is overdue, the quote good until the 11th expired.
  expect(await ids({ status: 'overdue' })).toEqual([invoice.id]);
  expect(await ids({ status: 'expired' })).toEqual([quote.id]);
  expect(await ids({ contactId: omar })).toEqual([fresh.id, quote.id]);
  expect(await ids({ q: 'inv-0002' })).toEqual([fresh.id]);
  expect(await ids({ q: 'thomp' })).toEqual([invoice.id, quoteDraft.id]);
  expect(await ids({ issuedFrom: '2026-10-02', issuedTo: '2026-10-11' })).toEqual([quote.id]);
  expect(await ids({ dealId: 'deal_01h455vb4pex5vsknk084sn02q' })).toEqual([]);

  const page = await list(f, { limit: '3' });
  expect(page.nextCursor).toBe(invoice.id);
  expect(
    (await list(f, { limit: '3', after: page.nextCursor })).items.map((each) => each.id),
  ).toEqual([quoteDraft.id]);
  const summary = (await list(f, { status: 'overdue' })).items[0];
  expect(summary).toMatchObject({
    kind: 'invoice',
    status: 'sent',
    number: 'INV-0001',
    customerName: 'Maya Thompson',
    total: '3480.0000',
    amountPaid: '0.0000',
    balanceDue: '3480.0000',
    overdue: true,
    expired: false,
  });
  expect(await read(f, invoice.id)).toMatchObject({ overdue: true, expired: false });
  expect(await read(f, quote.id)).toMatchObject({ overdue: false, expired: true });
  // An invoice is due through the whole of its due date.
  suite.at('2026-10-05T12:00:00.000Z');
  expect(await ids({ status: 'overdue' })).toEqual([]);
});

it('shows documents to payments.read and lets payments.manage alone change them', async () => {
  const f = await fixture();
  const quote = await issued(f, 'quote');
  const made = await draft(f);
  const reader = f.withPermissions('payments.read');
  expect(await read(f, made.id, reader)).toMatchObject({ id: made.id, canManage: false });
  expect((await list(f, {}, reader)).canManage).toBe(false);
  for (const work of [
    () => read(f, made.id, f.withPermissions('contacts.manage')),
    () => list(f, {}, f.withPermissions()),
  ])
    expect((await refusalOf(work, ForbiddenError)).permission).toBe('payments.read');
  // payments.manage includes seeing them.
  expect((await read(f, made.id, f.withPermissions('payments.manage'))).canManage).toBe(true);
  const id = { id: made.id };
  for (const work of [
    () => api(f, 'createSalesDocument', { body: { kind: 'quote', ...input(f) } }, reader),
    () => api(f, 'updateSalesDocument', { params: id, body: edit(f, made) }, reader),
    () => api(f, 'deleteSalesDocument', { params: id }, reader),
    () => api(f, 'issueSalesDocument', { params: id, body: { revision: 1 } }, reader),
    () => api(f, 'reviseSalesDocument', { params: { id: quote.id } }, reader),
    () => api(f, 'acceptQuote', { params: { id: quote.id } }, reader),
    () => api(f, 'declineQuote', { params: { id: quote.id } }, reader),
    () => api(f, 'convertQuoteToInvoice', { params: { id: quote.id } }, reader),
    () => api(f, 'voidInvoice', { params: id, body: { reason: 'No' } }, reader),
    () => api(f, 'duplicateSalesDocument', { params: id }, reader),
    () => api(f, 'setSalesDocumentNote', { params: id, body: { internalNote: 'No' } }, reader),
  ])
    expect((await refusalOf(work, ForbiddenError)).permission).toBe('payments.manage');
  expect(await read(f, quote.id)).toEqual(quote);
  expect((await list(f)).items).toHaveLength(2);
});

it('keeps one business’s documents from another, whatever is asked of them', async () => {
  const f = await fixture();
  const other = await fixture();
  const sent = await issued(f);
  const quote = await issued(f, 'quote');
  expect((await list(other)).items).toEqual([]);
  expect((await list(other, { contactId: f.contactId })).items).toEqual([]);
  const id = { id: sent.id };
  for (const work of [
    () => api(other, 'getSalesDocument', { params: id }),
    () =>
      api(other, 'updateSalesDocument', {
        params: id,
        body: edit(other, sent, { contactId: other.contactId }),
      }),
    () => api(other, 'deleteSalesDocument', { params: id }),
    () => api(other, 'issueSalesDocument', { params: id, body: { revision: sent.revision } }),
    () => api(other, 'reviseSalesDocument', { params: id }),
    () => api(other, 'acceptQuote', { params: { id: quote.id } }),
    () => api(other, 'declineQuote', { params: { id: quote.id } }),
    () => api(other, 'convertQuoteToInvoice', { params: { id: quote.id } }),
    () => api(other, 'voidInvoice', { params: id, body: { reason: 'Theirs' } }),
    () => api(other, 'duplicateSalesDocument', { params: id }),
    () => api(other, 'setSalesDocumentNote', { params: id, body: { internalNote: 'Theirs' } }),
  ])
    await refusalOf(work, NotFoundError);
  expect(await read(f, sent.id)).toEqual(sent);
  expect(await read(f, quote.id)).toEqual(quote);
  // Each business numbers its own: the other's first invoice is its number one.
  expect((await issued(other)).number).toBe('INV-0001');
  // And the tables themselves show a business only its own rows.
  const seen = await database.withTenant(other.business.context, (sql) =>
    sql.one<{ documents: number; lines: number; sequences: number }>(
      `select (select count(*)::integer from commerce.documents) as documents,
              (select count(*)::integer from commerce.document_lines) as lines,
              (select count(*)::integer from commerce.sequences) as sequences`,
    ),
  );
  expect(seen).toEqual({ documents: 1, lines: 1, sequences: 1 });
});

it('refuses every change in a business that is not active', async () => {
  const f = await fixture();
  const made = await draft(f);
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [f.business.id]),
  );
  for (const work of [
    () => draft(f),
    () => issue(f, made),
    () =>
      api(f, 'createProduct', {
        body: { kind: 'product', name: 'Chair', unitPrice: '1', currency: 'KES' },
      }),
  ])
    expect((await refusalOf(work, ConflictError)).message).toBe('This business is not active.');
});
