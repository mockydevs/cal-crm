import { describe, expect, it } from 'vitest';

import {
  createInvoiceReminderInput,
  invoiceReminder,
  invoiceReminderEndpoints,
  updateInvoiceReminderInput,
} from './invoice-reminders.js';

describe('invoice reminders contract', () => {
  const valid = {
    name: '3 days overdue reminder',
    enabled: true,
    everyAmount: 3,
    everyUnit: 'days' as const,
    direction: 'after' as const,
    anchor: 'due_date' as const,
    maxSends: 3,
    subject: 'Invoice {{invoice.number}} from {{business.name}} is overdue',
    body: 'Hello {{contact.name}},\n\nYour invoice {{invoice.number}} for {{invoice.total}} was due on {{invoice.due_date}}. View online: {{invoice.url}}',
  };

  it('accepts a valid create input with allowed merge fields', () => {
    const parsed = createInvoiceReminderInput.parse(valid);
    expect(parsed.name).toBe('3 days overdue reminder');
    expect(parsed.everyAmount).toBe(3);
    expect(parsed.everyUnit).toBe('days');
    expect(parsed.direction).toBe('after');
    expect(parsed.anchor).toBe('due_date');
    expect(parsed.maxSends).toBe(3);
  });

  it('accepts a reminder before the due date', () => {
    const parsed = createInvoiceReminderInput.parse({
      ...valid,
      name: 'Upcoming due date',
      direction: 'before',
      anchor: 'due_date',
    });
    expect(parsed.direction).toBe('before');
    expect(parsed.anchor).toBe('due_date');
  });

  it('refuses a reminder before the sent date', () => {
    const result = createInvoiceReminderInput.safeParse({
      ...valid,
      direction: 'before',
      anchor: 'sent_date',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        'A reminder before its date can only be before the due date.',
      );
    }
  });

  it('refuses unknown merge fields in subject or body', () => {
    const badSubject = createInvoiceReminderInput.safeParse({
      ...valid,
      subject: 'Invoice {{unknown.field}}',
    });
    expect(badSubject.success).toBe(false);
    if (!badSubject.success) {
      expect(badSubject.error.issues[0]?.message).toContain('Unknown merge field in subject');
    }

    const badBody = createInvoiceReminderInput.safeParse({
      ...valid,
      body: 'Pay here: {{invalid.token}}',
    });
    expect(badBody.success).toBe(false);
    if (!badBody.success) {
      expect(badBody.error.issues[0]?.message).toContain('Unknown merge field in body');
    }
  });

  it('refuses out of range values', () => {
    expect(createInvoiceReminderInput.safeParse({ ...valid, everyAmount: 0 }).success).toBe(false);
    expect(createInvoiceReminderInput.safeParse({ ...valid, everyAmount: 366 }).success).toBe(
      false,
    );
    expect(createInvoiceReminderInput.safeParse({ ...valid, maxSends: 0 }).success).toBe(false);
    expect(createInvoiceReminderInput.safeParse({ ...valid, maxSends: 21 }).success).toBe(false);
    expect(createInvoiceReminderInput.safeParse({ ...valid, name: '' }).success).toBe(false);
  });

  it('accepts a valid update input with updatedAt', () => {
    const now = new Date().toISOString();
    const parsed = updateInvoiceReminderInput.parse({
      name: 'Updated name',
      enabled: false,
      updatedAt: now,
    });
    expect(parsed.name).toBe('Updated name');
    expect(parsed.enabled).toBe(false);
  });

  it('refuses update before sent date', () => {
    const now = new Date().toISOString();
    const result = updateInvoiceReminderInput.safeParse({
      direction: 'before',
      anchor: 'sent_date',
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });

  it('parses a stored invoice reminder row', () => {
    const now = new Date().toISOString();
    const reminder = invoiceReminder.parse({
      id: '01890a5d-ac96-774b-bcce-b302099a8057',
      name: 'Reminder 1',
      enabled: true,
      enabledSince: now,
      everyAmount: 7,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Overdue invoice',
      body: 'Please pay your invoice.',
      createdAt: now,
      updatedAt: now,
    });
    expect(reminder.id).toBe('01890a5d-ac96-774b-bcce-b302099a8057');
    expect(reminder.enabledSince).toBe(now);
  });

  it('declares the 4 CRUD endpoints in group Payments', () => {
    expect(invoiceReminderEndpoints).toHaveLength(4);
    const [list, create, update, remove] = invoiceReminderEndpoints;
    expect(list.operationId).toBe('listInvoiceReminders');
    expect(list.method).toBe('get');
    expect(list.path).toBe('/invoice-reminders');
    expect(list.group).toBe('Payments');

    expect(create.operationId).toBe('createInvoiceReminder');
    expect(create.method).toBe('post');
    expect(create.path).toBe('/invoice-reminders');

    expect(update.operationId).toBe('updateInvoiceReminder');
    expect(update.method).toBe('patch');
    expect(update.path).toBe('/invoice-reminders/{id}');

    expect(remove.operationId).toBe('deleteInvoiceReminder');
    expect(remove.method).toBe('delete');
    expect(remove.path).toBe('/invoice-reminders/{id}');
  });
});
