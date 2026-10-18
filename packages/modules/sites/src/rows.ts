// The rows of a site, a step and a page as the commands hold them, and how steps and their
// pages are shown wherever they are listed.
//
// Lock order, for every command of this module: a site, then a step, then a page. A command
// that changes what a site's steps must agree on (their order, their paths, how many there
// are) holds the site's row first.
import {
  pageDocument,
  SITE_PAGE_PATH,
  upgradePageDocument,
  type PageDocument,
  type SiteKeepArrival,
  type SiteKind,
  type SitePageSummary,
  type SiteStepSummary,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { uuidOf } from './support.js';

export const kindOf = (kind: string): SiteKind => (kind === 'website' ? 'website' : 'funnel');

/** The setting as the table's own constraint allows it; anything else reads as what a site starts with. */
export const keepArrivalOf = (value: string): SiteKeepArrival =>
  value === 'always' || value === 'never' ? value : 'unless_opted_out';

const SITE_COLUMNS = [
  'id',
  'kind',
  'name',
  'public_key',
  'folder_id',
  'domain_id',
  'path',
  'favicon_url',
  'head_code',
  'body_code',
  'chat_widget_id',
  'payment_live',
  'require_card',
  'optimize_images',
  'lazy_custom_code',
  'privacy_fonts',
  'auto_schema',
  'keep_arrival',
  'origin_template_id',
  'revision',
  'created_at',
  'updated_at',
] as const;

export interface SiteRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly public_key: string;
  readonly folder_id: string | null;
  readonly domain_id: string | null;
  readonly path: string;
  readonly favicon_url: string | null;
  readonly head_code: string;
  readonly body_code: string;
  readonly chat_widget_id: string | null;
  readonly payment_live: boolean;
  readonly require_card: boolean;
  readonly optimize_images: boolean;
  readonly lazy_custom_code: boolean;
  readonly privacy_fonts: boolean;
  readonly auto_schema: boolean;
  readonly keep_arrival: string;
  readonly origin_template_id: string | null;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** A site of this business; one of another business is the same error as none. */
export async function requireSite(
  trx: DatabaseTransaction,
  publicId: string,
  lock = false,
): Promise<SiteRow> {
  let query = trx
    .selectFrom('sites.sites')
    .select(SITE_COLUMNS)
    .where('id', '=', uuidOf('site', publicId));
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Site', publicId);
  return row;
}

/** The site's row by its own id, held: for a command that reached it through a step. */
export async function holdSite(trx: DatabaseTransaction, id: string): Promise<SiteRow> {
  const row = await trx
    .selectFrom('sites.sites')
    .select(SITE_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  // The step was read a moment ago, so its site was there: it was deleted in between.
  if (row === undefined) throw new ConflictError('This site was deleted.');
  return row;
}

/** Marks the site as changed now, for the lists' "Last updated", without a new revision. */
export async function touchSite(trx: DatabaseTransaction, id: string): Promise<void> {
  await trx
    .updateTable('sites.sites')
    .set({ updated_at: sql<Date>`now()` })
    .where('id', '=', id)
    .execute();
}

const STEP_COLUMNS = [
  'id',
  'site_id',
  'name',
  'path',
  'position',
  'split_test',
  'revision',
  'updated_at',
] as const;

export interface StepRow {
  readonly id: string;
  readonly site_id: string;
  readonly name: string;
  readonly path: string;
  readonly position: number;
  readonly split_test: boolean;
  readonly revision: number;
  readonly updated_at: Date;
}

export async function requireStep(
  trx: DatabaseTransaction,
  publicId: string,
  lock = false,
): Promise<StepRow> {
  let query = trx
    .selectFrom('sites.steps')
    .select(STEP_COLUMNS)
    .where('id', '=', uuidOf('site_step', publicId));
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Step', publicId);
  return row;
}

const PAGE_COLUMNS = [
  'id',
  'step_id',
  'site_id',
  'site_kind',
  'role',
  'weight',
  'current_version',
  'published_version',
  'published_at',
  'revision',
  'updated_at',
] as const;

export interface PageRow {
  readonly id: string;
  readonly step_id: string;
  readonly site_id: string;
  readonly site_kind: string;
  readonly role: string;
  readonly weight: number;
  readonly current_version: number;
  readonly published_version: number | null;
  readonly published_at: Date | null;
  readonly revision: number;
  readonly updated_at: Date;
}

export async function requirePage(
  trx: DatabaseTransaction,
  publicId: string,
  lock = false,
): Promise<PageRow> {
  let query = trx
    .selectFrom('sites.pages')
    .select(PAGE_COLUMNS)
    .where('id', '=', uuidOf('site_page', publicId));
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Page', publicId);
  return row;
}

/** A step's pages, control first, held when the command will change them. */
export async function pagesOf(
  trx: DatabaseTransaction,
  stepId: string,
  lock = false,
): Promise<PageRow[]> {
  let query = trx
    .selectFrom('sites.pages')
    .select(PAGE_COLUMNS)
    .where('step_id', '=', stepId)
    .orderBy('role');
  if (lock) query = query.forUpdate();
  return query.execute();
}

export const roleOf = (role: string): SitePageSummary['role'] =>
  role === 'variation' ? 'variation' : 'control';

export const pageSummary = (row: PageRow): SitePageSummary => ({
  id: toPublicId('site_page', row.id),
  role: roleOf(row.role),
  weight: row.weight,
  currentVersion: row.current_version,
  publishedVersion: row.published_version,
  publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
  hasUnpublishedChanges:
    row.published_version !== null && row.published_version !== row.current_version,
});

/**
 * Where a site and its steps answer on the install's own address, as paths: `/s/<key>`
 * and `/s/<key>/<step path>`. The routes make them full addresses (index.ts), since only
 * they know the install's address and whether it serves public pages at all.
 */
export const livePath = (publicKey: string, stepPath?: string): string =>
  `${SITE_PAGE_PATH}/${publicKey}${stepPath === undefined ? '' : `/${stepPath}`}`;

/**
 * The step a site's own address shows: a funnel's first step; a website's page at the
 * path `home` or `index`, or else the first one added. Undefined for a site with no step.
 */
export function homeStepOf<Step extends { readonly path: string; readonly position: number }>(
  kind: SiteKind,
  steps: readonly Step[],
): Step | undefined {
  const first = [...steps].sort((left, right) => left.position - right.position)[0];
  if (kind === 'funnel') return first;
  return (
    steps.find((step) => step.path === 'home') ??
    steps.find((step) => step.path === 'index') ??
    first
  );
}

/** A site's public key by the site's own id. */
export async function publicKeyOf(trx: DatabaseTransaction, siteId: string): Promise<string> {
  const row = await trx
    .selectFrom('sites.sites')
    .select('public_key')
    .where('id', '=', siteId)
    .executeTakeFirst();
  // Its step or page was read a moment ago, so the site was there: it was deleted in between.
  if (row === undefined) throw new ConflictError('This site was deleted.');
  return row.public_key;
}

/** Whether a step's control page is published, which is when a visitor can reach the step. */
const isLive = (pages: readonly PageRow[]): boolean =>
  pages.some((page) => page.role === 'control' && page.published_version !== null);

export const stepSummary = (
  row: StepRow,
  pages: readonly PageRow[],
  publicKey: string,
): SiteStepSummary => ({
  id: toPublicId('site_step', row.id),
  name: row.name,
  path: row.path,
  position: row.position,
  splitTest: row.split_test,
  liveUrl: isLive(pages) ? livePath(publicKey, row.path) : null,
  pages: pages.map(pageSummary),
  revision: row.revision,
  updatedAt: row.updated_at.toISOString(),
});

/** A site's steps in order, each with its pages, control first. */
export async function stepSummaries(
  trx: DatabaseTransaction,
  siteId: string,
): Promise<SiteStepSummary[]> {
  const publicKey = await publicKeyOf(trx, siteId);
  const steps = await trx
    .selectFrom('sites.steps')
    .select(STEP_COLUMNS)
    .where('site_id', '=', siteId)
    .orderBy('position')
    .execute();
  const pages = await trx
    .selectFrom('sites.pages')
    .select(PAGE_COLUMNS)
    .where('site_id', '=', siteId)
    .orderBy('role')
    .execute();
  return steps.map((step) =>
    stepSummary(
      step,
      pages.filter((page) => page.step_id === step.id),
      publicKey,
    ),
  );
}

/**
 * A stored document as the current format reads it. One this release cannot read (written
 * by a newer release, or damaged) is refused rather than shown as something else.
 */
export function storedDocument(stored: unknown): PageDocument {
  try {
    const parsed = pageDocument.safeParse(upgradePageDocument(stored));
    if (parsed.success) return parsed.data;
  } catch {
    // Answered below with the other unreadable documents.
  }
  throw new ConflictError('This page was saved in a format this release cannot read.');
}

/** The document of one version of a page. */
export async function versionDocument(
  trx: DatabaseTransaction,
  pageId: string,
  number: number,
): Promise<{ document: PageDocument; format: number }> {
  const row = await trx
    .selectFrom('sites.page_versions')
    .select(['document', 'format'])
    .where('page_id', '=', pageId)
    .where('number', '=', number)
    .executeTakeFirstOrThrow();
  return { document: storedDocument(row.document), format: row.format };
}
