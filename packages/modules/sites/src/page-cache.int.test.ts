// A visit to a page that has not changed renders nothing, and a visit after anything the
// page is made from has changed is never sent the old page. One test for each thing a page
// depends on: change it, and the very next visit is the new page. Real Postgres: what a
// kept page is checked against is read by the database itself (private.site_page_state,
// 0089).
import { randomUUID } from 'node:crypto';

import { site as siteContract, sitePage, siteStep, type SitePage } from '@repo/contracts';
import { parsePublicId } from '@repo/kernel';
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
import { createPublicSiteHandlers, type ServedSitePage } from './index.js';

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
const publish = async (t: Tenant, page: SitePage): Promise<SitePage> =>
  sitePage.parse(
    await t.call('publishSitePage', { params: { id: page.id }, body: { revision: page.revision } }),
  );
const controlOf = async (t: Tenant, stepId: string): Promise<SitePage> => {
  const step = siteStep.parse(await t.call('getSiteStep', { params: { id: stepId } }));
  return t.page(step.pages[0]?.id ?? '');
};
const readSite = async (t: Tenant, id: string) =>
  siteContract.parse(await t.call('getSite', { params: { id } }));

/** A funnel with one published step at `landing` that shows these elements. */
async function live(t: Tenant, children: unknown[] = [headline('h', 'Welcome aboard')]) {
  const site = await t.site();
  const step = await t.step(site.id, { name: 'Landing', path: 'landing' });
  const page = await publish(t, await t.save(await controlOf(t, step.id), pageWith(children)));
  return { site, step, page, key: (await readSite(t, site.id)).publicKey ?? '' };
}

/** Visits the page and says whether that visit had to render it. */
async function visit(
  key: string,
  path = 'landing',
): Promise<{ page: ServedSitePage | undefined; rendered: boolean }> {
  const before = harness.renders.length;
  const page = await harness.visit.page(key, path, request());
  return { page, rendered: harness.renders.length > before };
}

/**
 * The page is kept (two visits, one render), then `change` is made, and the next visit is
 * given back: it must not be the page that was kept.
 */
async function afterChange(key: string, change: () => Promise<unknown>, path = 'landing') {
  const first = await visit(key, path);
  expect(first.page).toBeDefined();
  const second = await visit(key, path);
  expect(second.rendered).toBe(false);
  expect(second.page).toBe(first.page);
  await change();
  return { before: first.page, ...(await visit(key, path)) };
}

describe('a page that has not changed', () => {
  it('is rendered once and then sent as it is, the same bytes under the same tag', async () => {
    const t = await harness.tenant();
    const { key, site, step, page } = await live(t);
    const first = await visit(key);
    expect(first.rendered).toBe(true);
    for (let again = 0; again < 5; again += 1) {
      const next = await visit(key);
      expect(next.rendered).toBe(false);
      // The very object: its bytes are not made again either.
      expect(next.page).toBe(first.page);
    }
    expect(first.page?.body.equals(Buffer.from(first.page.html, 'utf8'))).toBe(true);
    expect(first.page?.view).toEqual({
      businessId: t.businessId,
      siteId: uuid('site', site.id),
      stepId: uuid('site_step', step.id),
      pageId: uuid('site_page', page.id),
    });
    // The site's own address is another address: kept by itself, the same page.
    const home = await visit(key, '');
    expect(home.rendered).toBe(true);
    expect(home.page?.etag).toBe(first.page?.etag);
    expect((await visit(key, '')).rendered).toBe(false);
  });

  it('is rendered by one request when many ask at once', async () => {
    const t = await harness.tenant();
    const { key } = await live(t);
    const before = harness.renders.length;
    const pages = await Promise.all(
      Array.from({ length: 20 }, () => harness.visit.page(key, 'landing', request())),
    );
    expect(harness.renders.length - before).toBe(1);
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]?.html).toContain('Welcome aboard');
  });

  it('is never kept when there is nothing to show: a page published later is there at once', async () => {
    const t = await harness.tenant();
    const site = await t.site();
    const step = await t.step(site.id, { name: 'Landing', path: 'landing' });
    const key = (await readSite(t, site.id)).publicKey ?? '';
    const saved = await t.save(await controlOf(t, step.id), pageWith([headline('h', 'Now live')]));
    for (let asked = 0; asked < 3; asked += 1)
      expect(await harness.visit.page(key, 'landing', request())).toBeUndefined();
    // Many at once, of a page that is not there: each is told so.
    expect(
      await Promise.all(
        Array.from({ length: 8 }, () => harness.visit.page(key, 'landing', request())),
      ),
    ).toEqual(Array.from({ length: 8 }, () => undefined));
    await publish(t, saved);
    expect((await visit(key)).page?.html).toContain('Now live');
  });

  it('is never a preview: a draft is rendered every time it is opened, and kept nowhere', async () => {
    const t = await harness.tenant();
    const { key, page } = await live(t);
    await visit(key);
    const draft = await t.save(await t.page(page.id), pageWith([headline('h', 'A draft')]));
    const link = (await t.call('getSitePagePreview', { params: { id: draft.id } })) as {
      url: string;
    };
    const token = link.url.slice(link.url.lastIndexOf('/') + 1);
    const before = harness.renders.length;
    const one = await harness.visit.preview(token, request());
    const two = await harness.visit.preview(token, request());
    expect(one?.html).toContain('A draft');
    expect(two).not.toBe(one);
    expect(one?.view).toBeUndefined();
    // And the live page is still the published one, still kept.
    expect(harness.renders.length).toBe(before);
    const still = await visit(key);
    expect(still.rendered).toBe(false);
    expect(still.page?.html).toContain('Welcome aboard');
  });
});

