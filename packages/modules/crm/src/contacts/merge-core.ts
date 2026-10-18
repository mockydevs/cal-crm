// What a contact merge does with crm's own rows of a contact merged away: every statement is
// set-based, inside the merge's transaction, so a failure anywhere leaves nothing half moved.
// The contact's row itself, and the values the contact kept takes from it, are the merge
// command's (merge.ts): this moves what hangs off it.
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/**
 * Every column of crm's that points at a contact and that the core below moves or combines.
 * The completeness test holds the database to this list: a new column that points at a
 * contact fails it until a merge says what becomes of it.
 */
export const crmMergeColumns = [
  'crm.contact_identities.contact_id',
  'crm.field_values.record_id',
  'crm.record_tags.record_id',
  'crm.record_links.from_record_id',
  'crm.record_links.to_record_id',
  'crm.notes.record_id',
  'crm.tasks.record_id',
  'crm.task_series.record_id',
  'crm.timeline_entries.record_id',
  'crm.contact_followers.contact_id',
  'crm.contact_attributions.contact_id',
  'crm.record_files.record_id',
  'crm.contact_scores.contact_id',
  'crm.score_changes.contact_id',
] as const;

const affected = (result: { numAffectedRows?: bigint }): number =>
  Number(result.numAffectedRows ?? 0n);

/** What the core moved of one contact, by kind of row. */
export type CoreCounts = Record<string, number>;

/**
 * Moves the rows of contact `from` to contact `into`, both of the business, both locked.
 * `fileFields` are the file fields whose value the contact kept takes from `from`: its files
 * in those fields keep filling them, and its files in any other field become plain files of
 * the record.
 */
export async function moveCoreRows(
  trx: DatabaseTransaction,
  businessId: string,
  move: { readonly from: string; readonly into: string },
  fileFields: readonly string[],
): Promise<CoreCounts> {
  const { from, into } = move;
  // Email addresses, phone numbers and the rest: each is unique in the business, so they
  // move without clashing. They arrive as secondary (merge.ts names the primaries), and a
  // phone label the contact kept already uses is dropped, as one label names one number.
  await sql`
    update crm.contact_identities m set label = null
    where m.business_id = ${businessId} and m.contact_id = ${from} and m.label is not null
      and exists (
        select 1 from crm.contact_identities k
        where k.business_id = m.business_id and k.contact_id = ${into} and k.label = m.label)
  `.execute(trx);
  const identities = affected(
    await sql`
      update crm.contact_identities set contact_id = ${into}, is_primary = false
      where business_id = ${businessId} and contact_id = ${from}
    `.execute(trx),
  );

  // Tags: the contact kept gets every tag either had, once.
  const tags = affected(
    await sql`
      insert into crm.record_tags
        (business_id, record_id, tag_id, source_kind, source_id, source_event_id, created_at)
      select business_id, ${into}, tag_id, source_kind, source_id, source_event_id, created_at
      from crm.record_tags where business_id = ${businessId} and record_id = ${from}
      on conflict do nothing
    `.execute(trx),
  );
  await sql`delete from crm.record_tags where business_id = ${businessId} and record_id = ${from}`.execute(
    trx,
  );

  const links = await moveLinks(trx, businessId, from, into);

  const notes = affected(
    await sql`update crm.notes set record_id = ${into}
      where business_id = ${businessId} and record_id = ${from}`.execute(trx),
  );
  // A series before its tasks: the worker making a series' next task holds the series' row,
  // not the contact's, while it writes the task, so waiting for the series here means its
  // task is there to move next.
  const taskSeries = affected(
    await sql`update crm.task_series set record_id = ${into}
      where business_id = ${businessId} and record_id = ${from}`.execute(trx),
  );
  const tasks = affected(
    await sql`update crm.tasks set record_id = ${into}
      where business_id = ${businessId} and record_id = ${from}`.execute(trx),
  );

  // The timeline can't be changed, only added to: the contact kept gets a copy of each
  // entry, and the merged contact's own go when it is purged.
  const timeline = affected(
    await sql`
      insert into crm.timeline_entries
        (business_id, record_id, occurred_at, event_id, event_recorded_at, event_type)
      select business_id, ${into}, occurred_at, event_id, event_recorded_at, event_type
      from crm.timeline_entries where business_id = ${businessId} and record_id = ${from}
      on conflict do nothing
    `.execute(trx),
  );

  const followers = affected(
    await sql`
      insert into crm.contact_followers
        (business_id, contact_id, user_id, added_by_kind, added_by_id, created_at)
      select business_id, ${into}, user_id, added_by_kind, added_by_id, created_at
      from crm.contact_followers where business_id = ${businessId} and contact_id = ${from}
      on conflict do nothing
    `.execute(trx),
  );
  await sql`delete from crm.contact_followers
    where business_id = ${businessId} and contact_id = ${from}`.execute(trx);

  // Touches move as they are; which is first and which latest is worked out again over all
  // of them once every contact has moved (merge.ts).
  const attributions = affected(
    await sql`
      update crm.contact_attributions set contact_id = ${into}, is_first = false, is_latest = false
      where business_id = ${businessId} and contact_id = ${from}
    `.execute(trx),
  );

  const files = affected(
    await sql`
      update crm.record_files
      set record_id = ${into},
          field_id = case when field_id = any (${sql.val(fileFields)}::uuid[]) then field_id end
      where business_id = ${businessId} and record_id = ${from}
    `.execute(trx),
  );

  // The score's history is a ledger, copied as the timeline is; the score itself is added up
  // once every contact has moved (merge.ts). A change keyed as one the contact kept already
  // has (the same rule on the same event) was counted there.
  const scoreChanges = affected(
    await sql`
      insert into crm.score_changes
        (business_id, contact_id, source, source_key, rule_id, change, actor_kind, actor_id,
         recorded_at)
      select business_id, ${into}, source, source_key, rule_id, change, actor_kind, actor_id,
             recorded_at
      from crm.score_changes where business_id = ${businessId} and contact_id = ${from}
      on conflict do nothing
    `.execute(trx),
  );

  return {
    identities,
    tags,
    links,
    notes,
    tasks,
    taskSeries,
    timeline,
    followers,
    attributions,
    files,
    scoreChanges,
  };
}

