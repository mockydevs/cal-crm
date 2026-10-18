import { defineCommand, requireBusiness } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

export type BounceKind = 'hard' | 'soft';

/** One recipient of a parsed delivery report (RFC 3464), as the mail adapter reads it. */
export interface BounceRecipient {
  /** Lower case, or null when the report's address isn't one a contact could hold. */
  readonly finalRecipient: string | null;
  readonly originalRecipient: string | null;
  /** class.subject.detail (RFC 3463). */
  readonly status: string;
  readonly bounce: BounceKind | null;
}

/**
 * A parsed delivery report. All of it is an unauthenticated claim: anyone can send a
 * message shaped like a report.
 */
export interface BounceReport {
  /** The returned message's Message-ID: it links the report to a message, and proves nothing. */
  readonly originalMessageId: string | null;
  readonly recipients: readonly BounceRecipient[];
}

const STATUS = /^[245]\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const address = z.string().max(320).nullable();
const bounceInput = z.strictObject({
  mailboxId: z.uuid(),
  report: z.strictObject({
    originalMessageId: z.string().max(998).nullable(),
    recipients: z
      .array(
        z.strictObject({
          finalRecipient: address,
          originalRecipient: address,
          status: z.string().regex(STATUS),
          bounce: z.enum(['hard', 'soft']).nullable(),
        }),
      )
      .max(100)
      .readonly(),
  }),
});

// The Message-ID the SMTP dispatcher gives each outbound message (smtp-outbound.ts).
const OUTBOUND_ID =
  /^<crm-outbound\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@crm\.invalid>$/;
const outboundIdOf = (messageId: string | null) =>
  messageId === null ? undefined : OUTBOUND_ID.exec(messageId)?.[1];

/**
 * What a report says about one address: the groups naming it as the final or the original
 * recipient must agree. A report that says two things about the address says nothing.
 */
export function bounceOf(
  report: BounceReport,
  recipient: string,
): { readonly kind: BounceKind; readonly status: string } | null {
  const named = report.recipients.filter(
    (each) => each.finalRecipient === recipient || each.originalRecipient === recipient,
  );
  const [first] = named;
  const kind = first?.bounce ?? null;
  if (first === undefined || kind === null) return null;
  if (named.some((each) => each.bounce !== kind)) return null;
  return { kind, status: first.status };
}

export type BounceOutcome =
  /** The message is now bounced; a hard bounce also suppressed its address. */
  | { readonly outcome: 'recorded'; readonly messageId: string; readonly bounce: BounceKind }
  /** The message already had this bounce, or a harder one. */
  | { readonly outcome: 'unchanged'; readonly messageId: string }
  /** Not about a message this mailbox sent to that address, or not a bounce. Nothing changes. */
  | { readonly outcome: 'ignored' };

// A reserved attempt may already have reached the provider while its answer is pending.
const SENT_STATUSES = ['sending', 'sent', 'delivered', 'read', 'unknown', 'bounced'] as const;

/**
 * Records what a delivery report says about one of the mailbox's own messages. Only the
 * mailbox sync runs it, inside the transaction that records the report's UID.
 *
 * The report is never trusted on its own. It changes something only when it returns the
 * Message-ID of a message this mailbox was actually given to deliver, and names that
 * message's own stored recipient. The address suppressed is always the stored one, never
 * one the report supplies, so a forged report can't suppress an address of its choosing.
 */
