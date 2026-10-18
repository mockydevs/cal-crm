// Authoring message templates: the emails automations send by id. A template is never
// removed from the database, since published automations name it: it's archived, which
// frees its name and makes a step that sends it fail as template_unavailable, or deleted to
// the trash, which archives it too and can be undone. One that a published workflow sends
// can't be deleted. An edit reaches every automation that sends the template, because
// sending reads the current text. Each change names the revision it was made from, so two
// people editing the same template can't silently overwrite each other.
import { createHash } from 'node:crypto';
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  archiveMessageTemplate,
  bulkMessageTemplatesInput,
  createMessageTemplate,
  duplicateMessageTemplateInput,
  EMAIL_CONTENT_LIMITS,
  emailPreviewLine,
  mergeTokens,
  templateContentOf,
  type EmailContent,
  messageTemplateRevisionInput,
  moveMessageTemplateInput,
  updateMessageTemplate,
  updateMessageTemplateInput,
  type BulkMessageTemplatesResult,
  type listMessageTemplates,
  type MessageTemplate,
  type MessageTemplateBulkSkipCode,
  type MessageTemplateList,
  type MessageTemplateSummary,
  type MessageTemplateUse,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type DB } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import {
  sql,
  type ExpressionBuilder,
  type ExpressionWrapper,
  type SqlBool,
  type UpdateObject,
} from 'kysely';
import type * as z from 'zod';

import { emailHtmlIsEmpty, emailTextOf, sanitizeEmailHtml } from './email-html.js';
import { lockTemplateFolderTopology } from './template-folders.js';

/**
 * The active and paused automations whose published version sends a template, by the
 * template's public id. Automations own that answer, so the server passes their reader in.
 */
export type ReadTemplateUses = (
  trx: DatabaseTransaction,
  context: TenantContext,
  template: string,
) => Promise<readonly MessageTemplateUse[]>;

/**
 * Every merge field a send can fill in for a contact of this business, such as
 * contact.firstName and contact.custom.<key>. Whatever sends templates owns that answer.
 */
export type ReadTemplateFields = (
  trx: DatabaseTransaction,
  context: TenantContext,
) => Promise<readonly string[]>;

/**
 * How many workflows use each of some templates in a Send email step, by the template's
 * public id. Automations own that answer too; one call answers a whole page of a list.
 */
export type ReadTemplateUseCounts = (
  trx: DatabaseTransaction,
  context: TenantContext,
  templates: readonly { readonly id: string; readonly name: string }[],
) => Promise<ReadonlyMap<string, number>>;

export interface TemplateOptions {
  /** Left out, a template's usedBy is null: this server can't tell what sends it. */
  readonly uses?: ReadTemplateUses | undefined;
  /** Left out, a listed template's workflowUses is null. */
  readonly useCounts?: ReadTemplateUseCounts | undefined;
  /** Left out, unfillableFields is null: this server can't tell what a send fills in. */
  readonly fields?: ReadTemplateFields | undefined;
}

interface SummaryRow {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly archived_at: Date | null;
  /** When it was moved to the trash; it is archived too. */
  readonly deleted_at: Date | null;
  /** updated_at to the microsecond, which a JavaScript Date would round away. */
  readonly version: string;
  readonly body_hash: string;
  /** Null for a plain-text template. */
  readonly html_hash: string | null;
  readonly preheader: string | null;
  readonly folder_id: string | null;
  /** The start of the plain-text part, for the line a picker shows. */
  readonly preview_text: string;
}
type TemplateRow = SummaryRow & { readonly body: string; readonly body_html: string | null };

const columns = [
  'id',
  'name',
  'subject',
  'created_at',
  'updated_at',
  'archived_at',
  'deleted_at',
  'preheader',
  'folder_id',
] as const;
const version = sql<string>`extract(epoch from updated_at)::text`.as('version');
// Hashed in PostgreSQL, so a list can give each revision without loading any body.
const bodyHash = sql<string>`encode(sha256(convert_to(body, 'UTF8')), 'hex')`.as('body_hash');
const htmlHash = sql<string | null>`encode(sha256(convert_to(body_html, 'UTF8')), 'hex')`.as(
  'html_hash',
);
const previewText = sql<string>`left(body, 600)`.as('preview_text');
const computed = [version, bodyHash, htmlHash, previewText] as const;
// The same moment the table's trigger gives updated_at: the transaction's start.
const now = sql<Date>`now()`;

const updateInput = updateMessageTemplateInput.extend(updateMessageTemplate.params.shape);
const revisionInput = messageTemplateRevisionInput.extend(archiveMessageTemplate.params.shape);
const moveInput = moveMessageTemplateInput.extend(archiveMessageTemplate.params.shape);
const duplicateInput = duplicateMessageTemplateInput.extend(archiveMessageTemplate.params.shape);

