// Which kinds of notification a person receives in a business. The choice is the person's
// own: nobody else reads or changes it, and row-level security says so too.
import { requireBusiness, type Invocation } from '@repo/commands';
import type { NotificationPreferences, updateNotificationPreferencesInput } from '@repo/contracts';
import type { DatabaseTransaction, Json } from '@repo/db';
import { sql } from 'kysely';
import type * as z from 'zod';

import { preferencesOf } from './rules.js';
import { requirePerson } from './store.js';

/** The name a change of preferences has in the audit log. */
export const PREFERENCES_CHANGED = 'notification_preferences.update';

/** Every kind, on or off, for the caller in the business they work in. */
export async function readPreferences(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<NotificationPreferences> {
  const businessId = requireBusiness(invocation.context);
  const me = requirePerson(invocation.context);
  const stored = await trx
    .selectFrom('notifications.preferences')
    .select(['kind', 'in_app', 'remind_minutes'])
    .where('business_id', '=', businessId)
    .where('user_id', '=', me)
    .execute();
  return preferencesOf(stored);
}

/**
 * Turns the kinds named on or off for the caller, and leaves the rest as they were. The
 * change is kept in the audit log with who made it, as a command's is. It needs no
 * permission, so it is not a command: a person's own preferences are theirs whatever
 * their role allows, and a role cannot take them away.
 */
export async function savePreferences(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: z.output<typeof updateNotificationPreferencesInput>,
): Promise<NotificationPreferences> {
  const { context } = invocation;
  const businessId = requireBusiness(context);
  const me = requirePerson(context);
  await trx
    .insertInto('notifications.preferences')
    .values(
      input.items.map((item) => ({
        business_id: businessId,
        user_id: me,
        kind: item.kind,
        in_app: item.inApp,
        remind_minutes: item.remindMinutes ?? null,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['business_id', 'user_id', 'kind']).doUpdateSet((eb) => ({
        in_app: eb.ref('excluded.in_app'),
        // A reminder's time is changed only when it is sent; left out, it stays.
        remind_minutes: sql<number | null>`case when ${JSON.stringify(
          input.items.filter((item) => item.remindMinutes !== undefined).map((item) => item.kind),
        )}::jsonb ? excluded.kind then excluded.remind_minutes
            else notifications.preferences.remind_minutes end`,
      })),
    )
    .execute();
  await trx
    .insertInto('audit.commands')
    .values({
      agency_id: context.agencyId,
      business_id: businessId,
      command: PREFERENCES_CHANGED,
      actor_kind: context.actorKind,
      actor_id: me,
      ip: invocation.ip ?? null,
      user_agent: invocation.userAgent ?? null,
      outcome: 'ok',
      error_code: null,
      input: sql<Json>`${JSON.stringify({ items: input.items })}::jsonb`,
      correlation_id: context.correlationId,
    })
    .execute();
  return readPreferences(trx, invocation);
}
