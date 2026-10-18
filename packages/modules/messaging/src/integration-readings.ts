// What Settings → Integrations shows for the business's mailboxes, Twilio accounts and
// Emailable key: how many work, how many need someone, and the one account's name when
// there is exactly one.
import type { IntegrationReading } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/**
 * The business's mailboxes, by their channel account's state as the Email Services page
 * reads it: an active mailbox works and a failing one needs someone. A paused or
 * disconnected mailbox was set aside on purpose, so it counts as neither.
 */
export async function readMailboxIntegration(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<IntegrationReading> {
  // A count without grouping always returns its one row, even when there is nothing.
  const row = await trx
    .selectFrom('messaging.mailboxes as mailbox')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'mailbox.id')
        .onRef('channel.business_id', '=', 'mailbox.business_id'),
    )
    .select([
      sql<number>`count(*) filter (where channel.status = 'active')::int`.as('connected'),
      sql<number>`count(*) filter (where channel.status = 'failing')::int`.as('attention'),
      sql<string | null>`min(mailbox.email_address)
        filter (where channel.status in ('active', 'failing'))`.as('name'),
    ])
    .where('mailbox.business_id', '=', businessId)
    .executeTakeFirstOrThrow();
  return reading(row);
}

/**
 * The business's own accounts with one provider. Emailable's connection status is what the
 * email verification settings show (connected, failing, disconnected); Twilio's is the
 * same column. A disconnected account is gone, so it counts as neither. An agency's shared
 * account (no business) is the agency's to look after and is not counted here.
 */
async function readProviderConnections(
  trx: DatabaseTransaction,
  businessId: string,
  provider: 'twilio' | 'emailable',
): Promise<IntegrationReading> {
  const row = await trx
    .selectFrom('messaging.provider_connections')
    .select([
      sql<number>`count(*) filter (where status = 'connected')::int`.as('connected'),
      sql<number>`count(*) filter (where status = 'failing')::int`.as('attention'),
      sql<string | null>`min(label) filter (where status in ('connected', 'failing'))`.as('name'),
    ])
    .where('business_id', '=', businessId)
    .where('provider', '=', provider)
    .executeTakeFirstOrThrow();
  return reading(row);
}

/** The business's Twilio accounts. */
export function readTwilioIntegration(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<IntegrationReading> {
  return readProviderConnections(trx, businessId, 'twilio');
}

/** The business's Emailable key, of which it has at most one. */
export function readEmailableIntegration(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<IntegrationReading> {
  return readProviderConnections(trx, businessId, 'emailable');
}

// The name is only meaningful when exactly one live account was counted.
function reading(row: {
  readonly connected: number;
  readonly attention: number;
  readonly name: string | null;
}): IntegrationReading {
  return {
    connected: row.connected,
    attention: row.attention,
    label: row.connected + row.attention === 1 ? row.name : null,
  };
}
