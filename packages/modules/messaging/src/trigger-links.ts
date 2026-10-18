// Trigger links: a named web address a message carries by key. The key is made when the
// link is created and never changes, so renaming a link or pointing it somewhere else
// breaks no message and no automation that names it; addresses already sent follow the new
// destination. Deleting a link removes its tokens and clicks with it, so addresses already
// sent stop working.
import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  createTriggerLinkInput,
  deleteTriggerLink,
  mergeKeyFromName,
  TRIGGER_LINK_LIMITS,
  triggerLinkMergeKey,
  updateTriggerLink,
  updateTriggerLinkInput,
  type ListTriggerLinkClicksQuery,
  type ListTriggerLinksQuery,
  type TriggerLink,
  type TriggerLinkClickList,
  type TriggerLinkList,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  isUuidV7,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

const uniqueErrors = explainUniqueViolation({
  trigger_links_key_unique: () =>
    invalid('/key', 'taken', 'This key already belongs to a trigger link.'),
  trigger_links_name_unique: () =>
    invalid('/name', 'taken', 'A trigger link with this name already exists.'),
});

/** May create, change and delete trigger links: they are what messages carry. */
export const mayManageTriggerLinks = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('templates.manage');

interface LinkRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly key: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  /** created_at to the microsecond, which a JavaScript Date would round away. */
  readonly position: string;
  readonly clicks: string;
  readonly contacts: string;
  readonly last_clicked_at: Date | null;
}

// Everything a save can change. The key is not in it: no save changes a key.
const revisionOf = (row: Pick<LinkRow, 'id' | 'name' | 'url'>): string =>
  createHash('sha256')
    .update(JSON.stringify([row.id, row.name, row.url]))
    .digest('hex');

function asLink(row: LinkRow): TriggerLink {
  return {
    id: toPublicId('trigger_link', row.id),
    name: row.name,
    url: row.url,
    key: row.key,
    mergeKey: triggerLinkMergeKey(row.key),
    clicks: Number(row.clicks),
    contacts: Number(row.contacts),
    lastClickedAt: row.last_clicked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revision: revisionOf(row),
  };
}

