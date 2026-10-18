import { connectMailboxInput } from '@repo/contracts';
import { withTenant, type Database } from '@repo/db';
import type { MailAttachment, MailboxSubmitter } from '@repo/mail';
import type { TenantContext } from '@repo/kernel';
import type { Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import { MAILBOX_CREDENTIALS } from './attempts.js';
import { readCampaignGate, readCampaignSender } from './campaign-gate.js';
import { withUnsubscribeAddress } from './campaign-rules.js';
import {
  copiedHtml,
  copiedText,
  deliveredHtml,
  deliveredText,
  readPostalAddressLine,
} from './email-compose.js';
import { outboundMessageIdOf } from './email-thread.js';
import { evaluateMailboxAdmission } from './mailbox-admission.js';
import {
  createDispatchOutboundTask,
  type OutboundAdmission,
  type OutboundChannel,
} from './outbound.js';
import { createUnsubscribeLink } from './unsubscribe.js';

/**
 * Reads a file a message carries, in the message's own business: its name, type and bytes,
 * or undefined when the file is gone. The worker hands over the files service's reader; a
 * role without one sends no message that carries a file.
 */
export type OutboundAttachmentReader = (
  context: TenantContext,
  fileId: string,
) => Promise<MailAttachment | undefined>;

/** The most bytes one message's files come to. Larger mail is refused by many servers. */
export const OUTBOUND_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** The Message-ID of the copy a marketing email's Cc and Bcc addresses get: never the contact's. */
const copyMessageIdOf = (messageId: string, part: number): string =>
  `<crm-outbound-copy.${String(part)}.${messageId}@crm.invalid>`;

/**
 * Who a marketing email's copies go to, one message each entry. The contact's own email
 * names nobody else (see deliver below), so the copies are messages of their own: one to
 * the Cc addresses together, who may see each other as Cc always shows, with the Bcc
 * addresses unseen on it; or, with no Cc, one to each Bcc address alone, so none of them
 * is shown another.
 */
export function copyRecipients(
  cc: readonly string[],
  bcc: readonly string[],
): readonly {
  readonly to: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}[] {
  const [first, ...rest] = cc;
  if (first !== undefined) return [{ to: first, cc: rest, bcc }];
  return bcc.map((address) => ({ to: address, cc: [], bcc: [] }));
}

/** Worker-only composition. SMTP credentials never enter a job or a provider error. */
export function createSmtpDispatchTask(
  vault: Vault,
  submitter: MailboxSubmitter,
  db: Database,
  publicUrl: string,
  readAttachment?: OutboundAttachmentReader,
): ReturnType<typeof createDispatchOutboundTask> {
  const channel = createSmtpOutbound(vault, submitter, db, publicUrl, readAttachment);
  return createDispatchOutboundTask(channel.sender, channel.admission);
}

/** SMTP ports can share dispatch with SMS while keeping mailbox admission intact. */
export function createSmtpOutbound(
  vault: Vault,
  submitter: MailboxSubmitter,
  db: Database,
  publicUrl: string,
  readAttachment?: OutboundAttachmentReader,
): OutboundChannel {
  const origin = new URL(publicUrl);
  const unsubscribeAvailable =
    origin.protocol === 'https:' && origin.username === '' && origin.password === '';
  const admission: OutboundAdmission = async (trx, context, message) => {
    if (message.channel !== 'email') return { action: 'refuse', reason: 'unsupported_channel' };
    if (message.purpose === 'marketing' && !unsubscribeAvailable)
      return { action: 'refuse', reason: 'unsubscribe_unavailable' };
    // Every marketing email shows the business's postal address (15 U.S.C.
    // 7704(a)(5)(A)(iii)); without one in the profile it is not sent.
    if (message.purpose === 'marketing' && (await readPostalAddressLine(trx, context)) === null)
      return { action: 'refuse', reason: 'postal_address_missing' };
    // A message that carries a file is sent whole or not at all.
    if (message.attachments.length > 0 && readAttachment === undefined)
      return { action: 'refuse', reason: 'attachments_unavailable' };
    // A campaign that was paused or cancelled after this email was released holds it here,
    // in the transaction that would reserve it: nothing of the campaign leaves after that.
    if (message.lane === 'campaign') {
      const gate = await readCampaignGate(trx, message.messageId);
      if (gate !== undefined) return gate;
    }
    const {
      rows: [row],
    } = await sql<{
      daily_limit: number;
      pacing_per_minute: number;
      warmup_enabled: boolean;
      use_for_conversations: boolean;
      use_for_campaigns: boolean;
      now_ms: number;
      elapsed_days: number;
      paused_until_ms: number | null;
      recent_all: number;
      recent_automated: number;
      earliest_ms: number | null;
      last_ms: number | null;
    }>`
      select mb.daily_limit,mb.pacing_per_minute,mb.warmup_enabled,
        mb.use_for_conversations,mb.use_for_campaigns,
        (extract(epoch from now())*1000)::float8 as now_ms,
        (extract(epoch from (now()-coalesce(mb.warmup_started_at,mb.created_at)))/86400)::float8 as elapsed_days,
        (extract(epoch from mb.sending_paused_until)*1000)::float8 as paused_until_ms,
        usage.recent_all,usage.recent_automated,usage.earliest_ms,usage.last_ms
      from messaging.mailboxes mb
      cross join lateral (
        select count(*)::integer as recent_all,
          count(*) filter(where d.lane in ('automation','campaign'))::integer as recent_automated,
          (extract(epoch from min(d.reserved_at))*1000)::float8 as earliest_ms,
          (extract(epoch from max(d.reserved_at))*1000)::float8 as last_ms
        from messaging.outbound_dispatch d
        join messaging.messages m on m.business_id=d.business_id and m.id=d.id
        where d.business_id=mb.business_id and m.channel_account_id=mb.id
          and d.reserved_at>now()-interval '24 hours'
      ) usage
      where mb.id=${message.accountId}::uuid
    `.execute(trx);
    if (row === undefined) return { action: 'refuse', reason: 'mailbox_unavailable' };
    if (message.lane === 'campaign' ? !row.use_for_campaigns : !row.use_for_conversations)
      return { action: 'refuse', reason: 'mailbox_use_disabled' };
    const decision = evaluateMailboxAdmission({
      nowMs: row.now_ms,
      dailyLimit: row.daily_limit,
      pacingPerMinute: row.pacing_per_minute,
      warmupEnabled: row.warmup_enabled,
      elapsedDays: row.elapsed_days,
      recentAll: row.recent_all,
      recentAutomated: row.recent_automated,
      earliestReservationMs: row.earliest_ms,
      lastReservationMs: row.last_ms,
      pausedUntilMs: row.paused_until_ms,
      lane: message.lane,
    });
    return decision.action === 'allow'
      ? decision
      : {
          action: 'defer',
          reason: decision.reason,
          retryAt: new Date(decision.retryAtMs),
        };
  };
  return {
    sender: {
      async deliver(message, context) {
        const prepared = await withTenant(db, context, async (trx) => {
          const row = await trx
            .selectFrom('messaging.mailboxes')
            .select(['secret_id', 'email_address', 'display_name'])
            .where('id', '=', message.accountId)
            .executeTakeFirst();
          if (row === undefined) return null;
          const input = connectMailboxInput.parse(
            JSON.parse(await vault.read(trx, row.secret_id, MAILBOX_CREDENTIALS)),
          );
          // A campaign's email carries the name and reply address the campaign chose.
          const campaign =
            message.purpose === 'marketing'
              ? await readCampaignSender(trx, message.messageId)
              : undefined;
          // The calendar invite this email carries, if any (calendar-confirmations.ts).
          const invite = await trx
            .selectFrom('messaging.message_invites')
            .select(['method', 'content'])
            .where('message_id', '=', message.messageId)
            .executeTakeFirst();
          return {
            invite,
            login: input.smtp,
            // A workflow's email carries its step's own; the address is the mailbox's.
            from: {
              address: row.email_address,
              name: campaign?.fromName ?? message.fromName ?? row.display_name,
            },
            replyTo: campaign?.replyTo ?? message.replyTo ?? undefined,
            ...(message.purpose === 'marketing'
              ? {
                  unsubscribeUrl: await createUnsubscribeLink(
                    trx,
                    context,
                    message.messageId,
                    publicUrl,
                  ),
                }
              : {}),
            // A workflow's marketing email ends with where the business is, and with how to
            // unsubscribe unless its body shows a link of its own (email-compose.ts). A
            // campaign writes both into its body when it is released.
            footer:
              message.purpose === 'marketing' && message.lane === 'automation'
                ? { addressLine: await readPostalAddressLine(trx, context) }
                : undefined,
          };
        });
        if (prepared === null) return { outcome: 'rejected' };
        // Nothing has been handed to the mail server yet: a file that is gone, or files too
        // large to send, end the message here, and nothing is half sent.
        const attachments: MailAttachment[] = [];
        for (const fileId of message.attachments) {
          const file = await readAttachment?.(context, fileId);
          if (file === undefined) return { outcome: 'rejected' };
          attachments.push(file);
        }
        if (
          attachments.reduce((bytes, file) => bytes + file.content.byteLength, 0) >
          OUTBOUND_ATTACHMENT_BYTES
        )
          return { outcome: 'rejected' };
        // The visible unsubscribe link: a body written with one waits for the address this
        // email was just given (campaign-rules.ts). Other mail holds no such place.
        const address = prepared.unsubscribeUrl;
        const cc = message.cc ?? [];
        const bcc = message.bcc ?? [];
        // An email with an unsubscribe link is the contact's alone. The link, in the body and
        // in the List-Unsubscribe header, withdraws the contact's consent for whoever follows
        // it, and one SMTP message is the same bytes for every recipient: so Cc and Bcc get a
        // copy of their own below, without the link, and this message names only the contact.
        const apart = address !== undefined && cc.length + bcc.length > 0;
        const receipt = await submitter.submit(prepared.login, prepared.from, {
          messageId: outboundMessageIdOf(message.messageId),
          // Stored when the reply was written; the adapter checks every id again.
          reply: message.reply,
          to: message.to,
          subject: message.subject ?? '',
          text:
            address === undefined
              ? message.text
              : prepared.footer === undefined
                ? withUnsubscribeAddress(message.text, address)
                : deliveredText(message.text, address, prepared.footer.addressLine),
          ...(message.html === null
            ? {}
            : {
                html:
                  address === undefined
                    ? message.html
                    : prepared.footer === undefined
                      ? withUnsubscribeAddress(message.html, address)
                      : deliveredHtml(message.html, address, prepared.footer.addressLine),
              }),
          ...(address === undefined ? {} : { unsubscribeUrl: address }),
          // Workflow and campaign mail is a program's: RFC 3834 asks responders not to answer.
          ...(message.lane === 'automation' || message.lane === 'campaign'
            ? { autoSubmitted: true }
            : {}),
          ...(prepared.replyTo === undefined ? {} : { replyTo: prepared.replyTo }),
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(prepared.invite === undefined
            ? {}
            : {
                calendarInvite: {
                  method: prepared.invite.method === 'CANCEL' ? 'CANCEL' : 'REQUEST',
                  content: prepared.invite.content,
                },
              }),
          ...(apart || cc.length === 0 ? {} : { cc }),
          ...(apart || bcc.length === 0 ? {} : { bcc }),
        });
        if (receipt.outcome === 'accepted') {
          // The copies leave only once the contact's own email was taken, and what becomes
          // of them does not change what became of it: the contact has the email, and a
          // second try would send it to them again.
          if (apart) {
            const addressLine = prepared.footer?.addressLine ?? null;
            for (const [part, copy] of copyRecipients(cc, bcc).entries())
              await submitter
                .submit(prepared.login, prepared.from, {
                  messageId: copyMessageIdOf(message.messageId, part),
                  reply: message.reply,
                  to: copy.to,
                  subject: message.subject ?? '',
                  text: copiedText(message.text, message.to, addressLine),
                  ...(message.html === null
                    ? {}
                    : { html: copiedHtml(message.html, message.to, addressLine) }),
                  // No unsubscribeUrl: the adapter then writes no List-Unsubscribe header.
                  ...(prepared.replyTo === undefined ? {} : { replyTo: prepared.replyTo }),
                  ...(attachments.length === 0 ? {} : { attachments }),
                  ...(copy.cc.length === 0 ? {} : { cc: copy.cc }),
                  ...(copy.bcc.length === 0 ? {} : { bcc: copy.bcc }),
                })
                .catch(() => undefined);
          }
          return { outcome: 'accepted', providerId: receipt.messageId };
        }
        if (receipt.outcome === 'rejected' && receipt.temporary)
          await withTenant(db, context, async (trx) => {
            await trx
              .updateTable('messaging.mailboxes')
              .set({
                sending_paused_until: sql`now()+interval '15 minutes'`,
                sending_pause_reason: 'provider_temporary',
              })
              .where('id', '=', message.accountId)
              .execute();
          });
        return { outcome: receipt.outcome };
      },
    },
    admission,
  };
}