// Everything a save can change, and when it was last saved: no column is needed for it.
function revisionOf(row: SummaryRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.version,
        row.name,
        row.subject,
        row.body_hash,
        row.archived_at?.toISOString() ?? null,
        // Only a formatted template adds to what is hashed, so a plain-text template's
        // revision is the one it had before templates could be formatted.
        ...(row.html_hash === null ? [] : [row.html_hash, row.preheader]),
        // Likewise only one in the trash, so every other revision stays as it was.
        ...(row.deleted_at === null ? [] : [row.deleted_at.toISOString()]),
      ]),
    )
    .digest('hex');
}

const mayManage = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('templates.manage');

/** Each folder of the business by id, with the names of the folders it is in. */
type FolderPaths = ReadonlyMap<string, { readonly name: string; readonly path: string[] }>;

const NO_FOLDERS: FolderPaths = new Map();

// Read only when a template shown is filed: a business has at most a few hundred folders.
async function folderPaths(
  trx: DatabaseTransaction,
  rows: readonly SummaryRow[],
): Promise<FolderPaths> {
  if (rows.every((row) => row.folder_id === null)) return NO_FOLDERS;
  const folders = await trx
    .selectFrom('messaging.template_folders')
    .select(['id', 'parent_id', 'name'])
    .execute();
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return new Map(
    folders.map((folder) => {
      const path: string[] = [];
      // A folder is never inside itself (template-folders.ts); the count is a second lock.
      for (
        let at: typeof folder | undefined = folder, steps = 0;
        at !== undefined && steps < 100;
        at = at.parent_id === null ? undefined : byId.get(at.parent_id), steps += 1
      )
        path.unshift(at.name);
      return [folder.id, { name: folder.name, path }];
    }),
  );
}

function summaryOf(row: SummaryRow, folders: FolderPaths): MessageTemplateSummary {
  const folder = row.folder_id === null ? undefined : folders.get(row.folder_id);
  return {
    id: toPublicId('template', row.id),
    name: row.name,
    subject: row.subject,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    revision: revisionOf(row),
    format: row.html_hash === null ? 'text' : 'html',
    preheader: row.preheader,
    folder:
      row.folder_id === null || folder === undefined
        ? null
        : {
            id: toPublicId('template_folder', row.folder_id),
            name: folder.name,
            path: folder.path,
          },
    preview: emailPreviewLine(row.preview_text),
  };
}

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

/** What a template input stores: its text, and its formatted part cleaned, when it has one. */
export function storedTemplateContent(input: {
  readonly body?: string | undefined;
  readonly content?: EmailContent | undefined;
  readonly preheader?: string | null | undefined;
}): {
  readonly body: string;
  readonly body_html: string | null;
  readonly preheader: string | null;
} {
  const content = templateContentOf(input);
  if ('code' in content)
    throw invalid(
      '/content',
      content.code,
      content.code === 'content_twice'
        ? 'Give the message as body or as content, not both.'
        : 'Write the message.',
    );
  const preheader = input.preheader ?? null;
  if (content.format === 'text') {
    if (preheader !== null)
      throw invalid(
        '/preheader',
        'preheader_needs_html',
        'Preview text is part of a formatted email. Remove it, or give the message as formatted text.',
      );
    return { body: content.text, body_html: null, preheader: null };
  }
  const html = sanitizeEmailHtml(content.html);
  if (emailHtmlIsEmpty(html)) throw invalid('/content/html', 'empty', 'Write the message.');
  if (html.length > EMAIL_CONTENT_LIMITS.html)
    throw invalid('/content/html', 'too_long', 'Use at most 200,000 characters.');
  const given = content.text ?? '';
  const text = given.trim() === '' ? emailTextOf(html) : given;
  if (text.trim() === '')
    throw invalid(
      '/content/text',
      'text_required',
      'This email shows only pictures. Write its plain-text part, or describe the pictures.',
    );
  if (text.length > EMAIL_CONTENT_LIMITS.text)
    throw invalid('/content/text', 'too_long', 'Use at most 100,000 characters.');
  return { body: text, body_html: html, preheader };
}

const taken = (name: string, path: string, fix: string): ValidationError =>
  new ValidationError([
    { path, code: 'taken', message: `A template is already named "${name}". ${fix}` },
  ]);

// What a save keeps in the audit log: enough to tell which text it was, never the text.
const auditOf = (input: {
  readonly name: string;
  readonly subject: string;
  readonly body?: string | undefined;
  readonly content?: EmailContent | undefined;
}): Readonly<Record<string, unknown>> => {
  // As it was given: the audit is written whether or not the save goes on to be refused.
  const text = input.content?.text ?? input.body ?? '';
  const html = input.content?.format === 'html' ? input.content.html : undefined;
  return {
    name: input.name,
    subject: input.subject,
    bodyLength: text.length,
    bodySha256: createHash('sha256').update(text).digest('hex'),
    ...(html === undefined
      ? {}
      : { htmlLength: html.length, htmlSha256: createHash('sha256').update(html).digest('hex') }),
  };
};

/**
 * A template of this business, optionally held for a write. One that doesn't exist and
 * one that belongs to another business are the same error.
 */
