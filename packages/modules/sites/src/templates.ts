// The template library: the templates that ship with the product, the agency's ("Shared
// with me") and the business's own ("My templates"), read through one list with the filters
// the library shows. A template is a copy: saving one reads its source once, and nothing
// that happens to the source afterwards reaches it.
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  createSiteTemplateInput,
  deleteSiteTemplate,
  setSiteTemplateFavorite,
  setSiteTemplateFavoriteInput,
  SITE_TEMPLATE_LIMITS,
  updateSiteTemplate,
  updateSiteTemplateInput,
  type ListSiteTemplatesQuery,
  type SiteTemplate,
  type SiteTemplateContent,
  type SiteTemplateKind,
  type SiteTemplateList,
  type SiteTemplateSummary,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
} from '@repo/kernel';
import { sql } from 'kysely';

import { BUILT_IN_TEMPLATES, builtInTemplate, type BuiltInTemplate } from './builtin-templates.js';
import { readableContent, readSiteContent, readStepContent } from './copies.js';
import { remapSection } from './remap.js';
import { kindOf, requirePage, requireSite, requireStep, versionDocument } from './rows.js';
import {
  asJson,
  invalid,
  madeBy,
  may,
  requireRevision,
  serializeAdditions,
  several,
  uuidOf,
} from './support.js';

const templateKind = (kind: string): SiteTemplateKind =>
  kind === 'website' || kind === 'step' || kind === 'section' ? kind : 'funnel';

/** When the product's own templates were written: they have no row to say. */
const SHIPPED = '2026-10-11T00:00:00.000Z';

const stepsIn = (content: SiteTemplateContent): number =>
  content.kind === 'section' ? 0 : content.kind === 'step' ? 1 : content.steps.length;

interface TemplateRow {
  readonly id: string;
  readonly business_id: string | null;
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly category: string | null;
  readonly page_type: string | null;
  readonly tags: string[];
  readonly colors: string[];
  readonly preview_file_id: string | null;
  readonly uses: number;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly step_count: number;
}

const COLUMNS = [
  'id',
  'business_id',
  'kind',
  'name',
  'description',
  'category',
  'page_type',
  'tags',
  'colors',
  'preview_file_id',
  'uses',
  'revision',
  'created_at',
  'updated_at',
] as const;

const stepCount = sql<number>`case kind when 'section' then 0 when 'step' then 1
  else jsonb_array_length(content -> 'steps') end`.as('step_count');

/** Who may change a template: its business with sites.manage, the agency's with sites.share. */
const mayChange = (invocation: Invocation, row: { business_id: string | null }): boolean =>
  may(invocation, row.business_id === null ? 'sites.share' : 'sites.manage');

