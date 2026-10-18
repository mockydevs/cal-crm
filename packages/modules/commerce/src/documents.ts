// Quotes and invoices: one family of documents with the same lines, totals, numbering and
// snapshots. A draft is edited freely. Issuing gives it its number, writes down who it is
// from and for as they are that day, and freezes it; after that only its status, its
// payments and the team's own note change. Every amount comes from the one function of the
// contract (computeDocumentTotals) and is stored as it returned it.
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  allowedDocumentActions,
  createSalesDocumentInput,
  documentActionRefusal,
  invoiceStatusFor,
  isExpired,
  isOverdue,
  salesDocumentLinkInput,
  salesDocumentNoteInput,
  salesDocumentRevisionInput,
  updateSalesDocumentInput,
  voidInvoiceInput,
  type DocumentState,
  type Payment,
  type SalesDocument,
  type SalesDocumentAction,
  type SalesDocumentKind,
  type SalesDocumentLink,
  type SalesDocumentList,
  type SalesDocumentStatus,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type Json } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { sql, type RawBuilder } from 'kysely';
import * as z from 'zod';

import { ensureLink, linksAvailable, readLink } from './links.js';
import { readPaymentsOf } from './payment-reads.js';
import {
  dueBeforeIssue,
  fourPlaces,
  issueDates,
  kindOf,
  likePattern,
  lineTotal,
  pricedLines,
  sellerOf,
  shownTotals,
  statusOf,
  storedSeller,
} from './rules.js';
import { storedSettings, takeNumber } from './settings.js';
import {
  actorOf,
  businessToday,
  canManage,
  heldBusiness,
  MANAGE,
  notFound,
  rowId,
  type CommerceOptions,
} from './shared.js';

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

const documents = (trx: DatabaseTransaction) =>
  trx
    .selectFrom('commerce.documents as d')
    .select([
      'd.id',
      'd.kind',
      'd.status',
      'd.number',
      'd.contact_id',
      'd.deal_id',
      'd.source_document_id',
      'd.currency',
      'd.discount_kind',
      'd.discount_value',
      'd.notes',
      'd.terms',
      'd.internal_note',
      'd.customer_name',
      'd.customer_email',
      'd.customer_phone',
      'd.bill_to',
      'd.customer_tax_number',
      'd.seller',
      'd.subtotal',
      'd.discount_total',
      'd.tax_total',
      'd.total',
      'd.amount_paid',
      'd.balance_due',
      'd.issued_at',
      'd.accepted_at',
      'd.declined_at',
      'd.voided_at',
      'd.void_reason',
      'd.sent_at',
      'd.last_sent_at',
      'd.send_count',
      'd.revision',
      'd.created_at',
      'd.updated_at',
    ])
    .select([
      // Calendar days, read as text: they must not pass through a moment in some time zone.
      sql<string | null>`d.issue_date::text`.as('issue_date'),
      sql<string | null>`d.due_date::text`.as('due_date'),
      // On a quote: the invoice made from it, if one was.
      sql<string | null>`(select i.id from commerce.documents i
        where i.business_id = d.business_id and i.source_document_id = d.id)`.as('invoice_id'),
    ]);

/** A document's row as its reads and its commands hold it. */
export interface DocumentRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly number: string | null;
  readonly contact_id: string | null;
  readonly deal_id: string | null;
  readonly source_document_id: string | null;
  readonly currency: string;
  readonly discount_kind: string | null;
  readonly discount_value: string | null;
  readonly notes: string;
  readonly terms: string;
  readonly internal_note: string;
  readonly customer_name: string;
  readonly customer_email: string | null;
  readonly customer_phone: string | null;
  readonly bill_to: string;
  readonly customer_tax_number: string | null;
  readonly seller: unknown;
  readonly subtotal: string;
  readonly discount_total: string;
  readonly tax_total: string;
  readonly total: string;
  readonly amount_paid: string;
  readonly balance_due: string;
  readonly issued_at: Date | null;
  readonly accepted_at: Date | null;
  readonly declined_at: Date | null;
  readonly voided_at: Date | null;
  readonly void_reason: string | null;
  readonly sent_at: Date | null;
  readonly last_sent_at: Date | null;
  readonly send_count: number;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly issue_date: string | null;
  readonly due_date: string | null;
  /** On a quote: the invoice made from it, if one was. */
  readonly invoice_id: string | null;
}

