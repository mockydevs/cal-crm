// Publishing as a visitor meets it: what the install's own address shows for a site's key
// and path, what it never shows, and the preview of a draft. Real Postgres, the module's
// own routes and its public handlers.
import { randomUUID } from 'node:crypto';

import {
  EMPTY_PAGE_DOCUMENT,
  site as siteContract,
  sitePage,
  sitePageElementList,
  sitePagePreview,
  siteStep,
  type PageDocument,
  type SitePage,
} from '@repo/contracts';
import { parsePublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  button,
  headline,
  openHarness,
  pageWith,
  PREVIEW_SECRET,
  PUBLIC_URL,
  type Harness,
  type Tenant,
} from '../test/harness.js';
import { createPublicSiteHandlers } from './index.js';
import { issuePreviewToken } from './preview-token.js';

let harness: Harness;
beforeAll(async () => {
  harness = await openHarness(inject('databaseServer'));
});
afterAll(async () => {
  await harness.close();
});

const request = () => ({ requestId: randomUUID() });
const uuid = (kind: Parameters<typeof parsePublicId>[0], id: string): string =>
  parsePublicId(kind, id) ?? '';

const publish = async (t: Tenant, page: SitePage, version?: number): Promise<SitePage> =>
  sitePage.parse(
    await t.call('publishSitePage', {
      params: { id: page.id },
      body: { revision: page.revision, ...(version === undefined ? {} : { version }) },
    }),
  );
const controlOf = async (t: Tenant, stepId: string): Promise<SitePage> => {
  const step = siteStep.parse(await t.call('getSiteStep', { params: { id: stepId } }));
  return t.page(step.pages[0]?.id ?? '');
};
const readSite = async (t: Tenant, id: string) =>
  siteContract.parse(await t.call('getSite', { params: { id } }));
const keyOf = async (t: Tenant, siteId: string): Promise<string> =>
  (await readSite(t, siteId)).publicKey ?? '';

/** A funnel with one step whose page says this, saved and not yet published. */
async function funnel(t: Tenant, text = 'Welcome aboard') {
  const site = await t.site();
  const step = await t.step(site.id, { name: 'Landing', path: 'landing' });
  const saved = await t.save(await controlOf(t, step.id), pageWith([headline('h', text)]));
  return { site, step, page: saved, key: await keyOf(t, site.id) };
}

