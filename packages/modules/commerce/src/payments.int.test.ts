// Payments and receipts against Postgres, through the module's own routes: the invoice's
// amount paid, balance and status follow each payment in its transaction, nothing is
// recorded beyond what is owed, and a payment is reversed, never deleted.
import {
  commerceSettings,
  paymentList,
  receipt as receiptContract,
  salesDocument,
  type Receipt,
  type SalesDocument,
} from '@repo/contracts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
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

/** An issued invoice of 3,480.00: two hours at 1,500 and 16 percent tax. */
async function invoice(
  f: CommerceFixture,
  change: Record<string, unknown> = {},
  kind: 'invoice' | 'quote' = 'invoice',
): Promise<SalesDocument> {
  const draft = salesDocument.parse(
    await api(f, 'createSalesDocument', {
      body: {
        kind,
        contactId: f.contactId,
        currency: 'KES',
        lines: [{ name: 'Event planning', quantity: '2', unitPrice: '1500', taxRate: '16' }],
        ...change,
      },
    }),
  );
  return salesDocument.parse(
    await api(f, 'issueSalesDocument', {
      params: { id: draft.id },
      body: { revision: draft.revision },
    }),
  );
}
const pay = async (
  f: CommerceFixture,
  id: string,
  amount: string,
  more: Record<string, unknown> = {},
  invocation = f.manager,
): Promise<Receipt> =>
  receiptContract.parse(
    await api(
      f,
      'recordPayment',
      { params: { id }, body: { amount, method: 'mobile_money', ...more } },
      invocation,
    ),
  );
const reverse = async (f: CommerceFixture, id: string, reason = 'Entered twice.') =>
  receiptContract.parse(await api(f, 'reversePayment', { params: { id }, body: { reason } }));
const read = async (f: CommerceFixture, id: string) =>
  salesDocument.parse(await api(f, 'getSalesDocument', { params: { id } }));
const payments = async (
  f: CommerceFixture,
  query: Record<string, unknown> = {},
  invocation = f.manager,
) => paymentList.parse(await api(f, 'listPayments', { query }, invocation));
const stored = (f: CommerceFixture) =>
  database.withTenant(f.business.context, (sql) =>
    sql.one<{ payments: number; paid: string }>(
      `select count(*)::integer as payments,
              coalesce(sum(amount) filter (where status = 'recorded'), 0)::numeric(19, 4)::text as paid
       from commerce.payments`,
    ),
  );

