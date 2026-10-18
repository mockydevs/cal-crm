// Snippets: text a person keeps to insert into a message. A text snippet goes into a text
// message or a chat; an email snippet has a subject too. Plain text only, as message
// templates are. A snippet is in at most one folder; deleting a folder leaves its snippets,
// and deleting a snippet is for good: nothing refers to one once its text is in a message.
//
// Lock order: a folder before a snippet. Deleting a folder holds the folder and then takes
// its snippets out of it, so a writer that needs both takes the folder first.
import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  createSnippetFolderInput,
  createSnippetInput,
  deleteSnippet,
  deleteSnippetFolder,
  mergeTokens,
  moveSnippetsInput,
  renderSnippet,
  renderSnippetInput,
  renameSnippetFolder,
  renameSnippetFolderInput,
  SNIPPET_LIMITS,
  snippetTextIssues,
  updateSnippet,
  updateSnippetInput,
  type ConditionValues,
  type ListSnippetsQuery,
  type RenderedSnippet,
  type Snippet,
  type SnippetFolder,
  type SnippetFolderList,
  type SnippetList,
  type SnippetSummary,
  type SnippetType,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  isUuidV7,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type PublicIdKind,
} from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';

import { renderWithTriggerLinks } from './trigger-link-tokens.js';

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

// The UUID inside a public id, or the nil UUID, which no row has: an id that is not one
// names nothing, and is answered as an id nothing has.
const NOTHING = '00000000-0000-0000-0000-000000000000';
const uuidOf = (kind: PublicIdKind, id: string): string => parsePublicId(kind, id) ?? NOTHING;

const uniqueErrors = explainUniqueViolation({
  snippets_name_unique: () => invalid('/name', 'taken', 'A snippet with this name already exists.'),
  snippet_folders_name_unique: () =>
    invalid('/name', 'taken', 'A folder with this name already exists.'),
});

/** May create, change, move and delete snippets and their folders, as for templates. */
export const mayManageSnippets = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('templates.manage');

/**
 * A contact's values by merge field, as a send reads them. Whatever sends messages owns
 * that answer (the automation module's contactValues), so the server passes its reader in.
 */
export type ReadSnippetValues = (
  trx: DatabaseTransaction,
  contactId: string,
) => Promise<ConditionValues>;

export interface SnippetOptions {
  readonly values: ReadSnippetValues;
  /** PUBLIC_URL. Without one a trigger link in a snippet has no address to become. */
  readonly publicUrl?: string | undefined;
}

interface SnippetRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly subject: string | null;
  readonly body: string;
  readonly folder_id: string | null;
  readonly folder_name: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const typeOf = (kind: string): SnippetType => (kind === 'email' ? 'email' : 'text');

// Everything a save can change. The type is not in it: no save changes a type.
const revisionOf = (
  row: Pick<SnippetRow, 'id' | 'name' | 'subject' | 'body' | 'folder_id'>,
): string =>
  createHash('sha256')
    .update(JSON.stringify([row.id, row.name, row.subject, row.body, row.folder_id]))
    .digest('hex');

const shared = (row: SnippetRow) => ({
  id: toPublicId('snippet', row.id),
  type: typeOf(row.kind),
  name: row.name,
  subject: row.subject,
  folderId: row.folder_id === null ? null : toPublicId('snippet_folder', row.folder_id),
  folderName: row.folder_name,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  revision: revisionOf(row),
});

const asSummary = (row: SnippetRow): SnippetSummary => ({
  ...shared(row),
  bodyPreview: row.body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LIMITS.preview),
});

const asSnippet = (row: SnippetRow): Snippet => ({
  ...shared(row),
  body: row.body,
  mergeFields: mergeTokens({ subject: row.subject ?? '', body: row.body }),
});

