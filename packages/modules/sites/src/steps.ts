// A site's steps, their pages and the versions of a page, split tests and statistics.
// Saving a page never changes the live page; publishing makes a chosen version live; a page
// keeps its newest thirty versions and never drops the live one.
//
// Versions are for moments worth going back to. A save on purpose, a
// restore and a publish each leave a kept version, which nothing rewrites. The editor's own
// saves do not: a page has one working draft, its newest version, which an autosave
// rewrites in place for as long as the same person goes on editing. A new working draft
// starts, and what was there stays as a version, when the newest version is a kept one,
// when someone else wrote it, or when it was last written SITE_PAGE_AUTOSAVE_IDLE_MINUTES
// ago or more. So the state before a period of editing is always a version, and a period of
// editing adds one version, not one for each pause.
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  cloneSiteStep,
  cloneSiteStepInput,
  createSiteStep,
  createSiteStepInput,
  createSiteVariation,
  createSiteVariationInput,
  declareSiteWinner,
  declareSiteWinnerInput,
  deleteSiteStep,
  EMPTY_PAGE_DOCUMENT,
  pageDocumentReferences,
  publishSitePage,
  publishSitePageInput,
  reorderSiteSteps,
  reorderSiteStepsInput,
  resetSiteStats,
  restoreSitePageInput,
  restoreSitePageVersion,
  saveSitePageDraft,
  saveSitePageDraftInput,
  setSiteSplitTest,
  setSiteSplitTestInput,
  SITE_LIMITS,
  SITE_PAGE_AUTOSAVE_IDLE_MINUTES,
  sitePageRevisionInput,
  unpublishSitePage,
  updateSiteStep,
  updateSiteStepInput,
  type PageDocument,
  type SitePage,
  type SitePageVersionDetail,
  type SitePageVersionList,
  type SiteStats,
  type SiteStep,
  type SiteStepSummary,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { sql } from 'kysely';

import { addPage, addSteps, useTemplate } from './copies.js';
import { readPageProblems, type PageReaders } from './public.js';
import {
  holdSite,
  kindOf,
  livePath,
  pageSummary,
  pagesOf,
  publicKeyOf,
  requirePage,
  requireSite,
  requireStep,
  roleOf,
  stepSummaries,
  stepSummary,
  storedDocument,
  touchSite,
  versionDocument,
  type PageRow,
  type StepRow,
} from './rows.js';
import { asJson, invalid, madeBy, may, requireRevision } from './support.js';

/** The names of people by user id: whatever knows the team answers (the server passes it). */
export type ReadPeople = (
  trx: DatabaseTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

const uniqueErrors = explainUniqueViolation({
  steps_path_unique: () => invalid('/path', 'taken', 'This site already has a step at this path.'),
});

// A step that content carries needs an id for its own actions to name. A new, blank step
// has no actions, so any id will do: this one names no row.
const NEW_STEP = toPublicId('site_step', '0192f000-0000-7000-8000-000000000000');

// Steps ---------------------------------------------------------------------------------------

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  step: StepRow,
): Promise<SiteStep> {
  const pages = await pagesOf(trx, step.id);
  const [first] = pages;
  return {
    ...stepSummary(step, pages, await publicKeyOf(trx, step.site_id)),
    siteId: toPublicId('site', step.site_id),
    siteKind: kindOf(first?.site_kind ?? 'funnel'),
    canManage: may(invocation, 'sites.manage'),
    canPublish: may(invocation, 'sites.publish'),
  };
}