async function requireTemplate(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<TemplateRow> {
  const uuid = parsePublicId('template', id);
  if (uuid === undefined) throw new NotFoundError('Template', id);
  let query = trx
    .selectFrom('messaging.templates')
    .select([...columns, 'body', 'body_html'])
    .select(computed)
    .where('id', '=', uuid)
    .where('channel', '=', 'email');
  // Two saves from the same revision take turns here, so the second sees the first.
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Template', id);
  return row;
}

async function writableTemplate(
  trx: DatabaseTransaction,
  id: string,
  revision: string,
): Promise<TemplateRow> {
  const current = await requireTemplate(trx, id, true);
  if (revisionOf(current) !== revision)
    throw new ConflictError(
      'This template changed after you opened it. Read it again before saving, archiving or restoring it.',
    );
  return current;
}

const IN_TRASH = 'This template is in the trash. Restore it first.';

/** A few workflows by name, and how many more there are. */
function workflowNames(uses: readonly MessageTemplateUse[]): string {
  const shown = uses.slice(0, 3).map((use) => `"${use.name}"`);
  const more = uses.length - shown.length;
  const last = shown.pop() ?? '';
  return more > 0
    ? `${[...shown, last].join(', ')} and ${String(more)} more`
    : shown.length === 0
      ? last
      : `${shown.join(', ')} and ${last}`;
}

/**
 * Why a template can't be deleted or archived: the workflows that send it, a few of them by
 * name, and those whose live version no longer does but whose runs still in progress will.
 * Either way their sends would fail, since a send treats an archived template as gone.
 */
function inUseMessage(uses: readonly MessageTemplateUse[], verb: 'delete' | 'archive'): string {
  const live = uses.filter((use) => use.runsInProgress !== true);
  const running = uses.filter((use) => use.runsInProgress === true);
  const sentences: string[] = [];
  if (live.length > 0)
    sentences.push(
      live.length === 1
        ? `${workflowNames(live)} sends this template. Take it out of its Send email step, then ${verb} it.`
        : `${workflowNames(live)} send this template. Take it out of their Send email step, then ${verb} it.`,
    );
  if (running.length > 0)
    sentences.push(
      live.length === 0
        ? `Runs still in progress in ${workflowNames(running)} send this template. ${verb === 'delete' ? 'Delete' : 'Archive'} it once they finish.`
        : `Runs still in progress in ${workflowNames(running)} send it too: ${verb} it once they finish.`,
    );
  return sentences.join(' ');
}

const nameTaken = (name: string): string =>
  `A template is already named "${name}". Rename or archive that one, then restore this template.`;

/** Whether a live template other than this one has this one's name. */
async function nameIsTaken(
  trx: DatabaseTransaction,
  row: Pick<TemplateRow, 'id' | 'name'>,
): Promise<boolean> {
  const other = await trx
    .selectFrom('messaging.templates')
    .select('id')
    .where('channel', '=', 'email')
    .where('archived_at', 'is', null)
    .where('id', '<>', row.id)
    .where(sql<boolean>`name_normalized = lower(btrim(${row.name}))`)
    .executeTakeFirst();
  return other !== undefined;
}

const COPY_OF = 'Copy of ';
const NAME_LIMIT = 120;

/** "Copy of" a name, numbered from the second; the name is cut so the whole fits. */
function copyName(name: string, number: number): string {
  const suffix = number === 1 ? '' : ` (${String(number)})`;
  // The database measures a name in code points; a letter drawn from several is kept whole
  // or left out, never split.
  let room = NAME_LIMIT - COPY_OF.length - suffix.length;
  let kept = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(name)) {
    room -= Array.from(segment).length;
    if (room < 0) break;
    kept += segment;
  }
  return `${COPY_OF}${kept.trimEnd()}${suffix}`;
}

/** The first copy name no live template has, ignoring case and outer spaces. */
async function freeCopyName(trx: DatabaseTransaction, name: string): Promise<string> {
  // A hundred at a time: a business has fewer live templates than names to try.
  for (let first = 1; ; first += 100) {
    const candidates = Array.from({ length: 100 }, (_, index) => copyName(name, first + index));
    const { rows } = await sql<{ candidate: string }>`
      select c.candidate from unnest(${candidates}::text[]) with ordinality as c(candidate, n)
      where not exists (
        select from messaging.templates t
        where t.channel = 'email' and t.archived_at is null
          and t.name_normalized = lower(btrim(c.candidate)))
      order by c.n limit 1`.execute(trx);
    const free = rows[0]?.candidate;
    if (free !== undefined) return free;
  }
}

/** A template folder of this business, by its public id, or not found. */
async function requireFolder(
  trx: DatabaseTransaction,
  businessId: string,
  publicFolderId: string,
): Promise<string> {
  const parsed = parsePublicId('template_folder', publicFolderId);
  if (parsed === undefined) throw new NotFoundError('Template folder', publicFolderId);
  const folder = await trx
    .selectFrom('messaging.template_folders')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', parsed)
    .executeTakeFirst();
  if (folder === undefined) throw new NotFoundError('Template folder', publicFolderId);
  return folder.id;
}

