// The trash: contacts, companies and deals moved there stay, with everything attached,
// until they're restored or purged. A purge deletes the registry row (crm.records), and the
// database's cascades remove the record and everything attached to it. The worker purges
// what's been there longer than the business's retention days.
import { randomUUID } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  parseRecordId,
  recordKinds,
  TRASH_PAGE_SIZE,
  trashedRecordIdInput,
  type listTrashQuery,
  type RecordKind,
  type TrashList,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { sql, type RawBuilder } from 'kysely';
import * as z from 'zod';

type TrashQuery = z.output<typeof listTrashQuery>;

const DAY = 24 * 60 * 60 * 1000;

/** The days a record stays in the trash before it's purged (crm.settings). */
const DEFAULT_RETENTION_DAYS = 30;

const tables = {
  contact: sql.table('crm.contacts'),
  company: sql.table('crm.companies'),
  deal: sql.table('crm.deals'),
} as const satisfies Record<RecordKind, RawBuilder<unknown>>;

/** What the trash calls a record: a contact without a name by its primary identity. */
const names = {
  contact: sql`coalesce(t.display_name, (
    select i.value_normalized from crm.contact_identities i
    where i.business_id = t.business_id and i.contact_id = t.id and i.is_primary
    order by i.kind limit 1))`,
  company: sql`t.name`,
  deal: sql`t.name`,
} as const satisfies Record<RecordKind, RawBuilder<unknown>>;

async function retentionDays(trx: DatabaseTransaction, businessId: string): Promise<number> {
  const settings = await trx
    .selectFrom('crm.settings')
    .select('trash_retention_days')
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  return settings?.trash_retention_days ?? DEFAULT_RETENTION_DAYS;
}

/**
 * Locks a record for a purge: its registry row, then its own row, the order requireRecord
 * takes them. The registry row is held FOR NO KEY UPDATE, which lets through the FOR KEY
 * SHARE a timeline entry takes: a write that locked the record's own row first (a restore,
 * say) adds its entry and finishes instead of deadlocking. The DELETE takes the full lock.
 * Says whether the record is in the trash, as it is after any write the lock waited for.
 */
async function lockForPurge(trx: DatabaseTransaction, businessId: string, id: string) {
  const record = parseRecordId(id);
  if (record === undefined) throw new NotFoundError('Record', id);
  const registered = await trx
    .selectFrom('crm.records')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', record.id)
    .where('kind', '=', record.kind)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (registered === undefined) throw new NotFoundError('Record', id);
  // A row a restore changed while this waited is read again: no longer in the trash.
  const { rows } = await sql`
    select t.id from ${tables[record.kind]} t
    where t.business_id = ${businessId} and t.id = ${record.id} and t.deleted_at is not null
    for update`.execute(trx);
  return { ...record, trashed: rows.length > 0 };
}

/** A page of the business's trash, most recently trashed first. */
export async function readTrash(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: TrashQuery,
): Promise<TrashList> {
  const businessId = requireBusiness(invocation.context);
  const days = await retentionDays(trx, businessId);
  const kinds = query.kind === undefined ? (['contact', 'company', 'deal'] as const) : [query.kind];
  let after: RawBuilder<unknown> = sql``;
  if (query.after !== undefined) {
    const anchor = parseRecordId(query.after);
    const { rows } =
      anchor === undefined
        ? { rows: [] }
        : await sql<{ id: string }>`
            select a.id from ${tables[anchor.kind]} a
            where a.business_id = ${businessId} and a.id = ${anchor.id}
              and a.deleted_at is not null`.execute(trx);
    if (anchor === undefined || rows.length === 0)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_record',
          message: "Start after a record in this business's trash.",
        },
      ]);
    // Keyset paging across the kinds: the place is read in SQL, so no precision is lost.
    after = sql`and (t.deleted_at, t.id) < ((select a.deleted_at from ${tables[anchor.kind]} a
      where a.business_id = ${businessId} and a.id = ${anchor.id}), ${anchor.id}::uuid)`;
  }
  const limit = TRASH_PAGE_SIZE + 1;
  const branches = kinds.map(
    (kind) => sql`(select ${kind}::text as kind, t.id, ${names[kind]} as name, t.deleted_at
      from ${tables[kind]} t
      where t.business_id = ${businessId} and t.deleted_at is not null ${after}
      order by t.deleted_at desc, t.id desc limit ${limit})`,
  );
  const { rows } = await sql<{
    kind: RecordKind;
    id: string;
    name: string | null;
    deleted_at: Date;
  }>`
    select * from (${sql.join(branches, sql` union all `)}) trash
    order by deleted_at desc, id desc limit ${limit}`.execute(trx);
  const page = rows.slice(0, TRASH_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: toPublicId(row.kind, row.id),
      kind: row.kind,
      name: row.name,
      trashedAt: row.deleted_at.toISOString(),
      purgeAt: new Date(row.deleted_at.getTime() + days * DAY).toISOString(),
    })),
    next:
      rows.length > TRASH_PAGE_SIZE && last !== undefined ? toPublicId(last.kind, last.id) : null,
    retentionDays: days,
    canPurge: invocation.permissions === 'all' || invocation.permissions.has('trash.purge'),
  };
}

