// What the outbound pipeline asks of a campaign as one of its emails is about to leave:
// whether the campaign still sends, and who it says the email is from.
import type { DatabaseTransaction } from '@repo/db';

import type { OutboundAdmission } from './outbound.js';

type Gate = Exclude<Awaited<ReturnType<OutboundAdmission>>, { action: 'allow' }>;

/** How long a paused campaign's released emails wait before asking again. */
export const CAMPAIGN_PAUSE_RETRY_MS = 5 * 60_000;

const campaignOf = (trx: DatabaseTransaction, messageId: string) =>
  trx
    .selectFrom('messaging.email_campaign_recipients as recipient')
    .innerJoin('messaging.email_campaigns as campaign', (join) =>
      join
        .onRef('campaign.business_id', '=', 'recipient.business_id')
        .onRef('campaign.id', '=', 'recipient.campaign_id'),
    )
    .where('recipient.message_id', '=', messageId);

/**
 * Why this email must not leave now, or undefined when it may: a paused campaign's email
 * waits, and one of a campaign that is no longer sending is refused. A message on the
 * campaign lane that belongs to no campaign is not held.
 */
export async function readCampaignGate(
  trx: DatabaseTransaction,
  messageId: string,
): Promise<Gate | undefined> {
  const row = await campaignOf(trx, messageId).select('campaign.status').executeTakeFirst();
  if (row === undefined || row.status === 'sending') return undefined;
  if (row.status === 'paused')
    return {
      action: 'defer',
      reason: 'campaign_paused',
      retryAt: new Date(Date.now() + CAMPAIGN_PAUSE_RETRY_MS),
    };
  return { action: 'refuse', reason: 'campaign_cancelled' };
}

/** The name and reply address a campaign gives its emails; undefined for other mail. */
export async function readCampaignSender(
  trx: DatabaseTransaction,
  messageId: string,
): Promise<{ readonly fromName: string | null; readonly replyTo: string | null } | undefined> {
  const row = await campaignOf(trx, messageId)
    .select(['campaign.from_name', 'campaign.reply_to'])
    .executeTakeFirst();
  return row === undefined ? undefined : { fromName: row.from_name, replyTo: row.reply_to };
}