/** As much of a document as its rules read. */
export const stateOf = (row: DocumentRow): DocumentState => ({
  kind: kindOf(row.kind),
  status: statusOf(row.status),
  number: row.number,
  amountPaid: row.amount_paid,
  converted: row.invoice_id !== null,
});

const discountOf = (kind: string | null, value: string | null): SalesDocument['discount'] =>
  kind === null || value === null
    ? null
    : { kind: kind === 'percent' ? 'percent' : 'amount', value: fourPlaces(value) };

const lateness = (
  row: DocumentRow,
  today: string,
): { readonly overdue: boolean; readonly expired: boolean } => {
  const state = {
    kind: kindOf(row.kind),
    status: statusOf(row.status),
    dueDate: row.due_date,
    balanceDue: row.balance_due,
  };
  return { overdue: isOverdue(state, today), expired: isExpired(state, today) };
};

async function present(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: DocumentRow,
  today: string,
): Promise<SalesDocument> {
  const lines = await trx
    .selectFrom('commerce.document_lines')
    .selectAll()
    .where('document_id', '=', row.id)
    .orderBy('position')
    .execute();
  const kind = kindOf(row.kind);
  const status = statusOf(row.status);
  const payments: Payment[] = kind === 'invoice' ? await readPaymentsOf(trx, row.id) : [];
  return {
    id: toPublicId('sales_document', row.id),
    kind,
    status,
    number: row.number,
    contactId: row.contact_id === null ? null : toPublicId('contact', row.contact_id),
    dealId: row.deal_id === null ? null : toPublicId('deal', row.deal_id),
    quoteId:
      row.source_document_id === null ? null : toPublicId('sales_document', row.source_document_id),
    invoiceId: row.invoice_id === null ? null : toPublicId('sales_document', row.invoice_id),
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    customer: {
      name: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
      billTo: row.bill_to,
      taxNumber: row.customer_tax_number,
    },
    // A draft is shown with the business as it is now; what an earlier issue wrote down is
    // replaced when the draft is issued again.
    seller: status === 'draft' ? null : storedSeller(row.seller),
    lines: lines.map((line) => ({
      id: toPublicId('sales_document_line', line.id),
      position: line.position,
      productId: line.product_id === null ? null : toPublicId('product', line.product_id),
      name: line.name,
      description: line.description,
      quantity: fourPlaces(line.quantity),
      unit: line.unit,
      unitPrice: fourPlaces(line.unit_price),
      discount: discountOf(line.discount_kind, line.discount_value),
      taxRate: fourPlaces(line.tax_rate),
      amount: fourPlaces(line.amount),
      discountAmount: fourPlaces(line.discount_amount),
      taxableAmount: fourPlaces(line.taxable_amount),
      taxAmount: fourPlaces(line.tax_amount),
      total: lineTotal(line.taxable_amount, line.tax_amount),
    })),
    discount: discountOf(row.discount_kind, row.discount_value),
    notes: row.notes,
    terms: row.terms,
    internalNote: row.internal_note,
    totals: shownTotals(
      {
        subtotal: row.subtotal,
        discountTotal: row.discount_total,
        taxTotal: row.tax_total,
        total: row.total,
        amountPaid: row.amount_paid,
        balanceDue: row.balance_due,
      },
      lines.map((line) => ({
        taxRate: line.tax_rate,
        discountAmount: line.discount_amount,
        taxableAmount: line.taxable_amount,
        taxAmount: line.tax_amount,
      })),
    ),
    ...lateness(row, today),
    issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
    acceptedAt: row.accepted_at === null ? null : row.accepted_at.toISOString(),
    declinedAt: row.declined_at === null ? null : row.declined_at.toISOString(),
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    voidReason: row.void_reason,
    sentAt: row.sent_at === null ? null : row.sent_at.toISOString(),
    lastSentAt: row.last_sent_at === null ? null : row.last_sent_at.toISOString(),
    sendCount: row.send_count,
    // Only a document in force has a public address. One revised back to a draft keeps its
    // row, and the same address answers again once it is issued; a void one's opens nothing.
    publicLink:
      status === 'draft' || status === 'void' ? null : await readLink(options, trx, row.id),
    payments,
    actions: allowedDocumentActions(stateOf(row)),
    revision: row.revision,
    canManage: canManage(invocation),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** One quote or invoice with its lines, totals and payments. */
export async function readDocument(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<SalesDocument> {
  requireBusiness(invocation.context);
  const row = await documents(trx)
    .where('d.id', '=', rowId('sales_document', publicId))
    .executeTakeFirst();
  if (row === undefined) throw notFound('sales_document', publicId);
  const { today } = await businessToday(options, trx, invocation);
  return present(options, trx, invocation, row, today);
}

export interface DocumentListInput {
  readonly kind?: SalesDocumentKind | undefined;
  readonly status: SalesDocumentStatus | 'all' | 'overdue' | 'expired';
  readonly contactId?: string | undefined;
  readonly dealId?: string | undefined;
  readonly q?: string | undefined;
  readonly issuedFrom?: string | undefined;
  readonly issuedTo?: string | undefined;
  readonly after?: string | undefined;
  readonly limit: number;
}

/** Quotes and invoices, newest first, narrowed by kind, status or lateness, and whose. */
export async function readDocuments(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: DocumentListInput,
): Promise<SalesDocumentList> {
  requireBusiness(invocation.context);
  const { today } = await businessToday(options, trx, invocation);
  let query = documents(trx).orderBy('d.id', 'desc');
  if (input.kind !== undefined) query = query.where('d.kind', '=', input.kind);
  if (input.status === 'overdue')
    query = query
      .where('d.kind', '=', 'invoice')
      .where('d.status', 'in', ['sent', 'partly_paid'])
      .where(sql<boolean>`d.due_date < ${today}::date`)
      .where('d.balance_due', '>', '0');
  else if (input.status === 'expired')
    query = query
      .where('d.kind', '=', 'quote')
      .where('d.status', '=', 'sent')
      .where(sql<boolean>`d.due_date < ${today}::date`);
  else if (input.status !== 'all') query = query.where('d.status', '=', input.status);
  if (input.contactId !== undefined)
    query = query.where('d.contact_id', '=', rowId('contact', input.contactId));
  if (input.dealId !== undefined)
    query = query.where('d.deal_id', '=', rowId('deal', input.dealId));
  if (input.q !== undefined && input.q !== '') {
    const pattern = likePattern(input.q);
    query = query.where((where) =>
      where.or([
        where(sql<string>`lower(d.number)`, 'like', pattern),
        where(sql<string>`lower(d.customer_name)`, 'like', pattern),
      ]),
    );
  }
  if (input.issuedFrom !== undefined)
    query = query.where(sql<boolean>`d.issue_date >= ${input.issuedFrom}::date`);
  if (input.issuedTo !== undefined)
    query = query.where(sql<boolean>`d.issue_date <= ${input.issuedTo}::date`);
  if (input.after !== undefined)
    query = query.where('d.id', '<', rowId('sales_document', input.after));
  const found = await query.limit(input.limit + 1).execute();
  const rows = found.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      id: toPublicId('sales_document', row.id),
      kind: kindOf(row.kind),
      status: statusOf(row.status),
      number: row.number,
      contactId: row.contact_id === null ? null : toPublicId('contact', row.contact_id),
      customerName: row.customer_name,
      dealId: row.deal_id === null ? null : toPublicId('deal', row.deal_id),
      currency: row.currency,
      issueDate: row.issue_date,
      dueDate: row.due_date,
      total: fourPlaces(row.total),
      amountPaid: fourPlaces(row.amount_paid),
      balanceDue: fourPlaces(row.balance_due),
      ...lateness(row, today),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })),
    nextCursor:
      found.length > input.limit && last !== undefined
        ? toPublicId('sales_document', last.id)
        : null,
    canManage: canManage(invocation),
  };
}

