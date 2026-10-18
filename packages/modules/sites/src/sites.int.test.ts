// Funnels, websites and their folders against real Postgres: the lists, a site's settings,
// copying and deleting, and that another business sees none of it.
import {
  permissions,
  site as siteContract,
  siteFolder,
  siteFolderList,
  siteList,
  type Permission,
  type Site,
  type SiteFolder,
} from '@repo/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { headline, openHarness, pageWith, type Harness, type Tenant } from '../test/harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await openHarness(inject('databaseServer'));
});
afterAll(async () => {
  await harness.close();
});

const everythingBut = (...denied: Permission[]): readonly Permission[] =>
  permissions.filter((each) => !denied.includes(each));
const issueOf = async (work: Promise<unknown>): Promise<{ path: string; code: string }> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  const [issue] = (error as ValidationError).issues;
  return { path: issue.path, code: issue.code };
};

const folder = async (t: Tenant, name: string, kind = 'funnel'): Promise<SiteFolder> =>
  siteFolder.parse(await t.call('createSiteFolder', { body: { kind, name } }));
const read = async (t: Tenant, id: string): Promise<Site> =>
  siteContract.parse(await t.call('getSite', { params: { id } }));
const update = async (t: Tenant, current: Site, change: Record<string, unknown>): Promise<Site> =>
  siteContract.parse(
    await t.call('updateSite', {
      params: { id: current.id },
      body: { revision: current.revision, ...change },
    }),
  );
const list = async (t: Tenant, query: Record<string, unknown>) =>
  siteList.parse(await t.call('listSites', { query: { kind: 'funnel', ...query } }));

