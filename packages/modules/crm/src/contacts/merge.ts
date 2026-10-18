// Merging contacts: up to ten become one, as GoHighLevel's Merge Contacts does. The contact
// kept takes the values picked field by field (merge-fields.ts says which by default), every
// row of the others moves to it, and the others go to the trash marked with the contact
// they were merged into, never to be restored. It cannot be undone.
//
// One command, one transaction: crm moves its own rows (merge-core.ts), and each module that
// keeps rows of a contact moves its own through a participant the server hands in, since
// crm can't import the modules that build on it. Anything that fails rolls everything back.
//
// Locks, in the order every writer of a contact takes them: each participant's own locks
// first (automation's run locks come before a contact's row), then every contact's row,
// sorted by id, FOR NO KEY UPDATE (leaving foreign keys to them free), then whatever rows a
// participant changes as it changes them.
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  MAX_CONTACT_IDENTITIES,
  MAX_CONTACT_MERGE_ROWS,
  SCORING_LIMITS,
  mergeContactsCommandInput,
  type ContactMerge,
  type ContactMergeChoiceField,
  type ContactMergePreview,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { sql } from 'kysely';

import { readContact } from './contacts.js';
import { storedDndChannels } from './details.js';
import { countCoreRows, moveCoreRows } from './merge-core.js';
import { combinedScore, oldest, sourceOf, strictestDnd } from './merge-fields.js';

/** Counts of rows, by kind: what a participant moved, or would move. */
export type MergeCounts = Readonly<Record<string, number>>;

/**
 * A module's part in a contact merge. The server hands crm one for each module that keeps
 * rows pointing at a contact, in a fixed order, and the merge calls them inside its one
 * transaction. Contact ids here are database ids (uuids), not public ids.
 *
 * A participant works only in the transaction it is given: no network call, no transaction
 * of its own, no job that acts before the merge commits (command.enqueue is fine: it is
 * written with the merge). It changes only its own module's rows, with set-based statements
 * (an UPDATE or INSERT … SELECT over the contact's rows, never a row at a time in a loop
 * over unbounded data). Throwing anything rolls the whole merge back.
 */
export interface ContactMergeParticipant {
  /** The module, as it names the counts it gives: messaging, automation and so on. */
  readonly name: string;
  /**
   * Takes this module's locks that come before a contact's row in its own writers (as
   * automation's run locks do), for every contact of the merge, the one kept included,
   * sorted by id. Called once, before any contact's row is locked and before anything is
   * checked. Leave it out when the module has none.
   */
  readonly lock?: (
    trx: DatabaseTransaction,
    command: CommandContext,
    contactIds: readonly string[],
  ) => Promise<void>;
  /**
   * How many rows a merge of these contacts (the ones merged away) would move, by kind:
   * shown before a merge, and added up against the limit of rows one merge moves. A count
   * may stop once it passes `atMost`. Called by the preview (outside any command) and by the
   * merge after the contacts are locked. Leave it out when the module's rows are few.
   */
  readonly count?: (
    trx: DatabaseTransaction,
    invocation: Invocation,
    contactIds: readonly string[],
    atMost: number,
  ) => Promise<MergeCounts>;
  /**
   * Moves or combines this module's rows of contact `from` into contact `into`, once for each
   * contact merged away, after crm has moved its own rows and before `from` goes to the
   * trash. Both contacts are locked and live. May emit events and queue jobs through
   * `command`. Gives what it moved, by kind, for the merge's event.
   */
  readonly merge: (
    trx: DatabaseTransaction,
    command: CommandContext,
    move: { readonly from: string; readonly into: string },
  ) => Promise<MergeCounts>;
}

export interface ContactMergeOptions {
  /** Each module's part, in the order they run. */
  readonly participants: readonly ContactMergeParticipant[];
}

