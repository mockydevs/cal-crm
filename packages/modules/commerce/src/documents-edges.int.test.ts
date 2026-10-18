// The edges of quotes, invoices and payments against Postgres: a document on an
// opportunity, a contact with no name or one deleted for good, dates the wrong way round, a
// counter with no number left, and work done by the system rather than a person.
import {
  commerceSettings,
  MAX_SEQUENCE_NUMBER,
  paymentList,
  product as productContract,
  receipt as receiptContract,
  salesDocument,
  salesDocumentList,
  type SalesDocument,
} from '@repo/contracts';
import { ConflictError, toPublicId, ValidationError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, beforeEach, expect, it } from 'vitest';

import { commerceSuite, NOW, refusalOf, type CommerceFixture } from '../test/commerce-fixtures.js';

const suite = commerceSuite();
const { fixture, api } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});
beforeEach(() => {
  suite.at(NOW);
});

const values = (f: CommerceFixture, change: Record<string, unknown> = {}) => ({
  contactId: f.contactId,
  currency: 'KES',
  lines: [{ name: 'Event planning', quantity: '2', unitPrice: '1500', taxRate: '16' }],
  ...change,
});
const draft = async (
  f: CommerceFixture,
  kind: 'quote' | 'invoice' = 'invoice',
  change: Record<string, unknown> = {},
  invocation = f.manager,
): Promise<SalesDocument> =>
  salesDocument.parse(
    await api(f, 'createSalesDocument', { body: { kind, ...values(f, change) } }, invocation),
  );
const issue = async (f: CommerceFixture, current: SalesDocument, invocation = f.manager) =>
  salesDocument.parse(
    await api(
      f,
      'issueSalesDocument',
      { params: { id: current.id }, body: { revision: current.revision } },
      invocation,
    ),
  );
const read = async (f: CommerceFixture, id: string) =>
  salesDocument.parse(await api(f, 'getSalesDocument', { params: { id } }));

