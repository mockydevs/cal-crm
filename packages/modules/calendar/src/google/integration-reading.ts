// What Settings → Integrations shows for Google Calendar in a business: how many members'
// connections work, how many need someone, and the account's address when there is one.
import type { IntegrationReading } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

// The same test the member's own Google settings use for a failing calendar: a refresh of
// the busy time failed after the last one that worked, or failed before any ever did.
const busyFailing = sql<boolean>`busy_failed_at is not null
  and (busy_checked_at is null or busy_failed_at > busy_checked_at)`;

/**
 * Members' Google Calendar connections in the business. A connection Google refused
 * (expired or revoked) needs the member to connect again, so it counts as needing
 * attention; one a member ended, or that ended with their membership, counts as nothing.
 */
export async function readGoogleCalendarIntegration(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<IntegrationReading> {
  // A count without grouping always returns its one row, even when there is nothing.
  const row = await trx
    .selectFrom('calendar.google_connections')
    .select([
      sql<number>`count(*) filter (where status = 'connected' and not (${busyFailing}))::int`.as(
        'connected',
      ),
      sql<number>`count(*) filter (where (status = 'connected' and ${busyFailing})
        or (status = 'disconnected' and disconnected_reason = 'expired_or_revoked'))::int`.as(
        'attention',
      ),
      sql<number>`count(*) filter (where status <> 'disconnected')::int`.as('live'),
      sql<string | null>`min(google_email) filter (where status <> 'disconnected')`.as('email'),
    ])
    .where('business_id', '=', businessId)
    .executeTakeFirstOrThrow();
  return {
    connected: row.connected,
    attention: row.attention,
    label: row.live === 1 ? row.email : null,
  };
}
