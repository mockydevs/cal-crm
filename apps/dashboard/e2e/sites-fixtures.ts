// A stand-in for the Sites API that keeps funnels, websites, folders, steps and templates
// as the server does. Every request is parsed with the contract's own schema before it is
// answered, and every answer with the schema it is promised under, so a screen that sends
// or expects anything the contract does not have fails here.
import { expect, type Page, type Route } from '@playwright/test';
import {
  cloneSiteInput,
  cloneSiteStepInput,
  createSiteFolderInput,
  createSiteInput,
  createSiteStepInput,
  createSiteVariationInput,
  declareSiteWinnerInput,
  importSiteInput,
  listSiteFoldersQuery,
  listSitesQuery,
  listSiteTemplatesQuery,
  reorderSiteStepsInput,
  setSiteSecurityHeadersInput,
  setSiteSplitTestInput,
  setSiteTemplateFavoriteInput,
  site as siteSchema,
  siteDomainList,
  siteFolderList,
  siteList,
  siteStats,
  siteStatsQuery,
  siteStep as siteStepSchema,
  siteTemplateList,
  updateSiteFolderInput,
  updateSiteInput,
  updateSiteStepInput,
  type Site,
  type SiteFolder,
  type SiteKind,
  type SitePageSummary,
  type SiteStepSummary,
  type SiteTemplateSummary,
} from '@repo/contracts';
import { harbor } from './session';

const at = '2026-10-11T09:00:00.000Z';
const letters = '0123456789abcdefghjkmnpqrstvwxyz';
let made = 0;
/** An id as the server makes one: the prefix, then a UUIDv7 in base32. */
export function idOf(prefix: string): string {
  made += 1;
  const tail = `${letters[Math.floor(made / 32) % 32] ?? '0'}${letters[made % 32] ?? '0'}`;
  return `${prefix}_01h455vb4pex5vsknk084sn0${tail}`;
}

export const domainId = 'sdom_01h455vb4pex5vsknk084sn02q';

function pageOf(role: SitePageSummary['role'], weight: number): SitePageSummary {
  return {
    id: idOf('spg'),
    role,
    weight,
    currentVersion: 1,
    publishedVersion: null,
    publishedAt: null,
    hasUnpublishedChanges: true,
  };
}

export function stepOf(name: string, path: string, position: number): SiteStepSummary {
  return {
    id: idOf('sstp'),
    name,
    path,
    position,
    splitTest: false,
    pages: [pageOf('control', 100)],
    revision: 1,
    updatedAt: at,
  };
}

export function siteOf(
  kind: SiteKind,
  name: string,
  steps: readonly [string, string][] = [],
  rest: Partial<Site> = {},
): Site {
  return {
    id: idOf('site'),
    kind,
    name,
    folderId: null,
    stepCount: steps.length,
    domain: null,
    path: '',
    createdAt: at,
    updatedAt: at,
    faviconUrl: null,
    headCode: '',
    bodyCode: '',
    chatWidgetId: null,
    paymentLive: false,
    requireCard: false,
    optimizeImages: true,
    lazyCustomCode: false,
    privacyFonts: false,
    autoSchema: false,
    keepArrival: 'unless_opted_out',
    securityHeaders: [],
    steps: steps.map(([stepName, path], index) => stepOf(stepName, path, index)),
    originTemplateId: null,
    revision: 1,
    canManage: true,
    canPublish: true,
    canShare: true,
    ...rest,
  };
}