/** One step with its pages, as anyone in the business may read it. */
export async function readSiteStep(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<SiteStep> {
  requireBusiness(invocation.context);
  return present(trx, invocation, await requireStep(trx, publicId));
}

export const createSiteStepCommand = defineCommand({
  name: 'site_step.create',
  permission: 'sites.manage',
  input: createSiteStepInput.extend(createSiteStep.params.shape),
  async handle(trx, input, command): Promise<SiteStep> {
    const businessId = requireBusiness(command.context);
    const site = await requireSite(trx, input.id, true);
    const template =
      input.templateId === undefined
        ? undefined
        : await useTemplate(trx, input.templateId, ['step']);
    const [stepId = ''] = await addSteps(
      trx,
      command,
      { businessId, id: site.id, kind: kindOf(site.kind) },
      {
        steps: [
          {
            id: NEW_STEP,
            name: input.name,
            path: input.path,
            document: template?.content.document ?? EMPTY_PAGE_DOCUMENT,
          },
        ],
        sections: template?.content.sections ?? [],
      },
      { originTemplateId: template?.id },
    );
    await touchSite(trx, site.id);
    await command.emit({
      type: 'site_step.created',
      subject: { kind: 'site_step', id: stepId },
      payload: { siteId: input.id, name: input.name, path: input.path },
    });
    return readSiteStep(trx, command, toPublicId('site_step', stepId));
  },
});

export const updateSiteStepCommand = defineCommand({
  name: 'site_step.update',
  permission: 'sites.manage',
  input: updateSiteStepInput.safeExtend(updateSiteStep.params.shape),
  async handle(trx, input, command): Promise<SiteStep> {
    requireBusiness(command.context);
    const current = await requireStep(trx, input.id, true);
    requireRevision(current.revision, input.revision, 'step');
    await trx
      .updateTable('sites.steps')
      .set({
        revision: current.revision + 1,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.path === undefined ? {} : { path: input.path }),
      })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await touchSite(trx, current.site_id);
    await command.emit({
      type: 'site_step.updated',
      subject: { kind: 'site_step', id: current.id },
      payload: { name: input.name ?? current.name, path: input.path ?? current.path },
    });
    return readSiteStep(trx, command, input.id);
  },
});

export const deleteSiteStepCommand = defineCommand({
  name: 'site_step.delete',
  permission: 'sites.manage',
  input: deleteSiteStep.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireStep(trx, input.id, true);
    // The table takes its pages, their versions and their statistics.
    await trx.deleteFrom('sites.steps').where('id', '=', current.id).execute();
    await touchSite(trx, current.site_id);
    await command.emit({
      type: 'site_step.deleted',
      subject: { kind: 'site_step', id: current.id },
      payload: { siteId: toPublicId('site', current.site_id), name: current.name },
    });
  },
});

export const cloneSiteStepCommand = defineCommand({
  name: 'site_step.clone',
  permission: 'sites.manage',
  input: cloneSiteStepInput.extend(cloneSiteStep.params.shape),
  async handle(trx, input, command): Promise<SiteStep> {
    const businessId = requireBusiness(command.context);
    const source = await requireStep(trx, input.id);
    const site = await holdSite(trx, source.site_id);
    const [control] = await pagesOf(trx, source.id);
    if (control === undefined) throw new NotFoundError('Step', input.id);
    const { document } = await versionDocument(trx, control.id, control.current_version);
    const [stepId = ''] = await addSteps(
      trx,
      command,
      { businessId, id: site.id, kind: kindOf(site.kind) },
      {
        steps: [
          {
            id: toPublicId('site_step', source.id),
            name: input.name ?? `${source.name.slice(0, 113)} (copy)`,
            path: input.path ?? `${source.path.slice(0, 195)}-copy`,
            document,
          },
        ],
        sections: [],
      },
      { originSteps: true, keepSections: true, keepSteps: true },
    );
    await touchSite(trx, site.id);
    await command.emit({
      type: 'site_step.cloned',
      subject: { kind: 'site_step', id: stepId },
      payload: { from: input.id },
    });
    return readSiteStep(trx, command, toPublicId('site_step', stepId));
  },
});

export const reorderSiteStepsCommand = defineCommand({
  name: 'site.reorder_steps',
  permission: 'sites.manage',
  input: reorderSiteStepsInput.extend(reorderSiteSteps.params.shape),
  async handle(trx, input, command): Promise<{ items: SiteStepSummary[] }> {
    requireBusiness(command.context);
    const site = await requireSite(trx, input.id, true);
    requireRevision(site.revision, input.revision, 'site');
    if (site.kind !== 'funnel')
      throw new ConflictError('A website’s pages have no order. Only a funnel’s steps do.');
    const steps = await trx
      .selectFrom('sites.steps')
      .select('id')
      .where('site_id', '=', site.id)
      .forUpdate()
      .execute();
    const wanted = input.stepIds.map((id) => parsePublicId('site_step', id));
    const own = new Set(steps.map((step) => step.id));
    // All or none: the order names every step of this funnel, and nothing else.
    if (wanted.length !== own.size || wanted.some((id) => id === undefined || !own.has(id)))
      throw invalid('/stepIds', 'invalid_steps', 'Name every step of this funnel once.');
    for (const [position, id] of wanted.entries())
      await trx
        .updateTable('sites.steps')
        .set({ position })
        .where('id', '=', id ?? '')
        .execute();
    await trx
      .updateTable('sites.sites')
      .set({ revision: site.revision + 1 })
      .where('id', '=', site.id)
      .execute();
    await command.emit({
      type: 'site.steps_reordered',
      subject: { kind: 'site', id: site.id },
      payload: { stepIds: input.stepIds },
    });
    return { items: await stepSummaries(trx, site.id) };
  },
});

