// Keeping how a visitor arrived, as the pages of a site are served. Which sites name the
// arrival's script on their pages and which stay as they were, the site's own switch, and
// that a page a process has kept is rendered again when the answer changes. Real Postgres,
// the module's own routes and its public handlers.
import { randomUUID } from 'node:crypto';

import {
  site as siteContract,
  sitePage,
  sitePagePreview,
  siteStep,
  type Site,
  type SitePage,
} from '@repo/contracts';
import { parsePublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  headline,
  openHarness,
  pageWith,
  PREVIEW_SECRET,
  PUBLIC_URL,
  SCRIPTS,
  type Harness,
  type Tenant,
} from '../test/harness.js';
import { createPublicSiteHandlers } from './index.js';

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
const readSite = async (t: Tenant, id: string): Promise<Site> =>
  siteContract.parse(await t.call('getSite', { params: { id } }));
const setKeep = async (t: Tenant, siteId: string, keepArrival: Site['keepArrival']) =>
  siteContract.parse(
    await t.call('updateSite', {
      params: { id: siteId },
      body: { revision: (await readSite(t, siteId)).revision, keepArrival },
    }),
  );

const FORM = 'form_01h455vb4pex5vsknk084sn02q';
const formOn = (formId: string | null = FORM): unknown => ({
  id: 'signup',
  type: 'form',
  props: { formId },
});
/** A published form of the business, so a page that shows it can be published. */
async function aForm(t: Tenant): Promise<string> {
  const formKey = randomUUID().replaceAll('-', '');
  await harness.setForm(t.businessId, uuid('form', FORM), { publicKey: formKey, published: true });
  return formKey;
}

/**
 * A funnel of two published steps: `offer`, which says something, and `details`, which
 * shows what is given. Returns the site, its key and the two pages.
 */
async function twoSteps(t: Tenant, second: unknown[]) {
  const site = await t.site();
  const one = await t.step(site.id, { name: 'Offer', path: 'offer' });
  const two = await t.step(site.id, { name: 'Details', path: 'details' });
  const offer = await publish(
    t,
    await t.save(await controlOf(t, one.id), pageWith([headline('h', 'The offer')])),
  );
  const details = await publish(t, await t.save(await controlOf(t, two.id), pageWith(second)));
  return { site, key: (await readSite(t, site.id)).publicKey ?? '', offer, details };
}

const scriptsOf = (html: string | undefined): string[] =>
  [...(html ?? '').matchAll(/<script[^>]*>/g)].map(([tag]) => tag);
const tagFor = (key: string, more = ''): string =>
  `<script defer src="${SCRIPTS.arrival}" data-site="${key}"${more}>`;
const open = (key: string, path: string) => harness.visit.page(key, path, request());