describe('folders', () => {
  it('are made, renamed from the revision read and deleted, each kind apart', async () => {
    const t = await harness.tenant();
    const campaigns = await folder(t, ' Campaigns ');
    expect(campaigns).toMatchObject({
      kind: 'funnel',
      name: 'Campaigns',
      siteCount: 0,
      revision: 1,
    });
    await folder(t, 'Campaigns', 'website');
    expect(await issueOf(folder(t, 'campaigns'))).toEqual({ path: '/name', code: 'taken' });

    const renamed = siteFolder.parse(
      await t.call('updateSiteFolder', {
        params: { id: campaigns.id },
        body: { name: 'Spring', revision: campaigns.revision },
      }),
    );
    expect(renamed).toMatchObject({ name: 'Spring', revision: 2 });
    await expect(
      t.call('updateSiteFolder', {
        params: { id: campaigns.id },
        body: { name: 'Stale', revision: campaigns.revision },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const inside = await t.site({ folderId: campaigns.id });
    expect(inside.folderId).toBe(campaigns.id);
    const listed = siteFolderList.parse(
      await t.call('listSiteFolders', { query: { kind: 'funnel' } }),
    );
    expect(listed.items.map((each) => [each.name, each.siteCount])).toEqual([['Spring', 1]]);
    expect(listed.canManage).toBe(true);

    // Deleting a folder leaves its sites, in no folder.
    await t.call('deleteSiteFolder', { params: { id: campaigns.id } });
    expect((await read(t, inside.id)).folderId).toBeNull();
    await expect(
      t.call('deleteSiteFolder', { params: { id: campaigns.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('stop at a hundred of a kind', async () => {
    const t = await harness.tenant();
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `insert into sites.folders (business_id, kind, name, created_by_kind)
         select app.business_id(), 'funnel', 'Folder ' || n, 'user' from generate_series(1, 100) n`,
      ),
    );
    expect(await issueOf(folder(t, 'One more'))).toEqual({ path: '/name', code: 'limit_reached' });
    // The other kind has its own hundred.
    await folder(t, 'One more', 'website');
  });
});

describe('a site', () => {
  it('starts blank with no steps, in the folder named, and reads back with its settings', async () => {
    const t = await harness.tenant();
    const made = await t.site({ kind: 'website', name: ' Our website ' });
    expect(made).toMatchObject({
      kind: 'website',
      name: 'Our website',
      folderId: null,
      stepCount: 0,
      steps: [],
      domain: null,
      path: '',
      faviconUrl: null,
      headCode: '',
      chatWidgetId: null,
      paymentLive: false,
      optimizeImages: true,
      securityHeaders: [],
      originTemplateId: null,
      revision: 1,
      canManage: true,
      canPublish: true,
      canShare: true,
    });
    expect(await read(t, made.id)).toEqual(made);
    // A funnel cannot go in a folder of websites.
    const websites = await folder(t, 'Sites', 'website');
    expect(await issueOf(t.site({ folderId: websites.id }))).toEqual({
      path: '/folderId',
      code: 'invalid_folder',
    });
  });

  it('is told what each person may do with it', async () => {
    const t = await harness.tenant();
    const made = await t.site();
    const looking = siteContract.parse(
      await t.call('getSite', { params: { id: made.id } }, t.as([])),
    );
    expect(looking).toMatchObject({ canManage: false, canPublish: false, canShare: false });
    await expect(
      t.call(
        'createSite',
        { body: { kind: 'funnel', name: 'No' } },
        t.as(everythingBut('sites.manage')),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await list(t, {})).canManage).toBe(true);
  });

  it('changes only the settings named, from the revision it was read at', async () => {
    const t = await harness.tenant();
    const made = await t.site();
    const campaigns = await folder(t, 'Campaigns');
    const changed = await update(t, made, {
      name: 'Renamed',
      folderId: campaigns.id,
      faviconUrl: 'https://img.example/favicon.ico',
      headCode: '<script>head()</script>',
      bodyCode: '<noscript>body</noscript>',
      paymentLive: true,
      requireCard: true,
      optimizeImages: false,
      lazyCustomCode: true,
      privacyFonts: true,
      autoSchema: true,
    });
    expect(changed).toMatchObject({
      name: 'Renamed',
      folderId: campaigns.id,
      faviconUrl: 'https://img.example/favicon.ico',
      headCode: '<script>head()</script>',
      bodyCode: '<noscript>body</noscript>',
      paymentLive: true,
      requireCard: true,
      optimizeImages: false,
      lazyCustomCode: true,
      privacyFonts: true,
      autoSchema: true,
      revision: 2,
    });
    // Nothing else moved.
    const again = await update(t, changed, { folderId: null });
    expect(again).toMatchObject({
      name: 'Renamed',
      folderId: null,
      paymentLive: true,
      revision: 3,
    });
    await expect(update(t, made, { name: 'Stale' })).rejects.toBeInstanceOf(ConflictError);
    // The audit log keeps how much code a site carries, never the code.
    const audited = await harness.database.as('crm_owner', (sql) =>
      sql.query<{ input: Record<string, unknown> }>(
        `select input from audit.commands where command = 'site.update' and business_id = $1
         order by recorded_at`,
        [t.businessId],
      ),
    );
    expect(JSON.stringify(audited)).not.toContain('head()');
    expect(audited[0]?.input).toMatchObject({ headCodeLength: 23, bodyCodeLength: 25 });
  });

  it('answers at one domain and path, which no other site of the business may take', async () => {
    const t = await harness.tenant();
    const hostname = `go-${t.businessId.slice(-8)}.example.com`;
    const domain = (await t.call('createSiteDomain', { body: { hostname } })) as { id: string };
    const first = await update(t, await t.site(), { domainId: domain.id, path: 'offers/spring' });
    expect(first).toMatchObject({
      domain: { id: domain.id, hostname, verified: false },
      path: 'offers/spring',
    });
    const second = await t.site();
    expect(
      await issueOf(update(t, second, { domainId: domain.id, path: 'offers/spring' })),
    ).toEqual({
      path: '/path',
      code: 'taken',
    });
    await update(t, second, { domainId: domain.id, path: '' });
    expect((await list(t, {})).items.find((each) => each.id === first.id)?.domain?.hostname).toBe(
      hostname,
    );
    // A domain of nobody, and a chat widget of nobody.
    const third = await t.site();
    expect(
      await issueOf(update(t, third, { domainId: toPublicId('site_domain', t.businessId) })),
    ).toEqual({ path: '/domainId', code: 'invalid_domain' });
    expect(
      await issueOf(update(t, third, { chatWidgetId: toPublicId('webchat_widget', t.businessId) })),
    ).toEqual({ path: '/chatWidgetId', code: 'invalid_widget' });
    expect(
      (await update(t, third, { chatWidgetId: null, domainId: null })).chatWidgetId,
    ).toBeNull();
  });

  it('replaces its response headers together', async () => {
    const t = await harness.tenant();
    const made = await t.site();
    const set = async (current: Site, headers: unknown[]) =>
      siteContract.parse(
        await t.call('setSiteSecurityHeaders', {
          params: { id: current.id },
          body: { revision: current.revision, headers },
        }),
      );
    const withTwo = await set(made, [
      { name: 'X-Frame-Options', value: 'DENY' },
      { name: 'Content-Security-Policy', value: "default-src 'self'" },
    ]);
    expect(withTwo.securityHeaders).toEqual([
      { name: 'Content-Security-Policy', value: "default-src 'self'" },
      { name: 'X-Frame-Options', value: 'DENY' },
    ]);
    expect(withTwo.revision).toBe(2);
    expect((await set(withTwo, [])).securityHeaders).toEqual([]);
    await expect(set(made, [])).rejects.toBeInstanceOf(ConflictError);
  });

  it('is copied with its steps, pages, headers and settings, and without its address', async () => {
    const t = await harness.tenant();
    const source = await t.site({ name: 'Spring offer' });
    const landing = await t.step(source.id, { name: 'Landing', path: 'landing' });
    const thanks = await t.step(source.id, { name: 'Thanks', path: 'thanks' });
    const [landingPage] = landing.pages;
    await t.save(
      await t.page(landingPage?.id ?? ''),
      pageWith([
        headline('title', 'Hello {{custom_values.business_name}}'),
        {
          id: 'go',
          type: 'button',
          props: { label: 'Go', subLabel: '', action: { type: 'step', stepId: thanks.id } },
        },
      ]),
    );
    const settled = await update(t, await read(t, source.id), { headCode: '<!-- head -->' });
    await t.call('setSiteSecurityHeaders', {
      params: { id: source.id },
      body: { revision: settled.revision, headers: [{ name: 'X-Frame-Options', value: 'DENY' }] },
    });

    const copy = siteContract.parse(
      await t.call('cloneSite', { params: { id: source.id }, body: {} }),
    );
    expect(copy).toMatchObject({
      name: 'Spring offer (copy)',
      kind: 'funnel',
      headCode: '<!-- head -->',
      domain: null,
      path: '',
      securityHeaders: [{ name: 'X-Frame-Options', value: 'DENY' }],
    });
    expect(copy.id).not.toBe(source.id);
    expect(copy.steps.map((step) => [step.name, step.path, step.position])).toEqual([
      ['Landing', 'landing', 0],
      ['Thanks', 'thanks', 1],
    ]);
    // New rows throughout, unpublished at version 1, and the button goes to the copy's own step.
    const [copiedLanding, copiedThanks] = copy.steps;
    expect(copiedLanding?.id).not.toBe(landing.id);
    const page = await t.page(copiedLanding?.pages[0]?.id ?? '');
    expect(page).toMatchObject({ currentVersion: 1, publishedVersion: null });
    const text = JSON.stringify(page.document);
    expect(text).toContain('{{custom_values.business_name}}');
    expect(text).toContain(copiedThanks?.id);
    expect(text).not.toContain(thanks.id);

    // A site with no steps copies as one with none, under the name given.
    const empty = await t.site();
    const named = siteContract.parse(
      await t.call('cloneSite', { params: { id: empty.id }, body: { name: 'Second' } }),
    );
    expect(named).toMatchObject({ name: 'Second', stepCount: 0 });
  });

  it('is deleted for good with everything under it', async () => {
    const t = await harness.tenant();
    const made = await t.site();
    await t.step(made.id);
    await t.call('deleteSite', { params: { id: made.id } });
    await expect(read(t, made.id)).rejects.toBeInstanceOf(NotFoundError);
    const left = await t.read((trx) => trx.selectFrom('sites.steps').select('id').execute());
    expect(left).toEqual([]);
    await expect(t.call('deleteSite', { params: { id: made.id } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(t.call('getSite', { params: { id: 'not-an-id' } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('stops at five hundred in a business', async () => {
    const t = await harness.tenant();
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `insert into sites.sites (business_id, kind, name, created_by_kind)
         select app.business_id(), 'website', 'Site ' || n, 'user' from generate_series(1, 500) n`,
      ),
    );
    expect(await issueOf(t.site())).toEqual({ path: '/name', code: 'limit_reached' });
  });
});

describe('the lists', () => {
  it('show one kind, search by name, filter by folder, and page in either order', async () => {
    const t = await harness.tenant();
    const campaigns = await folder(t, 'Campaigns');
    const alpha = await t.site({ name: 'Alpha launch' });
    const beta = await t.site({ name: 'beta 100% offer', folderId: campaigns.id });
    const gamma = await t.site({ name: 'Gamma' });
    await t.site({ kind: 'website', name: 'A website' });
    await t.step(alpha.id);

    const byName = await list(t, { sort: 'name' });
    expect(byName.items.map((each) => each.name)).toEqual([
      'Alpha launch',
      'beta 100% offer',
      'Gamma',
    ]);
    expect(byName).toMatchObject({ total: 3, next: null });
    expect(byName.items[0]?.stepCount).toBe(1);

    // Adding a step made Alpha the newest change.
    const recent = await list(t, { limit: '2' });
    expect(recent.items.map((each) => each.id)).toEqual([alpha.id, gamma.id]);
    expect(recent.total).toBe(3);
    const rest = await list(t, { limit: '2', after: recent.next ?? '' });
    expect(rest.items.map((each) => each.id)).toEqual([beta.id]);
    expect(rest.next).toBeNull();

    const firstByName = await list(t, { sort: 'name', limit: '1' });
    const secondByName = await list(t, { sort: 'name', limit: '1', after: firstByName.next ?? '' });
    expect(secondByName.items.map((each) => each.id)).toEqual([beta.id]);

    expect((await list(t, { q: '100%' })).items.map((each) => each.id)).toEqual([beta.id]);
    expect((await list(t, { q: '_' })).total).toBe(0);
    expect((await list(t, { folder: campaigns.id })).items.map((each) => each.id)).toEqual([
      beta.id,
    ]);
    expect((await list(t, { folder: 'none', sort: 'name' })).items.map((each) => each.id)).toEqual([
      alpha.id,
      gamma.id,
    ]);
    expect((await list(t, { kind: 'website' })).items.map((each) => each.name)).toEqual([
      'A website',
    ]);
    expect(await issueOf(list(t, { after: 'not-a-cursor' }))).toEqual({
      path: '/after',
      code: 'invalid_cursor',
    });
    expect(await issueOf(list(t, { after: Buffer.from('[1,2]').toString('base64url') }))).toEqual({
      path: '/after',
      code: 'invalid_cursor',
    });
  });

  it("never show, change or delete another business's site", async () => {
    const a = await harness.tenant();
    const b = await harness.tenant(a.agencyId);
    const theirs = await b.site({ name: 'Business B only' });
    const theirFolder = await folder(b, 'B only');
    expect((await list(a, {})).total).toBe(0);
    for (const work of [
      () => a.call('getSite', { params: { id: theirs.id } }),
      () =>
        a.call('updateSite', { params: { id: theirs.id }, body: { revision: 1, name: 'Mine' } }),
      () => a.call('deleteSite', { params: { id: theirs.id } }),
      () => a.call('cloneSite', { params: { id: theirs.id }, body: {} }),
      () =>
        a.call('setSiteSecurityHeaders', {
          params: { id: theirs.id },
          body: { revision: 1, headers: [] },
        }),
      () =>
        a.call('updateSiteFolder', {
          params: { id: theirFolder.id },
          body: { name: 'x', revision: 1 },
        }),
    ])
      await expect(work()).rejects.toBeInstanceOf(NotFoundError);
    expect(await issueOf(a.site({ folderId: theirFolder.id }))).toEqual({
      path: '/folderId',
      code: 'invalid_folder',
    });
    expect((await read(b, theirs.id)).name).toBe('Business B only');
    // Outside any business there is nothing to list.
    await expect(
      a.call(
        'listSites',
        { query: { kind: 'funnel' } },
        {
          ...a.as(),
          context: { agencyId: a.agencyId, actorKind: 'user', correlationId: 'x' },
        },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