/** Purges one record in the trash, with everything attached to it. */
export const purgeRecordCommand = defineCommand({
  name: 'record.purge',
  permission: 'trash.purge',
  input: trashedRecordIdInput,
  async handle(trx, input, command): Promise<undefined> {
    const businessId = requireBusiness(command.context);
    const record = await lockForPurge(trx, businessId, input.id);
    if (!record.trashed) throw new ConflictError('Move it to the trash before purging it.');
    await trx
      .deleteFrom('crm.records')
      .where('business_id', '=', businessId)
      .where('id', '=', record.id)
      .execute();
    // Its timeline went with it, so the event names no records; and no personal data.
    await command.emit({
      type: 'record.purged',
      subject: { kind: record.kind, id: record.id },
      payload: { kind: record.kind },
    });
    return undefined;
  },
});

/** At most this many records go in one purge of a business; the worker repeats until done. */
const PURGE_BATCH = 500;

/** Purges the business's records that have been in the trash past its retention days. */
export const purgeExpiredCommand = defineCommand({
  name: 'trash.purge_expired',
  permission: 'trash.purge',
  input: z.strictObject({}),
  async handle(trx, _input, command): Promise<{ purged: number }> {
    const businessId = requireBusiness(command.context);
    const days = await retentionDays(trx, businessId);
    const cutoff = sql`now() - make_interval(days => ${days})`;
    const { rows: candidates } = await sql<{ id: string }>`
      (select id from crm.contacts where business_id = ${businessId} and deleted_at < ${cutoff})
      union all
      (select id from crm.companies where business_id = ${businessId} and deleted_at < ${cutoff})
      union all
      (select id from crm.deals where business_id = ${businessId} and deleted_at < ${cutoff})
      limit ${PURGE_BATCH}`.execute(trx);
    // Locked as a purge of one is, but never waiting: a record someone is working on is
    // skipped, for the next run. Each record's own row is read again, so one restored
    // since the candidates were read stays.
    const { rows: registered } = await sql<{ id: string }>`
      select id from crm.records
      where business_id = ${businessId} and id = any(${candidates.map((row) => row.id)}::uuid[])
      order by id for no key update skip locked`.execute(trx);
    const ids = registered.map((row) => row.id);
    const rows: { id: string; kind: RecordKind }[] = [];
    for (const kind of recordKinds) {
      const locked = await sql<{ id: string }>`
        select t.id from ${tables[kind]} t
        where t.business_id = ${businessId} and t.id = any(${ids}::uuid[])
          and t.deleted_at < ${cutoff}
        order by t.id for update skip locked`.execute(trx);
      rows.push(...locked.rows.map((row) => ({ id: row.id, kind })));
    }
    if (rows.length === 0) return { purged: 0 };
    await sql`
      delete from crm.records where business_id = ${businessId}
        and id = any(${rows.map((row) => row.id)}::uuid[])`.execute(trx);
    const count = (kind: RecordKind) => rows.filter((row) => row.kind === kind).length;
    await command.emit({
      type: 'trash.purged',
      subject: { kind: 'business', id: businessId },
      payload: {
        retentionDays: days,
        contacts: count('contact'),
        companies: count('company'),
        deals: count('deal'),
      },
    });
    return { purged: rows.length };
  },
});

/**
 * The worker's daily purge: each business with expired trash, in its own business as the
 * system, until none is left. Gives how many records it purged.
 */
export async function purgeExpiredTrash(services: Services): Promise<number> {
  let total = 0;
  for (;;) {
    const { rows } = await sql<{ agency_id: string; business_id: string }>`
      select agency_id, business_id from private.businesses_with_expired_trash(${100})`.execute(
      services.db,
    );
    let purged = 0;
    for (const row of rows) {
      const result = await runCommand(
        services,
        purgeExpiredCommand,
        {},
        {
          context: {
            agencyId: row.agency_id,
            businessId: row.business_id,
            actorKind: 'system',
            correlationId: randomUUID(),
          },
          permissions: 'all',
        },
      );
      purged += result.purged;
    }
    total += purged;
    // Nothing found, or nothing removable: stop rather than ask again.
    if (purged === 0) return total;
  }
}