export const recordBounceCommand = defineCommand({
  name: 'mailbox.record_bounce',
  permission: 'mailboxes.manage',
  input: bounceInput,
  // Identifiers only: no addresses reach the audit log.
  audit: (input) => ({
    mailboxId: input.mailboxId,
    messageId: outboundIdOf(input.report.originalMessageId) ?? null,
  }),
  async handle(trx, { mailboxId, report }, command): Promise<BounceOutcome> {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the mailbox sync records bounces.');
    const businessId = requireBusiness(command.context);
    await sql`select id from tenancy.businesses where id=${businessId}::uuid for no key update`.execute(
      trx,
    );
    const outboundId = outboundIdOf(report.originalMessageId);
    if (outboundId === undefined) return { outcome: 'ignored' };
    const message = await reportedMessage(trx, businessId, mailboxId, outboundId);
    const [recipient] = message?.to_addresses ?? [];
    if (message === undefined || recipient === undefined || message.to_addresses.length !== 1)
      return { outcome: 'ignored' };
    const bounce = bounceOf(report, recipient);
    if (bounce === null) return { outcome: 'ignored' };
    // A repeated report, or a soft one after a hard one, changes nothing.
    const already = message.status === 'bounced';
    if (already && (message.error_code === 'hard_bounce' || bounce.kind === 'soft'))
      return { outcome: 'unchanged', messageId: message.id };

    await trx
      .updateTable('messaging.messages')
      .set({
        status: 'bounced',
        failed_at: sql<Date>`coalesce(failed_at, now())`,
        error_code: bounce.kind === 'hard' ? 'hard_bounce' : 'soft_bounce',
        // The status code only: a report's free text can quote addresses and content.
        error_detail: bounce.status,
      })
      .where('id', '=', message.id)
      .execute();
    if (bounce.kind === 'hard') {
      await suppress(trx, businessId, recipient, 'hard_bounce', message.id, bounce.status);
      await sql`insert into messaging.email_verifications
        (business_id,address_normalized,status,depth,reasons,checked_at)
        values (${businessId}::uuid,${recipient},'invalid','mailbox',array['hard_bounce'],now())
        on conflict (business_id,address_normalized) do update set status='invalid',depth='mailbox',
          reasons=array['hard_bounce'],checked_at=now(),current_check_id=null,next_attempt_at=null`.execute(
        trx,
      );
    }
    // An address that soft-bounces again and again is dead in all but name: after
    // SOFT_BOUNCE_LIMIT in a row it is suppressed as invalid.
    if (bounce.kind === 'soft' && (await softBounceStreak(trx, recipient)) >= SOFT_BOUNCE_LIMIT)
      await suppress(trx, businessId, recipient, 'invalid', message.id, 'soft_bounce_limit');
    await command.emit({
      type: 'message.bounced',
      subject: { kind: 'message', id: message.id },
      payload: { mailboxId, bounce: bounce.kind, status: bounce.status },
      records: [message.contact_id],
    });
    return { outcome: 'recorded', messageId: message.id, bounce: bounce.kind };
  },
});

/**
 * How many soft bounces in a row make an address invalid. Mailchimp converts a soft bounce
 * into a hard one after 7 for an address with no activity
 * (mailchimp.com/help/soft-vs-hard-bounces), and Klaviyo suppresses an address that "soft
 * bounces more than 7 consecutive times" (help.klaviyo.com/hc/en-us/articles/115005250408);
 * both read 2026-10-14.
 */
export const SOFT_BOUNCE_LIMIT = 7;

/**
 * How many of the latest emails handed to the mail server for this address, newest first,
 * soft-bounced before one that did not: a message that was sent and never bounced, or that
 * bounced hard, ends the streak. Counted over two years, as Klaviyo counts its own.
 */
async function softBounceStreak(trx: DatabaseTransaction, address: string): Promise<number> {
  const { rows } = await sql<{ soft: boolean }>`
    select (m.status = 'bounced' and m.error_code = 'soft_bounce') as soft
    from messaging.messages m
    join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
    where m.channel = 'email' and m.direction = 'outbound' and m.to_addresses[1] = ${address}
      and cardinality(m.to_addresses) = 1 and d.reserved_at is not null
      and d.reserved_at > now() - interval '2 years'
    order by d.reserved_at desc, m.id desc
    limit ${SOFT_BOUNCE_LIMIT}
  `.execute(trx);
  const broken = rows.findIndex((row) => !row.soft);
  return broken === -1 ? rows.length : broken;
}

/**
 * One suppression per address. A lasting one is kept as it is, whatever its reason; a
 * temporary or expired one gives way to this lasting one.
 */
async function suppress(
  trx: DatabaseTransaction,
  businessId: string,
  address: string,
  reason: 'hard_bounce' | 'complaint' | 'invalid',
  messageId: string,
  detail: string,
): Promise<void> {
  await trx
    .insertInto('messaging.suppressions')
    .values({
      business_id: businessId,
      channel: 'email',
      address_normalized: address,
      reason,
      source_message_id: messageId,
      detail,
    })
    .onConflict((oc) =>
      oc
        .columns(['business_id', 'channel', 'address_normalized'])
        .doUpdateSet({
          reason,
          source_message_id: messageId,
          detail,
          expires_at: null,
          created_at: sql<Date>`now()`,
        })
        .where('messaging.suppressions.expires_at', 'is not', null),
    )
    .execute();
}

/** The outbound email a report returns, sent by this mailbox, locked; undefined when none. */
async function reportedMessage(
  trx: DatabaseTransaction,
  businessId: string,
  mailboxId: string,
  outboundId: string,
) {
  return (
    trx
      .selectFrom('messaging.messages as m')
      .innerJoin('messaging.outbound_dispatch as d', (join) =>
        join.onRef('d.business_id', '=', 'm.business_id').onRef('d.id', '=', 'm.id'),
      )
      .innerJoin('messaging.conversations as v', (join) =>
        join.onRef('v.business_id', '=', 'm.business_id').onRef('v.id', '=', 'm.conversation_id'),
      )
      .select(['m.id', 'm.status', 'm.error_code', 'm.to_addresses', 'v.contact_id'])
      .where('m.business_id', '=', businessId)
      .where('m.id', '=', outboundId)
      .where('m.channel', '=', 'email')
      .where('m.direction', '=', 'outbound')
      .where('m.channel_account_id', '=', mailboxId)
      .where('m.status', 'in', SENT_STATUSES)
      // Handed to the mail server at least once; a queued or refused message can't bounce.
      .where('d.reserved_at', 'is not', null)
      .forUpdate('m')
      .executeTakeFirst()
  );
}