function snippets(trx: DatabaseTransaction) {
  return trx
    .selectFrom('messaging.snippets as s')
    .leftJoin('messaging.snippet_folders as d', (join) =>
      join.onRef('d.business_id', '=', 's.business_id').onRef('d.id', '=', 's.folder_id'),
    )
    .select([
      's.id',
      's.kind',
      's.name',
      's.subject',
      's.body',
      's.folder_id',
      'd.name as folder_name',
      's.created_at',
      's.updated_at',
    ]);
}

/** A snippet of this business; one of another business is the same error as none. */
async function requireSnippet(
  trx: DatabaseTransaction,
  snippetId: string,
  lock = false,
): Promise<SnippetRow> {
  let query = snippets(trx).where('s.id', '=', uuidOf('snippet', snippetId));
  // Two saves from one revision take turns here, so the second sees the first.
  if (lock) query = query.forUpdate('s');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Snippet', snippetId);
  return row;
}

/**
 * Holds the folder a snippet is to go in, so it can't be deleted on the way. Null is no
 * folder; undefined is a folder this business doesn't have.
 */
async function holdFolder(
  trx: DatabaseTransaction,
  folderId: string | null,
): Promise<string | null | undefined> {
  if (folderId === null) return null;
  const folder = await trx
    .selectFrom('messaging.snippet_folders')
    .select('id')
    .where('id', '=', uuidOf('snippet_folder', folderId))
    .forShare()
    .executeTakeFirst();
  return folder?.id;
}

function heldFolder(folder: string | null | undefined): string | null {
  if (folder === undefined)
    throw invalid('/folderId', 'invalid_folder', 'Choose a folder in this business.');
  return folder;
}

/**
 * One writer at a time adds to a business's snippets (or to their folders), so the count
 * it reads is still true when it inserts.
 */
