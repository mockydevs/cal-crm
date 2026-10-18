// A stand-in for the domains and redirects API of Sites, which keeps them as the server
// does. Every request is parsed with the contract's own schema before it is answered, and
// every answer with the schema it is promised under, so a screen that sends or expects
// anything the contract does not have fails here.
import { expect, type Page, type Route } from '@playwright/test';
import {
  createSiteDomainInput,
  createSiteRedirectInput,
  deleteSiteDomain,
  deleteSiteRedirect,
  listSitesQuery,
  siteDomain as siteDomainSchema,
  siteDomainList,
  siteList,
  siteRedirect as siteRedirectSchema,
  siteRedirectList,
  updateSiteDomainInput,
  updateSiteRedirectInput,
  type SiteDomain,
  type SiteRedirect,
  type SiteSummary,
} from '@repo/contracts';
import { harbor } from './session';

const at = '2026-10-11T09:00:00.000Z';
const later = '2026-10-11T09:30:00.000Z';
const letters = '0123456789abcdefghjkmnpqrstvwxyz';
let made = 0;
/** An id as the server makes one: the prefix, then a UUIDv7 in base32. */
function idOf(prefix: string): string {
  made += 1;
  const tail = `${letters[Math.floor(made / 32) % 32] ?? '0'}${letters[made % 32] ?? '0'}`;
  return `${prefix}_01h455vb4pex5vsknk084sn0${tail}`;
}

/** Where the stand-in install's sites answer: what a CNAME names and what an A record names. */
const sitesHost = 'sites.crm.example';
const sitesAddress = '203.0.113.10';

/** The record the server works out for a host name: an A record for a root, else a CNAME. */
function recordOf(hostname: string): NonNullable<SiteDomain['record']> {
  const labels = hostname.split('.');
  return labels.length === 2
    ? { type: 'A', host: '@', value: sitesAddress }
    : { type: 'CNAME', host: labels.slice(0, -2).join('.'), value: sitesHost };
}

