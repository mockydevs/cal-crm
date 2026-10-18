// A record's audit log: the commands that changed it, read from audit.commands. A command's
// audit row and its events are written in one transaction, so they carry the same
// recorded_at, and the row lists the ids of its events: a record's timeline
// (crm.timeline_entries) therefore finds the rows of the commands that changed it with one
// index range of each table, and nothing has to be stored twice.
//
// What an entry shows is decided here and nowhere else:
// - only rows of the reader's own business, never the agency's own rows, which row-level
//   security lets a business read;
// - never the address or the browser a command came from;
// - of the command's input, only the fields `shownInput` lists for that command;
// - of the command's events, only those on this record's timeline.
import {
  AUDIT_PAGE_SIZE,
  auditActionOf,
  auditActionVerbs,
  auditModuleOf,
  auditModules,
  auditOutcomes,
  recordKinds,
  type AuditEntry,
  type AuditListEntry,
  type AuditLog,
  type AuditPage,
  type ListAuditQuery,
  type RecordKind,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  actorKinds,
  isUuidV7,
  parsePublicId,
  publicIdPrefixes,
  toPublicId,
  ValidationError,
  type PublicIdKind,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';

import { recordNames } from '../tasks/tasks.js';
import { namesOf, type ActorNames } from './activity.js';

/**
 * The fields of a command's kept input an entry shows. A command that isn't listed shows
 * none: an input is kept for the record, and may hold more than its reader may see
 * elsewhere. These are the settings whose reason is kept in the audit log alone.
 */
export const shownInput: Readonly<Record<string, readonly string[]>> = {
  'contact.update': ['timeZone', 'doNotContact', 'doNotContactReason'],
  'contact.set_dnd': ['all', 'channels', 'inbound', 'reason'],
};

interface AuditRow {
  readonly id: string;
  readonly recorded_at: Date;
  readonly command: string;
  readonly actor_kind: string;
  readonly actor_id: string | null;
  readonly outcome: string;
  readonly error_code: string | null;
  /** Always an object: the table takes nothing else (commands_input_object). */
  readonly input: Readonly<Record<string, unknown>>;
  readonly proposal_id: string | null;
  readonly events: readonly { readonly id: string; readonly type: string }[];
}

/**
 * A page of a record's audit log, newest first, starting after an entry. Undefined when the
 * business has no record of that kind with that id.
 */
export async function readRecordAudit(
  trx: DatabaseTransaction,
  reader: TenantContext & { readonly businessId: string },
  actorNames: ActorNames,
  record: { readonly kind: RecordKind; readonly id: string },
  after?: string,
): Promise<AuditLog | undefined> {
  const found = await trx
    .selectFrom('crm.records')
    .select('id')
    .where('business_id', '=', reader.businessId)
    .where('id', '=', record.id)
    .where('kind', '=', record.kind)
    .executeTakeFirst();
  if (found === undefined) return undefined;

  // The rows this record's timeline leads to. Matching on the agency and the business as
  // well as the time keeps each lookup inside one range of commands_scope_recorded_idx, and
  // keeps out the agency's own rows, whose business is null.
  const ofRecord = sql`
    from crm.timeline_entries t
    join audit.commands a
      on a.agency_id = ${reader.agencyId} and a.business_id = t.business_id
     and a.recorded_at = t.event_recorded_at and t.event_id = any (a.event_ids)
    where t.business_id = ${reader.businessId} and t.record_id = ${record.id}`;

  if (after !== undefined) {
    const { rows } = await sql`select 1 ${ofRecord} and a.id = ${after} limit 1`.execute(trx);
    if (rows.length === 0)
      throw new ValidationError([
        {
          path: '/after',
          code: 'not_in_audit_log',
          message: "That entry isn't in this record's audit log.",
        },
      ]);
  }

  // Keyset paging: the cursor's place is read in SQL, never through a JavaScript Date,
  // which would drop its microseconds. A command that wrote several events about the record
  // is one entry.
  const { rows } = await sql<AuditRow>`
    select distinct on (a.recorded_at, a.id)
      a.id, a.recorded_at, a.command, a.actor_kind, a.actor_id, a.outcome, a.error_code,
      a.input, a.proposal_id,
      (select coalesce(jsonb_agg(jsonb_build_object('id', e.event_id, 'type', e.event_type)
                                 order by e.event_id), '[]'::jsonb)
       from crm.timeline_entries e
       where e.business_id = t.business_id and e.record_id = t.record_id
         and e.event_recorded_at = a.recorded_at and e.event_id = any (a.event_ids)) as events
    ${ofRecord}
      ${
        after === undefined
          ? sql``
          : sql`and (a.recorded_at, a.id) < (
              select c.recorded_at, c.id from audit.commands c
              where c.id = ${after} and c.business_id = ${reader.businessId})`
      }
    order by a.recorded_at desc, a.id desc
    limit ${AUDIT_PAGE_SIZE + 1}
  `.execute(trx);

  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: await presentEntries(trx, reader, actorNames, page),
    next:
      rows.length > AUDIT_PAGE_SIZE && last !== undefined
        ? toPublicId('audit_entry', last.id)
        : null,
  };
}

