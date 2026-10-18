// The duplicate finder: GoHighLevel's duplicate lookup, Contacts → Manage Duplicates (find
// by email, phone or name; reject a group) and a contact's "Possible duplicates".
// https://help.gohighlevel.com/support/solutions/articles/48001202210
//
// Two contacts never hold the same email address or phone number, so a lookup finds one
// contact at most, and the groups are of near duplicates: contacts whose addresses share a
// match key (crm.contact_identities.match_key, kept by the database), or whose names are
// alike and who share a second sign. Groups are worked out when asked, a page at a time, in
// the request's business under row-level security; only live contacts are in them. A group
// someone rejected stays hidden while every contact in it was rejected together.
import { defineCommand, defineTask, requireBusiness, type Invocation } from '@repo/commands';
import {
  DEFAULT_DUPLICATE_GROUP_PAGE,
  MAX_DUPLICATE_GROUP_CONTACTS,
  rejectDuplicateGroupInput,
  type DuplicateContact,
  type DuplicateFindMode,
  type DuplicateGroup,
  type DuplicateGroupList,
  type DuplicateLookup,
  type DuplicateMatchField,
  type DuplicateReason,
  type ListDuplicateGroupsQuery,
  type PossibleDuplicates,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { countryOf } from './country.js';
import {
  decodeGroupCursor,
  encodeGroupCursor,
  isRejected,
  isWeakGroup,
  nameGroupsOf,
  nameKeyOf,
  type NamePair,
} from './duplicate-keys.js';
import { matchFields, readMatchSettings } from './duplicate-settings.js';
import { normalizePhone } from './phones.js';

/**
 * How many contacts a name page compares at a time, and how many slices one request reads.
 * One slice of 200 in a business of 100,000 contacts takes about one second with varied
 * names and about three with thousands of namesakes (measured on 2026-10-18), so a request
 * reads one and the page offers to compare more.
 */
const NAME_SLICE = 200;
const NAME_SLICES = 1;

interface ContactRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly created_at: Date;
  readonly deleted_at: Date | null;
  readonly emails: string[];
  readonly phones: string[];
}

/** Contacts as a group shows them, by id, with their addresses primary first. */
async function readContacts(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ContactRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<ContactRow>`
    select c.id, c.display_name, c.created_at, c.deleted_at,
      coalesce(array_agg(i.value_normalized order by i.is_primary desc, i.created_at, i.id)
        filter (where i.kind = 'email'), '{}') as emails,
      coalesce(array_agg(i.value_normalized order by i.is_primary desc, i.created_at, i.id)
        filter (where i.kind = 'phone'), '{}') as phones
    from crm.contacts c
    left join crm.contact_identities i
      on i.business_id = c.business_id and i.contact_id = c.id and i.kind in ('email', 'phone')
    where c.business_id = ${businessId} and c.id = any(${[...ids]}::uuid[])
    group by c.business_id, c.id`.execute(trx);
  return new Map(rows.map((row) => [row.id, row]));
}

const shownContact = (row: ContactRow): DuplicateContact => ({
  id: toPublicId('contact', row.id),
  name: row.display_name,
  emails: row.emails,
  phones: row.phones,
  createdAt: row.created_at.toISOString(),
});

/** A group as the API shows it, from the ids that share its sign (oldest first). */
function shownGroup(
  contacts: ReadonlyMap<string, ContactRow>,
  group: {
    readonly by: DuplicateFindMode;
    readonly valueKey: string;
    readonly ids: readonly string[];
    readonly reasons: readonly DuplicateReason[];
  },
): DuplicateGroup {
  const listed = group.ids
    .slice(0, MAX_DUPLICATE_GROUP_CONTACTS)
    .flatMap((id) => contacts.get(id) ?? []);
  return {
    by: group.by,
    valueKey: group.valueKey,
    reasons: [...group.reasons],
    weak: isWeakGroup(
      group.by,
      group.valueKey,
      listed.map((row) => row.display_name),
    ),
    total: group.ids.length,
    contacts: listed.map(shownContact),
  };
}