/** The document's row, held until the command ends. */
export async function lockedDocument(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<DocumentRow> {
  const row = await documents(trx)
    .where('d.id', '=', rowId('sales_document', publicId))
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw notFound('sales_document', publicId);
  return row;
}

/** Refuses the action when the document, as it stands, does not allow it. */
export function requireAction(action: SalesDocumentAction, row: DocumentRow): void {
  const refusal = documentActionRefusal(action, stateOf(row));
  if (refusal !== undefined) throw new ConflictError(refusal);
}

export const stale = (): ConflictError =>
  new ConflictError('This document changed since you opened it. Reload before saving.');

const refuse = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

/** The records whose timelines show what happened to a document: its contact and its deal. */
export const recordsOf = (row: {
  readonly contact_id: string | null;
  readonly deal_id: string | null;
}): string[] => [row.contact_id, row.deal_id].filter((id) => id !== null);

/** The longest name commerce.documents.customer_name holds (0079). */
const CUSTOMER_NAME_LENGTH = 300;

interface Customer {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * Who a document is for, as the contact is now. A contact the business does not have, or
 * one in the trash, is refused where it was named.
 */
async function customerOf(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  contactId: string,
): Promise<Customer> {
  const contact = await options.contacts
    .read(trx, invocation, contactId)
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    });
  if (contact === undefined)
    throw refuse('/contactId', 'unknown_contact', 'This contact was not found.');
  if (contact.trashedAt !== null)
    throw refuse(
      '/contactId',
      'contact_trashed',
      'This contact is in the trash. Restore it first.',
    );
  return {
    id: rowId('contact', contactId),
    // A name as long as the column holds: a longer one is cut, never refused.
    name: (contact.name ?? '').slice(0, CUSTOMER_NAME_LENGTH),
    email: contact.emails[0] ?? null,
    phone: contact.phones[0]?.number ?? null,
  };
}