it('records a payment as a receipt: the invoice is partly paid, then paid, in the same step', async () => {
  const f = await fixture();
  const sent = await invoice(f);
  suite.at('2026-10-14T08:00:00.000Z');
  const first = await pay(f, sent.id, '1000', { reference: ' QJK2XY7Z9A ', note: ' Deposit ' });
  expect(first).toMatchObject({
    number: 'RCT-0001',
    invoiceId: sent.id,
    invoiceNumber: 'INV-0001',
    contactId: f.contactId,
    customerName: 'Maya Thompson',
    amount: '1000.0000',
    currency: 'KES',
    // No day named: the day it was recorded, where the business is.
    paidOn: '2026-10-14',
    method: 'mobile_money',
    reference: 'QJK2XY7Z9A',
    note: 'Deposit',
    balanceAfter: '2480.0000',
    status: 'recorded',
    reversedAt: null,
    reversalReason: null,
    seller: sent.seller,
    customer: sent.customer,
    invoice: {
      id: sent.id,
      number: 'INV-0001',
      status: 'partly_paid',
      total: '3480.0000',
      amountPaid: '1000.0000',
      balanceDue: '2480.0000',
    },
    canManage: true,
  });
  expect(first.id).toMatch(/^pay_/);
  const partly = await read(f, sent.id);
  expect(partly).toMatchObject({
    status: 'partly_paid',
    totals: { total: '3480.0000', amountPaid: '1000.0000', balanceDue: '2480.0000' },
    // With a payment on it, it is neither revised nor voided.
    actions: ['record_payment', 'duplicate'],
    revision: sent.revision + 1,
  });
  expect(partly.payments.map(({ number, amount }) => [number, amount])).toEqual([
    ['RCT-0001', '1000.0000'],
  ]);

  const second = await pay(f, sent.id, '2480.00', { method: 'cash', paidOn: '2026-10-13' });
  expect(second).toMatchObject({
    number: 'RCT-0002',
    paidOn: '2026-10-13',
    balanceAfter: '0.0000',
    invoice: { status: 'paid', amountPaid: '3480.0000', balanceDue: '0.0000' },
  });
  const paid = await read(f, sent.id);
  expect(paid).toMatchObject({
    status: 'paid',
    totals: { amountPaid: '3480.0000', balanceDue: '0.0000' },
    actions: ['duplicate'],
    overdue: false,
  });
  expect(paid.payments.map((each) => each.number)).toEqual(['RCT-0001', 'RCT-0002']);
  // What the rows hold agrees with the payments themselves.
  expect(await stored(f)).toEqual({ payments: 2, paid: '3480.0000' });
  const types = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ type: string; subject_kind: string }>(
      `select type, subject_kind from events.events
       where type like 'payment.%' or type = 'invoice.paid' order by recorded_at, id`,
    ),
  );
  expect(types).toEqual([
    { type: 'payment.recorded', subject_kind: 'payment' },
    { type: 'payment.recorded', subject_kind: 'payment' },
    { type: 'invoice.paid', subject_kind: 'sales_document' },
  ]);
});

it('never records more than is owed, an amount of nothing, or a fraction of a cent', async () => {
  const f = await fixture();
  const sent = await invoice(f);
  const refused = async (amount: string) =>
    (await refusalOf(() => pay(f, sent.id, amount), ValidationError)).issues;
  expect(await refused('3480.01')).toEqual([
    {
      path: '/amount',
      code: 'overpayment',
      message: 'This is more than is still owed on the invoice.',
    },
  ]);
  expect((await refused('10.005'))[0]).toMatchObject({ path: '/amount', code: 'amount_precision' });
  expect((await refused('0'))[0]).toMatchObject({ path: '/amount' });
  await pay(f, sent.id, '3000');
  // Against what is left, not against the total.
  expect((await refused('480.01'))[0]).toMatchObject({ code: 'overpayment' });
  expect(await read(f, sent.id)).toMatchObject({
    status: 'partly_paid',
    totals: { amountPaid: '3000.0000', balanceDue: '480.0000' },
  });
  await pay(f, sent.id, '480');
  expect((await refusalOf(() => pay(f, sent.id, '1'), ConflictError)).message).toBe(
    'This invoice is already paid in full.',
  );
  // A refused payment takes no receipt number.
  expect(await stored(f)).toEqual({ payments: 2, paid: '3480.0000' });
  const settings = commerceSettings.parse(await api(f, 'getCommerceSettings'));
  expect(settings.numbering.receipt).toMatchObject({ nextNumber: 3, lastNumber: 2 });
});

it('takes payments at once one after the other, each against what the one before left', async () => {
  const f = await fixture();
  const sent = await invoice(f);
  // Three of 1,500 against 3,480: two fit, the third would overpay.
  const tried = await Promise.all(
    Array.from({ length: 3 }, () => settled(pay(f, sent.id, '1500'))),
  );
  expect(tried.filter((each) => each.ok)).toHaveLength(2);
  const failed = tried.find((each) => !each.ok);
  expect(failed).toMatchObject({ error: expect.any(ValidationError) as unknown });
  const after = await read(f, sent.id);
  expect(after).toMatchObject({
    status: 'partly_paid',
    totals: { amountPaid: '3000.0000', balanceDue: '480.0000' },
  });
  expect(after.payments.map((each) => each.number)).toEqual(['RCT-0001', 'RCT-0002']);
  expect(after.payments.map((each) => each.balanceAfter)).toEqual(['1980.0000', '480.0000']);
});