/** The contact ids each rejection of this kind names, among those that name any of these. */
async function rejectionsAmong(
  trx: DatabaseTransaction,
  businessId: string,
  kind: DuplicateFindMode,
  ids: readonly string[],
): Promise<readonly (readonly string[])[]> {
  if (ids.length === 0) return [];
  const { rows } = await sql<{ contact_ids: string[] }>`
    select contact_ids from crm.duplicate_rejections
    where business_id = ${businessId} and kind = ${kind}
      and contact_ids && ${[...new Set(ids)]}::uuid[]`.execute(trx);
  return rows.map((row) => row.contact_ids);
}

interface KeyGroup {
  readonly key: string;
  /** Every live contact that shares the key, oldest first. */
  readonly ids: string[];
}

/**
 * Groups of live contacts that share an email or phone match key, after `after`, in key
 * order. A group rejected with this key is left out while it holds no one else. The keys of
 * the kind after `after` are grouped and sorted whole, then the page is cut from them: on
 * 100,000 addresses that is about a tenth of a second.
 */
async function keyGroups(
  trx: DatabaseTransaction,
  businessId: string,
  kind: DuplicateMatchField,
  after: string | undefined,
  limit: number,
): Promise<KeyGroup[]> {
  const { rows } = await sql<KeyGroup>`
    select k.key, k.ids
    from (
      select i.match_key as key, array_agg(distinct i.contact_id) as ids
      from crm.contact_identities i
      join crm.contacts c on c.business_id = i.business_id and c.id = i.contact_id
      where i.business_id = ${businessId} and i.kind = ${kind} and i.match_key is not null
        and c.deleted_at is null
        and (${after ?? null}::text is null or i.match_key > ${after ?? null}::text)
      group by i.match_key
      having count(distinct i.contact_id) > 1
    ) as k
    where not exists (
      select 1 from crm.duplicate_rejections r
      where r.business_id = ${businessId} and r.kind = ${kind} and r.value_key = k.key
        and k.ids <@ r.contact_ids)
    order by k.key
    limit ${limit}`.execute(trx);
  return rows;
}

/**
 * Pairs of live contacts whose names are alike and that share a second sign, for these
 * contacts, at most `perContact` pairs each (private.similar_contact_names). The trigram
 * index is used at the transaction's threshold, so 0.6 is set first, for this transaction.
 */
async function similarNames(
  trx: DatabaseTransaction,
  ids: readonly string[],
  laterOnly: boolean,
  perContact: number = MAX_DUPLICATE_GROUP_CONTACTS,
): Promise<NamePair[]> {
  if (ids.length === 0) return [];
  await sql`select set_config('pg_trgm.similarity_threshold', '0.6', true)`.execute(trx);
  const { rows } = await sql<{
    a: string;
    o: string;
    company: boolean;
    email_name: boolean;
    phone: boolean;
  }>`
    select contact_id as a, similar_id as o, company, email_name, phone
    from private.similar_contact_names(
      ${[...ids]}::uuid[], ${laterOnly}, ${perContact}::integer)`.execute(trx);
  return rows.map((row) => ({
    a: row.a,
    o: row.o,
    company: row.company,
    emailName: row.email_name,
    phone: row.phone,
  }));
}