/** The deal a document belongs to, which must be one of the business's. */
async function dealOf(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  invocation: Invocation,
  dealId: string | null,
): Promise<string | null> {
  if (dealId === null) return null;
  await options.deals.read(trx, invocation, dealId).catch((error: unknown) => {
    if (error instanceof NotFoundError)
      throw refuse('/dealId', 'unknown_deal', 'This opportunity was not found.');
    throw error;
  });
  return rowId('deal', dealId);
}

type DocumentValues = z.output<typeof updateSalesDocumentInput>;

/**
 * Writes the document's lines and the amounts they come to, replacing the lines it had.
 * The arithmetic is the contract's; this stores what it returns.
 */
async function writeLines(
  trx: DatabaseTransaction,
  businessId: string,
  documentId: string,
  values: Pick<DocumentValues, 'currency' | 'lines' | 'discount'>,
): Promise<{
  readonly subtotal: string;
  readonly discount_total: string;
  readonly tax_total: string;
  readonly total: string;
}> {
  const priced = pricedLines(values);
  // Each product a line names is one of the business's, and stays while the line is written.
  const rows = priced.lines.map(({ line, amounts }) => ({
    line,
    amounts,
    productId: line.productId === null ? null : rowId('product', line.productId),
  }));
  const named = [
    ...new Set(rows.flatMap((row) => (row.productId === null ? [] : [row.productId]))),
  ];
  const known =
    named.length === 0
      ? []
      : await trx
          .selectFrom('commerce.products')
          .select('id')
          .where('id', 'in', named)
          .forKeyShare()
          .execute();
  const have = new Set(known.map((row) => row.id));
  const missing = rows.flatMap((row, index): Issue[] =>
    row.productId !== null && !have.has(row.productId)
      ? [
          {
            path: `/lines/${String(index)}/productId`,
            code: 'unknown_product',
            message: 'This product was not found.',
          },
        ]
      : [],
  );
  const [firstMissing, ...otherMissing] = missing;
  if (firstMissing !== undefined) throw new ValidationError([firstMissing, ...otherMissing]);

  await trx.deleteFrom('commerce.document_lines').where('document_id', '=', documentId).execute();
  if (rows.length > 0)
    await trx
      .insertInto('commerce.document_lines')
      .values(
        rows.map(({ line, amounts, productId }, index) => ({
          business_id: businessId,
          document_id: documentId,
          position: index,
          product_id: productId,
          name: line.name,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unit_price: line.unitPrice,
          discount_kind: line.discount?.kind ?? null,
          discount_value: line.discount?.value ?? null,
          tax_rate: line.taxRate ?? '0',
          amount: amounts.amount,
          discount_amount: amounts.discount,
          taxable_amount: amounts.taxable,
          tax_amount: amounts.tax,
        })),
      )
      .execute();
  return {
    subtotal: priced.totals.subtotal,
    discount_total: priced.totals.discountTotal,
    tax_total: priced.totals.taxTotal,
    total: priced.totals.total,
  };
}

