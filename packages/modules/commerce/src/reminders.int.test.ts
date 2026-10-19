// Invoice reminders integration tests:
// CRUD, limits, stale-write checks, and the periodic sweep that emails customers about unpaid invoices.
import { allowEveryone } from '@repo/commands';
import type { InvoiceReminder, InvoiceReminderList, SalesDocument } from '@repo/contracts';
import { ConflictError, NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { afterEach, describe, expect, it } from 'vitest';

import { refusalOf } from '../test/commerce-fixtures.js';
import { sharingSuite, type SharingFixture } from '../test/sharing-fixtures.js';
import { sendInvoiceRemindersSweep } from './reminders.js';
import type { CommerceOptions } from './shared.js';

const suite = sharingSuite();

const sweep = () =>
  sendInvoiceRemindersSweep({ db: suite.db, authorize: allowEveryone }, suite.options);

afterEach(async () => {
  await suite.rows('update commerce.invoice_reminders set enabled = false');
});

interface StoredSend {
  readonly reminder_id: string;
  readonly document_id: string;
  readonly step: number;
  readonly message_id: string;
  readonly sent_at: Date;
}

const sends = (f: SharingFixture) =>
  suite.rows<StoredSend>(
    `select reminder_id, document_id, step, message_id, sent_at
     from commerce.invoice_reminder_sends
     where business_id = $1
     order by step asc`,
    [f.business.id],
  );

const createReminder = (
  f: SharingFixture,
  body: Record<string, unknown>,
): Promise<InvoiceReminder> =>
  suite.api(f, 'createInvoiceReminder', { body }, f.manager) as Promise<InvoiceReminder>;

const updateReminder = (
  f: SharingFixture,
  id: string,
  body: Record<string, unknown>,
): Promise<InvoiceReminder> =>
  suite.api(
    f,
    'updateInvoiceReminder',
    { params: { id }, body },
    f.manager,
  ) as Promise<InvoiceReminder>;

const listReminders = (f: SharingFixture): Promise<InvoiceReminderList> =>
  suite.api(f, 'listInvoiceReminders', undefined, f.manager) as Promise<InvoiceReminderList>;

/** Issues an invoice and marks it sent with sent_at = sentAt and due_date = dueDate. */
async function createSentInvoice(
  f: SharingFixture,
  sentAt: string,
  dueDate: string,
): Promise<SalesDocument> {
  const invoice = await suite.issued(f, 'invoice');
  const uuid = parsePublicId('sales_document', invoice.id);
  await suite.rows(
    `update commerce.documents
     set sent_at = $1::timestamptz, last_sent_at = $1::timestamptz, send_count = 1,
         due_date = $2::date, issue_date = $1::date
     where id = $3`,
    [sentAt, dueDate, uuid],
  );
  return invoice;
}

describe('invoice reminders', () => {
  it('sends a reminder after the due date, then every interval, up to the maximum', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');

    const reminder = await createReminder(f, {
      name: 'Overdue reminder',
      everyAmount: 3,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Reminder: Invoice {{ invoice.number }} is overdue',
      body: 'Hello {{ contact.name }}, your invoice is overdue. Please pay at {{ invoice.url }}.',
    });

    await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-15');

    // Before due date: 0 sent
    suite.at('2026-10-14T09:00:00.000Z');
    expect(await sweep()).toBe(0);

    // At due date: step 1 is anchor + 3 days = 2026-10-18. So at 2026-10-15: 0 sent
    suite.at('2026-10-15T12:00:00.000Z');
    expect(await sweep()).toBe(0);

    // 2026-10-18: step 1 is due
    suite.at('2026-10-18T10:00:00.000Z');
    expect(await sweep()).toBe(1);
    let sendRows = await sends(f);
    expect(sendRows).toHaveLength(1);
    expect(sendRows[0]?.step).toBe(1);
    expect(sendRows[0]?.reminder_id).toBe(reminder.id);

    // Running again at the same time sends nothing
    expect(await sweep()).toBe(0);

    // 2026-10-21: step 2 is due
    suite.at('2026-10-21T10:00:00.000Z');
    expect(await sweep()).toBe(1);
    sendRows = await sends(f);
    expect(sendRows).toHaveLength(2);
    expect(sendRows[1]?.step).toBe(2);

    // 2026-10-24: step 3 is due (maximum)
    suite.at('2026-10-24T10:00:00.000Z');
    expect(await sweep()).toBe(1);
    sendRows = await sends(f);
    expect(sendRows).toHaveLength(3);
    expect(sendRows[2]?.step).toBe(3);

    // 2026-10-28: beyond max sends (3): no more sends
    suite.at('2026-10-28T10:00:00.000Z');
    expect(await sweep()).toBe(0);
    expect(await sends(f)).toHaveLength(3);
  });

  it('sends a reminder before the due date once', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');

    await createReminder(f, {
      name: 'Upcoming due reminder',
      everyAmount: 2,
      everyUnit: 'days',
      direction: 'before',
      anchor: 'due_date',
      maxSends: 5, // Even if maxSends is set > 1, before sends only once (k=1)
      subject: 'Upcoming invoice {{ invoice.number }}',
      body: 'Your invoice will be due on {{ invoice.due_date }}.',
    });

    await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-15');

    // Due date 2026-10-15 - 2 days = 2026-10-13.
    // 2026-10-12: not due yet
    suite.at('2026-10-12T10:00:00.000Z');
    expect(await sweep()).toBe(0);

    // 2026-10-13: due once
    suite.at('2026-10-13T10:00:00.000Z');
    expect(await sweep()).toBe(1);
    const sendRows = await sends(f);
    expect(sendRows).toHaveLength(1);
    expect(sendRows[0]?.step).toBe(1);

    // 2026-10-14 and later: never sends a second time
    suite.at('2026-10-14T10:00:00.000Z');
    expect(await sweep()).toBe(0);
    suite.at('2026-10-16T10:00:00.000Z');
    expect(await sweep()).toBe(0);
    expect(await sends(f)).toHaveLength(1);
  });

  it('never reminds about an invoice sent before the reminder was turned on', async () => {
    const f = await suite.fixture();
    // Invoice sent at Oct 5
    await createSentInvoice(f, '2026-10-05T10:00:00.000Z', '2026-10-10');

    // Reminder enabled at Oct 12
    suite.at('2026-10-12T10:00:00.000Z');
    await createReminder(f, {
      name: 'Overdue',
      everyAmount: 1,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    // Oct 15: invoice is overdue, but was sent before the reminder was created/turned on
    suite.at('2026-10-15T10:00:00.000Z');
    expect(await sweep()).toBe(0);
    expect(await sends(f)).toHaveLength(0);
  });

  it('stops reminding once the invoice is paid', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');
    await createReminder(f, {
      name: 'Overdue',
      everyAmount: 2,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    const invoice = await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-10');

    // Step 1: 2026-10-12
    suite.at('2026-10-12T10:00:00.000Z');
    expect(await sweep()).toBe(1);

    // Pay invoice
    await suite.rows(
      `update commerce.documents set status = 'paid', balance_due = 0, amount_paid = 1500 where id = $1`,
      [parsePublicId('sales_document', invoice.id)],
    );

    // Step 2 time arrives: 2026-10-14
    suite.at('2026-10-14T10:00:00.000Z');
    expect(await sweep()).toBe(0);
    expect(await sends(f)).toHaveLength(1);
  });

  it('stops reminding once the invoice is void', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');
    await createReminder(f, {
      name: 'Overdue',
      everyAmount: 2,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    const invoice = await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-10');

    // Step 1: 2026-10-12
    suite.at('2026-10-12T10:00:00.000Z');
    expect(await sweep()).toBe(1);

    // Void invoice
    await suite.rows(
      `update commerce.documents set status = 'void', void_reason = 'Cancelled order', voided_at = now() where id = $1`,
      [parsePublicId('sales_document', invoice.id)],
    );

    // Step 2 time arrives: 2026-10-14
    suite.at('2026-10-14T10:00:00.000Z');
    expect(await sweep()).toBe(0);
    expect(await sends(f)).toHaveLength(1);
  });

  it('never sends a step twice, even when two runs overlap', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');
    await createReminder(f, {
      name: 'Overdue',
      everyAmount: 1,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-10');

    suite.at('2026-10-11T10:00:00.000Z');
    // Run two sweeps concurrently
    const [result1, result2] = await Promise.all([sweep(), sweep()]);

    expect(result1 + result2).toBe(1);
    expect(await sends(f)).toHaveLength(1);
  });

  it('sends one step per run to a long-overdue invoice', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');
    await createReminder(f, {
      name: 'Overdue',
      everyAmount: 2,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-05');

    // At 2026-10-20, the invoice is overdue by 15 days (steps 1, 2, 3 are all in the past)
    suite.at('2026-10-20T10:00:00.000Z');

    // Run 1: sends only step 1
    expect(await sweep()).toBe(1);
    let sendRows = await sends(f);
    expect(sendRows).toHaveLength(1);
    expect(sendRows[0]?.step).toBe(1);

    // Run 2: sends step 2
    expect(await sweep()).toBe(1);
    sendRows = await sends(f);
    expect(sendRows).toHaveLength(2);
    expect(sendRows[1]?.step).toBe(2);

    // Run 3: sends step 3
    expect(await sweep()).toBe(1);
    sendRows = await sends(f);
    expect(sendRows).toHaveLength(3);
    expect(sendRows[2]?.step).toBe(3);

    // Run 4: max sends reached
    expect(await sweep()).toBe(0);
  });

  it('skips an invoice whose contact has no email', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');
    await createReminder(f, {
      name: 'Overdue',
      everyAmount: 1,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-10');

    // Delete contact identities for this contact
    await suite.rows(
      'delete from crm.contact_identities where business_id = $1 and contact_id = $2',
      [f.business.id, f.contact.id],
    );

    suite.at('2026-10-12T10:00:00.000Z');
    expect(await sweep()).toBe(0);
    expect(await sends(f)).toHaveLength(0);
  });

  it('refuses a reminder before the sent date', async () => {
    const f = await suite.fixture();
    const err = await refusalOf(
      () =>
        createReminder(f, {
          name: 'Invalid reminder',
          everyAmount: 1,
          everyUnit: 'days',
          direction: 'before',
          anchor: 'sent_date',
          subject: 'Invalid',
          body: 'Invalid',
        }),
      ValidationError,
    );
    expect(err.issues).toEqual([
      expect.objectContaining({
        path: '/anchor',
      }),
    ]);
  });

  it('refuses a twenty-first reminder', async () => {
    const f = await suite.fixture();
    for (let i = 1; i <= 20; i++) {
      const idx = String(i);
      await createReminder(f, {
        name: `Reminder ${idx}`,
        everyAmount: i,
        everyUnit: 'days',
        direction: 'after',
        anchor: 'due_date',
        subject: `Reminder ${idx}`,
        body: `Body ${idx}`,
      });
    }

    const list = await listReminders(f);
    expect(list.items).toHaveLength(20);

    const err = await refusalOf(
      () =>
        createReminder(f, {
          name: 'Reminder 21',
          everyAmount: 21,
          everyUnit: 'days',
          direction: 'after',
          anchor: 'due_date',
          subject: 'Reminder 21',
          body: 'Body 21',
        }),
      ConflictError,
    );
    expect(err.message).toBe('A business may have at most 20 invoice reminders.');
  });

  it('turning a reminder back on starts it again from now', async () => {
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');

    const reminder = await createReminder(f, {
      name: 'Overdue reminder',
      everyAmount: 1,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    // Turn reminder off at Oct 5
    suite.at('2026-10-05T08:00:00.000Z');
    const updated = await updateReminder(f, reminder.id, {
      enabled: false,
      updatedAt: reminder.updatedAt,
    });
    expect(updated.enabled).toBe(false);

    // Invoice 1 sent at Oct 8 (while reminder was off)
    await createSentInvoice(f, '2026-10-08T10:00:00.000Z', '2026-10-10');

    // Turn reminder back on at Oct 12
    suite.at('2026-10-12T10:00:00.000Z');
    const reenabled = await updateReminder(f, reminder.id, {
      enabled: true,
      updatedAt: updated.updatedAt,
    });
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.enabledSince).toBe('2026-10-12T10:00:00.000Z');

    // Invoice 2 sent at Oct 13 (after reminder reenabled)
    await createSentInvoice(f, '2026-10-13T10:00:00.000Z', '2026-10-14');

    // Sweep at Oct 16:
    // Invoice 1 was sent at Oct 8 (< enabled_since Oct 12), so it is skipped.
    // Invoice 2 was sent at Oct 13 (>= enabled_since Oct 12), due date Oct 14, so it is reminded!
    suite.at('2026-10-16T10:00:00.000Z');
    expect(await sweep()).toBe(1);
    const sendRows = await sends(f);
    expect(sendRows).toHaveLength(1);
  });

  it("keeps two businesses' reminders apart", async () => {
    const f1 = await suite.fixture();
    const f2 = await suite.fixture();

    suite.at('2026-10-01T08:00:00.000Z');
    // Reminder in business 1 only
    await createReminder(f1, {
      name: 'Business 1 reminder',
      everyAmount: 1,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    // Overdue invoices in both businesses
    await createSentInvoice(f1, '2026-10-02T10:00:00.000Z', '2026-10-05');
    await createSentInvoice(f2, '2026-10-02T10:00:00.000Z', '2026-10-05');

    suite.at('2026-10-10T10:00:00.000Z');
    expect(await sweep()).toBe(1);

    expect(await sends(f1)).toHaveLength(1);
    expect(await sends(f2)).toHaveLength(0);

    // Business 2 list of reminders is empty
    const list2 = await listReminders(f2);
    expect(list2.items).toHaveLength(0);

    // Business 2 cannot read or update business 1's reminder
    const list1 = await listReminders(f1);
    expect(list1.items).toHaveLength(1);
    const b1ReminderId = list1.items[0]?.id ?? '';

    await expect(
      suite.api(
        f2,
        'updateInvoiceReminder',
        {
          params: { id: b1ReminderId },
          body: { name: 'Hacked', updatedAt: '2026-10-01T08:00:00.000Z' },
        },
        f2.manager,
      ),
    ).rejects.toThrow(NotFoundError);

    await expect(
      suite.api(f2, 'deleteInvoiceReminder', { params: { id: b1ReminderId } }, f2.manager),
    ).rejects.toThrow(NotFoundError);
  });

  it("counts the due date from midnight in the business's time zone", async () => {
    const f = await suite.fixture();
    await suite.rows('update tenancy.businesses set timezone = $1 where id = $2', [
      'America/New_York',
      f.business.id,
    ]);
    suite.at('2026-10-01T08:00:00.000Z');

    await createReminder(f, {
      name: 'Overdue reminder',
      everyAmount: 1,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-15');

    // Due date is 2026-10-15. In America/New_York (EDT, UTC-4), midnight on the due date
    // is 2026-10-15 04:00:00Z. One day after midnight in New York is 2026-10-16 04:00:00Z.
    // At 22:00 New York time on the due date itself (2026-10-16T02:00:00.000Z),
    // 1 day after due date has not arrived yet:
    suite.at('2026-10-16T02:00:00.000Z');
    expect(await sweep()).toBe(0);
    expect(await sends(f)).toHaveLength(0);

    // At 23:00 New York time on the day after the due date (2026-10-17T03:00:00.000Z),
    // 1 day after midnight has passed (since 2026-10-16 04:00:00Z), so it has been sent:
    suite.at('2026-10-17T03:00:00.000Z');
    expect(await sweep()).toBe(1);
    expect(await sends(f)).toHaveLength(1);
  });

  it('skips a step another run recorded while this run was sending', async () => {
    // Inserts the sends row between the run's check and its insert, through the fake mail sender's callback.
    const f = await suite.fixture();
    suite.at('2026-10-01T08:00:00.000Z');

    const reminder = await createReminder(f, {
      name: 'Overdue reminder',
      everyAmount: 1,
      everyUnit: 'days',
      direction: 'after',
      anchor: 'due_date',
      maxSends: 3,
      subject: 'Invoice overdue',
      body: 'Please pay.',
    });

    const invoice1 = await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-05');
    await createSentInvoice(f, '2026-10-02T10:00:00.000Z', '2026-10-05');
    const inv1Uuid = parsePublicId('sales_document', invoice1.id);

    suite.at('2026-10-10T10:00:00.000Z');

    let insertedConflict = false;
    const realMail = suite.options.mail;
    if (realMail === undefined) {
      throw new Error('Missing mail in suite options');
    }
    const optionsWithCallback: CommerceOptions = {
      ...suite.options,
      mail: {
        ...realMail,
        send: async (trx, context, input) => {
          if (!insertedConflict) {
            insertedConflict = true;
            await suite.rows(
              `insert into commerce.invoice_reminder_sends (business_id, reminder_id, document_id, step)
               values ($1, $2, $3, $4)`,
              [f.business.id, reminder.id, inv1Uuid, 1],
            );
          }
          return realMail.send(trx, context, input);
        },
      },
    };

    const sentCount = await sendInvoiceRemindersSweep(
      { db: suite.db, authorize: allowEveryone },
      optionsWithCallback,
    );

    // Invoice 1 was skipped because another run recorded step 1 while sending;
    // invoice 2 succeeded because the conflict did not abort the transaction.
    expect(sentCount).toBe(1);
    const sendRows = await sends(f);
    expect(sendRows).toHaveLength(2);
  });
});
