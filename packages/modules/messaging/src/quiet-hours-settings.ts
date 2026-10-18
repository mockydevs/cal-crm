import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  messagingSettings,
  updateMessagingSettingsInput,
  type MessagingSettings,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError } from '@repo/kernel';
import { sql } from 'kysely';
import {
  clockOf,
  quietHoursDefaults,
  quietHoursRevision,
  type QuietHoursValues,
} from './quiet-hours-values.js';

async function currentValues(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<QuietHoursValues> {
  const row = await trx
    .selectFrom('messaging.settings')
    .select(['quiet_hours_enabled', 'quiet_hours_start', 'quiet_hours_end', 'contact_daily_limit'])
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  return row === undefined
    ? quietHoursDefaults
    : {
        quietHoursEnabled: row.quiet_hours_enabled,
        quietHoursStart: clockOf(row.quiet_hours_start),
        quietHoursEnd: clockOf(row.quiet_hours_end),
        contactDailyLimit: row.contact_daily_limit,
      };
}

/** The business's quiet hours and daily limit, and what they are holding back now. */
export async function readMessagingSettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<MessagingSettings> {
  const businessId = requireBusiness(invocation.context);
  const values = await currentValues(trx, businessId);
  const {
    rows: [counts],
  } = await sql<{ held: number; without_time_zone: number }>`
    select
      (select count(*)::integer from messaging.messages
        where business_id=${businessId}::uuid and direction='outbound'
          and status='queued' and error_code='quiet_hours') as held,
      -- As sending reads it (outbound.ts quietHoursZone): a zone PostgreSQL doesn't know,
      -- or an abbreviation such as EST, counts as none, and the business's zone is used.
      (select count(*)::integer from crm.contacts c
        left join pg_catalog.pg_timezone_names tz on tz.name=c.timezone
          and (tz.name like '%/%' or tz.name='UTC')
        where c.business_id=${businessId}::uuid and c.deleted_at is null
          and tz.name is null) as without_time_zone
  `.execute(trx);
  return messagingSettings.parse({
    ...values,
    revision: quietHoursRevision(values),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('mailboxes.manage'),
    heldMessages: counts?.held ?? 0,
    contactsWithoutTimeZone: counts?.without_time_zone ?? 0,
  });
}

export const updateMessagingSettingsCommand = defineCommand({
  name: 'messaging.update_settings',
  permission: 'mailboxes.manage',
  input: updateMessagingSettingsInput,
  async handle(trx, input, command) {
    const businessId = requireBusiness(command.context);
    // The dispatch lock: a send check sees the settings before or after a save, and two
    // saves take turns, so the revision check below can't be raced.
    await trx
      .selectFrom('tenancy.businesses')
      .select('id')
      .where('id', '=', businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (quietHoursRevision(await currentValues(trx, businessId)) !== input.revision)
      throw new ConflictError(
        'These settings changed after you opened them. Reload the page and try again.',
      );
    const saved = {
      quiet_hours_enabled: input.quietHoursEnabled,
      quiet_hours_start: input.quietHoursStart,
      quiet_hours_end: input.quietHoursEnd,
      contact_daily_limit: input.contactDailyLimit,
    };
    await trx
      .insertInto('messaging.settings')
      .values({ business_id: businessId, ...saved })
      .onConflict((conflict) => conflict.column('business_id').doUpdateSet(saved))
      .execute();
    await command.emit({
      type: 'messaging_settings.updated',
      subject: { kind: 'business', id: businessId },
      payload: {
        quietHoursEnabled: input.quietHoursEnabled,
        quietHoursStart: input.quietHoursStart,
        quietHoursEnd: input.quietHoursEnd,
        contactDailyLimit: input.contactDailyLimit,
      },
    });
    return readMessagingSettings(trx, command);
  },
});
