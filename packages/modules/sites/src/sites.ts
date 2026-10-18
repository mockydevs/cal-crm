// Funnels and websites and their folders: the lists, a site with its settings and steps,
// and creating, changing, copying and deleting one. A deleted site is gone for good with
// everything under it, as every record outside the CRM's trash is.
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  cloneSite,
  cloneSiteInput,
  createSiteFolderInput,
  createSiteInput,
  deleteSite,
  deleteSiteFolder,
  setSiteSecurityHeaders,
  setSiteSecurityHeadersInput,
  SITE_LIMITS,
  updateSite,
  updateSiteFolder,
  updateSiteFolderInput,
  updateSiteInput,
  type ListSitesQuery,
  type Site,
  type SiteFolder,
  type SiteFolderList,
  type SiteKind,
  type SiteList,
  type SiteSummary,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';

import { addSteps, readSiteContent, useTemplate } from './copies.js';
import {
  homeStepOf,
  keepArrivalOf,
  kindOf,
  livePath,
  requireSite,
  stepSummaries,
  type SiteRow,
} from './rows.js';
import {
  containing,
  decodeCursor,
  encodeCursor,
  invalid,
  madeBy,
  may,
  requireRevision,
  serializeAdditions,
  uuidOf,
} from './support.js';

const uniqueErrors = explainUniqueViolation({
  folders_name_unique: () => invalid('/name', 'taken', 'A folder with this name already exists.'),
  sites_domain_path_unique: () =>
    invalid('/path', 'taken', 'Another site already answers at this domain and path.'),
});

/** A reference to a row of another module that is not there: the constraint names which. */
function explainMissingReference(error: unknown): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23503' &&
    (error as { constraint?: unknown }).constraint === 'sites_chat_widget'
  )
    throw invalid('/chatWidgetId', 'invalid_widget', 'Choose a chat widget of this business.');
  throw error;
}

// Folders -----------------------------------------------------------------------------------

function folders(trx: DatabaseTransaction) {
  return trx.selectFrom('sites.folders as f').select([
    'f.id',
    'f.kind',
    'f.name',
    'f.revision',
    'f.created_at',
    'f.updated_at',
    sql<string>`(select count(*) from sites.sites s
                 where s.business_id = f.business_id and s.folder_id = f.id)::text`.as(
      'site_count',
    ),
  ]);
}

interface FolderRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly site_count: string;
}

const asFolder = (row: FolderRow): SiteFolder => ({
  id: toPublicId('site_folder', row.id),
  kind: kindOf(row.kind),
  name: row.name,
  siteCount: Number(row.site_count),
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

async function requireFolder(trx: DatabaseTransaction, publicId: string): Promise<FolderRow> {
  const row = await folders(trx)
    .where('f.id', '=', uuidOf('site_folder', publicId))
    .forUpdate('f')
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Folder', publicId);
  return row;
}

/** The folders of funnels, or of websites, by name. */
export async function readSiteFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
  kind: SiteKind,
): Promise<SiteFolderList> {
  requireBusiness(invocation.context);
  const rows = await folders(trx)
    .where('f.kind', '=', kind)
    .orderBy('f.name_normalized')
    .orderBy('f.id')
    .execute();
  return { items: rows.map(asFolder), canManage: may(invocation, 'sites.manage') };
}

export const createSiteFolderCommand = defineCommand({
  name: 'site_folder.create',
  permission: 'sites.manage',
  input: createSiteFolderInput,
  async handle(trx, input, command): Promise<SiteFolder> {
    const businessId = requireBusiness(command.context);
    await serializeAdditions(trx, businessId, `folders:${input.kind}`);
    const { count } = await trx
      .selectFrom('sites.folders')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('kind', '=', input.kind)
      .executeTakeFirstOrThrow();
    if (Number(count) >= SITE_LIMITS.folders)
      throw invalid(
        '/name',
        'limit_reached',
        `A business can have at most ${String(SITE_LIMITS.folders)} folders here. Delete one first.`,
      );
    const row = await trx
      .insertInto('sites.folders')
      .values({ business_id: businessId, kind: input.kind, name: input.name, ...madeBy(command) })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'site_folder.created',
      subject: { kind: 'site_folder', id: row.id },
      payload: { name: input.name, kind: input.kind },
    });
    return asFolder(await requireFolder(trx, toPublicId('site_folder', row.id)));
  },
});