// Pages and their versions --------------------------------------------------------------------

async function presentPage(
  trx: DatabaseTransaction,
  invocation: Invocation,
  page: PageRow,
  readers: PageReaders,
): Promise<SitePage> {
  const { document, format } = await versionDocument(trx, page.id, page.current_version);
  const newest = await trx
    .selectFrom('sites.page_versions')
    .select(['draft', 'updated_at'])
    .where('page_id', '=', page.id)
    .where('number', '=', page.current_version)
    .executeTakeFirstOrThrow();
  const step = await trx
    .selectFrom('sites.steps')
    .select('path')
    .where('id', '=', page.step_id)
    .executeTakeFirstOrThrow();
  return {
    ...pageSummary(page),
    problems: await readPageProblems(trx, page, document, readers),
    autosavedAt: newest.draft ? newest.updated_at.toISOString() : null,
    // A visitor is served a step's control page, and only while it is published.
    liveUrl:
      page.role === 'control' && page.published_version !== null
        ? livePath(await publicKeyOf(trx, page.site_id), step.path)
        : null,
    stepId: toPublicId('site_step', page.step_id),
    siteId: toPublicId('site', page.site_id),
    siteKind: kindOf(page.site_kind),
    document,
    storedFormat: format,
    revision: page.revision,
    updatedAt: page.updated_at.toISOString(),
    canManage: may(invocation, 'sites.manage'),
    canPublish: may(invocation, 'sites.publish'),
  };
}

/**
 * One page with its newest saved document and what is wrong with it, as anyone in the
 * business may read it. `readers` are the other modules' own, for what the page shows of
 * theirs (a form, a calendar).
 */
export async function readSitePage(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  readers: PageReaders = {},
): Promise<SitePage> {
  requireBusiness(invocation.context);
  return presentPage(trx, invocation, await requirePage(trx, publicId), readers);
}

/**
 * What a document points at must be there: a saved section of the business or of this
 * site, and steps of this site. Anything else is refused with the place it was named at.
 */
async function requireReferences(
  trx: DatabaseTransaction,
  page: PageRow,
  document: PageDocument,
): Promise<void> {
  const { sectionIds, stepIds } = pageDocumentReferences(document);
  const issues: Issue[] = [];
  if (sectionIds.length > 0) {
    const found = await trx
      .selectFrom('sites.saved_sections')
      .select('id')
      .where(
        'id',
        'in',
        sectionIds.flatMap((id) => parsePublicId('site_section', id) ?? []),
      )
      .where((eb) => eb.or([eb('site_id', 'is', null), eb('site_id', '=', page.site_id)]))
      .forShare()
      .execute();
    const known = new Set(found.map((row) => toPublicId('site_section', row.id)));
    for (const id of sectionIds)
      if (!known.has(id))
        issues.push({
          path: '/document/sections',
          code: 'invalid_section',
          message: `No saved section ${id} can be used on this site.`,
        });
  }
  if (stepIds.length > 0) {
    const found = await trx
      .selectFrom('sites.steps')
      .select('id')
      .where('site_id', '=', page.site_id)
      .where(
        'id',
        'in',
        stepIds.flatMap((id) => parsePublicId('site_step', id) ?? []),
      )
      .execute();
    const known = new Set(found.map((row) => toPublicId('site_step', row.id)));
    for (const id of stepIds)
      if (!known.has(id))
        issues.push({
          path: '/document',
          code: 'invalid_step',
          message: `This site has no step ${id} for an action to go to.`,
        });
  }
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
}