/** A number another document of the kind already has: possible only after a prefix change. */
const numberTaken = explainUniqueViolation({
  documents_number_unique: () =>
    new ConflictError(
      'Another document already has the next number. Change the prefix or the next number in the settings.',
    ),
});

/** What accepting, declining or revising a document writes. */
interface StatusChange {
  readonly status: SalesDocumentStatus;
  readonly accepted_at?: RawBuilder<Date> | null;
  readonly declined_at?: RawBuilder<Date> | null;
}

const updateWithId = z.strictObject({ id: z.string(), values: updateSalesDocumentInput });
const revisionWithId = salesDocumentRevisionInput.extend({ id: z.string() });
const idOnly = z.strictObject({ id: z.string() });
const voidWithId = voidInvoiceInput.extend({ id: z.string() });
const noteWithId = salesDocumentNoteInput.extend({ id: z.string() });
const linkWithId = salesDocumentLinkInput.extend({ id: z.string() });

export interface DocumentCommands {
  readonly create: Command<typeof createSalesDocumentInput, SalesDocument>;
  readonly update: Command<typeof updateWithId, SalesDocument>;
  readonly remove: Command<typeof idOnly, undefined>;
  readonly issue: Command<typeof revisionWithId, SalesDocument>;
  readonly revise: Command<typeof idOnly, SalesDocument>;
  readonly accept: Command<typeof idOnly, SalesDocument>;
  readonly decline: Command<typeof idOnly, SalesDocument>;
  readonly convert: Command<typeof idOnly, SalesDocument>;
  readonly void: Command<typeof voidWithId, SalesDocument>;
  readonly duplicate: Command<typeof idOnly, SalesDocument>;
  readonly setNote: Command<typeof noteWithId, SalesDocument>;
  readonly link: Command<typeof linkWithId, SalesDocumentLink>;
}

/** What the audit log keeps of a document's values: what it is, not every line's words. */
const auditOf = (values: Pick<DocumentValues, 'contactId' | 'dealId' | 'currency' | 'lines'>) => ({
  contactId: values.contactId,
  dealId: values.dealId,
  currency: values.currency,
  lines: values.lines.length,
});