export function folderOf(kind: SiteKind, name: string): SiteFolder {
  return {
    id: idOf('sfld'),
    kind,
    name,
    siteCount: 0,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

export function templateOf(
  kind: SiteKind,
  name: string,
  rest: Partial<SiteTemplateSummary> = {},
): SiteTemplateSummary {
  return {
    id: idOf('stpl'),
    kind,
    scope: 'builtin',
    name,
    description: 'A landing page and a thank-you page.',
    category: 'Coaching',
    pageType: 'Opt-in',
    tags: ['leads'],
    colors: ['#155eef', '#f79009'],
    previewFileId: null,
    stepCount: 2,
    uses: 3,
    favorite: false,
    canManage: false,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}

interface Refusal {
  readonly status: 403 | 409 | 422;
  readonly detail?: string;
  readonly errors?: readonly { path: string; code: string; message: string }[];
}

export interface SitesApi {
  sites: Site[];
  folders: SiteFolder[];
  templates: SiteTemplateSummary[];
  /** What each change was sent, in order: "METHOD /path" and the parsed body. */
  readonly sent: { readonly call: string; readonly body: unknown }[];
  /** The parsed query of every read of a list of sites, in order. */
  readonly lists: unknown[];
  /** Answers the next request whose "METHOD /path" matches with a refusal, once. */
  refuse: (call: RegExp, refusal: Refusal) => void;
}

const problem = (route: Route, refusal: Refusal): Promise<void> =>
  route.fulfill({
    status: refusal.status,
    contentType: 'application/problem+json',
    body: JSON.stringify({
      type: 'about:blank',
      title: 'Refused',
      status: refusal.status,
      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
      ...(refusal.errors === undefined ? {} : { errors: refusal.errors }),
    }),
  });

/**
 * Answers the Sites pages as the server does. `canManage: false` is someone who may only
 * read; `forbidden` is someone the business does not let read its sites at all.
 */
export async function fakeSitesApi(
  page: Page,
  {
    sites = [],
    folders = [],
    templates = [],
    canManage = true,
    forbidden = false,
  }: {
    readonly sites?: readonly Site[];
    readonly folders?: readonly SiteFolder[];
    readonly templates?: readonly SiteTemplateSummary[];
    readonly canManage?: boolean;
    readonly forbidden?: boolean;
  } = {},
): Promise<SitesApi> {
  const refusals: { call: RegExp; refusal: Refusal }[] = [];
  const api: SitesApi = {
    sites: sites.map((each) => ({ ...each, canManage, canShare: canManage })),
    folders: [...folders],
    templates: [...templates],
    sent: [],
    lists: [],
    refuse: (call, refusal) => {
      refusals.push({ call, refusal });
    },
  };
  const counted = (): SiteFolder[] =>
    api.folders.map((folder) => ({
      ...folder,
      siteCount: api.sites.filter((each) => each.folderId === folder.id).length,
    }));
  const found = (id: string | undefined): Site => {
    const site = api.sites.find((each) => each.id === id);
    if (site === undefined) throw new Error(`No site ${String(id)} in the stand-in.`);
    return site;
  };
  const put = (next: Site): Site => {
    const saved = { ...next, stepCount: next.steps.length, revision: next.revision + 1 };
    api.sites = api.sites.map((each) => (each.id === saved.id ? saved : each));
    return saved;
  };
  const owner = (stepId: string | undefined): { site: Site; step: SiteStepSummary } => {
    for (const site of api.sites) {
      const step = site.steps.find((each) => each.id === stepId);
      if (step !== undefined) return { site, step };
    }
    throw new Error(`No step ${String(stepId)} in the stand-in.`);
  };
  const putStep = (site: Site, step: SiteStepSummary): unknown => {
    const saved = { ...step, revision: step.revision + 1 };
    put({ ...site, steps: site.steps.map((each) => (each.id === saved.id ? saved : each)) });
    return siteStepSchema.parse({
      ...saved,
      siteId: site.id,
      siteKind: site.kind,
      canManage,
      canPublish: canManage,
    });
  };
  const stale = (route: Route): Promise<void> =>
    problem(route, { status: 409, detail: 'Someone else changed it first. Reload and try again.' });

  await page.route('**/api/v1/webchat/widgets', (route) => route.fulfill({ json: { data: [] } }));
  // Whether the install serves public pages: it does, unless a test says otherwise by
  // answering this address itself afterwards (the page editor's stand-in does).
  await page.route('**/api/v1/site-public-status', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        code: 'enabled',
        reason: null,
        baseUrl: 'https://crm.example/s',
        scripts: { countdown: true, popup: true },
      },
    }),
  );
  await page.route('**/api/v1/site-domains', (route) =>
    route.fulfill({
      json: siteDomainList.parse({
        items: [
          {
            id: domainId,
            hostname: 'go.harborlights.example',
            record: { type: 'CNAME', host: 'go', value: 'sites.crm.example' },
            verification: { status: 'verified', error: null, checkedAt: at, verifiedAt: at },
            certificateStatus: 'none',
            wwwRedirect: false,
            defaultStepId: null,
            notFoundStepId: null,
            siteCount: 0,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          },
        ],
        canManage,
      }),
    }),
  );
  await page.route(
    /\/api\/v1\/(?:sites|site-folders|site-steps|site-templates)(?:[/?].*)?$/,
    async (route) => {
      const request = route.request();
      expect(request.headers()['business-id']).toBe(harbor.id);
      const url = new URL(request.url());
      const path = url.pathname.replace('/api/v1', '');
      const call = `${request.method()} ${path}`;
      if (forbidden) return problem(route, { status: 403 });
      const query = Object.fromEntries(url.searchParams);
      const body: unknown = request.postData() === null ? undefined : request.postDataJSON();
      const refused = refusals.find((each) => each.call.test(call));
      if (refused !== undefined) {
        refusals.splice(refusals.indexOf(refused), 1);
        api.sent.push({ call, body });
        return problem(route, refused.refusal);
      }
      const parts = path.split('/').filter((part) => part !== '');
      const [root, id, action] = parts;
      const json = (value: unknown, status = 200): Promise<void> =>
        route.fulfill({ status, json: value });
      const none = (): Promise<void> => route.fulfill({ status: 204 });
      const change = <Input>(parsed: Input): Input => {
        api.sent.push({ call, body: parsed });
        return parsed;
      };

      if (root === 'site-folders') {
        if (call === 'GET /site-folders') {
          const asked = listSiteFoldersQuery.parse(query);
          return json(
            siteFolderList.parse({
              items: counted().filter((each) => each.kind === asked.kind),
              canManage,
            }),
          );
        }
        if (call === 'POST /site-folders') {
          const input = change(createSiteFolderInput.parse(body));
          const folder = folderOf(input.kind, input.name);
          api.folders.push(folder);
          return json(folder, 201);
        }
        const folder = api.folders.find((each) => each.id === id);
        if (folder === undefined) return problem(route, { status: 422 });
        if (request.method() === 'PATCH') {
          const input = change(updateSiteFolderInput.parse(body));
          if (input.revision !== folder.revision) return stale(route);
          const saved = { ...folder, name: input.name, revision: folder.revision + 1 };
          api.folders = api.folders.map((each) => (each.id === id ? saved : each));
          return json(saved);
        }
        change(undefined);
        api.folders = api.folders.filter((each) => each.id !== id);
        api.sites = api.sites.map((each) =>
          each.folderId === id ? { ...each, folderId: null } : each,
        );
        return none();
      }

      if (root === 'site-templates') {
        if (request.method() === 'GET') {
          const asked = listSiteTemplatesQuery.parse(query);
          const several = (text: string | undefined): string[] | undefined => text?.split(',');
          const ofKind = api.templates.filter(
            (each) =>
              each.kind === asked.kind &&
              (asked.list === 'all' ||
                (asked.list === 'favorites' && each.favorite) ||
                (asked.list === 'mine' && each.scope === 'business') ||
                (asked.list === 'shared' && each.scope === 'agency')),
          );
          const facet = (values: (string | null)[]): { value: string; count: number }[] =>
            [...new Set(values.filter((value) => value !== null))].map((value) => ({
              value,
              count: values.filter((each) => each === value).length,
            }));
          const items = ofKind.filter(
            (each) =>
              (several(asked.category)?.includes(each.category ?? '') ?? true) &&
              (several(asked.type)?.includes(each.pageType ?? '') ?? true) &&
              (several(asked.tag)?.some((tag) => each.tags.includes(tag)) ?? true) &&
              each.name.toLowerCase().includes((asked.q ?? '').toLowerCase()),
          );
          return json(
            siteTemplateList.parse({
              items,
              total: items.length,
              next: null,
              facets: {
                categories: facet(ofKind.map((each) => each.category)),
                types: facet(ofKind.map((each) => each.pageType)),
                tags: facet(ofKind.flatMap((each) => each.tags)),
              },
              canManage,
              canShare: false,
            }),
          );
        }
        const input = change(setSiteTemplateFavoriteInput.parse(body));
        api.templates = api.templates.map((each) =>
          each.id === id ? { ...each, favorite: input.favorite } : each,
        );
        return json(api.templates.find((each) => each.id === id));
      }

      if (root === 'site-steps') {
        const { site, step } = owner(id);
        if (action === 'clone') {
          change(cloneSiteStepInput.parse(body));
          const copy = stepOf(`${step.name} (copy)`, `${step.path}-copy`, site.steps.length);
          put({ ...site, steps: [...site.steps, copy] });
          return json(
            siteStepSchema.parse({
              ...copy,
              siteId: site.id,
              siteKind: site.kind,
              canManage,
              canPublish: canManage,
            }),
            201,
          );
        }
        if (action === 'variation') {
          const input = change(createSiteVariationInput.parse(body));
          if (input.revision !== step.revision) return stale(route);
          const [control] = step.pages;
          if (control === undefined) throw new Error('A step has a control page.');
          return json(
            putStep(site, {
              ...step,
              pages: [{ ...control, weight: 50 }, pageOf('variation', 50)],
            }),
            201,
          );
        }
        if (action === 'split-test') {
          const input = change(setSiteSplitTestInput.parse(body));
          if (input.revision !== step.revision) return stale(route);
          return json(
            putStep(site, {
              ...step,
              splitTest: input.active,
              pages: step.pages.map((each) => ({
                ...each,
                weight: each.role === 'control' ? input.controlWeight : 100 - input.controlWeight,
              })),
            }),
          );
        }
        if (action === 'winner') {
          const input = change(declareSiteWinnerInput.parse(body));
          if (input.revision !== step.revision) return stale(route);
          const kept = step.pages.find((each) => each.id === input.pageId);
          if (kept === undefined) return problem(route, { status: 422 });
          return json(
            putStep(site, {
              ...step,
              splitTest: false,
              pages: [{ ...kept, role: 'control', weight: 100 }],
            }),
          );
        }
        if (request.method() === 'PATCH') {
          const input = change(updateSiteStepInput.parse(body));
          if (input.revision !== step.revision) return stale(route);
          return json(
            putStep(site, {
              ...step,
              name: input.name ?? step.name,
              path: input.path ?? step.path,
            }),
          );
        }
        change(undefined);
        put({ ...site, steps: site.steps.filter((each) => each.id !== step.id) });
        return none();
      }

      // /sites
      if (call === 'GET /sites') {
        const asked = listSitesQuery.parse(query);
        api.lists.push(asked);
        const all = api.sites
          .filter(
            (each) =>
              each.kind === asked.kind &&
              (asked.folder === undefined ||
                (asked.folder === 'none'
                  ? each.folderId === null
                  : each.folderId === asked.folder)) &&
              each.name.toLowerCase().includes((asked.q ?? '').toLowerCase()),
          )
          .toSorted((one, other) =>
            asked.sort === 'name' ? one.name.localeCompare(other.name) : 0,
          );
        const start = Number(asked.after ?? '0');
        const items = all.slice(start, start + asked.limit);
        return json(
          siteList.parse({
            items: items.map(
              ({
                id: siteId,
                kind,
                name,
                folderId,
                stepCount,
                domain,
                path: sitePath,
                createdAt,
                updatedAt,
              }) => ({
                id: siteId,
                kind,
                name,
                folderId,
                stepCount,
                domain,
                path: sitePath,
                createdAt,
                updatedAt,
              }),
            ),
            total: all.length,
            next: start + asked.limit < all.length ? String(start + asked.limit) : null,
            canManage,
          }),
        );
      }
      if (call === 'POST /sites') {
        const input = change(createSiteInput.parse(body));
        const template = api.templates.find((each) => each.id === input.templateId);
        const created = siteOf(
          input.kind,
          input.name,
          template === undefined
            ? []
            : [
                ['Landing Page', 'landing'],
                ['Thank You', 'thank-you'],
              ],
          { folderId: input.folderId, originTemplateId: template?.id ?? null },
        );
        api.sites.unshift(created);
        return json(siteSchema.parse(created), 201);
      }
      if (call === 'POST /sites/import') {
        const input = change(importSiteInput.parse(body));
        const created = siteOf(
          'funnel',
          input.name ?? 'Shared funnel',
          [['Landing Page', 'landing']],
          {
            folderId: input.folderId,
          },
        );
        api.sites.unshift(created);
        return json(siteSchema.parse(created), 201);
      }
      if (api.sites.every((each) => each.id !== id)) {
        return route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404 }),
        });
      }
      const site = found(id);
      if (action === undefined) {
        if (request.method() === 'GET') return json(siteSchema.parse(site));
        if (request.method() === 'DELETE') {
          change(undefined);
          api.sites = api.sites.filter((each) => each.id !== id);
          return none();
        }
        const input = change(updateSiteInput.parse(body));
        if (input.revision !== site.revision) return stale(route);
        const { revision: _, domainId: chosenDomain, ...rest } = input;
        const settings = Object.fromEntries(
          Object.entries(rest).filter(([, value]) => value !== undefined),
        );
        return json(
          siteSchema.parse(
            put({
              ...site,
              ...settings,
              domain:
                chosenDomain === undefined
                  ? site.domain
                  : chosenDomain === null
                    ? null
                    : { id: chosenDomain, hostname: 'go.harborlights.example', verified: true },
            }),
          ),
        );
      }
      if (action === 'clone') {
        change(cloneSiteInput.parse(body));
        const copy = siteOf(
          site.kind,
          `${site.name} (copy)`,
          site.steps.map((each) => [each.name, each.path]),
          { folderId: site.folderId },
        );
        api.sites.unshift(copy);
        return json(siteSchema.parse(copy), 201);
      }
      if (action === 'security-headers') {
        const input = change(setSiteSecurityHeadersInput.parse(body));
        if (input.revision !== site.revision) return stale(route);
        return json(siteSchema.parse(put({ ...site, securityHeaders: input.headers })));
      }
      if (action === 'steps') {
        const input = change(createSiteStepInput.parse(body));
        const step = stepOf(input.name, input.path, site.steps.length);
        put({ ...site, steps: [...site.steps, step] });
        return json(
          siteStepSchema.parse({
            ...step,
            siteId: site.id,
            siteKind: site.kind,
            canManage,
            canPublish: canManage,
          }),
          201,
        );
      }
      if (action === 'step-order') {
        const input = change(reorderSiteStepsInput.parse(body));
        if (input.revision !== site.revision) return stale(route);
        const steps = input.stepIds.map((stepId, position) => ({
          ...owner(stepId).step,
          position,
        }));
        put({ ...site, steps });
        return json({ items: steps });
      }
      if (action === 'stats' && parts[3] === 'reset') {
        change(undefined);
        return none();
      }
      if (action === 'stats') {
        siteStatsQuery.parse(query);
        return json(
          siteStats.parse({
            from: '2026-09-28',
            to: '2026-10-11',
            steps: site.steps.map((each, index) => ({
              stepId: each.id,
              name: each.name,
              views: 1200 - index * 400,
              uniqueViews: 800 - index * 300,
              optIns: 100,
              optInRate: 0.125,
              orders: 0,
              orderQuantity: 0,
              orderAmount: '0',
              pages: [],
            })),
          }),
        );
      }
      if (action === 'export') {
        change(undefined);
        return json({ bundle: 'eyJzaXRlIjoiYnVuZGxlIn0.c2lnbmF0dXJl' });
      }
      throw new Error(`The stand-in has no answer for ${call}.`);
    },
  );
  return api;
}
