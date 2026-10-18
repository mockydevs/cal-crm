import { mailboxSetupAlerts, type MailboxSetupAlerts } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

/** Unknown evidence does not resolve a known regression; a pass or inapplicable check does. */
export async function readMailboxAlerts(trx: DatabaseTransaction): Promise<MailboxSetupAlerts> {
  const { rows } = await sql<{
    mailbox_id: string;
    name: string;
    check_key: string;
    finished_at: Date;
  }>`
    with latest as (
      select distinct on (r.business_id, r.mailbox_id, c.check_key)
        r.business_id, r.mailbox_id, c.check_key, c.status, r.started_at, r.finished_at, r.id
      from messaging.mailbox_check_runs r
      join messaging.mailbox_check_results c on c.business_id=r.business_id and c.run_id=r.id
      where r.finished_at is not null and c.status <> 'could_not_check'
      order by r.business_id, r.mailbox_id, c.check_key, r.started_at desc, r.id desc
    )
    select l.mailbox_id, a.name, l.check_key, l.finished_at
    from latest l
    join messaging.channel_accounts a on a.business_id=l.business_id and a.id=l.mailbox_id
    where l.status='fail' and a.status='active' and exists (
      select 1 from messaging.mailbox_check_runs older
      join messaging.mailbox_check_results c on c.business_id=older.business_id and c.run_id=older.id
      where older.business_id=l.business_id and older.mailbox_id=l.mailbox_id
        and (older.started_at, older.id) < (l.started_at, l.id)
        and older.finished_at is not null and c.check_key=l.check_key
        and c.status in ('pass', 'not_applicable')
    )
    order by l.finished_at desc, l.mailbox_id, l.check_key
    limit 101
  `.execute(trx);
  return mailboxSetupAlerts.parse({
    data: rows.slice(0, 100).map((row) => ({
      mailboxId: toPublicId('mailbox', row.mailbox_id),
      name: row.name,
      checkKey: row.check_key,
      failedAt: row.finished_at.toISOString(),
    })),
    hasMore: rows.length > 100,
  });
}
