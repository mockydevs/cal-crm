// A site's steps, pages and page versions against real Postgres: order, paths, clone and
// delete; draft, publish, history and restore; split tests; statistics.
import {
  EMPTY_PAGE_DOCUMENT,
  SITE_LIMITS,
  sitePage,
  sitePageVersionDetail,
  sitePageVersionList,
  siteStats,
  siteStep,
  site as siteContract,
  type PageDocument,
  type SitePage,
  type SiteStep,
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

import {
  button,
  headline,
  openHarness,
  pageWith,
  type Harness,
  type Tenant,
} from '../test/harness.js';
import { readSiteStats } from './steps.js';

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
const readStep = async (t: Tenant, id: string): Promise<SiteStep> =>
  siteStep.parse(await t.call('getSiteStep', { params: { id } }));
const controlOf = (step: SiteStep): string => step.pages[0]?.id ?? '';
const publish = async (t: Tenant, page: SitePage, version?: number): Promise<SitePage> =>
  sitePage.parse(
    await t.call('publishSitePage', {
      params: { id: page.id },
      body: { revision: page.revision, ...(version === undefined ? {} : { version }) },
    }),
  );

describe('steps', () => {
  it('are added last, each with a path of its own and an empty control page', async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    const landing = await t.step(funnel.id, { name: ' Landing Page ', path: 'landing' });
    expect(landing).toMatchObject({
      name: 'Landing Page',
      path: 'landing',
      position: 0,
      splitTest: false,
      siteId: funnel.id,
      siteKind: 'funnel',
      revision: 1,
      canManage: true,
      canPublish: true,
    });
    expect(landing.pages).toHaveLength(1);
    expect(landing.pages[0]).toMatchObject({
      role: 'control',
      weight: 100,
      currentVersion: 1,
      publishedVersion: null,
      hasUnpublishedChanges: false,
    });
    const nested = await t.step(funnel.id, { name: 'Offer', path: 'offers/spring' });
    expect(nested.position).toBe(1);
    expect(await issuesOf(t.step(funnel.id, { path: 'landing' }))).toEqual([
      { path: '/path', code: 'taken' },
    ]);
    const page = await t.page(controlOf(landing));
    expect(page).toMatchObject({ stepId: landing.id, siteId: funnel.id, storedFormat: 1 });
    expect(page.document).toEqual(EMPTY_PAGE_DOCUMENT);
    await expect(t.step(toPublicId('site', t.businessId))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('are renamed and moved to another path from the revision read', async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    const landing = await t.step(funnel.id, { path: 'landing' });
    await t.step(funnel.id, { path: 'thanks' });
    const change = (body: Record<string, unknown>) =>
      t.call('updateSiteStep', { params: { id: landing.id }, body });
    const renamed = siteStep.parse(await change({ revision: 1, name: 'Start', path: 'start' }));
    expect(renamed).toMatchObject({ name: 'Start', path: 'start', revision: 2 });
    expect(siteStep.parse(await change({ revision: 2, name: 'Begin' }))).toMatchObject({
      name: 'Begin',
      path: 'start',
    });
    await expect(change({ revision: 1, name: 'Stale' })).rejects.toBeInstanceOf(ConflictError);
    expect(await issuesOf(change({ revision: 3, path: 'thanks' }))).toEqual([
      { path: '/path', code: 'taken' },
    ]);
  });

  it("are put in a new order in a funnel, all or none; a website's pages have no order", async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    const one = await t.step(funnel.id);
    const two = await t.step(funnel.id);
    const three = await t.step(funnel.id);
    const reorder = (siteId: string, revision: number, stepIds: string[]) =>
      t.call('reorderSiteSteps', { params: { id: siteId }, body: { revision, stepIds } });
    const current = siteContract.parse(await t.call('getSite', { params: { id: funnel.id } }));
    const moved = (await reorder(funnel.id, current.revision, [three.id, one.id, two.id])) as {
      items: SiteStep[];
    };
    expect(moved.items.map((step) => [step.id, step.position])).toEqual([
      [three.id, 0],
      [one.id, 1],
      [two.id, 2],
    ]);
    const after = siteContract.parse(await t.call('getSite', { params: { id: funnel.id } }));
    expect(after.steps.map((step) => step.id)).toEqual([three.id, one.id, two.id]);
    expect(after.revision).toBe(current.revision + 1);
    await expect(
      reorder(funnel.id, current.revision, [one.id, two.id, three.id]),
    ).rejects.toBeInstanceOf(ConflictError);
    const other = await t.step((await t.site()).id);
    for (const ids of [
      [one.id, two.id],
      [one.id, two.id, other.id],
    ])
      expect(await issuesOf(reorder(funnel.id, after.revision, ids))).toEqual([
        { path: '/stepIds', code: 'invalid_steps' },
      ]);
    const website = await t.site({ kind: 'website' });
    const home = await t.step(website.id);
    await expect(reorder(website.id, 1, [home.id])).rejects.toBeInstanceOf(ConflictError);
  });

  it('are copied within their site with the page as it stands, and deleted with their pages', async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    const landing = await t.step(funnel.id, { name: 'Landing', path: 'landing' });
    const thanks = await t.step(funnel.id, { name: 'Thanks', path: 'thanks' });
    await t.save(
      await t.page(controlOf(landing)),
      pageWith([
        headline('title', 'Hello'),
        button('next', { type: 'step', stepId: thanks.id }),
        button('self', { type: 'step', stepId: landing.id }),
      ]),
    );
    const copy = siteStep.parse(
      await t.call('cloneSiteStep', { params: { id: landing.id }, body: {} }),
    );
    expect(copy).toMatchObject({ name: 'Landing (copy)', path: 'landing-copy', position: 2 });
    const copied = await t.page(controlOf(copy));
    expect(copied).toMatchObject({ currentVersion: 1, publishedVersion: null });
    const text = JSON.stringify(copied.document);
    // A button to another step of the site still goes there; one to itself goes to the copy.
    expect(text).toContain(thanks.id);
    expect(text).toContain(copy.id);
    expect(text).not.toContain(landing.id);
    expect(
      await issuesOf(t.call('cloneSiteStep', { params: { id: landing.id }, body: {} })),
    ).toEqual([{ path: '/path', code: 'taken' }]);
    const named = siteStep.parse(
      await t.call('cloneSiteStep', {
        params: { id: landing.id },
        body: { name: 'Second', path: 'second' },
      }),
    );
    expect(named).toMatchObject({ name: 'Second', path: 'second' });

    await t.call('deleteSiteStep', { params: { id: landing.id } });
    await expect(readStep(t, landing.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.page(controlOf(landing))).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.call('deleteSiteStep', { params: { id: landing.id } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('stop at a hundred in a site', async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `insert into sites.steps (business_id, site_id, name, path, position, created_by_kind)
         select app.business_id(), $1, 'Step ' || n, 'step-' || n, n, 'user'
         from generate_series(1, $2) n`,
        [parsePublicId('site', funnel.id), SITE_LIMITS.steps],
      ),
    );
    expect(await issuesOf(t.step(funnel.id))).toEqual([{ path: '/steps', code: 'limit_reached' }]);
  });
});

describe('a page', () => {
  it('is saved as a new version from the version it was opened at, and never by a stale editor', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    const opened = await t.page(controlOf(step));
    const document = pageWith([headline('title', 'Hello {{custom_values.business_name}}')]);
    const saved = await t.save(opened, document);
    expect(saved).toMatchObject({ currentVersion: 2, publishedVersion: null, revision: 2 });
    expect(saved.document).toEqual(document);
    // A second editor who opened version 1 is told, and nothing is stored.
    await expect(t.save(opened, pageWith([headline('title', 'Theirs')]))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await t.page(opened.id)).currentVersion).toBe(2);
    // The audit log keeps that a page was saved and how large, not the page.
    const audited = await harness.database.as('crm_owner', (sql) =>
      sql.query<{ input: Record<string, unknown> }>(
        `select input from audit.commands
         where command = 'site_page.save' and business_id = $1 and outcome = 'ok'`,
        [t.businessId],
      ),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.input).toMatchObject({ baseVersion: 1, mode: 'visual' });
    expect(JSON.stringify(audited)).not.toContain('custom_values');
  });

  it('refuses a document that is not valid, and saves nothing of it', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    const opened = await t.page(controlOf(step));
    const attempt = (document: unknown) =>
      t.call('saveSitePageDraft', {
        params: { id: opened.id },
        body: { baseVersion: 1, document },
      });
    for (const document of [
      { ...EMPTY_PAGE_DOCUMENT, format: 2 },
      { ...EMPTY_PAGE_DOCUMENT, sections: [{ id: 'x', type: 'marquee' }] },
      pageWith([headline('same', 'One'), headline('same', 'Two')]),
      pageWith([button('open', { type: 'popup', popupId: 'missing' })]),
      pageWith([button('go', { type: 'url', href: 'javascript:alert(1)', newTab: false })]),
    ])
      await expect(attempt(document)).rejects.toBeInstanceOf(ValidationError);
    expect((await t.page(opened.id)).currentVersion).toBe(1);
    const versions = await t.read((trx) =>
      trx.selectFrom('sites.page_versions').select('number').execute(),
    );
    expect(versions).toEqual([{ number: 1 }]);
  });

  it('may point only at steps of its own site and at saved sections it can use', async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    const step = await t.step(funnel.id);
    const sibling = await t.step(funnel.id);
    const elsewhere = await t.step((await t.site()).id);
    const opened = await t.page(controlOf(step));
    const section = { id: 's', type: 'section', props: { width: 'full' }, rows: [] };
    const make = async (siteId: string | null, name: string) =>
      (
        (await t.call('createSiteSection', { body: { siteId, name, document: section } })) as {
          id: string;
        }
      ).id;
    const universal = await make(null, 'Header');
    const own = await make(funnel.id, 'Footer');
    const foreign = await make(elsewhere.siteId, 'Theirs');
    const ref = (id: string, sectionId: string) => ({ id, type: 'saved_section', sectionId });

    const good = await t.save(
      opened,
      pageWith(
        [button('next', { type: 'step', stepId: sibling.id })],
        [ref('header', universal), ref('footer', own)],
      ),
    );
    expect(good.currentVersion).toBe(2);
    expect(
      await issuesOf(
        t.save(
          good,
          pageWith(
            [button('away', { type: 'step', stepId: elsewhere.id })],
            [ref('theirs', foreign), ref('none', toPublicId('site_section', t.businessId))],
          ),
        ),
      ),
    ).toEqual([
      { path: '/document/sections', code: 'invalid_section' },
      { path: '/document/sections', code: 'invalid_section' },
      { path: '/document', code: 'invalid_step' },
    ]);
  });

  it('takes a code page: files instead of sections', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site({ kind: 'website' })).id);
    const code: PageDocument = {
      format: 1,
      mode: 'code',
      settings: { seo: EMPTY_PAGE_DOCUMENT.settings.seo },
      files: [
        { path: 'index.html', kind: 'text', content: '<h1>Hello</h1>' },
        { path: 'css/site.css', kind: 'text', content: 'h1 { color: #111827 }' },
      ],
    };
    const saved = await t.save(await t.page(controlOf(step)), code);
    expect(saved.document).toEqual(code);
  });

  it('is published at the newest version or any kept one, unpublished, and says when a newer one waits', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    const first = await t.page(controlOf(step));
    const second = await t.save(first, pageWith([headline('title', 'Second')]));
    const live = await publish(t, second);
    expect(live).toMatchObject({ publishedVersion: 2, hasUnpublishedChanges: false });
    expect(live.publishedAt).not.toBeNull();
    const third = await t.save(live, pageWith([headline('title', 'Third')]));
    // Saving never changes the live page.
    expect(third).toMatchObject({
      currentVersion: 3,
      publishedVersion: 2,
      hasUnpublishedChanges: true,
    });
    expect((await readStep(t, step.id)).pages[0]).toMatchObject({
      publishedVersion: 2,
      hasUnpublishedChanges: true,
    });
    const newest = await publish(t, third);
    expect(newest.publishedVersion).toBe(3);
    const back = await publish(t, newest, 2);
    expect(back.publishedVersion).toBe(2);
    // Version 1 is the empty page the step began as: an empty page is never made live.
    expect(await issuesOf(publish(t, back, 1))).toEqual([{ path: '/version', code: 'empty_page' }]);
    await expect(publish(t, third)).rejects.toBeInstanceOf(ConflictError);
    expect(await issuesOf(publish(t, back, 9))).toEqual([
      { path: '/version', code: 'invalid_version' },
    ]);

    const off = sitePage.parse(
      await t.call('unpublishSitePage', {
        params: { id: back.id },
        body: { revision: back.revision },
      }),
    );
    expect(off).toMatchObject({ publishedVersion: null, publishedAt: null, currentVersion: 3 });
    await expect(
      t.call('unpublishSitePage', { params: { id: off.id }, body: { revision: off.revision } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      t.call('unpublishSitePage', { params: { id: off.id }, body: { revision: 1 } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('takes sites.publish to publish and sites.manage to save: one without the other is refused', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    const page = await t.page(controlOf(step));
    await expect(
      t.call(
        'publishSitePage',
        { params: { id: page.id }, body: { revision: 1 } },
        t.as(['sites.manage']),
      ),
    ).rejects.toMatchObject({ permission: 'sites.publish' });
    await expect(
      t.call(
        'saveSitePageDraft',
        { params: { id: page.id }, body: { baseVersion: 1, document: EMPTY_PAGE_DOCUMENT } },
        t.as(['sites.publish']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const looking = sitePage.parse(
      await t.call('getSitePage', { params: { id: page.id } }, t.as([])),
    );
    expect(looking).toMatchObject({ canManage: false, canPublish: false });
  });

  it('keeps its newest thirty versions and never drops the live one', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    let page = await publish(
      t,
      await t.save(await t.page(controlOf(step)), pageWith([headline('t', 'Live')])),
    );
    for (let n = 0; n < SITE_LIMITS.versions + 3; n++)
      page = await t.save(page, pageWith([headline('t', `Draft ${String(n)}`)]));
    expect(page.currentVersion).toBe(SITE_LIMITS.versions + 5);
    const list = sitePageVersionList.parse(
      await t.call('listSitePageVersions', { params: { id: page.id } }),
    );
    const numbers = list.items.map((item) => item.number);
    // The newest thirty, and version 2: the one that is live.
    expect(numbers).toHaveLength(SITE_LIMITS.versions + 1);
    expect(numbers[0]).toBe(page.currentVersion);
    expect(numbers.at(-1)).toBe(2);
    expect(numbers.at(-2)).toBe(page.currentVersion - SITE_LIMITS.versions + 1);
    expect(list.items[0]).toMatchObject({
      current: true,
      published: false,
      restoredFrom: null,
      createdBy: { kind: 'user', name: 'Dana Brooks' },
    });
    expect(list.items.at(-1)).toMatchObject({ current: false, published: true });
    const live = sitePageVersionDetail.parse(
      await t.call('getSitePageVersion', { params: { id: page.id, version: '2' } }),
    );
    expect(JSON.stringify(live.document)).toContain('Live');
    await expect(
      t.call('getSitePageVersion', { params: { id: page.id, version: '1' } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Without a reader of names a version still says what kind of actor saved it.
    const unnamed = sitePageVersionList.parse(
      await t.callWith({}, 'listSitePageVersions', { params: { id: page.id } }),
    );
    expect(unnamed.items[0]?.createdBy).toEqual({ kind: 'user', name: null });
  });

  it('restores an older version as a new one, and leaves the live page alone', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    const second = await publish(
      t,
      await t.save(await t.page(controlOf(step)), pageWith([headline('t', 'Second')])),
    );
    const third = await t.save(second, pageWith([headline('t', 'Third')]));
    const restore = (revision: number, version: number) =>
      t.call('restoreSitePageVersion', { params: { id: third.id }, body: { revision, version } });
    const restored = sitePage.parse(await restore(third.revision, 1));
    expect(restored).toMatchObject({ currentVersion: 4, publishedVersion: 2 });
    expect(restored.document).toEqual(EMPTY_PAGE_DOCUMENT);
    const list = sitePageVersionList.parse(
      await t.call('listSitePageVersions', { params: { id: third.id } }),
    );
    expect(list.items[0]).toMatchObject({ number: 4, restoredFrom: 1 });
    await expect(restore(third.revision, 1)).rejects.toBeInstanceOf(ConflictError);
    expect(await issuesOf(restore(restored.revision, 99))).toEqual([
      { path: '/version', code: 'invalid_version' },
    ]);
  });

  it('refuses a stored document this release cannot read, instead of showing something else', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    const page = await t.page(controlOf(step));
    // As a newer release would have left it. The table lets crm_app add a version, not edit one.
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `with newer as (
           insert into sites.page_versions (business_id, page_id, number, format, document, created_by_kind)
           values (app.business_id(), $1, 2, 9, '{"format": 9, "mode": "holographic"}', 'system')
         )
         update sites.pages set current_version = 2 where id = $1`,
        [parsePublicId('site_page', page.id)],
      ),
    );
    await expect(t.page(page.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(
      t.call('publishSitePage', { params: { id: page.id }, body: { revision: page.revision } }),
    ).rejects.toBeInstanceOf(ConflictError);
    // The older version is still there to restore.
    const restored = sitePage.parse(
      await t.call('restoreSitePageVersion', {
        params: { id: page.id },
        body: { revision: page.revision, version: 1 },
      }),
    );
    expect(restored.currentVersion).toBe(3);
  });
});

describe('a split test', () => {
  const variation = async (t: Tenant, step: SiteStep, copyControl?: boolean): Promise<SiteStep> =>
    siteStep.parse(
      await t.call('createSiteVariation', {
        params: { id: step.id },
        body: { revision: step.revision, ...(copyControl === undefined ? {} : { copyControl }) },
      }),
    );
  const split = async (t: Tenant, step: SiteStep, active: boolean, controlWeight: number) =>
    siteStep.parse(
      await t.call('setSiteSplitTest', {
        params: { id: step.id },
        body: { revision: step.revision, active, controlWeight },
      }),
    );

  it('gives a funnel step a variation, a copy of the control or empty, and splits its visitors', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    await t.save(await t.page(controlOf(step)), pageWith([headline('title', 'Control')]));
    await expect(split(t, step, true, 50)).rejects.toBeInstanceOf(ConflictError);
    const tested = await variation(t, step);
    expect(tested.pages.map((page) => [page.role, page.weight])).toEqual([
      ['control', 50],
      ['variation', 50],
    ]);
    expect(tested).toMatchObject({ splitTest: false, revision: 2 });
    const copied = await t.page(tested.pages[1]?.id ?? '');
    expect(JSON.stringify(copied.document)).toContain('Control');
    await expect(variation(t, tested)).rejects.toBeInstanceOf(ConflictError);
    await expect(variation(t, step)).rejects.toBeInstanceOf(ConflictError);

    const running = await split(t, tested, true, 70);
    expect(running.splitTest).toBe(true);
    expect(running.pages.map((page) => page.weight)).toEqual([70, 30]);
    const stopped = await split(t, running, false, 70);
    expect(stopped.splitTest).toBe(false);

    const blank = await variation(t, await t.step(tested.siteId), false);
    expect((await t.page(blank.pages[1]?.id ?? '')).document).toEqual(EMPTY_PAGE_DOCUMENT);
  });

  it('is not for a website: its pages have a control only', async () => {
    const t = await harness.tenant();
    const page = await t.step((await t.site({ kind: 'website' })).id);
    await expect(variation(t, page)).rejects.toBeInstanceOf(ConflictError);
    expect((await readStep(t, page.id)).pages).toHaveLength(1);
  });

  it('ends by keeping one page as the control and deleting the other', async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    const declare = (step: SiteStep, pageId: string, revision = step.revision) =>
      t.call('declareSiteWinner', { params: { id: step.id }, body: { revision, pageId } });

    const first = await split(t, await variation(t, await t.step(funnel.id)), true, 40);
    const [control, challenger] = first.pages;
    await expect(declare(first, challenger?.id ?? '', 1)).rejects.toBeInstanceOf(ConflictError);
    expect(await issuesOf(declare(first, toPublicId('site_page', t.businessId)))).toEqual([
      { path: '/pageId', code: 'invalid_page' },
    ]);
    const won = siteStep.parse(await declare(first, challenger?.id ?? ''));
    expect(won.splitTest).toBe(false);
    expect(won.pages).toHaveLength(1);
    expect(won.pages[0]).toMatchObject({ id: challenger?.id, role: 'control', weight: 100 });
    await expect(t.page(control?.id ?? '')).rejects.toBeInstanceOf(NotFoundError);
    await expect(declare(won, challenger?.id ?? '')).rejects.toBeInstanceOf(ConflictError);

    const second = await variation(t, await t.step(funnel.id));
    const kept = siteStep.parse(await declare(second, second.pages[0]?.id ?? ''));
    expect(kept.pages).toHaveLength(1);
    expect(kept.pages[0]).toMatchObject({ id: second.pages[0]?.id, role: 'control', weight: 100 });
  });
});

describe('statistics', () => {
  it('add up per page and per step over a range of days, and reset to nothing', async () => {
    const t = await harness.tenant();
    const funnel = await t.site();
    const landing = await t.step(funnel.id, { name: 'Landing' });
    const thanks = await t.step(funnel.id, { name: 'Thanks' });
    const tested = siteStep.parse(
      await t.call('createSiteVariation', { params: { id: landing.id }, body: { revision: 1 } }),
    );
    const uuid = (id: string, kind: 'site' | 'site_step' | 'site_page') => parsePublicId(kind, id);
    const count = (pageId: string, stepId: string, day: string, numbers: number[]) =>
      harness.database.withTenant(t.as().context, (sql) =>
        sql.query(
          `insert into sites.step_stats_daily
             (business_id, page_id, day, step_id, site_id, views, unique_views, opt_ins, orders,
              order_quantity, order_amount)
           values (app.business_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            uuid(pageId, 'site_page'),
            day,
            uuid(stepId, 'site_step'),
            uuid(funnel.id, 'site'),
            ...numbers,
          ],
        ),
      );
    const [control, challenger] = tested.pages;
    await count(control?.id ?? '', landing.id, '2026-10-01', [10, 8, 2, 1, 2, 19.99]);
    await count(control?.id ?? '', landing.id, '2026-10-02', [5, 2, 1, 0, 0, 0.01]);
    await count(challenger?.id ?? '', landing.id, '2026-10-02', [4, 4, 2, 0, 0, 0]);
    await count(control?.id ?? '', landing.id, '2026-09-01', [100, 100, 100, 0, 0, 0]);

    const read = async (query: Record<string, unknown>, now?: string) =>
      siteStats.parse(
        now === undefined
          ? await t.call('getSiteStats', { params: { id: funnel.id }, query })
          : await t.read((trx) => readSiteStats(trx, t.as(), funnel.id, query, new Date(now))),
      );
    const stats = await read({ from: '2026-10-01', to: '2026-10-02' });
    expect(stats.steps.map((step) => step.name)).toEqual(['Landing', 'Thanks']);
    expect(stats.steps[0]).toMatchObject({
      stepId: landing.id,
      views: 19,
      uniqueViews: 14,
      optIns: 5,
      orders: 1,
      orderQuantity: 2,
      orderAmount: '20.00',
    });
    expect(stats.steps[0]?.optInRate).toBeCloseTo(5 / 14);
    expect(stats.steps[0]?.pages).toMatchObject([
      { pageId: control?.id, role: 'control', views: 15, uniqueViews: 10, optIns: 3 },
      {
        pageId: challenger?.id,
        role: 'variation',
        views: 4,
        uniqueViews: 4,
        optIns: 2,
        optInRate: 0.5,
      },
    ]);
    // A step nobody saw is there with zeros, and a rate of zero rather than a division.
    expect(stats.steps[1]).toMatchObject({
      stepId: thanks.id,
      views: 0,
      optInRate: 0,
      orderAmount: '0.00',
    });

    // Fourteen days by default, ending today.
    const recent = await read({}, '2026-10-14T08:00:00Z');
    expect(recent).toMatchObject({ from: '2026-10-01', to: '2026-10-14' });
    expect(recent.steps[0]?.views).toBe(19);
    expect((await read({ to: '2026-09-01' })).steps[0]?.views).toBe(100);
    expect(await issuesOf(read({ from: '2026-10-02', to: '2026-10-01' }))).toEqual([
      { path: '/from', code: 'invalid_range' },
    ]);

    await t.call('resetSiteStats', { params: { id: funnel.id } });
    expect((await read({ from: '2026-01-01', to: '2026-12-31' })).steps[0]?.views).toBe(0);
  });
});
