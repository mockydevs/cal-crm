import { randomUUID } from 'node:crypto';

import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type CommandContext,
  type Services,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { connectMailboxInput, createContactInput } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';
import {
  parseDeliveryReport,
  parseFeedbackReport,
  parseInboundMessage,
  type DeliveryReport,
  type FeedbackReport,
  type InboundMessage,
  type MailboxInboxCursor,
  type MailboxReader,
} from '@repo/mail';
import { createContact } from '@repo/module-crm';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { MAILBOX_CREDENTIALS } from './attempts.js';
import { recordBounceCommand, recordComplaintCommand } from './bounces.js';

export const syncMailboxReference = {
  name: 'mailboxes.sync',
  data: z.strictObject({ mailboxId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

type RefusalReason =
  | 'message_too_large'
  | 'too_many_attachments'
  | 'malformed'
  | 'html_too_large'
  | 'received_date_unavailable';

/** One inbox UID, as read and parsed outside any transaction. */
export type InboundItem =
  | {
      readonly uid: number;
      readonly outcome: 'refused';
      readonly reason: RefusalReason;
      readonly sourceSha256: Buffer | null;
    }
  | {
      readonly uid: number;
      readonly outcome: 'parsed';
      readonly message: InboundMessage;
      /** The server's INTERNALDATE: when the mailbox received it. */
      readonly receivedAt: Date | null;
      /** What a delivery report says, when the message is one that could be read as such. */
      readonly report?: DeliveryReport | null;
      /** What a feedback report (RFC 5965) says, when the message is one. */
      readonly complaint?: FeedbackReport | null;
    };

const cursor = z.strictObject({
  uidValidity: z.string().regex(/^[1-9]\d{0,9}$/),
  lastUid: z.number().int().min(0).max(4294967295),
});

const isItem = (value: unknown): value is InboundItem =>
  typeof value === 'object' &&
  value !== null &&
  'uid' in value &&
  typeof value.uid === 'number' &&
  'outcome' in value &&
  (value.outcome === 'refused' || value.outcome === 'parsed');

const ingestInput = z.strictObject({
  mailboxId: z.uuid(),
  /** The position this run read from; a different stored one means another run moved it. */
  expected: cursor.nullable(),
  /** The credentials the run read with; replaced or rotated ones mean it read another login. */
  credentials: z.strictObject({ secretId: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  next: cursor,
  /** For a mailbox without a cursor: the time just before this first read. */
  startedAt: z.date().nullable(),
  items: z.array(z.custom<InboundItem>(isItem)).max(1000),
});

type Outcome =
  | 'stored'
  | 'duplicate'
  | 'refused'
  | 'own_message'
  | 'sender_is_mailbox'
  | 'sender_unresolved'
  | 'delivery_report'
  | 'complaint_report'
  | 'sender_unauthenticated'
  | 'before_connection';

// The Message-ID the SMTP dispatcher gives each outbound message (smtp-outbound.ts).
const OUTBOUND_ID =
  /^<crm-outbound\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@crm\.invalid>$/;
const outboundIdOf = (messageId: string) => OUTBOUND_ID.exec(messageId)?.[1];

const sameCursor = (a: MailboxInboxCursor | null, b: MailboxInboxCursor | null) =>
  a === null || b === null ? a === b : a.uidValidity === b.uidValidity && a.lastUid === b.lastUid;

// A display name, split for a contact's first and last name; never the address itself.
function nameOf(
  name: string,
  address: string,
): { firstName: string | null; lastName: string | null } {
  const words =
    name.includes('@') || name.toLowerCase() === address ? [] : name.split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  return { firstName: first ?? null, lastName: rest.length === 0 ? null : rest.join(' ') };
}

interface Mailbox {
  readonly id: string;
  readonly address: string;
}

/** The sender's contact, created when the address belongs to nobody in the business yet. */
async function senderContact(
  trx: DatabaseTransaction,
  command: CommandContext,
  address: string,
  name: string,
): Promise<string | null> {
  const find = () =>
    trx
      .selectFrom('crm.contact_identities')
      .select('contact_id')
      .where('kind', '=', 'email')
      .where('value_normalized', '=', address)
      .executeTakeFirst();
  const known = await find();
  if (known !== undefined) return known.contact_id;
  const input = createContactInput.safeParse({ ...nameOf(name, address), emails: [address] });
  if (!input.success) return null;
  // The CRM's own command keeps its invariants: identities, timeline and contact.created.
  // It is told how the contact came to be: the system acts here, which alone doesn't say.
  await createContact(trx, input.data, command, 'email');
  return (await find())?.contact_id ?? null;
}

/** The stored message a reply answers, in the same conversation only. */
async function parentOf(
  trx: DatabaseTransaction,
  conversationId: string,
  message: InboundMessage,
): Promise<string | null> {
  // In-Reply-To first, then References from the newest.
  const candidates = [...new Set([...message.inReplyTo, ...[...message.references].reverse()])];
  if (candidates.length === 0) return null;
  const outboundIds = candidates.flatMap((id) => outboundIdOf(id) ?? []);
  const rows = await trx
    .selectFrom('messaging.messages')
    .select(['id', 'direction', 'email_message_id'])
    .where('conversation_id', '=', conversationId)
    .where((eb) =>
      eb.or([
        eb('email_message_id', 'in', candidates),
        ...(outboundIds.length === 0
          ? []
          : [eb.and([eb('direction', '=', 'outbound'), eb('id', 'in', outboundIds)])]),
      ]),
    )
    .execute();
  for (const candidate of candidates) {
    const outboundId = outboundIdOf(candidate);
    const row = rows.find((each) =>
      outboundId === undefined
        ? each.email_message_id === candidate
        : each.direction === 'outbound' && each.id === outboundId,
    );
    if (row !== undefined) return row.id;
  }
  return null;
}

/** An address without its "+tag": ada+shop@example.com and ada@example.com are one mailbox. */
const mailboxOf = (address: string): string => {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  const plus = lower.indexOf('+');
  return plus > 0 && plus < at ? `${lower.slice(0, plus)}${lower.slice(at)}` : lower;
};

/**
 * The conversation a reply belongs in when its sender wrote from the plain form of the
 * address our message went to: we wrote to ada+shop@example.com and ada@example.com answers.
 * Only a message this mailbox itself sent counts, and only when the two addresses are one
 * mailbox; anyone else quoting the thread stays in their own conversation.
 */
async function answeredFromSameMailbox(
  trx: DatabaseTransaction,
  mailboxId: string,
  message: InboundMessage,
  senderAddress: string,
): Promise<{ conversationId: string; contactId: string; parentId: string } | undefined> {
  const candidates = [...new Set([...message.inReplyTo, ...[...message.references].reverse()])];
  const outboundIds = candidates.flatMap((id) => outboundIdOf(id) ?? []);
  if (outboundIds.length === 0) return undefined;
  const rows = await trx
    .selectFrom('messaging.messages as m')
    .innerJoin('messaging.conversations as c', (join) =>
      join.onRef('c.business_id', '=', 'm.business_id').onRef('c.id', '=', 'm.conversation_id'),
    )
    .select(['m.id', 'm.conversation_id', 'm.to_addresses', 'c.contact_id'])
    .where('m.direction', '=', 'outbound')
    .where('m.channel_account_id', '=', mailboxId)
    .where('m.id', 'in', outboundIds)
    .execute();
  const exact = senderAddress.trim().toLowerCase();
  const from = mailboxOf(senderAddress);
  // In-Reply-To first, then References from the newest, as parentOf reads them.
  for (const id of outboundIds) {
    const row = rows.find((each) => each.id === id);
    if (row === undefined) continue;
    const sentTo = row.to_addresses;
    // The very address is the ordinary case, which the sender's own contact already covers.
    if (sentTo.some((to) => to.trim().toLowerCase() === exact)) return undefined;
    if (sentTo.some((to) => mailboxOf(to) === from))
      return { conversationId: row.conversation_id, contactId: row.contact_id, parentId: row.id };
  }
  return undefined;
}

async function storeMessage(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  mailbox: Mailbox,
  message: InboundMessage,
  receivedAt: Date | null,
  report: DeliveryReport | null,
  complaint: FeedbackReport | null,
): Promise<{ outcome: Outcome; messageId: string | null }> {
  if (message.feedbackReport) {
    // A spam complaint from a feedback loop is never filed as a conversation either; one
    // about a message this mailbox sent suppresses its recipient (bounces.ts).
    if (complaint !== null)
      await recordComplaintCommand.handle(
        trx,
        recordComplaintCommand.input.parse({
          mailboxId: mailbox.id,
          report: {
            feedbackType: complaint.feedbackType.slice(0, 100),
            originalMessageId: complaint.originalMessageId,
          },
        }),
        command,
      );
    return { outcome: 'complaint_report', messageId: null };
  }
  if (message.deliveryReport) {
    // A report is never filed as a conversation. Whatever it says, its UID keeps this
    // outcome; only a bounce tied to a message this mailbox sent changes anything more.
    if (report !== null)
      await recordBounceCommand.handle(
        trx,
        // Only what the decision needs: which message, which address, and what was said.
        recordBounceCommand.input.parse({
          mailboxId: mailbox.id,
          report: {
            originalMessageId: report.originalMessageId,
            recipients: report.recipients.map((recipient) => ({
              finalRecipient: recipient.finalRecipient,
              originalRecipient: recipient.originalRecipient,
              status: recipient.status,
              bounce: recipient.bounce,
            })),
          },
        }),
        command,
      );
    return { outcome: 'delivery_report', messageId: null };
  }
  const ownId = message.messageId === null ? undefined : outboundIdOf(message.messageId);
  if (ownId !== undefined) {
    const own = await trx
      .selectFrom('messaging.messages')
      .select('id')
      .where('id', '=', ownId)
      .where('direction', '=', 'outbound')
      .where('channel_account_id', '=', mailbox.id)
      .executeTakeFirst();
    if (own !== undefined) return { outcome: 'own_message', messageId: own.id };
  }
  const { sender } = message;
  if (sender.kind === 'unresolved') return { outcome: 'sender_unresolved', messageId: null };
  // Only a known Message-ID proves mail is ours; a From claiming the mailbox proves nothing.
  if (sender.address === mailbox.address) return { outcome: 'sender_is_mailbox', messageId: null };
  // The receiving server says the From address was forged (DMARC failed for its domain): it
  // is not filed under whoever holds that address, starts no workflow and makes no contact.
  // The mail stays in the mailbox itself, where the person can read it.
  if (message.senderAuthentication === 'fail')
    return { outcome: 'sender_unauthenticated', messageId: null };

  const stored =
    message.messageId === null
      ? undefined
      : await trx
          .selectFrom('messaging.messages')
          .select('id')
          .where('channel_account_id', '=', mailbox.id)
          .where('direction', '=', 'inbound')
          .where('email_message_id', '=', message.messageId)
          .executeTakeFirst();
  if (stored !== undefined) return { outcome: 'duplicate', messageId: stored.id };
  const sameBytes = await trx
    .selectFrom('messaging.mailbox_inbound_uids')
    .select('message_id')
    .where('mailbox_id', '=', mailbox.id)
    .where('outcome', '=', 'stored')
    .where('source_sha256', '=', message.sourceSha256)
    .executeTakeFirst();
  if (sameBytes !== undefined) return { outcome: 'duplicate', messageId: sameBytes.message_id };

  // A reply from the plain form of the address we wrote to goes where our message is.
  const answered = await answeredFromSameMailbox(trx, mailbox.id, message, sender.address);
  const contactId =
    answered?.contactId ?? (await senderContact(trx, command, sender.address, sender.name));
  if (contactId === null) return { outcome: 'sender_unresolved', messageId: null };
  const conversation =
    answered === undefined
      ? await trx
          .insertInto('messaging.conversations')
          .values({ business_id: businessId, contact_id: contactId })
          .onConflict((oc) =>
            oc.columns(['business_id', 'contact_id']).doUpdateSet({ contact_id: contactId }),
          )
          .returning('id')
          .executeTakeFirstOrThrow()
      : { id: answered.conversationId };
  const at = receivedAt ?? new Date();
  const inserted = await trx
    .insertInto('messaging.messages')
    .values({
      business_id: businessId,
      conversation_id: conversation.id,
      channel: 'email',
      channel_account_id: mailbox.id,
      direction: 'inbound',
      status: 'received',
      subject: message.subject,
      body_text: message.text,
      body_html: message.html,
      from_address: sender.address,
      to_addresses: message.to.map((each) => each.address),
      cc_addresses: message.cc.map((each) => each.address),
      email_message_id: message.messageId,
      // Every id the header had, as it had them: a reply to this message needs to know
      // whether it named one message or several (RFC 5322 section 3.6.4).
      in_reply_to: message.inReplyTo.length === 0 ? null : message.inReplyTo.join(' '),
      email_references: [...message.references],
      parent_message_id: answered?.parentId ?? (await parentOf(trx, conversation.id, message)),
      automated: message.automated,
      author_kind: 'contact',
      author_id: contactId,
      sent_at: message.headerDate,
      created_at: at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // A new message reopens the conversation, and wakes a snoozed one.
  await trx
    .updateTable('messaging.conversations')
    .set((eb) => ({
      status: 'open',
      snoozed_until: null,
      needs_reply: true,
      unread_count: eb('unread_count', '+', 1),
      last_message_at: sql<Date>`greatest(last_message_at, ${at})`,
      last_inbound_at: sql<Date>`greatest(last_inbound_at, ${at})`,
    }))
    .where('id', '=', conversation.id)
    .execute();
  await command.emit({
    // An out-of-office or other automatic answer (Auto-Submitted other than "no", RFC 3834)
    // is not the contact writing in: it starts no "message received" workflow and ends no
    // "until they reply" wait. It is still filed, under an event of its own.
    type: message.automated ? 'message.auto_reply_received' : 'message.received',
    subject: { kind: 'message', id: inserted.id },
    payload: { conversationId: conversation.id, mailboxId: mailbox.id, channel: 'email' },
    records: [contactId],
  });
  return { outcome: 'stored', messageId: inserted.id };
}

/**
 * The sealed credentials' digest, share-locked until the transaction ends so they can't be
 * replaced meanwhile. Any change, a rotation included, gives a different digest.
 */
async function credentialsOf(
  trx: DatabaseTransaction,
  secretId: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('vault.secrets')
    .select(sql<string>`encode(sha256(enc || ciphertext), 'hex')`.as('sha256'))
    .where('id', '=', secretId)
    .forShare()
    .executeTakeFirst();
  return row?.sha256;
}

/**
 * Records one batch of an inbox's UIDs and moves its cursor, all or nothing. Only the
 * worker's system actor runs it: the sender headers it reads are untrusted claims.
 */
export const ingestInboundCommand = defineCommand({
  name: 'mailbox.ingest_inbound',
  permission: 'mailboxes.manage',
  input: ingestInput,
  // Identifiers only: no addresses, headers or bodies reach the audit log.
  audit: (input) => ({
    mailboxId: input.mailboxId,
    uidValidity: input.next.uidValidity,
    uids: input.items.map((item) => item.uid),
  }),
  async handle(trx, input, command): Promise<{ applied: boolean; stored: number }> {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the mailbox sync records inbound mail.');
    const businessId = requireBusiness(command.context);
    // The business first, as every writer of conversations takes it (the lock order).
    // Inbound SMS holds it FOR UPDATE and then takes the senders' lock below; a batch that
    // took that lock first and the business after it deadlocked with one (40P01).
    // Share-locked and held until commit: a business switched off meanwhile either commits
    // first, and is seen here, or waits for this batch.
    const business = await trx
      .selectFrom('tenancy.businesses')
      .select('id')
      .where('id', '=', businessId)
      .where('status', '=', 'active')
      .forShare()
      .executeTakeFirst();
    if (business === undefined) return { applied: false, stored: 0 };
    // Unknown senders are looked up and created one batch at a time per business, so two
    // mailboxes can't create the same contact at once.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`inbound-senders:${businessId}`}, 0))`.execute(
      trx,
    );
    const row = await trx
      .selectFrom('messaging.mailboxes as mailbox')
      .innerJoin('messaging.channel_accounts as channel', 'channel.id', 'mailbox.id')
      .innerJoin('tenancy.businesses as business', 'business.id', 'mailbox.business_id')
      .select([
        'mailbox.id',
        'mailbox.email_normalized',
        'mailbox.imap_uid_validity',
        'mailbox.imap_last_uid',
        'mailbox.secret_id',
        'mailbox.created_at',
        'mailbox.inbound_started_at',
        'mailbox.inbound_uid_validity',
      ])
      .where('mailbox.id', '=', input.mailboxId)
      .where('mailbox.use_for_conversations', '=', true)
      .where('channel.status', '=', 'active')
      .where('business.status', '=', 'active')
      .forUpdate('mailbox')
      .executeTakeFirst();
    if (row === undefined) return { applied: false, stored: 0 };
    // Held until commit: a channel switched off meanwhile either commits first, and is seen
    // here, or waits for this batch.
    const channel = await trx
      .selectFrom('messaging.channel_accounts')
      .select('id')
      .where('id', '=', row.id)
      .where('status', '=', 'active')
      .forShare()
      .executeTakeFirst();
    if (channel === undefined) return { applied: false, stored: 0 };
    const current =
      row.imap_uid_validity === null
        ? null
        : { uidValidity: row.imap_uid_validity, lastUid: Number(row.imap_last_uid ?? 0) };
    if (!sameCursor(current, input.expected)) return { applied: false, stored: 0 };
    if (row.secret_id !== input.credentials.secretId) return { applied: false, stored: 0 };
    const secret = await credentialsOf(trx, row.secret_id);
    if (secret !== input.credentials.sha256) return { applied: false, stored: 0 };

    // Generated from a not-null column; typed nullable by the generator.
    const mailbox = { id: row.id, address: row.email_normalized ?? '' };
    // A UID read again under the same UIDVALIDITY already has its outcome.
    const recorded = new Set(
      input.items.length === 0
        ? []
        : (
            await trx
              .selectFrom('messaging.mailbox_inbound_uids')
              .select('uid')
              .where('mailbox_id', '=', mailbox.id)
              .where('uid_validity', '=', input.next.uidValidity)
              .where(
                'uid',
                'in',
                input.items.map((item) => String(item.uid)),
              )
              .execute()
          ).map((each) => Number(each.uid)),
    );
    // A UIDVALIDITY reset makes the server send its whole inbox again. Only mail received
    // after sync began is read; INTERNALDATE has whole seconds (RFC 9051). The baseline's
    // UIDVALIDITY; a mailbox without one takes the first it's read under.
    const origin = row.inbound_uid_validity ?? current?.uidValidity ?? input.next.uidValidity;
    const reset = input.next.uidValidity !== origin;
    const startedAt = row.inbound_started_at ?? row.created_at;
    const cutoff = Math.floor(startedAt.getTime() / 1000) * 1000;
    const onReset = (receivedAt: Date | null) =>
      !reset
        ? undefined
        : receivedAt === null
          ? { outcome: 'refused' as const, reason: 'received_date_unavailable' as const }
          : receivedAt.getTime() < cutoff
            ? { outcome: 'before_connection' as const, reason: null }
            : undefined;
    let stored = 0;
    for (const item of [...input.items].sort((a, b) => a.uid - b.uid)) {
      if (recorded.has(item.uid)) continue;
      const skipped = item.outcome === 'parsed' ? onReset(item.receivedAt) : undefined;
      const result =
        item.outcome === 'refused'
          ? { outcome: 'refused' as const, reason: item.reason, messageId: null }
          : skipped !== undefined
            ? { ...skipped, messageId: null }
            : {
                ...(await storeMessage(
                  trx,
                  command,
                  businessId,
                  mailbox,
                  item.message,
                  item.receivedAt,
                  item.report ?? null,
                  item.complaint ?? null,
                )),
                reason: null,
              };
      if (result.outcome === 'stored') stored += 1;
      await trx
        .insertInto('messaging.mailbox_inbound_uids')
        .values({
          business_id: businessId,
          mailbox_id: mailbox.id,
          uid_validity: input.next.uidValidity,
          uid: String(item.uid),
          outcome: result.outcome,
          reason: result.reason,
          message_id: result.messageId,
          source_sha256: item.outcome === 'refused' ? item.sourceSha256 : item.message.sourceSha256,
        })
        .execute();
    }
    await trx
      .updateTable('messaging.mailboxes')
      .set({
        imap_uid_validity: input.next.uidValidity,
        imap_last_uid: String(input.next.lastUid),
        last_synced_at: sql<Date>`now()`,
        inbound_started_at: row.inbound_started_at ?? input.startedAt,
        inbound_uid_validity: origin,
      })
      .where('id', '=', mailbox.id)
      .execute();
    // The inbox may hold more: read on until a run makes no progress.
    if (!sameCursor(input.expected, input.next))
      await sql`select private.enqueue_mailbox_sync(${mailbox.id}::uuid, null::uuid)`.execute(trx);
    return { applied: true, stored };
  },
});

const unavailable = () => new Error('The mailbox credentials are unavailable.');

async function itemOf(
  message: Awaited<ReturnType<MailboxReader['readInbox']>>['messages'][number],
) {
  if (message.outcome === 'refused')
    return {
      uid: message.uid,
      outcome: 'refused',
      reason: message.reason,
      sourceSha256: null,
    } as const;
  const parsed = await parseInboundMessage(message.source);
  return parsed.outcome === 'refused'
    ? ({
        uid: message.uid,
        outcome: 'refused',
        reason: parsed.reason,
        sourceSha256: parsed.sourceSha256,
      } as const)
    : ({
        uid: message.uid,
        outcome: 'parsed',
        message: parsed.message,
        receivedAt: message.internalDate,
        report: parsed.message.deliveryReport ? await parseDeliveryReport(message.source) : null,
        complaint: parsed.message.feedbackReport ? await parseFeedbackReport(message.source) : null,
      } as const);
}

/**
 * Reads the next batch of a mailbox's inbox. Credentials are decrypted and mail is read
 * outside any transaction; only the ingest command writes, after rechecking the cursor.
 */
export function createSyncMailboxTask(
  vault: Vault,
  reader: MailboxReader,
): Task<typeof syncMailboxReference.data> {
  return defineTask({
    ...syncMailboxReference,
    async run({ mailboxId }, { invocation, services }) {
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await trx
          .selectFrom('messaging.mailboxes as mailbox')
          .innerJoin('messaging.channel_accounts as channel', 'channel.id', 'mailbox.id')
          .innerJoin('tenancy.businesses as business', 'business.id', 'mailbox.business_id')
          .select(['mailbox.secret_id', 'mailbox.imap_uid_validity', 'mailbox.imap_last_uid'])
          .where('mailbox.id', '=', mailboxId)
          .where('mailbox.use_for_conversations', '=', true)
          .where('channel.status', '=', 'active')
          .where('business.status', '=', 'active')
          .executeTakeFirst();
        if (row === undefined) return null;
        // Locked first, so the digest is of the credentials decrypted next.
        const sha256 = await credentialsOf(trx, row.secret_id);
        if (sha256 === undefined) throw unavailable();
        let credentials: unknown = undefined;
        try {
          credentials = JSON.parse(await vault.read(trx, row.secret_id, MAILBOX_CREDENTIALS));
        } catch (failure) {
          if (!(failure instanceof SecretUnreadableError || failure instanceof SyntaxError))
            throw failure;
        }
        // Thrown without the cause: a JSON error can quote the decrypted credentials.
        const input = connectMailboxInput.safeParse(credentials);
        if (!input.success) throw unavailable();
        return {
          login: input.data.imap,
          credentials: { secretId: row.secret_id, sha256 },
          cursor:
            row.imap_uid_validity === null
              ? null
              : { uidValidity: row.imap_uid_validity, lastUid: Number(row.imap_last_uid ?? 0) },
        };
      });
      if (prepared === null) return;
      // Taken before the first read of a mailbox connected without a baseline.
      const startedAt = prepared.cursor === null ? new Date() : null;
      // A connection failure fails the job, so the queue retries it with backoff.
      const read = await reader.readInbox(prepared.login, prepared.cursor);
      const items: InboundItem[] = [];
      for (const message of read.messages) items.push(await itemOf(message));
      await runCommand(
        services,
        ingestInboundCommand,
        {
          mailboxId,
          expected: prepared.cursor,
          credentials: prepared.credentials,
          next: read.cursor,
          startedAt,
          items,
        },
        invocation,
      );
    },
  });
}

/** Bounded identifier-only discovery; each sync is queued in its own tenant. */
export async function scheduleMailboxSyncs(services: Services): Promise<number> {
  const { rows } = await sql<{ agency_id: string; business_id: string; mailbox_id: string }>`
    select * from private.due_mailbox_syncs(1000)
  `.execute(services.db);
  for (const row of rows)
    await withTenant(
      services.db,
      {
        agencyId: row.agency_id,
        businessId: row.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      },
      (trx) =>
        sql`select private.enqueue_mailbox_sync(${row.mailbox_id}::uuid, null::uuid)`.execute(trx),
    );
  return rows.length;
}
