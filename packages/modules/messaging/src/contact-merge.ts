// Messaging's part in a contact merge (crm contacts/merge.ts): the contact kept ends up with
// one conversation holding every message of both, the consent history of both, and the rest
// of what messaging keeps of a contact, as GoHighLevel combines conversations on a merge.
//
// Locks. Every writer of conversations takes the business row first (inbox.sql's order: the
// business, the conversation, then messages and the chat session), and the inbox reply and
// the outbound worker hold it FOR UPDATE. A booking holds it FOR NO KEY UPDATE, then the
// contact, then FOR UPDATE to queue its confirmation. The merge takes it in `lock`, before
// any contact's row, FOR NO KEY UPDATE: a writer holding the business never waits for
// something the merge holds, and one that holds a contact and will need the business FOR
// UPDATE has taken the business first, so the merge waits for it there. In `merge`, both contacts are locked already; their
// conversations are taken sorted by id, then their chat sessions, then the consent locks
// (after the contacts, as every consent writer takes them).
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import {
  countContactRows,
  moveContactRows,
  type ContactColumns,
  type ContactMergeParticipant,
  type MergeCounts,
} from '@repo/module-crm';
import { sql } from 'kysely';

import { sourceOfActor } from './consent-proof.js';
import { latestConsentStatus, lockContactConsent } from './consent-state.js';

/** Rows that only name the contact, and move as they are. */
const plainRows = {
  // A trigger link in mail already sent keeps working: its token resolves to the contact kept.
  triggerLinkTokens: { table: 'messaging.trigger_link_tokens', column: 'contact_id' },
  triggerLinkClicks: { table: 'messaging.trigger_link_clicks', column: 'contact_id' },
  campaignTests: { table: 'messaging.email_campaign_tests', column: 'contact_id' },
  // The address is what an unsubscribe link acts on; the contact only says who it was sent to.
  unsubscribeLinks: { table: 'messaging.unsubscribe_links', column: 'contact_id' },
  // A call's number moves with the contact's identity, which keeps its id.
  calls: { table: 'messaging.calls', column: 'contact_id' },
} as const satisfies ContactColumns;

const affected = (result: { numAffectedRows?: bigint }): number =>
  Number(result.numAffectedRows ?? 0n);

/** A conversation as the merge reads it, once locked. */
interface ConversationRow {
  readonly id: string;
  readonly contact_id: string;
  readonly status: string;
  readonly needs_reply: boolean;
  readonly message_seq: string;
  readonly read_through_seq: string;
}

/**
 * Moves the messages of conversation `from` into `into`'s conversation and numbers them all
 * again, so the unread count stays what the two were: every message the team had read in
 * either comes first, then every unread one, each oldest first. Needs-reply reads the last
 * number, so it follows the messages' times too. Gives how many messages moved.
 */