/**
 * The rows as entries, for a record's log and the business's alike: who acted, named as
 * far as the reader may see, and of the input only what `shownInput` lists.
 */
async function presentEntries(
  trx: DatabaseTransaction,
  reader: TenantContext,
  actorNames: ActorNames,
  rows: readonly AuditRow[],
): Promise<AuditEntry[]> {
  const actors = rows.map((row) => ({
    actor_kind: actorKinds.find((kind) => kind === row.actor_kind) ?? ('system' as const),
    actor_id: row.actor_id,
  }));
  const names = await namesOf(trx, actors, actorNames);
  return rows.map((row, index) => {
    const kind = actors[index]?.actor_kind ?? 'system';
    return {
      id: toPublicId('audit_entry', row.id),
      at: row.recorded_at.toISOString(),
      command: row.command,
      outcome: auditOutcomes.find((outcome) => outcome === row.outcome) ?? 'failed',
      errorCode: row.error_code,
      actor: {
        kind,
        name: names.get(`${kind}:${row.actor_id ?? ''}`) ?? null,
        you: kind === 'user' && row.actor_id === reader.userId,
      },
      proposed: row.proposal_id !== null,
      events: row.events.map((event) => ({
        id: toPublicId('event', event.id),
        type: event.type,
      })),
      detail: Object.fromEntries(
        (shownInput[row.command] ?? []).flatMap((key) =>
          Object.hasOwn(row.input, key) ? [[key, row.input[key]]] : [],
        ),
      ),
    };
  });
}

/** A row of the business's log: its events come with what each is about. */
interface ListRow extends AuditRow {
  readonly events: readonly {
    readonly id: string;
    readonly type: string;
    readonly kind: string;
    readonly subject: string;
  }[];
}

type Subject = NonNullable<AuditListEntry['record']>;

const isPublicIdKind = (kind: string): kind is PublicIdKind =>
  Object.hasOwn(publicIdPrefixes, kind);