it('records a payment only against an issued invoice that is not void', async () => {
  const f = await fixture();
  const draft = salesDocument.parse(
    await api(f, 'createSalesDocument', {
      body: { kind: 'invoice', contactId: f.contactId, currency: 'KES', lines: [] },
    }),
  );
  expect((await refusalOf(() => pay(f, draft.id, '1'), ConflictError)).message).toBe(
    'Issue this invoice before recording a payment.',
  );
  const quote = await invoice(f, {}, 'quote');
  expect((await refusalOf(() => pay(f, quote.id, '1'), ConflictError)).message).toBe(
    'A payment is recorded against an invoice.',
  );
  const voided = await invoice(f);
  await api(f, 'voidInvoice', { params: { id: voided.id }, body: { reason: 'Wrong customer.' } });
  expect((await refusalOf(() => pay(f, voided.id, '1'), ConflictError)).message).toBe(
    'This invoice is void.',
  );
  // An invoice that comes to nothing is paid the moment it is issued: nothing is owed.
  const free = await invoice(f, {
    lines: [
      {
        name: 'Gift',
        quantity: '1',
        unitPrice: '100',
        discount: { kind: 'percent', value: '100' },
      },
    ],
  });
  expect(free).toMatchObject({ status: 'paid', totals: { total: '0.0000', balanceDue: '0.0000' } });
  await refusalOf(() => pay(f, free.id, '1'), ConflictError);
  expect(await stored(f)).toEqual({ payments: 0, paid: '0.0000' });
});

it('reverses a payment without deleting it: the invoice owes that amount again', async () => {
  const f = await fixture();
  const sent = await invoice(f);
  const first = await pay(f, sent.id, '1000');
  const second = await pay(f, sent.id, '2480');
  expect((await read(f, sent.id)).status).toBe('paid');

  const undone = await reverse(f, second.id, ' Entered twice. ');
  expect(undone).toMatchObject({
    id: second.id,
    number: 'RCT-0002',
    amount: '2480.0000',
    // What its receipt said when it was recorded stays what it says.
    balanceAfter: '0.0000',
    status: 'reversed',
    reversalReason: 'Entered twice.',
    invoice: { status: 'partly_paid', amountPaid: '1000.0000', balanceDue: '2480.0000' },
  });
  expect(undone.reversedAt).not.toBeNull();
  expect((await refusalOf(() => reverse(f, second.id), ConflictError)).message).toBe(
    'This payment is already reversed.',
  );
  const partly = await read(f, sent.id);
  expect(partly).toMatchObject({
    status: 'partly_paid',
    totals: { amountPaid: '1000.0000', balanceDue: '2480.0000' },
  });
  // Both payments are still there, the reversed one marked.
  expect(partly.payments.map((each) => [each.number, each.status])).toEqual([
    ['RCT-0001', 'recorded'],
    ['RCT-0002', 'reversed'],
  ]);
  await reverse(f, first.id);
  const unpaid = await read(f, sent.id);
  expect(unpaid).toMatchObject({
    status: 'sent',
    totals: { amountPaid: '0.0000', balanceDue: '3480.0000' },
    actions: ['revise', 'void', 'record_payment', 'duplicate'],
  });
  expect(await stored(f)).toEqual({ payments: 2, paid: '0.0000' });
  // A reversed receipt's number is not given out again.
  expect((await pay(f, sent.id, '3480')).number).toBe('RCT-0003');
  // The database keeps a payment as it was recorded, and lets none be deleted (0079).
  for (const statement of [
    `update commerce.payments set amount = 1`,
    `update commerce.payments set status = 'recorded', reversed_at = null, reversal_reason = null,
       reversed_by_kind = null where status = 'reversed'`,
    `delete from commerce.payments`,
  ])
    expect(
      await settled(database.withTenant(f.business.context, (sql) => sql.query(statement))),
    ).toMatchObject({ ok: false });
  expect(await stored(f)).toEqual({ payments: 3, paid: '3480.0000' });
});