/** A contact as a merge reads it, once every contact is locked. */
interface MergeRow {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly born: string | null;
  readonly source: string | null;
  readonly contact_type: string | null;
  readonly timezone: string | null;
  readonly owner_user_id: string | null;
  readonly locale: string | null;
  readonly do_not_contact: boolean;
  readonly dnd_channels: string[];
  readonly dnd_inbound: boolean;
  readonly created_at: Date;
  readonly created_by_kind: string;
  readonly created_by_id: string | null;
  readonly created_source: string;
  readonly last_activity_at: Date | null;
  readonly deleted_at: Date | null;
  readonly merged_into_id: string | null;
  readonly score: number | null;
  readonly revision: string;
}

/** The contact's own columns each field the merge picks is stored in. */
const columnOf = {
  firstName: 'first_name',
  lastName: 'last_name',
  dateOfBirth: 'born',
  source: 'source',
  type: 'contact_type',
  timeZone: 'timezone',
  owner: 'owner_user_id',
} as const satisfies Record<ContactMergeChoiceField, keyof MergeRow>;

const merging = (ids: readonly string[]) => sql.val(ids);

/**
 * The contacts as they are now, and each one's revision: everything a merge reads from them
 * and the person merging was shown (its own fields, addresses, and when its custom fields
 * last changed), so a change made since is caught.
 */