export const updateSiteFolderCommand = defineCommand({
  name: 'site_folder.rename',
  permission: 'sites.manage',
  input: updateSiteFolderInput.extend(updateSiteFolder.params.shape),
  async handle(trx, input, command): Promise<SiteFolder> {
    requireBusiness(command.context);
    const current = await requireFolder(trx, input.id);
    requireRevision(current.revision, input.revision, 'folder');
    await trx
      .updateTable('sites.folders')
      .set({ name: input.name, revision: current.revision + 1 })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'site_folder.renamed',
      subject: { kind: 'site_folder', id: current.id },
      payload: { name: input.name },
    });
    return asFolder(await requireFolder(trx, input.id));
  },
});

export const deleteSiteFolderCommand = defineCommand({
  name: 'site_folder.delete',
  permission: 'sites.manage',
  input: deleteSiteFolder.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireFolder(trx, input.id);
    // The table takes its sites out of it: they stay, in no folder.
    await trx.deleteFrom('sites.folders').where('id', '=', current.id).execute();
    await command.emit({
      type: 'site_folder.deleted',
      subject: { kind: 'site_folder', id: current.id },
      payload: { name: current.name },
    });
  },
});

// Sites -------------------------------------------------------------------------------------

interface ListedRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly folder_id: string | null;
  readonly domain_id: string | null;
  readonly path: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const asSummary = (
  row: ListedRow,
  steps: number,
  domain: { hostname: string; verified: boolean } | undefined,
): SiteSummary => ({
  id: toPublicId('site', row.id),
  kind: kindOf(row.kind),
  name: row.name,
  folderId: row.folder_id === null ? null : toPublicId('site_folder', row.folder_id),
  stepCount: steps,
  domain:
    row.domain_id === null || domain === undefined
      ? null
      : { id: toPublicId('site_domain', row.domain_id), ...domain },
  path: row.path,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

async function domainsOf(
  trx: DatabaseTransaction,
  ids: readonly (string | null)[],
): Promise<Map<string, { hostname: string; verified: boolean }>> {
  const wanted = [...new Set(ids.flatMap((id) => id ?? []))];
  if (wanted.length === 0) return new Map();
  const rows = await trx
    .selectFrom('sites.domains')
    .select(['id', 'hostname', 'verification_status'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(
    rows.map((row) => [
      row.id,
      { hostname: row.hostname, verified: row.verification_status === 'verified' },
    ]),
  );
}

/** A page of the business's funnels or websites, and how many match. */
export async function readSites(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListSitesQuery,
): Promise<SiteList> {
  requireBusiness(invocation.context);
  const matching = () => {
    let found = trx.selectFrom('sites.sites as s').where('s.kind', '=', query.kind);
    if (query.q !== undefined && query.q !== '')
      found = found.where(sql<SqlBool>`s.name ilike ${containing(query.q)}`);
    if (query.folder === 'none') found = found.where('s.folder_id', 'is', null);
    else if (query.folder !== undefined)
      found = found.where('s.folder_id', '=', uuidOf('site_folder', query.folder));
    return found;
  };
  const { total } = await matching()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  // Where a row stands in the order asked for, as text a cursor can carry exactly.
  const place =
    query.sort === 'name' ? sql<string>`s.name_normalized` : sql<string>`s.updated_at::text`;
  let page = matching().select([
    's.id',
    's.kind',
    's.name',
    's.folder_id',
    's.domain_id',
    's.path',
    's.created_at',
    's.updated_at',
    place.as('place'),
    sql<string>`(select count(*) from sites.steps t
                 where t.business_id = s.business_id and t.site_id = s.id)::text`.as('steps'),
  ]);
  if (query.after !== undefined) {
    const [afterPlace, afterId] = decodeCursor(query.after);
    page = page.where(
      query.sort === 'name'
        ? sql<SqlBool>`(s.name_normalized, s.id) > (${afterPlace}, ${afterId}::uuid)`
        : sql<SqlBool>`(s.updated_at, s.id) < (${afterPlace}::timestamptz, ${afterId}::uuid)`,
    );
  }
  page =
    query.sort === 'name'
      ? page.orderBy('s.name_normalized').orderBy('s.id')
      : page.orderBy('s.updated_at', 'desc').orderBy('s.id', 'desc');
  const rows = await page.limit(query.limit + 1).execute();
  const shown = rows.slice(0, query.limit);
  const domains = await domainsOf(
    trx,
    shown.map((row) => row.domain_id),
  );
  const last = shown.at(-1);
  return {
    items: shown.map((row) => asSummary(row, Number(row.steps), domains.get(row.domain_id ?? ''))),
    total: Number(total),
    next:
      rows.length > query.limit && last !== undefined ? encodeCursor(last.place, last.id) : null,
    canManage: may(invocation, 'sites.manage'),
  };
}

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: SiteRow,
): Promise<Site> {
  const steps = await stepSummaries(trx, row.id);
  const headers = await trx
    .selectFrom('sites.security_headers')
    .select(['name', 'value'])
    .where('site_id', '=', row.id)
    .orderBy('name_normalized')
    .execute();
  const domains = await domainsOf(trx, [row.domain_id]);
  return {
    ...asSummary(row, steps.length, domains.get(row.domain_id ?? '')),
    publicKey: row.public_key,
    // The site's own address shows its home step, and answers only while that is published.
    liveUrl:
      typeof homeStepOf(kindOf(row.kind), steps)?.liveUrl === 'string'
        ? livePath(row.public_key)
        : null,
    faviconUrl: row.favicon_url,
    headCode: row.head_code,
    bodyCode: row.body_code,
    chatWidgetId:
      row.chat_widget_id === null ? null : toPublicId('webchat_widget', row.chat_widget_id),
    paymentLive: row.payment_live,
    requireCard: row.require_card,
    optimizeImages: row.optimize_images,
    lazyCustomCode: row.lazy_custom_code,
    privacyFonts: row.privacy_fonts,
    autoSchema: row.auto_schema,
    keepArrival: keepArrivalOf(row.keep_arrival),
    securityHeaders: headers,
    steps,
    originTemplateId:
      row.origin_template_id === null ? null : toPublicId('site_template', row.origin_template_id),
    revision: row.revision,
    canManage: may(invocation, 'sites.manage'),
    canPublish: may(invocation, 'sites.publish'),
    canShare: may(invocation, 'sites.share'),
  };
}

/** One site with its settings and steps, as anyone in the business may read it. */
export async function readSite(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<Site> {
  requireBusiness(invocation.context);
  return present(trx, invocation, await requireSite(trx, publicId));
}

/** Holds the folder a site is to go in. It must be a folder of the site's own kind. */
export async function heldFolder(
  trx: DatabaseTransaction,
  folderId: string | null,
  kind: string,
): Promise<string | null> {
  if (folderId === null) return null;
  const folder = await trx
    .selectFrom('sites.folders')
    .select('id')
    .where('id', '=', uuidOf('site_folder', folderId))
    .where('kind', '=', kind)
    .forShare()
    .executeTakeFirst();
  if (folder === undefined)
    throw invalid('/folderId', 'invalid_folder', 'Choose a folder of this kind in this business.');
  return folder.id;
}

/** Sites one business may have: counted under the lock that serializes adding them. */
export async function requireRoomForSite(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<void> {
  await serializeAdditions(trx, businessId, 'sites');
  const { count } = await trx
    .selectFrom('sites.sites')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  if (Number(count) >= SITE_LIMITS.sites)
    throw invalid(
      '/name',
      'limit_reached',
      `A business can have at most ${String(SITE_LIMITS.sites)} funnels and websites. Delete one first.`,
    );
}

export const createSiteCommand = defineCommand({
  name: 'site.create',
  permission: 'sites.manage',
  input: createSiteInput,
  async handle(trx, input, command): Promise<Site> {
    const businessId = requireBusiness(command.context);
    await requireRoomForSite(trx, businessId);
    const folderId = await heldFolder(trx, input.folderId, input.kind);
    // A funnel is started from a funnel template and a website from a website template.
    const template =
      input.templateId === undefined
        ? undefined
        : await useTemplate(trx, input.templateId, [input.kind]);
    const row = await trx
      .insertInto('sites.sites')
      .values({
        business_id: businessId,
        kind: input.kind,
        name: input.name,
        folder_id: folderId,
        origin_template_id: template?.id ?? null,
        ...madeBy(command),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (template !== undefined)
      await addSteps(trx, command, { businessId, id: row.id, kind: input.kind }, template.content, {
        originTemplateId: template.id,
      });
    await command.emit({
      type: 'site.created',
      subject: { kind: 'site', id: row.id },
      payload: {
        name: input.name,
        kind: input.kind,
        ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
      },
    });
    return readSite(trx, command, toPublicId('site', row.id));
  },
});

export const updateSiteCommand = defineCommand({
  name: 'site.update',
  permission: 'sites.manage',
  input: updateSiteInput.extend(updateSite.params.shape),
  // The audit log keeps which settings changed, not the code a site carries.
  audit: ({ headCode, bodyCode, ...rest }) => ({
    ...rest,
    ...(headCode === undefined ? {} : { headCodeLength: headCode.length }),
    ...(bodyCode === undefined ? {} : { bodyCodeLength: bodyCode.length }),
  }),
  async handle(trx, input, command): Promise<Site> {
    requireBusiness(command.context);
    const current = await requireSite(trx, input.id, true);
    requireRevision(current.revision, input.revision, 'site');
    const folderId =
      input.folderId === undefined
        ? undefined
        : await heldFolder(trx, input.folderId, current.kind);
    let domainId: string | null | undefined;
    if (input.domainId !== undefined) {
      domainId = null;
      if (input.domainId !== null) {
        const domain = await trx
          .selectFrom('sites.domains')
          .select('id')
          .where('id', '=', uuidOf('site_domain', input.domainId))
          .forShare()
          .executeTakeFirst();
        if (domain === undefined)
          throw invalid('/domainId', 'invalid_domain', 'Choose a domain of this business.');
        domainId = domain.id;
      }
    }
    const chatWidgetId =
      input.chatWidgetId === undefined
        ? undefined
        : input.chatWidgetId === null
          ? null
          : (parsePublicId('webchat_widget', input.chatWidgetId) ?? null);
    await trx
      .updateTable('sites.sites')
      .set({
        revision: current.revision + 1,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(folderId === undefined ? {} : { folder_id: folderId }),
        ...(domainId === undefined ? {} : { domain_id: domainId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.faviconUrl === undefined ? {} : { favicon_url: input.faviconUrl }),
        ...(input.headCode === undefined ? {} : { head_code: input.headCode }),
        ...(input.bodyCode === undefined ? {} : { body_code: input.bodyCode }),
        ...(chatWidgetId === undefined ? {} : { chat_widget_id: chatWidgetId }),
        ...(input.paymentLive === undefined ? {} : { payment_live: input.paymentLive }),
        ...(input.requireCard === undefined ? {} : { require_card: input.requireCard }),
        ...(input.optimizeImages === undefined ? {} : { optimize_images: input.optimizeImages }),
        ...(input.lazyCustomCode === undefined ? {} : { lazy_custom_code: input.lazyCustomCode }),
        ...(input.privacyFonts === undefined ? {} : { privacy_fonts: input.privacyFonts }),
        ...(input.autoSchema === undefined ? {} : { auto_schema: input.autoSchema }),
        ...(input.keepArrival === undefined ? {} : { keep_arrival: input.keepArrival }),
      })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors)
      .catch(explainMissingReference);
    await command.emit({
      type: 'site.updated',
      subject: { kind: 'site', id: current.id },
      // Which settings changed, by name: never the code a site carries.
      payload: { changed: Object.keys(input).filter((key) => key !== 'id' && key !== 'revision') },
    });
    return readSite(trx, command, input.id);
  },
});

export const setSiteSecurityHeadersCommand = defineCommand({
  name: 'site.set_security_headers',
  permission: 'sites.manage',
  input: setSiteSecurityHeadersInput.extend(setSiteSecurityHeaders.params.shape),
  async handle(trx, input, command): Promise<Site> {
    const businessId = requireBusiness(command.context);
    const current = await requireSite(trx, input.id, true);
    requireRevision(current.revision, input.revision, 'site');
    await trx.deleteFrom('sites.security_headers').where('site_id', '=', current.id).execute();
    if (input.headers.length > 0)
      await trx
        .insertInto('sites.security_headers')
        .values(
          input.headers.map((header) => ({
            business_id: businessId,
            site_id: current.id,
            name: header.name,
            value: header.value,
          })),
        )
        .execute();
    await trx
      .updateTable('sites.sites')
      .set({ revision: current.revision + 1 })
      .where('id', '=', current.id)
      .execute();
    await command.emit({
      type: 'site.security_headers_set',
      subject: { kind: 'site', id: current.id },
      payload: { headers: input.headers.map((header) => header.name) },
    });
    return readSite(trx, command, input.id);
  },
});

export const deleteSiteCommand = defineCommand({
  name: 'site.delete',
  permission: 'sites.manage',
  input: deleteSite.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireSite(trx, input.id, true);
    // The table takes its steps, pages, versions, statistics, headers, its own saved
    // sections and the redirects that point at it.
    await trx.deleteFrom('sites.sites').where('id', '=', current.id).execute();
    await command.emit({
      type: 'site.deleted',
      subject: { kind: 'site', id: current.id },
      payload: { name: current.name, kind: kindOf(current.kind) },
    });
  },
});

/** A name for a copy: the source's with "(copy)", within the length a name may have. */
export const copyName = (name: string): string => `${name.slice(0, 113)} (copy)`;

export const cloneSiteCommand = defineCommand({
  name: 'site.clone',
  permission: 'sites.manage',
  input: cloneSiteInput.extend(cloneSite.params.shape),
  async handle(trx, input, command): Promise<Site> {
    const businessId = requireBusiness(command.context);
    await requireRoomForSite(trx, businessId);
    const source = await requireSite(trx, input.id);
    const kind = kindOf(source.kind);
    const row = await trx
      .insertInto('sites.sites')
      .values({
        business_id: businessId,
        kind,
        name: input.name ?? copyName(source.name),
        folder_id: source.folder_id,
        // The address stays the source's alone; everything else comes along.
        favicon_url: source.favicon_url,
        head_code: source.head_code,
        body_code: source.body_code,
        chat_widget_id: source.chat_widget_id,
        payment_live: source.payment_live,
        require_card: source.require_card,
        optimize_images: source.optimize_images,
        lazy_custom_code: source.lazy_custom_code,
        privacy_fonts: source.privacy_fonts,
        auto_schema: source.auto_schema,
        keep_arrival: source.keep_arrival,
        origin_site_id: source.id,
        origin_template_id: source.origin_template_id,
        ...madeBy(command),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      insert into sites.security_headers (business_id, site_id, name, value)
      select business_id, ${row.id}::uuid, name, value
      from sites.security_headers where site_id = ${source.id}
    `.execute(trx);
    const steps = await trx
      .selectFrom('sites.steps')
      .select('id')
      .where('site_id', '=', source.id)
      .limit(1)
      .execute();
    if (steps.length > 0)
      await addSteps(
        trx,
        command,
        { businessId, id: row.id, kind },
        await readSiteContent(trx, { id: source.id, kind }, { universal: false }),
        { originSteps: true, keepSections: true },
      );
    await command.emit({
      type: 'site.cloned',
      subject: { kind: 'site', id: row.id },
      payload: { from: toPublicId('site', source.id), kind },
    });
    return readSite(trx, command, toPublicId('site', row.id));
  },
});