export interface TemplateCommands {
  readonly create: Command<typeof createMessageTemplate.body, MessageTemplate>;
  readonly update: Command<typeof updateInput, MessageTemplate>;
  readonly archive: Command<typeof revisionInput, MessageTemplate>;
  readonly restore: Command<typeof revisionInput, MessageTemplate>;
  readonly move: Command<typeof moveInput, MessageTemplate>;
  /** Moves a template to the trash. */
  readonly remove: Command<typeof revisionInput, MessageTemplate>;
  readonly duplicate: Command<typeof duplicateInput, MessageTemplate>;
  readonly bulk: Command<typeof bulkMessageTemplatesInput, BulkMessageTemplatesResult>;
}

/** A template with what sends it, as the API answers. */
async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: TemplateRow,
  options: TemplateOptions,
): Promise<MessageTemplate> {
  const id = toPublicId('template', row.id);
  const mergeFields = mergeTokens({ ...row, html: row.body_html });
  // Asked only when the text uses a field: most reads then cost nothing more.
  const fillable =
    options.fields === undefined
      ? undefined
      : new Set(mergeFields.length === 0 ? [] : await options.fields(trx, invocation.context));
  return {
    ...summaryOf({ ...row, preview_text: row.body }, await folderPaths(trx, [row])),
    body: row.body,
    content:
      row.body_html === null
        ? { format: 'text', text: row.body }
        : { format: 'html', html: row.body_html, text: row.body },
    mergeFields,
    unfillableFields:
      fillable === undefined ? null : mergeFields.filter((field) => !fillable.has(field)),
    canManage: mayManage(invocation),
    usedBy:
      options.uses === undefined ? null : [...(await options.uses(trx, invocation.context, id))],
  };
}

// A template in the trash is archived too, so everything that reads templates sees it as
// unavailable; one already archived keeps when it was archived.
const toTrash: UpdateObject<DB, 'messaging.templates'> = {
  deleted_at: now,
  archived_at: sql<Date>`coalesce(archived_at, now())`,
};

const emitDeleted = (command: CommandContext, row: SummaryRow): Promise<string> =>
  command.emit({
    type: 'template.deleted',
    subject: { kind: 'template', id: row.id },
    payload: { name: row.name },
  });

/**
 * Why a template can't be deleted or archived now: the workflows that send it. Undefined
 * when none do, or when this server can't tell.
 */
async function inUse(
  trx: DatabaseTransaction,
  command: CommandContext,
  row: SummaryRow,
  options: TemplateOptions,
  verb: 'delete' | 'archive',
): Promise<string | undefined> {
  const uses = await options.uses?.(trx, command.context, toPublicId('template', row.id));
  return uses === undefined || uses.length === 0 ? undefined : inUseMessage(uses, verb);
}

/** Why one template of a bulk request was left as it was, as the answer says it. */
type BulkReason = NonNullable<BulkMessageTemplatesResult['results'][number]['reason']>;
const skipped = (code: MessageTemplateBulkSkipCode, message: string): BulkReason => ({
  code,
  message,
});

/** One template of a bulk change: done, unchanged, or why it was skipped. */
async function bulkChange(
  trx: DatabaseTransaction,
  command: CommandContext,
  change: {
    readonly action: BulkMessageTemplatesResult['action'];
    readonly folderId: string | null;
  },
  row: SummaryRow,
  options: TemplateOptions,
): Promise<'done' | 'unchanged' | BulkReason> {
  const set = (values: UpdateObject<DB, 'messaging.templates'>) =>
    trx.updateTable('messaging.templates').set(values).where('id', '=', row.id).execute();
  const subject = { kind: 'template', id: row.id };
  switch (change.action) {
    case 'move': {
      if (row.deleted_at !== null) return skipped('in_trash', IN_TRASH);
      if (row.folder_id === change.folderId) return 'unchanged';
      await set({ folder_id: change.folderId });
      await command.emit({
        type: 'template.moved',
        subject,
        payload: { folderId: change.folderId },
      });
      return 'done';
    }
    case 'archive': {
      if (row.deleted_at !== null) return skipped('in_trash', IN_TRASH);
      if (row.archived_at !== null) return 'unchanged';
      const refusal = await inUse(trx, command, row, options, 'archive');
      if (refusal !== undefined) return skipped('in_use', refusal);
      await set({ archived_at: now });
      await command.emit({
        type: 'template.archived',
        subject,
        payload: { name: row.name, automations: options.uses === undefined ? null : [] },
      });
      return 'done';
    }
    case 'delete': {
      if (row.deleted_at !== null) return 'unchanged';
      const refusal = await inUse(trx, command, row, options, 'delete');
      if (refusal !== undefined) return skipped('in_use', refusal);
      await set(toTrash);
      await emitDeleted(command, row);
      return 'done';
    }
    case 'restore': {
      if (row.archived_at === null) return 'unchanged';
      if (await nameIsTaken(trx, row)) return skipped('name_taken', nameTaken(row.name));
      await set({ archived_at: null, deleted_at: null }).catch(
        explainUniqueViolation({
          templates_name_unique: () =>
            taken(row.name, '', 'Rename or archive that one, then restore this template.'),
        }),
      );
      await command.emit({
        type: 'template.restored',
        subject,
        payload: { name: row.name, from: row.deleted_at === null ? 'archived' : 'trash' },
      });
      return 'done';
    }
  }
}

