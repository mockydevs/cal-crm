import type { DatabaseTransaction } from '@repo/db';
import { requireBusiness } from '@repo/commands';
import { parseInput } from '@repo/contracts';
import type { TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import { queueOutboundMessage } from './outbound.js';

/** Who a calendar invite is from (the sending mailbox) and to (the booker's address). */
export interface CalendarInviteParties {
  readonly organizer: { readonly email: string; readonly name: string };
  readonly attendee: { readonly email: string; readonly name: string };
}

export interface CalendarConfirmationInput {
  readonly identityId: string;
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly subject: string;
  readonly text: string;
  /**
   * A calendar invite to send with the email (RFC 6047): its iTIP method, and the calendar
   * module's own builder of the iCalendar text, given the parties as stored here.
   */
  readonly invite?: {
    readonly method: 'REQUEST' | 'CANCEL';
    readonly build: (parties: CalendarInviteParties) => string;
  };
}
export type CalendarConfirmationResult =
  { readonly outcome: 'queued'; readonly deferred: boolean } | { readonly outcome: 'refused' };

const recipientInput = z.strictObject({ appointmentId: z.uuid(), contactId: z.uuid() });

/** Management commands derive both UUIDs; removal never selects a new primary address. */
export async function readCalendarConfirmationRecipient(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: { readonly appointmentId: string; readonly contactId: string },
): Promise<string | null> {
  const { appointmentId, contactId } = parseInput(recipientInput, input);
  const businessId = requireBusiness(context);
  const recipient = await trx
    .selectFrom('messaging.messages as m')
    .innerJoin('messaging.outbound_dispatch as d', (join) =>
      join.onRef('d.business_id', '=', 'm.business_id').onRef('d.id', '=', 'm.id'),
    )
    .innerJoin('messaging.conversations as v', (join) =>
      join.onRef('v.business_id', '=', 'm.business_id').onRef('v.id', '=', 'm.conversation_id'),
    )
    .innerJoin('crm.contact_identities as i', (join) =>
      join
        .onRef('i.business_id', '=', 'd.business_id')
        .onRef('i.id', '=', 'd.identity_id')
        .onRef('i.contact_id', '=', 'v.contact_id'),
    )
    .select('i.id')
    .where('m.business_id', '=', businessId)
    .where('m.idempotency_key', '=', `calendar:book:${appointmentId}`)
    .where('m.direction', '=', 'outbound')
    .where('m.channel', '=', 'email')
    .where('d.purpose', '=', 'transactional')
    .where('d.lane', '=', 'transactional')
    .where('v.contact_id', '=', contactId)
    .where('i.kind', '=', 'email')
    .executeTakeFirst();
  return recipient?.id ?? null;
}

/** Scoped booking commands supply resolved UUIDs; canonical outbound policy still applies. */
export async function queueCalendarConfirmation(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: CalendarConfirmationInput,
): Promise<CalendarConfirmationResult> {
  const messageId = await queueOutboundMessage(trx, context, {
    identityId: input.identityId,
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
    subject: input.subject,
    text: input.text,
    channel: 'email',
    purpose: 'transactional',
    lane: 'transactional',
  });
  const message = await trx
    .selectFrom('messaging.messages')
    .select(['status', sql<boolean>`coalesce(scheduled_for>now(),false)`.as('deferred')])
    .where('id', '=', messageId)
    .executeTakeFirstOrThrow();
  if (message.status !== 'queued') return { outcome: 'refused' };
  if (input.invite !== undefined) {
    const businessId = requireBusiness(context);
    const parties = await trx
      .selectFrom('messaging.mailboxes as m')
      .innerJoin('crm.contact_identities as i', (join) =>
        join.onRef('i.business_id', '=', 'm.business_id'),
      )
      .innerJoin('crm.contacts as c', (join) =>
        join.onRef('c.business_id', '=', 'i.business_id').onRef('c.id', '=', 'i.contact_id'),
      )
      .select([
        'm.email_address',
        'm.display_name',
        'i.value as attendee',
        'c.first_name',
        'c.last_name',
      ])
      .where('m.business_id', '=', businessId)
      .where('m.id', '=', input.accountId)
      .where('i.id', '=', input.identityId)
      .where('i.kind', '=', 'email')
      .executeTakeFirstOrThrow();
    const content = input.invite.build({
      organizer: { email: parties.email_address, name: parties.display_name },
      attendee: {
        email: parties.attendee,
        name: [parties.first_name, parties.last_name].filter((part) => part !== null).join(' '),
      },
    });
    await trx
      .insertInto('messaging.message_invites')
      .values({
        business_id: businessId,
        message_id: messageId,
        method: input.invite.method,
        content,
      })
      .onConflict((conflict) => conflict.columns(['business_id', 'message_id']).doNothing())
      .execute();
  }
  return { outcome: 'queued', deferred: message.deferred };
}
