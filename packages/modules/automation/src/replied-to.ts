// "Replied to automation": which automation an inbound message is a reply to. It is the one
// whose run sent the contact's most recent automated message on the same channel, at or
// before the reply. There is no time window, and threads are not followed: only order in
// time, on one channel.
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/**
 * The automation whose run sent the contact's most recent automated message on a channel,
 * at or before a moment, or nothing when none was sent. Whether that run is still going
 * does not matter: the reply itself has often just stopped it.
 *
 * A step's message is queued with the key `automation:<enrolment>:<step>:<visit>`
 * (actions.ts), which is what names the run here. A message that failed or bounced is not
 * counted, and neither is one a person sent by hand.
 */
export async function automationRepliedTo(
  trx: DatabaseTransaction,
  reply: { readonly recordId: string; readonly channel: string; readonly at: Date },
): Promise<string | undefined> {
  const { rows } = await sql<{ automation_id: string | null }>`
    select (
      select run.automation_id from automation.enrolments run
      where run.business_id = message.business_id
        and run.id::text = split_part(message.idempotency_key, ':', 2)
    ) as automation_id
    from messaging.messages message
    join messaging.conversations conversation
      on conversation.business_id = message.business_id
     and conversation.id = message.conversation_id
    where conversation.contact_id = ${reply.recordId}
      and message.direction = 'outbound'
      and message.channel = ${reply.channel}
      and message.idempotency_key like 'automation:%'
      and message.status not in ('failed', 'bounced')
      and coalesce(message.sent_at, message.created_at) <= ${reply.at}
    order by coalesce(message.sent_at, message.created_at) desc, message.id desc
    limit 1
  `.execute(trx);
  return rows[0]?.automation_id ?? undefined;
}

/**
 * Whether a run has sent the contact a message on a channel, at or before a moment: what a
 * stop on a reply to the run's own messages asks. The same key names the run, and the same
 * messages are left out: failed or bounced ones, and those a person sent by hand. A reply
 * with no channel answers nothing.
 */
export async function runWroteOn(
  trx: DatabaseTransaction,
  reply: {
    readonly enrolmentId: string;
    readonly recordId: string;
    readonly channel: unknown;
    readonly at: Date;
  },
): Promise<boolean> {
  if (typeof reply.channel !== 'string') return false;
  const { rows } = await sql<{ wrote: boolean }>`
    select exists (
      select 1
      from messaging.messages message
      join messaging.conversations conversation
        on conversation.business_id = message.business_id
       and conversation.id = message.conversation_id
      where conversation.contact_id = ${reply.recordId}
        and message.direction = 'outbound'
        and message.channel = ${reply.channel}
        and message.idempotency_key like ${`automation:${reply.enrolmentId}:%`}
        and message.status not in ('failed', 'bounced')
        and coalesce(message.sent_at, message.created_at) <= ${reply.at}
    ) as wrote
  `.execute(trx);
  return rows[0]?.wrote === true;
}