export function createTemplateCommands(options: TemplateOptions = {}): TemplateCommands {
  const create = defineCommand({
    name: 'template.create',
    permission: 'templates.manage',
    input: createMessageTemplate.body,
    audit: auditOf,
    async handle(trx, input, command): Promise<MessageTemplate> {
      const businessId = requireBusiness(command.context);
      const stored = storedTemplateContent(input);
      let folderId: string | null = null;
      if (input.folderId !== undefined && input.folderId !== null) {
        await lockTemplateFolderTopology(trx, businessId);
        folderId = await requireFolder(trx, businessId, input.folderId);
      }
      const row = await trx
        .insertInto('messaging.templates')
        .values({
          business_id: businessId,
          channel: 'email',
          name: input.name,
          subject: input.subject,
          ...stored,
          folder_id: folderId,
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returning([...columns, 'body', 'body_html'])
        .returning(computed)
        .executeTakeFirstOrThrow()
        // The index decides, so two creates at once can't both take a name.
        .catch(
          explainUniqueViolation({
            templates_name_unique: () => taken(input.name, '/name', 'Choose another name.'),
          }),
        );
      await command.emit({
        type: 'template.created',
        subject: { kind: 'template', id: row.id },
        payload: { name: row.name, channel: 'email' },
      });
      return present(trx, command, row, options);
    },
  });

  const update = defineCommand({
    name: 'template.update',
    permission: 'templates.manage',
    input: updateInput,
    audit: (input) => ({ id: input.id, revision: input.revision, ...auditOf(input) }),
    async handle(trx, input, command): Promise<MessageTemplate> {
      requireBusiness(command.context);
      const stored = storedTemplateContent(input);
      const current = await writableTemplate(trx, input.id, input.revision);
      if (current.deleted_at !== null) throw new ConflictError(IN_TRASH);
      if (current.archived_at !== null)
        throw new ConflictError('This template is archived. Restore it before editing it.');
      const changed = {
        name: current.name !== input.name,
        subject: current.subject !== input.subject,
        body:
          current.body !== stored.body ||
          current.body_html !== stored.body_html ||
          current.preheader !== stored.preheader,
      };
      // A save of what is already stored changes nothing, so it reports nothing.
      if (!changed.name && !changed.subject && !changed.body)
        return present(trx, command, current, options);
      const row = await trx
        .updateTable('messaging.templates')
        .set({ name: input.name, subject: input.subject, ...stored })
        .where('id', '=', current.id)
        .returning([...columns, 'body', 'body_html'])
        .returning(computed)
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({
            templates_name_unique: () => taken(input.name, '/name', 'Choose another name.'),
          }),
        );
      await command.emit({
        type: 'template.updated',
        subject: { kind: 'template', id: row.id },
        payload: {
          name: row.name,
          ...(changed.name ? { previousName: current.name } : {}),
          subjectChanged: changed.subject,
          bodyChanged: changed.body,
        },
      });
      return present(trx, command, row, options);
    },
  });

  const archive = defineCommand({
    name: 'template.archive',
    permission: 'templates.manage',
    input: revisionInput,
    async handle(trx, input, command): Promise<MessageTemplate> {
      requireBusiness(command.context);
      const current = await writableTemplate(trx, input.id, input.revision);
      if (current.archived_at !== null) return present(trx, command, current, options);
      // Sends treat an archived template as gone: one a workflow still sends stays live.
      const refusal = await inUse(trx, command, current, options, 'archive');
      if (refusal !== undefined) throw new ConflictError(refusal);
      const row = await trx
        .updateTable('messaging.templates')
        .set({ archived_at: now })
        .where('id', '=', current.id)
        .returning([...columns, 'body', 'body_html'])
        .returning(computed)
        .executeTakeFirstOrThrow();
      const archived = await present(trx, command, row, options);
      await command.emit({
        type: 'template.archived',
        subject: { kind: 'template', id: row.id },
        // Empty, since one in use is refused; null when this server can't tell what sends it.
        payload: { name: row.name, automations: archived.usedBy?.map((use) => use.id) ?? null },
      });
      return archived;
    },
  });

  const restore = defineCommand({
    name: 'template.restore',
    permission: 'templates.manage',
    input: revisionInput,
    async handle(trx, input, command): Promise<MessageTemplate> {
      requireBusiness(command.context);
      const current = await writableTemplate(trx, input.id, input.revision);
      if (current.archived_at === null) return present(trx, command, current, options);
      // Out of the trash or out of the archive, it comes back live.
      const row = await trx
        .updateTable('messaging.templates')
        .set({ archived_at: null, deleted_at: null })
        .where('id', '=', current.id)
        .returning([...columns, 'body', 'body_html'])
        .returning(computed)
        .executeTakeFirstOrThrow()
        // Its name was free to take while it was archived.
        .catch(
          explainUniqueViolation({
            templates_name_unique: () =>
              taken(current.name, '', 'Rename or archive that one, then restore this template.'),
          }),
        );
      await command.emit({
        type: 'template.restored',
        subject: { kind: 'template', id: row.id },
        payload: { name: row.name, from: current.deleted_at === null ? 'archived' : 'trash' },
      });
      return present(trx, command, row, options);
    },
  });

  const move = defineCommand({
    name: 'template.move',
    permission: 'templates.manage',
    input: moveInput,
    async handle(trx, input, command): Promise<MessageTemplate> {
      const businessId = requireBusiness(command.context);
      await lockTemplateFolderTopology(trx, businessId);
      const current = await writableTemplate(trx, input.id, input.revision);
      if (current.deleted_at !== null) throw new ConflictError(IN_TRASH);
      const folderId =
        input.folderId === null ? null : await requireFolder(trx, businessId, input.folderId);
      const row = await trx
        .updateTable('messaging.templates')
        .set({ folder_id: folderId })
        .where('business_id', '=', businessId)
        .where('id', '=', current.id)
        .returning([...columns, 'body', 'body_html'])
        .returning(computed)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'template.moved',
        subject: { kind: 'template', id: row.id },
        payload: { folderId },
      });
      return present(trx, command, row, options);
    },
  });

  const remove = defineCommand({
    name: 'template.delete',
    permission: 'templates.manage',
    input: revisionInput,
    async handle(trx, input, command): Promise<MessageTemplate> {
      requireBusiness(command.context);
      const current = await writableTemplate(trx, input.id, input.revision);
      if (current.deleted_at !== null) return present(trx, command, current, options);
      const refusal = await inUse(trx, command, current, options, 'delete');
      if (refusal !== undefined) throw new ConflictError(refusal);
      const row = await trx
        .updateTable('messaging.templates')
        .set(toTrash)
        .where('id', '=', current.id)
        .returning([...columns, 'body', 'body_html'])
        .returning(computed)
        .executeTakeFirstOrThrow();
      await emitDeleted(command, row);
      return present(trx, command, row, options);
    },
  });

  const duplicate = defineCommand({
    name: 'template.duplicate',
    permission: 'templates.manage',
    input: duplicateInput,
    async handle(trx, input, command): Promise<MessageTemplate> {
      const businessId = requireBusiness(command.context);
      const source = await requireTemplate(trx, input.id);
      if (source.deleted_at !== null)
        throw new ConflictError('This template is in the trash. Restore it before duplicating it.');
      // Its folder can't be removed while the copy is filed in it.
      if (source.folder_id !== null) await lockTemplateFolderTopology(trx, businessId);
      // Copies made at the same moment would choose the same free name: they take turns, and
      // each chooses after the one before it is saved.
      if (input.name === undefined)
        await sql`select pg_advisory_xact_lock(hashtextextended(${`messaging.template-copy:${businessId}`}, 0))`.execute(
          trx,
        );
      const name = input.name ?? (await freeCopyName(trx, source.name));
      const row = await trx
        .insertInto('messaging.templates')
        .values({
          business_id: businessId,
          channel: 'email',
          name,
          subject: source.subject,
          body: source.body,
          body_html: source.body_html,
          preheader: source.preheader,
          folder_id: source.folder_id,
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returning([...columns, 'body', 'body_html'])
        .returning(computed)
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({
            templates_name_unique: () => taken(name, '/name', 'Choose another name.'),
          }),
        );
      await command.emit({
        type: 'template.created',
        subject: { kind: 'template', id: row.id },
        payload: { name: row.name, channel: 'email', duplicateOf: source.id },
      });
      return present(trx, command, row, options);
    },
  });

  // Many templates at once, in one transaction: each that can be changed is, as its own
  // command would change it and with the same event; one that can't is skipped with its
  // reason and never stops the others. No revision is asked: a selection in a list holds
  // none, as a bulk change of deals doesn't.
  const bulk = defineCommand({
    name: 'template.bulk',
    permission: 'templates.manage',
    input: bulkMessageTemplatesInput,
    async handle(trx, input, command): Promise<BulkMessageTemplatesResult> {
      const businessId = requireBusiness(command.context);
      let folderId: string | null = null;
      if (input.action === 'move') {
        await lockTemplateFolderTopology(trx, businessId);
        if (input.folderId !== null)
          folderId = await requireFolder(trx, businessId, input.folderId);
      }
      const rows = await trx
        .selectFrom('messaging.templates')
        .select(columns)
        .select(computed)
        .where('channel', '=', 'email')
        .where(
          'id',
          'in',
          input.ids.flatMap((id) => parsePublicId('template', id) ?? []),
        )
        // Held in one order, so two bulk changes of the same templates take turns.
        .orderBy('id')
        .forUpdate()
        .execute();
      const byId = new Map(rows.map((row) => [toPublicId('template', row.id), row]));
      const results: BulkMessageTemplatesResult['results'] = [];
      for (const id of input.ids) {
        const row = byId.get(id);
        const outcome =
          row === undefined
            ? skipped('not_found', 'This template was not found.')
            : await bulkChange(trx, command, { action: input.action, folderId }, row, options);
        results.push(
          typeof outcome === 'string'
            ? { id, outcome, reason: null }
            : { id, outcome: 'skipped', reason: outcome },
        );
      }
      const count = (outcome: 'done' | 'unchanged' | 'skipped') =>
        results.filter((result) => result.outcome === outcome).length;
      return {
        action: input.action,
        results,
        done: count('done'),
        unchanged: count('unchanged'),
        skipped: count('skipped'),
      };
    },
  });

  return { create, update, archive, restore, move, remove, duplicate, bulk };
}

