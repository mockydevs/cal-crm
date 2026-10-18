// A record's activity and the chain of events behind one, read from the timeline this
// module keeps and the event log. Names of who acted come from the modules that own them,
// through the lookups the server passes in.
import {
  ACTIVITY_PAGE_SIZE,
  MAX_CHAIN_LENGTH,
  type ActivityEntry,
  type EventChain,
  type RecordActivity,
  type RecordKind,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  publicIdPrefixes,
  toPublicId,
  ValidationError,
  type ActorKind,
  type PublicIdKind,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';

/** The names of actors of one kind, by id, as far as the reader may see them. */
export type NameLookup = (
  trx: DatabaseTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/** A lookup for each kind of actor that has names; any other kind shows none. */
export type ActorNames = Readonly<Partial<Record<ActorKind, NameLookup>>>;

/** An event as the timeline and "Why?" show it, before names are added. */
interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly occurred_at: Date;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly actor_kind: ActorKind;
  readonly actor_id: string | null;
  readonly causation_id: string | null;
  /** Always an object: the table takes nothing else (events_payload_object). */
  readonly payload: Readonly<Record<string, unknown>>;
}

const isPublicIdKind = (kind: string): kind is PublicIdKind =>
  Object.hasOwn(publicIdPrefixes, kind);

/**
 * An event's payload as the timeline gives it out. Some events name a person by their
 * internal user id so that workers know whom they concern (a task's `assignedUserId`); no
 * raw user id leaves through the timeline, where people are named only as the actor.
 */
function shown(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !key.endsWith('UserId')));
}

/** Each distinct actor's name, by `kind:id`, found with one lookup per kind. */
export async function namesOf(
  trx: DatabaseTransaction,
  rows: readonly Pick<EventRow, 'actor_kind' | 'actor_id'>[],
  actorNames: ActorNames,
): Promise<Map<string, string>> {
  const wanted = new Map<ActorKind, { readonly lookup: NameLookup; readonly ids: Set<string> }>();
  for (const { actor_kind: kind, actor_id: id } of rows) {
    const lookup = actorNames[kind];
    if (id !== null && lookup !== undefined) {
      const actors = wanted.get(kind) ?? { lookup, ids: new Set<string>() };
      actors.ids.add(id);
      wanted.set(kind, actors);
    }
  }
  const names = new Map<string, string>();
  for (const [kind, { lookup, ids }] of wanted) {
    for (const [id, name] of await lookup(trx, [...ids])) {
      names.set(`${kind}:${id}`, name);
    }
  }
  return names;
}

/** The events as entries, with who acted named as far as the reader may see. */
async function entriesOf(
  trx: DatabaseTransaction,
  rows: readonly EventRow[],
  reader: TenantContext,
  actorNames: ActorNames,
): Promise<ActivityEntry[]> {
  const names = await namesOf(trx, rows, actorNames);
  return rows.map((row) => ({
    id: toPublicId('event', row.id),
    type: row.type,
    occurredAt: row.occurred_at.toISOString(),
    subject: {
      kind: row.subject_kind,
      id: isPublicIdKind(row.subject_kind) ? toPublicId(row.subject_kind, row.subject_id) : null,
    },
    actor: {
      kind: row.actor_kind,
      name: names.get(`${row.actor_kind}:${row.actor_id ?? ''}`) ?? null,
      you: row.actor_kind === 'user' && row.actor_id === reader.userId,
    },
    payload: shown(row.payload),
    causedBy: row.causation_id === null ? null : toPublicId('event', row.causation_id),
  }));
}

const eventColumns = sql`
  e.id, e.type, e.occurred_at, e.subject_kind, e.subject_id,
  e.actor_kind, e.actor_id, e.causation_id, e.payload
`;

/**
 * A page of a record's activity, newest first, starting after the entry for an event.
 * Undefined when the business has no record of that kind with that id.
 */
export async function readActivity(
  trx: DatabaseTransaction,
  reader: TenantContext,
  actorNames: ActorNames,
  record: { readonly kind: RecordKind; readonly id: string },
  after?: string,
): Promise<RecordActivity | undefined> {
  const found = await trx
    .selectFrom('crm.records')
    .select('id')
    .where('id', '=', record.id)
    .where('kind', '=', record.kind)
    .executeTakeFirst();
  if (found === undefined) {
    return undefined;
  }
  if (after !== undefined) {
    const entry = await trx
      .selectFrom('crm.timeline_entries')
      .select('event_id')
      .where('record_id', '=', record.id)
      .where('event_id', '=', after)
      .executeTakeFirst();
    if (entry === undefined) {
      throw new ValidationError([
        {
          path: '/after',
          code: 'not_in_activity',
          message: "That entry isn't in this record's activity.",
        },
      ]);
    }
  }

  // Keyset paging: the cursor's place is read in SQL, never through a JavaScript Date,
  // which would drop its microseconds. Changes made at the same moment are told apart by
  // their ids, which a command's events take in the order it emits them.
  const { rows } = await sql<EventRow>`
    select ${eventColumns}
    from crm.timeline_entries t
    join events.events e on e.id = t.event_id and e.recorded_at = t.event_recorded_at
    where t.record_id = ${record.id}
      ${
        after === undefined
          ? sql``
          : sql`and (t.occurred_at, t.event_id) < (
              select c.occurred_at, c.event_id from crm.timeline_entries c
              where c.record_id = ${record.id} and c.event_id = ${after})`
      }
    order by t.occurred_at desc, t.event_id desc
    limit ${ACTIVITY_PAGE_SIZE + 1}
  `.execute(trx);

  const page = rows.slice(0, ACTIVITY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: await entriesOf(trx, page, reader, actorNames),
    next:
      rows.length > ACTIVITY_PAGE_SIZE && last !== undefined ? toPublicId('event', last.id) : null,
  };
}

/**
 * Why an event happened: it and the events that led to it, oldest first, following each
 * one's cause for at most MAX_CHAIN_LENGTH steps. Undefined when the reader can't see the
 * event. A cause the reader can't see ends the chain, which then doesn't reach its origin.
 */
export async function readChain(
  trx: DatabaseTransaction,
  reader: TenantContext,
  actorNames: ActorNames,
  eventId: string,
): Promise<EventChain | undefined> {
  // Row-level security shows the agency's own events inside each of its businesses, but
  // they can name other businesses (business.created), which a business user mustn't see.
  // So in a business, only its events are read; at the agency, all of them.
  const inView = sql`((select app.business_id()) is null or e.business_id = (select app.business_id()))`;
  // Each step looks its cause up by id alone, so every monthly partition's primary key
  // index is probed: a handful of lookups a step, for a panel someone opens.
  const { rows } = await sql<EventRow & { readonly step: number }>`
    with recursive chain as (
      select ${eventColumns}, 1 as step
      from events.events e
      where e.id = ${eventId} and ${inView}
      union all
      select ${eventColumns}, chain.step + 1
      from chain
      join events.events e on e.id = chain.causation_id
      where chain.step < ${MAX_CHAIN_LENGTH} and ${inView}
    )
    select * from chain order by step desc
  `.execute(trx);

  const origin = rows[0];
  if (origin === undefined) {
    return undefined;
  }
  return {
    items: await entriesOf(trx, rows, reader, actorNames),
    reachesOrigin: origin.causation_id === null,
  };
}
