import type { CommandContext } from '@repo/commands';
import { createContactInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ValidationError } from '@repo/kernel';
import { createContact } from '@repo/module-crm';
import { sql } from 'kysely';

import { queueOutboundMessage } from '../outbound.js';

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Sends a single follow-up SMS after an inbound call was missed, creating the contact first
 * when the caller is not recognized yet, subject to the business settings, caller consent,
 * quiet hours and phone number capabilities.
 */
export async function maybeSendMissedCallText(
  trx: DatabaseTransaction,
  command: CommandContext,
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
      'c.contact_id',
      'c.remote_e164',
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

  if (call.phone_number_id === null) return;
  if (!call.capabilities?.includes('sms')) return;

  const settings = await trx
    .selectFrom('messaging.phone_system_settings')
    .select(['missed_call_text_enabled', 'missed_call_text'])
    .where('business_id', '=', call.business_id)
    .executeTakeFirst();

  // When the missed-call text is off (or empty), leave unknown callers alone without creating
  // a contact: the owner's decision was to create contacts only for sending the missed-call text.
  if (!settings?.missed_call_text_enabled) return;
  if (settings.missed_call_text === null) return;
  const text = settings.missed_call_text.trim();
  if (text === '') return;

  let contactIdentityId = call.contact_identity_id;

  if (contactIdentityId === null) {
    if (call.remote_e164 === null) return;
    if (!E164.test(call.remote_e164)) return;

    // Unknown callers are locked and created one at a time per business (as inbound SMS does).
    await sql`select pg_advisory_xact_lock(hashtextextended(${`inbound-senders:${call.business_id}`}, 0))`.execute(
      trx,
    );

    const findIdentity = () =>
      trx
        .selectFrom('crm.contact_identities')
        .select(['contact_id', 'id'])
        .where('business_id', '=', call.business_id)
        .where('kind', '=', 'phone')
        .where('value_normalized', '=', call.remote_e164)
        .executeTakeFirst();

    let matched = await findIdentity();
    if (matched === undefined) {
      const input = createContactInput.safeParse({ phones: [call.remote_e164] });
      if (!input.success) return;
      try {
        // The CRM's own command keeps its invariants: identities, timeline and contact.created.
        await createContact(trx, input.data, command, 'call');
      } catch (failure) {
        // A number the CRM doesn't accept as a phone number is refused before it writes anything.
        if (!(failure instanceof ValidationError)) throw failure;
        return;
      }
      matched = await findIdentity();
    }

    if (matched === undefined) return;

    await trx
      .updateTable('messaging.calls')
      .set({
        contact_id: matched.contact_id,
        contact_identity_id: matched.id,
      })
      .where('id', '=', call.id)
      .execute();

    contactIdentityId = matched.id;
  }

  await queueOutboundMessage(trx, command.context, {
    identityId: contactIdentityId,
    accountId: call.phone_number_id,
    channel: 'sms',
    purpose: 'transactional',
    lane: 'reply',
    idempotencyKey: `missed-call:${call.id}`,
    text: settings.missed_call_text,
  });
}