/** One template with its body, for any member of the business. */
export async function readTemplate(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: TemplateOptions = {},
): Promise<MessageTemplate> {
  requireBusiness(invocation.context);
  return present(trx, invocation, await requireTemplate(trx, id), options);
}

type TemplateListQuery = Omit<
  z.output<typeof listMessageTemplates.query>,
  'limit' | 'deleted' | 'sort'
> &
  Partial<Pick<z.output<typeof listMessageTemplates.query>, 'deleted' | 'sort'>> & {
    readonly limit?: number | undefined;
  };

type TemplateBuilder = ExpressionBuilder<DB, 'messaging.templates'>;
type TemplateFilter = (
  eb: TemplateBuilder,
) => ExpressionWrapper<DB, 'messaging.templates', SqlBool>;

/** The templates a list asks for, before any page is placed: every filter but use. */
function matchingTemplates(query: TemplateListQuery, folderId: string | null | undefined) {
  return (eb: TemplateBuilder) => {
    const conditions = [eb('channel', '=', 'email')];
    if (folderId !== undefined)
      conditions.push(eb('folder_id', folderId === null ? 'is' : '=', folderId));
    if (query.q !== undefined && query.q !== '') {
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(eb.or([eb('name', 'ilike', pattern), eb('subject', 'ilike', pattern)]));
    }
    if (query.format !== undefined)
      conditions.push(eb('body_html', query.format === 'html' ? 'is not' : 'is', null));
    // The trash, or everything else: an archive that includes or is the archived templates
    // still leaves the trash out.
    if (query.deleted === 'only') conditions.push(eb('deleted_at', 'is not', null));
    else {
      conditions.push(eb('deleted_at', 'is', null));
      if (query.archived !== 'include')
        conditions.push(eb('archived_at', query.archived === 'only' ? 'is not' : 'is', null));
    }
    return eb.and(conditions);
  };
}

