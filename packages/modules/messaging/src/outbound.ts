import { createHash } from 'node:crypto';
import { defineTask, requireBusiness, type Task } from '@repo/commands';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, type TenantContext } from '@repo/kernel';
import type { ReplyHeaders } from '@repo/mail';
import { sql } from 'kysely';
import * as z from 'zod';
import { readReplyThread } from './email-thread.js';
import {
  evaluateOutboundPolicy,
  outboundLanePriority,
  type OutboundLane,
  type OutboundPolicyFacts,
} from './outbound-policy.js';
import { addressConsentStatus } from './consent-state.js';

/** The most files one message carries. */
export const OUTBOUND_ATTACHMENT_LIMIT = 5;

/** The most addresses in Cc, and in Bcc, of one message. */
export const OUTBOUND_COPY_LIMIT = 10;

// RFC 5321 4.5.3.1.3: a path is at most 256 octets with its angle brackets.
const copyAddress = z.email().max(254);

const outboundInput = z
  .strictObject({
    identityId: z.uuid(),
    accountId: z.uuid(),
    channel: z.enum(['email', 'sms']),
    purpose: z.enum(['marketing', 'transactional']),
    lane: z.enum(['reply', 'transactional', 'automation', 'campaign']),
    idempotencyKey: z.string().min(1).max(200),
    subject: z
      .string()
      .max(998)
      .regex(/^[^\r\n]*$/)
      .optional(),
    text: z.string().min(1).max(1_000_000),
    html: z.string().max(1_000_000).optional(),
    /**
     * Files of the business sent with an email (files.files ids), such as an invoice's PDF.
     * Left out by every sender that attaches nothing, so their requests hash as before.
     */
    attachments: z.array(z.uuid()).min(1).max(OUTBOUND_ATTACHMENT_LIMIT).optional(),
    /**
     * What a workflow's email says about itself: the name it is from, where answers go, and
     * who else gets it. Each is left out by every sender that sets none, so their requests
     * hash as before. The From address is always the mailbox's own.
     */
    fromName: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\r\n]*$/)
      .optional(),
    replyTo: copyAddress.optional(),
    cc: z.array(copyAddress).min(1).max(OUTBOUND_COPY_LIMIT).optional(),
    bcc: z.array(copyAddress).min(1).max(OUTBOUND_COPY_LIMIT).optional(),
    /**
     * The appointment a transactional message is about (calendar.appointments id), such as
     * a reminder's. While it is the contact's own and is ahead, quiet hours do not hold the
     * message. Left out by every other sender, so their requests hash as before.
     */
    appointmentId: z.uuid().optional(),
  })
  .refine((input) => input.appointmentId === undefined || input.purpose === 'transactional', {
    message: 'Only a transactional message is about an appointment.',
  })
  .refine((input) => input.lane !== 'campaign' || input.purpose === 'marketing', {
    message: 'Campaigns require marketing consent.',
  })
  .refine((input) => input.attachments === undefined || input.channel === 'email', {
    message: 'Only an email carries attachments.',
  })
  .refine(
    (input) =>
      input.channel === 'email' ||
      (input.fromName === undefined &&
        input.replyTo === undefined &&
        input.cc === undefined &&
        input.bcc === undefined),
    { message: 'Only an email has a From name, a Reply-To, Cc or Bcc.' },
  );
export type OutboundInput = z.input<typeof outboundInput>;
const dispatchData = z.strictObject({ messageId: z.uuid() });

export interface OutboundDelivery {
  readonly messageId: string;
  readonly accountId: string;
  readonly channel: 'email' | 'sms';
  readonly purpose: 'marketing' | 'transactional';
  readonly to: string;
  readonly subject: string | null;
  readonly text: string;
  readonly html: string | null;
  /**
   * The email thread it was written in, as stored when it was queued; empty for a message
   * that answers nothing, and for every text message.
   */
  readonly reply: ReplyHeaders;
  /** The files it carries, as files.files ids, in the order they were attached. */
  readonly attachments: readonly string[];
  /** A workflow email's own From name and Reply-To; left out or null, the mailbox's. */
  readonly fromName?: string | null;
  readonly replyTo?: string | null;
  /** Who else gets an email, as stored when it was queued. */
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  /** The lane it was queued on. A sender that is handed none treats it as no workflow's. */
  readonly lane?: 'reply' | 'transactional' | 'automation' | 'campaign';
}
/** Worker-only provider port. Exceptions are ambiguous, never automatic resend signals. */
export interface OutboundSender {
  deliver(
    message: OutboundDelivery,
    context: TenantContext,
  ): Promise<
    | { readonly outcome: 'accepted'; readonly providerId: string }
    | { readonly outcome: 'rejected' }
    | { readonly outcome: 'unknown' }
  >;
}