async function readMergeRows(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<MergeRow[]> {
  const { rows } = await sql<MergeRow>`
    select c.id, c.first_name, c.last_name, c.date_of_birth::text as born, c.source,
      c.contact_type, c.timezone, c.owner_user_id, c.locale, c.do_not_contact, c.dnd_channels,
      c.dnd_inbound, c.created_at, c.created_by_kind, c.created_by_id, c.created_source,
      c.last_activity_at, c.deleted_at, c.merged_into_id, s.score,
      encode(sha256(convert_to(jsonb_build_array(
        c.first_name, c.last_name, c.date_of_birth, c.source, c.contact_type, c.timezone,
        c.owner_user_id, c.do_not_contact, c.dnd_channels, c.dnd_inbound, c.updated_at::text,
        (select coalesce(jsonb_agg(jsonb_build_array(i.id, i.value_normalized, i.is_primary,
                  i.label) order by i.id), '[]')
         from crm.contact_identities i
         where i.business_id = c.business_id and i.contact_id = c.id),
        (select coalesce(jsonb_agg(jsonb_build_array(v.field_id, v.updated_at::text)
                  order by v.field_id), '[]')
         from crm.field_values v where v.business_id = c.business_id and v.record_id = c.id)
      )::text, 'UTF8')), 'hex') as revision
    from crm.contacts c
    left join crm.contact_scores s on s.business_id = c.business_id and s.contact_id = c.id
    where c.business_id = ${businessId} and c.id = any (${merging(ids)}::uuid[])
  `.execute(trx);
  return rows;
}

const uuidOf = (id: string): string => {
  const uuid = parsePublicId('contact', id);
  if (uuid === undefined) throw new NotFoundError('Contact', id);
  return uuid;
};

/**
 * Each contact, in the order named, refused when it isn't there (or is another business's),
 * is in the trash, or was merged already.
 */
function requireMergeable(
  rows: readonly MergeRow[],
  ids: readonly [string, ...string[]],
): [MergeRow, ...MergeRow[]] {
  const each = (id: string): MergeRow => {
    const row = rows.find((each) => each.id === id);
    const publicId = toPublicId('contact', id);
    if (row === undefined) throw new NotFoundError('Contact', publicId);
    if (row.merged_into_id !== null)
      throw new NotFoundError('Contact', publicId, {
        mergedInto: toPublicId('contact', row.merged_into_id),
      });
    if (row.deleted_at !== null)
      throw new ConflictError(`Contact ${publicId} is in the trash. Restore it before merging it.`);
    return row;
  };
  const [first, ...rest] = ids;
  return [each(first), ...rest.map(each)];
}

/** What every module would move for the contacts merged away, and how many rows in all. */
async function countRows(
  trx: DatabaseTransaction,
  invocation: Invocation,
  businessId: string,
  losers: readonly string[],
  participants: readonly ContactMergeParticipant[],
): Promise<{ moved: Record<string, MergeCounts>; rows: number }> {
  const moved: Record<string, MergeCounts> = {
    crm: await countCoreRows(trx, businessId, losers, MAX_CONTACT_MERGE_ROWS),
  };
  for (const participant of participants)
    if (participant.count !== undefined)
      moved[participant.name] = await participant.count(
        trx,
        invocation,
        losers,
        MAX_CONTACT_MERGE_ROWS,
      );
  const rows = Object.values(moved)
    .flatMap((counts) => Object.values(counts))
    .reduce((sum, count) => sum + count, 0);
  return { moved, rows };
}

const tooLarge = (rows: number) =>
  new ValidationError([
    {
      path: '/mergeIds',
      code: 'merge_too_large',
      message: `These contacts have ${String(rows)} rows of history between them, more than the ${String(MAX_CONTACT_MERGE_ROWS)} one merge moves. Merge fewer contacts at a time.`,
    },
  ]);

/** What the merge preview shows: each contact's revision, and what would move. */
export async function readContactMergePreview(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  mergeIds: readonly string[],
  options: ContactMergeOptions,
): Promise<ContactMergePreview> {
  const businessId = requireBusiness(invocation.context);
  const ids: [string, ...string[]] = [uuidOf(id), ...mergeIds.map(uuidOf)];
  if (new Set(ids).size !== ids.length)
    throw new ValidationError([
      {
        path: '/mergeIds',
        code: 'merges_itself',
        message: 'The contact kept cannot also be merged away.',
      },
    ]);
  const rows = requireMergeable(await readMergeRows(trx, businessId, ids), ids);
  const { moved, rows: count } = await countRows(
    trx,
    invocation,
    businessId,
    ids.slice(1),
    options.participants,
  );
  return {
    contacts: rows.map((row) => ({ id: toPublicId('contact', row.id), revision: row.revision })),
    moved,
    rows: count,
    maxRows: MAX_CONTACT_MERGE_ROWS,
  };
}

/** The contact's custom fields, by key, and the ones with a value on any of the contacts. */
async function readCustomFields(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<{
  readonly byKey: ReadonlyMap<string, { readonly id: string; readonly valueType: string }>;
  readonly holders: ReadonlyMap<string, Set<string>>;
  readonly types: ReadonlyMap<string, string>;
}> {
  const definitions = await trx
    .selectFrom('crm.field_definitions as field')
    .innerJoin('crm.object_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'field.business_id')
        .onRef('type.id', '=', 'field.object_type_id'),
    )
    .select(['field.id', 'field.key', 'field.value_type'])
    .where('field.business_id', '=', businessId)
    .where('type.kind', '=', 'contact')
    .execute();
  const values = await trx
    .selectFrom('crm.field_values')
    .select(['record_id', 'field_id', 'value_type'])
    .where('business_id', '=', businessId)
    .where('record_id', 'in', ids)
    .execute();
  const holders = new Map<string, Set<string>>();
  const types = new Map<string, string>();
  for (const value of values) {
    holders.set(value.field_id, (holders.get(value.field_id) ?? new Set()).add(value.record_id));
    types.set(value.field_id, value.value_type);
  }
  for (const definition of definitions) types.set(definition.id, definition.value_type);
  return {
    byKey: new Map(
      definitions.map((definition) => [
        definition.key,
        { id: definition.id, valueType: definition.value_type },
      ]),
    ),
    holders,
    types,
  };
}

interface IdentityRow {
  readonly id: string;
  readonly contact_id: string;
  readonly kind: string;
  readonly value_normalized: string;
  readonly is_primary: boolean;
}

/**
 * Which identity of each kind is the contact kept's primary once the merge is done: the
 * address picked, else its own primary, else the first primary of the others in the order
 * named. Refuses a picked address none of the contacts has, and more addresses of a kind
 * than a contact holds.
 */
function planPrimaries(
  identities: readonly IdentityRow[],
  order: readonly string[],
  picked: { readonly email?: string | undefined; readonly phone?: string | undefined },
): string[] {
  const issues: Issue[] = [];
  for (const [kind, path] of [
    ['email', '/primaryEmail'],
    ['phone', '/primaryPhone'],
  ] as const) {
    const value = picked[kind];
    if (
      value !== undefined &&
      !identities.some((each) => each.kind === kind && each.value_normalized === value)
    )
      issues.push({
        path,
        code: 'not_merged',
        message: 'Pick an address one of the contacts has.',
      });
    const count = identities.filter((each) => each.kind === kind).length;
    if (count > MAX_CONTACT_IDENTITIES)
      issues.push({
        path: '/mergeIds',
        code: 'too_many_addresses',
        message: `Together these contacts have ${String(count)} ${kind === 'email' ? 'email addresses' : 'phone numbers'}, and a contact holds at most ${String(MAX_CONTACT_IDENTITIES)}. Remove some first.`,
      });
  }
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  const kinds = [...new Set(identities.map((each) => each.kind))];
  return kinds.flatMap((kind) => {
    const value = kind === 'email' || kind === 'phone' ? picked[kind] : undefined;
    const chosen =
      value === undefined
        ? order
            .map((contactId) =>
              identities.find(
                (each) => each.kind === kind && each.contact_id === contactId && each.is_primary,
              ),
            )
            .find((each) => each !== undefined)
        : identities.find((each) => each.kind === kind && each.value_normalized === value);
    return chosen === undefined ? [] : [chosen.id];
  });
}

/** Adds counts into a total, by kind. */
function addInto(total: Record<string, number>, counts: MergeCounts): void {
  for (const [kind, count] of Object.entries(counts)) total[kind] = (total[kind] ?? 0) + count;
}

/** The contact kept's own fields after the merge, and which of them changed. */
function plannedContact(
  rows: readonly [MergeRow, ...MergeRow[]],
  chosen: Partial<Record<ContactMergeChoiceField, string>>,
): {
  readonly values: Record<(typeof columnOf)[ContactMergeChoiceField], string | null>;
  readonly changed: ContactMergeChoiceField[];
} {
  const [survivor, ...losers] = rows;
  const values = {} as Record<(typeof columnOf)[ContactMergeChoiceField], string | null>;
  const changed: ContactMergeChoiceField[] = [];
  for (const [field, column] of Object.entries(columnOf) as [
    ContactMergeChoiceField,
    (typeof columnOf)[ContactMergeChoiceField],
  ][]) {
    const source = sourceOf({
      survivorId: survivor.id,
      mergeIds: losers.map((row) => row.id),
      holders: new Set(rows.filter((row) => row[column] !== null).map((row) => row.id)),
      chosen: chosen[field] === undefined ? undefined : uuidOf(chosen[field]),
    });
    const value = rows.find((row) => row.id === source)?.[column] ?? null;
    values[column] = value;
    if (value !== survivor[column]) changed.push(field);
  }
  return { values, changed };
}

export function mergeContactsCommand(
  options: ContactMergeOptions,
): Command<typeof mergeContactsCommandInput, ContactMerge> {
  return defineCommand({
    name: 'contact.merge',
    permission: 'contacts.merge',
    input: mergeContactsCommandInput,
    // Identifiers only: the addresses picked as primary stay out of the audit log.
    audit: (input) => ({
      id: input.id,
      mergeIds: input.mergeIds,
      fields: input.fields ?? {},
      customFields: input.customFields ?? {},
      primaryEmailPicked: input.primaryEmail !== undefined,
      primaryPhonePicked: input.primaryPhone !== undefined,
    }),
    async handle(trx, input, command): Promise<ContactMerge> {
      const businessId = requireBusiness(command.context);
      const into = uuidOf(input.id);
      const losers = input.mergeIds.map(uuidOf);
      const all: [string, ...string[]] = [into, ...losers];
      const sorted = [...all].sort();

      for (const participant of options.participants)
        await participant.lock?.(trx, command, sorted);
      // Sorted, then locked in that order (the lock is taken above the sort).
      await sql`
        select id from crm.contacts
        where business_id = ${businessId} and id = any (${merging(sorted)}::uuid[])
        order by id
        for no key update
      `.execute(trx);

      const rows = requireMergeable(await readMergeRows(trx, businessId, all), all);
      for (const row of rows)
        if (input.revisions[toPublicId('contact', row.id)] !== row.revision)
          throw new ConflictError(
            `Contact ${toPublicId('contact', row.id)} changed after you opened the merge. Reload and try again.`,
          );
      const [survivor, ...others] = rows;

      const identities = await trx
        .selectFrom('crm.contact_identities')
        .select(['id', 'contact_id', 'kind', 'value_normalized', 'is_primary'])
        .where('business_id', '=', businessId)
        .where('contact_id', 'in', all)
        .orderBy('id')
        .execute();
      const primaries = planPrimaries(identities, all, {
        email: input.primaryEmail,
        phone: input.primaryPhone,
      });

      const fields = await readCustomFields(trx, businessId, all);
      const unknown = Object.keys(input.customFields ?? {}).filter((key) => !fields.byKey.has(key));
      const [firstUnknown, ...moreUnknown] = unknown.map((key): Issue => ({
        path: `/customFields/${key}`,
        code: 'unknown_field',
        message: 'Contacts have no custom field with this key.',
      }));
      if (firstUnknown !== undefined) throw new ValidationError([firstUnknown, ...moreUnknown]);
      const chosenFields = new Map(
        Object.entries(input.customFields ?? {}).flatMap(([key, contactId]) => {
          const field = fields.byKey.get(key);
          return field === undefined ? [] : [[field.id, uuidOf(contactId)] as const];
        }),
      );
      const fieldSources = new Map<string, string | null>(
        [...new Set([...fields.holders.keys(), ...chosenFields.keys()])].map((fieldId) => [
          fieldId,
          sourceOf({
            survivorId: into,
            mergeIds: losers,
            holders: fields.holders.get(fieldId) ?? new Set(),
            chosen: chosenFields.get(fieldId),
          }),
        ]),
      );
      const isFile = (fieldId: string) => fields.types.get(fieldId) === 'file';

      const { rows: count } = await countRows(
        trx,
        command,
        businessId,
        losers,
        options.participants,
      );
      if (count > MAX_CONTACT_MERGE_ROWS) throw tooLarge(count);

      // crm's own rows, then each module's, one contact merged away at a time.
      const core: Record<string, number> = {};
      const moved: Record<string, Record<string, number>> = { crm: core };
      for (const from of losers) {
        const fileFields = [...fieldSources]
          .filter(([fieldId, source]) => source === from && isFile(fieldId))
          .map(([fieldId]) => fieldId);
        addInto(core, await moveCoreRows(trx, businessId, { from, into }, fileFields));
      }
      for (const participant of options.participants) {
        const total: Record<string, number> = {};
        for (const from of losers)
          addInto(total, await participant.merge(trx, command, { from, into }));
        moved[participant.name] = total;
      }

      await sql`
        update crm.contacts set merged_into_id = ${into}, deleted_at = now()
        where business_id = ${businessId} and id = any (${merging(losers)}::uuid[])
      `.execute(trx);

      // The contact kept: its primary addresses, ...
      if (primaries.length > 0) {
        await sql`
          update crm.contact_identities set is_primary = false
          where business_id = ${businessId} and contact_id = ${into} and is_primary
            and id <> all (${merging(primaries)}::uuid[])
        `.execute(trx);
        await sql`
          update crm.contact_identities set is_primary = true
          where business_id = ${businessId} and id = any (${merging(primaries)}::uuid[])
            and not is_primary
        `.execute(trx);
      }

      // ... its custom fields, each from the contact picked or the default, ...
      const bySource = new Map<string, string[]>();
      const emptied: string[] = [];
      for (const [fieldId, source] of fieldSources) {
        if (source === null || source === into) continue;
        if (fields.holders.get(fieldId)?.has(source) === true)
          bySource.set(source, [...(bySource.get(source) ?? []), fieldId]);
        else emptied.push(fieldId);
      }
      // A unique field's value belongs to one record (0128): the contact merged away gives up
      // the values the contact kept takes, before it takes them.
      await sql`
        delete from crm.field_unique_values
        where business_id = ${businessId}
          and record_id = any (${merging([...bySource.keys()])}::uuid[])
          and field_id = any (${merging([...bySource.values()].flat())}::uuid[])
      `.execute(trx);
      let fieldValues = 0;
      for (const [source, fieldIds] of bySource)
        fieldValues += Number(
          (
            await sql`
              insert into crm.field_values
                (business_id, record_id, field_id, value_type, value_text, value_number,
                 value_date, value_datetime, value_bool, value_options, value_json, source_kind,
                 source_id, source_event_id, confidence, confirmed_by_id, confirmed_at)
              select business_id, ${into}, field_id, value_type, value_text, value_number,
                value_date, value_datetime, value_bool, value_options, value_json, source_kind,
                source_id, source_event_id, confidence, confirmed_by_id, confirmed_at
              from crm.field_values
              where business_id = ${businessId} and record_id = ${source}
                and field_id = any (${merging(fieldIds)}::uuid[])
              on conflict (business_id, record_id, field_id) do update set
                value_type = excluded.value_type, value_text = excluded.value_text,
                value_number = excluded.value_number, value_date = excluded.value_date,
                value_datetime = excluded.value_datetime, value_bool = excluded.value_bool,
                value_options = excluded.value_options, value_json = excluded.value_json,
                source_kind = excluded.source_kind, source_id = excluded.source_id,
                source_event_id = excluded.source_event_id, confidence = excluded.confidence,
                confirmed_by_id = excluded.confirmed_by_id, confirmed_at = excluded.confirmed_at
            `.execute(trx)
          ).numAffectedRows ?? 0n,
        );
      if (emptied.length > 0)
        await sql`
          delete from crm.field_values
          where business_id = ${businessId} and record_id = ${into}
            and field_id = any (${merging(emptied)}::uuid[])
        `.execute(trx);
      // A file of a file field whose value came from another contact no longer fills it.
      const fileFieldsTaken = [...fieldSources]
        .filter(([fieldId, source]) => source !== null && source !== into && isFile(fieldId))
        .map(([fieldId]) => fieldId);
      if (fileFieldsTaken.length > 0)
        await sql`
          update crm.record_files f set field_id = null
          where f.business_id = ${businessId} and f.record_id = ${into}
            and f.field_id = any (${merging(fileFieldsTaken)}::uuid[])
            and not exists (
              select 1 from crm.field_values v
              where v.business_id = f.business_id and v.record_id = f.record_id
                and v.field_id = f.field_id and f.file_id::text = any (v.value_options))
        `.execute(trx);
      addInto(core, { fieldValues });

      // ... its own fields, the strictest do not disturb, and the oldest contact's creation.
      const { values, changed } = plannedContact(rows, input.fields ?? {});
      const dnd = strictestDnd(
        rows.map((row) => ({
          doNotContact: row.do_not_contact,
          channels: row.dnd_channels,
          inbound: row.dnd_inbound,
        })),
      );
      const first = oldest(
        rows.map((row) => ({ ...row, createdAt: row.created_at })) as [
          MergeRow & { readonly createdAt: Date },
          ...(MergeRow & { readonly createdAt: Date })[],
        ],
      );
      const lastActivity = rows
        .map((row) => row.last_activity_at)
        .filter((at): at is Date => at !== null)
        .reduce<Date | null>((latest, at) => (latest === null || at > latest ? at : latest), null);
      await trx
        .updateTable('crm.contacts')
        .set({
          first_name: values.first_name,
          last_name: values.last_name,
          date_of_birth: values.born,
          source: values.source,
          contact_type: values.contact_type,
          timezone: values.timezone,
          owner_user_id: values.owner_user_id,
          locale: survivor.locale ?? others.find((row) => row.locale !== null)?.locale ?? null,
          do_not_contact: dnd.doNotContact,
          dnd_channels: dnd.channels,
          dnd_inbound: dnd.inbound,
          created_at: first.created_at,
          created_by_kind: first.created_by_kind,
          created_by_id: first.created_by_id,
          created_source: first.created_source,
          last_activity_at: lastActivity,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', into)
        .execute();

      // The score: what all of them scored, added up.
      const score = combinedScore(
        rows.map((row) => row.score),
        SCORING_LIMITS.score,
      );
      if (score !== null && score !== survivor.score)
        await sql`
          insert into crm.contact_scores (business_id, contact_id, score)
          values (${businessId}, ${into}, ${score})
          on conflict (business_id, contact_id) do update set score = excluded.score
        `.execute(trx);

      // Of all the touches now on the contact kept, the earliest is its first and the last
      // its latest. Cleared first: each flag is unique per contact, checked row by row.
      await sql`
        update crm.contact_attributions set is_first = false, is_latest = false
        where business_id = ${businessId} and contact_id = ${into} and (is_first or is_latest)
      `.execute(trx);
      await sql`
        update crm.contact_attributions a
        set is_first = a.id = ends.first_id, is_latest = a.id = ends.latest_id
        from (
          select
            (select id from crm.contact_attributions
             where business_id = ${businessId} and contact_id = ${into}
             order by touched_at, id limit 1) as first_id,
            (select id from crm.contact_attributions
             where business_id = ${businessId} and contact_id = ${into}
             order by touched_at desc, id desc limit 1) as latest_id
        ) as ends
        where a.business_id = ${businessId} and a.contact_id = ${into}
          and a.id in (ends.first_id, ends.latest_id)
      `.execute(trx);

      // What the contact kept now shows, told as the commands that change it tell it, so a
      // timeline and an automation see one kind of change however it was made.
      const subject = { kind: 'contact', id: into };
      const standard = changed.filter((field) => field !== 'owner');
      if (standard.length > 0)
        await command.emit({
          type: 'contact.updated',
          subject,
          records: [into],
          payload: { changed: standard },
        });
      if (changed.includes('owner'))
        await command.emit({
          type:
            values.owner_user_id === null ? 'contact.owner_unassigned' : 'contact.owner_assigned',
          subject,
          records: [into],
          payload: values.owner_user_id === null ? {} : { assignedUserId: values.owner_user_id },
        });
      if (dnd.doNotContact && !survivor.do_not_contact)
        await command.emit({ type: 'contact.do_not_contact_set', subject, records: [into] });
      if (dnd.inbound && !survivor.dnd_inbound)
        await command.emit({ type: 'contact.inbound_dnd_set', subject, records: [into] });
      const before = storedDndChannels(survivor.dnd_channels);
      const enabled = dnd.channels.filter((channel) => !before.includes(channel));
      if (enabled.length > 0)
        await command.emit({
          type: 'contact.dnd_changed',
          subject,
          records: [into],
          payload: {
            channels: dnd.channels,
            enabled,
            disabled: [],
            ...(dnd.doNotContact && !survivor.do_not_contact ? { doNotContact: 'set' } : {}),
          },
        });
      await command.emit({
        type: 'contact.merged',
        subject,
        records: all,
        payload: { mergedIds: input.mergeIds, moved },
      });
      // So whatever reacts to a contact going to the trash runs for each one merged away.
      for (const from of losers)
        await command.emit({
          type: 'contact.trashed',
          subject: { kind: 'contact', id: from },
          records: [from],
          payload: { mergedInto: input.id },
        });

      return {
        contact: await readContact(trx, command, input.id),
        mergedIds: input.mergeIds,
        moved,
      };
    },
  });
}