const usesUnknown = (path: string): ValidationError =>
  invalid(path, 'uses_unknown', 'This server cannot tell which workflows use a template.');

/**
 * A page of templates without their bodies: by name, by last change, or by how many
 * workflows use them; optionally only those some workflow uses, or none does.
 */
export async function readTemplates(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: TemplateListQuery,
  options: Pick<TemplateOptions, 'useCounts'> = {},
): Promise<MessageTemplateList> {
  requireBusiness(invocation.context);
  const limit = query.limit ?? 50;
  const sort = query.sort ?? 'name';
  // Only automations know how many workflows use a template.
  const useCounts = options.useCounts;
  if (useCounts === undefined) {
    if (query.used !== undefined) throw usesUnknown('/used');
    if (sort === 'uses') throw usesUnknown('/sort');
  }
  let folderId: string | null | undefined;
  if (query.folder === 'root') folderId = null;
  else if (query.folder !== undefined) {
    const parsed = parsePublicId('template_folder', query.folder);
    if (parsed === undefined) throw new NotFoundError('Template folder', query.folder);
    const folder = await trx
      .selectFrom('messaging.template_folders')
      .select('id')
      .where('id', '=', parsed)
      .executeTakeFirst();
    if (folder === undefined) throw new NotFoundError('Template folder', query.folder);
    folderId = folder.id;
  }
  const matches: TemplateFilter = matchingTemplates(query, folderId);
  // The anchor only has to be a template of this business: one archived, deleted or
  // renamed since the page was read still marks a place. The rows after it match the filter.
  let anchor: string | undefined;
  if (query.after !== undefined) {
    const uuid = parsePublicId('template', query.after);
    const row =
      uuid === undefined
        ? undefined
        : await trx
            .selectFrom('messaging.templates')
            .select('id')
            .where('id', '=', uuid)
            .where('channel', '=', 'email')
            .executeTakeFirst();
    if (row === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_template',
          message: 'Start after a template in this list.',
        },
      ]);
    anchor = row.id;
  }
  const page =
    useCounts !== undefined && (sort === 'uses' || query.used !== undefined)
      ? await pageByUse(trx, invocation, { ...query, sort }, matches, anchor, limit, useCounts)
      : await pageInOrder(trx, { sort }, matches, anchor, limit);
  const folders = await folderPaths(trx, page.rows);
  const items = page.rows.map((row) => summaryOf(row, folders));
  // One question for the whole page, to whoever owns workflows, unless it was asked already.
  const uses =
    page.uses ??
    (await useCounts?.(
      trx,
      invocation.context,
      items.map((item) => ({ id: item.id, name: item.name })),
    ));
  const last = page.rows.at(-1);
  return {
    canManage: mayManage(invocation),
    items: items.map((item) => ({
      ...item,
      workflowUses: uses === undefined ? null : (uses.get(item.id) ?? 0),
    })),
    nextCursor: page.more && last !== undefined ? toPublicId('template', last.id) : null,
    total: page.total,
  };
}

