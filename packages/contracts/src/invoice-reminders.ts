// Invoice reminders (Invoices → Settings → Reminder Settings, as GoHighLevel has it):
// emails that remind a customer about an invoice they haven't paid, before or after its due
// date or the date it was sent. Each reminder applies only to invoices sent after it was
// turned on.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { timestamp } from './timestamps.js';

export const INVOICE_REMINDER_LIMITS = {
  maxReminders: 20,
  maxSends: 20,
  maxAmount: 365,
  nameLength: 100,
  subjectLength: 200,
  bodyLength: 5000,
} as const;

export const invoiceReminderUnits = ['hours', 'days', 'months'] as const;
export type InvoiceReminderUnit = (typeof invoiceReminderUnits)[number];

export const invoiceReminderDirections = ['before', 'after'] as const;
export type InvoiceReminderDirection = (typeof invoiceReminderDirections)[number];

export const invoiceReminderAnchors = ['due_date', 'sent_date'] as const;
export type InvoiceReminderAnchor = (typeof invoiceReminderAnchors)[number];

export const INVOICE_REMINDER_MERGE_FIELDS = [
  'invoice.number',
  'invoice.url',
  'invoice.total',
  'invoice.due_date',
  'contact.name',
  'business.name',
] as const;

export const INVOICE_REMINDER_ALLOWED_MERGE_FIELDS: ReadonlySet<string> = new Set([
  ...INVOICE_REMINDER_MERGE_FIELDS,
  'invoice.dueDate',
  'customer.name',
  'seller.name',
]);

const MERGE_TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*[^}]+)?\s*\}\}/g;

export function unknownMergeFields(text: string): string[] {
  const matches = [...text.matchAll(MERGE_TOKEN)];
  const unknown: string[] = [];
  for (const match of matches) {
    const token = match[1];
    if (token !== undefined && !INVOICE_REMINDER_ALLOWED_MERGE_FIELDS.has(token)) {
      unknown.push(token);
    }
  }
  return [...new Set(unknown)];
}

function validateReminder(
  direction: InvoiceReminderDirection | undefined,
  anchor: InvoiceReminderAnchor | undefined,
  subject: string | undefined,
  body: string | undefined,
  ctx: z.RefinementCtx,
): void {
  if (direction === 'before' && anchor !== undefined && anchor !== 'due_date') {
    ctx.addIssue({
      code: 'custom',
      message: 'A reminder before its date can only be before the due date.',
      path: ['anchor'],
    });
  }
  if (subject !== undefined) {
    const unknown = unknownMergeFields(subject);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Unknown merge field in subject: ${unknown.join(', ')}.`,
        path: ['subject'],
      });
    }
  }
  if (body !== undefined) {
    const unknown = unknownMergeFields(body);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Unknown merge field in body: ${unknown.join(', ')}.`,
        path: ['body'],
      });
    }
  }
}

const nameSchema = z
  .string()
  .trim()
  .min(1, { error: 'Give the reminder a name.' })
  .max(INVOICE_REMINDER_LIMITS.nameLength, {
    error: `Use at most ${String(INVOICE_REMINDER_LIMITS.nameLength)} characters.`,
  });

const subjectSchema = z
  .string()
  .trim()
  .min(1, { error: 'Give the email a subject.' })
  .max(INVOICE_REMINDER_LIMITS.subjectLength, {
    error: `Use at most ${String(INVOICE_REMINDER_LIMITS.subjectLength)} characters.`,
  });

const bodySchema = z
  .string()
  .min(1, { error: 'Write the reminder message.' })
  .max(INVOICE_REMINDER_LIMITS.bodyLength, {
    error: `Use at most ${String(INVOICE_REMINDER_LIMITS.bodyLength)} characters.`,
  });

const everyAmountSchema = z.int().min(1).max(INVOICE_REMINDER_LIMITS.maxAmount);
const everyUnitSchema = z.enum(invoiceReminderUnits);
const directionSchema = z.enum(invoiceReminderDirections);
const anchorSchema = z.enum(invoiceReminderAnchors);
const maxSendsSchema = z.int().min(1).max(INVOICE_REMINDER_LIMITS.maxSends);