interface NewVersion {
  readonly document: unknown;
  readonly format: number;
  readonly restoredFrom?: number;
  /** True for the working draft an autosave starts; left out, the version is a kept one. */
  readonly draft?: boolean;
  readonly name?: string | undefined;
}

/**
 * Stores a page's next version, and drops what is older than the newest thirty: kept
 * versions, earlier working drafts and the working draft all count, and the live version
 * is never dropped, however old it is.
 */
async function addVersion(
  trx: DatabaseTransaction,
  command: Parameters<typeof madeBy>[0],
  businessId: string,
  page: PageRow,
  version: NewVersion,
): Promise<void> {
  const number = page.current_version + 1;
  await trx
    .insertInto('sites.page_versions')
    .values({
      business_id: businessId,
      page_id: page.id,
      number,
      format: version.format,
      document: asJson(version.document),
      restored_from: version.restoredFrom ?? null,
      draft: version.draft ?? false,
      name: version.name ?? null,
      ...madeBy(command),
    })
    .execute();
  await trx
    .updateTable('sites.pages')
    .set({ current_version: number, revision: page.revision + 1 })
    .where('id', '=', page.id)
    .execute();
  // The live version is never dropped, however old it is.
  let stale = trx
    .deleteFrom('sites.page_versions')
    .where('page_id', '=', page.id)
    .where('number', '<=', number - SITE_LIMITS.versions);
  if (page.published_version !== null) stale = stale.where('number', '<>', page.published_version);
  await stale.execute();
  await touchSite(trx, page.site_id);
}

/**
 * Whether the page's newest version is a working draft this save may write into: still
 * open, written by whoever is saving now, and last written less than
 * SITE_PAGE_AUTOSAVE_IDLE_MINUTES ago. Anything else is left as it is, and stays a version.
 */
async function openDraft(
  trx: DatabaseTransaction,
  command: Parameters<typeof madeBy>[0],
  page: PageRow,
  now: number,
): Promise<boolean> {
  const newest = await trx
    .selectFrom('sites.page_versions')
    .select(['draft', 'created_by_kind', 'created_by_id', 'updated_at'])
    .where('page_id', '=', page.id)
    .where('number', '=', page.current_version)
    .executeTakeFirstOrThrow();
  const author = madeBy(command);
  return (
    newest.draft &&
    newest.created_by_kind === author.created_by_kind &&
    newest.created_by_id === author.created_by_id &&
    now - newest.updated_at.getTime() < SITE_PAGE_AUTOSAVE_IDLE_MINUTES * 60_000
  );
}

/** Keeps a page's working draft as a version: from here nothing rewrites it. */
const keepVersion = (trx: DatabaseTransaction, pageId: string, number: number) =>
  trx
    .updateTable('sites.page_versions')
    .set({ draft: false })
    .where('page_id', '=', pageId)
    .where('number', '=', number)
    .where('draft', '=', true)
    .execute();

export interface PageCommandOptions extends PageReaders {
  /** The clock, in milliseconds, that says how long a working draft has been left. */
  readonly now?: (() => number) | undefined;
}

/**
 * The commands that change a page, given the other modules' readers: publishing checks a
 * form or a calendar on the page against them, and each answers with the page and its
 * problems.
 */