async function serializeAdditions(
  trx: DatabaseTransaction,
  businessId: string,
  what: 'snippets' | 'snippet_folders',
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(${`messaging.${what}:${businessId}`}, 0))
  `.execute(trx);
}

const renderInput = renderSnippetInput.extend(renderSnippet.params.shape);

// What a save keeps in the audit log: which snippet it was, never its text.
const auditOf = (
  input: { readonly body: string; readonly subject: string | null } & Readonly<
    Record<string, unknown>
  >,
): Readonly<Record<string, unknown>> => {
  const { body, subject, ...rest } = input;
  return { ...rest, hasSubject: subject !== null, bodyLength: body.length };
};

export const createSnippetCommand = defineCommand({
  name: 'snippet.create',
  permission: 'templates.manage',
  input: createSnippetInput,
  audit: auditOf,
  async handle(trx, input, command): Promise<Snippet> {
    const businessId = requireBusiness(command.context);
    await serializeAdditions(trx, businessId, 'snippets');
    const folderId = heldFolder(await holdFolder(trx, input.folderId));
    const { count } = await trx
      .selectFrom('messaging.snippets')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count) >= SNIPPET_LIMITS.snippets)
      throw invalid(
        '/name',
        'limit_reached',
        `A business can have at most ${String(SNIPPET_LIMITS.snippets)} snippets. Delete one first.`,
      );
    const row = await trx
      .insertInto('messaging.snippets')
      .values({
        business_id: businessId,
        kind: input.type,
        name: input.name,
        subject: input.subject,
        body: input.body,
        folder_id: folderId,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'snippet.created',
      subject: { kind: 'snippet', id: row.id },
      payload: { name: input.name, type: input.type },
    });
    return asSnippet(await requireSnippet(trx, toPublicId('snippet', row.id)));
  },
});

export const updateSnippetCommand = defineCommand({
  name: 'snippet.update',
  permission: 'templates.manage',
  input: updateSnippetInput.extend(updateSnippet.params.shape),
  audit: auditOf,
  async handle(trx, input, command): Promise<Snippet> {
    requireBusiness(command.context);
    // The folder before the snippet (the lock order above). Whether it is there is said
    // only after the revision is checked: a stale save is told it is stale first.
    const folder = await holdFolder(trx, input.folderId);
    const current = await requireSnippet(trx, input.snippetId, true);
    if (revisionOf(current) !== input.revision)
      throw new ConflictError(
        'This snippet changed. Reload the saved version before editing it again.',
      );
    const folderId = heldFolder(folder);
    // The type was fixed when the snippet was made, so its rules are checked against it here.
    const [first, ...others] = snippetTextIssues({
      type: typeOf(current.kind),
      subject: input.subject,
      body: input.body,
    }).map((issue) => ({ ...issue, code: 'invalid_for_type' }));
    if (first !== undefined) throw new ValidationError([first, ...others]);
    await trx
      .updateTable('messaging.snippets')
      .set({ name: input.name, subject: input.subject, body: input.body, folder_id: folderId })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'snippet.updated',
      subject: { kind: 'snippet', id: current.id },
      payload: {
        name: input.name,
        subjectChanged: input.subject !== current.subject,
        bodyChanged: input.body !== current.body,
      },
    });
    return asSnippet(await requireSnippet(trx, input.snippetId));
  },
});

export const deleteSnippetCommand = defineCommand({
  name: 'snippet.delete',
  permission: 'templates.manage',
  input: deleteSnippet.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireSnippet(trx, input.snippetId, true);
    await trx.deleteFrom('messaging.snippets').where('id', '=', current.id).execute();
    await command.emit({
      type: 'snippet.deleted',
      subject: { kind: 'snippet', id: current.id },
      payload: { name: current.name, type: typeOf(current.kind) },
    });
  },
});

export const moveSnippetsCommand = defineCommand({
  name: 'snippet.move',
  permission: 'templates.manage',
  input: moveSnippetsInput,
  async handle(trx, input, command): Promise<{ items: SnippetSummary[] }> {
    const businessId = requireBusiness(command.context);
    const folderId = heldFolder(await holdFolder(trx, input.folderId));
    const wanted = input.snippetIds.map((id) => uuidOf('snippet', id));
    const held = await trx
      .selectFrom('messaging.snippets')
      .select(['id', 'folder_id'])
      .where('id', 'in', wanted)
      .orderBy('id')
      .forUpdate()
      .execute();
    // All or none: a snippet that isn't this business's moves nothing.
    if (held.length !== wanted.length)
      throw invalid('/snippetIds', 'invalid_snippet', 'Choose snippets in this business.');
    const moving = held.filter((row) => row.folder_id !== folderId).map(({ id }) => id);
    if (moving.length > 0) {
      await trx
        .updateTable('messaging.snippets')
        .set({ folder_id: folderId })
        .where('id', 'in', moving)
        .execute();
      await command.emit({
        type: 'snippet.moved',
        subject: { kind: 'business', id: businessId },
        payload: {
          folderId: input.folderId,
          snippetIds: moving.map((id) => toPublicId('snippet', id)),
        },
      });
    }
    const rows = await snippets(trx).where('s.id', 'in', wanted).execute();
    // In the order they were named.
    const place = new Map(wanted.map((id, index) => [id, index]));
    const ordered = rows.toSorted(
      (left, right) => Number(place.get(left.id)) - Number(place.get(right.id)),
    );
    return { items: ordered.map(asSummary) };
  },
});

/** One snippet with its whole body, for any member of the business. */
export async function readSnippet(
  trx: DatabaseTransaction,
  invocation: Invocation,
  snippetId: string,
): Promise<Snippet> {
  requireBusiness(invocation.context);
  return asSnippet(await requireSnippet(trx, snippetId));
}

/** A search as a LIKE pattern: the text anywhere, with its own % and _ taken literally. */
const containing = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

// Where a page ended: the last snippet's name as PostgreSQL orders it, and its id. Opaque
// to callers, and still good when that snippet has since been deleted.
const encodeCursor = (sortName: string, id: string): string =>
  Buffer.from(JSON.stringify([sortName, id])).toString('base64url');

function decodeCursor(cursor: string): readonly [sortName: string, id: string] {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(decoded) && decoded.length === 2) {
      const pair: readonly unknown[] = decoded;
      const [sortName, id] = pair;
      if (typeof sortName === 'string' && typeof id === 'string' && isUuidV7(id))
        return [sortName, id];
    }
  } catch {
    // Not a cursor this list gave: answered below, like any other that isn't.
  }
  throw invalid('/after', 'invalid_cursor', 'Start from the next a page of this list gave.');
}

/** A page of the business's snippets in name order, and how many match. */
export async function readSnippets(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListSnippetsQuery,
): Promise<SnippetList> {
  requireBusiness(invocation.context);
  let matching = snippets(trx);
  if (query.q !== undefined && query.q !== '') {
    const pattern = containing(query.q);
    matching = matching.where(
      sql<SqlBool>`(s.name ilike ${pattern} or s.subject ilike ${pattern} or s.body ilike ${pattern})`,
    );
  }
  if (query.type !== undefined) matching = matching.where('s.kind', '=', query.type);
  if (query.folder === 'none') matching = matching.where('s.folder_id', 'is', null);
  else if (query.folder !== undefined)
    matching = matching.where('s.folder_id', '=', uuidOf('snippet_folder', query.folder));
  const { total } = await matching
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  // Never null: the column is generated from the name, which is never null.
  let page = matching.select(sql<string>`s.name_normalized`.as('sort_name'));
  if (query.after !== undefined) {
    const [afterName, afterId] = decodeCursor(query.after);
    page = page.where(sql<SqlBool>`(s.name_normalized, s.id) > (${afterName}, ${afterId}::uuid)`);
  }
  const rows = await page
    .orderBy('s.name_normalized')
    .orderBy('s.id')
    .limit(query.limit + 1)
    .execute();
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map(asSummary),
    total: Number(total),
    next:
      rows.length > query.limit && last !== undefined
        ? encodeCursor(last.sort_name, last.id)
        : null,
    canManage: mayManageSnippets(invocation),
  };
}

/**
 * A snippet filled in for one contact, as a send would fill a template in: a field with no
 * value, or a value that would break the subject onto a second line, is named rather than
 * blanked. A trigger link becomes this contact's own address for it, so this writes a
 * token; it is a command for that reason, and for the same reason asks for the permission
 * to reply. Nothing is sent.
 */
export function createRenderSnippetCommand(
  options: SnippetOptions,
): Command<typeof renderInput, RenderedSnippet> {
  return defineCommand({
    name: 'snippet.render',
    permission: 'conversations.reply',
    input: renderInput,
    async handle(trx, input, command): Promise<RenderedSnippet> {
      requireBusiness(command.context);
      const row = await requireSnippet(trx, input.snippetId);
      const contactId = await liveContact(trx, input.contactId);
      const rendered = await renderWithTriggerLinks(trx, command.context, {
        contactId,
        text: { subject: row.subject ?? '', body: row.body },
        values: await options.values(trx, contactId),
        publicUrl: options.publicUrl,
      });
      if (!rendered.ok) return { ok: false, code: rendered.code, fields: [...rendered.fields] };
      return {
        ok: true,
        type: typeOf(row.kind),
        subject: row.subject === null ? null : rendered.subject,
        body: rendered.body,
      };
    },
  });
}

async function liveContact(trx: DatabaseTransaction, contactId: string): Promise<string> {
  const row = await trx
    .selectFrom('crm.contacts')
    .select('id')
    .where('id', '=', uuidOf('contact', contactId))
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined)
    throw invalid('/contactId', 'unknown_contact', 'Choose a contact of this business.');
  return row.id;
}

// Folders ------------------------------------------------------------------------------

interface FolderRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly snippet_count: string | number;
}

const folderRevision = (row: Pick<FolderRow, 'id' | 'name'>): string =>
  createHash('sha256')
    .update(JSON.stringify([row.id, row.name]))
    .digest('hex');

const asFolder = (row: FolderRow): SnippetFolder => ({
  id: toPublicId('snippet_folder', row.id),
  name: row.name,
  snippetCount: Number(row.snippet_count),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  revision: folderRevision(row),
});

function folders(trx: DatabaseTransaction) {
  return trx.selectFrom('messaging.snippet_folders as d').select([
    'd.id',
    'd.name',
    'd.created_at',
    'd.updated_at',
    // A count is never null, which a subquery's type would not say.
    sql<string>`(
      select count(*) from messaging.snippets s
      where s.business_id = d.business_id and s.folder_id = d.id)`.as('snippet_count'),
  ]);
}

async function requireFolder(trx: DatabaseTransaction, folderId: string): Promise<FolderRow> {
  const id = uuidOf('snippet_folder', folderId);
  // Held first, on its own: a count can't be read from a locked join.
  const held = await trx
    .selectFrom('messaging.snippet_folders')
    .select('id')
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  const row =
    held === undefined ? undefined : await folders(trx).where('d.id', '=', id).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Snippet folder', folderId);
  return row;
}

export const createSnippetFolderCommand = defineCommand({
  name: 'snippet_folder.create',
  permission: 'templates.manage',
  input: createSnippetFolderInput,
  async handle(trx, input, command): Promise<SnippetFolder> {
    const businessId = requireBusiness(command.context);
    await serializeAdditions(trx, businessId, 'snippet_folders');
    const { count } = await trx
      .selectFrom('messaging.snippet_folders')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count) >= SNIPPET_LIMITS.folders)
      throw invalid(
        '/name',
        'limit_reached',
        `A business can have at most ${String(SNIPPET_LIMITS.folders)} snippet folders. Delete one first.`,
      );
    const row = await trx
      .insertInto('messaging.snippet_folders')
      .values({
        business_id: businessId,
        name: input.name,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning(['id', 'name', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'snippet_folder.created',
      subject: { kind: 'snippet_folder', id: row.id },
      payload: { name: row.name },
    });
    return asFolder({ ...row, snippet_count: 0 });
  },
});

export const renameSnippetFolderCommand = defineCommand({
  name: 'snippet_folder.rename',
  permission: 'templates.manage',
  input: renameSnippetFolderInput.extend(renameSnippetFolder.params.shape),
  async handle(trx, input, command): Promise<SnippetFolder> {
    requireBusiness(command.context);
    const current = await requireFolder(trx, input.folderId);
    if (folderRevision(current) !== input.revision)
      throw new ConflictError('This folder changed. Reload it before renaming it again.');
    if (current.name === input.name) return asFolder(current);
    await trx
      .updateTable('messaging.snippet_folders')
      .set({ name: input.name })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'snippet_folder.renamed',
      subject: { kind: 'snippet_folder', id: current.id },
      payload: { name: input.name, previousName: current.name },
    });
    return asFolder(await requireFolder(trx, input.folderId));
  },
});

export const deleteSnippetFolderCommand = defineCommand({
  name: 'snippet_folder.delete',
  permission: 'templates.manage',
  input: deleteSnippetFolder.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireFolder(trx, input.folderId);
    // The foreign key takes its snippets out of it (on delete set null).
    await trx.deleteFrom('messaging.snippet_folders').where('id', '=', current.id).execute();
    await command.emit({
      type: 'snippet_folder.deleted',
      subject: { kind: 'snippet_folder', id: current.id },
      payload: { name: current.name, snippets: Number(current.snippet_count) },
    });
  },
});

/** Every folder of the business, by name: a business has at most 100. */
export async function readSnippetFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<SnippetFolderList> {
  requireBusiness(invocation.context);
  const rows = await folders(trx).orderBy('d.name_normalized').orderBy('d.id').execute();
  return {
    items: rows.map(asFolder),
    canManage: mayManageSnippets(invocation),
  };
}
