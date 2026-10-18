// The notifications module's housekeeping, for the worker's maintenance schedule.
import type { Services } from '@repo/commands';

/** Notifications removed in one run; private.expire_notifications takes at most 50,000. */
const BATCH = 5000;

/**
 * Removes the notifications that are past their time, in every business, and says how
 * many: 30 days after one was read, or 90 days after it was made if nobody read it
 * (migration 0056). It skips a row someone is marking read at that moment, and takes it
 * the next hour.
 */
export async function expireNotifications(services: Services): Promise<number> {
  const row = await services.db
    .selectNoFrom((eb) =>
      // Kysely writes a function's name as given, so this is private.expire_notifications.
      eb.fn<number>('private.expire_notifications', [eb.val(BATCH)]).as('removed'),
    )
    .executeTakeFirstOrThrow();
  return row.removed;
}
