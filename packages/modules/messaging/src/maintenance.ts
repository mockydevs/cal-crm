import { randomUUID } from 'node:crypto';
import type { Services } from '@repo/commands';
import { withTenant } from '@repo/db';
import type { SealingVault } from '@repo/module-vault';
import { sql } from 'kysely';
import { failAttempt, findAttempt } from './attempts.js';

/** Bounded, tenant-scoped cleanup. Only identifiers cross the maintenance boundary. */
export async function expireMailboxAttempts(
  services: Services,
  vault: SealingVault,
): Promise<number> {
  const { rows } = await sql<{
    agency_id: string;
    business_id: string;
    attempt_id: string;
  }>`select * from private.expired_mailbox_attempts(1000)`.execute(services.db);
  let removed = 0;
  for (const row of rows) {
    const expired = await withTenant(
      services.db,
      {
        agencyId: row.agency_id,
        businessId: row.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      },
      async (trx) => {
        const attempt = await findAttempt(trx, row.attempt_id, true);
        if (attempt?.status !== 'pending' || attempt.expires_at.getTime() > Date.now())
          return false;
        await failAttempt(trx, vault, attempt, 'expired');
        await sql`select pg_notify('crm_business_changed', ${row.business_id})`.execute(trx);
        return true;
      },
    );
    if (expired) removed += 1;
  }
  return removed;
}

/** Authentication links waiting for delivery must not remain indefinitely in the vault. */
export async function expireInstallMessages(
  services: Services,
  vault: SealingVault,
): Promise<number> {
  const { rows } = await sql<{
    agency_id: string;
    business_id: string;
    message_id: string;
  }>`select * from private.expired_install_messages(1000)`.execute(services.db);
  let removed = 0;
  for (const row of rows) {
    const expired = await withTenant(
      services.db,
      {
        agencyId: row.agency_id,
        businessId: row.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      },
      async (trx) => {
        const current = await trx
          .selectFrom('vault.secrets')
          .select('id')
          .where('id', '=', row.message_id)
          .where('purpose', '=', 'mailbox.install_message')
          .where('created_at', '<=', sql<Date>`now() - interval '10 minutes'`)
          .forUpdate()
          .executeTakeFirst();
        if (current === undefined) return false;
        await vault.remove(trx, current.id);
        return true;
      },
    );
    if (expired) removed += 1;
  }
  return removed;
}