async function combineConversations(
  trx: DatabaseTransaction,
  businessId: string,
  kept: ConversationRow,
  merged: ConversationRow,
): Promise<number> {
  // Numbers are unique in a conversation, so every message steps out of the way first: the
  // kept conversation's above every number either conversation used, and the merged one's
  // above those.
  const step = sql`(${kept.message_seq}::bigint + ${merged.message_seq}::bigint + 1)`;
  const moved = affected(
    await sql`
      update messaging.messages set conversation_id = ${kept.id}, seq = seq + 2 * ${step}
      where business_id = ${businessId} and conversation_id = ${merged.id}
    `.execute(trx),
  );
  await sql`
    update messaging.messages set seq = seq + ${step}
    where business_id = ${businessId} and conversation_id = ${kept.id} and seq < ${step}
  `.execute(trx);
  // Then they take the numbers from 1: the read messages of both, then the unread of both.
  const read = sql`(seq < 2 * ${step} and seq - ${step} <= ${kept.read_through_seq}::bigint
    or seq > 2 * ${step} and seq - 2 * ${step} <= ${merged.read_through_seq}::bigint)`;
  const { rows } = await sql<{ read: string; last: string }>`
    with renumbered as (
      select id, ${read} as read,
        row_number() over (order by ${read} desc, created_at, id) as seq
      from messaging.messages
      where business_id = ${businessId} and conversation_id = ${kept.id}
    ),
    numbered as (
      update messaging.messages m set seq = renumbered.seq
      from renumbered where m.business_id = ${businessId} and m.id = renumbered.id
      returning renumbered.read, renumbered.seq
    )
    select (count(*) filter (where read))::text as read, coalesce(max(seq), 0)::text as last
    from numbered
  `.execute(trx);
  const [numbers] = rows;
  // The kept conversation's assignee, status and star stay; the merged one fills what it
  // lacks, and reopens it when the contact was waiting for a reply there. The unread count
  // and needs-reply are derived by the database from the messages.
  const reopen = merged.status === 'open' && merged.needs_reply;
  await sql`
    update messaging.conversations k set
      message_seq = ${numbers?.last ?? kept.message_seq}::bigint,
      read_through_seq = ${numbers?.read ?? kept.read_through_seq}::bigint,
      last_message_at = greatest(k.last_message_at, m.last_message_at),
      last_inbound_at = greatest(k.last_inbound_at, m.last_inbound_at),
      assignee_user_id = coalesce(k.assignee_user_id, m.assignee_user_id),
      starred_at = coalesce(k.starred_at, m.starred_at),
      status = case when ${reopen} then 'open' else k.status end,
      snoozed_until = case when ${reopen} then null else k.snoozed_until end
    from messaging.conversations m
    where k.business_id = ${businessId} and k.id = ${kept.id}
      and m.business_id = ${businessId} and m.id = ${merged.id}
  `.execute(trx);
  return moved;
}

/**
 * The web chat sessions: the merged contact's moves to the contact kept when it has none,
 * else it ends with its conversation. A session that claimed the merged contact claims the
 * contact kept now, unless it is the kept contact's own.
 */
async function moveChats(
  trx: DatabaseTransaction,
  businessId: string,
  move: { readonly from: string; readonly into: string },
  conversationId: string | undefined,
): Promise<number> {
  const { from, into } = move;
  await sql`
    select id from messaging.webchat_sessions
    where business_id = ${businessId} and (contact_id = any (${sql.val([from, into])}::uuid[])
      or claimed_contact_id = ${from})
    order by id for update
  `.execute(trx);
  const kept = await sql<{ id: string }>`
    select id from messaging.webchat_sessions
    where business_id = ${businessId} and contact_id = ${into}
  `.execute(trx);
  let moved = 0;
  if (kept.rows.length > 0)
    await sql`
      delete from messaging.webchat_sessions
      where business_id = ${businessId} and contact_id = ${from}
    `.execute(trx);
  else
    moved = affected(
      await sql`
        update messaging.webchat_sessions set contact_id = ${into},
          conversation_id = coalesce(${conversationId ?? null}::uuid, conversation_id),
          claimed_contact_id = nullif(claimed_contact_id, ${into})
        where business_id = ${businessId} and contact_id = ${from}
      `.execute(trx),
    );
  await sql`
    update messaging.webchat_sessions
    set claimed_contact_id = case when contact_id = ${into} then null else ${into}::uuid end
    where business_id = ${businessId} and claimed_contact_id = ${from}
  `.execute(trx);
  return moved;
}

/**
 * Consent is a ledger and is never changed: the merged contact's rows are copied onto the
 * contact kept, with their own times and proof and the contact they came from, so the rule
 * of consent-state.ts reads both histories. Then the stricter answer wins: where either
 * contact had withdrawn, and the copies leave the contact kept granted, a withdrawal is
 * added now, so no opt-out is lost by merging.
 */
