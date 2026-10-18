// A payment as it is stored and as the API shows it: read by the payments' own routes and
// by the invoice the payment was recorded against.
import { requireBusiness, type Invocation } from '@repo/commands';
import type { Payment, PaymentList, Receipt } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { fourPlaces, invoiceStatusOf, methodOf, receiptSeller } from './rules.js';
import { canManage, notFound, rowId } from './shared.js';

const payments = (trx: DatabaseTransaction) =>
  trx
    .selectFrom('commerce.payments as p')
    .innerJoin('commerce.documents as d', (join) =>
      join.onRef('d.business_id', '=', 'p.business_id').onRef('d.id', '=', 'p.document_id'),
    )
    .select([
      'p.id',
      'p.number',
      'p.document_id',
      'p.amount',
      'p.currency',
      'p.method',
      'p.reference',
      'p.note',
      'p.balance_after',
      'p.status',
      'p.reversed_at',
      'p.reversal_reason',
      'p.last_sent_at',
      'p.send_count',
      'p.created_at',
      'd.number as invoice_number',
      'd.contact_id',
      'd.customer_name',
    ])
    .select(sql<string>`p.paid_on::text`.as('paid_on'));

type PaymentRow = Awaited<ReturnType<ReturnType<typeof payments>['executeTakeFirstOrThrow']>>;

function presentPayment(row: PaymentRow): Payment {
  return {
    id: toPublicId('payment', row.id),
    number: row.number,
    invoiceId: toPublicId('sales_document', row.document_id),
    // A payment is recorded against an issued invoice, and a number is kept for good.
    invoiceNumber: row.invoice_number ?? '',
    contactId: row.contact_id === null ? null : toPublicId('contact', row.contact_id),
    customerName: row.customer_name,
    amount: fourPlaces(row.amount),
    currency: row.currency,
    paidOn: row.paid_on,
    method: methodOf(row.method),
    reference: row.reference,
    note: row.note,
    balanceAfter: fourPlaces(row.balance_after),
    status: row.status === 'reversed' ? 'reversed' : 'recorded',
    reversedAt: row.reversed_at === null ? null : row.reversed_at.toISOString(),
    reversalReason: row.reversal_reason,
    lastSentAt: row.last_sent_at === null ? null : row.last_sent_at.toISOString(),
    sendCount: row.send_count,
    createdAt: row.created_at.toISOString(),
  };
}

/** An invoice's payments, oldest first, reversed ones included. */
export async function readPaymentsOf(
  trx: DatabaseTransaction,
  documentId: string,
): Promise<Payment[]> {
  const rows = await payments(trx)
    .where('p.document_id', '=', documentId)
    .orderBy('p.id')
    .execute();
  return rows.map(presentPayment);
}

/** Payments received, newest first: an invoice's, a contact's, recorded or reversed. */
export async function readPayments(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: {
    readonly invoiceId?: string | undefined;
    readonly contactId?: string | undefined;
    readonly status: 'all' | 'recorded' | 'reversed';
    readonly after?: string | undefined;
    readonly limit: number;
  },
): Promise<PaymentList> {
  requireBusiness(invocation.context);
  let query = payments(trx).orderBy('p.id', 'desc');
  if (input.invoiceId !== undefined)
    query = query.where('p.document_id', '=', rowId('sales_document', input.invoiceId));
  if (input.contactId !== undefined)
    query = query.where('d.contact_id', '=', rowId('contact', input.contactId));
  if (input.status !== 'all') query = query.where('p.status', '=', input.status);
  if (input.after !== undefined) query = query.where('p.id', '<', rowId('payment', input.after));
  const found = await query.limit(input.limit + 1).execute();
  const rows = found.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(presentPayment),
    nextCursor:
      found.length > input.limit && last !== undefined ? toPublicId('payment', last.id) : null,
    canManage: canManage(invocation),
  };
}

/**
 * A payment as its receipt: who it is from and for as the invoice's issue wrote them down,
 * and where the invoice stands now.
 */
export async function readReceipt(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<Receipt> {
  requireBusiness(invocation.context);
  const row = await payments(trx)
    .select([
      'd.seller',
      'd.status as invoice_status',
      'd.customer_email',
      'd.customer_phone',
      'd.bill_to',
      'd.customer_tax_number',
      'd.total',
      'd.amount_paid',
      'd.balance_due',
    ])
    .select([
      sql<string | null>`d.issue_date::text`.as('issue_date'),
      sql<string | null>`d.due_date::text`.as('due_date'),
    ])
    .where('p.id', '=', rowId('payment', publicId))
    .executeTakeFirst();
  if (row === undefined) throw notFound('payment', publicId);
  return {
    ...presentPayment(row),
    seller: receiptSeller(row.seller),
    customer: {
      name: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
      billTo: row.bill_to,
      taxNumber: row.customer_tax_number,
    },
    invoice: {
      id: toPublicId('sales_document', row.document_id),
      number: row.invoice_number ?? '',
      status: invoiceStatusOf(row.invoice_status),
      issueDate: row.issue_date,
      dueDate: row.due_date,
      total: fourPlaces(row.total),
      amountPaid: fourPlaces(row.amount_paid),
      balanceDue: fourPlaces(row.balance_due),
    },
    canManage: canManage(invocation),
  };
}