const fromRow = (
  row: TemplateRow,
  invocation: Invocation,
  favorites: ReadonlySet<string>,
): SiteTemplateSummary => ({
  id: toPublicId('site_template', row.id),
  kind: templateKind(row.kind),
  scope: row.business_id === null ? 'agency' : 'business',
  name: row.name,
  description: row.description,
  category: row.category,
  pageType: row.page_type,
  tags: row.tags,
  colors: row.colors,
  previewFileId: row.preview_file_id === null ? null : toPublicId('file', row.preview_file_id),
  stepCount: row.step_count,
  uses: row.uses,
  favorite: favorites.has(row.id),
  canManage: mayChange(invocation, row),
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const fromBuiltIn = (
  template: BuiltInTemplate,
  favorites: ReadonlySet<string>,
  uses: number,
): SiteTemplateSummary => ({
  id: toPublicId('site_template', template.id),
  kind: template.kind,
  scope: 'builtin',
  name: template.name,
  description: template.description,
  category: template.category,
  pageType: template.pageType,
  tags: [...template.tags],
  colors: [...template.colors],
  previewFileId: null,
  stepCount: stepsIn(template.content),
  uses,
  favorite: favorites.has(template.id),
  canManage: false,
  revision: 1,
  createdAt: SHIPPED,
  updatedAt: SHIPPED,
});

/** The caller's favourites in this business. A machine has none. */
async function favoritesOf(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<ReadonlySet<string>> {
  const { userId } = invocation.context;
  if (userId === undefined) return new Set();
  const rows = await trx
    .selectFrom('sites.template_favorites')
    .select('template_id')
    .where('user_id', '=', userId)
    .execute();
  return new Set(rows.map((row) => row.template_id));
}

/** How often this business used each of the product's templates of a kind. */
async function builtInUses(
  trx: DatabaseTransaction,
  kind: SiteTemplateKind,
): Promise<ReadonlyMap<string, number>> {
  if (kind === 'section') return new Map();
  const rows =
    kind === 'step'
      ? await trx
          .selectFrom('sites.steps as t')
          .innerJoin('sites.sites as s', (join) =>
            join.onRef('s.business_id', '=', 't.business_id').onRef('s.id', '=', 't.site_id'),
          )
          .select(['t.origin_template_id as id', (eb) => eb.fn.countAll<string>().as('uses')])
          .where('t.origin_template_id', 'is not', null)
          // A step that arrived with a whole funnel is that funnel's use, not a step's.
          .where(sql<boolean>`s.origin_template_id is distinct from t.origin_template_id`)
          .groupBy('t.origin_template_id')
          .execute()
      : await trx
          .selectFrom('sites.sites')
          .select(['origin_template_id as id', (eb) => eb.fn.countAll<string>().as('uses')])
          .where('origin_template_id', 'is not', null)
          .where('origin_site_id', 'is', null)
          .groupBy('origin_template_id')
          .execute();
  return new Map(rows.map((row) => [row.id ?? '', Number(row.uses)]));
}

const facet = (values: readonly (string | null)[]) => {
  const counts = new Map<string, number>();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => left.value.localeCompare(right.value, 'en'));
};

const offsetOf = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw invalid('/after', 'invalid_cursor', 'Start from the next a page of this list gave.');
  return offset;
};

/**
 * A page of the templates of a kind. The library of one business is small (its own, its
 * agency's and the product's), so the filters, the order and the pages are worked out over
 * the whole of it, which also gives the filters their counts.
 */
export async function readSiteTemplates(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListSiteTemplatesQuery,
): Promise<SiteTemplateList> {
  const businessId = requireBusiness(invocation.context);
  const favorites = await favoritesOf(trx, invocation);
  let stored = trx
    .selectFrom('sites.templates')
    .select([...COLUMNS, stepCount])
    .where('kind', '=', query.kind);
  if (query.list === 'mine') stored = stored.where('business_id', '=', businessId);
  if (query.list === 'shared') stored = stored.where('business_id', 'is', null);
  const rows = await stored.execute();
  const uses: ReadonlyMap<string, number> =
    query.list === 'mine' || query.list === 'shared'
      ? new Map<string, number>()
      : await builtInUses(trx, query.kind);
  const all: SiteTemplateSummary[] = [
    ...(query.list === 'mine' || query.list === 'shared'
      ? []
      : BUILT_IN_TEMPLATES.filter((template) => template.kind === query.kind).map((template) =>
          fromBuiltIn(template, favorites, uses.get(template.id) ?? 0),
        )),
    ...rows.map((row) => fromRow(row, invocation, favorites)),
  ].filter((template) => query.list !== 'favorites' || template.favorite);

  const categories = several(query.category).map((value) => value.toLowerCase());
  const types = several(query.type).map((value) => value.toLowerCase());
  const tags = several(query.tag).map((value) => value.toLowerCase());
  const q = query.q?.toLowerCase() ?? '';
  const matching = all.filter(
    (template) =>
      (categories.length === 0 || categories.includes(template.category?.toLowerCase() ?? '')) &&
      (types.length === 0 || types.includes(template.pageType?.toLowerCase() ?? '')) &&
      (tags.length === 0 || template.tags.some((tag) => tags.includes(tag.toLowerCase()))) &&
      (q === '' || template.name.toLowerCase().includes(q)),
  );
  matching.sort((left, right) =>
    query.sort === 'popular' && left.uses !== right.uses
      ? right.uses - left.uses
      : left.createdAt === right.createdAt
        ? left.id < right.id
          ? -1
          : 1
        : left.createdAt < right.createdAt
          ? 1
          : -1,
  );
  const offset = offsetOf(query.after);
  const end = offset + query.limit;
  return {
    items: matching.slice(offset, end),
    total: matching.length,
    next: end < matching.length ? Buffer.from(String(end)).toString('base64url') : null,
    facets: {
      categories: facet(all.map((template) => template.category)),
      types: facet(all.map((template) => template.pageType)),
      tags: facet(all.flatMap((template) => template.tags)),
    },
    canManage: may(invocation, 'sites.manage'),
    canShare: may(invocation, 'sites.share'),
  };
}

async function requireTemplate(
  trx: DatabaseTransaction,
  publicId: string,
  lock = false,
): Promise<TemplateRow & { content: unknown }> {
  let query = trx
    .selectFrom('sites.templates')
    .select([...COLUMNS, 'content', stepCount])
    .where('id', '=', uuidOf('site_template', publicId));
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Template', publicId);
  return row;
}

/** One template as the caller sees it: the product's, the agency's or the business's. */
async function readSummary(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<{ summary: SiteTemplateSummary; content: SiteTemplateContent }> {
  requireBusiness(invocation.context);
  const favorites = await favoritesOf(trx, invocation);
  const builtIn = builtInTemplate(parsePublicId('site_template', publicId) ?? '');
  if (builtIn !== undefined) {
    const uses = await builtInUses(trx, builtIn.kind);
    return {
      summary: fromBuiltIn(builtIn, favorites, uses.get(builtIn.id) ?? 0),
      content: builtIn.content,
    };
  }
  const row = await requireTemplate(trx, publicId);
  return { summary: fromRow(row, invocation, favorites), content: readableContent(row.content) };
}

/** One template with its content. */
export async function readSiteTemplate(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<SiteTemplate> {
  const { summary, content } = await readSummary(trx, invocation, publicId);
  return { ...summary, content };
}

/** A file that is not this agency's, named as a template's preview. */
function explainMissingFile(error: unknown): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23503' &&
    (error as { constraint?: unknown }).constraint === 'templates_preview_file'
  )
    throw invalid('/previewFileId', 'invalid_file', 'Choose a file of this business.');
  throw error;
}

const fileOf = (publicId: string | null): string | null =>
  publicId === null ? null : uuidOf('file', publicId);

export const createSiteTemplateCommand = defineCommand({
  name: 'site_template.create',
  permission: 'sites.manage',
  input: createSiteTemplateInput,
  async handle(trx, input, command): Promise<SiteTemplate> {
    const businessId = requireBusiness(command.context);
    // A template for the whole agency is the agency's to share.
    if (input.scope === 'agency' && !may(command, 'sites.share'))
      throw new ForbiddenError('You may not save templates for the whole agency.', 'sites.share');
    await serializeAdditions(trx, businessId, 'templates');
    const { count } = await trx
      .selectFrom('sites.templates')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('business_id', '=', businessId)
      .executeTakeFirstOrThrow();
    if (input.scope === 'business' && Number(count) >= SITE_TEMPLATE_LIMITS.templates)
      throw invalid(
        '/name',
        'limit_reached',
        `A business can have at most ${String(SITE_TEMPLATE_LIMITS.templates)} templates. Delete one first.`,
      );
    let content: SiteTemplateContent;
    if (input.source.type === 'site') {
      const site = await requireSite(trx, input.source.siteId);
      content = await readSiteContent(
        trx,
        { id: site.id, kind: kindOf(site.kind) },
        { universal: true },
      );
    } else if (input.source.type === 'step') {
      const step = await requireStep(trx, input.source.stepId);
      content = await readStepContent(trx, step.id);
    } else {
      const page = await requirePage(trx, input.source.pageId);
      const { document } = await versionDocument(trx, page.id, page.current_version);
      const wanted = input.source.sectionId;
      const section =
        document.mode === 'visual'
          ? document.sections.find((each) => each.type === 'section' && each.id === wanted)
          : undefined;
      if (section?.type !== 'section')
        throw invalid('/source/sectionId', 'invalid_section', 'This page has no such section.');
      // On another page a button to one of this funnel's steps has nowhere to go.
      content = {
        kind: 'section',
        section: remapSection(section, { steps: new Map(), sections: new Map() }),
      };
    }
    const row = await trx
      .insertInto('sites.templates')
      .values({
        agency_id: command.context.agencyId,
        business_id: input.scope === 'agency' ? null : businessId,
        kind: content.kind,
        name: input.name,
        description: input.description,
        category: input.category,
        page_type: input.pageType,
        tags: input.tags,
        colors: input.colors,
        preview_file_id: fileOf(input.previewFileId),
        format: 1,
        content: asJson(content),
        ...madeBy(command),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(explainMissingFile);
    await command.emit({
      type: 'site_template.created',
      subject: { kind: 'site_template', id: row.id },
      payload: { name: input.name, kind: content.kind, scope: input.scope },
    });
    return readSiteTemplate(trx, command, toPublicId('site_template', row.id));
  },
});

/** A stored template the caller may change, held. The product's own are never changed. */
async function changeable(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<TemplateRow> {
  if (builtInTemplate(parsePublicId('site_template', publicId) ?? '') !== undefined)
    throw new ConflictError('A template that ships with the product cannot be changed.');
  const row = await requireTemplate(trx, publicId, true);
  if (!mayChange(invocation, row))
    throw new ForbiddenError('You may not change the agency’s templates.', 'sites.share');
  return row;
}

export const updateSiteTemplateCommand = defineCommand({
  name: 'site_template.update',
  permission: 'sites.manage',
  input: updateSiteTemplateInput.extend(updateSiteTemplate.params.shape),
  async handle(trx, input, command): Promise<SiteTemplate> {
    requireBusiness(command.context);
    const current = await changeable(trx, command, input.id);
    requireRevision(current.revision, input.revision, 'template');
    await trx
      .updateTable('sites.templates')
      .set({
        revision: current.revision + 1,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.pageType === undefined ? {} : { page_type: input.pageType }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.colors === undefined ? {} : { colors: input.colors }),
        ...(input.previewFileId === undefined
          ? {}
          : { preview_file_id: fileOf(input.previewFileId) }),
      })
      .where('id', '=', current.id)
      .execute()
      .catch(explainMissingFile);
    await command.emit({
      type: 'site_template.updated',
      subject: { kind: 'site_template', id: current.id },
      payload: { name: input.name ?? current.name },
    });
    return readSiteTemplate(trx, command, input.id);
  },
});

export const deleteSiteTemplateCommand = defineCommand({
  name: 'site_template.delete',
  permission: 'sites.manage',
  input: deleteSiteTemplate.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await changeable(trx, command, input.id);
    await trx.deleteFrom('sites.templates').where('id', '=', current.id).execute();
    await trx
      .deleteFrom('sites.template_favorites')
      .where('template_id', '=', current.id)
      .execute();
    await command.emit({
      type: 'site_template.deleted',
      subject: { kind: 'site_template', id: current.id },
      payload: { name: current.name, kind: templateKind(current.kind) },
    });
  },
});

export const setSiteTemplateFavoriteCommand = defineCommand({
  name: 'site_template.set_favorite',
  permission: 'sites.manage',
  input: setSiteTemplateFavoriteInput.extend(setSiteTemplateFavorite.params.shape),
  async handle(trx, input, command): Promise<SiteTemplateSummary> {
    const businessId = requireBusiness(command.context);
    const { userId } = command.context;
    if (userId === undefined) throw new ConflictError('Favourites belong to a person.');
    // Read first: a template of another business is the same error as none.
    const { summary } = await readSummary(trx, command, input.id);
    const templateId = uuidOf('site_template', input.id);
    if (input.favorite)
      await trx
        .insertInto('sites.template_favorites')
        .values({ business_id: businessId, user_id: userId, template_id: templateId })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
    else
      await trx
        .deleteFrom('sites.template_favorites')
        .where('user_id', '=', userId)
        .where('template_id', '=', templateId)
        .execute();
    return { ...summary, favorite: input.favorite };
  },
});