/** The id inside a public id of any kind, or undefined when the value is none. */
function anyPublicId(value: string): string | undefined {
  for (const kind of Object.keys(publicIdPrefixes)) {
    const id = isPublicIdKind(kind) ? parsePublicId(kind, value) : undefined;
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The things the page's commands were about, by id, as far as this list names them: a
 * contact, a company or a deal by the name the task list shows, a task by its title. One
 * that is gone is there with `exists: false`; a thing of any other kind is not looked up.
 */
async function subjectsOf(
  trx: DatabaseTransaction,
  businessId: string,
  wanted: readonly { readonly kind: string; readonly id: string }[],
): Promise<Map<string, Pick<Subject, 'name' | 'exists'>>> {
  const found = new Map<string, Pick<Subject, 'name' | 'exists'>>();
  const ids = (kinds: readonly string[]) => [
    ...new Set(wanted.flatMap((each) => (kinds.includes(each.kind) ? [each.id] : []))),
  ];
  const records = ids(recordKinds);
  const tasks = ids(['task']);
  for (const id of [...records, ...tasks]) found.set(id, { name: null, exists: false });
  if (records.length > 0)
    for (const row of await recordNames(trx, records))
      found.set(row.id, { name: row.name, exists: true });
  if (tasks.length > 0) {
    const rows = await trx
      .selectFrom('crm.tasks')
      .select(['id', 'title'])
      .where('business_id', '=', businessId)
      .where('id', 'in', tasks)
      .execute();
    for (const row of rows) found.set(row.id, { name: row.title, exists: true });
  }
  return found;
}

/** Who a member filter names, as the server's membership lookup answers. */
export interface AuditMembers {
  readonly resolve: (
    trx: DatabaseTransaction,
    context: TenantContext,
    selection: string | null,
  ) => Promise<string | null>;
}

/**
 * A page of the business's audit log, newest first: the commands that changed something, or
 * with `outcome` the attempts that were refused or failed.
 *
 * A command changed something when it is ok and wrote an event: a command that only reads,
 * and the workers' bookkeeping, write none and are never listed. Rows are read from
 * commands_scope_recorded_idx backwards from the cursor; a member's from commands_actor_idx;
 * one thing's from the events about it (events_subject_idx).
 */
export async function readAudit(
  trx: DatabaseTransaction,
  reader: TenantContext & { readonly businessId: string },
  actorNames: ActorNames,
  members: AuditMembers | undefined,
  query: ListAuditQuery,
): Promise<AuditPage> {
  const limit = query.limit ?? AUDIT_PAGE_SIZE;
  let userId: string | undefined;
  if (query.member !== undefined) {
    // Without the server's lookup only the reader is known. With it, someone not on the
    // team is refused by the lookup itself, as a task's assignee is.
    const named =
      members === undefined
        ? query.member === 'me'
          ? (reader.userId ?? null)
          : null
        : await members.resolve(trx, reader, query.member);
    if (named === null)
      throw new ValidationError([
        {
          path: '/member',
          code: 'unavailable_member',
          message: 'Choose someone on this business or agency team.',
        },
      ]);
    userId = named;
  }
  const subject = query.subject === undefined ? undefined : anyPublicId(query.subject);
  // An id that is none names nothing, and a search that finds nothing is an empty page.
  if (query.subject !== undefined && subject === undefined) return { items: [], next: null };

  const after = query.after === undefined ? undefined : parsePublicId('audit_entry', query.after);
  if (query.after !== undefined) {
    const { rows } = await sql`
      select 1 from audit.commands c
      where c.id = ${after ?? null}::uuid and c.agency_id = ${reader.agencyId}
        and c.business_id = ${reader.businessId} limit 1`.execute(trx);
    if (rows.length === 0)
      throw new ValidationError([
        {
          path: '/after',
          code: 'not_in_audit_log',
          message: "That entry isn't in this business's audit log.",
        },
      ]);
  }

  const verbs = Object.values(auditActionVerbs).flat();
  const lastWord = sql`substring(a.command from '[^.]+$')`;
  const conditions = [
    // The agency and the business both, so the agency's own rows, whose business is null
    // and which row-level security lets a business read, stay out.
    sql`a.agency_id = ${reader.agencyId} and a.business_id = ${reader.businessId}`,
    query.outcome === 'ok'
      ? sql`a.outcome = 'ok' and cardinality(a.event_ids) > 0`
      : sql`a.outcome = ${query.outcome}`,
    ...(userId === undefined ? [] : [sql`a.actor_kind = 'user' and a.actor_id = ${userId}`]),
    ...(query.actorKind === undefined ? [] : [sql`a.actor_kind = ${query.actorKind}`]),
    ...(query.module === undefined
      ? []
      : [sql`split_part(a.command, '.', 1) = any (${[...auditModules[query.module]]}::text[])`]),
    ...(query.action === undefined
      ? []
      : query.action === 'updated'
        ? [sql`${lastWord} <> all (${verbs}::text[])`]
        : [sql`${lastWord} = any (${[...auditActionVerbs[query.action]]}::text[])`]),
    ...(query.from === undefined ? [] : [sql`a.recorded_at >= ${query.from}::timestamptz`]),
    ...(query.before === undefined ? [] : [sql`a.recorded_at < ${query.before}::timestamptz`]),
    // Keyset paging: the cursor's place is read in SQL, never through a JavaScript Date,
    // which would drop its microseconds.
    ...(after === undefined
      ? []
      : [
          sql`(a.recorded_at, a.id) < (
            select c.recorded_at, c.id from audit.commands c
            where c.id = ${after} and c.agency_id = ${reader.agencyId}
              and c.business_id = ${reader.businessId})`,
        ]),
  ];
  // One thing's commands are found from the events about it: a command's audit row and
  // its events are written in one transaction, so they carry the same recorded_at.
  const source =
    subject === undefined
      ? sql`from audit.commands a`
      : sql`from events.events s
            join audit.commands a
              on a.recorded_at = s.recorded_at and s.id = any (a.event_ids)
            where s.subject_id = ${subject} and s.agency_id = ${reader.agencyId}
              and s.business_id = ${reader.businessId} and`;
  const { rows } = await sql<ListRow>`
    select distinct on (a.recorded_at, a.id)
      a.id, a.recorded_at, a.command, a.actor_kind, a.actor_id, a.outcome, a.error_code,
      a.input, a.proposal_id,
      (select coalesce(jsonb_agg(jsonb_build_object(
                'id', e.id, 'type', e.type, 'kind', e.subject_kind, 'subject', e.subject_id)
                order by e.id), '[]'::jsonb)
       from events.events e
       where e.id = any (a.event_ids) and e.recorded_at = a.recorded_at
         and e.agency_id = a.agency_id and e.business_id = a.business_id) as events
    ${source} ${subject === undefined ? sql`where` : sql``} ${sql.join(conditions, sql` and `)}
    order by a.recorded_at desc, a.id desc
    limit ${limit + 1}
  `.execute(trx);

  const page = rows.slice(0, limit);
  const entries = await presentEntries(trx, reader, actorNames, page);
  /** What each row is about: the distinct subjects of its events, in the order written. */
  const about = page.map((row) => [
    ...new Map(row.events.map((event) => [event.subject, event])).values(),
  ]);
  const named = await subjectsOf(
    trx,
    reader.businessId,
    about.flatMap((subjects) =>
      subjects.length === 1 ? subjects.map((each) => ({ kind: each.kind, id: each.subject })) : [],
    ),
  );
  const last = page.at(-1);
  return {
    items: entries.map((entry, index) => {
      const subjects = about[index] ?? [];
      const only = subjects.length === 1 ? subjects[0] : undefined;
      return {
        ...entry,
        module: auditModuleOf(entry.command),
        action: auditActionOf(entry.command),
        record:
          only === undefined
            ? null
            : {
                kind: only.kind,
                id:
                  isPublicIdKind(only.kind) && isUuidV7(only.subject)
                    ? toPublicId(only.kind, only.subject)
                    : null,
                name: named.get(only.subject)?.name ?? null,
                exists: named.get(only.subject)?.exists ?? null,
              },
        recordCount: subjects.length,
      };
    }),
    next: rows.length > limit && last !== undefined ? toPublicId('audit_entry', last.id) : null,
  };
}