/** A Cc or Bcc an email is sent without, and why: the suppression's reason. */
export interface OutboundLeftOutCopy {
  readonly copy: 'cc' | 'bcc';
  /** As the message stores it. */
  readonly address: string;
  readonly reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'invalid' | 'manual';
}

/** Runs within the serialized tenant transaction, before the irreversible reservation. */
export type OutboundAdmission = (
  trx: DatabaseTransaction,
  context: TenantContext,
  message: OutboundDelivery & {
    readonly lane: 'reply' | 'transactional' | 'automation' | 'campaign';
  },
) => Promise<
  | {
      readonly action: 'allow';
      /** Copies to send without; the email goes to everyone else. */
      readonly leftOut?: readonly OutboundLeftOutCopy[];
    }
  | { readonly action: 'defer'; readonly reason: string; readonly retryAt: Date }
  | { readonly action: 'refuse'; readonly reason: string }
>;

/** A channel's provider sender and admission behind the shared dispatch task. */
export interface OutboundChannel {
  readonly sender: OutboundSender;
  readonly admission: OutboundAdmission;
}

export async function lockBusiness(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<string> {
  const businessId = requireBusiness(context);
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('id')
    .where('id', '=', businessId)
    .where('agency_id', '=', context.agencyId)
    .forUpdate()
    .executeTakeFirst();
  if (business === undefined) throw new NotFoundError('business', businessId);
  return business.id;
}

/**
 * The time zone quiet hours are kept by, as joins on the contact c and the business b: the
 * contact's own when it is a region zone (America/New_York), otherwise the business's. An
 * abbreviation such as EST is a fixed offset with no summer time, so it is never used: at
 * 21:30 EDT it would say 20:30 and let a text through.
 */
export const quietHoursZoneJoins = sql`
  left join pg_catalog.pg_timezone_names qz_contact
    on qz_contact.name=c.timezone and (qz_contact.name like '%/%' or qz_contact.name='UTC')
  left join pg_catalog.pg_timezone_names qz_business on qz_business.name=b.timezone`;

/** The zone the joins above give, as SQL: the contact's, else the business's. */
export const quietHoursZone = sql`coalesce(qz_contact.name, qz_business.name)`;

async function policyFacts(
  trx: DatabaseTransaction,
  identityId: string | null,
  accountId: string,
  channel: 'email' | 'sms',
  purpose: 'marketing' | 'transactional',
  lane: OutboundLane | undefined,
  appointmentId: string | null = null,
): Promise<OutboundPolicyFacts> {
  const {
    rows: [row],
  } = await sql<Omit<OutboundPolicyFacts, 'lane'>>`
    select (c.deleted_at is null) as "contactActive",
      (a.status='active' and b.status='active') as "senderActive",
      c.do_not_contact as "doNotContact",
      ${addressConsentStatus(sql`c.business_id`, sql`c.id`, sql`i.value_normalized`, channel, purpose)} as consent,
      (select reason from messaging.suppressions
        where business_id=c.business_id and channel=${channel} and address_normalized=i.value_normalized
        and (expires_at is null or expires_at>now()) limit 1) as suppression,
      case when not coalesce(s.quiet_hours_enabled,true) then 'open'
        when tz.name is null then 'unknown'
        when coalesce(s.quiet_hours_start,'21:00'::time)=coalesce(s.quiet_hours_end,'08:00'::time) then 'quiet'
        when coalesce(s.quiet_hours_start,'21:00'::time)<coalesce(s.quiet_hours_end,'08:00'::time) then
          case when (now() at time zone tz.name)::time>=coalesce(s.quiet_hours_start,'21:00'::time)
            and (now() at time zone tz.name)::time<coalesce(s.quiet_hours_end,'08:00'::time) then 'quiet' else 'open' end
        else case when (now() at time zone tz.name)::time>=coalesce(s.quiet_hours_start,'21:00'::time)
            or (now() at time zone tz.name)::time<coalesce(s.quiet_hours_end,'08:00'::time) then 'quiet' else 'open' end
        end as timing,
      -- The daily cap counts what it protects contacts from: workflow and campaign messages.
      (select count(*)::integer from messaging.outbound_dispatch d
        join messaging.messages m on m.business_id=d.business_id and m.id=d.id
        join messaging.conversations v on v.business_id=m.business_id and v.id=m.conversation_id
        where v.business_id=c.business_id and v.contact_id=c.id and d.lane in ('automation','campaign')
          and d.reserved_at>now()-interval '24 hours') as "recentMessages",
      coalesce(s.contact_daily_limit,10) as "frequencyLimit",
      (${channel} = any(c.dnd_channels)) as "channelDoNotDisturb",
      -- A transactional message about this contact's own appointment, booked or confirmed
      -- and not ended, read again at every decision: quiet hours do not hold it.
      (${purpose}='transactional' and exists (select 1 from calendar.appointments ap
        where ap.business_id=c.business_id and ap.id=${appointmentId}::uuid and ap.contact_id=c.id
          and ap.status in ('booked','confirmed') and ap.ends_at>now())) as "ownAppointment",
      -- The person wrote to the business from this very address (and it was not refused as
      -- unauthenticated, which is never stored): an answer to them needs no other basis.
      (${channel}='email' and exists (select 1 from messaging.messages im
        join messaging.conversations iv on iv.business_id=im.business_id and iv.id=im.conversation_id
        where iv.business_id=c.business_id and iv.contact_id=c.id and im.direction='inbound'
          and im.channel='email' and im.from_address=i.value_normalized)) as "inboundBasis"
    from crm.contact_identities i
    join crm.contacts c on c.business_id=i.business_id and c.id=i.contact_id
    join tenancy.businesses b on b.id=c.business_id
    join messaging.channel_accounts a on a.business_id=c.business_id and a.id=${accountId}::uuid and a.channel=${channel}
    left join messaging.settings s on s.business_id=c.business_id
    ${quietHoursZoneJoins}
    left join lateral (select ${quietHoursZone} as name) tz on true
    where i.id=${identityId}::uuid and i.kind=${channel === 'email' ? 'email' : 'phone'}
  `.execute(trx);
  return {
    ...(row ?? {
      contactActive: false,
      senderActive: false,
      doNotContact: false,
      consent: 'unknown',
      suppression: null,
      timing: 'unknown',
      recentMessages: 0,
      frequencyLimit: 10,
    }),
    ...(lane === undefined ? {} : { lane }),
  };
}

/**
 * What the pipeline would decide for a message to this identity from this account, now,
 * without queueing one: for a sender that has work to do before it queues (a PDF to draw
 * and keep) and should not do it for a message that will be refused. Queueing decides
 * again, and that decision is the one that counts.
 */
export async function readOutboundPolicy(
  trx: DatabaseTransaction,
  message: {
    readonly identityId: string;
    readonly accountId: string;
    readonly channel: 'email' | 'sms';
    readonly purpose: 'marketing' | 'transactional';
    /** The lane it would be queued on; left out, every rule applies as to automated mail. */
    readonly lane?: OutboundLane;
  },
): Promise<ReturnType<typeof evaluateOutboundPolicy>> {
  return evaluateOutboundPolicy(
    await policyFacts(
      trx,
      message.identityId,
      message.accountId,
      message.channel,
      message.purpose,
      message.lane,
    ),
  );
}

async function applyPolicy(
  trx: DatabaseTransaction,
  messageId: string,
  facts: OutboundPolicyFacts,
): Promise<boolean> {
  const decision = evaluateOutboundPolicy(facts);
  if (decision.action === 'allow') return true;
  if (decision.action === 'refuse') {
    await trx
      .updateTable('messaging.messages')
      .set({
        status: 'failed',
        failed_at: sql`now()`,
        error_code: decision.reason,
        // What kind of refusal it was, for the wording: a suppression's category, or that
        // do not disturb was on for this channel and not for every one.
        error_detail:
          decision.reason === 'suppressed'
            ? decision.suppressionReason
            : 'scope' in decision
              ? decision.scope
              : null,
      })
      .where('id', '=', messageId)
      .execute();
  } else {
    await trx
      .updateTable('messaging.messages')
      .set({
        status: 'queued',
        scheduled_for: sql`now()+interval '5 minutes'`,
        error_code: decision.reason,
        error_detail: null,
      })
      .where('id', '=', messageId)
      .execute();
    await sql`select private.enqueue_outbound(${messageId}::uuid)`.execute(trx);
  }
  return false;
}

/** Call inside an authorized command's tenant transaction; UUIDs never accept raw addresses. */
export async function queueOutboundMessage(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: OutboundInput,
): Promise<string> {
  const parsed = outboundInput.parse(input);
  const businessId = await lockBusiness(trx, context);
  const requestHash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
  const existing = await trx
    .selectFrom('messaging.messages as m')
    .innerJoin('messaging.outbound_dispatch as d', (join) =>
      join.onRef('d.business_id', '=', 'm.business_id').onRef('d.id', '=', 'm.id'),
    )
    .select(['m.id', 'd.request_hash'])
    .where('m.idempotency_key', '=', parsed.idempotencyKey)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (existing.request_hash !== requestHash)
      throw new ConflictError('This idempotency key already identifies a different message.');
    return existing.id;
  }
  const identity = await trx
    .selectFrom('crm.contact_identities')
    .select(['id', 'contact_id', 'value_normalized'])
    .where('id', '=', parsed.identityId)
    .where('kind', '=', parsed.channel === 'email' ? 'email' : 'phone')
    .executeTakeFirst();
  if (identity === undefined) throw new NotFoundError('recipient', parsed.identityId);
  const account = await trx
    .selectFrom('messaging.channel_accounts')
    .select('id')
    .where('id', '=', parsed.accountId)
    .where('channel', '=', parsed.channel)
    .executeTakeFirst();
  if (account === undefined) throw new NotFoundError('channel account', parsed.accountId);
  const conversation = await trx
    .insertInto('messaging.conversations')
    .values({ business_id: businessId, contact_id: identity.contact_id })
    .onConflict((oc) =>
      oc.columns(['business_id', 'contact_id']).doUpdateSet({ contact_id: identity.contact_id }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  // A person's email answer joins the thread of the mail it answers. Decided here, once:
  // the same request sent again finds this message, whatever has arrived since.
  const thread =
    parsed.channel === 'email' && parsed.lane === 'reply'
      ? await readReplyThread(trx, conversation.id, identity.value_normalized)
      : undefined;
  const message = await trx
    .insertInto('messaging.messages')
    .values({
      business_id: businessId,
      conversation_id: conversation.id,
      channel: parsed.channel,
      channel_account_id: account.id,
      direction: 'outbound',
      status: 'queued',
      subject: parsed.subject ?? null,
      body_text: parsed.text,
      body_html: parsed.html ?? null,
      to_addresses: [identity.value_normalized],
      ...(parsed.cc === undefined ? {} : { cc_addresses: parsed.cc }),
      ...(parsed.bcc === undefined ? {} : { bcc_addresses: parsed.bcc }),
      ...(thread === undefined
        ? {}
        : {
            in_reply_to: thread.headers.inReplyTo,
            email_references: [...thread.headers.references],
            parent_message_id: thread.parentId,
          }),
      idempotency_key: parsed.idempotencyKey,
      priority: outboundLanePriority(parsed.lane),
      author_kind: context.actorKind,
      author_id: context.actorId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('messaging.outbound_dispatch')
    .values({
      business_id: businessId,
      id: message.id,
      identity_id: identity.id,
      purpose: parsed.purpose,
      lane: parsed.lane,
      request_hash: requestHash,
      ...(parsed.fromName === undefined ? {} : { from_name: parsed.fromName }),
      ...(parsed.replyTo === undefined ? {} : { reply_to: parsed.replyTo }),
      ...(parsed.appointmentId === undefined ? {} : { appointment_id: parsed.appointmentId }),
    })
    .execute();
  // What it carries is written with it. The foreign key keeps each file to this business.
  if (parsed.attachments !== undefined)
    await trx
      .insertInto('messaging.message_attachments')
      .values(
        parsed.attachments.map((fileId) => ({
          business_id: businessId,
          message_id: message.id,
          file_id: fileId,
        })),
      )
      .execute();
  if (
    await applyPolicy(
      trx,
      message.id,
      await policyFacts(
        trx,
        identity.id,
        account.id,
        parsed.channel,
        parsed.purpose,
        parsed.lane,
        parsed.appointmentId ?? null,
      ),
    )
  )
    await sql`select private.enqueue_outbound(${message.id}::uuid)`.execute(trx);
  return message.id;
}

export function createDispatchOutboundTask(
  sender: OutboundSender,
  admission?: OutboundAdmission,
): Task<typeof dispatchData> {
  return defineTask({
    name: 'messaging.dispatch',
    data: dispatchData,
    async run({ messageId }, { invocation, services }) {
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        await lockBusiness(trx, invocation.context);
        const row = await trx
          .selectFrom('messaging.messages as m')
          .innerJoin('messaging.outbound_dispatch as d', (join) =>
            join.onRef('d.business_id', '=', 'm.business_id').onRef('d.id', '=', 'm.id'),
          )
          .select([
            'm.id',
            'm.channel_account_id',
            'm.channel',
            'm.to_addresses',
            'm.cc_addresses',
            'm.bcc_addresses',
            'd.from_name',
            'd.reply_to',
            'm.subject',
            'm.body_text',
            'm.body_html',
            'm.in_reply_to',
            'm.email_references',
            'm.status',
            'm.scheduled_for',
            sql<boolean>`coalesce(m.scheduled_for>now(),false)`.as('not_due'),
            'd.identity_id',
            'd.purpose',
            'd.lane',
            'd.appointment_id',
            'd.reserved_at',
            'd.finished_at',
          ])
          .where('m.id', '=', messageId)
          .forUpdate('m')
          .executeTakeFirst();
        if (row?.finished_at !== null || row.status === 'failed' || row.status === 'sent')
          return null;
        if (row.reserved_at !== null) {
          await trx
            .updateTable('messaging.messages')
            .set({ status: 'unknown', error_code: 'delivery_unknown', error_detail: null })
            .where('id', '=', messageId)
            .where('status', 'in', ['queued', 'sending'])
            .execute();
          return null;
        }
        if (row.not_due) {
          await sql`select private.enqueue_outbound(${messageId}::uuid)`.execute(trx);
          return null;
        }
        const channel = z.enum(['email', 'sms']).parse(row.channel);
        const purpose = z.enum(['marketing', 'transactional']).parse(row.purpose);
        if (row.channel_account_id === null) throw new Error('Outbound message has no sender.');
        const identity =
          row.identity_id === null
            ? undefined
            : await trx
                .selectFrom('crm.contact_identities')
                .select('value_normalized')
                .where('id', '=', row.identity_id)
                .executeTakeFirst();
        if (identity === undefined || identity.value_normalized !== row.to_addresses[0]) {
          await trx
            .updateTable('messaging.messages')
            .set({
              status: 'failed',
              failed_at: sql`now()`,
              error_code: 'recipient_changed',
              error_detail: null,
            })
            .where('id', '=', messageId)
            .execute();
          return null;
        }
        const lane = z.enum(['reply', 'transactional', 'automation', 'campaign']).parse(row.lane);
        if (
          !(await applyPolicy(
            trx,
            messageId,
            await policyFacts(
              trx,
              row.identity_id,
              row.channel_account_id,
              channel,
              purpose,
              lane,
              row.appointment_id,
            ),
          ))
        )
          return null;
        const to = row.to_addresses.at(0);
        if (to === undefined) throw new Error('Outbound message has no recipient.');
        // Files sent with it; an image placed inside the body (content_id) is not one.
        const attached = await trx
          .selectFrom('messaging.message_attachments')
          .select('file_id')
          .where('message_id', '=', messageId)
          .where('content_id', 'is', null)
          .orderBy('id')
          .execute();
        let delivery: OutboundDelivery = {
          messageId,
          accountId: row.channel_account_id,
          channel,
          purpose,
          to,
          subject: row.subject,
          text: row.body_text,
          html: row.body_html,
          reply: { inReplyTo: row.in_reply_to, references: row.email_references },
          attachments: attached.map((file) => file.file_id),
          fromName: row.from_name,
          replyTo: row.reply_to,
          cc: row.cc_addresses,
          bcc: row.bcc_addresses,
          lane,
        };
        let leftOut: readonly OutboundLeftOutCopy[] = [];
        if (admission !== undefined) {
          const decision = await admission(trx, invocation.context, { ...delivery, lane });
          if (decision.action !== 'allow') {
            await trx
              .updateTable('messaging.messages')
              .set(
                decision.action === 'defer'
                  ? {
                      status: 'queued',
                      scheduled_for: decision.retryAt,
                      error_code: decision.reason,
                      error_detail: null,
                    }
                  : {
                      status: 'failed',
                      failed_at: sql`now()`,
                      error_code: decision.reason,
                      error_detail: null,
                    },
              )
              .where('id', '=', messageId)
              .execute();
            if (decision.action === 'defer')
              await sql`select private.enqueue_outbound(${messageId}::uuid)`.execute(trx);
            return null;
          }
          leftOut = decision.leftOut ?? [];
        }
        // The email goes to the copies left in; the message keeps who it went to and the
        // dispatch who it did not.
        const kept = (copy: 'cc' | 'bcc', addresses: readonly string[]) =>
          addresses.filter(
            (address) => !leftOut.some((left) => left.copy === copy && left.address === address),
          );
        if (leftOut.length > 0)
          delivery = {
            ...delivery,
            cc: kept('cc', row.cc_addresses),
            bcc: kept('bcc', row.bcc_addresses),
          };
        await trx
          .updateTable('messaging.outbound_dispatch')
          .set({
            reserved_at: sql`now()`,
            ...(leftOut.length === 0 ? {} : { left_out_copies: JSON.stringify(leftOut) }),
          })
          .where('id', '=', messageId)
          .execute();
        await trx
          .updateTable('messaging.messages')
          .set({
            status: 'sending',
            scheduled_for: null,
            error_code: null,
            error_detail: null,
            ...(leftOut.length === 0
              ? {}
              : {
                  cc_addresses: kept('cc', row.cc_addresses),
                  bcc_addresses: kept('bcc', row.bcc_addresses),
                }),
          })
          .where('id', '=', messageId)
          .execute();
        return delivery;
      });
      if (prepared === null) return;
      let result: Awaited<ReturnType<OutboundSender['deliver']>>;
      try {
        result = await sender.deliver(prepared, invocation.context);
      } catch {
        result = { outcome: 'unknown' };
      }
      await withTenant(services.db, invocation.context, async (trx) => {
        // Inbox writers take business, conversation, then message. Keep the same
        // business-first order here, including when a message trigger takes a conversation.
        await lockBusiness(trx, invocation.context);
        await trx
          .updateTable('messaging.messages')
          .set(
            result.outcome === 'accepted'
              ? {
                  status: 'sent',
                  sent_at: sql`now()`,
                  provider_message_id: result.providerId,
                  error_code: null,
                  error_detail: null,
                }
              : result.outcome === 'rejected'
                ? {
                    status: 'failed',
                    failed_at: sql`now()`,
                    error_code: 'delivery_rejected',
                    error_detail: null,
                  }
                : { status: 'unknown', error_code: 'delivery_unknown', error_detail: null },
          )
          .where('id', '=', messageId)
          // A concurrent retry may mark the reservation unknown while this worker
          // still awaits its answer. Preserve actual delivery reports in either case.
          .where('status', 'in', ['sending', 'unknown'])
          .execute();
        await trx
          .updateTable('messaging.outbound_dispatch')
          .set({ finished_at: sql`now()` })
          .where('id', '=', messageId)
          .execute();
      });
    },
  });
}
