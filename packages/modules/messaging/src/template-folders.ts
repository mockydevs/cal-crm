import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  createEmailCampaignFolderInput,
  createMessageTemplateFolderInput,
  emailCampaignRevisionInput,
  MESSAGE_TEMPLATE_FOLDER_LIMIT,
  MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH,
  messageTemplateFolderRevisionInput,
  publicId,
  updateEmailCampaignFolderInput,
  updateMessageTemplateFolderInput,
  type EmailCampaignFolder,
  type EmailCampaignFolderList,
  type MessageTemplateFolder,
  type MessageTemplateFolderDetail,
  type MessageTemplateFolderList,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';

interface FolderRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly name_normalized: string | null;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}
const columns = [
  'id',
  'parent_id',
  'name',
  'name_normalized',
  'revision',
  'created_at',
  'updated_at',
] as const;
const updateInput = updateMessageTemplateFolderInput.safeExtend({
  id: publicId('template_folder'),
});
const removeInput = messageTemplateFolderRevisionInput.extend({ id: publicId('template_folder') });
const present = (row: FolderRow, count: number): MessageTemplateFolder => ({
  id: toPublicId('template_folder', row.id),
  parentId: row.parent_id === null ? null : toPublicId('template_folder', row.parent_id),
  name: row.name,
  revision: row.revision,
  templateCount: count,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * The two trees this table holds (0088): folders of templates and folders of campaigns. A
 * folder is of one kind for good, and so are its parent and everything in it.
 */
interface FolderKind {
  readonly kind: 'template' | 'campaign';
  readonly permission: 'templates.manage' | 'campaigns.manage';
  /** What the folders are called in a refusal, and what their commands and events start with. */
  readonly noun: 'Template' | 'Campaign';
  /** The public id its folders carry: a campaign folder's id never names a template folder. */
  readonly id: 'template_folder' | 'email_campaign_folder';
}
const TEMPLATES: FolderKind = {
  kind: 'template',
  permission: 'templates.manage',
  noun: 'Template',
  id: 'template_folder',
};
const CAMPAIGNS: FolderKind = {
  kind: 'campaign',
  permission: 'campaigns.manage',
  noun: 'Campaign',
  id: 'email_campaign_folder',
};

/**
 * The folders of templates, each with how many live templates are directly in it, and how
 * many templates each view of the library holds: live, unfiled, archived and in the trash.
 */
export async function readTemplateFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<MessageTemplateFolderList> {
  const list = await templateFolders(trx, invocation);
  // A template in the trash is archived too: it counts as deleted, not archived.
  const counts = await trx
    .selectFrom('messaging.templates')
    .select([
      sql<number>`count(*) filter (where archived_at is null)::integer`.as('all'),
      sql<number>`count(*) filter (where archived_at is null and folder_id is null)::integer`.as(
        'unfiled',
      ),
      sql<number>`count(*) filter (where archived_at is not null and deleted_at is null)::integer`.as(
        'archived',
      ),
      sql<number>`count(*) filter (where deleted_at is not null)::integer`.as('deleted'),
    ])
    .where('channel', '=', 'email')
    .executeTakeFirstOrThrow();
  return { ...list, counts };
}

async function templateFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<MessageTemplateFolderList> {
  requireBusiness(invocation.context);
  const rows = await trx
    .selectFrom('messaging.template_folders as folder')
    .select(columns.map((column) => `folder.${column}` as const))
    .select((eb) =>
      eb
        .selectFrom('messaging.templates as template')
        .select((inner) => inner.fn.countAll<string>().as('count'))
        .whereRef('template.folder_id', '=', 'folder.id')
        .where('template.archived_at', 'is', null)
        .as('templates'),
    )
    .where('folder.kind', '=', 'template')
    .orderBy(sql`lower(btrim(folder.name))`)
    .orderBy('folder.id')
    .limit(MESSAGE_TEMPLATE_FOLDER_LIMIT + 1)
    .execute();
  if (rows.length > MESSAGE_TEMPLATE_FOLDER_LIMIT)
    throw new ConflictError('The template folder limit has been exceeded.');
  return {
    canManage: invocation.permissions === 'all' || invocation.permissions.has('templates.manage'),
    items: rows.map((row) => present(row, Number(row.templates ?? 0))),
  };
}

/**
 * The folders of email campaigns, each with how many campaigns are directly in it, and how
 * many campaigns the business has in all and in no folder.
 */
export async function readCampaignFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<EmailCampaignFolderList> {
  requireBusiness(invocation.context);
  const rows = await trx
    .selectFrom('messaging.template_folders as folder')
    .select(columns.map((column) => `folder.${column}` as const))
    .select((eb) =>
      eb
        .selectFrom('messaging.email_campaigns as campaign')
        .select((inner) => inner.fn.countAll<string>().as('count'))
        .whereRef('campaign.folder_id', '=', 'folder.id')
        .as('campaigns'),
    )
    .where('folder.kind', '=', 'campaign')
    .orderBy(sql`lower(btrim(folder.name))`)
    .orderBy('folder.id')
    .limit(MESSAGE_TEMPLATE_FOLDER_LIMIT)
    .execute();
  const counts = await trx
    .selectFrom('messaging.email_campaigns')
    .select([
      sql<number>`count(*)::integer`.as('all'),
      sql<number>`count(*) filter (where folder_id is null)::integer`.as('unfiled'),
    ])
    .executeTakeFirstOrThrow();
  return {
    canManage: invocation.permissions === 'all' || invocation.permissions.has('campaigns.manage'),
    items: rows.map((row) => campaignFolder(row, Number(row.campaigns))),
    counts,
  };
}

const campaignFolder = (row: FolderRow, count: number): EmailCampaignFolder => ({
  id: toPublicId('email_campaign_folder', row.id),
  parentId: row.parent_id === null ? null : toPublicId('email_campaign_folder', row.parent_id),
  name: row.name,
  revision: row.revision,
  campaignCount: count,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** Root-to-current breadcrumbs are derived from the same bounded tenant snapshot. */
export async function readTemplateFolder(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<MessageTemplateFolderDetail> {
  const { items } = await templateFolders(trx, invocation);
  const byId = new Map(items.map((item) => [item.id, item]));
  const folder = byId.get(id);
  if (folder === undefined) throw new NotFoundError('Template folder', id);
  const breadcrumbs: MessageTemplateFolder[] = [];
  for (let current = folder; ;) {
    if (breadcrumbs.length >= MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH) throw tooDeep();
    breadcrumbs.unshift(current);
    if (current.parentId === null) break;
    const parent = byId.get(current.parentId);
    if (parent === undefined)
      throw new ConflictError('The template folder ancestry is unavailable.');
    current = parent;
  }
  return { folder, breadcrumbs };
}

interface Tree {
  readonly rows: readonly FolderRow[];
  readonly byId: ReadonlyMap<string, FolderRow>;
  depth(id: string | null): number;
  within(id: string, ancestor: string): boolean;
  height(id: string): number;
  nameTaken(parent: string | null, normalizedName: string, except?: string): boolean;
}

/** Placement and topology mutations share one lock so folder removal cannot race a move. */
export async function lockTemplateFolderTopology(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`template-folders:${businessId}`}, 0))`.execute(
    trx,
  );
}

async function lockTree(
  trx: DatabaseTransaction,
  businessId: string,
  { kind, noun }: FolderKind,
): Promise<Tree> {
  await lockTemplateFolderTopology(trx, businessId);
  const tooDeep = () => deep(noun);
  const rows = await trx
    .selectFrom('messaging.template_folders')
    .select(columns)
    .where('kind', '=', kind)
    .limit(MESSAGE_TEMPLATE_FOLDER_LIMIT + 1)
    .execute();
  if (rows.length > MESSAGE_TEMPLATE_FOLDER_LIMIT)
    throw new ConflictError(`The ${noun.toLowerCase()} folder limit has been exceeded.`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depth = (id: string | null) => {
    let count = 0;
    for (let at = id; at !== null; at = byId.get(at)?.parent_id ?? null) {
      count += 1;
      if (count > MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH) throw tooDeep();
    }
    return count;
  };
  const within = (id: string, ancestor: string) => {
    for (
      let at: string | null = id, steps = 0;
      at !== null;
      at = byId.get(at)?.parent_id ?? null, steps += 1
    ) {
      if (steps >= MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH) throw tooDeep();
      if (at === ancestor) return true;
    }
    return false;
  };
  return {
    rows,
    byId,
    depth,
    within,
    height: (id) =>
      Math.max(...rows.filter((row) => within(row.id, id)).map((row) => depth(row.id))) -
      depth(id) +
      1,
    nameTaken: (parent, normalizedName, except) =>
      rows.some(
        (row) =>
          row.id !== except && row.parent_id === parent && row.name_normalized === normalizedName,
      ),
  };
}

const deep = (noun: FolderKind['noun']) =>
  new ValidationError([
    {
      path: '/parentId',
      code: 'folder_too_deep',
      message: `${noun} folders nest at most five levels deep.`,
    },
  ]);
const tooDeep = () => deep('Template');

async function normalizeName(trx: DatabaseTransaction, name: string): Promise<string> {
  const { normalized } = await trx
    .selectNoFrom(sql<string>`lower(btrim(${name}))`.as('normalized'))
    .executeTakeFirstOrThrow();
  return normalized;
}
function place(tree: Tree, publicFolderId: string | null, kind: FolderKind): string | null {
  if (publicFolderId === null) return null;
  const id = parsePublicId(kind.id, publicFolderId);
  if (id === undefined || !tree.byId.has(id))
    throw new NotFoundError(`${kind.noun} folder`, publicFolderId);
  return id;
}
function writable(tree: Tree, given: string, revision: number, kind: FolderKind): FolderRow {
  const id = place(tree, given, kind);
  const folder = id === null ? undefined : tree.byId.get(id);
  if (folder === undefined) throw new NotFoundError(`${kind.noun} folder`, given);
  if (folder.revision !== revision)
    throw new ConflictError(
      'This folder changed after you opened it. Read it again before saving or removing it.',
    );
  return folder;
}
async function readFolder(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<MessageTemplateFolder> {
  const folder = (await templateFolders(trx, invocation)).items.find(
    (item) => item.id === toPublicId('template_folder', id),
  );
  if (folder === undefined) throw new NotFoundError('Template folder', id);
  return folder;
}

async function readCampaignFolder(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<EmailCampaignFolder> {
  const folder = (await readCampaignFolders(trx, invocation)).items.find(
    (item) => item.id === toPublicId('email_campaign_folder', id),
  );
  if (folder === undefined) throw new NotFoundError('Campaign folder', id);
  return folder;
}

/** The three writes of a tree, whichever kind it is; each answers with the folder's id. */
function treeWrites(kind: FolderKind) {
  const { noun } = kind;
  const event = noun.toLowerCase();
  const taken = () =>
    new ConflictError(`A ${event} folder with that name already exists at the destination.`);

  async function create(
    trx: DatabaseTransaction,
    input: { readonly name: string; readonly parentId: string | null },
    command: CommandContext,
  ): Promise<string> {
    const businessId = requireBusiness(command.context);
    const tree = await lockTree(trx, businessId, kind);
    if (tree.rows.length >= MESSAGE_TEMPLATE_FOLDER_LIMIT)
      throw new ConflictError(`A business keeps at most 500 ${event} folders.`);
    const parentId = place(tree, input.parentId, kind);
    if (tree.depth(parentId) + 1 > MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH) throw deep(noun);
    if (tree.nameTaken(parentId, await normalizeName(trx, input.name))) throw taken();
    const { id } = await trx
      .insertInto('messaging.template_folders')
      .values({
        business_id: businessId,
        parent_id: parentId,
        name: input.name,
        kind: kind.kind,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await command.emit({
      type: `${event}.folder_created`,
      subject: { kind: kind.id, id },
      records: [],
      payload: {},
    });
    return id;
  }

  async function update(
    trx: DatabaseTransaction,
    input: {
      readonly id: string;
      readonly revision: number;
      readonly name?: string | undefined;
      readonly parentId?: string | null | undefined;
    },
    command: CommandContext,
  ): Promise<string> {
    const tree = await lockTree(trx, requireBusiness(command.context), kind);
    const folder = writable(tree, input.id, input.revision, kind);
    const parentId =
      input.parentId === undefined ? folder.parent_id : place(tree, input.parentId, kind);
    const name = input.name ?? folder.name;
    if (parentId !== null && tree.within(parentId, folder.id))
      throw new ValidationError([
        {
          path: '/parentId',
          code: 'folder_inside_itself',
          message: 'A folder cannot move into itself or one of its descendants.',
        },
      ]);
    if (tree.depth(parentId) + tree.height(folder.id) > MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH)
      throw deep(noun);
    if (tree.nameTaken(parentId, await normalizeName(trx, name), folder.id)) throw taken();
    const moved = parentId !== folder.parent_id;
    const renamed = name !== folder.name;
    if (!moved && !renamed) return folder.id;
    await trx
      .updateTable('messaging.template_folders')
      .set({ parent_id: parentId, name, revision: folder.revision + 1 })
      .where('id', '=', folder.id)
      .execute();
    await command.emit({
      type: `${event}.folder_updated`,
      subject: { kind: kind.id, id: folder.id },
      records: [],
      payload: { moved, renamed },
    });
    return folder.id;
  }

  async function remove(
    trx: DatabaseTransaction,
    input: { readonly id: string; readonly revision: number },
    command: CommandContext,
  ): Promise<undefined> {
    const tree = await lockTree(trx, requireBusiness(command.context), kind);
    const folder = writable(tree, input.id, input.revision, kind);
    const children = tree.rows.filter((row) => row.parent_id === folder.id);
    if (
      children.some(
        (child) =>
          child.name_normalized !== null &&
          tree.nameTaken(folder.parent_id, child.name_normalized, folder.id),
      )
    )
      throw taken();
    // A child may reuse the removed parent's name. Check uniqueness after that
    // parent has gone, within the same locked transaction, rather than renaming assets.
    await sql`set constraints messaging.template_folders_name_unique deferred`.execute(trx);
    await trx
      .updateTable('messaging.template_folders')
      .set({ parent_id: folder.parent_id, revision: sql`revision + 1` })
      .where('parent_id', '=', folder.id)
      .execute();
    // What the folder held moves to its parent. Only one of the two tables can hold
    // anything in a folder of this kind (0088), so both are asked.
    await trx
      .updateTable('messaging.templates')
      .set({ folder_id: folder.parent_id })
      .where('folder_id', '=', folder.id)
      .execute();
    await trx
      .updateTable('messaging.email_campaigns')
      .set({ folder_id: folder.parent_id })
      .where('folder_id', '=', folder.id)
      .execute();
    await trx.deleteFrom('messaging.template_folders').where('id', '=', folder.id).execute();
    await sql`set constraints messaging.template_folders_name_unique immediate`.execute(trx);
    await command.emit({
      type: `${event}.folder_removed`,
      subject: { kind: kind.id, id: folder.id },
      records: [],
      payload: { relocatedFolders: children.length },
    });
    return undefined;
  }

  return { create, update, remove };
}

export interface TemplateFolderCommands {
  readonly create: Command<typeof createMessageTemplateFolderInput, MessageTemplateFolder>;
  readonly update: Command<typeof updateInput, MessageTemplateFolder>;
  readonly remove: Command<typeof removeInput, undefined>;
}

/** Canonical authoring commands; topology checks and their writes share a tenant lock. */
export function createTemplateFolderCommands(): TemplateFolderCommands {
  const writes = treeWrites(TEMPLATES);
  const create = defineCommand({
    name: 'template.create_folder',
    permission: TEMPLATES.permission,
    input: createMessageTemplateFolderInput,
    handle: async (trx, input, command) =>
      readFolder(trx, command, await writes.create(trx, input, command)),
  });
  const update = defineCommand({
    name: 'template.update_folder',
    permission: TEMPLATES.permission,
    input: updateInput,
    handle: async (trx, input, command) =>
      readFolder(trx, command, await writes.update(trx, input, command)),
  });
  const remove = defineCommand({
    name: 'template.remove_folder',
    permission: TEMPLATES.permission,
    input: removeInput,
    handle: (trx, input, command) => writes.remove(trx, input, command),
  });
  return { create, update, remove };
}

const updateCampaignFolderInput = updateEmailCampaignFolderInput.safeExtend({
  id: publicId('email_campaign_folder'),
});
const removeCampaignFolderInput = emailCampaignRevisionInput.extend({
  id: publicId('email_campaign_folder'),
});

export interface CampaignFolderCommands {
  readonly create: Command<typeof createEmailCampaignFolderInput, EmailCampaignFolder>;
  readonly update: Command<typeof updateCampaignFolderInput, EmailCampaignFolder>;
  readonly remove: Command<typeof removeCampaignFolderInput, undefined>;
}

/** The same tree for email campaigns, kept apart from the templates' by its kind. */
export function createCampaignFolderCommands(): CampaignFolderCommands {
  const writes = treeWrites(CAMPAIGNS);
  const create = defineCommand({
    name: 'campaign.create_folder',
    permission: CAMPAIGNS.permission,
    input: createEmailCampaignFolderInput,
    handle: async (trx, input, command) =>
      readCampaignFolder(trx, command, await writes.create(trx, input, command)),
  });
  const update = defineCommand({
    name: 'campaign.update_folder',
    permission: CAMPAIGNS.permission,
    input: updateCampaignFolderInput,
    handle: async (trx, input, command) =>
      readCampaignFolder(trx, command, await writes.update(trx, input, command)),
  });
  const remove = defineCommand({
    name: 'campaign.remove_folder',
    permission: CAMPAIGNS.permission,
    input: removeCampaignFolderInput,
    handle: (trx, input, command) => writes.remove(trx, input, command),
  });
  return { create, update, remove };
}