async function copyConsents(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  move: { readonly from: string; readonly into: string },
): Promise<number> {
  const { from, into } = move;
  for (const contactId of [from, into].sort()) await lockContactConsent(trx, contactId);
  const business = sql`${businessId}::uuid`;
  const status = (contactId: string, channel: string, purpose: string) =>
    latestConsentStatus(business, sql`${contactId}::uuid`, channel, purpose);
  // Each channel and purpose either contact has a history for (at most eight), read as the
  // send check reads them: a withdrawal of an address the contact holds counts too.
  const pairs = await sql<{ channel: string; purpose: string }>`
    select distinct k.channel, k.purpose from messaging.consents k
    where k.business_id = ${businessId} and (k.contact_id = any (${sql.val([from, into])}::uuid[])
      or exists (
        select 1 from crm.contact_identities i
        where i.business_id = k.business_id and i.value_normalized = k.address_normalized
          and i.contact_id = any (${sql.val([from, into])}::uuid[])))
    order by k.channel, k.purpose
  `.execute(trx);
  const withdrawn: { channel: string; purpose: string }[] = [];
  for (const pair of pairs.rows) {
    const { rows } = await sql<{ withdrawn: boolean }>`
      select ${status(from, pair.channel, pair.purpose)} = 'withdrawn'
        or ${status(into, pair.channel, pair.purpose)} = 'withdrawn' as withdrawn
    `.execute(trx);
    if (rows[0]?.withdrawn === true) withdrawn.push(pair);
  }
  const mergedFrom = toPublicId('contact', from);
  const copied = affected(
    await sql`
      insert into messaging.consents
        (business_id, contact_id, channel, purpose, status, address_normalized, source, proof,
         recorded_at, recorded_by_kind, recorded_by_id)
      select business_id, ${into}, channel, purpose, status, address_normalized, source,
        proof || jsonb_build_object('mergedFrom', ${mergedFrom}::text), recorded_at,
        recorded_by_kind, recorded_by_id
      from messaging.consents
      where business_id = ${businessId} and contact_id = ${from}
      order by recorded_at, id
    `.execute(trx),
  );
  const source = sourceOfActor(command.context.actorKind) ?? 'user';
  for (const { channel, purpose } of withdrawn) {
    const { rows } = await sql<{ status: string }>`
      select ${status(into, channel, purpose)} as status
    `.execute(trx);
    if (rows[0]?.status === 'withdrawn') continue;
    await sql`
      insert into messaging.consents
        (business_id, contact_id, channel, purpose, status, source, proof, recorded_at,
         recorded_by_kind, recorded_by_id)
      values (${businessId}, ${into}, ${channel}, ${purpose}, 'withdrawn', ${source},
        jsonb_build_object('mergedFrom', ${mergedFrom}::text), clock_timestamp(),
        ${command.context.actorKind}, ${command.context.actorId ?? null})
    `.execute(trx);
  }
  return copied;
}

// How far along a campaign recipient is: the further one is kept when both contacts were in
// one campaign, so nobody is mailed twice for one person.
const progress = (row: string) => sql`case ${sql.ref(`${row}.status`)}
  when 'sent' then 4 when 'queued' then 3 when 'failed' then 2 when 'skipped' then 1 else 0 end`;

/**
 * Campaign recipients, one row per campaign and contact. The merged contact's rows move
 * where the contact kept is not a recipient. Where both are, the row further along is the
 * contact kept's (taking the merged one's state when that is further), and the merged
 * contact's row is left behind as skipped, contact_removed, so it is never released.
 */
async function moveRecipients(
  trx: DatabaseTransaction,
  businessId: string,
  move: { readonly from: string; readonly into: string },
): Promise<number> {
  const { from, into } = move;
  await sql`
    with taken as (
      update messaging.email_campaign_recipients l
      set status = 'skipped', reason = 'contact_removed', fields = null, message_id = null
      from messaging.email_campaign_recipients k
      where l.business_id = ${businessId} and l.contact_id = ${from}
        and k.business_id = l.business_id and k.campaign_id = l.campaign_id
        and k.contact_id = ${into} and ${progress('l')} > ${progress('k')}
      returning l.campaign_id, old.status, old.reason, old.fields, old.batch, old.message_id,
        old.released_at
    )
    update messaging.email_campaign_recipients k
    set status = taken.status, reason = taken.reason, fields = taken.fields,
      batch = taken.batch, message_id = taken.message_id, released_at = taken.released_at
    from taken
    where k.business_id = ${businessId} and k.campaign_id = taken.campaign_id
      and k.contact_id = ${into}
  `.execute(trx);
  await sql`
    update messaging.email_campaign_recipients l
    set status = 'skipped', reason = 'contact_removed'
    where l.business_id = ${businessId} and l.contact_id = ${from} and l.status = 'pending'
      and exists (
        select 1 from messaging.email_campaign_recipients k
        where k.business_id = l.business_id and k.campaign_id = l.campaign_id
          and k.contact_id = ${into})
  `.execute(trx);
  return affected(
    await sql`
      update messaging.email_campaign_recipients l set contact_id = ${into}
      where l.business_id = ${businessId} and l.contact_id = ${from}
        and not exists (
          select 1 from messaging.email_campaign_recipients k
          where k.business_id = l.business_id and k.campaign_id = l.campaign_id
            and k.contact_id = ${into})
    `.execute(trx),
  );
}