describe('a site that takes a lead somewhere', () => {
  it('names the arrival’s script on every page of it, also on a page with nothing else to run', async () => {
    const t = await harness.tenant();
    const formKey = await aForm(t);
    const { site, key } = await twoSteps(t, [formOn()]);
    expect((await readSite(t, site.id)).keepArrival).toBe('unless_opted_out');

    // The landing page holds a headline and nothing else: its site has a form on step 2.
    const offer = await open(key, 'offer');
    expect(scriptsOf(offer?.html)).toEqual([tagFor(key)]);
    // A script of this address may run; the page itself calls nothing.
    expect(offer?.policy).toContain("default-src 'none'; script-src 'self'; style-src 'sha256-");
    expect(offer?.policy).not.toContain('connect-src');
    expect(offer?.policy).not.toContain('unsafe');

    const details = await open(key, 'details');
    expect(scriptsOf(details?.html)).toEqual([
      tagFor(key),
      `<script async src="/forms/embed.js" data-form-key="${formKey}">`,
    ]);
    expect(details?.policy).toContain("script-src 'self'; connect-src 'self'");
  });

  it('does so for a calendar as for a form', async () => {
    const t = await harness.tenant();
    const calendar = await harness.calendar(t);
    const { key } = await twoSteps(t, [
      { id: 'book', type: 'calendar', props: { calendarId: calendar.id } },
    ]);
    expect(scriptsOf((await open(key, 'offer'))?.html)).toEqual([tagFor(key)]);
    const details = await open(key, 'details');
    expect(scriptsOf(details?.html)).toEqual([tagFor(key)]);
    expect(details?.html).toContain(`href="${PUBLIC_URL}${calendar.path}"`);
  });

  it('does so for a form a saved section holds, on whichever page shows that section', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const section = (await t.call('createSiteSection', {
      body: {
        name: 'Sign up',
        siteId: null,
        document: {
          id: 'signup-section',
          type: 'section',
          props: { width: 'full' },
          rows: [
            {
              id: 'signup-row',
              type: 'row',
              columns: [
                { id: 'signup-col', type: 'column', props: { span: 12 }, children: [formOn()] },
              ],
            },
          ],
        },
      },
    })) as { id: string };
    const site = await t.site();
    const one = await t.step(site.id, { name: 'Offer', path: 'offer' });
    const two = await t.step(site.id, { name: 'Details', path: 'details' });
    await publish(
      t,
      await t.save(await controlOf(t, one.id), pageWith([headline('h', 'The offer')])),
    );
    await publish(
      t,
      await t.save(
        await controlOf(t, two.id),
        pageWith(
          [headline('d', 'Details')],
          [{ id: 'shared', type: 'saved_section', sectionId: section.id }],
        ),
      ),
    );
    const key = (await readSite(t, site.id)).publicKey ?? '';
    expect(scriptsOf((await open(key, 'offer'))?.html)).toEqual([tagFor(key)]);
  });

  it('keeps it for every visitor only when the site says so, and not at all when it says never', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const { site, key } = await twoSteps(t, [formOn()]);
    expect((await setKeep(t, site.id, 'always')).keepArrival).toBe('always');
    expect(scriptsOf((await open(key, 'offer'))?.html)).toEqual([tagFor(key, ' data-gpc="keep"')]);

    expect((await setKeep(t, site.id, 'never')).keepArrival).toBe('never');
    const off = await open(key, 'offer');
    expect(off?.html).not.toContain('<script');
    expect(off?.policy).not.toContain('script-src');
    // The form's own page still shows its form, and loads nothing for the arrival.
    expect(scriptsOf((await open(key, 'details'))?.html)).toHaveLength(1);

    expect((await setKeep(t, site.id, 'unless_opted_out')).keepArrival).toBe('unless_opted_out');
    expect(scriptsOf((await open(key, 'offer'))?.html)).toEqual([tagFor(key)]);
    // Anything else is refused by the contract's own list.
    await expect(
      t.call('updateSite', {
        params: { id: site.id },
        body: { revision: (await readSite(t, site.id)).revision, keepArrival: 'sometimes' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('gives a copy of the site the same setting, under the copy’s own key', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const { site } = await twoSteps(t, [formOn()]);
    await setKeep(t, site.id, 'always');
    const copy = siteContract.parse(
      await t.call('cloneSite', { params: { id: site.id }, body: {} }),
    );
    expect(copy.keepArrival).toBe('always');
    expect(copy.publicKey).not.toBe((await readSite(t, site.id)).publicKey);
  });

  it('names no such script on a draft shown to its editor', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const { key, offer } = await twoSteps(t, [formOn()]);
    expect(scriptsOf((await open(key, 'offer'))?.html)).toEqual([tagFor(key)]);
    const preview = sitePagePreview.parse(
      await t.call('getSitePagePreview', { params: { id: offer.id } }),
    );
    const shown = await harness.visit.preview(
      preview.url.slice(preview.url.lastIndexOf('/') + 1),
      request(),
    );
    expect(shown?.html).toContain('The offer');
    expect(shown?.html).not.toContain('<script');
    expect(shown?.policy).not.toContain('script-src');
  });

  it('names none on a server that has no such script to send', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const { key } = await twoSteps(t, [formOn()]);
    const { arrival: _left, ...others } = SCRIPTS;
    const without = createPublicSiteHandlers({
      db: harness.db,
      secret: PREVIEW_SECRET,
      publicUrl: PUBLIC_URL,
      forms: harness.options.forms,
      booking: true,
      scripts: others,
    });
    expect((await without.page(key, 'offer', request()))?.html).not.toContain('<script');
  });
});

describe('a site that takes no lead', () => {
  it('stays free of any script, whatever its setting', async () => {
    const t = await harness.tenant();
    const { site, key } = await twoSteps(t, [headline('d', 'Only words')]);
    for (const keep of ['unless_opted_out', 'always'] as const) {
      await setKeep(t, site.id, keep);
      for (const path of ['offer', 'details']) {
        const page = await open(key, path);
        expect(page?.html, `${keep} ${path}`).not.toContain('<script');
        expect(page?.policy, `${keep} ${path}`).not.toContain('script-src');
      }
    }
  });

  it('is not taken for one by a form on a step that was never published', async () => {
    const t = await harness.tenant();
    const site = await t.site();
    const one = await t.step(site.id, { name: 'Offer', path: 'offer' });
    const two = await t.step(site.id, { name: 'Details', path: 'details' });
    await publish(
      t,
      await t.save(await controlOf(t, one.id), pageWith([headline('h', 'The offer')])),
    );
    // A step that is only saved, never published, is no page a visitor can reach.
    await t.save(await controlOf(t, two.id), pageWith([formOn()]));
    const key = (await readSite(t, site.id)).publicKey ?? '';
    expect((await open(key, 'offer'))?.html).not.toContain('<script');
  });

  it('is not one because another site of the same business takes leads', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const taking = await twoSteps(t, [formOn()]);
    const plain = await twoSteps(t, [headline('d', 'Only words')]);
    expect(scriptsOf((await open(taking.key, 'offer'))?.html)).toEqual([tagFor(taking.key)]);
    expect((await open(plain.key, 'offer'))?.html).not.toContain('<script');
  });
});

