// What became of a campaign: its recipients one by one, and its numbers. Both are read when
// asked, from the recipient rows and the messages they point at, so they agree with the
// conversations. Opens and clicks are not measured, so they are not here.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  emailCampaignRecipientStatuses,
  emailCampaignSkipReasons,
  type EmailCampaignRecipientList,
  type EmailCampaignStats,
  type listEmailCampaignRecipients,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import type * as z from 'zod';

import { only, requireCampaign } from './campaign-store.js';

export async function readCampaignRecipients(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  query: z.output<typeof listEmailCampaignRecipients.query>,
): Promise<EmailCampaignRecipientList> {
  const businessId = requireBusiness(invocation.context);
  const campaign = await requireCampaign(trx, invocation.context, id);
  let selection = trx
    .selectFrom('messaging.email_campaign_recipients as recipient')
    .innerJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'recipient.business_id')
        .onRef('contact.id', '=', 'recipient.contact_id'),
    )
    .leftJoin('messaging.messages as message', (join) =>
      join
        .onRef('message.business_id', '=', 'recipient.business_id')
        .onRef('message.id', '=', 'recipient.message_id'),
    )
    .leftJoin('messaging.outbound_dispatch as dispatch', (join) =>
      join
        .onRef('dispatch.business_id', '=', 'recipient.business_id')
        .onRef('dispatch.id', '=', 'recipient.message_id'),
    )
    .select([
      'recipient.contact_id',
      'recipient.status',
      'recipient.reason',
      'recipient.fields',
      'recipient.batch',
      'recipient.message_id',
      'contact.display_name',
      'message.status as message_status',
      'message.sent_at',
      'message.to_addresses',
      'dispatch.unsubscribe_used_at',
    ])
    .where('recipient.business_id', '=', businessId)
    .where('recipient.campaign_id', '=', campaign.id);
  if (query.status !== undefined)
    selection = selection.where('recipient.status', '=', query.status);
  if (query.reason !== undefined)
    selection = selection.where('recipient.reason', '=', query.reason);
  if (query.after !== undefined)
    selection = selection.where(
      'recipient.contact_id',
      '>',
      parsePublicId('contact', query.after) ?? '',
    );
  const rows = await selection
    .orderBy('recipient.contact_id')
    .limit(query.limit + 1)
    .execute();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      contactId: toPublicId('contact', row.contact_id),
      name: row.display_name,
      // The address it was sent to. Before that, none is shown: it is read when it leaves.
      email: row.to_addresses?.[0] ?? null,
      status: emailCampaignRecipientStatuses.find((status) => status === row.status) ?? 'failed',
      reason: emailCampaignSkipReasons.find((reason) => reason === row.reason) ?? null,
      fields: row.fields,
      batch: row.batch,
      bounced: row.message_status === 'bounced',
      unsubscribed: row.unsubscribe_used_at !== null,
      messageId: row.message_id === null ? null : toPublicId('message', row.message_id),
      sentAt: row.sent_at?.toISOString() ?? null,
    })),
    next:
      rows.length > query.limit && last !== undefined
        ? toPublicId('contact', last.contact_id)
        : null,
  };
}

interface Totals {
  readonly audience: number;
  readonly pending: number;
  readonly queued: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  readonly bounced: number;
  readonly hard_bounced: number;
  readonly unsubscribed: number;
  readonly batches: number;
}

export async function readCampaignStats(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<EmailCampaignStats> {
  const campaign = await requireCampaign(trx, invocation.context, id);
  const { rows } = await sql<Totals>`
    select count(*)::integer as audience,
      (count(*) filter (where r.status = 'pending'))::integer as pending,
      (count(*) filter (where r.status = 'queued'))::integer as queued,
      (count(*) filter (where r.status = 'sent'))::integer as sent,
      (count(*) filter (where r.status = 'failed'))::integer as failed,
      (count(*) filter (where r.status = 'skipped'))::integer as skipped,
      (count(*) filter (where m.status = 'bounced'))::integer as bounced,
      (count(*) filter (where m.status = 'bounced' and m.error_code = 'hard_bounce'))::integer as hard_bounced,
      (count(*) filter (where d.unsubscribe_used_at is not null))::integer as unsubscribed,
      coalesce(max(r.batch), 0)::integer as batches
    from messaging.email_campaign_recipients r
    left join messaging.messages m on m.business_id = r.business_id and m.id = r.message_id
    left join messaging.outbound_dispatch d on d.business_id = r.business_id and d.id = r.message_id
    where r.campaign_id = ${campaign.id}
  `.execute(trx);
  const totals = only(rows);
  const reasons = await trx
    .selectFrom('messaging.email_campaign_recipients')
    .select(['reason', (eb) => eb.fn.countAll<string>().as('count')])
    .where('campaign_id', '=', campaign.id)
    .where('status', '=', 'skipped')
    .groupBy('reason')
    .execute();
  return {
    audience: totals.audience,
    pending: totals.pending,
    queued: totals.queued,
    sent: totals.sent,
    failed: totals.failed,
    skipped: totals.skipped,
    skippedByReason: reasons
      .flatMap((row) => {
        const reason = emailCampaignSkipReasons.find((each) => each === row.reason);
        return reason === undefined ? [] : [{ reason, count: Number(row.count) }];
      })
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    bounced: totals.bounced,
    hardBounced: totals.hard_bounced,
    unsubscribed: totals.unsubscribed,
    batches: totals.batches,
    countedAt: new Date().toISOString(),
  };
}