describe('publishing a page', () => {
  it('gives every site a key of its own, which a copy does not share', async () => {
    const t = await harness.tenant();
    const { site, key } = await funnel(t);
    expect(key).toMatch(/^[a-z0-9]{32}$/);
    const copy = siteContract.parse(
      await t.call('cloneSite', { params: { id: site.id }, body: {} }),
    );
    expect(copy.publicKey).toMatch(/^[a-z0-9]{32}$/);
    expect(copy.publicKey).not.toBe(key);
    // The same key every time it is read: an address, once given out, stays good.
    expect(await keyOf(t, site.id)).toBe(key);
  });

  it('makes the page answer at the site’s key and the step’s path, and at the site’s own address', async () => {
    const t = await harness.tenant();
    const { site, step, page, key } = await funnel(t);
    expect(await harness.visit.page(key, 'landing', request())).toBeUndefined();
    expect(await harness.visit.page(key, '', request())).toBeUndefined();
    expect((await readSite(t, site.id)).liveUrl).toBeNull();
    expect(page.liveUrl).toBeNull();

    const before = harness.views.length;
    const published = await publish(t, page);
    expect(published.liveUrl).toBe(`${PUBLIC_URL}/s/${key}/landing`);
    const live = await readSite(t, site.id);
    expect(live.liveUrl).toBe(`${PUBLIC_URL}/s/${key}`);
    expect(live.steps[0]?.liveUrl).toBe(`${PUBLIC_URL}/s/${key}/landing`);
    expect(siteStep.parse(await t.call('getSiteStep', { params: { id: step.id } })).liveUrl).toBe(
      `${PUBLIC_URL}/s/${key}/landing`,
    );

    const served = await harness.visit.page(key, 'landing', request());
    expect(served?.html).toContain('<h1 class="hl">Welcome aboard</h1>');
    expect(served?.html).toContain('<title>Landing</title>');
    expect(served?.html).toContain(`<link rel="canonical" href="${PUBLIC_URL}/s/${key}/landing">`);
    expect(served?.html).toContain('<meta name="robots" content="noindex">');
    expect(served?.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(served?.policy).toContain("default-src 'none'; style-src 'sha256-");
    expect(served?.policy).toContain("frame-ancestors 'none'");
    expect(served?.policy).not.toContain('script-src');
    // The site's own address is its first step, the same bytes.
    const home = await harness.visit.page(key, '', request());
    expect(home?.etag).toBe(served?.etag);
    // Each page served to a visitor is told to whoever counts views, by its ids alone.
    expect(harness.views.slice(before)).toEqual([
      {
        businessId: t.businessId,
        siteId: uuid('site', site.id),
        stepId: uuid('site_step', step.id),
        pageId: uuid('site_page', page.id),
      },
      expect.objectContaining({ pageId: uuid('site_page', page.id) }),
    ]);
  });

  it('never shows a draft: a save after publishing changes nothing a visitor sees', async () => {
    const t = await harness.tenant();
    const { page, key } = await funnel(t, 'The published words');
    const published = await publish(t, page);
    const first = await harness.visit.page(key, 'landing', request());
    const edited = await t.save(published, pageWith([headline('h', 'A secret draft')]));
    expect(edited.hasUnpublishedChanges).toBe(true);
    const still = await harness.visit.page(key, 'landing', request());
    expect(still?.html).toContain('The published words');
    expect(still?.html).not.toContain('A secret draft');
    expect(still?.etag).toBe(first?.etag);
    // Publishing again makes the new version live, with a tag of its own.
    await publish(t, edited);
    const now = await harness.visit.page(key, 'landing', request());
    expect(now?.html).toContain('A secret draft');
    expect(now?.etag).not.toBe(first?.etag);
    // An older version can be made live again by its number.
    await publish(t, await t.page(page.id), published.currentVersion);
    expect((await harness.visit.page(key, 'landing', request()))?.html).toContain(
      'The published words',
    );
  });

  it('takes the page off the web when it is unpublished, and when its step or site is deleted', async () => {
    const t = await harness.tenant();
    const { site, step, page, key } = await funnel(t);
    const published = await publish(t, page);
    expect(await harness.visit.page(key, 'landing', request())).toBeDefined();
    const off = sitePage.parse(
      await t.call('unpublishSitePage', {
        params: { id: page.id },
        body: { revision: published.revision },
      }),
    );
    expect(off.liveUrl).toBeNull();
    expect(await harness.visit.page(key, 'landing', request())).toBeUndefined();
    expect(await harness.visit.page(key, '', request())).toBeUndefined();

    await publish(t, off);
    expect(await harness.visit.page(key, 'landing', request())).toBeDefined();
    await t.call('deleteSiteStep', { params: { id: step.id } });
    expect(await harness.visit.page(key, 'landing', request())).toBeUndefined();
    expect(await harness.visit.page(key, '', request())).toBeUndefined();

    const again = await funnel(t);
    await publish(t, again.page);
    expect(await harness.visit.page(again.key, 'landing', request())).toBeDefined();
    await t.call('deleteSite', { params: { id: again.site.id } });
    expect(await harness.visit.page(again.key, 'landing', request())).toBeUndefined();
    expect(await readSite(t, site.id)).toMatchObject({ liveUrl: null });
  });

  it('answers nothing for a key or a path that names nothing, in any spelling', async () => {
    const t = await harness.tenant();
    const { page, key } = await funnel(t);
    await publish(t, page);
    for (const [siteKey, path] of [
      [key, 'other'],
      [key, 'Landing'],
      [key, 'landing/'],
      [key, 'landing/more'],
      [key.toUpperCase(), 'landing'],
      [`${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`, 'landing'],
      ['short', 'landing'],
      ["' or 1=1 --", 'landing'],
      ['_preview', ''],
    ] as const)
      expect(await harness.visit.page(siteKey, path, request())).toBeUndefined();
  });

  it('serves one business’s site by its own key only, and nothing of a business that is off', async () => {
    const a = await harness.tenant();
    const b = await harness.tenant();
    const mine = await funnel(a, 'Mine alone');
    const theirs = await funnel(b, 'Theirs alone');
    await publish(a, mine.page);
    await publish(b, theirs.page);
    expect((await harness.visit.page(mine.key, 'landing', request()))?.html).toContain(
      'Mine alone',
    );
    expect((await harness.visit.page(theirs.key, 'landing', request()))?.html).toContain(
      'Theirs alone',
    );
    expect((await harness.visit.page(mine.key, 'landing', request()))?.html).not.toContain(
      'Theirs alone',
    );
    // One business cannot read, publish or preview another's page by its id.
    await expect(a.call('getSitePage', { params: { id: theirs.page.id } })).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    await expect(
      a.call('getSitePagePreview', { params: { id: theirs.page.id } }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(
      a.call('publishSitePage', { params: { id: theirs.page.id }, body: { revision: 1 } }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });

    await harness.database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [b.businessId]),
    );
    expect(await harness.visit.page(theirs.key, 'landing', request())).toBeUndefined();
    expect(await harness.visit.page(mine.key, 'landing', request())).toBeDefined();
  });

  it('shows a website’s home page at its own address, and each page at its path', async () => {
    const t = await harness.tenant();
    const site = await t.site({ kind: 'website' });
    const about = await t.step(site.id, { name: 'About', path: 'about/team' });
    const home = await t.step(site.id, { name: 'Home', path: 'home' });
    const key = await keyOf(t, site.id);
    await publish(
      t,
      await t.save(await controlOf(t, about.id), pageWith([headline('h', 'About us')])),
    );
    // The home page is not published yet, so the site's own address answers nothing.
    expect(await harness.visit.page(key, '', request())).toBeUndefined();
    expect((await readSite(t, site.id)).liveUrl).toBeNull();
    expect((await harness.visit.page(key, 'about/team', request()))?.html).toContain('About us');
    await publish(
      t,
      await t.save(await controlOf(t, home.id), pageWith([headline('h', 'Home sweet')])),
    );
    expect((await harness.visit.page(key, '', request()))?.html).toContain('Home sweet');
    expect((await readSite(t, site.id)).liveUrl).toBe(`${PUBLIC_URL}/s/${key}`);
  });

  it('links to the steps a visitor can reach, as the site is now', async () => {
    const t = await harness.tenant();
    const site = await t.site();
    const first = await t.step(site.id, { name: 'One', path: 'one' });
    const second = await t.step(site.id, { name: 'Two', path: 'two' });
    const key = await keyOf(t, site.id);
    const saved = await t.save(
      await controlOf(t, first.id),
      pageWith([
        button('next', { type: 'next_step' }),
        button('named', { type: 'step', stepId: second.id }),
      ]),
    );
    // The next step is not published: a warning, and the buttons lead nowhere yet.
    expect(saved.problems).toEqual([
      expect.objectContaining({ code: 'unpublished_step', nodeId: 'next', blocking: false }),
      expect.objectContaining({ code: 'unpublished_step', nodeId: 'named', blocking: false }),
    ]);
    await publish(t, saved);
    expect((await harness.visit.page(key, 'one', request()))?.html).not.toContain('<a ');
    await publish(t, await t.save(await controlOf(t, second.id), pageWith([headline('h', 'Two')])));
    const linked = await harness.visit.page(key, 'one', request());
    expect(linked?.html.match(new RegExp(`href="/s/${key}/two"`, 'g'))).toHaveLength(2);
    // Renaming the step moves the link with it: nothing rendered is kept from before.
    const step = siteStep.parse(await t.call('getSiteStep', { params: { id: second.id } }));
    await t.call('updateSiteStep', {
      params: { id: second.id },
      body: { revision: step.revision, path: 'thanks' },
    });
    expect((await harness.visit.page(key, 'one', request()))?.html).toContain(
      `href="/s/${key}/thanks"`,
    );
    expect(await harness.visit.page(key, 'two', request())).toBeUndefined();
  });

  it('serves the control page to everyone while a step has a variation', async () => {
    const t = await harness.tenant();
    const { step, page, key } = await funnel(t, 'The control');
    await publish(t, page);
    const made = siteStep.parse(
      await t.call('createSiteVariation', {
        params: { id: step.id },
        body: { revision: step.revision, copyControl: false },
      }),
    );
    const variation = await t.page(made.pages[1]?.id ?? '');
    const saved = await t.save(variation, pageWith([headline('h', 'The variation')]));
    expect(saved.problems).toEqual([
      expect.objectContaining({ code: 'variation_not_served', blocking: false }),
    ]);
    const published = await publish(t, saved);
    // A variation has no address of its own: nobody is served it yet.
    expect(published.liveUrl).toBeNull();
    await t.call('setSiteSplitTest', {
      params: { id: step.id },
      body: { revision: made.revision, active: true, controlWeight: 0 },
    });
    for (let visit = 0; visit < 5; visit += 1)
      expect((await harness.visit.page(key, 'landing', request()))?.html).toContain('The control');
  });

  it('refuses a page with a blocking problem, in sentences, and publishes nothing', async () => {
    const t = await harness.tenant();
    const site = await t.site();
    const step = await t.step(site.id, { path: 'landing' });
    const key = await keyOf(t, site.id);
    const empty = await controlOf(t, step.id);
    expect(empty.problems).toEqual([
      {
        code: 'empty_page',
        message: 'This page is empty. Add a section with some content before publishing.',
        nodeId: null,
        blocking: true,
      },
    ]);
    const refused = await publish(t, empty).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).issues).toEqual([
      {
        path: '/version',
        code: 'empty_page',
        message: 'This page is empty. Add a section with some content before publishing.',
      },
    ]);
    expect((await t.page(empty.id)).publishedVersion).toBeNull();
    expect(await harness.visit.page(key, 'landing', request())).toBeUndefined();

    const broken = await t.save(
      empty,
      pageWith([
        {
          id: 'pic',
          type: 'image',
          props: { src: null, alt: '', action: { type: 'none' }, optimize: true },
        },
        button('last', { type: 'next_step' }),
        { id: 'cal', type: 'calendar', props: { calendarId: null } },
      ]),
    );
    const issues = await publish(t, broken).catch((error: unknown) => error);
    expect((issues as ValidationError).issues).toEqual([
      expect.objectContaining({ path: '/document/pic', code: 'image_missing' }),
      expect.objectContaining({ path: '/document/last', code: 'no_next_step' }),
      expect.objectContaining({ path: '/document/cal', code: 'calendar_missing' }),
    ]);
    // An older version is checked as itself: version 1 is still the empty page.
    await expect(publish(t, broken, 1)).rejects.toBeInstanceOf(ValidationError);
    await expect(publish(t, broken, 99)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_version' })],
    });
  });

  it('refuses a stale revision and needs the permission to publish', async () => {
    const t = await harness.tenant();
    const { page, key } = await funnel(t);
    await expect(
      t.call('publishSitePage', { params: { id: page.id }, body: { revision: page.revision + 1 } }),
    ).rejects.toMatchObject({ name: 'ConflictError' });
    await expect(
      t.call(
        'publishSitePage',
        { params: { id: page.id }, body: { revision: page.revision } },
        t.as(['sites.manage']),
      ),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(await harness.visit.page(key, 'landing', request())).toBeUndefined();
    // A save from a version that is no longer the newest is refused, and stores nothing.
    await t.save(page, pageWith([headline('h', 'Second')]));
    await expect(t.save(page, pageWith([headline('h', 'Third')]))).rejects.toMatchObject({
      name: 'ConflictError',
    });
    expect((await t.page(page.id)).currentVersion).toBe(page.currentVersion + 1);
  });

  it('shows a published form through the CRM’s own embed, and refuses one that is not', async () => {
    const t = await harness.tenant();
    const { page, key } = await funnel(t);
    const formId = 'form_01h455vb4pex5vsknk084sn02q';
    const withForm = (id: string): PageDocument =>
      pageWith([{ id: 'signup', type: 'form', props: { formId: id } }]);
    const saved = await t.save(page, withForm(formId));
    expect(saved.problems).toEqual([
      expect.objectContaining({ code: 'form_gone', blocking: true }),
    ]);
    await expect(publish(t, saved)).rejects.toBeInstanceOf(ValidationError);
    const formKey = randomUUID().replaceAll('-', '');
    const setForm = (published: boolean) =>
      harness.setForm(t.businessId, uuid('form', formId), { publicKey: formKey, published });
    await setForm(false);
    expect((await t.page(page.id)).problems).toEqual([
      expect.objectContaining({ code: 'form_unpublished' }),
    ]);
    await setForm(true);
    await publish(t, await t.page(page.id));
    const served = await harness.visit.page(key, 'landing', request());
    expect(served?.html).toContain(
      `<script async src="/forms/embed.js" data-form-key="${formKey}"></script>`,
    );
    expect(served?.policy).toContain("script-src 'self'; connect-src 'self'");
    // A form unpublished after the page went live is no longer shown, and no script is allowed.
    await setForm(false);
    const without = await harness.visit.page(key, 'landing', request());
    expect(without?.html).not.toContain('<script');
    expect(without?.policy).not.toContain('script-src');
    await harness.removeForm(t.businessId, uuid('form', formId));
    // On an install that shows no public form, a form on a page cannot be shown at all.
    const noForms = sitePage.parse(
      await t.callWith({ ...harness.options, forms: undefined }, 'getSitePage', {
        params: { id: page.id },
      }),
    );
    expect(noForms.problems).toEqual([expect.objectContaining({ code: 'form_unavailable' })]);
  });

  it('shows a saved section as it is now, and applies only the site’s safe response headers', async () => {
    const t = await harness.tenant();
    const { site, page, key } = await funnel(t);
    const section = (await t.call('createSiteSection', {
      body: {
        name: 'Footer',
        siteId: null,
        document: {
          id: 'footer',
          type: 'section',
          props: { width: 'full' },
          rows: [
            {
              id: 'footer-row',
              type: 'row',
              columns: [
                {
                  id: 'footer-col',
                  type: 'column',
                  props: { span: 12 },
                  children: [headline('fh', 'Old footer')],
                },
              ],
            },
          ],
        },
      },
    })) as { id: string; revision: number };
    const document = {
      ...EMPTY_PAGE_DOCUMENT,
      sections: [{ id: 'shared', type: 'saved_section' as const, sectionId: section.id }],
    };
    await publish(t, await t.save(page, document));
    expect((await harness.visit.page(key, 'landing', request()))?.html).toContain('Old footer');
    const current = await readSite(t, site.id);
    await t.call('setSiteSecurityHeaders', {
      params: { id: site.id },
      body: {
        revision: current.revision,
        headers: [
          { name: 'Referrer-Policy', value: 'no-referrer' },
          { name: 'Content-Security-Policy', value: "default-src *; script-src 'unsafe-inline'" },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Clear-Site-Data', value: '"cookies"' },
          { name: 'Permissions-Policy', value: 'camera=()' },
        ],
      },
    });
    const served = await harness.visit.page(key, 'landing', request());
    expect(served?.headers).toEqual([
      { name: 'permissions-policy', value: 'camera=()' },
      { name: 'referrer-policy', value: 'no-referrer' },
    ]);
    expect(served?.policy).toContain("default-src 'none'");
  });
});

