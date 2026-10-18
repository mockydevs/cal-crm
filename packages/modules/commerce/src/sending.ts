// Sending a quote, an invoice or a receipt to its contact by email. Commerce writes the
// message and draws the PDF; messaging sends it, through its one outbound pipeline, as a
// transactional message: it is stored in the contact's conversation, and consent,
// suppressions, do not contact, quiet hours and the mailbox's limits all apply. What that
// pipeline refuses is refused here, in words, and nothing is written.
//
// One send is one transaction: the document is issued first when asked, its public address
// is made, the PDF is drawn and kept as a file, the email is queued with it, and the
// document says it was sent. Any refusal undoes all of it. The worker delivers the email
// after the transaction commits.
import { defineCommand, type Command, type CommandContext } from '@repo/commands';
import {
  documentSendRefusal,
  sendReceiptInput,
  sendSalesDocumentInput,
  type ReceiptSend,
  type SalesDocumentSend,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import {
  lockedDocument,
  readDocument,
  recordsOf,
  stale,
  stateOf,
  type DocumentCommands,
} from './documents.js';
import { ensureLink, linksAvailable } from './links.js';
import { documentMail, mailRefusalIssue, receiptMail, type MailText } from './mail-text.js';
import { readReceipt } from './payment-reads.js';
import { pdfOf, printableOf, printableReceipt, type Printable } from './printing.js';
import { fourPlaces, kindOf } from './rules.js';
import {
  heldBusiness,
  MANAGE,
  notFound,
  rowId,
  type CommerceMail,
  type CommerceOptions,
  type MailRefused,
  type QueuedMail,
} from './shared.js';

const documentSend = z.strictObject({ id: z.string(), values: sendSalesDocumentInput });
const receiptSendInput = z.strictObject({ id: z.string(), values: sendReceiptInput });

export interface SendCommands {
  readonly document: Command<typeof documentSend, SalesDocumentSend>;
  readonly receipt: Command<typeof receiptSendInput, ReceiptSend>;
}

const refused = (mail: MailRefused): ValidationError =>
  new ValidationError([mailRefusalIssue(mail)]);

const noAddress = (): ValidationError =>
  new ValidationError([
    {
      path: '/to',
      code: 'no_address',
      message: 'This contact has no email address. Add one to the contact first.',
    },
  ]);

const messageOf = (queued: QueuedMail, attachedPdf: boolean): SalesDocumentSend['message'] => ({
  id: queued.messageId,
  conversationId: queued.conversationId,
  to: queued.to,
  status: queued.deferred ? 'deferred' : 'queued',
  attachedPdf,
});

export function createSendCommands(
  options: CommerceOptions,
  documents: DocumentCommands,
): SendCommands {
  /** Messaging's way out, or the refusal of a role that has none. */
  const mailOf = (): CommerceMail => {
    if (options.mail === undefined) throw new ConflictError('This install cannot send email.');
    return options.mail;
  };

  /**
   * Draws the PDF, keeps it as a file of the business and queues the email with it. The
   * address is checked with messaging first, so a message that will be refused costs no
   * drawing and leaves no file.
   */
  async function deliver(
    trx: DatabaseTransaction,
    command: CommandContext,
    mail: CommerceMail,
    email: {
      readonly contactId: string;
      readonly to: string;
      readonly mailboxId: string | undefined;
      readonly idempotencyKey: string;
      readonly attachPdf: boolean;
      readonly printable: () => Promise<Printable>;
      readonly words: (attachedPdf: boolean) => MailText;
    },
  ): Promise<QueuedMail> {
    const address = { contactId: email.contactId, to: email.to, mailboxId: email.mailboxId };
    const unwelcome = await mail.check(trx, command.context, address);
    if (unwelcome !== undefined) throw refused(unwelcome);
    const attachments: string[] = [];
    if (email.attachPdf) {
      if (options.files === undefined)
        throw new ConflictError(
          'This install keeps no files, so the PDF cannot be attached. Send it without the PDF.',
        );
      const pdf = await pdfOf(await email.printable());
      attachments.push(
        await options.files.store(trx, command, { filename: pdf.filename, content: pdf.content }),
      );
    }
    const queued = await mail.send(trx, command.context, {
      ...address,
      idempotencyKey: email.idempotencyKey,
      ...email.words(attachments.length > 0),
      attachments,
    });
    if (queued.outcome === 'refused') throw refused(queued);
    return queued;
  }

  const document = defineCommand({
    name: 'sales_document.send',
    permission: MANAGE,
    input: documentSend,
    // What was sent and how, never the words or the address.
    audit: ({ id, values }) => ({
      id,
      revision: values.revision,
      attachPdf: values.attachPdf,
      issueIfDraft: values.issueIfDraft,
    }),
    async handle(trx, { id, values }, command): Promise<SalesDocumentSend> {
      const mail = mailOf();
      // The pipeline's lock on the business comes first, before anything else is held.
      await mail.hold(trx, command.context);
      const businessId = await heldBusiness(options, trx, command);
      let row = await lockedDocument(trx, id);
      // A send moves the revision on, so the same request sent twice sends once.
      if (row.revision !== values.revision) throw stale();
      const refusal = documentSendRefusal(stateOf(row), values.issueIfDraft);
      if (refusal !== undefined) throw new ConflictError(refusal);
      if (row.status === 'draft') {
        await documents.issue.handle(trx, { id, revision: row.revision }, command);
        row = await lockedDocument(trx, id);
      }
      if (row.contact_id === null)
        throw new ConflictError('The contact this was for is gone, so it cannot be sent.');
      const to = values.to ?? row.customer_email;
      if (to === null) throw noAddress();
      const link = linksAvailable(options)
        ? (await ensureLink(options, trx, command, businessId, row.id)).link
        : null;
      if (link === null && !values.attachPdf)
        throw new ConflictError(
          'There is nothing to send: this install gives documents no public address, and no PDF is attached.',
        );
      const read = await readDocument(options, trx, command, id);
      const queued = await deliver(trx, command, mail, {
        contactId: row.contact_id,
        to,
        mailboxId: values.mailboxId,
        idempotencyKey: `commerce:document:${row.id}:${String(row.revision)}`,
        attachPdf: values.attachPdf,
        printable: () => printableOf(options, trx, command, read),
        words: (attachedPdf) =>
          documentMail(read, {
            subject: values.subject,
            message: values.message,
            url: link?.url ?? null,
            attachedPdf,
          }),
      });
      const attachedPdf = values.attachPdf;
      await trx
        .updateTable('commerce.documents')
        .set({
          sent_at: sql<Date>`coalesce(sent_at, now())`,
          last_sent_at: sql<Date>`now()`,
          send_count: sql<number>`send_count + 1`,
          revision: row.revision + 1,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: `${kindOf(row.kind)}.sent`,
        subject: { kind: 'sales_document', id: row.id },
        // Identifiers and amounts only: events are kept for good, and an address is not.
        payload: {
          number: row.number,
          total: fourPlaces(row.total),
          currency: row.currency,
          messageId: queued.messageId,
          attachedPdf,
        },
        records: recordsOf(row),
      });
      return {
        document: await readDocument(options, trx, command, id),
        message: messageOf(queued, attachedPdf),
      };
    },
  });

  const receipt = defineCommand({
    name: 'payment.send',
    permission: MANAGE,
    input: receiptSendInput,
    audit: ({ id, values }) => ({ id, attachPdf: values.attachPdf }),
    async handle(trx, { id, values }, command): Promise<ReceiptSend> {
      const mail = mailOf();
      await mail.hold(trx, command.context);
      const businessId = await heldBusiness(options, trx, command);
      const paymentId = rowId('payment', id);
      const payment = await trx
        .selectFrom('commerce.payments')
        .select(['document_id', 'status'])
        .where('id', '=', paymentId)
        .executeTakeFirst();
      if (payment === undefined) throw notFound('payment', id);
      // The invoice's row is held, as when a payment is recorded: sends of one invoice's
      // receipts take turns.
      const invoice = await lockedDocument(trx, toPublicId('sales_document', payment.document_id));
      const idempotencyKey = `commerce:receipt:${paymentId}:${values.idempotencyKey}`;
      // The same press of Send, sent again: the first one's email, and nothing more.
      const earlier = await mail.find(trx, command.context, idempotencyKey);
      if (earlier !== undefined)
        return {
          receipt: await readReceipt(trx, command, id),
          message: messageOf(earlier, values.attachPdf),
        };
      if (payment.status === 'reversed')
        throw new ConflictError('This payment was reversed, so its receipt is not sent.');
      if (invoice.contact_id === null)
        throw new ConflictError('The contact this was for is gone, so it cannot be sent.');
      const to = values.to ?? invoice.customer_email;
      if (to === null) throw noAddress();
      // The link in a receipt's email is its invoice's, which shows what is still owed.
      const link =
        linksAvailable(options) && invoice.status !== 'void' && invoice.status !== 'draft'
          ? (await ensureLink(options, trx, command, businessId, invoice.id)).link
          : null;
      if (link === null && !values.attachPdf)
        throw new ConflictError(
          'There is nothing to send: the invoice has no public address, and no PDF is attached.',
        );
      const read = await readReceipt(trx, command, id);
      const queued = await deliver(trx, command, mail, {
        contactId: invoice.contact_id,
        to,
        mailboxId: values.mailboxId,
        idempotencyKey,
        attachPdf: values.attachPdf,
        printable: () => printableReceipt(options, trx, read),
        words: (attachedPdf) =>
          receiptMail(read, {
            subject: values.subject,
            message: values.message,
            url: link?.url ?? null,
            attachedPdf,
          }),
      });
      await trx
        .updateTable('commerce.payments')
        .set({ last_sent_at: sql<Date>`now()`, send_count: sql<number>`send_count + 1` })
        .where('id', '=', paymentId)
        .execute();
      await command.emit({
        type: 'payment.receipt_sent',
        subject: { kind: 'payment', id: paymentId },
        payload: {
          number: read.number,
          invoiceNumber: invoice.number,
          messageId: queued.messageId,
          attachedPdf: values.attachPdf,
        },
        records: recordsOf(invoice),
      });
      return {
        receipt: await readReceipt(trx, command, id),
        message: messageOf(queued, values.attachPdf),
      };
    },
  });

  return { document, receipt };
}