interface TemplatePage {
  readonly rows: readonly SummaryRow[];
  readonly more: boolean;
  /** Every template that matches, on every page together. */
  readonly total: number;
  /** How many workflows use each, when the page was placed by it. */
  readonly uses?: ReadonlyMap<string, number>;
}

// By name or by last change, paged in PostgreSQL: each comparison under the collation the
// ordering uses, and to the microsecond a JavaScript Date would round away.
async function pageInOrder(
  trx: DatabaseTransaction,
  { sort }: { readonly sort: 'name' | 'updated' | 'uses' },
  matches: TemplateFilter,
  anchor: string | undefined,
  limit: number,
): Promise<TemplatePage> {
  let selection = trx
    .selectFrom('messaging.templates')
    .select(columns)
    .select(computed)
    .where(matches);
  // Counted before the page's place is applied, so "N of M" is the same M on each page.
  const { total } = await selection
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  if (anchor !== undefined)
    selection = selection.where(
      sort === 'updated'
        ? sql<boolean>`(updated_at, id) < (
            select anchor.updated_at, anchor.id from messaging.templates anchor
            where anchor.id = ${anchor})`
        : sql<boolean>`(name_normalized, id) > (
            select anchor.name_normalized, anchor.id from messaging.templates anchor
            where anchor.id = ${anchor})`,
    );
  // Archived templates can share a name, and two saves a moment: the id settles the order.
  selection =
    sort === 'updated'
      ? selection.orderBy('updated_at', 'desc').orderBy('id', 'desc')
      : selection.orderBy('name_normalized').orderBy('id');
  const rows = await selection.limit(limit + 1).execute();
  return { rows: rows.slice(0, limit), more: rows.length > limit, total: Number(total) };
}

// By how many workflows use each, or only those some workflow uses or none does: the
// counts come from automations, so every matching template is read (its id and name only),
// counted in one question, then ordered and filtered here. The anchor is read with them,
// so it still marks its place once it no longer matches.
async function pageByUse(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: TemplateListQuery & { readonly sort: 'name' | 'updated' | 'uses' },
  matches: TemplateFilter,
  anchor: string | undefined,
  limit: number,
  useCounts: ReadTemplateUseCounts,
): Promise<TemplatePage> {
  let candidates = trx
    .selectFrom('messaging.templates')
    .select(['id', 'name'])
    .select((eb) => matches(eb).as('matches'))
    .where((eb) =>
      anchor === undefined ? matches(eb) : eb.or([matches(eb), eb('id', '=', anchor)]),
    );
  // In PostgreSQL's order, which a sort by use keeps among templates used alike.
  candidates =
    query.sort === 'updated'
      ? candidates.orderBy('updated_at', 'desc').orderBy('id', 'desc')
      : candidates.orderBy('name_normalized').orderBy('id');
  const rows = (await candidates.execute()).map((row) => ({
    ...row,
    publicId: toPublicId('template', row.id),
  }));
  const uses = await useCounts(
    trx,
    invocation.context,
    rows.map((row) => ({ id: row.publicId, name: row.name })),
  );
  const usesOf = (row: { readonly publicId: string }): number => uses.get(row.publicId) ?? 0;
  const ordered =
    query.sort === 'uses' ? [...rows].sort((left, right) => usesOf(right) - usesOf(left)) : rows;
  const wanted = (row: (typeof rows)[number]): boolean =>
    row.matches === true &&
    (query.used === undefined || (query.used === 'yes') === usesOf(row) > 0);
  const start = anchor === undefined ? 0 : ordered.findIndex((row) => row.id === anchor) + 1;
  const after = ordered.slice(start).filter(wanted);
  const ids = after.slice(0, limit).map((row) => row.id);
  const full =
    ids.length === 0
      ? []
      : await trx
          .selectFrom('messaging.templates')
          .select(columns)
          .select(computed)
          .where('id', 'in', ids)
          .execute();
  const byId = new Map(full.map((row) => [row.id, row]));
  return {
    rows: ids.flatMap((id) => byId.get(id) ?? []),
    more: after.length > limit,
    total: ordered.filter(wanted).length,
    uses,
  };
}
