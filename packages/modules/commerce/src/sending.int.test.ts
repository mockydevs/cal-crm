// Sending a quote, an invoice and a receipt by email, on real Postgres with the real files
// service and the messaging module's real outbound queue: what is queued and where, what a
// send writes on the document, what the pipeline refuses, and that a send that is refused
// leaves nothing behind.
import { randomUUID } from 'node:crypto';

import type { Receipt, ReceiptSend, SalesDocument, SalesDocumentSend } from '@repo/contracts';
import { ConflictError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';

import { refusalOf } from '../test/commerce-fixtures.js';
import { sharingSuite, type SharingFixture } from '../test/sharing-fixtures.js';

const suite = sharingSuite();

const send = (
  f: SharingFixture,
  document: Pick<SalesDocument, 'id' | 'revision'>,
  body: Record<string, unknown> = {},
  among?: Parameters<typeof suite.api>[4],
): Promise<SalesDocumentSend> =>
  suite.api(
    f,
    'sendSalesDocument',
    { params: { id: document.id }, body: { revision: document.revision, ...body } },
    f.manager,
    among,
  ) as Promise<SalesDocumentSend>;

interface Stored {
  readonly id: string;
  readonly direction: string;
  readonly channel: string;
  readonly status: string;
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string | null;
  readonly to_addresses: string[];
  readonly contact_id: string;
  readonly purpose: string;
  readonly lane: string;
  readonly channel_account_id: string;
  readonly author_kind: string;
}

/** Every message of the business, oldest first, with whose conversation it is in. */
const messages = (f: SharingFixture) =>
  suite.rows<Stored>(
    `select m.id, m.direction, m.channel, m.status, m.subject, m.body_text, m.body_html,
            m.to_addresses, v.contact_id, d.purpose, d.lane, m.channel_account_id, m.author_kind
     from messaging.messages m
     join messaging.conversations v on v.business_id = m.business_id and v.id = m.conversation_id
     join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
     where m.business_id = $1 order by m.id`,
    [f.business.id],
  );

/** The files a message carries, as the files module holds them. */
const attachments = (f: SharingFixture, messageId: string) =>
  suite.rows<{ id: string; filename: string; content_type: string; size_bytes: string }>(
    `select f.id, f.filename, f.content_type, f.size_bytes
     from messaging.message_attachments a
     join files.files f on f.business_id = a.business_id and f.id = a.file_id
     where a.business_id = $1 and a.message_id = $2`,
    [f.business.id, messageId],
  );

const eventsOf = (f: SharingFixture, type: string) =>
  suite.rows<{ payload: Record<string, unknown>; actor_kind: string }>(
    'select payload, actor_kind from events.events where business_id = $1 and type = $2',
    [f.business.id, type],
  );

const countOf = async (f: SharingFixture, table: string): Promise<number> => {
  const [row] = await suite.rows<{ count: string }>(
    `select count(*)::text as count from ${table} where business_id = $1`,
    [f.business.id],
  );
  return Number(row?.count ?? '0');
};

async function storedPdf(f: SharingFixture, fileId: string): Promise<string> {
  const found = await suite.files.content(
    { db: suite.db, authorize: () => true },
    f.manager,
    toPublicId('file', fileId),
  );
  if (found === undefined) throw new Error('The attachment is not in the files service.');
  const chunks: Buffer[] = [];
  for await (const chunk of await found.open()) chunks.push(Buffer.from(chunk as Uint8Array));
  const { text } = await extractText(
    await getDocumentProxy(new Uint8Array(Buffer.concat(chunks))),
    {
      mergePages: true,
    },
  );
  return text;
}

const issueOf = async (work: () => Promise<unknown>) =>
  (await refusalOf(work, ValidationError)).issues[0];

describe('sending an invoice', () => {
  it('queues a transactional email in the contact’s conversation, with the link and the PDF', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const sent = await send(f, invoice);

    const [message, ...others] = await messages(f);
    expect(others).toEqual([]);
    expect(message).toMatchObject({
      direction: 'outbound',
      channel: 'email',
      status: 'queued',
      // Not marketing: an invoice is sent because the customer is owed one.
      purpose: 'transactional',
      lane: 'transactional',
      contact_id: f.contact.id,
      to_addresses: [f.email],
      channel_account_id: f.mailboxId,
      subject: `Invoice ${invoice.number ?? ''} from Harbor Lights Events`,
      body_html: null,
      author_kind: 'user',
    });
    const url = invoice.publicLink?.url ?? '';
    expect(url).not.toBe('');
    expect(message?.body_text).toBe(
      [
        'Hello Maya Thompson,',
        `Here is invoice ${invoice.number ?? ''} from Harbor Lights Events for KES 1,500.00. It is due on 26 Oct 2026.`,
        `View it online: ${url}`,
        'A PDF copy is attached.',
        'Harbor Lights Events',
      ].join('\n\n'),
    );
    expect(sent.message).toEqual({
      id: toPublicId('message', message?.id ?? ''),
      conversationId: expect.stringMatching(/^cvn_/) as string,
      to: f.email,
      status: 'queued',
      attachedPdf: true,
    });

    // The PDF is a file of the business, attached to the message, and says what the invoice says.
    const [file, ...more] = await attachments(f, message?.id ?? '');
    expect(more).toEqual([]);
    expect(file).toMatchObject({
      filename: `${invoice.number ?? ''}.pdf`,
      content_type: 'application/pdf',
    });
    const text = await storedPdf(f, file?.id ?? '');
    expect(text).toContain(invoice.number ?? '');
    expect(text).toContain('KES 1,500.00');

    // The document says it was sent, and moved on, so the same request cannot send twice.
    expect(sent.document).toMatchObject({
      id: invoice.id,
      status: 'sent',
      sendCount: 1,
      revision: invoice.revision + 1,
      publicLink: invoice.publicLink,
    });
    expect(sent.document.sentAt).not.toBeNull();
    expect(sent.document.lastSentAt).toBe(sent.document.sentAt);

    // Told once, on the contact's timeline, without the address it went to.
    const told = await eventsOf(f, 'invoice.sent');
    expect(told).toEqual([
      {
        actor_kind: 'user',
        payload: {
          number: invoice.number,
          total: '1500.0000',
          currency: 'KES',
          messageId: sent.message.id,
          attachedPdf: true,
        },
      },
    ]);
    expect(JSON.stringify(told)).not.toContain(f.email);
    const timeline = await suite.rows(
      `select 1 from crm.timeline_entries
       where business_id = $1 and record_id = $2 and event_type = 'invoice.sent'`,
      [f.business.id, f.contact.id],
    );
    expect(timeline).toHaveLength(1);
    // The worker has its job: delivery is messaging's, after this transaction.
    const [audit] = await suite.rows<{ input: unknown; outcome: string }>(
      "select input, outcome from audit.commands where business_id = $1 and command = 'sales_document.send'",
      [f.business.id],
    );
    expect(audit).toEqual({
      outcome: 'ok',
      input: { id: invoice.id, revision: invoice.revision, attachPdf: true, issueIfDraft: false },
    });
  });

  it('sends once for one request: the same revision again is refused and sends nothing', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const first = await send(f, invoice);
    const refused = await refusalOf(() => send(f, invoice), ConflictError);
    expect(refused.message).toContain('changed since you opened it');
    expect(await messages(f)).toHaveLength(1);
    expect(await eventsOf(f, 'invoice.sent')).toHaveLength(1);

    // Sent again on purpose, at the revision it now has: a second email, and the first
    // time it was sent stays as it was.
    const second = await send(f, first.document, { attachPdf: false });
    expect(second.document).toMatchObject({ sendCount: 2, sentAt: first.document.sentAt });
    expect(Date.parse(second.document.lastSentAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(first.document.sentAt ?? ''),
    );
    expect(second.message).toMatchObject({ attachedPdf: false });
    const [, again] = await messages(f);
    expect(again?.body_text).not.toContain('A PDF copy is attached.');
    expect(await attachments(f, again?.id ?? '')).toEqual([]);
    expect(await eventsOf(f, 'invoice.sent')).toHaveLength(2);
  });

  it('takes the sender’s own subject, words, mailbox and one of the contact’s other addresses', async () => {
    const f = await suite.fixture();
    const other = `accounts.${randomUUID().slice(0, 8)}@example.com`;
    await suite.rows(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
       values ($1, $2, 'email', $3, $3)`,
      [f.business.id, f.contact.id, other],
    );
    const invoice = await suite.issued(f, 'invoice');
    const sent = await send(f, invoice, {
      to: other.toUpperCase(),
      subject: 'Your invoice for the wedding',
      message: 'As agreed on the phone.',
      mailboxId: toPublicId('mailbox', f.mailboxId ?? ''),
    });
    expect(sent.message.to).toBe(other);
    const [message] = await messages(f);
    expect(message).toMatchObject({
      subject: 'Your invoice for the wedding',
      to_addresses: [other],
    });
    expect(message?.body_text).toContain('As agreed on the phone.');
    expect(message?.body_text).not.toContain('Here is invoice');
  });

  it('is sent by someone who may manage payments only', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await expect(
      suite.api(
        f,
        'sendSalesDocument',
        { params: { id: invoice.id }, body: { revision: invoice.revision } },
        f.withPermissions('payments.read'),
      ),
    ).rejects.toThrow('payments.manage');
    expect(await messages(f)).toEqual([]);
  });

  it('is not found from another business', async () => {
    const f = await suite.fixture();
    const other = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await refusalOf(() => send(other, invoice), NotFoundError);
    expect(await messages(f)).toEqual([]);
    expect(await messages(other)).toEqual([]);
  });
});

describe('sending a draft', () => {
  it('is refused with the contract’s words unless it is issued in the same step', async () => {
    const f = await suite.fixture();
    const draft = await suite.draft(f, 'quote');
    const refused = await refusalOf(() => send(f, draft), ConflictError);
    expect(refused.message).toBe(
      'This quote is a draft. Issue it first, or send it with issueIfDraft.',
    );
    expect(await messages(f)).toEqual([]);

    const sent = await send(f, draft, { issueIfDraft: true });
    expect(sent.document).toMatchObject({ status: 'sent', sendCount: 1 });
    expect(sent.document.number).toMatch(/^QUO-\d{4}$/);
    // Issued, then sent: two more revisions.
    expect(sent.document.revision).toBe(draft.revision + 2);
    const [message] = await messages(f);
    expect(message?.subject).toBe(`Quote ${sent.document.number ?? ''} from Harbor Lights Events`);
    expect(message?.body_text).toContain(
      `View it online, and accept or decline it there: ${sent.document.publicLink?.url ?? 'none'}`,
    );
    expect(await eventsOf(f, 'quote.issued')).toHaveLength(1);
    expect(await eventsOf(f, 'quote.sent')).toHaveLength(1);
    const [file] = await attachments(f, message?.id ?? '');
    expect(file?.filename).toBe(`${sent.document.number ?? ''}.pdf`);
    expect(await storedPdf(f, file?.id ?? '')).not.toContain('DRAFT');
  });

  it('gives its number back when the send is refused: nothing was issued', async () => {
    const f = await suite.fixture({ consent: false });
    const draft = await suite.draft(f, 'invoice');
    const issue = await issueOf(() => send(f, draft, { issueIfDraft: true }));
    expect(issue.code).toBe('consent_required');
    const after = (await suite.api(f, 'getSalesDocument', {
      params: { id: draft.id },
    })) as SalesDocument;
    expect(after).toMatchObject({ status: 'draft', number: null, revision: draft.revision });
    expect(await eventsOf(f, 'invoice.issued')).toEqual([]);
  });

  it('refuses a void invoice', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const voided = (await suite.api(f, 'voidInvoice', {
      params: { id: invoice.id },
      body: { reason: 'Raised by mistake.' },
    })) as SalesDocument;
    const refused = await refusalOf(() => send(f, voided, { issueIfDraft: true }), ConflictError);
    expect(refused.message).toBe('A void invoice is not sent.');
  });
});

describe('what the outbound pipeline refuses', () => {
  /** A send that is refused leaves no message, no file, no event and no mark on the document. */
  async function nothingLeft(f: SharingFixture, invoice: SalesDocument): Promise<void> {
    expect(await messages(f)).toEqual([]);
    expect(await countOf(f, 'files.files')).toBe(0);
    expect(await eventsOf(f, 'invoice.sent')).toEqual([]);
    expect(
      (await suite.api(f, 'getSalesDocument', { params: { id: invoice.id } })) as SalesDocument,
    ).toMatchObject({ sendCount: 0, sentAt: null, lastSentAt: null, revision: invoice.revision });
  }

  it('refuses a suppressed address, and says why', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await suite.rows(
      `insert into messaging.suppressions (business_id, channel, address_normalized, reason)
       values ($1, 'email', $2, 'hard_bounce')`,
      [f.business.id, f.email],
    );
    expect(await issueOf(() => send(f, invoice))).toEqual({
      path: '/to',
      code: 'suppressed',
      message:
        'This address is on the suppression list (mail to it bounced), so nothing is sent to it.',
    });
    await nothingLeft(f, invoice);
    // The refusal itself is kept, in the audit log.
    const [audit] = await suite.rows<{ outcome: string; error_code: string }>(
      "select outcome, error_code from audit.commands where business_id = $1 and command = 'sales_document.send'",
      [f.business.id],
    );
    expect(audit).toEqual({ outcome: 'invalid', error_code: 'validation' });
  });

  it('refuses a contact marked do not contact, or with do not disturb on for email', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await suite.rows('update crm.contacts set do_not_contact = true where id = $1', [f.contact.id]);
    expect(await issueOf(() => send(f, invoice))).toMatchObject({
      path: '/to',
      code: 'do_not_contact',
      message: 'This contact is marked do not contact.',
    });
    await suite.rows(
      "update crm.contacts set do_not_contact = false, dnd_channels = '{email}' where id = $1",
      [f.contact.id],
    );
    expect((await issueOf(() => send(f, invoice))).message).toBe(
      'This contact has do not disturb switched on for email.',
    );
    await nothingLeft(f, invoice);
  });

  it('needs the contact’s transactional consent, and refuses one who withdrew it', async () => {
    const f = await suite.fixture({ consent: false });
    const invoice = await suite.issued(f, 'invoice');
    expect(await issueOf(() => send(f, invoice))).toMatchObject({
      path: '/to',
      code: 'consent_required',
    });
    // Marketing consent is another thing: it does not let an invoice through.
    await suite.rows(
      `insert into messaging.consents
         (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'system')`,
      [f.business.id, f.contact.id],
    );
    expect((await issueOf(() => send(f, invoice))).code).toBe('consent_required');
    await suite.rows(
      `insert into messaging.consents
         (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'transactional', 'withdrawn', 'user', 'system')`,
      [f.business.id, f.contact.id],
    );
    expect((await issueOf(() => send(f, invoice))).code).toBe('consent_withdrawn');
    await nothingLeft(f, invoice);
  });

  it('needs a mailbox that sends conversations', async () => {
    const f = await suite.fixture({ mailbox: false });
    const invoice = await suite.issued(f, 'invoice');
    expect(await issueOf(() => send(f, invoice))).toMatchObject({
      path: '/mailboxId',
      code: 'no_mailbox',
    });
    const g = await suite.fixture();
    const other = await suite.issued(g, 'invoice');
    // A mailbox of another business, and one that names nothing, are no mailbox.
    expect(
      (
        await issueOf(() =>
          send(f, invoice, { mailboxId: toPublicId('mailbox', g.mailboxId ?? '') }),
        )
      ).code,
    ).toBe('no_mailbox');
    await suite.rows(
      'update messaging.mailboxes set use_for_conversations = false where business_id = $1',
      [g.business.id],
    );
    expect((await issueOf(() => send(g, other))).code).toBe('no_mailbox');
    await nothingLeft(f, invoice);
  });

  it('sends only to an address that is the contact’s own', async () => {
    const f = await suite.fixture();
    const stranger = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    expect(await issueOf(() => send(f, invoice, { to: 'someone.else@example.com' }))).toMatchObject(
      {
        path: '/to',
        code: 'not_contacts_address',
      },
    );
    // Another business's contact's address is not this contact's either.
    expect((await issueOf(() => send(f, invoice, { to: stranger.email }))).code).toBe(
      'not_contacts_address',
    );
    await nothingLeft(f, invoice);
  });

  it('needs an address at all', async () => {
    const f = await suite.fixture();
    const draft = await suite.draft(f, 'invoice');
    await suite.rows(
      'delete from crm.contact_identities where business_id = $1 and contact_id = $2',
      [f.business.id, f.contact.id],
    );
    // Saved again, the draft is for the contact as it is now: without an address.
    const saved = (await suite.api(f, 'updateSalesDocument', {
      params: { id: draft.id },
      body: {
        contactId: f.contactId,
        currency: 'KES',
        lines: [{ name: 'Wedding day coordination', quantity: '1', unitPrice: '1500.00' }],
        revision: draft.revision,
      },
    })) as SalesDocument;
    expect(saved.customer.email).toBeNull();
    expect(await issueOf(() => send(f, saved, { issueIfDraft: true }))).toEqual({
      path: '/to',
      code: 'no_address',
      message: 'This contact has no email address. Add one to the contact first.',
    });
  });

  // A contact without a zone keeps quiet hours by the business's, so the invoice is sent,
  // not refused for want of a zone.
  it("keeps quiet hours by the business's time zone when the contact has none", async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await suite.rows(
      'update messaging.settings set quiet_hours_enabled = true where business_id = $1',
      [f.business.id],
    );
    await send(f, invoice);
    expect(await messages(f)).toHaveLength(1);
  });

  it('refuses a contact in the trash', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await suite.rows('update crm.contacts set deleted_at = now() where id = $1', [f.contact.id]);
    expect((await issueOf(() => send(f, invoice))).code).toBe('contact_inactive');
  });
});

describe('what an install needs to send', () => {
  it('cannot send without messaging, attach without files, or send nothing at all', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const noMail = await refusalOf(
      () => send(f, invoice, {}, suite.routesWith({ mail: undefined })),
      ConflictError,
    );
    expect(noMail.message).toBe('This install cannot send email.');
    const noFiles = await refusalOf(
      () => send(f, invoice, {}, suite.routesWith({ files: undefined })),
      ConflictError,
    );
    expect(noFiles.message).toContain('Send it without the PDF.');
    // Without files the link alone is sent.
    const bare = await send(
      f,
      invoice,
      { attachPdf: false },
      suite.routesWith({ files: undefined }),
    );
    expect(bare.message.attachedPdf).toBe(false);
    // Without public pages there is no link: the PDF alone is sent, and nothing at all is not.
    const noLinks = suite.routesWith({ links: undefined });
    const empty = await refusalOf(
      () => send(f, bare.document, { attachPdf: false }, noLinks),
      ConflictError,
    );
    expect(empty.message).toContain('There is nothing to send');
    const pdfOnly = await send(f, bare.document, {}, noLinks);
    const [, message] = await messages(f);
    expect(message?.body_text).not.toContain('View it online');
    expect(message?.body_text).toContain('A PDF copy is attached.');
    expect(pdfOnly.document.sendCount).toBe(2);
  });
});

describe('sending a receipt', () => {
  const paid = async (f: SharingFixture): Promise<{ invoice: SalesDocument; receipt: Receipt }> => {
    const invoice = await suite.issued(f, 'invoice');
    const receipt = (await suite.api(f, 'recordPayment', {
      params: { id: invoice.id },
      body: { amount: '400.00', method: 'mobile_money', paidOn: '2026-10-12' },
    })) as Receipt;
    return { invoice, receipt };
  };
  const sendReceipt = (
    f: SharingFixture,
    receipt: Receipt,
    body: Record<string, unknown> = {},
    among?: Parameters<typeof suite.api>[4],
  ): Promise<ReceiptSend> =>
    suite.api(
      f,
      'sendReceipt',
      { params: { id: receipt.id }, body: { idempotencyKey: randomUUID(), ...body } },
      f.manager,
      among,
    ) as Promise<ReceiptSend>;

  it('queues the receipt’s PDF with the link to its invoice, once for one press of Send', async () => {
    const f = await suite.fixture();
    const { invoice, receipt } = await paid(f);
    const idempotencyKey = randomUUID();
    const sent = await sendReceipt(f, receipt, { idempotencyKey });
    expect(sent.receipt).toMatchObject({ id: receipt.id, sendCount: 1 });
    expect(sent.receipt.lastSentAt).not.toBeNull();
    const [message, ...others] = await messages(f);
    expect(others).toEqual([]);
    expect(message).toMatchObject({
      purpose: 'transactional',
      lane: 'transactional',
      contact_id: f.contact.id,
      to_addresses: [f.email],
      subject: `Receipt ${receipt.number} from Harbor Lights Events`,
    });
    expect(message?.body_text).toBe(
      [
        'Hello Maya Thompson,',
        `Thank you. Here is receipt ${receipt.number} for KES 400.00, received on 12 Oct 2026 for invoice ${invoice.number ?? ''}.`,
        `View the invoice online: ${invoice.publicLink?.url ?? 'none'}`,
        'A PDF copy is attached.',
        'Harbor Lights Events',
      ].join('\n\n'),
    );
    const [file] = await attachments(f, message?.id ?? '');
    expect(file).toMatchObject({
      filename: `${receipt.number}.pdf`,
      content_type: 'application/pdf',
    });
    const text = await storedPdf(f, file?.id ?? '');
    expect(text).toContain(receipt.number);
    expect(text).toContain('KES 400.00');

    // The same press again: the first email, and nothing more.
    const again = await sendReceipt(f, receipt, { idempotencyKey });
    expect(again.message).toEqual(sent.message);
    expect(again.receipt.sendCount).toBe(1);
    expect(await messages(f)).toHaveLength(1);
    expect(await countOf(f, 'files.files')).toBe(1);
    expect(await eventsOf(f, 'payment.receipt_sent')).toEqual([
      {
        actor_kind: 'user',
        payload: {
          number: receipt.number,
          invoiceNumber: invoice.number,
          messageId: sent.message.id,
          attachedPdf: true,
        },
      },
    ]);

    // Another press is another email.
    expect((await sendReceipt(f, receipt, { attachPdf: false })).receipt.sendCount).toBe(2);
    expect(await messages(f)).toHaveLength(2);
  });

  it('obeys the pipeline as an invoice does, and leaves nothing when it is refused', async () => {
    const f = await suite.fixture();
    const { receipt } = await paid(f);
    await suite.rows(
      `insert into messaging.suppressions (business_id, channel, address_normalized, reason)
       values ($1, 'email', $2, 'complaint')`,
      [f.business.id, f.email],
    );
    expect(await issueOf(() => sendReceipt(f, receipt))).toMatchObject({
      path: '/to',
      code: 'suppressed',
    });
    expect(await messages(f)).toEqual([]);
    expect(await countOf(f, 'files.files')).toBe(0);
    expect(
      ((await suite.api(f, 'getReceipt', { params: { id: receipt.id } })) as Receipt).sendCount,
    ).toBe(0);
  });

  it('does not send the receipt of a reversed payment, nor one that names nothing', async () => {
    const f = await suite.fixture();
    const { receipt } = await paid(f);
    await suite.api(f, 'reversePayment', {
      params: { id: receipt.id },
      body: { reason: 'Recorded twice.' },
    });
    const refused = await refusalOf(() => sendReceipt(f, receipt), ConflictError);
    expect(refused.message).toBe('This payment was reversed, so its receipt is not sent.');
    await refusalOf(
      () =>
        suite.api(f, 'sendReceipt', {
          params: { id: 'pay_01h455vb4pex5vsknk084sn02q' },
          body: { idempotencyKey: randomUUID() },
        }),
      NotFoundError,
    );
    const other = await suite.fixture();
    await refusalOf(() => sendReceipt(other, receipt), NotFoundError);
  });

  it('needs something to send, and an install that can', async () => {
    const f = await suite.fixture();
    const { receipt } = await paid(f);
    const noMail = await refusalOf(
      () => sendReceipt(f, receipt, {}, suite.routesWith({ mail: undefined })),
      ConflictError,
    );
    expect(noMail.message).toBe('This install cannot send email.');
    const empty = await refusalOf(
      () => sendReceipt(f, receipt, { attachPdf: false }, suite.routesWith({ links: undefined })),
      ConflictError,
    );
    expect(empty.message).toContain('There is nothing to send');
    await suite.rows(
      'delete from crm.contact_identities where business_id = $1 and contact_id = $2',
      [f.business.id, f.contact.id],
    );
    expect((await issueOf(() => sendReceipt(f, receipt, { to: undefined }))).code).toBe(
      'not_contacts_address',
    );
  });
});
