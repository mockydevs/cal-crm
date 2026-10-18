// Domains and redirects against real Postgres: the record a business is shown, what a
// check of it records, linking a domain's pages, and redirects.
import {
  siteDomain,
  siteDomainList,
  siteRedirect,
  siteRedirectList,
  SITE_DOMAIN_LIMITS,
  type SiteDomain,
} from '@repo/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { openHarness, TARGET, type Harness, type Tenant } from '../test/harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await openHarness(inject('databaseServer'));
});
afterAll(async () => {
  await harness.close();
});

const issuesOf = async (work: Promise<unknown>): Promise<{ path: string; code: string }[]> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues.map(({ path, code }) => ({ path, code }));
};
let serial = 0;
const host = (prefix = 'www'): string => `${prefix}.d${String(Date.now())}${String(serial++)}.com`;
const connect = async (t: Tenant, hostname = host()): Promise<SiteDomain> =>
  siteDomain.parse(await t.call('createSiteDomain', { body: { hostname } }));
const verify = async (t: Tenant, id: string): Promise<SiteDomain> =>
  siteDomain.parse(await t.call('verifySiteDomain', { params: { id } }));

describe('a domain', () => {
  it('is connected unverified, with the one DNS record to add', async () => {
    const t = await harness.tenant();
    const hostname = host('WWW');
    const made = await connect(t, `  ${hostname} `);
    expect(made).toMatchObject({
      hostname: hostname.toLowerCase(),
      record: { type: 'CNAME', host: 'www', value: TARGET.hostname },
      verification: { status: 'pending', error: null, checkedAt: null, verifiedAt: null },
      certificateStatus: 'none',
      wwwRedirect: false,
      defaultStepId: null,
      notFoundStepId: null,
      siteCount: 0,
      revision: 1,
    });
    const root = await connect(t, `r${String(Date.now())}${String(serial++)}.com`);
    expect(root.record).toEqual({ type: 'A', host: '@', value: '203.0.113.10' });
    expect(siteDomain.parse(await t.call('getSiteDomain', { params: { id: made.id } }))).toEqual(
      made,
    );
    const listed = siteDomainList.parse(await t.call('listSiteDomains'));
    expect(listed.items.map((each) => each.id).sort()).toEqual([made.id, root.id].sort());
    expect(listed.canManage).toBe(true);
    expect(siteDomainList.parse(await t.call('listSiteDomains', {}, t.as([]))).canManage).toBe(
      false,
    );
  });

  it('is held by one business in the whole install', async () => {
    const a = await harness.tenant();
    const b = await harness.tenant();
    const hostname = host();
    await connect(a, hostname);
    for (const t of [a, b])
      expect(await issuesOf(connect(t, hostname))).toEqual([{ path: '/hostname', code: 'taken' }]);
    await expect(connect(a, 'not a host')).rejects.toBeInstanceOf(ValidationError);
  });

  it('is verified when its name points at this install, by name or by address', async () => {
    const t = await harness.tenant();
    const made = await connect(t);
    // Nothing found yet: a failed check that says so, and can be run again.
    const missing = await verify(t, made.id);
    expect(missing.verification).toMatchObject({ status: 'failed', verifiedAt: null });
    expect(missing.verification.error).toContain('No DNS record was found');
    expect(missing.verification.checkedAt).not.toBeNull();
    expect(missing.revision).toBe(2);

    harness.dns.set(made.hostname, {
      cnames: ['elsewhere.example.net.'],
      addresses: ['198.51.100.7'],
    });
    expect((await verify(t, made.id)).verification.error).toContain(
      'points at elsewhere.example.net',
    );

    harness.dns.set(made.hostname, { cnames: [`${TARGET.hostname}.`], addresses: [] });
    const verified = await verify(t, made.id);
    expect(verified.verification).toMatchObject({ status: 'verified', error: null });
    const since = verified.verification.verifiedAt;
    expect(since).not.toBeNull();
    // A later check keeps the moment it was first seen pointing here.
    harness.dns.set(made.hostname, { cnames: [], addresses: ['203.0.113.10'] });
    expect((await verify(t, made.id)).verification.verifiedAt).toBe(since);
    // And a record taken away again is noticed.
    harness.dns.set(made.hostname, new Error('SERVFAIL'));
    expect((await verify(t, made.id)).verification).toMatchObject({
      status: 'failed',
      verifiedAt: null,
    });
  });

  it('cannot be checked where the install has not been told its sites address or how to look one up', async () => {
    const t = await harness.tenant();
    const made = await connect(t);
    const bare = siteDomain.parse(
      await t.callWith({}, 'getSiteDomain', { params: { id: made.id } }),
    );
    expect(bare.record).toBeNull();
    await expect(
      t.callWith({}, 'verifySiteDomain', { params: { id: made.id } }),
    ).rejects.toBeInstanceOf(ConflictError);
    // With an address and no way to look names up, a check finds nothing rather than failing.
    const blind = siteDomain.parse(
      await t.callWith({ target: TARGET }, 'verifySiteDomain', { params: { id: made.id } }),
    );
    expect(blind.verification.status).toBe('failed');
    await expect(
      t.call('verifySiteDomain', { params: { id: made.id } }, t.as(['sites.manage'])),
    ).rejects.toMatchObject({ permission: 'domains.manage' });
  });

  it('opens at a step of the business, and is linked to sites that keep their own paths', async () => {
    const t = await harness.tenant();
    const other = await harness.tenant(t.agencyId);
    const made = await connect(t);
    const site = await t.site();
    const home = await t.step(site.id);
    const lost = await t.step(site.id);
    const theirs = await other.step((await other.site()).id);
    const change = (body: Record<string, unknown>) =>
      t.call('updateSiteDomain', { params: { id: made.id }, body });
    const changed = siteDomain.parse(
      await change({
        revision: 1,
        wwwRedirect: true,
        defaultStepId: home.id,
        notFoundStepId: lost.id,
      }),
    );
    expect(changed).toMatchObject({
      wwwRedirect: true,
      defaultStepId: home.id,
      notFoundStepId: lost.id,
      revision: 2,
    });
    await expect(change({ revision: 1, wwwRedirect: false })).rejects.toBeInstanceOf(ConflictError);
    expect(await issuesOf(change({ revision: 2, defaultStepId: theirs.id }))).toEqual([
      { path: '/defaultStepId', code: 'invalid_step' },
    ]);
    expect(await issuesOf(change({ revision: 2, notFoundStepId: theirs.id }))).toEqual([
      { path: '/notFoundStepId', code: 'invalid_step' },
    ]);
    expect(siteDomain.parse(await change({ revision: 2, defaultStepId: null }))).toMatchObject({
      defaultStepId: null,
      notFoundStepId: lost.id,
      wwwRedirect: true,
    });

    await t.call('updateSite', {
      params: { id: site.id },
      body: { revision: site.revision, domainId: made.id, path: 'offers' },
    });
    expect((await verify(t, made.id)).siteCount).toBe(1);
    // Deleting the step a domain opens at leaves the domain, without that choice.
    await t.call('deleteSiteStep', { params: { id: lost.id } });
    const after = siteDomain.parse(await t.call('getSiteDomain', { params: { id: made.id } }));
    expect(after.notFoundStepId).toBeNull();
  });

  it('is disconnected with its redirects, leaving its sites without a domain', async () => {
    const t = await harness.tenant();
    const made = await connect(t);
    const site = await t.site();
    await t.call('updateSite', {
      params: { id: site.id },
      body: { revision: site.revision, domainId: made.id },
    });
    await t.call('createSiteRedirect', {
      body: { domainId: made.id, path: '/old', target: { type: 'site', siteId: site.id } },
    });
    await t.call('deleteSiteDomain', { params: { id: made.id } });
    await expect(t.call('getSiteDomain', { params: { id: made.id } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(siteRedirectList.parse(await t.call('listSiteRedirects')).items).toEqual([]);
    expect(
      (await t.call('getSite', { params: { id: site.id } })) as { domain: unknown },
    ).toMatchObject({
      domain: null,
    });
    await expect(t.call('deleteSiteDomain', { params: { id: made.id } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('stops at fifty in a business, and is never another business’s to read or change', async () => {
    const t = await harness.tenant();
    const other = await harness.tenant(t.agencyId);
    const theirs = await connect(other);
    for (const work of [
      () => t.call('getSiteDomain', { params: { id: theirs.id } }),
      () =>
        t.call('updateSiteDomain', {
          params: { id: theirs.id },
          body: { revision: 1, wwwRedirect: true },
        }),
      () => t.call('verifySiteDomain', { params: { id: theirs.id } }),
      () => t.call('deleteSiteDomain', { params: { id: theirs.id } }),
    ])
      await expect(work()).rejects.toBeInstanceOf(NotFoundError);
    expect(siteDomainList.parse(await t.call('listSiteDomains')).items).toEqual([]);
    await expect(
      t.call('createSiteDomain', { body: { hostname: host() } }, t.as(['sites.manage'])),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `insert into sites.domains (business_id, hostname, created_by_kind)
         select app.business_id(), 'h' || n || '.' || $1, 'user' from generate_series(1, $2) n`,
        [host('limit'), SITE_DOMAIN_LIMITS.domains],
      ),
    );
    expect(await issuesOf(connect(t))).toEqual([{ path: '/hostname', code: 'limit_reached' }]);
  });
});

describe('a redirect', () => {
  it('sends a path on a domain to a site of the business or to a web address', async () => {
    const t = await harness.tenant();
    const domain = await connect(t);
    const site = await t.site({ kind: 'website', name: 'Our website' });
    const create = (body: Record<string, unknown>) => t.call('createSiteRedirect', { body });
    const toSite = siteRedirect.parse(
      await create({
        domainId: domain.id,
        path: '/old',
        target: { type: 'site', siteId: site.id },
      }),
    );
    expect(toSite).toMatchObject({
      domainId: domain.id,
      hostname: domain.hostname,
      path: '/old',
      target: { type: 'site', siteId: site.id, siteName: 'Our website', siteKind: 'website' },
      status: 301,
      revision: 1,
    });
    const toUrl = siteRedirect.parse(
      await create({
        domainId: domain.id,
        path: '/away',
        target: { type: 'url', url: 'https://example.org/new' },
        status: 302,
      }),
    );
    expect(toUrl).toMatchObject({
      target: { type: 'url', url: 'https://example.org/new' },
      status: 302,
    });
    expect(
      await issuesOf(create({ domainId: domain.id, path: '/old', target: toUrl.target })),
    ).toEqual([{ path: '/path', code: 'taken' }]);
    const listed = siteRedirectList.parse(await t.call('listSiteRedirects'));
    expect(listed.items.map((each) => each.path)).toEqual(['/away', '/old']);
    expect(listed.canManage).toBe(true);

    const change = (id: string, body: Record<string, unknown>) =>
      t.call('updateSiteRedirect', { params: { id }, body });
    const changed = siteRedirect.parse(
      await change(toUrl.id, {
        revision: 1,
        path: '/gone',
        target: { type: 'site', siteId: site.id },
        status: 301,
      }),
    );
    expect(changed).toMatchObject({
      path: '/gone',
      target: { type: 'site' },
      status: 301,
      revision: 2,
    });
    await expect(
      change(toUrl.id, { revision: 1, path: '/x', target: toUrl.target, status: 301 }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await issuesOf(
        change(toUrl.id, { revision: 2, path: '/old', target: toUrl.target, status: 301 }),
      ),
    ).toEqual([{ path: '/path', code: 'taken' }]);

    await t.call('deleteSiteRedirect', { params: { id: toUrl.id } });
    await expect(t.call('deleteSiteRedirect', { params: { id: toUrl.id } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // A redirect goes with the site it points at.
    await t.call('deleteSite', { params: { id: site.id } });
    expect(siteRedirectList.parse(await t.call('listSiteRedirects')).items).toEqual([]);
  });

  it('names only a domain and a site of its own business, and stops at five hundred', async () => {
    const t = await harness.tenant();
    const other = await harness.tenant(t.agencyId);
    const domain = await connect(t);
    const theirDomain = await connect(other);
    const theirSite = await other.site();
    const url = { type: 'url', url: 'https://example.org' };
    expect(
      await issuesOf(
        t.call('createSiteRedirect', {
          body: { domainId: theirDomain.id, path: '/a', target: url },
        }),
      ),
    ).toEqual([{ path: '/domainId', code: 'invalid_domain' }]);
    expect(
      await issuesOf(
        t.call('createSiteRedirect', {
          body: { domainId: domain.id, path: '/a', target: { type: 'site', siteId: theirSite.id } },
        }),
      ),
    ).toEqual([{ path: '/target/siteId', code: 'invalid_site' }]);
    await expect(
      t.call('updateSiteRedirect', {
        params: { id: toPublicId('site_redirect', t.businessId) },
        body: { revision: 1, path: '/a', target: url, status: 301 },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `insert into sites.redirects (business_id, domain_id, path, target_url, created_by_kind)
         select app.business_id(), $1, '/r' || n, 'https://example.org', 'user'
         from generate_series(1, $2) n`,
        [parsePublicId('site_domain', domain.id), SITE_DOMAIN_LIMITS.redirects],
      ),
    );
    expect(
      await issuesOf(
        t.call('createSiteRedirect', { body: { domainId: domain.id, path: '/a', target: url } }),
      ),
    ).toEqual([{ path: '/path', code: 'limit_reached' }]);
  });
});