async function mergeMessaging(
  trx: DatabaseTransaction,
  command: CommandContext,
  move: { readonly from: string; readonly into: string },
): Promise<MergeCounts> {
  const businessId = requireBusiness(command.context);
  const { from, into } = move;
  const { rows: conversations } = await sql<ConversationRow>`
    select id, contact_id, status, needs_reply, message_seq::text, read_through_seq::text
    from messaging.conversations
    where business_id = ${businessId} and contact_id = any (${sql.val([from, into])}::uuid[])
    order by id for update
  `.execute(trx);
  const kept = conversations.find((each) => each.contact_id === into);
  const merged = conversations.find((each) => each.contact_id === from);
  // The chat sessions first: one ends with the merged conversation, and its foreign key
  // would take it along.
  const chats = await moveChats(trx, businessId, move, kept?.id);
  let messages = 0;
  if (merged !== undefined && kept !== undefined) {
    messages = await combineConversations(trx, businessId, kept, merged);
    await sql`
      delete from messaging.conversations where business_id = ${businessId} and id = ${merged.id}
    `.execute(trx);
  } else if (merged !== undefined)
    await sql`
      update messaging.conversations set contact_id = ${into}
      where business_id = ${businessId} and id = ${merged.id}
    `.execute(trx);
  return {
    conversations: merged === undefined ? 0 : 1,
    messages,
    webchatSessions: chats,
    consents: await copyConsents(trx, command, businessId, move),
    campaignRecipients: await moveRecipients(trx, businessId, move),
    ...(await moveContactRows(trx, businessId, plainRows, move)),
  };
}

/** Messaging's part in a contact merge, wired by the server into crm's merge. */
export const messagingContactMerge: ContactMergeParticipant = {
  name: 'messaging',
  async lock(trx, command) {
    await sql`
      select id from tenancy.businesses where id = ${requireBusiness(command.context)}
      for no key update
    `.execute(trx);
  },
  async count(trx, invocation, contactIds, atMost) {
    const businessId = requireBusiness(invocation.context);
    const ids = sql.val(contactIds);
    const past = atMost + 1;
    const { rows } = await sql<Record<string, number>>`
      select
        (select count(*)::int from messaging.conversations
          where business_id = ${businessId} and contact_id = any (${ids}::uuid[]))
          as conversations,
        (select count(*)::int from (
          select 1 from messaging.messages m
          join messaging.conversations c on c.business_id = m.business_id
            and c.id = m.conversation_id
          where c.business_id = ${businessId} and c.contact_id = any (${ids}::uuid[])
          limit ${past}) as rows) as messages,
        (select count(*)::int from messaging.webchat_sessions
          where business_id = ${businessId} and contact_id = any (${ids}::uuid[]))
          as "webchatSessions",
        (select count(*)::int from (
          select 1 from messaging.consents
          where business_id = ${businessId} and contact_id = any (${ids}::uuid[])
          limit ${past}) as rows) as consents,
        (select count(*)::int from (
          select 1 from messaging.email_campaign_recipients
          where business_id = ${businessId} and contact_id = any (${ids}::uuid[])
          limit ${past}) as rows) as "campaignRecipients"
    `.execute(trx);
    return {
      ...rows[0],
      ...(await countContactRows(trx, businessId, plainRows, contactIds, atMost)),
    };
  },
  merge: mergeMessaging,
};
