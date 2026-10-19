import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { queueOutboundMessage } from '../outbound.js';

/**
 * Sends a single follow-up SMS to a recognized contact after an inbound call was missed,
 * subject to the business settings, caller consent, quiet hours and phone number capabilities.
 */
export async function maybeSendMissedCallText(
  trx: DatabaseTransaction,
  context: TenantContext,
  callId: string,
): Promise<void> {
  const call = await trx
    .selectFrom('messaging.calls as c')
    .leftJoin('messaging.phone_numbers as p', (join) =>
      join.onRef('p.business_id', '=', 'c.business_id').onRef('p.id', '=', 'c.phone_number_id'),
    )
    .select([
      'c.id',
      'c.business_id',
      'c.direction',
      'c.state',
      'c.failure_code',
      'c.connected_at',
      'c.contact_identity_id',
      'c.phone_number_id',
      'p.capabilities',
    ])
    .where('c.id', '=', callId)
    .executeTakeFirst();

  if (call === undefined) return;
  if (call.direction !== 'inbound') return;
  if (call.connected_at !== null) return;

  const isMissed =
    call.state === 'ended' ||
    (call.state === 'refused' && call.failure_code === 'member_unavailable');
  if (!isMissed) return;

  if (call.contact_identity_id === null || call.phone_number_id === null) return;
  if (!call.capabilities?.includes('sms')) return;

  const settings = await trx
    .selectFrom('messaging.phone_system_settings')
    .select(['missed_call_text_enabled', 'missed_call_text'])
    .where('business_id', '=', call.business_id)
    .executeTakeFirst();

  if (!settings?.missed_call_text_enabled) return;
  if (settings.missed_call_text === null) return;
  const text = settings.missed_call_text.trim();
  if (text === '') return;

  await queueOutboundMessage(trx, context, {
    identityId: call.contact_identity_id,
    accountId: call.phone_number_id,
    channel: 'sms',
    purpose: 'transactional',
    lane: 'reply',
    idempotencyKey: `missed-call:${call.id}`,
    text: settings.missed_call_text,
  });
}
