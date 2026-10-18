import { randomUUID } from 'node:crypto';
import type { Services } from '@repo/commands';
import { withTenant } from '@repo/db';
import { sql } from 'kysely';
import { beginMailboxCheck } from './check-runs.js';

/** Bounded identifier-only discovery; each mailbox is rechecked and locked in its tenant. */
export async function scheduleMailboxChecks(services: Services): Promise<number> {
  const { rows } = await sql<{ agency_id: string; business_id: string; mailbox_id: string }>`
    select * from private.due_mailbox_checks(1000)
  `.execute(services.db);
  let queued = 0;
  for (const row of rows) {
    const added = await withTenant(
      services.db,
      {
        agencyId: row.agency_id,
        businessId: row.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      },
      async (trx) => {
        const mailbox = await trx
          .selectFrom('messaging.mailboxes as mailbox')
          .innerJoin('messaging.channel_accounts as channel', 'channel.id', 'mailbox.id')
          .innerJoin('tenancy.businesses as business', 'business.id', 'mailbox.business_id')
          .select('mailbox.id')
          .select(
            sql<boolean>`mailbox.setup_checked_at is null or mailbox.setup_checked_at <= now() - interval '1 day'`.as(
              'due',
            ),
          )
          .where('mailbox.id', '=', row.mailbox_id)
          .where('channel.status', '=', 'active')
          .where('business.status', '=', 'active')
          .forUpdate('mailbox')
          .executeTakeFirst();
        if (mailbox === undefined) return false;
        const pending = await trx
          .selectFrom('messaging.mailbox_check_runs')
          .select('id')
          .select(sql<boolean>`queued_at <= now() - interval '10 minutes'`.as('stale'))
          .where('mailbox_id', '=', mailbox.id)
          .where('finished_at', 'is', null)
          .executeTakeFirst();
        if (pending !== undefined && !pending.stale) return false;
        if (pending === undefined && !mailbox.due) return false;
        const runId =
          pending?.id ??
          (await beginMailboxCheck(trx, row.business_id, mailbox.id, 'scheduled')).runId;
        await sql`select private.enqueue_mailbox_check(${runId}::uuid, null::uuid)`.execute(trx);
        return true;
      },
    );
    if (added) queued += 1;
  }
  return queued;
}