describe('a page a process has kept is rendered again when', () => {
  /** Two visits, one render; then the change; then the next visit. */
  async function afterChange(key: string, change: () => Promise<unknown>) {
    const first = await open(key, 'offer');
    const renders = harness.renders.length;
    expect(await open(key, 'offer')).toBe(first);
    expect(harness.renders).toHaveLength(renders);
    await change();
    const next = await open(key, 'offer');
    return { before: first, page: next, rendered: harness.renders.length > renders };
  }

  it('another step of its site begins to take leads, and when it stops', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const { key, details } = await twoSteps(t, [headline('d', 'Only words')]);
    const gained = await afterChange(key, async () =>
      publish(t, await t.save(await t.page(details.id), pageWith([formOn()]))),
    );
    expect(gained.before?.html).not.toContain('<script');
    expect(gained.rendered).toBe(true);
    expect(scriptsOf(gained.page?.html)).toEqual([tagFor(key)]);
    expect(gained.page?.etag).not.toBe(gained.before?.etag);

    const lost = await afterChange(key, async () =>
      publish(t, await t.save(await t.page(details.id), pageWith([headline('d', 'Words')]))),
    );
    expect(lost.rendered).toBe(true);
    expect(lost.page?.html).not.toContain('<script');
  });

  it('the site’s setting changes', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const { site, key } = await twoSteps(t, [formOn()]);
    const never = await afterChange(key, () => setKeep(t, site.id, 'never'));
    expect(scriptsOf(never.before?.html)).toEqual([tagFor(key)]);
    expect(never.rendered).toBe(true);
    expect(never.page?.html).not.toContain('<script');
    const always = await afterChange(key, () => setKeep(t, site.id, 'always'));
    expect(scriptsOf(always.page?.html)).toEqual([tagFor(key, ' data-gpc="keep"')]);
  });

  it('a saved section another step shows gains a form', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const sectionOf = (children: unknown[]) => ({
      id: 'shared-section',
      type: 'section',
      props: { width: 'full' },
      rows: [
        {
          id: 'shared-row',
          type: 'row',
          columns: [{ id: 'shared-col', type: 'column', props: { span: 12 }, children }],
        },
      ],
    });
    const section = (await t.call('createSiteSection', {
      body: { name: 'Shared', siteId: null, document: sectionOf([headline('s', 'Words')]) },
    })) as { id: string; revision: number };
    const site = await t.site();
    const one = await t.step(site.id, { name: 'Offer', path: 'offer' });
    const two = await t.step(site.id, { name: 'Details', path: 'details' });
    await publish(
      t,
      await t.save(await controlOf(t, one.id), pageWith([headline('h', 'The offer')])),
    );
    await publish(
      t,
      await t.save(
        await controlOf(t, two.id),
        pageWith(
          [headline('d', 'Details')],
          [{ id: 'shared', type: 'saved_section', sectionId: section.id }],
        ),
      ),
    );
    const key = (await readSite(t, site.id)).publicKey ?? '';
    const changed = await afterChange(key, () =>
      t.call('updateSiteSection', {
        params: { id: section.id },
        body: { revision: section.revision, name: 'Shared', document: sectionOf([formOn()]) },
      }),
    );
    expect(changed.before?.html).not.toContain('<script');
    expect(changed.rendered).toBe(true);
    expect(scriptsOf(changed.page?.html)).toEqual([tagFor(key)]);
  });

  it('the site’s only form is unpublished, and when it is published again', async () => {
    const t = await harness.tenant();
    const formKey = await aForm(t);
    const { key } = await twoSteps(t, [formOn()]);
    const setForm = (published: boolean) =>
      harness.setForm(t.businessId, uuid('form', FORM), { publicKey: formKey, published });
    // The landing page shows no form itself: it is kept by the form another step shows.
    const gone = await afterChange(key, () => setForm(false));
    expect(scriptsOf(gone.before?.html)).toEqual([tagFor(key)]);
    expect(gone.rendered).toBe(true);
    expect(gone.page?.html).not.toContain('<script');
    expect(gone.page?.policy).not.toContain('script-src');
    const back = await afterChange(key, () => setForm(true));
    expect(scriptsOf(back.page?.html)).toEqual([tagFor(key)]);
  });

  it('the site’s only calendar can no longer be booked', async () => {
    const t = await harness.tenant();
    const calendar = await harness.calendar(t);
    const { key } = await twoSteps(t, [
      { id: 'book', type: 'calendar', props: { calendarId: calendar.id } },
    ]);
    const off = await afterChange(key, () => harness.setCalendar(calendar.uuid, { active: false }));
    expect(scriptsOf(off.before?.html)).toEqual([tagFor(key)]);
    expect(off.rendered).toBe(true);
    expect(off.page?.html).not.toContain('<script');
  });

  it('and is not when nothing of it changed', async () => {
    const t = await harness.tenant();
    await aForm(t);
    const { key } = await twoSteps(t, [formOn()]);
    const same = await afterChange(key, () => Promise.resolve());
    expect(same.rendered).toBe(false);
    expect(same.page).toBe(same.before);
  });
});
