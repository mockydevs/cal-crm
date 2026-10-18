import { defineCommand, requireBusiness } from '@repo/commands';
import {
  mailboxSendingSettings,
  updateMailboxSendingInput,
  type MailboxSendingSettings,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';
import { mailboxDailyAllowance } from './mailbox-admission.js';

export async function readMailboxSendingSettings(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<MailboxSendingSettings> {
  const id = parsePublicId('mailbox', publicId);
  if (id === undefined) throw new NotFoundError('mailbox', publicId);
  const row = await trx
    .selectFrom('messaging.mailboxes')
    .select([
      'daily_limit',
      'pacing_per_minute',
      'warmup_enabled',
      'use_for_conversations',
      'use_for_campaigns',
      sql<Date>`coalesce(warmup_started_at,created_at)`.as('warmup_start'),
      sql<number>`floor(extract(epoch from (now()-coalesce(warmup_started_at,created_at)))/86400)::integer`.as(
        'elapsed_days',
      ),
      sql<Date | null>`case when sending_paused_until>now() then sending_paused_until else null end`.as(
        'paused_until',
      ),
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('mailbox', publicId);
  return mailboxSendingSettings.parse({
    dailyLimit: row.daily_limit,
    pacingPerMinute: row.pacing_per_minute,
    warmupEnabled: row.warmup_enabled,
    useForConversations: row.use_for_conversations,
    useForCampaigns: row.use_for_campaigns,
    effectiveAutomatedDailyLimit: mailboxDailyAllowance(
      row.daily_limit,
      row.warmup_enabled,
      row.elapsed_days,
    ),
    warmupStartedAt: row.warmup_start.toISOString(),
    pausedUntil: row.paused_until?.toISOString() ?? null,
    pauseReason: row.paused_until === null ? null : 'provider_temporary',
  });
}

export const updateMailboxSendingCommand = defineCommand({
  name: 'mailboxes.update_sending',
  permission: 'mailboxes.manage',
  input: updateMailboxSendingInput,
  audit: ({ id, settings }) => ({ id, ...settings }),
  async handle(trx, { id, settings }, command) {
    const businessId = requireBusiness(command.context);
    // Use the dispatch business lock so configuration cannot race quota admission.
    await trx
      .selectFrom('tenancy.businesses')
      .select('id')
      .where('id', '=', businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const mailboxId = parsePublicId('mailbox', id);
    if (mailboxId === undefined) throw new NotFoundError('mailbox', id);
    const updated = await trx
      .updateTable('messaging.mailboxes')
      .set({
        daily_limit: settings.dailyLimit,
        pacing_per_minute: settings.pacingPerMinute,
        warmup_enabled: settings.warmupEnabled,
        use_for_conversations: settings.useForConversations,
        use_for_campaigns: settings.useForCampaigns,
      })
      .where('id', '=', mailboxId)
      .returning('id')
      .executeTakeFirst();
    if (updated === undefined) throw new NotFoundError('mailbox', id);
    await command.emit({
      type: 'mailbox.sending_updated',
      subject: { kind: 'mailbox', id: mailboxId },
    });
    return readMailboxSendingSettings(trx, id);
  },
});