describe('a page is rendered again, on the next visit, after', () => {
  it('another version of it is published', async () => {
    const t = await harness.tenant();
    const { key, page } = await live(t);
    const next = await afterChange(key, async () => {
      // A save alone changes nothing a visitor sees, and renders nothing.
      const saved = await t.save(await t.page(page.id), pageWith([headline('h', 'Second')]));
      expect((await visit(key)).rendered).toBe(false);
      await publish(t, saved);
    });
    expect(next.rendered).toBe(true);
    expect(next.page?.html).toContain('Second');
    expect(next.page?.etag).not.toBe(next.before?.etag);
  });

  it('it is unpublished, and after it is published again', async () => {
    const t = await harness.tenant();
    const { key, page } = await live(t);
    let off: SitePage | undefined;
    const gone = await afterChange(key, async () => {
      off = sitePage.parse(
        await t.call('unpublishSitePage', {
          params: { id: page.id },
          body: { revision: (await t.page(page.id)).revision },
        }),
      );
    });
    expect(gone.page).toBeUndefined();
    expect((await visit(key)).page).toBeUndefined();
    if (off !== undefined) await publish(t, off);
    const back = await visit(key);
    expect(back.rendered).toBe(true);
    expect(back.page?.etag).toBe(gone.before?.etag);
  });

  it('its step is renamed', async () => {
    const t = await harness.tenant();
    const { key, step } = await live(t);
    const next = await afterChange(key, async () => {
      const current = siteStep.parse(await t.call('getSiteStep', { params: { id: step.id } }));
      await t.call('updateSiteStep', {
        params: { id: step.id },
        body: { revision: current.revision, name: 'A new name' },
      });
    });
    // The step's name is the page's title when the page names none.
    expect(next.before?.html).toContain('<title>Landing</title>');
    expect(next.page?.html).toContain('<title>A new name</title>');
  });

  it('its step moves to another path: the old address shows nothing, the new one the page', async () => {
    const t = await harness.tenant();
    const { key, step } = await live(t);
    const next = await afterChange(key, async () => {
      const current = siteStep.parse(await t.call('getSiteStep', { params: { id: step.id } }));
      await t.call('updateSiteStep', {
        params: { id: step.id },
        body: { revision: current.revision, path: 'moved' },
      });
    });
    expect(next.page).toBeUndefined();
    const moved = await visit(key, 'moved');
    expect(moved.page?.html).toContain(`href="${PUBLIC_URL}/s/${key}/moved"`);
  });

  it('a step it links to is published, moved, unpublished or deleted', async () => {
    const t = await harness.tenant();
    const site = await t.site();
    const one = await t.step(site.id, { name: 'One', path: 'landing' });
    const two = await t.step(site.id, { name: 'Two', path: 'two' });
    const key = (await readSite(t, site.id)).publicKey ?? '';
    await publish(
      t,
      await t.save(
        await controlOf(t, one.id),
        pageWith([button('named', { type: 'step', stepId: two.id })]),
      ),
    );
    const target = await t.save(await controlOf(t, two.id), pageWith([headline('h', 'Two')]));
    const published = await afterChange(key, () => publish(t, target));
    expect(published.before?.html).not.toContain('<a ');
    expect(published.page?.html).toContain(`href="/s/${key}/two"`);

    const moved = await afterChange(key, async () => {
      const current = siteStep.parse(await t.call('getSiteStep', { params: { id: two.id } }));
      await t.call('updateSiteStep', {
        params: { id: two.id },
        body: { revision: current.revision, path: 'thanks' },
      });
    });
    expect(moved.page?.html).toContain(`href="/s/${key}/thanks"`);

    const unpublished = await afterChange(key, async () => {
      const current = await controlOf(t, two.id);
      await t.call('unpublishSitePage', {
        params: { id: current.id },
        body: { revision: current.revision },
      });
    });
    expect(unpublished.page?.html).not.toContain('<a ');

    await publish(t, await controlOf(t, two.id));
    const deleted = await afterChange(key, () =>
      t.call('deleteSiteStep', { params: { id: two.id } }),
    );
    expect(deleted.before?.html).toContain(`href="/s/${key}/thanks"`);
    expect(deleted.page?.html).not.toContain('<a ');
  });

  it('the funnel’s steps are put in another order: the next step and the first step change', async () => {
    const t = await harness.tenant();
    const site = await t.site();
    const one = await t.step(site.id, { name: 'One', path: 'landing' });
    const two = await t.step(site.id, { name: 'Two', path: 'two' });
    const three = await t.step(site.id, { name: 'Three', path: 'three' });
    const key = (await readSite(t, site.id)).publicKey ?? '';
    await publish(
      t,
      await t.save(await controlOf(t, one.id), pageWith([button('next', { type: 'next_step' })])),
    );
    for (const [step, words] of [
      [two, 'Two'],
      [three, 'Three'],
    ] as const)
      await publish(t, await t.save(await controlOf(t, step.id), pageWith([headline('h', words)])));
    // The site's own address is its first step.
    expect((await visit(key, '')).page?.html).toContain(`href="/s/${key}/two"`);
    expect((await visit(key, '')).rendered).toBe(false);
    const next = await afterChange(key, async () => {
      await t.call('reorderSiteSteps', {
        params: { id: site.id },
        body: {
          revision: (await readSite(t, site.id)).revision,
          stepIds: [three.id, one.id, two.id],
        },
      });
    });
    expect(next.before?.html).toContain(`href="/s/${key}/two"`);
    expect(next.page?.html).toContain(`href="/s/${key}/two"`);
    const home = await visit(key, '');
    expect(home.rendered).toBe(true);
    expect(home.page?.html).toContain('Three');
    await t.call('reorderSiteSteps', {
      params: { id: site.id },
      body: {
        revision: (await readSite(t, site.id)).revision,
        stepIds: [three.id, two.id, one.id],
      },
    });
    // Now the page's step is the last: there is no next step to lead to.
    expect((await visit(key)).page?.html).not.toContain('<a ');
  });

  it('a saved section it shows is changed, and after that section is deleted', async () => {
    const t = await harness.tenant();
    const { key, page } = await live(t);
    const sectionOf = (words: string) => ({
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
              children: [headline('fh', words)],
            },
          ],
        },
      ],
    });
    const section = (await t.call('createSiteSection', {
      body: { name: 'Footer', siteId: null, document: sectionOf('Old footer') },
    })) as { id: string; revision: number };
    const document = pageWith(
      [headline('h', 'Above')],
      [{ id: 'shared', type: 'saved_section', sectionId: section.id }],
    );
    await publish(t, await t.save(await t.page(page.id), document));
    const changed = await afterChange(key, () =>
      t.call('updateSiteSection', {
        params: { id: section.id },
        body: { revision: section.revision, name: 'Footer', document: sectionOf('New footer') },
      }),
    );
    expect(changed.before?.html).toContain('Old footer');
    expect(changed.page?.html).toContain('New footer');
    expect(changed.page?.html).not.toContain('Old footer');

    // The module refuses to delete a section a page uses. Should one go all the same (a
    // row removed by hand), the page is still never the kept one.
    await expect(t.call('deleteSiteSection', { params: { id: section.id } })).rejects.toMatchObject(
      { name: 'ConflictError' },
    );
    const deleted = await afterChange(key, () =>
      harness.database.as('crm_owner', (sql) =>
        sql.query('delete from sites.saved_sections where id = $1', [
          uuid('site_section', section.id),
        ]),
      ),
    );
    expect(deleted.page?.html).toContain('Above');
    expect(deleted.page?.html).not.toContain('New footer');
  });

  it('a form it shows is unpublished, published again, given another key, or deleted', async () => {
    const t = await harness.tenant();
    const formId = 'form_01h455vb4pex5vsknk084sn02q';
    const id = uuid('form', formId);
    const first = randomUUID().replaceAll('-', '');
    await harness.setForm(t.businessId, id, { publicKey: first, published: true });
    const { key } = await live(t, [
      headline('h', 'Sign up'),
      { id: 'signup', type: 'form', props: { formId } },
    ]);

    const unpublished = await afterChange(key, () =>
      harness.setForm(t.businessId, id, { publicKey: first, published: false }),
    );
    expect(unpublished.before?.html).toContain(`data-form-key="${first}"`);
    expect(unpublished.before?.policy).toContain("script-src 'self'");
    expect(unpublished.page?.html).not.toContain('<script');
    expect(unpublished.page?.policy).not.toContain('script-src');

    const again = await afterChange(key, () =>
      harness.setForm(t.businessId, id, { publicKey: first, published: true }),
    );
    expect(again.page?.html).toContain(`data-form-key="${first}"`);

    const second = randomUUID().replaceAll('-', '');
    const rekeyed = await afterChange(key, () =>
      harness.setForm(t.businessId, id, { publicKey: second, published: true }),
    );
    expect(rekeyed.page?.html).toContain(`data-form-key="${second}"`);

    const archived = await afterChange(key, () =>
      harness.database.as('crm_owner', (sql) =>
        sql.query(
          `update forms.forms set status = 'archived', published_definition = null, published_at = null
           where business_id = $1 and id = $2`,
          [t.businessId, id],
        ),
      ),
    );
    expect(archived.page?.html).not.toContain('<script');
    await harness.setForm(t.businessId, id, { publicKey: second, published: true });
    const deleted = await afterChange(key, () => harness.removeForm(t.businessId, id));
    expect(deleted.before?.html).toContain('<script');
    expect(deleted.page?.html).not.toContain('<script');
  });

  it('the site’s response headers or its favicon are changed', async () => {
    const t = await harness.tenant();
    const { key, site } = await live(t);
    const headers = await afterChange(key, async () =>
      t.call('setSiteSecurityHeaders', {
        params: { id: site.id },
        body: {
          revision: (await readSite(t, site.id)).revision,
          headers: [{ name: 'Referrer-Policy', value: 'no-referrer' }],
        },
      }),
    );
    expect(headers.before?.headers).toEqual([]);
    expect(headers.page?.headers).toEqual([{ name: 'referrer-policy', value: 'no-referrer' }]);
    // The page itself is the same bytes: only what is sent with it changed.
    expect(headers.page?.etag).toBe(headers.before?.etag);

    const favicon = await afterChange(key, async () =>
      t.call('updateSite', {
        params: { id: site.id },
        body: {
          revision: (await readSite(t, site.id)).revision,
          faviconUrl: 'https://img.example/icon.png',
        },
      }),
    );
    expect(favicon.before?.html).not.toContain('rel="icon"');
    expect(favicon.page?.html).toContain('<link rel="icon" href="https://img.example/icon.png">');
  });

  it('a change that is not the page’s leaves it kept', async () => {
    const t = await harness.tenant();
    const { key, site } = await live(t);
    const other = await live(t, [headline('h', 'Another funnel')]);
    const renamed = await afterChange(key, async () => {
      // The site's own name is on no page; another site's pages are not this one's.
      await t.call('updateSite', {
        params: { id: site.id },
        body: { revision: (await readSite(t, site.id)).revision, name: 'Renamed' },
      });
      const page = await t.page(other.page.id);
      await publish(t, await t.save(page, pageWith([headline('h', 'Changed there')])));
    });
    expect(renamed.rendered).toBe(false);
    expect(renamed.page).toBe(renamed.before);
    expect((await visit(other.key)).page?.html).toContain('Changed there');
  });

  it('its business is switched off, and its site is deleted', async () => {
    const t = await harness.tenant();
    const { key } = await live(t);
    const off = await afterChange(key, () =>
      harness.database.as('crm_owner', (sql) =>
        sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [
          t.businessId,
        ]),
      ),
    );
    expect(off.page).toBeUndefined();
    await harness.database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'active' where id = $1`, [t.businessId]),
    );
    expect((await visit(key)).page?.etag).toBe(off.before?.etag);

    const second = await live(t);
    const deleted = await afterChange(second.key, () =>
      t.call('deleteSite', { params: { id: second.site.id } }),
    );
    expect(deleted.page).toBeUndefined();
  });

  it('a countdown on it ends', async () => {
    const t = await harness.tenant();
    const ends = harness.clock.now + 60_000;
    const { key } = await live(t, [
      {
        id: 'cd',
        type: 'countdown',
        props: {
          endsAt: new Date(ends).toISOString(),
          whenOver: { type: 'text', text: 'The offer has ended.' },
        },
      },
    ]);
    const started = harness.clock.now;
    try {
      const over = await afterChange(key, () => {
        // A moment before the end the page is still the kept one.
        harness.clock.now = ends - 1;
        return visit(key).then((still) => {
          expect(still.rendered).toBe(false);
          harness.clock.now = ends;
        });
      });
      expect(over.before?.html).toContain('<time datetime=');
      expect(over.rendered).toBe(true);
      expect(over.page?.html).toContain('The offer has ended.');
      // After its end nothing more changes by itself: the page is kept again.
      harness.clock.now = ends + 3_600_000;
      expect((await visit(key)).rendered).toBe(false);
    } finally {
      harness.clock.now = started;
    }
  });
});

describe('what a process keeps is bounded', () => {
  const handlersWith = (cache: { maxEntries?: number; maxBytes?: number }, renders: string[]) =>
    createPublicSiteHandlers({
      db: harness.db,
      secret: PREVIEW_SECRET,
      publicUrl: PUBLIC_URL,
      cache,
      onRendered: (view) => renders.push(view.pageId),
    });

  it('forgets the page used longest ago when there are too many, and renders it again', async () => {
    const t = await harness.tenant();
    const a = await live(t, [headline('h', 'Page A')]);
    const b = await live(t, [headline('h', 'Page B')]);
    const renders: string[] = [];
    const visits = handlersWith({ maxEntries: 1 }, renders);
    const see = (key: string) => visits.page(key, 'landing', request());
    expect((await see(a.key))?.html).toContain('Page A');
    await see(a.key);
    expect(renders).toHaveLength(1);
    // B takes the one place; A is rendered again when it is asked for next.
    expect((await see(b.key))?.html).toContain('Page B');
    await see(b.key);
    expect(renders).toHaveLength(2);
    expect((await see(a.key))?.html).toContain('Page A');
    expect(renders).toHaveLength(3);
  });

  it('keeps nothing when it is given no room, or less than a page', async () => {
    const t = await harness.tenant();
    const { key } = await live(t);
    for (const cache of [{ maxEntries: 0 }, { maxBytes: 0 }, { maxBytes: 100 }]) {
      const renders: string[] = [];
      const visits = handlersWith(cache, renders);
      const first = await visits.page(key, 'landing', request());
      const second = await visits.page(key, 'landing', request());
      expect(renders).toHaveLength(2);
      // The same bytes all the same: rendering is the same every time.
      expect(second?.etag).toBe(first?.etag);
    }
  });
});
