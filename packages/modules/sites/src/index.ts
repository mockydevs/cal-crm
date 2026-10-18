// The sites module, phase S1: funnels and websites with their steps, pages and page
// versions; templates, saved sections and the share bundle; and the domains and redirects a
// business connects. It owns the sites schema. A published page is served on the install's
// own address by public.ts, rendered by packages/site-render.
import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Command,
  type Route,
} from '@repo/commands';
import {
  cloneSite,
  cloneSiteStep,
  createSite,
  createSiteDomain,
  createSiteFolder,
  createSiteRedirect,
  createSiteSection,
  createSiteStep,
  createSiteTemplate,
  createSiteVariation,
  declareSiteWinner,
  deleteSite,
  deleteSiteDomain,
  deleteSiteFolder,
  deleteSiteRedirect,
  deleteSiteSection,
  deleteSiteStep,
  deleteSiteTemplate,
  exportSite,
  getSite,
  getSiteDomain,
  getSitePage,
  getSitePagePreview,
  getSitePageVersion,
  getSitePublicStatus,
  getSiteStats,
  getSiteStep,
  getSiteTemplate,
  importSite,
  listSiteDomains,
  listSiteFolders,
  listSitePageElements,
  listSitePageVersions,
  listSiteRedirects,
  listSiteSections,
  listSiteTemplates,
  listSites,
  parseInput,
  publishSitePage,
  reorderSiteSteps,
  resetSiteStats,
  restoreSitePageVersion,
  saveSitePageDraft,
  setSiteSecurityHeaders,
  setSiteSplitTest,
  setSiteTemplateFavorite,
  unpublishSitePage,
  updateSite,
  updateSiteDomain,
  updateSiteFolder,
  updateSiteRedirect,
  updateSiteSection,
  updateSiteStep,
  updateSiteTemplate,
  verifySiteDomain,
  type Endpoint,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import type * as z from 'zod';

import { createBundleCommands } from './bundle.js';
import type { Resolution, ResolveHost, SitesTarget } from './dns.js';
import {
  createDomainCommands,
  createSiteRedirectCommand,
  deleteSiteRedirectCommand,
  readSiteRedirects,
  updateSiteRedirectCommand,
} from './domains.js';
import {
  createSiteSectionCommand,
  deleteSiteSectionCommand,
  readSiteSections,
  updateSiteSectionCommand,
} from './sections.js';
import {
  cloneSiteCommand,
  createSiteCommand,
  createSiteFolderCommand,
  deleteSiteCommand,
  deleteSiteFolderCommand,
  readSite,
  readSiteFolders,
  readSites,
  setSiteSecurityHeadersCommand,
  updateSiteCommand,
  updateSiteFolderCommand,
} from './sites.js';
import type { PageScripts } from '@repo/site-render';

import { sitePageElements } from './elements.js';
import {
  readSitePagePreview,
  sitePublicStatus,
  type PageReaders,
  type ReadSiteForms,
} from './public.js';
import {
  cloneSiteStepCommand,
  createPageCommands,
  createSiteStepCommand,
  createSiteVariationCommand,
  declareSiteWinnerCommand,
  deleteSiteStepCommand,
  readSitePage,
  readSitePageVersion,
  readSitePageVersions,
  readSiteStats,
  readSiteStep,
  reorderSiteStepsCommand,
  resetSiteStatsCommand,
  setSiteSplitTestCommand,
  updateSiteStepCommand,
  type ReadPeople,
} from './steps.js';
import {
  createSiteTemplateCommand,
  deleteSiteTemplateCommand,
  readSiteTemplate,
  readSiteTemplates,
  setSiteTemplateFavoriteCommand,
  updateSiteTemplateCommand,
} from './templates.js';

export { BUILT_IN_TEMPLATES, type BuiltInTemplate } from './builtin-templates.js';
export type { Resolution, ResolveHost, SitesTarget } from './dns.js';
export type { ReadPeople } from './steps.js';
export {
  createPublicSiteHandlers,
  type PublicSiteHandlers,
  type PublicSiteOptions,
  type PageReaders,
  type PublicSiteRequest,
  type ReadSiteForms,
  type ServedSitePage,
  type ServedView,
} from './public.js';
export { DEFAULT_PAGE_CACHE, type PageCacheLimits } from './page-cache.js';
// The small scripts a published page may load, as the server reads and serves them: built
// with the renderer (packages/site-render/runtime), passed on here so the server needs no
// package of its own for them.
export type { PageScripts } from '@repo/site-render';
export {
  loadPageScripts,
  pageScriptPaths,
  type PageScriptFile,
  type PageScriptName,
} from '@repo/site-render/server';

export interface SiteRouteOptions {
  /** Names who saved a version of a page. Without it a version shows the kind of actor only. */
  readonly people?: ReadPeople;
  /**
   * The install's secret that signs share bundles, 32 characters or more. Without one the
   * export and import routes are not offered.
   */
  readonly bundleSecret?: string | undefined;
  /** Where this install's sites answer. Without it no DNS record is shown or checked. */
  readonly target?: SitesTarget | undefined;
  /** Looks a host name up. Without it a domain cannot be checked. */
  readonly resolve?: ResolveHost | undefined;
  /**
   * The install's own public address, when it serves public pages there (/s/<key>/…).
   * Without it no site, step or page has a live address, and a preview is refused.
   */
  readonly publicUrl?: string | undefined;
  /**
   * Keys the links that preview a draft: the server's public intake secret, the one the
   * public handlers are given. Left out, a preview is refused.
   */
  readonly previewSecret?: string | undefined;
  /** The forms module's reader, for a form shown on a page. Without it one is refused. */
  readonly forms?: ReadSiteForms | undefined;
  /**
   * Whether the install serves booking pages at its public address (/book/…), which a
   * calendar on a page links to. Left out or false, a calendar on a page is refused.
   */
  readonly booking?: boolean | undefined;
  /**
   * Where the install's small page scripts are loaded from, each only when the server has
   * it to send: the same addresses the public handlers are given.
   */
  readonly scripts?: PageScripts | undefined;
  /** The clock, in milliseconds. Tests pass their own. */
  readonly now?: (() => number) | undefined;
}

/**
 * A result with each live address made whole. The module writes a live address as a path
 * on the install (`/s/<key>/<path>`); only here is the install's own address known, and
 * whether it serves public pages at all: where it does not, nothing is live.
 */
function withLiveUrls(route: ApiRoute, publicUrl: string | undefined): ApiRoute {
  const whole = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(whole);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = { ...value };
    if (typeof out['liveUrl'] === 'string')
      out['liveUrl'] =
        publicUrl === undefined ? null : new URL(out['liveUrl'], publicUrl).toString();
    // A site's steps and a list's items: never a page's document, which holds no address of ours.
    for (const key of ['steps', 'items']) if (key in out) out[key] = whole(out[key]);
    return out;
  };
  return { ...route, run: async (request, services) => whole(await route.run(request, services)) };
}

