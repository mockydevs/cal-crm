// Saved sections: a section pages refer to instead of holding a copy, so one change shows
// everywhere it is used. With no site it is the business's own (a header on every funnel
// and website); with a site it is that site's alone. A section that a page's newest or live
// version uses cannot be deleted.
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  createSiteSectionInput,
  deleteSiteSection,
  pageSectionStepIds,
  updateSiteSection,
  updateSiteSectionInput,
  type PageSection,
  type SiteSection,
  type SiteSectionList,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { requireRoomForSections } from './copies.js';
import { requireSite } from './rows.js';
import { asJson, invalid, madeBy, may, requireRevision, uuidOf } from './support.js';

const uniqueErrors = explainUniqueViolation({
  saved_sections_name_unique: () =>
    invalid('/name', 'taken', 'A saved section with this name already exists here.'),
});

const COLUMNS = [
  'id',
  'site_id',
  'name',
  'document',
  'revision',
  'created_at',
  'updated_at',
] as const;

interface SectionRow {
  readonly id: string;
  readonly site_id: string | null;
  readonly name: string;
  readonly document: unknown;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const asSection = (row: SectionRow): SiteSection => ({
  id: toPublicId('site_section', row.id),
  siteId: row.site_id === null ? null : toPublicId('site', row.site_id),
  name: row.name,
  // Written through the schema on every save; read back as that type.
  document: row.document as PageSection,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

async function requireSection(
  trx: DatabaseTransaction,
  publicId: string,
  lock = false,
): Promise<SectionRow> {
  let query = trx
    .selectFrom('sites.saved_sections')
    .select(COLUMNS)
    .where('id', '=', uuidOf('site_section', publicId));
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Saved section', publicId);
  return row;
}

/** The business's own saved sections and, when a site is named, that site's too. */
export async function readSiteSections(
  trx: DatabaseTransaction,
  invocation: Invocation,
  sitePublicId: string | undefined,
): Promise<SiteSectionList> {
  requireBusiness(invocation.context);
  const site = sitePublicId === undefined ? undefined : await requireSite(trx, sitePublicId);
  const rows = await trx
    .selectFrom('sites.saved_sections')
    .select(COLUMNS)
    .where((eb) =>
      site === undefined
        ? eb('site_id', 'is', null)
        : eb.or([eb('site_id', 'is', null), eb('site_id', '=', site.id)]),
    )
    .orderBy('name_normalized')
    .orderBy('id')
    .execute();
  return { items: rows.map(asSection), canManage: may(invocation, 'sites.manage') };
}

/**
 * A section's actions may go to steps of the site it belongs to. A section of the whole
 * business is on many sites, so it can name no step at all.
 */
async function requireSteps(
  trx: DatabaseTransaction,
  siteId: string | null,
  document: PageSection,
): Promise<void> {
  const stepIds = pageSectionStepIds(document);
  if (stepIds.length === 0) return;
  if (siteId === null)
    throw invalid(
      '/document',
      'invalid_step',
      'A section of the whole business cannot go to a step of one site.',
    );
  const found = await trx
    .selectFrom('sites.steps')
    .select('id')
    .where('site_id', '=', siteId)
    .where(
      'id',
      'in',
      stepIds.flatMap((id) => parsePublicId('site_step', id) ?? []),
    )
    .execute();
  if (found.length !== stepIds.length)
    throw invalid('/document', 'invalid_step', 'An action goes to a step this site does not have.');
}

export const createSiteSectionCommand = defineCommand({
  name: 'site_section.create',
  permission: 'sites.manage',
  input: createSiteSectionInput,
  audit: ({ document, ...rest }) => ({ ...rest, size: JSON.stringify(document).length }),
  async handle(trx, input, command): Promise<SiteSection> {
    const businessId = requireBusiness(command.context);
    const site = input.siteId === null ? undefined : await requireSite(trx, input.siteId);
    await requireRoomForSections(trx, businessId, 1);
    await requireSteps(trx, site?.id ?? null, input.document);
    const row = await trx
      .insertInto('sites.saved_sections')
      .values({
        business_id: businessId,
        site_id: site?.id ?? null,
        name: input.name,
        format: 1,
        document: asJson(input.document),
        ...madeBy(command),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'site_section.created',
      subject: { kind: 'site_section', id: row.id },
      payload: { name: input.name, siteId: input.siteId },
    });
    return asSection(await requireSection(trx, toPublicId('site_section', row.id)));
  },
});

export const updateSiteSectionCommand = defineCommand({
  name: 'site_section.update',
  permission: 'sites.manage',
  input: updateSiteSectionInput.extend(updateSiteSection.params.shape),
  audit: ({ document, ...rest }) => ({ ...rest, size: JSON.stringify(document).length }),
  async handle(trx, input, command): Promise<SiteSection> {
    requireBusiness(command.context);
    const current = await requireSection(trx, input.id, true);
    requireRevision(current.revision, input.revision, 'saved section');
    await requireSteps(trx, current.site_id, input.document);
    await trx
      .updateTable('sites.saved_sections')
      .set({
        name: input.name,
        document: asJson(input.document),
        revision: current.revision + 1,
      })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'site_section.updated',
      subject: { kind: 'site_section', id: current.id },
      payload: { name: input.name },
    });
    return asSection(await requireSection(trx, input.id));
  },
});

export const deleteSiteSectionCommand = defineCommand({
  name: 'site_section.delete',
  permission: 'sites.manage',
  input: deleteSiteSection.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireSection(trx, input.id, true);
    // A page's newest version is what the editor opens; its live one is what visitors see.
    const reference = JSON.stringify({
      sections: [{ type: 'saved_section', sectionId: toPublicId('site_section', current.id) }],
    });
    const used = await sql<{ used: boolean }>`
      select exists (
        select 1 from sites.pages p
        join sites.page_versions v on v.business_id = p.business_id and v.page_id = p.id
          and (v.number = p.current_version or v.number = p.published_version)
        where v.document @> ${reference}::jsonb
      ) as used
    `.execute(trx);
    if (used.rows[0]?.used === true)
      throw new ConflictError('A page still uses this section. Take it off the page first.');
    await trx.deleteFrom('sites.saved_sections').where('id', '=', current.id).execute();
    await command.emit({
      type: 'site_section.deleted',
      subject: { kind: 'site_section', id: current.id },
      payload: { name: current.name },
    });
  },
});