describe('previewing a draft', () => {
  const tokenOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

  it('gives a link that shows the newest saved version for an hour, and counts nothing', async () => {
    const t = await harness.tenant();
    const { page, key } = await funnel(t, 'Only a draft');
    const preview = sitePagePreview.parse(
      // Anyone in the business who may read the page: no permission of its own.
      await t.call('getSitePagePreview', { params: { id: page.id } }, t.as([])),
    );
    expect(preview.url).toMatch(
      new RegExp(`^${PUBLIC_URL}/s/_preview/[A-Za-z0-9_-]{70}\\.[A-Za-z0-9_-]{22}$`),
    );
    expect(Date.parse(preview.expiresAt)).toBe(harness.clock.now + 3_600_000);
    const before = harness.views.length;
    const shown = await harness.visit.preview(tokenOf(preview.url), request());
    expect(shown?.html).toContain('Only a draft');
    expect(shown?.policy).toContain("frame-ancestors 'self'");
    expect(harness.views).toHaveLength(before);
    // The draft is still not public.
    expect(await harness.visit.page(key, 'landing', request())).toBeUndefined();
    // The same link shows what is saved next: it names the page, not a version.
    await t.save(
      page,
      pageWith([
        headline('h', 'A newer draft'),
        { id: 'x', type: 'custom_code', props: { code: '<script>alert(1)</script>' } },
      ]),
    );
    const newer = await harness.visit.preview(tokenOf(preview.url), request());
    expect(newer?.html).toContain('A newer draft');
    expect(newer?.html).toContain('Custom code runs on your connected domain.');
    expect(newer?.html).not.toContain('alert(1)');

    harness.clock.now += 3_600_000;
    try {
      expect(await harness.visit.preview(tokenOf(preview.url), request())).toBeUndefined();
    } finally {
      harness.clock.now -= 3_600_000;
    }
  });

  it('opens nothing for a link that is not this server’s, or whose page or business is gone', async () => {
    const t = await harness.tenant();
    const { site, page } = await funnel(t);
    const preview = sitePagePreview.parse(
      await t.call('getSitePagePreview', { params: { id: page.id } }),
    );
    const token = tokenOf(preview.url);
    const other = createPublicSiteHandlers({
      db: harness.db,
      secret: `${PREVIEW_SECRET}-other`,
      publicUrl: PUBLIC_URL,
    });
    expect(await other.preview(token, { requestId: 'not-a-uuid' })).toBeUndefined();
    expect(await harness.visit.preview('nonsense', request())).toBeUndefined();
    // A link that names another business for this page finds nothing there.
    const stranger = await harness.tenant();
    const forged = issuePreviewToken(
      PREVIEW_SECRET,
      {
        agencyId: stranger.agencyId,
        businessId: stranger.businessId,
        pageId: uuid('site_page', page.id),
      },
      harness.clock.now + 60_000,
    );
    expect(await harness.visit.preview(forged, request())).toBeUndefined();
    expect(await harness.visit.preview(token, request())).toBeDefined();
    await harness.database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [t.businessId]),
    );
    expect(await harness.visit.preview(token, request())).toBeUndefined();
    await harness.database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'active' where id = $1`, [t.businessId]),
    );
    await t.call('deleteSite', { params: { id: site.id } });
    expect(await harness.visit.preview(token, request())).toBeUndefined();
  });

  it('is refused on an install that serves no public page, where nothing is live either', async () => {
    const t = await harness.tenant();
    const { site, page } = await funnel(t);
    await publish(t, page);
    for (const options of [
      { ...harness.options, publicUrl: undefined },
      { ...harness.options, previewSecret: undefined },
    ])
      await expect(
        t.callWith(options, 'getSitePagePreview', { params: { id: page.id } }),
      ).rejects.toMatchObject({
        name: 'ConflictError',
        message:
          'Public pages are switched off on this install, so there is nothing to preview on.',
      });
    const off = { ...harness.options, publicUrl: undefined };
    const read = siteContract.parse(await t.callWith(off, 'getSite', { params: { id: site.id } }));
    expect(read.liveUrl).toBeNull();
    expect(read.steps[0]?.liveUrl).toBeNull();
    expect(
      sitePage.parse(await t.callWith(off, 'getSitePage', { params: { id: page.id } })).liveUrl,
    ).toBeNull();
  });
});

describe('the element list', () => {
  it('tells the editor how each element type is shown', async () => {
    const t = await harness.tenant();
    const list = sitePageElementList.parse(await t.call('listSitePageElements', {}, t.as([])));
    expect(list.items).toHaveLength(13);
    expect(list.items.find((each) => each.type === 'calendar')?.note).toContain('booking page');
  });
});