/** A route that runs a command with the request's path parameters and body as its input. */
function commandRoute<Input extends z.ZodType, Output>(
  endpoint: Endpoint,
  command: Command<Input, Output>,
): ApiRoute {
  return {
    endpoint,
    command,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        command,
        {
          ...(endpoint.body === undefined ? {} : (parseInput(endpoint.body, body) as object)),
          ...(endpoint.params === undefined ? {} : parseInput(endpoint.params, params)),
        },
        invocation,
      ),
  };
}

/** The admin API's routes for sites. */
export function createSiteRoutes(options: SiteRouteOptions = {}): readonly ApiRoute[] {
  const domains = createDomainCommands(options.target);
  const { resolve } = options;
  const readers: PageReaders = {
    forms: options.forms,
    bookingUrl: options.booking === true ? options.publicUrl : undefined,
    scripts: options.scripts,
  };
  const pages = createPageCommands({ ...readers, now: options.now });

  const sites = {
    endpoint: listSites,
    run: ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const input = parseInput(listSites.query, query);
      return withTenant(db, invocation.context, (trx) => readSites(trx, invocation, input));
    },
  } satisfies Route<typeof listSites>;
  const site = {
    endpoint: getSite,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getSite.params, params);
      return withTenant(db, invocation.context, (trx) => readSite(trx, invocation, id));
    },
  } satisfies Route<typeof getSite>;
  const folders = {
    endpoint: listSiteFolders,
    run: ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const { kind } = parseInput(listSiteFolders.query, query);
      return withTenant(db, invocation.context, (trx) => readSiteFolders(trx, invocation, kind));
    },
  } satisfies Route<typeof listSiteFolders>;
  const step = {
    endpoint: getSiteStep,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getSiteStep.params, params);
      return withTenant(db, invocation.context, (trx) => readSiteStep(trx, invocation, id));
    },
  } satisfies Route<typeof getSiteStep>;
  const page = {
    endpoint: getSitePage,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getSitePage.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readSitePage(trx, invocation, id, readers),
      );
    },
  } satisfies Route<typeof getSitePage>;
  const preview = {
    endpoint: getSitePagePreview,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getSitePagePreview.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readSitePagePreview(trx, invocation, id, {
          publicUrl: options.publicUrl,
          secret: options.previewSecret,
          now: options.now,
        }),
      );
    },
  } satisfies Route<typeof getSitePagePreview>;
  const elements = {
    endpoint: listSitePageElements,
    run: ({ invocation }) => {
      requireBusiness(invocation.context);
      return Promise.resolve({ items: [...sitePageElements(options.scripts)] });
    },
  } satisfies Route<typeof listSitePageElements>;
  const publicStatus = {
    endpoint: getSitePublicStatus,
    run: ({ invocation }) => {
      requireBusiness(invocation.context);
      return Promise.resolve(
        sitePublicStatus({ publicUrl: options.publicUrl, scripts: options.scripts }),
      );
    },
  } satisfies Route<typeof getSitePublicStatus>;
  const versions = {
    endpoint: listSitePageVersions,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(listSitePageVersions.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readSitePageVersions(trx, invocation, id, options.people),
      );
    },
  } satisfies Route<typeof listSitePageVersions>;
  const version = {
    endpoint: getSitePageVersion,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const input = parseInput(getSitePageVersion.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readSitePageVersion(trx, invocation, input.id, input.version, options.people),
      );
    },
  } satisfies Route<typeof getSitePageVersion>;
  const stats = {
    endpoint: getSiteStats,
    run: ({ invocation, params, query }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getSiteStats.params, params);
      const range = parseInput(getSiteStats.query, query);
      return withTenant(db, invocation.context, (trx) => readSiteStats(trx, invocation, id, range));
    },
  } satisfies Route<typeof getSiteStats>;
  const templates = {
    endpoint: listSiteTemplates,
    run: ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const input = parseInput(listSiteTemplates.query, query);
      return withTenant(db, invocation.context, (trx) => readSiteTemplates(trx, invocation, input));
    },
  } satisfies Route<typeof listSiteTemplates>;
  const template = {
    endpoint: getSiteTemplate,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getSiteTemplate.params, params);
      return withTenant(db, invocation.context, (trx) => readSiteTemplate(trx, invocation, id));
    },
  } satisfies Route<typeof getSiteTemplate>;
  const sections = {
    endpoint: listSiteSections,
    run: ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const input = parseInput(listSiteSections.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readSiteSections(trx, invocation, input.site),
      );
    },
  } satisfies Route<typeof listSiteSections>;
  const domainList = {
    endpoint: listSiteDomains,
    run: ({ invocation }, { db }) => {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, (trx) => domains.list(trx, invocation));
    },
  } satisfies Route<typeof listSiteDomains>;
  const domain = {
    endpoint: getSiteDomain,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getSiteDomain.params, params);
      return withTenant(db, invocation.context, (trx) => domains.read(trx, invocation, id));
    },
  } satisfies Route<typeof getSiteDomain>;
  const redirects = {
    endpoint: listSiteRedirects,
    run: ({ invocation }, { db }) => {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, (trx) => readSiteRedirects(trx, invocation));
    },
  } satisfies Route<typeof listSiteRedirects>;

  // Checking a domain looks its name up first, outside any transaction, then records what
  // was found. Someone who may not manage domains is refused by the command before that
  // matters: the lookup's answer changes nothing by itself.
  const verify = {
    endpoint: verifySiteDomain,
    command: domains.check,
    run: async ({ invocation, params }, services) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(verifySiteDomain.params, params);
      const { hostname } = await withTenant(services.db, invocation.context, (trx) =>
        domains.read(trx, invocation, id),
      );
      const nothing: Resolution = { cnames: [], addresses: [] };
      // A name that does not resolve is an answer, not a failure of the check.
      const found = resolve === undefined ? nothing : await resolve(hostname).catch(() => nothing);
      return runCommand(
        services,
        domains.check,
        {
          id,
          cnames: found.cnames.slice(0, 20),
          addresses: found.addresses.slice(0, 40),
        },
        invocation,
      );
    },
  } satisfies Route<typeof verifySiteDomain>;

  const bundles =
    options.bundleSecret === undefined ? undefined : createBundleCommands(options.bundleSecret);

  const routes: readonly ApiRoute[] = [
    sites,
    commandRoute(createSite, createSiteCommand),
    site,
    commandRoute(updateSite, updateSiteCommand),
    commandRoute(deleteSite, deleteSiteCommand),
    commandRoute(cloneSite, cloneSiteCommand),
    commandRoute(setSiteSecurityHeaders, setSiteSecurityHeadersCommand),
    folders,
    commandRoute(createSiteFolder, createSiteFolderCommand),
    commandRoute(updateSiteFolder, updateSiteFolderCommand),
    commandRoute(deleteSiteFolder, deleteSiteFolderCommand),
    commandRoute(createSiteStep, createSiteStepCommand),
    step,
    commandRoute(updateSiteStep, updateSiteStepCommand),
    commandRoute(deleteSiteStep, deleteSiteStepCommand),
    commandRoute(cloneSiteStep, cloneSiteStepCommand),
    commandRoute(reorderSiteSteps, reorderSiteStepsCommand),
    page,
    commandRoute(saveSitePageDraft, pages.save),
    commandRoute(publishSitePage, pages.publish),
    commandRoute(unpublishSitePage, pages.unpublish),
    preview,
    publicStatus,
    elements,
    versions,
    version,
    commandRoute(restoreSitePageVersion, pages.restore),
    commandRoute(createSiteVariation, createSiteVariationCommand),
    commandRoute(setSiteSplitTest, setSiteSplitTestCommand),
    commandRoute(declareSiteWinner, declareSiteWinnerCommand),
    stats,
    commandRoute(resetSiteStats, resetSiteStatsCommand),
    templates,
    template,
    commandRoute(createSiteTemplate, createSiteTemplateCommand),
    commandRoute(updateSiteTemplate, updateSiteTemplateCommand),
    commandRoute(deleteSiteTemplate, deleteSiteTemplateCommand),
    commandRoute(setSiteTemplateFavorite, setSiteTemplateFavoriteCommand),
    sections,
    commandRoute(createSiteSection, createSiteSectionCommand),
    commandRoute(updateSiteSection, updateSiteSectionCommand),
    commandRoute(deleteSiteSection, deleteSiteSectionCommand),
    ...(bundles === undefined
      ? []
      : [commandRoute(exportSite, bundles.export), commandRoute(importSite, bundles.import)]),
    domainList,
    commandRoute(createSiteDomain, domains.create),
    domain,
    commandRoute(updateSiteDomain, domains.update),
    verify,
    commandRoute(deleteSiteDomain, domains.remove),
    redirects,
    commandRoute(createSiteRedirect, createSiteRedirectCommand),
    commandRoute(updateSiteRedirect, updateSiteRedirectCommand),
    commandRoute(deleteSiteRedirect, deleteSiteRedirectCommand),
  ];
  return routes.map((route) => withLiveUrls(route, options.publicUrl));
}