it('reads a payment as its receipt and lists payments newest first, by invoice, contact and status', async () => {
  const f = await fixture();
  const a = await invoice(f);
  const b = await invoice(f);
  const one = await pay(f, a.id, '100');
  const two = await pay(f, b.id, '200');
  const three = await pay(f, a.id, '300');
  await reverse(f, one.id);

  const got = receiptContract.parse(await api(f, 'getReceipt', { params: { id: three.id } }));
  expect(got).toMatchObject({
    id: three.id,
    number: 'RCT-0003',
    // As it was when recorded: 3,480 less the 100 and the 300.
    balanceAfter: '3080.0000',
    // The invoice as it stands now: the 100 was reversed since.
    invoice: {
      number: 'INV-0001',
      status: 'partly_paid',
      amountPaid: '300.0000',
      balanceDue: '3180.0000',
    },
    seller: a.seller,
  });
  const numbers = async (query: Record<string, unknown>) =>
    (await payments(f, query)).items.map((each) => each.number);
  expect(await numbers({})).toEqual(['RCT-0003', 'RCT-0002', 'RCT-0001']);
  expect(await numbers({ invoiceId: a.id })).toEqual(['RCT-0003', 'RCT-0001']);
  expect(await numbers({ status: 'reversed' })).toEqual(['RCT-0001']);
  expect(await numbers({ status: 'recorded', invoiceId: b.id })).toEqual(['RCT-0002']);
  expect(await numbers({ contactId: f.contactId })).toHaveLength(3);
  expect(await numbers({ contactId: 'con_01h455vb4pex5vsknk084sn02q' })).toEqual([]);
  const page = await payments(f, { limit: '2' });
  expect(page.nextCursor).toBe(two.id);
  expect(
    (await payments(f, { limit: '2', after: page.nextCursor })).items.map((each) => each.number),
  ).toEqual(['RCT-0001']);
});

it('shows payments to payments.read, keeps recording and reversing to payments.manage, and to their business', async () => {
  const f = await fixture();
  const other = await fixture();
  const sent = await invoice(f);
  const paid = await pay(f, sent.id, '1000');
  const reader = f.withPermissions('payments.read');

  expect((await payments(f, {}, reader)).canManage).toBe(false);
  expect(
    receiptContract.parse(await api(f, 'getReceipt', { params: { id: paid.id } }, reader))
      .canManage,
  ).toBe(false);
  for (const work of [
    () => payments(f, {}, f.withPermissions()),
    () => api(f, 'getReceipt', { params: { id: paid.id } }, f.withPermissions('contacts.manage')),
  ])
    expect((await refusalOf(work, ForbiddenError)).permission).toBe('payments.read');
  for (const work of [
    () => pay(f, sent.id, '1', {}, reader),
    () => api(f, 'reversePayment', { params: { id: paid.id }, body: { reason: 'No' } }, reader),
  ])
    expect((await refusalOf(work, ForbiddenError)).permission).toBe('payments.manage');

  expect((await payments(other)).items).toEqual([]);
  expect((await payments(other, { invoiceId: sent.id })).items).toEqual([]);
  for (const work of [
    () => api(other, 'getReceipt', { params: { id: paid.id } }),
    () =>
      api(other, 'recordPayment', {
        params: { id: sent.id },
        body: { amount: '1', method: 'cash' },
      }),
    () => api(other, 'reversePayment', { params: { id: paid.id }, body: { reason: 'Theirs' } }),
  ])
    await refusalOf(work, NotFoundError);
  expect(await read(f, sent.id)).toMatchObject({
    status: 'partly_paid',
    totals: { amountPaid: '1000.0000' },
  });
  expect(await stored(f)).toEqual({ payments: 1, paid: '1000.0000' });
});