// The commands' own types are what the routes need; writing them out would only repeat them.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createPageCommands(options: PageCommandOptions = {}) {
  const readers: PageReaders = options;
  const save = defineCommand({
    name: 'site_page.save',
    permission: 'sites.manage',
    input: saveSitePageDraftInput.safeExtend(saveSitePageDraft.params.shape),
    // The audit log keeps that a page was saved and how large, not the page.
    audit: ({ id, baseVersion, document, autosave, name }) => ({
      id,
      baseVersion,
      mode: document.mode,
      size: JSON.stringify(document).length,
      ...(autosave === true ? { autosave } : {}),
      ...(name === undefined ? {} : { name }),
    }),
    async handle(trx, input, command): Promise<SitePage> {
      const businessId = requireBusiness(command.context);
      const page = await requirePage(trx, input.id, true);
      if (page.current_version !== input.baseVersion)
        throw new ConflictError(
          'This page was saved by someone else since you opened it. Reload before saving.',
        );
      // An autosave may leave the version number as it is, so the number alone cannot say
      // that nobody else wrote in between: the page's revision does.
      if (input.revision !== undefined) requireRevision(page.revision, input.revision, 'page');
      await requireReferences(trx, page, input.document);
      const autosave = input.autosave === true;
      if (await openDraft(trx, command, page, (options.now ?? Date.now)())) {
        // The same person, still editing: the working draft is written again in place. A
        // save on purpose keeps it as a version, under the name given.
        await trx
          .updateTable('sites.page_versions')
          .set({
            document: asJson(input.document),
            format: input.document.format,
            draft: autosave,
            name: input.name ?? null,
          })
          .where('page_id', '=', page.id)
          .where('number', '=', page.current_version)
          .where('draft', '=', true)
          .execute();
        await trx
          .updateTable('sites.pages')
          .set({ revision: page.revision + 1 })
          .where('id', '=', page.id)
          .execute();
        await touchSite(trx, page.site_id);
        // The editor's own saves are not told to anything that listens: only a kept version is.
        if (!autosave)
          await command.emit({
            type: 'site_page.saved',
            subject: { kind: 'site_page', id: page.id },
            payload: { version: page.current_version },
          });
        return readSitePage(trx, command, input.id, readers);
      }
      await addVersion(trx, command, businessId, page, {
        document: input.document,
        format: input.document.format,
        draft: autosave,
        name: input.name,
      });
      await command.emit({
        type: 'site_page.saved',
        subject: { kind: 'site_page', id: page.id },
        payload: { version: page.current_version + 1, ...(autosave ? { draft: true } : {}) },
      });
      return readSitePage(trx, command, input.id, readers);
    },
  });

  const restore = defineCommand({
    name: 'site_page.restore',
    permission: 'sites.manage',
    input: restoreSitePageInput.extend(restoreSitePageVersion.params.shape),
    async handle(trx, input, command): Promise<SitePage> {
      const businessId = requireBusiness(command.context);
      const page = await requirePage(trx, input.id, true);
      requireRevision(page.revision, input.revision, 'page');
      const old = await trx
        .selectFrom('sites.page_versions')
        .select(['document', 'format'])
        .where('page_id', '=', page.id)
        .where('number', '=', input.version)
        .executeTakeFirst();
      if (old === undefined)
        throw invalid('/version', 'invalid_version', 'This page keeps no such version.');
      // Read as this release reads it, so a restore never brings back what cannot be shown.
      const document = storedDocument(old.document);
      await addVersion(trx, command, businessId, page, {
        document,
        format: document.format,
        restoredFrom: input.version,
      });
      await command.emit({
        type: 'site_page.restored',
        subject: { kind: 'site_page', id: page.id },
        payload: { from: input.version, version: page.current_version + 1 },
      });
      return readSitePage(trx, command, input.id, readers);
    },
  });

  const publish = defineCommand({
    name: 'site_page.publish',
    permission: 'sites.publish',
    input: publishSitePageInput.extend(publishSitePage.params.shape),
    async handle(trx, input, command): Promise<SitePage> {
      requireBusiness(command.context);
      const page = await requirePage(trx, input.id, true);
      requireRevision(page.revision, input.revision, 'page');
      const version = input.version ?? page.current_version;
      const kept = await trx
        .selectFrom('sites.page_versions')
        .select('document')
        .where('page_id', '=', page.id)
        .where('number', '=', version)
        .executeTakeFirst();
      if (kept === undefined)
        throw invalid('/version', 'invalid_version', 'This page keeps no such version.');
      // What goes live must be readable by this release, and must not be broken for a
      // visitor: each blocking problem is said in a sentence, and nothing is published.
      const blocking = (
        await readPageProblems(trx, page, storedDocument(kept.document), readers)
      ).filter((problem) => problem.blocking);
      const [first, ...rest] = blocking.map((problem): Issue => ({
        path: problem.nodeId === null ? '/version' : `/document/${problem.nodeId}`,
        code: problem.code,
        message: problem.message,
      }));
      if (first !== undefined) throw new ValidationError([first, ...rest]);
      // What visitors are shown is a kept version, never one an autosave could rewrite: a
      // working draft is kept before it goes live (the table refuses the other order).
      await keepVersion(trx, page.id, version);
      await trx
        .updateTable('sites.pages')
        .set({
          published_version: version,
          // The time it is written, so each publication is its own.
          published_at: sql<Date>`clock_timestamp()`,
          revision: page.revision + 1,
        })
        .where('id', '=', page.id)
        .execute();
      await touchSite(trx, page.site_id);
      await command.emit({
        type: 'site_page.published',
        subject: { kind: 'site_page', id: page.id },
        payload: { version, stepId: toPublicId('site_step', page.step_id) },
      });
      return readSitePage(trx, command, input.id, readers);
    },
  });

  const unpublish = defineCommand({
    name: 'site_page.unpublish',
    permission: 'sites.publish',
    input: sitePageRevisionInput.extend(unpublishSitePage.params.shape),
    async handle(trx, input, command): Promise<SitePage> {
      requireBusiness(command.context);
      const page = await requirePage(trx, input.id, true);
      requireRevision(page.revision, input.revision, 'page');
      if (page.published_version === null) throw new ConflictError('This page is not published.');
      await trx
        .updateTable('sites.pages')
        .set({ published_version: null, published_at: null, revision: page.revision + 1 })
        .where('id', '=', page.id)
        .execute();
      await touchSite(trx, page.site_id);
      await command.emit({
        type: 'site_page.unpublished',
        subject: { kind: 'site_page', id: page.id },
        payload: { stepId: toPublicId('site_step', page.step_id) },
      });
      return readSitePage(trx, command, input.id, readers);
    },
  });
  return { save, restore, publish, unpublish };
}

