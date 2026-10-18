// What the bell reads and marks: the caller's own notifications where they work. Row-level
// security already hides everyone else's; each read here still names the person and the
// place, so the indexes are used and nothing rests on one safeguard.
import type { Invocation } from '@repo/commands';
import {
  NOTIFICATION_PAGE_SIZE,
  recordKinds,
  UNREAD_NOTIFICATIONS_SHOWN,
  type listNotificationsQuery,
  type Notification,
  type NotificationList,
  type NotificationTarget,
  type UnreadNotificationCount,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  actorKinds,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  type ActorKind,
  type TenantContext,
} from '@repo/kernel';
import { sql, type ExpressionBuilder, type Selectable } from 'kysely';
import * as z from 'zod';

import { kindOf } from './rules.js';

/** Finds the names of actors of one kind, by id: only the ones the transaction can see. */
export type NameLookup = (
  trx: DatabaseTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/** What the routes need from the modules that know people's and keys' names. */
export interface NotificationOptions {
  /** A lookup for each kind of actor that has names; any other kind shows none. */
  readonly actorNames: Readonly<Partial<Record<ActorKind, NameLookup>>>;
}

type Row = Selectable<DB['notifications.notifications']>;

/**
 * The person a request is made by, acting themselves. Notifications are a person's: an
 * API key, an assistant and the system have none, whatever person's id they carry.
 */
export function requirePerson(context: TenantContext): string {
  if (
    context.actorKind !== 'user' ||
    context.userId === undefined ||
    context.actorId !== context.userId
  )
    throw new ForbiddenError('Only a signed-in person has notifications.');
  return context.userId;
}

/** Where the caller works: their business, or the agency as a whole. */
const here =
  (context: TenantContext) => (eb: ExpressionBuilder<DB, 'notifications.notifications'>) =>
    context.businessId === undefined
      ? eb('business_id', 'is', null)
      : eb('business_id', '=', context.businessId);

const TARGET_KINDS = ['conversation', 'task', 'form', 'appointment', 'automation'] as const;

function targetOf(row: Row): NotificationTarget {
  if (row.subject_kind === 'ai_settings') return { kind: 'ai_settings' };
  if (row.subject_kind === 'calendar_connections') return { kind: 'calendar_connections' };
  if (row.subject_kind === 'integrations') return { kind: 'integrations' };
  const kind = TARGET_KINDS.find((each) => each === row.subject_kind);
  if (kind === undefined || row.subject_id === null)
    throw new TypeError(`Unknown notification subject: ${row.subject_kind}`);
  return { kind, id: toPublicId(kind, row.subject_id) };
}

/** The records the rows are about, as they are now: name and whether in the trash. */
async function recordsOf(
  trx: DatabaseTransaction,
  rows: readonly Row[],
): Promise<Map<string, NonNullable<Notification['record']>>> {
  const ids = [...new Set(rows.flatMap((row) => (row.record_id === null ? [] : [row.record_id])))];
  const records = new Map<string, NonNullable<Notification['record']>>();
  if (ids.length === 0) return records;
  const found = await trx
    .selectFrom('crm.records as record')
    .leftJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'record.business_id')
        .onRef('contact.id', '=', 'record.id'),
    )
    .leftJoin('crm.companies as company', (join) =>
      join
        .onRef('company.business_id', '=', 'record.business_id')
        .onRef('company.id', '=', 'record.id'),
    )
    .leftJoin('crm.deals as deal', (join) =>
      join.onRef('deal.business_id', '=', 'record.business_id').onRef('deal.id', '=', 'record.id'),
    )
    .leftJoin('crm.custom_records as custom', (join) =>
      join
        .onRef('custom.business_id', '=', 'record.business_id')
        .onRef('custom.id', '=', 'record.id'),
    )
    .select(['record.id', 'record.kind'])
    // A contact's name only: one with no name shows none, never an address or a number.
    .select(
      sql<string | null>`case record.kind when 'contact' then contact.display_name
        when 'company' then company.name when 'deal' then deal.name
        when 'custom' then custom.title end`.as('name'),
    )
    .select(
      sql<boolean>`coalesce(contact.deleted_at, company.deleted_at, deal.deleted_at,
        custom.deleted_at) is not null`.as('trashed'),
    )
    .where('record.id', 'in', ids)
    .execute();
  for (const row of found) {
    // Every kind of record the registry holds is one the API names: parsed, not assumed.
    const kind = z.enum(recordKinds).parse(row.kind);
    records.set(row.id, { id: toPublicId(kind, row.id), name: row.name, trashed: row.trashed });
  }
  return records;
}

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly Row[],
  options: NotificationOptions,
): Promise<Notification[]> {
  const records = await recordsOf(trx, rows);
  const names = new Map<string, string>();
  for (const kind of actorKinds) {
    const lookup = options.actorNames[kind];
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.actor_kind === kind && row.actor_id !== null ? [row.actor_id] : [],
        ),
      ),
    ];
    if (lookup !== undefined && ids.length > 0)
      for (const [id, name] of await lookup(trx, ids)) names.set(`${kind}:${id}`, name);
  }
  return rows.map((row) => {
    const kind = kindOf(row.kind);
    const actorKind = actorKinds.find((each) => each === row.actor_kind);
    if (kind === undefined || actorKind === undefined)
      throw new TypeError(`Unknown notification kind or actor: ${row.kind}, ${row.actor_kind}`);
    return {
      id: toPublicId('notification', row.id),
      kind,
      target: targetOf(row),
      record: row.record_id === null ? null : (records.get(row.record_id) ?? null),
      title: row.title,
      body: row.body,
      actor: {
        kind: actorKind,
        name: row.actor_id === null ? null : (names.get(`${actorKind}:${row.actor_id}`) ?? null),
        you: actorKind === 'user' && row.actor_id === invocation.context.userId,
      },
      readAt: row.read_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    };
  });
}