// Each count is read from the click index of its own link, for the links of one page.
function links(trx: DatabaseTransaction) {
  return trx.selectFrom('messaging.trigger_links as l').select((eb) => [
    'l.id',
    'l.name',
    'l.url',
    'l.key',
    'l.created_at',
    'l.updated_at',
    sql<string>`to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
      'position',
    ),
    // A count is never null, which a subquery's type would not say.
    sql<string>`(
      select count(*) from messaging.trigger_link_clicks c
      where c.business_id = l.business_id and c.link_id = l.id)`.as('clicks'),
    sql<string>`(
      select count(distinct c.contact_id) from messaging.trigger_link_clicks c
      where c.business_id = l.business_id and c.link_id = l.id)`.as('contacts'),
    eb
      .selectFrom('messaging.trigger_link_clicks as c')
      .select((inner) => inner.fn.max('c.clicked_at').as('at'))
      .whereRef('c.business_id', '=', 'l.business_id')
      .whereRef('c.link_id', '=', 'l.id')
      .as('last_clicked_at'),
  ]);
}

/** A link of this business; one of another business is the same error as none. */
async function requireLink(
  trx: DatabaseTransaction,
  linkId: string,
  lock = false,
): Promise<LinkRow> {
  // The nil UUID, which no row has: an id that is not one names nothing.
  const id = parsePublicId('trigger_link', linkId) ?? '00000000-0000-0000-0000-000000000000';
  // Two saves from one revision take turns here, so the second sees the first.
  if (lock)
    await trx
      .selectFrom('messaging.trigger_links')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  const row = await links(trx).where('l.id', '=', id).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Trigger link', linkId);
  return row;
}

/** The base key, or the base with the smallest number from 2 that no link has yet. */
async function freeKey(trx: DatabaseTransaction, base: string): Promise<string> {
  const suffixed = (n: number): string => {
    const suffix = `_${String(n)}`;
    return `${base.slice(0, 63 - suffix.length)}${suffix}`;
  };
  // Keys are at most 63 characters and a business has at most 1000 links: read them all.
  const rows = await trx.selectFrom('messaging.trigger_links').select('key').execute();
  const taken = new Set(rows.map((row) => row.key));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(suffixed(n))) n += 1;
  return suffixed(n);
}

export const createTriggerLinkCommand = defineCommand({
  name: 'trigger_link.create',
  permission: 'templates.manage',
  input: createTriggerLinkInput,
  async handle(trx, input, command): Promise<TriggerLink> {
    const businessId = requireBusiness(command.context);
    // One writer at a time adds a link, so the count and the key it picks are still true.
    await sql`
      select pg_advisory_xact_lock(hashtextextended(${`messaging.trigger_links:${businessId}`}, 0))
    `.execute(trx);
    const { count } = await trx
      .selectFrom('messaging.trigger_links')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count) >= TRIGGER_LINK_LIMITS.links)
      throw invalid(
        '/name',
        'limit_reached',
        `A business can have at most ${String(TRIGGER_LINK_LIMITS.links)} trigger links. Delete one first.`,
      );
    // A key the caller chose is taken or it isn't; one made from the name gets a number.
    const key = input.key ?? (await freeKey(trx, mergeKeyFromName(input.name, 'link')));
    const row = await trx
      .insertInto('messaging.trigger_links')
      .values({
        business_id: businessId,
        name: input.name,
        key,
        url: input.url,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'trigger_link.created',
      subject: { kind: 'trigger_link', id: row.id },
      payload: { key, name: input.name, url: input.url },
    });
    return asLink(await requireLink(trx, toPublicId('trigger_link', row.id)));
  },
});

export const updateTriggerLinkCommand = defineCommand({
  name: 'trigger_link.update',
  permission: 'templates.manage',
  input: updateTriggerLinkInput.extend(updateTriggerLink.params.shape),
  async handle(trx, input, command): Promise<TriggerLink> {
    requireBusiness(command.context);
    const current = await requireLink(trx, input.linkId, true);
    if (revisionOf(current) !== input.revision)
      throw new ConflictError(
        'This trigger link changed. Reload the saved version before editing it again.',
      );
    // A save of what is already stored changes nothing, so it reports nothing.
    if (current.name === input.name && current.url === input.url) return asLink(current);
    await trx
      .updateTable('messaging.trigger_links')
      .set({ name: input.name, url: input.url })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'trigger_link.updated',
      subject: { kind: 'trigger_link', id: current.id },
      payload: {
        key: current.key,
        name: input.name,
        ...(current.url === input.url ? {} : { url: input.url, previousUrl: current.url }),
      },
    });
    return asLink(await requireLink(trx, input.linkId));
  },
});

export const deleteTriggerLinkCommand = defineCommand({
  name: 'trigger_link.delete',
  permission: 'templates.manage',
  input: deleteTriggerLink.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireLink(trx, input.linkId, true);
    // Its tokens and clicks go with it (on delete cascade).
    await trx.deleteFrom('messaging.trigger_links').where('id', '=', current.id).execute();
    await command.emit({
      type: 'trigger_link.deleted',
      subject: { kind: 'trigger_link', id: current.id },
      payload: { key: current.key, name: current.name, clicks: Number(current.clicks) },
    });
  },
});

/** One link with its counts, for any member of the business. */
export async function readTriggerLink(
  trx: DatabaseTransaction,
  invocation: Invocation,
  linkId: string,
): Promise<TriggerLink> {
  requireBusiness(invocation.context);
  return asLink(await requireLink(trx, linkId));
}

/** A search as a LIKE pattern: the text anywhere, with its own % and _ taken literally. */
const containing = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

// Where a page ended: a moment to the microsecond, and an id. Opaque to callers, and still
// good when that row has since been deleted.
const encodeCursor = (position: string, id: string): string =>
  Buffer.from(JSON.stringify([position, id])).toString('base64url');

function decodeCursor(cursor: string): readonly [position: string, id: string] {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(decoded) && decoded.length === 2) {
      const pair: readonly unknown[] = decoded;
      const [position, id] = pair;
      if (
        typeof position === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(position) &&
        typeof id === 'string' &&
        isUuidV7(id)
      )
        return [position, id];
    }
  } catch {
    // Not a cursor this list gave: answered below, like any other that isn't.
  }
  throw invalid('/after', 'invalid_cursor', 'Start from the next a page of this list gave.');
}

/** A page of the business's trigger links, newest first, and how many match. */
export async function readTriggerLinks(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListTriggerLinksQuery,
): Promise<TriggerLinkList> {
  requireBusiness(invocation.context);
  let matching = links(trx);
  if (query.q !== undefined && query.q !== '') {
    const pattern = containing(query.q);
    matching = matching.where(
      sql<SqlBool>`(l.name ilike ${pattern} or l.key ilike ${pattern} or l.url ilike ${pattern})`,
    );
  }
  const { total } = await matching
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  let page = matching;
  if (query.after !== undefined) {
    const [position, id] = decodeCursor(query.after);
    page = page.where(sql<SqlBool>`(l.created_at, l.id) < (${position}::timestamptz, ${id}::uuid)`);
  }
  const rows = await page
    .orderBy('l.created_at', 'desc')
    .orderBy('l.id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map(asLink),
    total: Number(total),
    next:
      rows.length > query.limit && last !== undefined ? encodeCursor(last.position, last.id) : null,
    canManage: mayManageTriggerLinks(invocation),
  };
}

/** Who clicked a link and when, newest first, with the counts for the range asked for. */
export async function readTriggerLinkClicks(
  trx: DatabaseTransaction,
  invocation: Invocation,
  linkId: string,
  query: ListTriggerLinkClicksQuery,
): Promise<TriggerLinkClickList> {
  requireBusiness(invocation.context);
  const link = await requireLink(trx, linkId);
  if (
    query.from !== undefined &&
    query.to !== undefined &&
    new Date(query.from).getTime() >= new Date(query.to).getTime()
  )
    throw invalid('/to', 'invalid_range', 'End the range after it starts.');
  let matching = trx
    .selectFrom('messaging.trigger_link_clicks as c')
    .where('c.link_id', '=', link.id);
  if (query.from !== undefined)
    matching = matching.where('c.clicked_at', '>=', new Date(query.from));
  if (query.to !== undefined) matching = matching.where('c.clicked_at', '<', new Date(query.to));
  const counts = await matching
    .select((eb) => [
      eb.fn.countAll<string>().as('clicks'),
      sql<string>`count(distinct c.contact_id)`.as('contacts'),
    ])
    .executeTakeFirstOrThrow();
  let page = matching
    .innerJoin('crm.contacts as k', (join) =>
      join.onRef('k.business_id', '=', 'c.business_id').onRef('k.id', '=', 'c.contact_id'),
    )
    .select([
      'c.id',
      'c.contact_id',
      'c.clicked_at',
      sql<string>`to_char(c.clicked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'position',
      ),
      sql<string>`coalesce(k.display_name, (
        select i.value_normalized from crm.contact_identities i
        where i.business_id = k.business_id and i.contact_id = k.id and i.is_primary
        order by i.kind limit 1), '')`.as('contact_name'),
      sql<boolean>`k.deleted_at is not null`.as('contact_trashed'),
    ]);
  if (query.after !== undefined) {
    const [position, id] = decodeCursor(query.after);
    page = page.where(sql<SqlBool>`(c.clicked_at, c.id) < (${position}::timestamptz, ${id}::uuid)`);
  }
  const rows = await page
    .orderBy('c.clicked_at', 'desc')
    .orderBy('c.id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map((row) => ({
      id: row.id,
      contact: {
        id: toPublicId('contact', row.contact_id),
        name: row.contact_name,
        trashed: row.contact_trashed,
      },
      clickedAt: row.clicked_at.toISOString(),
    })),
    clicks: Number(counts.clicks),
    contacts: Number(counts.contacts),
    next:
      rows.length > query.limit && last !== undefined ? encodeCursor(last.position, last.id) : null,
  };
}