interface VersionRow {
  readonly number: number;
  readonly created_at: Date;
  readonly created_by_kind: string;
  readonly created_by_id: string | null;
  readonly restored_from: number | null;
  readonly draft: boolean;
  readonly name: string | null;
  readonly updated_at: Date;
}

async function authors(
  trx: DatabaseTransaction,
  people: ReadPeople | undefined,
  rows: readonly VersionRow[],
): Promise<ReadonlyMap<string, string>> {
  const users = rows.flatMap((row) =>
    row.created_by_kind === 'user' && row.created_by_id !== null ? [row.created_by_id] : [],
  );
  return people === undefined || users.length === 0 ? new Map() : people(trx, [...new Set(users)]);
}

const asVersion = (row: VersionRow, page: PageRow, names: ReadonlyMap<string, string>) => ({
  number: row.number,
  createdAt: row.created_at.toISOString(),
  createdBy: {
    kind: row.created_by_kind,
    name: row.created_by_id === null ? null : (names.get(row.created_by_id) ?? null),
  },
  restoredFrom: row.restored_from,
  current: row.number === page.current_version,
  published: row.number === page.published_version,
  // A version still open is the working draft while it is the newest; one that a newer
  // version came after is what an earlier period of editing left.
  kind: !row.draft
    ? ('saved' as const)
    : row.number === page.current_version
      ? ('draft' as const)
      : ('checkpoint' as const),
  name: row.name,
  updatedAt: row.updated_at.toISOString(),
});

const VERSION_COLUMNS = [
  'number',
  'created_at',
  'created_by_kind',
  'created_by_id',
  'restored_from',
  'draft',
  'name',
  'updated_at',
] as const;

/** The versions a page keeps, newest first. */
export async function readSitePageVersions(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  people?: ReadPeople,
): Promise<SitePageVersionList> {
  requireBusiness(invocation.context);
  const page = await requirePage(trx, publicId);
  const rows = await trx
    .selectFrom('sites.page_versions')
    .select(VERSION_COLUMNS)
    .where('page_id', '=', page.id)
    .orderBy('number', 'desc')
    .execute();
  const names = await authors(trx, people, rows);
  return { items: rows.map((row) => asVersion(row, page, names)) };
}

/** One version of a page with its document. */
export async function readSitePageVersion(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  number: number,
  people?: ReadPeople,
): Promise<SitePageVersionDetail> {
  requireBusiness(invocation.context);
  const page = await requirePage(trx, publicId);
  const row = await trx
    .selectFrom('sites.page_versions')
    .select([...VERSION_COLUMNS, 'document', 'format'])
    .where('page_id', '=', page.id)
    .where('number', '=', number)
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Version', String(number));
  const names = await authors(trx, people, [row]);
  return {
    ...asVersion(row, page, names),
    document: storedDocument(row.document),
    storedFormat: row.format,
  };
}

