// Copying. A clone, a template, a use of a template and a shared bundle are all the same
// two moves: read a site's steps and saved sections as content, and add content to a site
// as new rows. Nothing is ever linked: the copy has its own steps, pages and sections, its
// pages start unpublished at version 1, and merge fields stay as written.
import type { CommandContext } from '@repo/commands';
import {
  pageDocumentReferences,
  SITE_LIMITS,
  SITE_TEMPLATE_LIMITS,
  siteTemplateContent,
  upgradePageDocument,
  type PageDocument,
  type PageSection,
  type SiteKind,
  type SiteTemplateContent,
  type SiteTemplateKind,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { builtInTemplate } from './builtin-templates.js';
import { remapDocument, remapSection, type Renames } from './remap.js';
import { storedDocument } from './rows.js';
import { asJson, invalid, madeBy, serializeAdditions } from './support.js';

type SiteContent = Extract<SiteTemplateContent, { kind: SiteKind }>;
type CarriedStep = SiteContent['steps'][number];
type CarriedSection = SiteContent['sections'][number];

/** A saved section's document as stored, read back through the schema's own type. */
const storedSection = (stored: unknown): PageSection => stored as PageSection;

/**
 * The saved sections some documents refer to, as content carries them. With
 * `universal: false` the business's own sections are left behind: a copy inside the same
 * business keeps referring to them.
 */
async function carriedSections(
  trx: DatabaseTransaction,
  documents: readonly PageDocument[],
  universal: boolean,
): Promise<CarriedSection[]> {
  const ids = new Set(
    documents.flatMap((document) =>
      pageDocumentReferences(document).sectionIds.flatMap(
        (id) => parsePublicId('site_section', id) ?? [],
      ),
    ),
  );
  if (ids.size === 0) return [];
  const rows = await trx
    .selectFrom('sites.saved_sections')
    .select(['id', 'site_id', 'name', 'document'])
    .where('id', 'in', [...ids])
    .orderBy('id')
    .execute();
  return rows
    .filter((row) => universal || row.site_id !== null)
    .map((row) => ({
      id: toPublicId('site_section', row.id),
      name: row.name,
      scope: row.site_id === null ? ('universal' as const) : ('global' as const),
      document: storedSection(row.document),
    }));
}

/** A site's steps, each with its control page's newest version, and the sections they use. */
export async function readSiteContent(
  trx: DatabaseTransaction,
  site: { readonly id: string; readonly kind: SiteKind },
  options: { readonly universal: boolean },
): Promise<SiteContent> {
  const rows = await trx
    .selectFrom('sites.steps as s')
    .innerJoin('sites.pages as p', (join) =>
      join.onRef('p.business_id', '=', 's.business_id').onRef('p.step_id', '=', 's.id'),
    )
    .innerJoin('sites.page_versions as v', (join) =>
      join
        .onRef('v.business_id', '=', 'p.business_id')
        .onRef('v.page_id', '=', 'p.id')
        .onRef('v.number', '=', 'p.current_version'),
    )
    .select(['s.id', 's.name', 's.path', 'v.document'])
    .where('s.site_id', '=', site.id)
    .where('p.role', '=', 'control')
    .orderBy('s.position')
    .execute();
  if (rows.length === 0)
    throw new ConflictError('This site has no steps yet. Add a step before copying it.');
  const steps: CarriedStep[] = rows.map((row) => ({
    id: toPublicId('site_step', row.id),
    name: row.name,
    path: row.path,
    document: storedDocument(row.document),
  }));
  return {
    kind: site.kind,
    steps,
    sections: await carriedSections(
      trx,
      steps.map((step) => step.document),
      options.universal,
    ),
  };
}

/** One step's control page as a step template holds it. */
export async function readStepContent(
  trx: DatabaseTransaction,
  stepId: string,
): Promise<Extract<SiteTemplateContent, { kind: 'step' }>> {
  const row = await trx
    .selectFrom('sites.pages as p')
    .innerJoin('sites.page_versions as v', (join) =>
      join
        .onRef('v.business_id', '=', 'p.business_id')
        .onRef('v.page_id', '=', 'p.id')
        .onRef('v.number', '=', 'p.current_version'),
    )
    .select('v.document')
    .where('p.step_id', '=', stepId)
    .where('p.role', '=', 'control')
    .executeTakeFirstOrThrow();
  const document = storedDocument(row.document);
  // Outside its funnel a button to another of its steps has nowhere to go.
  const alone = remapDocument(document, {
    steps: new Map(),
    sections: { get: (id: string) => id } as ReadonlyMap<string, string>,
  });
  return { kind: 'step', document: alone, sections: await carriedSections(trx, [alone], true) };
}

/** A new step's first page: its control, at version 1, unpublished. */
export async function addPage(
  trx: DatabaseTransaction,
  command: CommandContext,
  page: {
    readonly businessId: string;
    readonly stepId: string;
    readonly siteId: string;
    readonly siteKind: SiteKind;
    readonly role: 'control' | 'variation';
    readonly weight: number;
    readonly document: PageDocument;
  },
): Promise<string> {
  const row = await trx
    .insertInto('sites.pages')
    .values({
      business_id: page.businessId,
      step_id: page.stepId,
      site_id: page.siteId,
      site_kind: page.siteKind,
      role: page.role,
      weight: page.weight,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('sites.page_versions')
    .values({
      business_id: page.businessId,
      page_id: row.id,
      number: 1,
      format: page.document.format,
      document: asJson(page.document),
      ...madeBy(command),
    })
    .execute();
  return row.id;
}

/** Saved sections one business may have: counted under the lock that serializes adding them. */
export async function requireRoomForSections(
  trx: DatabaseTransaction,
  businessId: string,
  adding: number,
): Promise<void> {
  if (adding === 0) return;
  await serializeAdditions(trx, businessId, 'saved_sections');
  const { count } = await trx
    .selectFrom('sites.saved_sections')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  if (Number(count) + adding > SITE_TEMPLATE_LIMITS.sections)
    throw invalid(
      '',
      'limit_reached',
      `A business can have at most ${String(SITE_TEMPLATE_LIMITS.sections)} saved sections. Delete one first.`,
    );
}

/**
 * Adds content to a site as new steps after the ones it has. The content's saved sections
 * become sections of this site alone, and every reference in the copied pages is renamed
 * to the new rows. `keepSections` names sections that are not copied because the site can
 * already use them (the business's own, in a copy inside the business).
 */
export async function addSteps(
  trx: DatabaseTransaction,
  command: CommandContext,
  site: { readonly businessId: string; readonly id: string; readonly kind: SiteKind },
  content: { readonly steps: readonly CarriedStep[]; readonly sections: readonly CarriedSection[] },
  options: {
    readonly originTemplateId?: string | undefined;
    readonly originSteps?: boolean;
    readonly keepSections?: boolean;
    /** Steps the copy does not bring stay named as they are: a copy inside the same site. */
    readonly keepSteps?: boolean;
  } = {},
): Promise<string[]> {
  const paths = content.steps.map((step) => step.path);
  if (new Set(paths).size !== paths.length)
    throw invalid('/steps', 'duplicate_path', 'Two steps of this copy have the same path.');
  const existing = await trx
    .selectFrom('sites.steps')
    .select(['path', 'position'])
    .where('site_id', '=', site.id)
    .execute();
  if (existing.length + content.steps.length > SITE_LIMITS.steps)
    throw invalid(
      '/steps',
      'limit_reached',
      `A site can have at most ${String(SITE_LIMITS.steps)} steps.`,
    );
  const taken = new Set(existing.map((row) => row.path));
  const clash = paths.find((path) => taken.has(path));
  if (clash !== undefined)
    throw invalid('/path', 'taken', `This site already has a step at ${clash}.`);

  await requireRoomForSections(trx, site.businessId, content.sections.length);
  const sections = new Map<string, string>();
  const madeSections: { id: string; document: PageSection }[] = [];
  // A business's section and a site's may share a name; in the copy both are the site's.
  const names = new Set<string>();
  for (const section of content.sections) {
    let name = section.name;
    for (let n = 2; names.has(name.toLowerCase()); n++)
      name = `${section.name.slice(0, 110)} (${String(n)})`;
    names.add(name.toLowerCase());
    const row = await trx
      .insertInto('sites.saved_sections')
      .values({
        business_id: site.businessId,
        site_id: site.id,
        name,
        format: 1,
        // Rewritten below, once the new steps have ids for its actions to name.
        document: asJson(section.document),
        ...madeBy(command),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    sections.set(section.id, toPublicId('site_section', row.id));
    madeSections.push({ id: row.id, document: section.document });
  }

  const first = existing.reduce((highest, row) => Math.max(highest, row.position + 1), 0);
  const steps = new Map<string, string>();
  const made: { id: string; document: PageDocument }[] = [];
  for (const [index, step] of content.steps.entries()) {
    const row = await trx
      .insertInto('sites.steps')
      .values({
        business_id: site.businessId,
        site_id: site.id,
        name: step.name,
        path: step.path,
        position: first + index,
        origin_step_id:
          options.originSteps === true ? (parsePublicId('site_step', step.id) ?? null) : null,
        origin_template_id: options.originTemplateId ?? null,
        ...madeBy(command),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    steps.set(step.id, toPublicId('site_step', row.id));
    made.push({ id: row.id, document: step.document });
  }

  const renames: Renames = {
    steps:
      options.keepSteps === true
        ? ({ get: (id: string) => steps.get(id) ?? id } as ReadonlyMap<string, string>)
        : steps,
    sections:
      options.keepSections === true
        ? ({ get: (id: string) => sections.get(id) ?? id } as ReadonlyMap<string, string>)
        : sections,
  };
  for (const section of madeSections)
    await trx
      .updateTable('sites.saved_sections')
      .set({ document: asJson(remapSection(section.document, renames)) })
      .where('id', '=', section.id)
      .execute();
  for (const step of made)
    await addPage(trx, command, {
      businessId: site.businessId,
      stepId: step.id,
      siteId: site.id,
      siteKind: site.kind,
      role: 'control',
      weight: 100,
      document: remapDocument(step.document, renames),
    });
  return made.map((step) => step.id);
}

/**
 * A template's content for a use of it, counted as a use. One of another business, or of a
 * kind that cannot be used here, is the same error as none.
 */
export async function useTemplate<Kind extends SiteTemplateKind>(
  trx: DatabaseTransaction,
  publicId: string,
  kinds: readonly Kind[],
): Promise<{ id: string; content: Extract<SiteTemplateContent, { kind: Kind }> }> {
  const id = parsePublicId('site_template', publicId);
  const fits = (
    content: SiteTemplateContent,
  ): content is Extract<SiteTemplateContent, { kind: Kind }> =>
    (kinds as readonly string[]).includes(content.kind);
  const builtIn = id === undefined ? undefined : builtInTemplate(id);
  if (id !== undefined && builtIn !== undefined && fits(builtIn.content))
    return { id, content: builtIn.content };
  const row =
    id === undefined || builtIn !== undefined
      ? undefined
      : await trx
          .updateTable('sites.templates')
          .set({ uses: sql<number>`uses + 1` })
          .where('id', '=', id)
          .where('kind', 'in', [...kinds])
          .returning(['id', 'content'])
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Template', publicId);
  const content = readableContent(row.content);
  if (!fits(content))
    throw new ConflictError('This template was saved in a format this release cannot read.');
  return { id: row.id, content };
}

/**
 * Stored content as this release reads it: each page in it is upgraded to the current
 * document format first, as a stored page version is.
 */
export function readableContent(stored: unknown): SiteTemplateContent {
  let raw = stored;
  if (isRecord(stored)) {
    const steps: unknown = stored['steps'];
    raw = {
      ...stored,
      ...('document' in stored ? { document: upgradeOrKeep(stored['document']) } : {}),
      ...(Array.isArray(steps)
        ? {
            steps: steps.map((step: unknown) =>
              isRecord(step) ? { ...step, document: upgradeOrKeep(step['document']) } : step,
            ),
          }
        : {}),
    };
  }
  const parsed = siteTemplateContent.safeParse(raw);
  if (!parsed.success)
    throw new ConflictError('This template was saved in a format this release cannot read.');
  return parsed.data;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A page upgraded to the current format; one that cannot be is left for the schema to refuse. */
function upgradeOrKeep(document: unknown): unknown {
  try {
    return upgradePageDocument(document);
  } catch {
    return document;
  }
}