/** A page of the caller's notifications where they work, newest first. */
export async function readNotifications(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listNotificationsQuery>,
  options: NotificationOptions,
): Promise<NotificationList> {
  const me = requirePerson(invocation.context);
  let selection = trx
    .selectFrom('notifications.notifications')
    .selectAll()
    .where('user_id', '=', me)
    .where(here(invocation.context));
  if (query.state === 'unread') selection = selection.where('read_at', 'is', null);
  // Ids are UUIDv7, so they order by when each was made. The cursor is only a place in
  // that order: one that names nothing, or someone else's, still shows only the caller's.
  const after = query.after === undefined ? undefined : parsePublicId('notification', query.after);
  if (after !== undefined) selection = selection.where('id', '<', after);
  const rows = await selection
    .orderBy('id', 'desc')
    .limit(NOTIFICATION_PAGE_SIZE + 1)
    .execute();
  const page = rows.slice(0, NOTIFICATION_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: await present(trx, invocation, page, options),
    nextCursor:
      rows.length > NOTIFICATION_PAGE_SIZE && last !== undefined
        ? toPublicId('notification', last.id)
        : null,
  };
}

/**
 * How many of the caller's notifications here are unread, counted up to the number the
 * bell shows and one more. It reads at most that many entries of the index that holds only
 * unread notifications, so it costs the same however many a person has, and being a plain
 * read of committed rows it is right whatever is being written at the same moment.
 */
export async function countUnread(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<UnreadNotificationCount> {
  const me = requirePerson(invocation.context);
  const unread = await trx
    .selectFrom('notifications.notifications')
    .select('id')
    .where('user_id', '=', me)
    .where(here(invocation.context))
    .where('read_at', 'is', null)
    .limit(UNREAD_NOTIFICATIONS_SHOWN + 1)
    .execute();
  return {
    unread: Math.min(unread.length, UNREAD_NOTIFICATIONS_SHOWN),
    more: unread.length > UNREAD_NOTIFICATIONS_SHOWN,
  };
}

/**
 * Marks one of the caller's notifications read, and gives it. One already read stays as
 * it was. Someone else's, one of another business and one that names nothing are all the
 * same: not found.
 */
export async function markRead(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: NotificationOptions,
): Promise<Notification> {
  const me = requirePerson(invocation.context);
  const uuid = parsePublicId('notification', id);
  if (uuid === undefined) throw new NotFoundError('Notification', id);
  const marked = await trx
    .updateTable('notifications.notifications')
    .set({ read_at: sql<Date>`now()` })
    .where('id', '=', uuid)
    .where('user_id', '=', me)
    .where(here(invocation.context))
    .where('read_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  const row =
    marked ??
    (await trx
      .selectFrom('notifications.notifications')
      .selectAll()
      .where('id', '=', uuid)
      .where('user_id', '=', me)
      .where(here(invocation.context))
      .executeTakeFirst());
  if (row === undefined) throw new NotFoundError('Notification', id);
  const [read] = await present(trx, invocation, [row], options);
  if (read === undefined) throw new TypeError('The notification must be present.');
  return read;
}

/**
 * Marks the caller's unread notifications here read, up to the newest one they were
 * shown, and gives how many are unread afterwards. What arrived after that one stays
 * unread: nobody marks read what they never saw.
 */
export async function markAllRead(
  trx: DatabaseTransaction,
  invocation: Invocation,
  through: string,
): Promise<UnreadNotificationCount> {
  const me = requirePerson(invocation.context);
  const upTo = parsePublicId('notification', through);
  if (upTo !== undefined)
    await trx
      .updateTable('notifications.notifications')
      .set({ read_at: sql<Date>`now()` })
      .where('user_id', '=', me)
      .where(here(invocation.context))
      .where('read_at', 'is', null)
      .where('id', '<=', upTo)
      .execute();
  return countUnread(trx, invocation);
}