// Split tests ---------------------------------------------------------------------------------

/** A step held with its pages, at the revision the change was made from. */
async function heldStep(
  trx: DatabaseTransaction,
  publicId: string,
  revision: number,
): Promise<{ step: StepRow; control: PageRow; variation: PageRow | undefined }> {
  const step = await requireStep(trx, publicId, true);
  requireRevision(step.revision, revision, 'step');
  const [control, variation] = await pagesOf(trx, step.id, true);
  if (control === undefined) throw new NotFoundError('Step', publicId);
  return { step, control, variation };
}

const bump = (trx: DatabaseTransaction, step: StepRow, splitTest: boolean) =>
  trx
    .updateTable('sites.steps')
    .set({ split_test: splitTest, revision: step.revision + 1 })
    .where('id', '=', step.id)
    .execute();

export const createSiteVariationCommand = defineCommand({
  name: 'site_step.create_variation',
  permission: 'sites.publish',
  input: createSiteVariationInput.extend(createSiteVariation.params.shape),
  async handle(trx, input, command): Promise<SiteStep> {
    const businessId = requireBusiness(command.context);
    const { step, control, variation } = await heldStep(trx, input.id, input.revision);
    if (control.site_kind !== 'funnel')
      throw new ConflictError('Only a funnel’s steps can be split tested, not a website’s pages.');
    if (variation !== undefined) throw new ConflictError('This step already has a variation.');
    const document = input.copyControl
      ? (await versionDocument(trx, control.id, control.current_version)).document
      : EMPTY_PAGE_DOCUMENT;
    // Half each until someone moves the slider; nothing is split before the test starts.
    await trx.updateTable('sites.pages').set({ weight: 50 }).where('id', '=', control.id).execute();
    await addPage(trx, command, {
      businessId,
      stepId: step.id,
      siteId: step.site_id,
      siteKind: 'funnel',
      role: 'variation',
      weight: 50,
      document,
    });
    await bump(trx, step, step.split_test);
    await touchSite(trx, step.site_id);
    await command.emit({
      type: 'site_step.variation_created',
      subject: { kind: 'site_step', id: step.id },
      payload: { copyControl: input.copyControl },
    });
    return readSiteStep(trx, command, input.id);
  },
});

export const setSiteSplitTestCommand = defineCommand({
  name: 'site_step.set_split_test',
  permission: 'sites.publish',
  input: setSiteSplitTestInput.extend(setSiteSplitTest.params.shape),
  async handle(trx, input, command): Promise<SiteStep> {
    requireBusiness(command.context);
    const { step, control, variation } = await heldStep(trx, input.id, input.revision);
    if (variation === undefined)
      throw new ConflictError('Create a variation before starting a split test.');
    await trx
      .updateTable('sites.pages')
      .set({ weight: input.controlWeight })
      .where('id', '=', control.id)
      .execute();
    await trx
      .updateTable('sites.pages')
      .set({ weight: 100 - input.controlWeight })
      .where('id', '=', variation.id)
      .execute();
    await bump(trx, step, input.active);
    await command.emit({
      type: input.active ? 'site_step.split_test_started' : 'site_step.split_test_stopped',
      subject: { kind: 'site_step', id: step.id },
      payload: { controlWeight: input.controlWeight },
    });
    return readSiteStep(trx, command, input.id);
  },
});

export const declareSiteWinnerCommand = defineCommand({
  name: 'site_step.declare_winner',
  permission: 'sites.publish',
  input: declareSiteWinnerInput.extend(declareSiteWinner.params.shape),
  async handle(trx, input, command): Promise<SiteStep> {
    requireBusiness(command.context);
    const { step, control, variation } = await heldStep(trx, input.id, input.revision);
    if (variation === undefined) throw new ConflictError('This step has no variation to compare.');
    const winner = [control, variation].find(
      (page) => page.id === parsePublicId('site_page', input.pageId),
    );
    if (winner === undefined)
      throw invalid('/pageId', 'invalid_page', 'Choose one of this step’s two pages.');
    const loser = winner.id === control.id ? variation : control;
    // The other page goes with its versions and its statistics; the winner is the control.
    await trx.deleteFrom('sites.pages').where('id', '=', loser.id).execute();
    await trx
      .updateTable('sites.pages')
      .set({ role: 'control', weight: 100, revision: winner.revision + 1 })
      .where('id', '=', winner.id)
      .execute();
    await bump(trx, step, false);
    await touchSite(trx, step.site_id);
    await command.emit({
      type: 'site_step.winner_declared',
      subject: { kind: 'site_step', id: step.id },
      payload: { pageId: input.pageId, was: roleOf(winner.role) },
    });
    return readSiteStep(trx, command, input.id);
  },
});