export const createInvoiceReminderInput = z
  .strictObject({
    name: nameSchema,
    enabled: z.boolean().default(true),
    everyAmount: everyAmountSchema,
    everyUnit: everyUnitSchema,
    direction: directionSchema,
    anchor: anchorSchema,
    maxSends: maxSendsSchema.default(3),
    subject: subjectSchema,
    body: bodySchema,
  })
  .superRefine((data, ctx) => {
    validateReminder(data.direction, data.anchor, data.subject, data.body, ctx);
  })
  .meta({ id: 'CreateInvoiceReminderInput' });
export type CreateInvoiceReminderInput = z.input<typeof createInvoiceReminderInput>;

export const updateInvoiceReminderInput = z
  .strictObject({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    everyAmount: everyAmountSchema.optional(),
    everyUnit: everyUnitSchema.optional(),
    direction: directionSchema.optional(),
    anchor: anchorSchema.optional(),
    maxSends: maxSendsSchema.optional(),
    subject: subjectSchema.optional(),
    body: bodySchema.optional(),
    updatedAt: timestamp.meta({
      description: 'The moment it was read at: a stale one returns 409 and changes nothing.',
    }),
  })
  .superRefine((data, ctx) => {
    validateReminder(data.direction, data.anchor, data.subject, data.body, ctx);
  })
  .meta({ id: 'UpdateInvoiceReminderInput' });
export type UpdateInvoiceReminderInput = z.input<typeof updateInvoiceReminderInput>;

export const invoiceReminder = z
  .looseObject({
    id: z.uuid(),
    name: z.string(),
    enabled: z.boolean(),
    enabledSince: timestamp,
    everyAmount: everyAmountSchema,
    everyUnit: everyUnitSchema,
    direction: directionSchema,
    anchor: anchorSchema,
    maxSends: maxSendsSchema,
    subject: z.string(),
    body: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'InvoiceReminder' });
export type InvoiceReminder = z.output<typeof invoiceReminder>;

export const invoiceReminderList = z
  .looseObject({
    items: z.array(invoiceReminder),
  })
  .meta({ id: 'InvoiceReminderList', description: "The business's invoice reminders." });
export type InvoiceReminderList = z.output<typeof invoiceReminderList>;

export const invoiceReminderParams = z
  .strictObject({
    id: z.uuid().meta({ description: 'The invoice reminder id.' }),
  })
  .meta({ id: 'InvoiceReminderParams' });

const group = 'Payments';

export const listInvoiceReminders = defineEndpoint({
  operationId: 'listInvoiceReminders',
  method: 'get',
  path: '/invoice-reminders',
  summary: 'List invoice reminders',
  group,
  response: {
    status: 200,
    description: 'The invoice reminders.',
    schema: invoiceReminderList,
  },
});

export const createInvoiceReminder = defineEndpoint({
  operationId: 'createInvoiceReminder',
  method: 'post',
  path: '/invoice-reminders',
  summary: 'Create an invoice reminder',
  group,
  body: createInvoiceReminderInput,
  response: {
    status: 201,
    description: 'The created invoice reminder.',
    schema: invoiceReminder,
  },
});

export const updateInvoiceReminder = defineEndpoint({
  operationId: 'updateInvoiceReminder',
  method: 'patch',
  path: '/invoice-reminders/{id}',
  summary: 'Update an invoice reminder',
  group,
  params: invoiceReminderParams,
  body: updateInvoiceReminderInput,
  response: {
    status: 200,
    description: 'The updated invoice reminder.',
    schema: invoiceReminder,
  },
});

export const deleteInvoiceReminder = defineEndpoint({
  operationId: 'deleteInvoiceReminder',
  method: 'delete',
  path: '/invoice-reminders/{id}',
  summary: 'Delete an invoice reminder',
  group,
  params: invoiceReminderParams,
  response: {
    status: 204,
    description: 'The invoice reminder was deleted.',
  },
});

export const invoiceReminderEndpoints = [
  listInvoiceReminders,
  createInvoiceReminder,
  updateInvoiceReminder,
  deleteInvoiceReminder,
] as const;
