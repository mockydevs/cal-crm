// The commerce module's invoice reminders: settings and the periodic sweep that emails
// customers about unpaid invoices.
import { randomUUID } from 'node:crypto';

import {
  defineCommand,
  type Command,
  type CommandContext,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  createInvoiceReminderInput,
  formatMoney,
  INVOICE_REMINDER_LIMITS,
  updateInvoiceReminderInput,
  type InvoiceReminder,
  type InvoiceReminderList,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { ensureLink, linksAvailable } from './links.js';
import { printedDate } from './print.js';
import { heldBusiness, MANAGE, type CommerceOptions } from './shared.js';

const oneLine = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

/** Replaces allowed merge field tokens in subject and body templates. */
export function fillReminderTemplate(
  template: string,
  values: {
    readonly invoiceNumber: string;
    readonly invoiceUrl: string;
    readonly invoiceTotal: string;
    readonly invoiceDueDate: string;
    readonly contactName: string;
    readonly businessName: string;
  },
): string {
  return template.replaceAll(
    /\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*[^}]+)?\s*\}\}/g,
    (match, token) => {
      switch (token) {
        case 'invoice.number':
          return values.invoiceNumber;
        case 'invoice.url':
          return values.invoiceUrl;
        case 'invoice.total':
          return values.invoiceTotal;
        case 'invoice.due_date':
        case 'invoice.dueDate':
          return values.invoiceDueDate;
        case 'contact.name':
        case 'customer.name':
          return values.contactName;
        case 'business.name':
        case 'seller.name':
          return values.businessName;
        default:
          return match;
      }
    },
  );
}

/** Computes the time when step k is due for a reminder. */
export function computeStepTime(
  anchor: Date,
  direction: 'before' | 'after',
  everyAmount: number,
  everyUnit: 'hours' | 'days' | 'months',
  k: number,
): Date {
  const result = new Date(anchor.getTime());
  const sign = direction === 'before' ? -1 : 1;
  const count = sign * k * everyAmount;
  if (everyUnit === 'hours') {
    result.setTime(result.getTime() + count * 3_600_000);
  } else if (everyUnit === 'days') {
    result.setUTCDate(result.getUTCDate() + count);
  } else {
    result.setUTCMonth(result.getUTCMonth() + count);
  }
  return result;
}