// Statistics ----------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

interface Counts {
  views: number;
  uniqueViews: number;
  optIns: number;
  orders: number;
  orderQuantity: number;
  /** In hundredths, so amounts add exactly. */
  cents: bigint;
}
const none = (): Counts => ({
  views: 0,
  uniqueViews: 0,
  optIns: 0,
  orders: 0,
  orderQuantity: 0,
  cents: 0n,
});
const shown = (counts: Counts) => ({
  views: counts.views,
  uniqueViews: counts.uniqueViews,
  optIns: counts.optIns,
  // GoHighLevel's definition: opt-ins over unique views.
  optInRate: counts.uniqueViews === 0 ? 0 : counts.optIns / counts.uniqueViews,
  orders: counts.orders,
  orderQuantity: counts.orderQuantity,
  orderAmount: `${String(counts.cents / 100n)}.${String(counts.cents % 100n).padStart(2, '0')}`,
});

/** Page views and opt-ins per step and page of a site, over a range of days. */
export async function readSiteStats(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  query: { readonly from?: string | undefined; readonly to?: string | undefined },
  now: Date = new Date(),
): Promise<SiteStats> {
  requireBusiness(invocation.context);
  const site = await requireSite(trx, publicId);
  const to = query.to ?? dayOf(now);
  // The last 14 days by default, as GoHighLevel's analytics opens.
  const from = query.from ?? dayOf(new Date(Date.parse(`${to}T00:00:00Z`) - 13 * DAY_MS));
  if (from > to) throw invalid('/from', 'invalid_range', 'The first day comes after the last.');
  const rows = await trx
    .selectFrom('sites.step_stats_daily')
    .select([
      'page_id',
      sql<string>`sum(views)::text`.as('views'),
      sql<string>`sum(unique_views)::text`.as('unique_views'),
      sql<string>`sum(opt_ins)::text`.as('opt_ins'),
      sql<string>`sum(orders)::text`.as('orders'),
      sql<string>`sum(order_quantity)::text`.as('order_quantity'),
      sql<string>`(sum(order_amount) * 100)::bigint::text`.as('cents'),
    ])
    .where('site_id', '=', site.id)
    .where(sql<boolean>`day between ${from}::date and ${to}::date`)
    .groupBy('page_id')
    .execute();
  const byPage = new Map(
    rows.map((row) => [
      row.page_id,
      {
        views: Number(row.views),
        uniqueViews: Number(row.unique_views),
        optIns: Number(row.opt_ins),
        orders: Number(row.orders),
        orderQuantity: Number(row.order_quantity),
        cents: BigInt(row.cents),
      } satisfies Counts,
    ]),
  );
  const steps = await stepSummaries(trx, site.id);
  return {
    from,
    to,
    steps: steps.map((step) => {
      const total = none();
      const pages = step.pages.map((page) => {
        const counts = byPage.get(parsePublicId('site_page', page.id) ?? '') ?? none();
        total.views += counts.views;
        total.uniqueViews += counts.uniqueViews;
        total.optIns += counts.optIns;
        total.orders += counts.orders;
        total.orderQuantity += counts.orderQuantity;
        total.cents += counts.cents;
        return { pageId: page.id, role: page.role, ...shown(counts) };
      });
      return { stepId: step.id, name: step.name, ...shown(total), pages };
    }),
  };
}

export const resetSiteStatsCommand = defineCommand({
  name: 'site.reset_stats',
  permission: 'sites.manage',
  input: resetSiteStats.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const site = await requireSite(trx, input.id, true);
    await trx.deleteFrom('sites.step_stats_daily').where('site_id', '=', site.id).execute();
    await command.emit({
      type: 'site.stats_reset',
      subject: { kind: 'site', id: site.id },
      payload: {},
    });
  },
});