const complaintInput = z.strictObject({
  mailboxId: z.uuid(),
  report: z.strictObject({
    feedbackType: z.string().max(100),
    originalMessageId: z.string().max(998).nullable(),
  }),
});

export type ComplaintOutcome =
  { readonly outcome: 'recorded'; readonly messageId: string } | { readonly outcome: 'ignored' };

/**
 * Records a spam complaint a mailbox provider's feedback loop reported (RFC 5965,
 * Feedback-Type abuse): the stored recipient of the returned message is suppressed for
 * good, so nothing is sent to them again. Google and Yahoo ask senders to keep complaints
 * under 0.3% (support.google.com/a/answer/81126, senders.yahooinc.com/best-practices), and
 * Yahoo asks for a complaint feedback loop on every DKIM domain. As with a bounce, the
 * report is a claim: it acts only on a message this mailbox sent, and on that message's
 * own recipient.
 */
export const recordComplaintCommand = defineCommand({
  name: 'mailbox.record_complaint',
  permission: 'mailboxes.manage',
  input: complaintInput,
  // Identifiers only: no addresses reach the audit log.
  audit: (input) => ({
    mailboxId: input.mailboxId,
    messageId: outboundIdOf(input.report.originalMessageId) ?? null,
  }),
  async handle(trx, { mailboxId, report }, command): Promise<ComplaintOutcome> {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the mailbox sync records complaints.');
    const businessId = requireBusiness(command.context);
    const outboundId = outboundIdOf(report.originalMessageId);
    if (report.feedbackType !== 'abuse' || outboundId === undefined) return { outcome: 'ignored' };
    const message = await reportedMessage(trx, businessId, mailboxId, outboundId);
    const [recipient] = message?.to_addresses ?? [];
    if (message === undefined || recipient === undefined || message.to_addresses.length !== 1)
      return { outcome: 'ignored' };
    await suppress(trx, businessId, recipient, 'complaint', message.id, 'abuse');
    await command.emit({
      type: 'message.complained',
      subject: { kind: 'message', id: message.id },
      payload: { mailboxId },
      records: [message.contact_id],
    });
    return { outcome: 'recorded', messageId: message.id };
  },
});

export interface MailboxBounceRate {
  /** Messages the mailbox was given to deliver in the window, whatever became of them. */
  readonly attempted: number;
  /** Of those, the ones that bounced, each counted once. */
  readonly bounced: number;
  /** Of the bounced, the ones whose address was bad. */
  readonly hardBounced: number;
  /** bounced / attempted; null when nothing was attempted. */
  readonly rate: number | null;
}

/** The share of attempted messages that bounced; null when there were none to bounce. */
export function bounceRate(attempted: number, bounced: number): number | null {
  return attempted > 0 ? bounced / attempted : null;
}

const windowDays = z.number().int().min(1).max(90);

/**
 * A mailbox's bounce rate over the last days (seven: EMAIL.md's "this week"), counted over
 * the messages handed to its mail server in that window. A message counts in the window it
 * was sent in, however late its bounce arrives. Call inside the reader's tenant transaction.
 */
export async function readMailboxBounceRate(
  trx: DatabaseTransaction,
  mailboxId: string,
  days = 7,
): Promise<MailboxBounceRate> {
  const {
    rows: [row],
  } = await sql<{ attempted: number; bounced: number; hard_bounced: number }>`
    select count(*)::integer as attempted,
      count(*) filter (where m.status = 'bounced')::integer as bounced,
      count(*) filter (where m.status = 'bounced' and m.error_code = 'hard_bounce')::integer
        as hard_bounced
    from messaging.outbound_dispatch d
    join messaging.messages m on m.business_id = d.business_id and m.id = d.id
    where m.channel_account_id = ${z.uuid().parse(mailboxId)}::uuid
      and m.channel = 'email' and m.direction = 'outbound'
      and d.reserved_at > now() - make_interval(days => ${windowDays.parse(days)}::integer)
  `.execute(trx);
  // An aggregate without groups always gives one row.
  const counts = row ?? { attempted: 0, bounced: 0, hard_bounced: 0 };
  return {
    attempted: counts.attempted,
    bounced: counts.bounced,
    hardBounced: counts.hard_bounced,
    rate: bounceRate(counts.attempted, counts.bounced),
  };
}