export function domainOf(hostname: string, rest: Partial<SiteDomain> = {}): SiteDomain {
  return {
    id: idOf('sdom'),
    hostname,
    record: recordOf(hostname),
    verification: { status: 'pending', error: null, checkedAt: null, verifiedAt: null },
    certificateStatus: 'none',
    wwwRedirect: false,
    defaultStepId: null,
    notFoundStepId: null,
    siteCount: 0,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}

export const verified: SiteDomain['verification'] = {
  status: 'verified',
  error: null,
  checkedAt: at,
  verifiedAt: at,
};

export function redirectOf(
  domain: SiteDomain,
  path: string,
  target: SiteRedirect['target'],
  status: SiteRedirect['status'] = 301,
): SiteRedirect {
  return {
    id: idOf('srdr'),
    domainId: domain.id,
    hostname: domain.hostname,
    path,
    target,
    status,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

export function siteOf(kind: SiteSummary['kind'], name: string): SiteSummary {
  return {
    id: idOf('site'),
    kind,
    name,
    folderId: null,
    stepCount: 1,
    domain: null,
    path: '',
    createdAt: at,
    updatedAt: at,
  };
}

interface Refusal {
  readonly status: 403 | 409 | 422;
  readonly detail?: string;
  readonly errors?: readonly { path: string; code: string; message: string }[];
}

export interface DomainsApi {
  domains: SiteDomain[];
  redirects: SiteRedirect[];
  /** What each change was sent, in order: "METHOD /path" and the parsed body. */
  readonly sent: { readonly call: string; readonly body: unknown }[];
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
 * Answers Settings → Domains & URL Redirects as the server does. `canManage: false` is
 * someone who may only read; `forbidden` is someone refused even that; `noAddress` is an
 * install that has not been told where its sites answer: no record, and a check is a 409.
 * A check finds what `pointsElsewhere` says: a host name listed there fails, any other is
 * verified.
 */
export async function fakeDomainsApi(
  page: Page,
  {
    domains = [],
    redirects = [],
    sites = [],
    canManage = true,
    forbidden = false,
    noAddress = false,
    pointsElsewhere = [],
  }: {
    readonly domains?: readonly SiteDomain[];
    readonly redirects?: readonly SiteRedirect[];
    readonly sites?: readonly SiteSummary[];
    readonly canManage?: boolean;
    readonly forbidden?: boolean;
    readonly noAddress?: boolean;
    readonly pointsElsewhere?: readonly string[];
  } = {},
): Promise<DomainsApi> {
  const refusals: { call: RegExp; refusal: Refusal }[] = [];
  const served = (domain: SiteDomain): SiteDomain =>
    noAddress ? { ...domain, record: null } : domain;
  const api: DomainsApi = {
    domains: domains.map(served),
    redirects: [...redirects],
    sent: [],
    refuse: (call, refusal) => {
      refusals.push({ call, refusal });
    },
  };
  const stale = (route: Route): Promise<void> =>
    problem(route, { status: 409, detail: 'Someone else changed it first. Reload and try again.' });
  const targetOf = (
    target: { type: 'site'; siteId: string } | { type: 'url'; url: string },
  ): SiteRedirect['target'] | undefined => {
    if (target.type === 'url') return target;
    const site = sites.find((each) => each.id === target.siteId);
    return site === undefined
      ? undefined
      : { type: 'site', siteId: site.id, siteName: site.name, siteKind: site.kind };
  };
  const noSuchSite: Refusal = {
    status: 422,
    errors: [
      {
        path: '/target/siteId',
        code: 'invalid_site',
        message: 'Choose a funnel or website of this business.',
      },
    ],
  };

  await page.route(
    /\/api\/v1\/(?:site-domains|site-redirects|sites)(?:[/?].*)?$/,
    async (route) => {
      const request = route.request();
      expect(request.headers()['business-id']).toBe(harbor.id);
      const url = new URL(request.url());
      const path = url.pathname.replace('/api/v1', '');
      const method = request.method();
      const call = `${method} ${path}`;
      if (forbidden) return problem(route, { status: 403 });
      const body: unknown = request.postData() === null ? undefined : request.postDataJSON();
      const refused = refusals.find((each) => each.call.test(call));
      if (refused !== undefined) {
        refusals.splice(refusals.indexOf(refused), 1);
        api.sent.push({ call, body });
        return problem(route, refused.refusal);
      }
      const [root, id, action] = path.split('/').filter((part) => part !== '');
      const json = (value: unknown, status = 200): Promise<void> =>
        route.fulfill({ status, json: value });
      const none = (): Promise<void> => route.fulfill({ status: 204 });
      const change = <Input>(parsed: Input): Input => {
        api.sent.push({ call, body: parsed });
        return parsed;
      };

      if (root === 'sites') {
        const asked = listSitesQuery.parse(Object.fromEntries(url.searchParams));
        const items = sites.filter((each) => each.kind === asked.kind);
        return json(siteList.parse({ items, total: items.length, next: null, canManage }));
      }

      if (root === 'site-domains') {
        if (call === 'GET /site-domains') {
          return json(
            siteDomainList.parse({
              items: api.domains.toSorted((one, other) =>
                one.hostname.localeCompare(other.hostname),
              ),
              canManage,
            }),
          );
        }
        if (call === 'POST /site-domains') {
          const input = change(createSiteDomainInput.parse(body));
          if (api.domains.some((each) => each.hostname === input.hostname)) {
            return problem(route, {
              status: 422,
              errors: [
                {
                  path: '/hostname',
                  code: 'taken',
                  message:
                    'This domain is already connected, here or in another business of this install.',
                },
              ],
            });
          }
          const domain = served(domainOf(input.hostname));
          api.domains.push(domain);
          return json(siteDomainSchema.parse(domain), 201);
        }
        const domain = api.domains.find((each) => each.id === id);
        if (domain === undefined) throw new Error(`No domain ${String(id)} in the stand-in.`);
        const put = (next: SiteDomain): Promise<void> => {
          const saved = { ...next, revision: next.revision + 1, updatedAt: later };
          api.domains = api.domains.map((each) => (each.id === saved.id ? saved : each));
          return json(siteDomainSchema.parse(saved));
        };
        if (method === 'POST' && action === 'verify') {
          change(undefined);
          if (noAddress) {
            return problem(route, {
              status: 409,
              detail:
                'This install has not been told where its sites answer, so a domain cannot be checked yet.',
            });
          }
          return put({
            ...domain,
            verification: pointsElsewhere.includes(domain.hostname)
              ? {
                  status: 'failed',
                  error: `${domain.hostname} does not point at this install yet.`,
                  checkedAt: later,
                  verifiedAt: null,
                }
              : { status: 'verified', error: null, checkedAt: later, verifiedAt: later },
          });
        }
        if (method === 'PATCH') {
          const input = change(updateSiteDomainInput.parse(body));
          if (input.revision !== domain.revision) return stale(route);
          return put({ ...domain, wwwRedirect: input.wwwRedirect ?? domain.wwwRedirect });
        }
        if (method === 'DELETE') {
          deleteSiteDomain.params.parse({ id });
          change(undefined);
          api.domains = api.domains.filter((each) => each.id !== id);
          api.redirects = api.redirects.filter((each) => each.domainId !== id);
          return none();
        }
        throw new Error(`The stand-in does not answer ${call}.`);
      }

      if (call === 'GET /site-redirects') {
        return json(
          siteRedirectList.parse({
            items: api.redirects.toSorted((one, other) =>
              `${one.hostname}${one.path}`.localeCompare(`${other.hostname}${other.path}`),
            ),
            canManage,
          }),
        );
      }
      const taken = (domainId: string, where: string, except?: string): boolean =>
        api.redirects.some(
          (each) => each.domainId === domainId && each.path === where && each.id !== except,
        );
      const pathTaken: Refusal = {
        status: 422,
        errors: [
          {
            path: '/path',
            code: 'taken',
            message: 'This domain already has a redirect at this path.',
          },
        ],
      };
      if (call === 'POST /site-redirects') {
        const input = change(createSiteRedirectInput.parse(body));
        const domain = api.domains.find((each) => each.id === input.domainId);
        if (domain === undefined) throw new Error('A redirect names a domain of the stand-in.');
        const target = targetOf(input.target);
        if (target === undefined) return problem(route, noSuchSite);
        if (taken(domain.id, input.path)) return problem(route, pathTaken);
        const redirect = redirectOf(domain, input.path, target, input.status);
        api.redirects.push(redirect);
        return json(siteRedirectSchema.parse(redirect), 201);
      }
      const redirect = api.redirects.find((each) => each.id === id);
      if (redirect === undefined) throw new Error(`No redirect ${String(id)} in the stand-in.`);
      if (method === 'PATCH') {
        const input = change(updateSiteRedirectInput.parse(body));
        if (input.revision !== redirect.revision) return stale(route);
        const target = targetOf(input.target);
        if (target === undefined) return problem(route, noSuchSite);
        if (taken(redirect.domainId, input.path, redirect.id)) return problem(route, pathTaken);
        const saved: SiteRedirect = {
          ...redirect,
          path: input.path,
          target,
          status: input.status,
          revision: redirect.revision + 1,
          updatedAt: later,
        };
        api.redirects = api.redirects.map((each) => (each.id === saved.id ? saved : each));
        return json(siteRedirectSchema.parse(saved));
      }
      if (method === 'DELETE') {
        deleteSiteRedirect.params.parse({ id });
        change(undefined);
        api.redirects = api.redirects.filter((each) => each.id !== id);
        return none();
      }
      throw new Error(`The stand-in does not answer ${call}.`);
    },
  );
  return api;
}