function reminderOf(row: {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly enabled_since: Date;
  readonly every_amount: number;
  readonly every_unit: string;
  readonly direction: string;
  readonly anchor: string;
  readonly max_sends: number;
  readonly subject: string;
  readonly body: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}): InvoiceReminder {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    enabledSince: row.enabled_since.toISOString(),
    everyAmount: row.every_amount,
    everyUnit: row.every_unit as 'hours' | 'days' | 'months',
    direction: row.direction as 'before' | 'after',
    anchor: row.anchor as 'due_date' | 'sent_date',
    maxSends: row.max_sends,
    subject: row.subject,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The business's invoice reminders, ordered by creation time. */
export async function readInvoiceReminders(
  trx: DatabaseTransaction,
  _invocation: Invocation,
  businessId: string,
): Promise<InvoiceReminderList> {
  const rows = await trx
    .selectFrom('commerce.invoice_reminders')
    .selectAll()
    .where('business_id', '=', businessId)
    .orderBy('created_at', 'asc')
    .execute();
  return {
    items: rows.map(reminderOf),
  };
}

export type CreateInvoiceReminderCommand = Command<
  typeof createInvoiceReminderInput,
  InvoiceReminder
>;

export function createInvoiceReminderCommand(
  options: CommerceOptions,
): CreateInvoiceReminderCommand {
  return defineCommand({
    name: 'invoice_reminder.create',
    permission: MANAGE,
    input: createInvoiceReminderInput,
    async handle(trx, input, command): Promise<InvoiceReminder> {
      const businessId = await heldBusiness(options, trx, command);
      const countRow = await trx
        .selectFrom('commerce.invoice_reminders')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('business_id', '=', businessId)
        .executeTakeFirst();
      if ((countRow?.count ?? 0) >= INVOICE_REMINDER_LIMITS.maxReminders) {
        throw new ConflictError(
          `A business may have at most ${String(INVOICE_REMINDER_LIMITS.maxReminders)} invoice reminders.`,
        );
      }
      const now = (options.now ?? (() => new Date()))();
      const row = await trx
        .insertInto('commerce.invoice_reminders')
        .values({
          business_id: businessId,
          name: input.name,
          enabled: input.enabled,
          enabled_since: now,
          every_amount: input.everyAmount,
          every_unit: input.everyUnit,
          direction: input.direction,
          anchor: input.anchor,
          max_sends: input.maxSends,
          subject: input.subject,
          body: input.body,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await command.emit({
        type: 'commerce.invoice_reminder_created',
        subject: { kind: 'business', id: businessId },
      });

      return reminderOf(row);
    },
  });
}

const updateInvoiceReminderParamsInput = z.strictObject({
  id: z.uuid(),
  values: updateInvoiceReminderInput,
});

export type UpdateInvoiceReminderCommand = Command<
  typeof updateInvoiceReminderParamsInput,
  InvoiceReminder
>;

export function createUpdateInvoiceReminderCommand(
  options: CommerceOptions,
): UpdateInvoiceReminderCommand {
  return defineCommand({
    name: 'invoice_reminder.update',
    permission: MANAGE,
    input: updateInvoiceReminderParamsInput,
    async handle(trx, { id, values }, command): Promise<InvoiceReminder> {
      const businessId = await heldBusiness(options, trx, command);
      const existing = await trx
        .selectFrom('commerce.invoice_reminders')
        .selectAll()
        .where('business_id', '=', businessId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (existing === undefined) {
        throw new NotFoundError('Invoice reminder', id);
      }
      if (existing.updated_at.toISOString() !== values.updatedAt) {
        throw new ConflictError(
          'This invoice reminder changed since you opened it. Reload before saving.',
        );
      }
      const now = (options.now ?? (() => new Date()))();
      // Turning a reminder from off to on sets enabled_since = now()
      const turningOn = !existing.enabled && values.enabled === true;
      const enabledSince = turningOn ? now : existing.enabled_since;

      const nextDirection = values.direction ?? existing.direction;
      const nextAnchor = values.anchor ?? existing.anchor;
      if (nextDirection === 'before' && nextAnchor !== 'due_date') {
        throw new ConflictError('A reminder before its date can only use the invoice due date.');
      }

      const row = await trx
        .updateTable('commerce.invoice_reminders')
        .set({
          name: values.name ?? existing.name,
          enabled: values.enabled ?? existing.enabled,
          enabled_since: enabledSince,
          every_amount: values.everyAmount ?? existing.every_amount,
          every_unit: values.everyUnit ?? existing.every_unit,
          direction: values.direction ?? existing.direction,
          anchor: values.anchor ?? existing.anchor,
          max_sends: values.maxSends ?? existing.max_sends,
          subject: values.subject ?? existing.subject,
          body: values.body ?? existing.body,
          updated_at: now,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await command.emit({
        type: 'commerce.invoice_reminder_updated',
        subject: { kind: 'business', id: businessId },
      });

      return reminderOf(row);
    },
  });
}

const deleteInvoiceReminderParamsInput = z.strictObject({
  id: z.uuid(),
});

export type DeleteInvoiceReminderCommand = Command<
  typeof deleteInvoiceReminderParamsInput,
  undefined
>;

export function createDeleteInvoiceReminderCommand(
  options: CommerceOptions,
): DeleteInvoiceReminderCommand {
  return defineCommand({
    name: 'invoice_reminder.delete',
    permission: MANAGE,
    input: deleteInvoiceReminderParamsInput,
    async handle(trx, { id }, command): Promise<undefined> {
      const businessId = await heldBusiness(options, trx, command);
      const result = await trx
        .deleteFrom('commerce.invoice_reminders')
        .where('business_id', '=', businessId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        throw new NotFoundError('Invoice reminder', id);
      }
      await command.emit({
        type: 'commerce.invoice_reminder_deleted',
        subject: { kind: 'business', id: businessId },
      });
      return undefined;
    },
  });
}

export interface InvoiceReminderCommands {
  readonly create: CreateInvoiceReminderCommand;
  readonly update: UpdateInvoiceReminderCommand;
  readonly delete: DeleteInvoiceReminderCommand;
}

export function createInvoiceReminderCommands(options: CommerceOptions): InvoiceReminderCommands {
  return {
    create: createInvoiceReminderCommand(options),
    update: createUpdateInvoiceReminderCommand(options),
    delete: createDeleteInvoiceReminderCommand(options),
  };
}

/** Sweeps one business for due invoice reminders, sending at most 500 emails. */
async function sweepBusiness(
  trx: DatabaseTransaction,
  agencyId: string,
  businessId: string,
  now: Date,
  options: CommerceOptions,
): Promise<number> {
  const mail = options.mail;
  if (mail === undefined) return 0;

  const reminders = await trx
    .selectFrom('commerce.invoice_reminders')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('enabled', '=', true)
    .orderBy('created_at', 'asc')
    .execute();

  if (reminders.length === 0) return 0;

  const tenantContext: TenantContext = {
    agencyId,
    businessId,
    actorKind: 'system',
    correlationId: randomUUID(),
  };

  const commandContext: CommandContext = {
    context: tenantContext,
    permissions: 'all',
    emit: () => Promise.resolve(''),
    enqueue: () => undefined,
  };

  const profile = await options.business.profile(trx, {
    context: tenantContext,
    permissions: 'all',
  });

  let businessSentCount = 0;
  const sentInvoicesInRun = new Set<string>();

  for (const reminder of reminders) {
    if (businessSentCount >= 500) break;

    const rows = await sql<{
      id: string;
      number: string | null;
      contact_id: string;
      customer_name: string;
      customer_email: string | null;
      due_date: string | null;
      due_at: Date | null;
      sent_at: Date;
      total: string;
      currency: string;
      recipient_email: string | null;
    }>`
      select d.id, d.number, d.contact_id, d.customer_name, d.customer_email,
             d.due_date::text as due_date,
             (d.due_date::timestamp at time zone b.timezone) as due_at,
             d.sent_at, d.total::text as total, d.currency,
             (
               select ci.value
               from crm.contact_identities ci
               where ci.business_id = d.business_id
                 and ci.contact_id = d.contact_id
                 and ci.kind = 'email'
               order by (ci.value = d.customer_email) desc, ci.is_primary desc, ci.created_at asc
               limit 1
             ) as recipient_email
      from commerce.documents d
      join tenancy.businesses b on b.id = d.business_id
      where d.business_id = ${businessId}
        and d.kind = 'invoice'
        and d.status in ('sent', 'partly_paid')
        and d.sent_at is not null
        and d.sent_at >= ${reminder.enabled_since}
        and d.contact_id is not null
        ${reminder.anchor === 'due_date' ? sql`and d.due_date is not null` : sql``}
      order by d.created_at asc
    `.execute(trx);

    for (const invoice of rows.rows) {
      if (businessSentCount >= 500) break;
      if (sentInvoicesInRun.has(invoice.id)) continue;
      if (!invoice.recipient_email) continue;

      let anchorDate: Date;
      if (reminder.anchor === 'due_date') {
        if (!invoice.due_at) continue;
        anchorDate = new Date(invoice.due_at);
      } else {
        anchorDate = new Date(invoice.sent_at);
      }

      const maxK = reminder.direction === 'before' ? 1 : reminder.max_sends;
      let lowestDueStep: number | null = null;

      for (let k = 1; k <= maxK; k++) {
        const stepTime = computeStepTime(
          anchorDate,
          reminder.direction as 'before' | 'after',
          reminder.every_amount,
          reminder.every_unit as 'hours' | 'days' | 'months',
          k,
        );
        if (stepTime.getTime() > now.getTime()) {
          break;
        }

        const sendExists = await trx
          .selectFrom('commerce.invoice_reminder_sends')
          .select('step')
          .where('business_id', '=', businessId)
          .where('reminder_id', '=', reminder.id)
          .where('document_id', '=', invoice.id)
          .where('step', '=', k)
          .executeTakeFirst();

        if (sendExists === undefined) {
          lowestDueStep = k;
          break;
        }
      }

      if (lowestDueStep === null) continue;

      const step = lowestDueStep;
      sentInvoicesInRun.add(invoice.id);

      const link = linksAvailable(options)
        ? (await ensureLink(options, trx, commandContext, businessId, invoice.id)).link
        : null;

      const values = {
        invoiceNumber: invoice.number ?? '',
        invoiceUrl: link?.url ?? '',
        invoiceTotal: formatMoney(invoice.total, invoice.currency),
        invoiceDueDate: invoice.due_date ? printedDate(invoice.due_date) : '',
        contactName: invoice.customer_name,
        businessName: profile.name,
      };

      const subject = oneLine(fillReminderTemplate(reminder.subject, values)).slice(0, 200);
      const text = fillReminderTemplate(reminder.body, values);

      const address = { contactId: invoice.contact_id, to: invoice.recipient_email };

      const check = await mail.check(trx, tenantContext, address);
      if (check !== undefined) continue;

      const idempotencyKey = `commerce:reminder:${reminder.id}:${invoice.id}:${String(step)}`;
      const queued = await mail.send(trx, tenantContext, {
        contactId: invoice.contact_id,
        to: invoice.recipient_email,
        idempotencyKey,
        subject,
        text,
        attachments: [],
      });

      if (queued.outcome === 'refused') continue;

      const messageUuid = parsePublicId('message', queued.messageId) ?? queued.messageId;

      const inserted = await trx
        .insertInto('commerce.invoice_reminder_sends')
        .values({
          business_id: businessId,
          reminder_id: reminder.id,
          document_id: invoice.id,
          step,
          message_id: messageUuid,
          sent_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['business_id', 'reminder_id', 'document_id', 'step']).doNothing(),
        )
        .returning('step')
        .executeTakeFirst();

      if (inserted === undefined) {
        continue;
      }
      businessSentCount++;
    }
  }

  return businessSentCount;
}

/**
 * Sweeps all businesses with active invoice reminders and delivers due reminder emails.
 * Reminders stop once an invoice is paid or void.
 */
export async function sendInvoiceRemindersSweep(
  services: Services,
  options: CommerceOptions,
): Promise<number> {
  if (options.mail === undefined) return 0;

  const { rows: businesses } = await sql<{ agency_id: string; business_id: string }>`
    select agency_id, business_id from private.businesses_with_invoice_reminders(100)
  `.execute(services.db);

  let totalSent = 0;
  const now = (options.now ?? (() => new Date()))();

  for (const b of businesses) {
    const sentForBusiness = await withTenant<number>(
      services.db,
      {
        agencyId: b.agency_id,
        businessId: b.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      },
      (trx) => sweepBusiness(trx, b.agency_id, b.business_id, now, options),
    );
    totalSent += sentForBusiness;
  }

  return totalSent;
}