/** A page of name groups, compared a slice of contacts at a time (NAME_SLICE, NAME_SLICES). */
async function nameGroupPage(
  trx: DatabaseTransaction,
  businessId: string,
  after: string | undefined,
  limit: number,
): Promise<DuplicateGroupList> {
  const found: {
    anchor: string;
    name: string;
    ids: readonly string[];
    reasons: readonly DuplicateReason[];
  }[] = [];
  let from = after;
  for (let slice = 0; slice < NAME_SLICES; slice++) {
    const anchors = await trx
      .selectFrom('crm.contacts')
      .select(['id', 'display_name'])
      .where('business_id', '=', businessId)
      .where('deleted_at', 'is', null)
      .where('display_name', 'is not', null)
      .$if(from !== undefined, (query) => query.where('id', '>', from ?? ''))
      .orderBy('id')
      .limit(NAME_SLICE)
      .execute();
    const names = new Map(anchors.map((row) => [row.id, row.display_name ?? '']));
    const groups = nameGroupsOf(await similarNames(trx, [...names.keys()], true));
    const rejected = await rejectionsAmong(
      trx,
      businessId,
      'name',
      groups.flatMap((group) => group.ids),
    );
    for (const group of groups) {
      if (isRejected(group.ids, rejected)) continue;
      found.push({ ...group, name: names.get(group.anchor) ?? '' });
      if (found.length === limit) break;
    }
    const last = anchors.at(-1)?.id;
    // A full page ends at its last group's first contact; the ones after it are read again.
    if (found.length === limit) {
      from = found.at(-1)?.anchor;
      break;
    }
    if (last === undefined || anchors.length < NAME_SLICE) {
      from = undefined;
      break;
    }
    from = last;
  }
  const contacts = await readContacts(
    trx,
    businessId,
    found.flatMap((group) => group.ids.slice(0, MAX_DUPLICATE_GROUP_CONTACTS)),
  );
  return {
    items: found.map((group) =>
      shownGroup(contacts, {
        by: 'name',
        valueKey: nameKeyOf(group.name),
        ids: group.ids,
        reasons: group.reasons,
      }),
    ),
    next: from === undefined ? null : encodeGroupCursor('name', from),
  };
}

/** Contacts → Manage Duplicates: a page of groups found by email, phone or name. */
export async function readDuplicateGroups(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListDuplicateGroupsQuery,
): Promise<DuplicateGroupList> {
  const businessId = requireBusiness(invocation.context);
  const limit = query.limit ?? DEFAULT_DUPLICATE_GROUP_PAGE;
  const after = decodeGroupCursor(query.by, query.cursor);
  if (query.by === 'name') return nameGroupPage(trx, businessId, after, limit);
  const kind = query.by;
  const groups = await keyGroups(trx, businessId, kind, after, limit + 1);
  const page = groups.slice(0, limit);
  const contacts = await readContacts(
    trx,
    businessId,
    page.flatMap((group) => group.ids.slice(0, MAX_DUPLICATE_GROUP_CONTACTS)),
  );
  const last = page.at(-1);
  return {
    items: page.map((group) =>
      shownGroup(contacts, { by: kind, valueKey: group.key, ids: group.ids, reasons: [kind] }),
    ),
    next: groups.length > limit && last !== undefined ? encodeGroupCursor(kind, last.key) : null,
  };
}

/**
 * The contacts that may be this one, as groups that each hold it: one for each of its
 * email and phone match keys that live contacts share, and one of the contacts whose names
 * are alike and who share a second sign with it. None for a contact in the trash.
 */