/**
 * Links of the merged contact, both ways, re-pointed to the contact kept. A link that would
 * join the contact kept to itself, or repeat one it already has, is dropped. Two records are
 * linked once under a type whichever of them is "from", so a link the contact kept has the
 * other way round is a repeat too. Where both had
 * a primary link of a kind from the same record (a deal's primary contact, a contact's
 * primary company), the contact kept's stays the primary.
 */
async function moveLinks(
  trx: DatabaseTransaction,
  businessId: string,
  from: string,
  into: string,
): Promise<number> {
  // From the merged contact (its companies, say): a moved link stays primary only where the
  // contact kept has no primary link of that kind.
  const outgoing = affected(
    await sql`
      update crm.record_links m
      set from_record_id = ${into},
          is_primary = m.is_primary and not exists (
            select 1 from crm.record_links k
            where k.business_id = m.business_id and k.from_record_id = ${into}
              and k.link_type_id = m.link_type_id and k.is_primary)
      where m.business_id = ${businessId} and m.from_record_id = ${from}
        and m.to_record_id <> ${into}
        and not exists (
          select 1 from crm.record_links k
          where k.business_id = m.business_id and k.link_type_id = m.link_type_id
            and ((k.from_record_id = ${into} and k.to_record_id = m.to_record_id)
              or (k.from_record_id = m.to_record_id and k.to_record_id = ${into})))
    `.execute(trx),
  );
  // Left behind are the links the contact kept repeats. Where one was primary and the
  // contact kept has no primary of that kind, its own link to that record takes its place.
  await sql`
    update crm.record_links k set is_primary = true
    where k.business_id = ${businessId} and k.from_record_id = ${into} and not k.is_primary
      and exists (
        select 1 from crm.record_links m
        where m.business_id = k.business_id and m.from_record_id = ${from}
          and m.link_type_id = k.link_type_id and m.to_record_id = k.to_record_id
          and m.is_primary)
      and not exists (
        select 1 from crm.record_links p
        where p.business_id = k.business_id and p.from_record_id = ${into}
          and p.link_type_id = k.link_type_id and p.is_primary)
  `.execute(trx);
  await sql`delete from crm.record_links
    where business_id = ${businessId} and from_record_id = ${from}`.execute(trx);

  // To the merged contact (a deal's contacts, say). Where the record already links to the
  // contact kept, the merged contact's link goes; if it was that record's primary, the
  // contact kept's link takes its place.
  const repeated = await sql<{
    from_record_id: string;
    link_type_id: string;
    is_primary: boolean;
  }>`
    delete from crm.record_links m
    where m.business_id = ${businessId} and m.to_record_id = ${from}
      and (m.from_record_id = ${into} or exists (
        select 1 from crm.record_links k
        where k.business_id = m.business_id and k.link_type_id = m.link_type_id
          and ((k.from_record_id = m.from_record_id and k.to_record_id = ${into})
            or (k.from_record_id = ${into} and k.to_record_id = m.from_record_id))))
    returning m.from_record_id, m.link_type_id, m.is_primary
  `.execute(trx);
  for (const row of repeated.rows.filter((each) => each.is_primary))
    await sql`
      update crm.record_links set is_primary = true
      where business_id = ${businessId} and from_record_id = ${row.from_record_id}
        and link_type_id = ${row.link_type_id} and to_record_id = ${into}
    `.execute(trx);
  const incoming = affected(
    await sql`update crm.record_links set to_record_id = ${into}
      where business_id = ${businessId} and to_record_id = ${from}`.execute(trx),
  );
  return outgoing + incoming;
}

/**
 * How many rows the core would move for these contacts, by kind, each count stopped just
 * past `atMost` so a contact with a huge history is not counted to the end.
 */
export async function countCoreRows(
  trx: DatabaseTransaction,
  businessId: string,
  contactIds: readonly string[],
  atMost: number,
): Promise<CoreCounts> {
  const ids = sql.val(contactIds);
  const past = atMost + 1;
  const count = (table: string, column: string) =>
    sql<number>`(select count(*)::int from (
      select 1 from ${sql.table(table)}
      where business_id = ${businessId} and ${sql.ref(column)} = any (${ids}::uuid[])
      limit ${past}) as rows)`;
  const { rows } = await sql<Record<string, number>>`
    select
      ${count('crm.contact_identities', 'contact_id')} as identities,
      ${count('crm.record_tags', 'record_id')} as tags,
      ${count('crm.record_links', 'from_record_id')} + ${count('crm.record_links', 'to_record_id')}
        as links,
      ${count('crm.notes', 'record_id')} as notes,
      ${count('crm.tasks', 'record_id')} as tasks,
      ${count('crm.task_series', 'record_id')} as "taskSeries",
      ${count('crm.timeline_entries', 'record_id')} as timeline,
      ${count('crm.contact_followers', 'contact_id')} as followers,
      ${count('crm.contact_attributions', 'contact_id')} as attributions,
      ${count('crm.record_files', 'record_id')} as files,
      ${count('crm.score_changes', 'contact_id')} as "scoreChanges",
      ${count('crm.field_values', 'record_id')} as "fieldValues"
  `.execute(trx);
  return rows[0] ?? {};
}