export function createDocumentCommands(options: CommerceOptions): DocumentCommands {
  const reread = async (
    trx: DatabaseTransaction,
    command: CommandContext,
    id: string,
  ): Promise<SalesDocument> =>
    readDocument(options, trx, command, toPublicId('sales_document', id));

  const create = defineCommand({
    name: 'sales_document.create',
    permission: MANAGE,
    input: createSalesDocumentInput,
    audit: (input) => ({ kind: input.kind, ...auditOf(input) }),
    async handle(trx, input, command): Promise<SalesDocument> {
      const businessId = await heldBusiness(options, trx, command);
      const customer = await customerOf(options, trx, command, input.contactId);
      const dealId = await dealOf(options, trx, command, input.dealId);
      if (dueBeforeIssue(input.issueDate, input.dueDate))
        throw refuse('/dueDate', 'before_issue', 'The due date is before the issue date.');
      const settings = await storedSettings(trx, businessId);
      const actor = actorOf(command.context);
      const row = await trx
        .insertInto('commerce.documents')
        .values({
          business_id: businessId,
          kind: input.kind,
          contact_id: customer.id,
          deal_id: dealId,
          currency: input.currency,
          issue_date: input.issueDate,
          due_date: input.dueDate,
          discount_kind: input.discount?.kind ?? null,
          discount_value: input.discount?.value ?? null,
          notes: input.notes ?? settings.defaultNotes,
          terms: input.terms ?? settings.defaultTerms,
          customer_name: customer.name,
          customer_email: customer.email,
          customer_phone: customer.phone,
          bill_to: input.billTo,
          customer_tax_number: input.customerTaxNumber,
          created_by_kind: actor.kind,
          created_by_id: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const totals = await writeLines(trx, businessId, row.id, input);
      await trx
        .updateTable('commerce.documents')
        .set({ ...totals, balance_due: totals.total })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: `${input.kind}.created`,
        subject: { kind: 'sales_document', id: row.id },
        payload: { total: totals.total, currency: input.currency },
      });
      return reread(trx, command, row.id);
    },
  });

  const update = defineCommand({
    name: 'sales_document.update',
    permission: MANAGE,
    input: updateWithId,
    audit: ({ id, values }) => ({ id, revision: values.revision, ...auditOf(values) }),
    async handle(trx, { id, values }, command): Promise<SalesDocument> {
      const businessId = await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, id);
      if (row.revision !== values.revision) throw stale();
      requireAction('update', row);
      const customer = await customerOf(options, trx, command, values.contactId);
      const dealId = await dealOf(options, trx, command, values.dealId);
      // A draft that was issued before keeps the date it was issued with unless another
      // is named: its number was given out that day.
      const issueDate = values.issueDate ?? (row.number === null ? null : row.issue_date);
      if (dueBeforeIssue(issueDate, values.dueDate))
        throw refuse('/dueDate', 'before_issue', 'The due date is before the issue date.');
      const totals = await writeLines(trx, businessId, row.id, values);
      await trx
        .updateTable('commerce.documents')
        .set({
          contact_id: customer.id,
          deal_id: dealId,
          currency: values.currency,
          issue_date: issueDate,
          due_date: values.dueDate,
          discount_kind: values.discount?.kind ?? null,
          discount_value: values.discount?.value ?? null,
          // Left out of an edit, the notes and terms stay as they are.
          ...(values.notes === undefined ? {} : { notes: values.notes }),
          ...(values.terms === undefined ? {} : { terms: values.terms }),
          customer_name: customer.name,
          customer_email: customer.email,
          customer_phone: customer.phone,
          bill_to: values.billTo,
          customer_tax_number: values.customerTaxNumber,
          ...totals,
          balance_due: totals.total,
          revision: row.revision + 1,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: `${row.kind}.updated`,
        subject: { kind: 'sales_document', id: row.id },
        payload: { total: totals.total, currency: values.currency },
      });
      return reread(trx, command, row.id);
    },
  });

  const remove = defineCommand({
    name: 'sales_document.delete',
    permission: MANAGE,
    input: idOnly,
    async handle(trx, input, command): Promise<undefined> {
      await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, input.id);
      requireAction('delete', row);
      // Its lines go with it.
      await trx.deleteFrom('commerce.documents').where('id', '=', row.id).execute();
      await command.emit({
        type: `${row.kind}.deleted`,
        subject: { kind: 'sales_document', id: row.id },
      });
      return undefined;
    },
  });

  const issue = defineCommand({
    name: 'sales_document.issue',
    permission: MANAGE,
    input: revisionWithId,
    async handle(trx, input, command): Promise<SalesDocument> {
      const businessId = await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, input.id);
      if (row.revision !== input.revision) throw stale();
      requireAction('issue', row);
      const kind = kindOf(row.kind);
      const lines = await trx
        .selectFrom('commerce.document_lines')
        .select(sql<string>`count(*)::text`.as('count'))
        .where('document_id', '=', row.id)
        .executeTakeFirstOrThrow();
      if (lines.count === '0')
        throw new ConflictError(`Add at least one line before issuing this ${kind}.`);
      if (row.contact_id === null)
        throw new ConflictError('The contact this was for is gone. Choose a contact first.');
      // Who it is for and who it is from, as they are now: written down for good.
      const customer = await customerOf(
        options,
        trx,
        command,
        toPublicId('contact', row.contact_id),
      ).catch((error: unknown) => {
        if (error instanceof ValidationError) throw new ConflictError(error.issues[0].message);
        throw error;
      });
      const { today, profile } = await businessToday(options, trx, command);
      const settings = await storedSettings(trx, businessId);
      const dates = issueDates(
        kind,
        { issueDate: row.issue_date, dueDate: row.due_date },
        today,
        settings,
      );
      if (dueBeforeIssue(dates.issueDate, dates.dueDate))
        throw new ConflictError('The due date is before the issue date. Change one of them first.');
      // A document issued before keeps its number; a new one takes the next, here, in the
      // transaction that writes it.
      const numbered = row.number === null ? await takeNumber(trx, businessId, kind) : undefined;
      // An invoice that comes to nothing is paid the moment it is issued.
      const status = kind === 'quote' ? 'sent' : invoiceStatusFor(row.total, '0');
      await trx
        .updateTable('commerce.documents')
        .set({
          status,
          ...(numbered === undefined
            ? {}
            : { number: numbered.number, sequence_number: numbered.sequence }),
          issue_date: dates.issueDate,
          due_date: dates.dueDate,
          customer_name: customer.name,
          customer_email: customer.email,
          customer_phone: customer.phone,
          seller: asJson(sellerOf(profile, settings)),
          issued_at: sql<Date>`now()`,
          revision: row.revision + 1,
        })
        .where('id', '=', row.id)
        .execute()
        .catch(numberTaken);
      // Its public address, where the install serves public pages: there from the moment
      // it is issued, so a screen can offer it at once. One issued again keeps its own.
      if (linksAvailable(options)) await ensureLink(options, trx, command, businessId, row.id);
      const payload = {
        number: numbered?.number ?? row.number,
        total: fourPlaces(row.total),
        currency: row.currency,
      };
      await command.emit({
        type: `${kind}.issued`,
        subject: { kind: 'sales_document', id: row.id },
        payload,
        records: recordsOf(row),
      });
      if (status === 'paid')
        await command.emit({
          type: 'invoice.paid',
          subject: { kind: 'sales_document', id: row.id },
          payload,
          records: recordsOf(row),
        });
      return reread(trx, command, row.id);
    },
  });

  /** A change of an issued document's status, which leaves everything it says alone. */
  const transition = (
    name: string,
    action: SalesDocumentAction,
    event: (kind: SalesDocumentKind) => string,
    change: () => StatusChange,
  ): Command<typeof idOnly, SalesDocument> =>
    defineCommand({
      name,
      permission: MANAGE,
      input: idOnly,
      async handle(trx, input, command): Promise<SalesDocument> {
        await heldBusiness(options, trx, command);
        const row = await lockedDocument(trx, input.id);
        requireAction(action, row);
        await trx
          .updateTable('commerce.documents')
          .set({ ...change(), revision: row.revision + 1 })
          .where('id', '=', row.id)
          .execute();
        await command.emit({
          type: event(kindOf(row.kind)),
          subject: { kind: 'sales_document', id: row.id },
          payload: { number: row.number },
          records: recordsOf(row),
        });
        return reread(trx, command, row.id);
      },
    });

  /** Copies a document's values and lines into a new draft. */
  async function copy(
    trx: DatabaseTransaction,
    command: CommandContext,
    businessId: string,
    row: DocumentRow,
    into: { readonly kind: SalesDocumentKind; readonly sourceDocumentId: string | null },
  ): Promise<string> {
    if (row.contact_id === null)
      throw new ConflictError('The contact this was for is gone, so it cannot be copied.');
    const actor = actorOf(command.context);
    const made = await trx
      .insertInto('commerce.documents')
      .values({
        business_id: businessId,
        kind: into.kind,
        contact_id: row.contact_id,
        deal_id: row.deal_id,
        source_document_id: into.sourceDocumentId,
        currency: row.currency,
        discount_kind: row.discount_kind,
        discount_value: row.discount_value,
        notes: row.notes,
        terms: row.terms,
        customer_name: row.customer_name,
        customer_email: row.customer_email,
        customer_phone: row.customer_phone,
        bill_to: row.bill_to,
        customer_tax_number: row.customer_tax_number,
        subtotal: row.subtotal,
        discount_total: row.discount_total,
        tax_total: row.tax_total,
        total: row.total,
        balance_due: row.total,
        created_by_kind: actor.kind,
        created_by_id: actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      insert into commerce.document_lines
        (business_id, document_id, position, product_id, name, description, quantity, unit,
         unit_price, discount_kind, discount_value, tax_rate, amount, discount_amount,
         taxable_amount, tax_amount)
      select business_id, ${made.id}::uuid, position, product_id, name, description, quantity,
             unit, unit_price, discount_kind, discount_value, tax_rate, amount, discount_amount,
             taxable_amount, tax_amount
      from commerce.document_lines
      where business_id = ${businessId}::uuid and document_id = ${row.id}::uuid
    `.execute(trx);
    return made.id;
  }

  const convert = defineCommand({
    name: 'sales_document.convert',
    permission: MANAGE,
    input: idOnly,
    async handle(trx, input, command): Promise<SalesDocument> {
      const businessId = await heldBusiness(options, trx, command);
      // The quote's row is held, so two conversions at once make one invoice.
      const row = await lockedDocument(trx, input.id);
      requireAction('convert', row);
      const invoiceId = await copy(trx, command, businessId, row, {
        kind: 'invoice',
        sourceDocumentId: row.id,
      });
      await trx
        .updateTable('commerce.documents')
        .set({ revision: row.revision + 1 })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'quote.converted',
        subject: { kind: 'sales_document', id: row.id },
        payload: { number: row.number, invoiceId: toPublicId('sales_document', invoiceId) },
        records: recordsOf(row),
      });
      await command.emit({
        type: 'invoice.created',
        subject: { kind: 'sales_document', id: invoiceId },
        payload: {
          total: fourPlaces(row.total),
          currency: row.currency,
          quoteId: toPublicId('sales_document', row.id),
        },
      });
      return reread(trx, command, invoiceId);
    },
  });

  const duplicate = defineCommand({
    name: 'sales_document.duplicate',
    permission: MANAGE,
    input: idOnly,
    async handle(trx, input, command): Promise<SalesDocument> {
      const businessId = await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, input.id);
      requireAction('duplicate', row);
      const kind = kindOf(row.kind);
      const copyId = await copy(trx, command, businessId, row, { kind, sourceDocumentId: null });
      await command.emit({
        type: `${kind}.created`,
        subject: { kind: 'sales_document', id: copyId },
        payload: {
          total: fourPlaces(row.total),
          currency: row.currency,
          copiedFrom: toPublicId('sales_document', row.id),
        },
      });
      return reread(trx, command, copyId);
    },
  });

  const voidInvoice = defineCommand({
    name: 'sales_document.void',
    permission: MANAGE,
    input: voidWithId,
    async handle(trx, input, command): Promise<SalesDocument> {
      await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, input.id);
      requireAction('void', row);
      await trx
        .updateTable('commerce.documents')
        .set({
          status: 'void',
          voided_at: sql<Date>`now()`,
          void_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'invoice.voided',
        subject: { kind: 'sales_document', id: row.id },
        payload: { number: row.number, reason: input.reason },
        records: recordsOf(row),
      });
      return reread(trx, command, row.id);
    },
  });

  const setNote = defineCommand({
    name: 'sales_document.set_note',
    permission: MANAGE,
    input: noteWithId,
    // The note is the team's own words: the audit log keeps that it changed, not what it says.
    audit: ({ id }) => ({ id }),
    async handle(trx, input, command): Promise<SalesDocument> {
      await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, input.id);
      await trx
        .updateTable('commerce.documents')
        .set({ internal_note: input.internalNote, revision: row.revision + 1 })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: `${row.kind}.note_updated`,
        subject: { kind: 'sales_document', id: row.id },
      });
      return reread(trx, command, row.id);
    },
  });

  const link = defineCommand({
    name: 'sales_document.link',
    permission: MANAGE,
    input: linkWithId,
    async handle(trx, input, command): Promise<SalesDocumentLink> {
      const businessId = await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, input.id);
      const noun = kindOf(row.kind);
      if (row.status === 'draft')
        throw new ConflictError(`Issue this ${noun} first: a draft has no public address.`);
      if (row.status === 'void') throw new ConflictError('A void invoice has no public address.');
      const made = await ensureLink(options, trx, command, businessId, row.id, input.regenerate);
      if (made.made)
        await command.emit({
          type: `${noun}.link_created`,
          subject: { kind: 'sales_document', id: row.id },
          // Never the address: whoever reads events must not be able to open the document.
          payload: { number: row.number, replaced: input.regenerate },
        });
      return made.link;
    },
  });

  return {
    create,
    update,
    remove,
    issue,
    revise: transition(
      'sales_document.revise',
      'revise',
      (kind) => `${kind}.revised`,
      // Back to a draft with the number it has. What its issue wrote down stays in the row
      // until it is issued again, and an answer to a quote is taken back.
      () => ({ status: 'draft', accepted_at: null, declined_at: null }),
    ),
    accept: transition(
      'sales_document.accept',
      'accept',
      () => 'quote.accepted',
      () => ({ status: 'accepted', accepted_at: sql<Date>`now()` }),
    ),
    decline: transition(
      'sales_document.decline',
      'decline',
      () => 'quote.declined',
      () => ({ status: 'declined', declined_at: sql<Date>`now()` }),
    ),
    convert,
    void: voidInvoice,
    duplicate,
    setNote,
    link,
  };
}
