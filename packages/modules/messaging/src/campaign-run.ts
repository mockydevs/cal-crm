// The campaign task: what turns a started campaign into emails, a few at a time.
//
// A run is a series of short steps, each its own transaction with the campaign's row held:
//   1. a scheduled campaign whose time has come starts;
//   2. the audience is fixed and written as recipient rows, a batch of contacts at a time;
//   3. recipients whose email has ended are written off as sent, skipped or failed;
//   4. as many pending recipients as every limit allows are released to the outbound
//      pipeline on the campaign lane, each decided by the pipeline's own policy;
//   5. a campaign with nobody left is finished.
// A step that fails leaves nothing behind, and the next run takes the same recipients: a
// recipient is released with its message in one transaction, under an idempotency key of
// the campaign and the contact, so nobody is sent a campaign twice. The task sends nothing
// itself, and never puts more in the queue than the mailbox sends in a minute, so a reply
// or a workflow email queued meanwhile leaves first.
import { randomUUID } from 'node:crypto';
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type AnyTask,
  type Invocation,
  type Services,
  type TaskReference,
} from '@repo/commands';
import {
  EMAIL_CAMPAIGN_LIMITS,
  EMAIL_UNSUBSCRIBE_MERGE_FIELD,
  emailCampaignStatusReasons,
  type EmailCampaignSkipReason,
  type EmailCampaignStatusReason,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { fixContactAudience } from '@repo/module-crm';
import { actorKinds, NotFoundError, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { AUDIENCE_BATCH, writeAudienceBatch } from './campaign-audience.js';
import {
  readBusinessCampaignLimit,
  readCampaignMailbox,
  type CampaignMailbox,
} from './campaign-checks.js';
import {
  bounceRateExceeded,
  CAMPAIGN_BOUNCE_PAUSE,
  htmlMergeValues,
  htmlWithUnsubscribe,
  planRelease,
  recipientOutcome,
  skipReasonOfPolicy,
  textWithUnsubscribe,
  UNSUBSCRIBE_PLACEHOLDER,
  type ReleasePlan,
} from './campaign-rules.js';
import {
  audienceOf,
  batchesOf,
  businessTimeZone,
  databaseNow,
  findCampaign,
  only,
  type CampaignOptions,
  type CampaignRow,
} from './campaign-store.js';
import { readPostalAddressLine } from './email-compose.js';
import { queueOutboundMessage, readOutboundPolicy } from './outbound.js';
import { renderWithTriggerLinks } from './trigger-link-tokens.js';

/** The job that runs a campaign. One at a time per campaign (0088's queue and key). */
export const runCampaignReference = {
  name: 'campaigns.run',
  data: z.strictObject({ campaignId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/** Recipients released or written off in one transaction. */
const CHUNK = 25;
/** Steps one run takes before it leaves the rest to the next. */
const STEP_LIMIT = 400;
/** How often a campaign with emails on their way is looked at. */
const TICK_MS = 60_000;
/** How often one waiting on a daily limit is. */
const LIMIT_RETRY_MS = 5 * 60_000;

type Step =
  | { readonly kind: 'done' }
  | { readonly kind: 'again' }
  | {
      readonly kind: 'advance';
      readonly to: 'sending' | 'paused' | 'sent' | 'failed';
      readonly reason?: EmailCampaignStatusReason;
    };

const DONE: Step = { kind: 'done' };
const AGAIN: Step = { kind: 'again' };

const advanceInput = z.strictObject({
  campaignId: z.uuid(),
  to: z.enum(['sending', 'paused', 'sent', 'failed']),
  reason: z.enum(emailCampaignStatusReasons).optional(),
});

/**
 * A change of status the task makes, as a command so it is an event and an audit entry:
 * a scheduled campaign starts, a campaign pauses itself, fails or is finished. Each is
 * made only from the status it follows, so a second run changes nothing.
 */
const advance = defineCommand({
  name: 'campaign.advance',
  permission: 'campaigns.send',
  input: advanceInput,
  async handle(trx, input, command): Promise<boolean> {
    const businessId = requireBusiness(command.context);
    const row = await findCampaign(trx, businessId, input.campaignId, true);
    const from = input.to === 'sending' ? ['scheduled'] : ['sending'];
    if (input.to === 'failed') from.push('scheduled');
    if (row === undefined || !from.includes(row.status)) return false;
    const subject = { kind: 'email_campaign', id: row.id };
    const reason = input.reason ?? null;
    if (input.to === 'sending') {
      await trx
        .updateTable('messaging.email_campaigns')
        .set({ status: 'sending', started_at: sql`now()`, next_run_at: sql`now()` })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.started',
        subject,
        payload: { name: row.name, batches: row.batch_size !== null },
      });
      return true;
    }
    if (input.to === 'paused') {
      await trx
        .updateTable('messaging.email_campaigns')
        .set({
          status: 'paused',
          status_reason: reason,
          wait_reason: null,
          wait_until: null,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.paused',
        subject,
        payload: { name: row.name, by: 'system', reason },
      });
      return true;
    }
    if (input.to === 'failed') {
      await trx
        .updateTable('messaging.email_campaign_recipients')
        .set({ status: 'skipped', reason: 'cancelled' })
        .where('campaign_id', '=', row.id)
        .where('status', '=', 'pending')
        .execute();
      await trx
        .updateTable('messaging.email_campaigns')
        .set({
          status: 'failed',
          status_reason: reason,
          started_at: sql`coalesce(started_at, now())`,
          finished_at: sql`now()`,
          next_run_at: sql`now()`,
          wait_reason: null,
          wait_until: null,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.failed',
        subject,
        payload: { name: row.name, reason },
      });
      return true;
    }
    const counts = await recount(trx, row.id);
    if (counts.pending > 0 || counts.queued > 0) return false;
    await trx
      .updateTable('messaging.email_campaigns')
      .set({
        status: 'sent',
        finished_at: sql`now()`,
        next_run_at: null,
        wait_reason: null,
        wait_until: null,
      })
      .where('id', '=', row.id)
      .execute();
    // What a workflow or a report hears: numbers and the name, never the email's words.
    await command.emit({
      type: 'campaign.sent',
      subject,
      payload: {
        name: row.name,
        audience: counts.audience,
        sent: counts.sent,
        skipped: counts.skipped,
        failed: counts.failed,
      },
    });
    return true;
  },
});

interface Counts {
  readonly audience: number;
  readonly pending: number;
  readonly queued: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
}

/** Counts the recipients by what became of them, and keeps the counts on the campaign. */
async function recount(trx: DatabaseTransaction, campaignId: string): Promise<Counts> {
  const { rows } = await sql<Counts>`
    select count(*)::integer as audience,
      (count(*) filter (where status = 'pending'))::integer as pending,
      (count(*) filter (where status = 'queued'))::integer as queued,
      (count(*) filter (where status = 'sent'))::integer as sent,
      (count(*) filter (where status = 'skipped'))::integer as skipped,
      (count(*) filter (where status = 'failed'))::integer as failed
    from messaging.email_campaign_recipients where campaign_id = ${campaignId}
  `.execute(trx);
  const counts = only(rows);
  await trx
    .updateTable('messaging.email_campaigns')
    .set({
      audience_count: counts.audience,
      pending_count: counts.pending,
      queued_count: counts.queued,
      sent_count: counts.sent,
      skipped_count: counts.skipped,
      failed_count: counts.failed,
    })
    .where('id', '=', campaignId)
    .execute();
  return counts;
}

/**
 * Writes off the released recipients whose message has ended: sent, refused by the policy
 * as it left (skipped, with the reason), or refused by the mail server (failed). Gives how
 * many it read, which is the limit when there may be more.
 */
async function settle(trx: DatabaseTransaction, campaignId: string): Promise<number> {
  const ended = await trx
    .selectFrom('messaging.email_campaign_recipients as recipient')
    .leftJoin('messaging.messages as message', (join) =>
      join
        .onRef('message.business_id', '=', 'recipient.business_id')
        .onRef('message.id', '=', 'recipient.message_id'),
    )
    .select([
      'recipient.contact_id',
      'message.status',
      'message.error_code',
      'message.error_detail',
    ])
    .where('recipient.campaign_id', '=', campaignId)
    .where('recipient.status', '=', 'queued')
    .where((eb) =>
      eb.or([eb('message.id', 'is', null), eb('message.status', 'not in', ['queued', 'sending'])]),
    )
    .limit(CHUNK * 40)
    .execute();
  const outcomes = new Map<string, string[]>();
  for (const row of ended) {
    // A message that is gone (its conversation was purged) cannot have been delivered.
    const outcome = recipientOutcome({
      status: row.status ?? 'unknown',
      errorCode: row.error_code,
      errorDetail: row.error_detail,
    }) ?? { status: 'failed' as const, reason: null };
    const key = `${outcome.status}:${outcome.reason ?? ''}`;
    outcomes.set(key, [...(outcomes.get(key) ?? []), row.contact_id]);
  }
  for (const [key, contacts] of outcomes) {
    const [status = 'failed', reason = ''] = key.split(':');
    await trx
      .updateTable('messaging.email_campaign_recipients')
      .set({ status, reason: reason === '' ? null : reason })
      .where('campaign_id', '=', campaignId)
      .where('contact_id', 'in', contacts)
      .execute();
  }
  return ended.length;
}

interface Usage {
  readonly recent_all: number;
  readonly recent_automated: number;
  readonly earliest_ms: number | null;
  readonly in_flight: number;
  readonly business_released: number;
  readonly agency_released: number;
}

/** What the mailbox, the business and the agency have used of their day. */
async function readUsage(trx: DatabaseTransaction, mailboxId: string): Promise<Usage> {
  const { rows } = await sql<Usage>`
    select
      (select count(*) from messaging.outbound_dispatch d
        join messaging.messages m on m.business_id = d.business_id and m.id = d.id
        where m.channel_account_id = ${mailboxId}::uuid and d.reserved_at > now() - interval '24 hours'
      )::integer as recent_all,
      (select count(*) from messaging.outbound_dispatch d
        join messaging.messages m on m.business_id = d.business_id and m.id = d.id
        where m.channel_account_id = ${mailboxId}::uuid and d.reserved_at > now() - interval '24 hours'
          and d.lane in ('automation', 'campaign')
      )::integer as recent_automated,
      (select (extract(epoch from min(d.reserved_at)) * 1000)::float8 from messaging.outbound_dispatch d
        join messaging.messages m on m.business_id = d.business_id and m.id = d.id
        where m.channel_account_id = ${mailboxId}::uuid and d.reserved_at > now() - interval '24 hours'
      ) as earliest_ms,
      -- Released and due, not yet handed to the mail server. One held for the contact's
      -- quiet hours is not in the mailbox's way, so it is not counted.
      (select count(*) from messaging.email_campaigns c
        join messaging.email_campaign_recipients r
          on r.business_id = c.business_id and r.campaign_id = c.id and r.status = 'queued'
        join messaging.outbound_dispatch d on d.business_id = r.business_id and d.id = r.message_id
        join messaging.messages m on m.business_id = d.business_id and m.id = d.id
        where c.mailbox_id = ${mailboxId}::uuid and d.reserved_at is null and m.status = 'queued'
          and (m.scheduled_for is null or m.scheduled_for <= now() + interval '1 minute')
      )::integer as in_flight,
      (select count(*) from messaging.email_campaign_recipients r
        where r.released_at > now() - interval '24 hours')::integer as business_released,
      (select private.agency_campaign_released())::integer as agency_released
  `.execute(trx);
  return only(rows);
}

interface Skip {
  readonly reason: EmailCampaignSkipReason;
  readonly fields?: readonly string[];
}

/**
 * Releases one recipient: the email filled in for the contact and queued on the campaign
 * lane, or the reason there is none. The pipeline's policy is asked first, so a contact it
 * would refuse gets no message at all; queueing and dispatch ask it again.
 */
async function releaseOne(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaign: CampaignRow,
  mailboxId: string,
  contactId: string,
  options: CampaignOptions,
): Promise<{ readonly messageId: string } | Skip> {
  const key = `campaign:${campaign.id}:${contactId}`;
  const identity = await trx
    .selectFrom('crm.contact_identities')
    .select('id')
    .where('contact_id', '=', contactId)
    .where('kind', '=', 'email')
    .where('is_primary', '=', true)
    .executeTakeFirst();
  if (identity === undefined) return { reason: 'no_email' };
  const refused = skipReasonOfPolicy(
    await readOutboundPolicy(trx, {
      identityId: identity.id,
      accountId: mailboxId,
      channel: 'email',
      purpose: 'marketing',
    }),
  );
  if (refused !== null) return { reason: refused };
  const values = {
    ...(await options.values(trx, contactId)),
    [EMAIL_UNSUBSCRIBE_MERGE_FIELD]: UNSUBSCRIBE_PLACEHOLDER,
  };
  // Every campaign email ends with the business's postal address (15 U.S.C.
  // 7704(a)(5)(A)(iii)); the checks refuse to start a campaign without one, and the
  // dispatcher refuses any marketing email without one.
  const addressLine = await readPostalAddressLine(trx, invocation.context);
  const text = await renderWithTriggerLinks(trx, invocation.context, {
    contactId,
    text: {
      subject: campaign.subject,
      body: textWithUnsubscribe(campaign.body_text, addressLine),
    },
    values,
    publicUrl: options.publicUrl,
  });
  if (!text.ok)
    return {
      reason: text.code === 'missing_values' ? 'missing_merge_values' : 'refused',
      fields: text.fields,
    };
  let html: string | undefined;
  if (campaign.body_html !== null) {
    const rendered = await renderWithTriggerLinks(trx, invocation.context, {
      contactId,
      text: {
        subject: '',
        body: htmlWithUnsubscribe(campaign.body_html, campaign.preheader, addressLine),
      },
      values: htmlMergeValues(values),
      publicUrl: options.publicUrl,
    });
    if (!rendered.ok) return { reason: 'missing_merge_values', fields: rendered.fields };
    html = rendered.body;
  }
  const messageId = await queueOutboundMessage(trx, invocation.context, {
    identityId: identity.id,
    accountId: mailboxId,
    channel: 'email',
    purpose: 'marketing',
    lane: 'campaign',
    idempotencyKey: key,
    subject: text.subject,
    text: text.body,
    ...(html === undefined ? {} : { html }),
  });
  // Whatever the pipeline makes of it from here, the next run reads from the message.
  return { messageId };
}

/** Releases up to `limit` of the next pending recipients. Gives how many were queued. */
async function release(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaign: CampaignRow,
  mailboxId: string,
  batch: number,
  limit: number,
  options: CampaignOptions,
): Promise<number> {
  const next = await trx
    .selectFrom('messaging.email_campaign_recipients')
    .select('contact_id')
    .where('campaign_id', '=', campaign.id)
    .where('status', '=', 'pending')
    .orderBy('contact_id')
    .limit(limit)
    .execute();
  let queued = 0;
  for (const { contact_id: contactId } of next) {
    const released = await releaseOne(trx, invocation, campaign, mailboxId, contactId, options);
    const change =
      'messageId' in released
        ? {
            status: 'queued',
            message_id: released.messageId,
            batch,
            released_at: sql<Date>`now()`,
          }
        : {
            status: 'skipped',
            reason: released.reason,
            fields: released.fields === undefined ? null : [...released.fields],
          };
    if ('messageId' in released) queued += 1;
    await trx
      .updateTable('messaging.email_campaign_recipients')
      .set(change)
      .where('campaign_id', '=', campaign.id)
      .where('contact_id', '=', contactId)
      .execute();
  }
  return queued;
}

const touch = (
  trx: DatabaseTransaction,
  campaignId: string,
  change: Partial<
    Pick<
      CampaignRow,
      | 'next_run_at'
      | 'wait_reason'
      | 'wait_until'
      | 'batch_number'
      | 'batch_released'
      | 'audience_cursor'
      | 'audience_fixed_at'
    >
  > & { readonly audience_fixed?: string },
) =>
  trx.updateTable('messaging.email_campaigns').set(change).where('id', '=', campaignId).execute();

/** Fixes the audience, then writes its next batch of contacts as recipient rows. */
async function writeAudience(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: CampaignRow,
  written: number,
  now: Date,
  options: CampaignOptions,
): Promise<Step> {
  const unavailable: Step = { kind: 'advance', to: 'failed', reason: 'audience_unavailable' };
  try {
    if (row.audience_fixed === null) {
      const audience = audienceOf(row);
      if (audience === null) return unavailable;
      await touch(trx, row.id, {
        audience_fixed: JSON.stringify(await fixContactAudience(trx, audience)),
        next_run_at: now,
      });
      return AGAIN;
    }
    const batch = await writeAudienceBatch(trx, invocation, row, options);
    if (written + batch.read > EMAIL_CAMPAIGN_LIMITS.audience)
      return { kind: 'advance', to: 'failed', reason: 'audience_too_large' };
    await touch(trx, row.id, {
      audience_cursor: batch.last ?? row.audience_cursor,
      next_run_at: now,
      ...(batch.read < AUDIENCE_BATCH ? { audience_fixed_at: now } : {}),
    });
    return AGAIN;
  } catch (error) {
    // The smart list is gone or is not the starter's to read, or the filter names a tag or
    // a field the business no longer has. Both are refused before anything is written.
    if (!(error instanceof NotFoundError || error instanceof ValidationError)) throw error;
    return unavailable;
  }
}

function nextRun(plan: ReleasePlan, queued: number, now: Date): Date {
  const soon = new Date(now.getTime() + TICK_MS);
  if (queued > 0 || plan.wait === null || plan.wait.reason === 'mailbox_pacing') return soon;
  if (plan.wait.reason === 'batch_interval' || plan.wait.reason === 'window')
    return plan.wait.until ?? soon;
  return new Date(now.getTime() + LIMIT_RETRY_MS);
}

async function bounced(trx: DatabaseTransaction, row: CampaignRow): Promise<boolean> {
  const { rows } = await sql<{ sent: number; hard: number }>`
    select (count(*) filter (where r.status = 'sent'))::integer as sent,
      (count(*) filter (where m.status = 'bounced' and m.error_code = 'hard_bounce'))::integer as hard
    from messaging.email_campaign_recipients r
    left join messaging.messages m on m.business_id = r.business_id and m.id = r.message_id
    where r.campaign_id = ${row.id}
      and r.released_at > coalesce(${row.resumed_at}::timestamptz, '-infinity'::timestamptz)
  `.execute(trx);
  const since = only(rows);
  return bounceRateExceeded(since.sent, since.hard);
}

const facts = (mailbox: CampaignMailbox, usage: Usage) => ({
  dailyLimit: mailbox.daily_limit,
  warmupEnabled: mailbox.warmup_enabled,
  elapsedDays: mailbox.elapsed_days,
  pacingPerMinute: mailbox.pacing_per_minute,
  useForConversations: mailbox.use_for_conversations,
  recentAll: usage.recent_all,
  recentAutomated: usage.recent_automated,
  earliestReservationMs: usage.earliest_ms,
  inFlight: usage.in_flight,
});

/** One step of a campaign, with its row held. */
async function step(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaignId: string,
  options: CampaignOptions,
): Promise<Step> {
  const row = await findCampaign(trx, requireBusiness(invocation.context), campaignId, true);
  if (row === undefined || row.status === 'draft') return DONE;
  const now = await databaseNow(trx);
  if (row.status === 'scheduled') {
    if (row.send_at !== null && row.send_at.getTime() > now.getTime()) {
      await touch(trx, row.id, { next_run_at: row.send_at });
      return DONE;
    }
    return { kind: 'advance', to: 'sending' };
  }
  const settled = await settle(trx, row.id);
  const counts = await recount(trx, row.id);
  if (settled === CHUNK * 40) {
    await touch(trx, row.id, { next_run_at: now });
    return AGAIN;
  }
  if (row.status !== 'sending') {
    // Paused, cancelled, failed or finished: only what was released is still followed.
    await touch(trx, row.id, {
      next_run_at: counts.queued > 0 ? new Date(now.getTime() + TICK_MS) : null,
    });
    return DONE;
  }
  if (row.audience_fixed_at === null)
    return writeAudience(trx, invocation, row, counts.audience, now, options);
  if (counts.audience === 0) return { kind: 'advance', to: 'failed', reason: 'audience_empty' };
  if (counts.pending === 0 && counts.queued === 0) return { kind: 'advance', to: 'sent' };
  if (counts.sent >= CAMPAIGN_BOUNCE_PAUSE.afterSent && (await bounced(trx, row)))
    return { kind: 'advance', to: 'paused', reason: 'bounce_rate' };
  const idle = {
    batchNumber: row.batch_number,
    batchReleased: row.batch_released,
    release: 0,
    wait: null,
  };
  if (counts.pending === 0) {
    await touch(trx, row.id, {
      next_run_at: nextRun(idle, counts.queued, now),
      wait_reason: null,
      wait_until: null,
    });
    return DONE;
  }
  const mailbox = await readCampaignMailbox(trx, row.mailbox_id);
  if (mailbox === undefined || !mailbox.active || !mailbox.use_for_campaigns)
    return { kind: 'advance', to: 'paused', reason: 'mailbox_unavailable' };
  const usage = await readUsage(trx, mailbox.id);
  const plan = planRelease({
    now,
    startedAt: row.started_at ?? now,
    timeZone: await businessTimeZone(trx, invocation.context),
    batches: batchesOf(row),
    batchNumber: row.batch_number,
    batchReleased: row.batch_released,
    pending: counts.pending,
    mailbox: facts(mailbox, usage),
    businessLimit: await readBusinessCampaignLimit(trx),
    businessReleased: usage.business_released,
    agencyLimit: options.agencyDailyLimit ?? null,
    agencyReleased: usage.agency_released,
  });
  if (plan.release === 0) {
    await touch(trx, row.id, {
      batch_number: plan.batchNumber,
      batch_released: plan.batchReleased,
      wait_reason: plan.wait?.reason ?? null,
      wait_until: plan.wait?.until ?? null,
      next_run_at: nextRun(plan, counts.queued, now),
    });
    return DONE;
  }
  const queued = await release(
    trx,
    invocation,
    row,
    mailbox.id,
    plan.batchNumber,
    Math.min(plan.release, CHUNK),
    options,
  );
  await touch(trx, row.id, {
    batch_number: plan.batchNumber,
    batch_released: plan.batchReleased + queued,
    wait_reason: null,
    wait_until: null,
    // Due at once, so a run that dies here is taken up by the next sweep.
    next_run_at: now,
  });
  return AGAIN;
}

/**
 * Runs a campaign as far as it can go now. The audience is read, and each email written, as
 * whoever sent or scheduled the campaign: their private smart lists are theirs to send to,
 * and the messages are theirs in the conversation. The job has the system's powers, since
 * that person's were checked when they started it.
 */
export async function runEmailCampaign(
  services: Services,
  job: Invocation,
  campaignId: string,
  options: CampaignOptions,
): Promise<void> {
  const starter = await withTenant(services.db, job.context, (trx) =>
    trx
      .selectFrom('messaging.email_campaigns')
      .select(['started_by_kind', 'started_by_id'])
      .where('id', '=', campaignId)
      .executeTakeFirst(),
  );
  if (starter === undefined) return;
  const actorKind = actorKinds.find((kind) => kind === starter.started_by_kind) ?? 'system';
  const actorId = starter.started_by_id;
  const invocation: Invocation = {
    ...job,
    context: {
      ...job.context,
      actorKind,
      ...(actorId === null ? {} : { actorId }),
      ...(actorKind === 'user' && actorId !== null ? { userId: actorId } : {}),
    },
    permissions: 'all',
  };
  for (let steps = 0; steps < STEP_LIMIT; steps += 1) {
    const next = await withTenant(services.db, invocation.context, (trx) =>
      step(trx, invocation, campaignId, options),
    );
    if (next.kind === 'done') return;
    if (next.kind === 'advance') {
      const moved = await runCommand(
        services,
        advance,
        { campaignId, to: next.to, ...(next.reason === undefined ? {} : { reason: next.reason }) },
        invocation,
      );
      if (!moved) return;
    }
  }
}

/** The worker's task: one run of one campaign. */
export function createCampaignTasks(options: CampaignOptions): readonly AnyTask[] {
  return [
    defineTask({
      ...runCampaignReference,
      run: ({ campaignId }, job) =>
        runEmailCampaign(job.services, job.invocation, campaignId, options),
    }),
  ];
}

/**
 * Queues a run for every campaign with work due: a scheduled one whose time has come, one
 * that is sending, and one whose released emails are still on their way. Identifiers only
 * cross the business boundary; each campaign is then read inside its own business.
 */
export async function scheduleEmailCampaigns(services: Services): Promise<number> {
  const { rows } = await sql<{ agency_id: string; business_id: string; campaign_id: string }>`
    select * from private.due_email_campaigns(500)
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
      (trx) => sql`select private.enqueue_email_campaign(${row.campaign_id}::uuid)`.execute(trx),
    );
  return rows.length;
}