export async function readPossibleDuplicates(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<PossibleDuplicates> {
  const businessId = requireBusiness(invocation.context);
  const contactId = parsePublicId('contact', id);
  const self =
    contactId === undefined
      ? undefined
      : (await readContacts(trx, businessId, [contactId])).get(contactId);
  if (contactId === undefined || self === undefined) throw new NotFoundError('Contact', id);
  if (self.deleted_at !== null) return { groups: [], count: 0 };

  const { rows: keyed } = await sql<{ kind: DuplicateMatchField; key: string; ids: string[] }>`
    select x.kind, x.match_key as key, array_agg(distinct o.contact_id) as ids
    from crm.contact_identities x
    join crm.contact_identities o
      on o.business_id = x.business_id and o.kind = x.kind and o.match_key = x.match_key
        and o.contact_id <> x.contact_id
    join crm.contacts c on c.business_id = o.business_id and c.id = o.contact_id
    where x.business_id = ${businessId} and x.contact_id = ${contactId}
      and x.kind in ('email', 'phone') and x.match_key is not null
      and c.deleted_at is null
    group by x.kind, x.match_key
    order by x.kind, x.match_key`.execute(trx);
  const keyGroupsOfSelf = await Promise.all(
    keyed.map(async (group) => {
      const ids = [contactId, ...group.ids].sort();
      const { rows } = await sql<{ contact_ids: string[] }>`
        select contact_ids from crm.duplicate_rejections
        where business_id = ${businessId} and kind = ${group.kind} and value_key = ${group.key}`.execute(
        trx,
      );
      return isRejected(
        ids,
        rows.map((row) => row.contact_ids),
      )
        ? []
        : [{ by: group.kind, valueKey: group.key, ids, reasons: [group.kind] }];
    }),
  );

  // Every contact named alike, earlier ones too, put with this one as their first.
  const nameGroup = nameGroupsOf(await similarNames(trx, [contactId], false)).map((group) => ({
    by: 'name' as const,
    valueKey: nameKeyOf(self.display_name ?? ''),
    ids: [...group.ids].sort(),
    reasons: group.reasons,
  }));
  const nameRejections = await rejectionsAmong(
    trx,
    businessId,
    'name',
    nameGroup.flatMap((group) => group.ids),
  );
  const groups = [
    ...keyGroupsOfSelf.flat(),
    ...nameGroup.filter((group) => !isRejected(group.ids, nameRejections)),
  ];
  const contacts = await readContacts(
    trx,
    businessId,
    groups.flatMap((group) => group.ids.slice(0, MAX_DUPLICATE_GROUP_CONTACTS)),
  );
  return {
    groups: groups.map((group) => shownGroup(contacts, group)),
    count: new Set(groups.flatMap((group) => group.ids).filter((each) => each !== contactId)).size,
  };
}

/**
 * GoHighLevel's duplicate lookup: the contact that holds the email address or the phone
 * number, in the trash too, found in the business's order (matchFields).
 */
export async function findDuplicateContact(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: { readonly email?: string | undefined; readonly phone?: string | undefined },
): Promise<DuplicateLookup> {
  const businessId = requireBusiness(invocation.context);
  let phone: string | undefined;
  if (query.phone !== undefined) {
    const normalized = normalizePhone(query.phone, await countryOf(trx, businessId));
    if (typeof normalized !== 'string')
      throw new ValidationError([
        { path: '/phone', code: normalized.code, message: normalized.message },
      ]);
    phone = normalized;
  }
  const values: Readonly<Record<DuplicateMatchField, string | undefined>> = {
    email: query.email,
    phone,
  };
  const order = matchFields(await readMatchSettings(trx, businessId), {
    email: values.email !== undefined,
    phone: values.phone !== undefined,
  });
  for (const kind of order) {
    const value = values[kind];
    if (value === undefined) continue;
    const holder = await trx
      .selectFrom('crm.contact_identities')
      .select('contact_id')
      .where('business_id', '=', businessId)
      .where('kind', '=', kind)
      .where('value_normalized', '=', value)
      .executeTakeFirst();
    const row =
      holder === undefined
        ? undefined
        : (await readContacts(trx, businessId, [holder.contact_id])).get(holder.contact_id);
    if (row !== undefined)
      return {
        contact: { ...shownContact(row), trashedAt: row.deleted_at?.toISOString() ?? null },
        matchedBy: kind,
      };
  }
  return { contact: null, matchedBy: null };
}

/** The most contacts one rejection keeps (duplicate_rejections_contacts_count). */
const MAX_REJECTED = 1000;

/**
 * Everyone in the group a rejection names, not only the contacts it was shown with: a group
 * lists 25, and one hidden only while every member was rejected would otherwise come back.
 * By email or phone, every live contact that shares the key; by name, the first contact's
 * backed look-alikes. The contacts named are kept too, whatever the group holds now.
 */
async function wholeGroup(
  trx: DatabaseTransaction,
  businessId: string,
  by: DuplicateFindMode,
  valueKey: string,
  named: readonly string[],
): Promise<string[]> {
  let members: readonly string[];
  if (by === 'name') {
    const first = [...named].sort()[0];
    const pairs = first === undefined ? [] : await similarNames(trx, [first], true, MAX_REJECTED);
    members = pairs.map((pair) => pair.o);
  } else {
    const { rows } = await sql<{ id: string }>`
      select distinct i.contact_id as id
      from crm.contact_identities i
      join crm.contacts c on c.business_id = i.business_id and c.id = i.contact_id
      where i.business_id = ${businessId} and i.kind = ${by} and i.match_key = ${valueKey}
        and c.deleted_at is null
      limit ${MAX_REJECTED + 1}`.execute(trx);
    members = rows.map((row) => row.id);
  }
  const all = [...new Set([...named, ...members])];
  if (all.length > MAX_REJECTED)
    throw new ConflictError(
      `This group holds more than ${String(MAX_REJECTED)} contacts, too many to reject at once.`,
    );
  return all;
}

/**
 * Manage Duplicates' Reject: these contacts are not one person, by this sign. Kept for good,
 * as GoHighLevel's is ("cannot be undone"); the same rejection twice is kept once. The key
 * may be an email address or a phone number, so the audit log keeps only the mode and the
 * contacts.
 */
export const rejectDuplicateGroupCommand = defineCommand({
  name: 'contact_duplicates.reject',
  permission: 'contacts.merge',
  input: rejectDuplicateGroupInput,
  audit: (input) => ({ by: input.by, contactIds: input.contactIds }),
  async handle(trx, input, command): Promise<void> {
    const businessId = requireBusiness(command.context);
    const ids = input.contactIds.map((each) => {
      const uuid = parsePublicId('contact', each);
      if (uuid === undefined) throw new NotFoundError('Contact', each);
      return { id: each, uuid };
    });
    const found = new Set(
      (
        await trx
          .selectFrom('crm.contacts')
          .select('id')
          .where('business_id', '=', businessId)
          .where(
            'id',
            'in',
            ids.map((each) => each.uuid),
          )
          .execute()
      ).map((row) => row.id),
    );
    const missing = ids.find((each) => !found.has(each.uuid));
    if (missing !== undefined) throw new NotFoundError('Contact', missing.id);
    const valueKey =
      input.by === 'name' ? nameKeyOf(input.valueKey) : input.valueKey.trim().toLowerCase();
    if (valueKey.length === 0)
      throw new ValidationError([
        { path: '/valueKey', code: 'blank', message: 'Send the group’s key as it was shown.' },
      ]);
    const members = await wholeGroup(
      trx,
      businessId,
      input.by,
      valueKey,
      ids.map((each) => each.uuid),
    );
    await sql`
      insert into crm.duplicate_rejections
        (business_id, kind, value_key, contact_ids, rejected_by_kind, rejected_by_id)
      values (${businessId}, ${input.by}, ${valueKey},
              private.sorted_uuids(${members}::uuid[]),
              ${command.context.actorKind}, ${command.context.actorId ?? null})
      on conflict (business_id, kind, value_key, contact_ids) do nothing`.execute(trx);
    await command.emit({
      type: 'contact_duplicates.rejected',
      subject: { kind: 'business', id: businessId },
      payload: { by: input.by, contactIds: input.contactIds },
    });
  },
});

/** How many addresses one transaction of the fill reads. */
export const MATCH_KEY_BATCH = 1000;

/**
 * Gives the addresses a business stored before match keys existed their keys, a batch at a
 * time, each in a transaction of its own, so no row waits long on another. The migration
 * that added the keys queues it once per business; a run that stops part way is run again
 * and starts over, skipping what has a key. New addresses get theirs as they are written.
 */
export const fillMatchKeysTask = defineTask({
  name: 'contacts.fill_match_keys',
  data: z.strictObject({}),
  async run(_data, { invocation, services }) {
    let after: string | null = null;
    for (;;) {
      const from: string | null = after;
      const batch: readonly string[] = await withTenant(
        services.db,
        invocation.context,
        async (trx) => {
          const { rows } = await sql<{ id: string }>`
          select id from crm.contact_identities
          where business_id = app.business_id() and (${from}::uuid is null or id > ${from}::uuid)
          order by id
          limit ${MATCH_KEY_BATCH}`.execute(trx);
          const ids = rows.map((row) => row.id);
          if (ids.length > 0)
            await sql`
            update crm.contact_identities
            set match_key = private.contact_match_key(kind, value_normalized)
            where business_id = app.business_id() and id = any(${ids}::uuid[])
              and kind in ('email', 'phone') and match_key is null`.execute(trx);
          return ids;
        },
      );
      after = batch.at(-1) ?? null;
      if (batch.length < MATCH_KEY_BATCH) return;
    }
  },
});
