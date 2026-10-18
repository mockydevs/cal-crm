// What a row of the contact list can show beside the contact itself: its last activity, its
// tags, its primary company and what email verification found of its primary address. Each is one read for the whole page, by the page's ids, and
// is made only when the request names it.
//
// Last activity is read, not stored. A contact's timeline already holds one entry for each
// event that concerns it, written in the event's own transaction (run-command.ts), and
// timeline_entries_contact_activity_idx (0057) holds exactly the entries that count, newest
// first for each record. So the newest is one index descent for each row, it is never behind
// a committed event, and no writer has to keep a second copy right.
import {
  conversationChannels,
  type ContactActivityChannel,
  type ContactListExtra,
  type ContactSummary,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { readEmailVerifications } from './email-verification-state.js';

/**
 * The events that are a contact getting in touch. The index's WHERE clause in migration
 * 0057 names the same five: change one only together with the other, in a new migration,
 * or the list reads every entry of a contact's timeline to find its last activity.
 */
export const CONTACT_ACTIVITY_EVENTS = [
  'message.received',
  'form.submitted',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
] as const;

const messageChannels: readonly string[] = conversationChannels;
const isMessageChannel = (value: unknown): value is (typeof conversationChannels)[number] =>
  typeof value === 'string' && messageChannels.includes(value);

/**
 * The channel an activity event came through. A received message names its channel in its
 * payload, except an email, which names the mailbox it arrived in (messaging's inbound.ts).
 * A message on a channel this version has no name for is `other`, so it still counts.
 */
export function activityChannel(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): ContactActivityChannel {
  if (type === 'form.submitted') return 'form';
  if (type.startsWith('appointment.')) return 'appointment';
  if (isMessageChannel(payload['channel'])) return payload['channel'];
  return payload['channel'] === undefined && typeof payload['mailboxId'] === 'string'
    ? 'email'
    : 'other';
}

type Extras = Pick<ContactSummary, 'lastActivity' | 'tags' | 'company' | 'emailVerification'>;

async function lastActivities(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, NonNullable<Extras['lastActivity']>>> {
  // Written out as constants, so the planner can see that the index holds them all.
  const events = sql.join(CONTACT_ACTIVITY_EVENTS.map((type) => sql.lit(type)));
  const { rows } = await sql<{
    contact_id: string;
    occurred_at: Date;
    event_type: string;
    payload: Readonly<Record<string, unknown>>;
  }>`
    select contact.id as contact_id, latest.occurred_at, latest.event_type, e.payload
    from unnest(${[...ids]}::uuid[]) as contact (id)
    cross join lateral (
      select t.occurred_at, t.event_id, t.event_recorded_at, t.event_type
      from crm.timeline_entries t
      where t.business_id = ${businessId} and t.record_id = contact.id
        and t.event_type in (${events})
      order by t.occurred_at desc, t.event_id desc
      limit 1
    ) latest
    join events.events e on e.id = latest.event_id and e.recorded_at = latest.event_recorded_at
  `.execute(trx);
  return new Map(
    rows.map((row) => [
      row.contact_id,
      { at: row.occurred_at.toISOString(), channel: activityChannel(row.event_type, row.payload) },
    ]),
  );
}

async function tagsOf(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, NonNullable<Extras['tags']>>> {
  const rows = await trx
    .selectFrom('crm.record_tags as assigned')
    .innerJoin('crm.tags as tag', (join) =>
      join
        .onRef('tag.business_id', '=', 'assigned.business_id')
        .onRef('tag.id', '=', 'assigned.tag_id'),
    )
    .select(['assigned.record_id', 'tag.id', 'tag.name'])
    .where('assigned.business_id', '=', businessId)
    .where('assigned.record_id', 'in', [...ids])
    .orderBy('tag.name_key')
    .orderBy('tag.id')
    .execute();
  const tags = new Map<string, NonNullable<Extras['tags']>>();
  for (const row of rows) {
    const list = tags.get(row.record_id) ?? [];
    list.push({ id: toPublicId('tag', row.id), name: row.name });
    tags.set(row.record_id, list);
  }
  return tags;
}

/** Each contact's primary company, unless that company is in the trash. */
async function companiesOf(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, NonNullable<Extras['company']>>> {
  const rows = await trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .innerJoin('crm.companies as company', (join) =>
      join
        .onRef('company.business_id', '=', 'link.business_id')
        .onRef('company.id', '=', 'link.to_record_id'),
    )
    .select(['link.from_record_id', 'company.id', 'company.name'])
    .where('link.business_id', '=', businessId)
    .where('link.from_record_id', 'in', [...ids])
    .where('link.is_primary', '=', true)
    .where('type.key', '=', 'contact_company')
    .where('company.deleted_at', 'is', null)
    .execute();
  return new Map(
    rows.map((row) => [row.from_record_id, { id: toPublicId('company', row.id), name: row.name }]),
  );
}

/**
 * Reads what the request named for these contacts, and gives each row's share of it. A row
 * has only the members that were asked for: without any, it is exactly what it was.
 */
export async function readContactExtras(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
  extras: readonly ContactListExtra[],
): Promise<(id: string) => Extras> {
  const wanted = new Set(ids.length === 0 ? [] : extras);
  const activity = wanted.has('lastActivity') ? await lastActivities(trx, businessId, ids) : null;
  const tags = wanted.has('tags') ? await tagsOf(trx, businessId, ids) : null;
  const companies = wanted.has('company') ? await companiesOf(trx, businessId, ids) : null;
  const verifications = wanted.has('emailVerification')
    ? await readEmailVerifications(trx, businessId, ids)
    : null;
  return (id) => ({
    ...(activity === null ? {} : { lastActivity: activity.get(id) ?? null }),
    ...(tags === null ? {} : { tags: tags.get(id) ?? [] }),
    ...(companies === null ? {} : { company: companies.get(id) ?? null }),
    ...(verifications === null ? {} : { emailVerification: verifications.get(id) ?? null }),
  });
}