/** An opportunity of the business, added directly, by its public id. */
async function deal(f: CommerceFixture): Promise<{ id: string; publicId: string }> {
  const row = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         select app.business_id(), 'deal', id from crm.object_types where kind = 'deal'
         returning id
       ), pipeline as (
         insert into crm.pipelines (business_id, name) values (app.business_id(), 'Events')
         returning id
       ), stage as (
         insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
         select app.business_id(), id, 'New lead', 0 from pipeline returning id, pipeline_id
       )
       insert into crm.deals (business_id, id, name, pipeline_id, stage_id, amount, currency, created_by_kind)
       select app.business_id(), record.id, 'Thompson wedding', stage.pipeline_id, stage.id, 3480, 'KES', 'system'
       from record, stage returning id`,
    ),
  );
  return { id: row.id, publicId: toPublicId('deal', row.id) };
}

it('belongs to an opportunity: listed by it, and what happens to it shows on the opportunity', async () => {
  const f = await fixture();
  const won = await deal(f);
  const made = await draft(f, 'quote', { dealId: won.publicId });
  expect(made.dealId).toBe(won.publicId);
  await draft(f, 'quote');
  const listed = salesDocumentList.parse(
    await api(f, 'listSalesDocuments', { query: { dealId: won.publicId } }),
  );
  expect(listed.items.map((each) => [each.id, each.dealId])).toEqual([[made.id, won.publicId]]);
  const sent = await issue(f, made);
  const invoice = salesDocument.parse(
    await api(f, 'convertQuoteToInvoice', { params: { id: sent.id } }),
  );
  expect(invoice.dealId).toBe(won.publicId);
  const timeline = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ event_type: string }>(
      'select event_type from crm.timeline_entries where record_id = $1 order by occurred_at, event_id',
      [won.id],
    ),
  );
  expect(timeline.map((entry) => entry.event_type)).toEqual(['quote.issued', 'quote.converted']);
  // An edit may take the document off the opportunity again.
  const edited = salesDocument.parse(
    await api(f, 'updateSalesDocument', {
      params: { id: invoice.id },
      body: { ...values(f), dealId: null, terms: 'Half up front.', revision: invoice.revision },
    }),
  );
  expect(edited).toMatchObject({ dealId: null, terms: 'Half up front.' });
});

it('is written for a contact with no name or address, with nothing made up', async () => {
  const f = await fixture({});
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set first_name = null, last_name = null where id = $1', [
      f.contact.id,
    ]),
  );
  const made = await draft(f);
  expect(made.customer).toEqual({
    name: '',
    email: null,
    phone: null,
    billTo: '',
    taxNumber: null,
  });
  expect((await issue(f, made)).customer.name).toBe('');
});

it('keeps a document whose contact was deleted for good, and still says who it was for', async () => {
  const f = await fixture();
  const sent = await issue(f, await draft(f));
  const paid = receiptContract.parse(
    await api(f, 'recordPayment', {
      params: { id: sent.id },
      body: { amount: '1000', method: 'cash' },
    }),
  );
  const waiting = await draft(f, 'quote');
  // The contact's own events go with them; the documents stay.
  await database.as('crm_owner', async (sql) => {
    await sql.query('delete from crm.timeline_entries where record_id = $1', [f.contact.id]);
    await sql.query('delete from crm.records where id = $1', [f.contact.id]);
  });
  const kept = await read(f, sent.id);
  expect(kept).toMatchObject({
    contactId: null,
    number: 'INV-0001',
    customer: { name: 'Maya Thompson', email: 'maya@example.com' },
    status: 'partly_paid',
  });
  const listed = salesDocumentList.parse(await api(f, 'listSalesDocuments'));
  expect(listed.items.map((each) => [each.contactId, each.customerName])).toEqual([
    [null, 'Maya Thompson'],
    [null, 'Maya Thompson'],
  ]);
  const payments = paymentList.parse(await api(f, 'listPayments'));
  expect(payments.items).toMatchObject([
    { id: paid.id, contactId: null, customerName: 'Maya Thompson' },
  ]);
  // Money still received against it is still recorded.
  const more = receiptContract.parse(
    await api(f, 'recordPayment', {
      params: { id: sent.id },
      body: { amount: '2480', method: 'cash' },
    }),
  );
  expect(more.invoice.status).toBe('paid');
  // A draft with nobody to send it to is neither issued nor copied until it names someone.
  expect((await refusalOf(() => issue(f, waiting), ConflictError)).message).toBe(
    'The contact this was for is gone. Choose a contact first.',
  );
  expect(
    (
      await refusalOf(
        () => api(f, 'duplicateSalesDocument', { params: { id: waiting.id } }),
        ConflictError,
      )
    ).message,
  ).toBe('The contact this was for is gone, so it cannot be copied.');
});

it('refuses a due date before the issue date, on an edit and at the issue', async () => {
  const f = await fixture();
  const made = await draft(f, 'invoice', { dueDate: '2026-10-01' });
  const refused = await refusalOf(
    () =>
      api(f, 'updateSalesDocument', {
        params: { id: made.id },
        body: {
          ...values(f),
          issueDate: '2026-10-05',
          dueDate: '2026-10-01',
          revision: made.revision,
        },
      }),
    ValidationError,
  );
  expect(refused.issues).toEqual([
    {
      path: '/dueDate',
      code: 'before_issue',
      message: 'The due date is before the issue date.',
    },
  ]);
  // It names no issue date, so that is today, the 12th: after the day it says it is due.
  expect((await refusalOf(() => issue(f, made), ConflictError)).message).toBe(
    'The due date is before the issue date. Change one of them first.',
  );
  expect(await read(f, made.id)).toMatchObject({ status: 'draft', number: null, revision: 1 });
});

it('stops issuing when a counter has no number left, and says where to change it', async () => {
  const f = await fixture();
  const settings = commerceSettings.parse(await api(f, 'getCommerceSettings'));
  await api(f, 'updateCommerceSettings', {
    body: {
      numbering: {
        quote: { prefix: 'QUO-' },
        invoice: { prefix: 'INV-', nextNumber: MAX_SEQUENCE_NUMBER },
        receipt: { prefix: 'RCT-' },
      },
      paymentTermsDays: 14,
      quoteValidityDays: 30,
      defaultNotes: '',
      defaultTerms: '',
      paymentInstructions: '',
      taxNumber: null,
      defaultTaxRate: null,
      revision: settings.revision,
    },
  });
  const made = await draft(f);
  expect((await refusalOf(() => issue(f, made), ConflictError)).message).toBe(
    'This counter has no number left. Change the numbering in the settings.',
  );
  expect((await read(f, made.id)).number).toBeNull();
});

it('is written by the system as by a person: an automation or a job acts with no user', async () => {
  const f = await fixture();
  const system = { context: f.business.context, permissions: 'all' as const };
  const made = productContract.parse(
    await api(
      f,
      'createProduct',
      { body: { kind: 'product', name: 'Chair', unitPrice: '50', currency: 'KES' } },
      system,
    ),
  );
  const sent = await issue(
    f,
    await draft(
      f,
      'invoice',
      { lines: [{ productId: made.id, name: 'Chair', quantity: '4', unitPrice: '50' }] },
      system,
    ),
    system,
  );
  const paid = receiptContract.parse(
    await api(
      f,
      'recordPayment',
      { params: { id: sent.id }, body: { amount: '200', method: 'bank_transfer' } },
      system,
    ),
  );
  await api(f, 'reversePayment', { params: { id: paid.id }, body: { reason: 'Bounced.' } }, system);
  const actors = await database.withTenant(f.business.context, (sql) =>
    sql.one<Record<string, string | null>>(
      `select (select created_by_kind || ':' || coalesce(created_by_id::text, '-') from commerce.products) as product,
              (select created_by_kind || ':' || coalesce(created_by_id::text, '-') from commerce.documents) as document,
              (select recorded_by_kind || ':' || coalesce(recorded_by_id::text, '-') from commerce.payments) as recorded,
              (select reversed_by_kind || ':' || coalesce(reversed_by_id::text, '-') from commerce.payments) as reversed`,
    ),
  );
  expect(actors).toEqual({
    product: 'system:-',
    document: 'system:-',
    recorded: 'system:-',
    reversed: 'system:-',
  });
});
