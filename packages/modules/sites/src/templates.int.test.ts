// The template library, saved sections and the share bundle against real Postgres: a
// template is a copy, the library's filters, favourites, and a site carried from one
// business to another.
import {
  siteBundle,
  site as siteContract,
  siteSection,
  siteSectionList,
  siteStep,
  siteTemplate,
  siteTemplateList,
  siteTemplateSummary,
  SITE_TEMPLATE_LIMITS,
  type Site,
  type SiteTemplate,
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
  BUNDLE_SECRET,
  button,
  headline,
  openHarness,
  pageWith,
  type Harness,
  type Tenant,
} from '../test/harness.js';
import { BUILT_IN_TEMPLATES } from './builtin-templates.js';
import { signBundle } from './bundle-signature.js';

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
const builtIn = (name: string): string =>
  toPublicId('site_template', BUILT_IN_TEMPLATES.find((each) => each.name === name)?.id ?? '');
const library = async (t: Tenant, query: Record<string, unknown>, invocation = t.as()) =>
  siteTemplateList.parse(
    await t.call('listSiteTemplates', { query: { kind: 'funnel', ...query } }, invocation),
  );
const save = async (t: Tenant, body: Record<string, unknown>): Promise<SiteTemplate> =>
  siteTemplate.parse(await t.call('createSiteTemplate', { body }));
const section = (id: string, children: unknown[] = []) => ({
  id,
  type: 'section',
  props: { width: 'full' },
  rows: [
    {
      id: `${id}-row`,
      type: 'row',
      columns: [{ id: `${id}-col`, type: 'column', props: { span: 12 }, children }],
    },
  ],
});

/** A funnel of two steps: the first has a button to the second and uses two saved sections. */
async function funnel(t: Tenant): Promise<{ site: Site; header: string; footer: string }> {
  const made = await t.site({ name: 'Spring offer' });
  const landing = await t.step(made.id, { name: 'Landing', path: 'landing' });
  const thanks = await t.step(made.id, { name: 'Thanks', path: 'thanks' });
  const sectionOf = async (siteId: string | null, name: string, document: unknown) =>
    siteSection.parse(await t.call('createSiteSection', { body: { siteId, name, document } })).id;
  const header = await sectionOf(null, 'Header', section('header', [headline('brand', 'Harbor')]));
  const footer = await sectionOf(
    made.id,
    'Footer',
    section('footer', [button('again', { type: 'step', stepId: landing.id })]),
  );
  await t.save(
    await t.page(landing.pages[0]?.id ?? ''),
    pageWith(
      [
        headline('title', 'Call {{custom_values.business_phone}}'),
        button('next', { type: 'step', stepId: thanks.id }),
      ],
      [
        { id: 'top', type: 'saved_section', sectionId: header },
        { id: 'bottom', type: 'saved_section', sectionId: footer },
      ],
    ),
  );
  return {
    site: siteContract.parse(await t.call('getSite', { params: { id: made.id } })),
    header,
    footer,
  };
}

describe('the templates that ship with the product', () => {
  it('are in every library, read with their content, and cannot be changed', async () => {
    const t = await harness.tenant();
    const funnels = await library(t, {});
    expect(
      funnels.items.map((each) => [each.name, each.scope, each.canManage, each.stepCount]),
    ).toEqual([['Two-step lead funnel', 'builtin', false, 2]]);
    expect(funnels).toMatchObject({ total: 1, next: null, canManage: true, canShare: true });
    expect((await library(t, { kind: 'step' })).items.map((each) => each.name).sort()).toEqual([
      'Coming soon',
      'Lead capture landing page',
      'Thank you page',
    ]);
    expect((await library(t, { kind: 'section' })).items.map((each) => each.stepCount)).toEqual([
      0,
    ]);
    const id = builtIn('Two-step lead funnel');
    const read = siteTemplate.parse(await t.call('getSiteTemplate', { params: { id } }));
    expect(read.content.kind).toBe('funnel');
    for (const work of [
      () => t.call('updateSiteTemplate', { params: { id }, body: { revision: 1, name: 'Mine' } }),
      () => t.call('deleteSiteTemplate', { params: { id } }),
    ])
      await expect(work()).rejects.toBeInstanceOf(ConflictError);
  });

  it('start a funnel and a step as copies, counted as uses in this business alone', async () => {
    const t = await harness.tenant();
    const other = await harness.tenant(t.agencyId);
    const id = builtIn('Two-step lead funnel');
    const made = await t.site({ templateId: id });
    expect(made).toMatchObject({ originTemplateId: id, stepCount: 2 });
    expect(made.steps.map((step) => [step.name, step.path])).toEqual([
      ['Landing Page', 'start'],
      ['Thank You', 'thank-you'],
    ]);
    // The first page's button goes to the copy's own second step, and merge fields stay.
    const first = await t.page(made.steps[0]?.pages[0]?.id ?? '');
    const text = JSON.stringify(first.document);
    expect(text).toContain(made.steps[1]?.id);
    expect(text).toContain('{{custom_values.business_name}}');

    const stepTemplate = builtIn('Coming soon');
    const added = siteStep.parse(
      await t.call('createSiteStep', {
        params: { id: made.id },
        body: { name: 'Soon', path: 'soon', templateId: stepTemplate },
      }),
    );
    expect(JSON.stringify((await t.page(added.pages[0]?.id ?? '')).document)).toContain(
      'countdown',
    );

    expect((await library(t, {})).items[0]?.uses).toBe(1);
    const steps = await library(t, { kind: 'step', sort: 'popular' });
    expect(steps.items[0]).toMatchObject({ name: 'Coming soon', uses: 1 });
    expect((await library(other, {})).items[0]?.uses).toBe(0);
    // A copy of the site is not another use of the template.
    await t.call('cloneSite', { params: { id: made.id }, body: {} });
    expect((await library(t, {})).items[0]?.uses).toBe(1);

    // A template of the wrong kind for the place it is used is as good as none.
    await expect(t.site({ templateId: stepTemplate })).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.site({ kind: 'website', templateId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      t.call('createSiteStep', {
        params: { id: made.id },
        body: { name: 'x', path: 'x', templateId: id },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      t.site({ templateId: toPublicId('site_template', t.businessId) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a template of a business', () => {
  it('is a copy of a site: later edits to the site do not change it, and using it makes new rows', async () => {
    const t = await harness.tenant();
    const source = await funnel(t);
    const saved = await save(t, {
      source: { type: 'site', siteId: source.site.id },
      name: ' Our spring funnel ',
      description: 'Two steps',
      category: 'Events',
      pageType: 'Lead capture',
      tags: ['spring', 'lead'],
      colors: ['#2563eb'],
    });
    expect(saved).toMatchObject({
      kind: 'funnel',
      scope: 'business',
      name: 'Our spring funnel',
      category: 'Events',
      pageType: 'Lead capture',
      tags: ['spring', 'lead'],
      colors: ['#2563eb'],
      stepCount: 2,
      uses: 0,
      favorite: false,
      canManage: true,
      revision: 1,
    });
    if (saved.content.kind !== 'funnel') throw new Error('Expected a funnel template.');
    // Both saved sections came along, each under what it was: the business's and the site's.
    expect(saved.content.sections.map((each) => [each.name, each.scope]).sort()).toEqual([
      ['Footer', 'global'],
      ['Header', 'universal'],
    ]);

    // The source changes; the template does not.
    await t.call('deleteSiteStep', { params: { id: source.site.steps[1]?.id ?? '' } });
    const reread = siteTemplate.parse(
      await t.call('getSiteTemplate', { params: { id: saved.id } }),
    );
    expect(reread.content).toEqual(saved.content);

    const made = await t.site({ name: 'From ours', templateId: saved.id });
    expect(made.steps.map((step) => step.path)).toEqual(['landing', 'thanks']);
    expect(made.steps[0]?.id).not.toBe(source.site.steps[0]?.id);
    const first = await t.page(made.steps[0]?.pages[0]?.id ?? '');
    const text = JSON.stringify(first.document);
    expect(text).toContain('{{custom_values.business_phone}}');
    expect(text).toContain(made.steps[1]?.id);
    // Its saved sections are new ones of the new site, and their own buttons go to its steps.
    expect(text).not.toContain(source.header);
    expect(text).not.toContain(source.footer);
    const sections = siteSectionList.parse(
      await t.call('listSiteSections', { query: { site: made.id } }),
    );
    const own = sections.items.filter((each) => each.siteId === made.id);
    expect(own.map((each) => each.name).sort()).toEqual(['Footer', 'Header']);
    expect(JSON.stringify(own)).toContain(made.steps[0]?.id);
    expect((await library(t, { list: 'mine' })).items[0]).toMatchObject({ id: saved.id, uses: 1 });
  });

  it('is saved from one step or one section too', async () => {
    const t = await harness.tenant();
    const source = await funnel(t);
    const [landing] = source.site.steps;
    const fromStep = await save(t, {
      source: { type: 'step', stepId: landing?.id },
      name: 'Landing',
    });
    expect(fromStep).toMatchObject({ kind: 'step', stepCount: 1 });
    // Outside its funnel the button to the next step has nowhere to go.
    expect(JSON.stringify(fromStep.content)).not.toContain(source.site.steps[1]?.id);
    expect(JSON.stringify(fromStep.content)).toContain('{{custom_values.business_phone}}');

    const pageId = landing?.pages[0]?.id;
    const fromSection = await save(t, {
      source: { type: 'section', pageId, sectionId: 'main' },
      name: 'Main block',
    });
    expect(fromSection).toMatchObject({ kind: 'section', stepCount: 0 });
    expect(fromSection.content).toMatchObject({ kind: 'section', section: { id: 'main' } });
    for (const sectionId of ['missing', 'top'])
      expect(
        await issuesOf(save(t, { source: { type: 'section', pageId, sectionId }, name: 'x' })),
      ).toEqual([{ path: '/source/sectionId', code: 'invalid_section' }]);

    const other = await t.site();
    const added = siteStep.parse(
      await t.call('createSiteStep', {
        params: { id: other.id },
        body: { name: 'From template', path: 'from-template', templateId: fromStep.id },
      }),
    );
    expect(added).toMatchObject({ name: 'From template', path: 'from-template' });
    // An empty site has nothing to make a template of.
    await expect(
      save(t, { source: { type: 'site', siteId: (await t.site()).id }, name: 'Empty' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('is filed, found by the filters the library shows, and paged', async () => {
    const t = await harness.tenant();
    const source = await funnel(t);
    const from = { source: { type: 'site', siteId: source.site.id } };
    const spring = await save(t, {
      ...from,
      name: 'Spring',
      category: 'Events',
      pageType: 'Lead capture',
      tags: ['Lead', 'spring'],
    });
    const autumn = await save(t, {
      ...from,
      name: 'Autumn sale',
      category: 'Retail',
      pageType: 'Checkout',
      tags: ['sale'],
    });
    await t.site({ templateId: autumn.id });

    const all = await library(t, {});
    expect(all.total).toBe(3);
    expect(all.facets).toEqual({
      categories: [
        { value: 'Business', count: 1 },
        { value: 'Events', count: 1 },
        { value: 'Retail', count: 1 },
      ],
      types: [
        { value: 'Checkout', count: 1 },
        { value: 'Lead capture', count: 2 },
      ],
      tags: expect.arrayContaining([
        { value: 'sale', count: 1 },
        { value: 'spring', count: 1 },
      ]) as unknown,
    });
    const names = async (query: Record<string, unknown>) =>
      (await library(t, query)).items.map((each) => each.name);
    expect(await names({ list: 'mine' })).toEqual(['Autumn sale', 'Spring']);
    expect(await names({ list: 'shared' })).toEqual([]);
    expect(await names({ category: 'events, retail' })).toEqual(['Autumn sale', 'Spring']);
    expect(await names({ type: 'Checkout' })).toEqual(['Autumn sale']);
    expect(await names({ tag: 'LEAD' })).toEqual(['Spring', 'Two-step lead funnel']);
    expect(await names({ q: 'SALE' })).toEqual(['Autumn sale']);
    expect(await names({ sort: 'popular' })).toEqual([
      'Autumn sale',
      'Spring',
      'Two-step lead funnel',
    ]);
    // The counts are of the whole list, whatever is ticked.
    expect((await library(t, { category: 'Retail' })).facets.categories).toHaveLength(3);

    const first = await library(t, { limit: '2' });
    expect(first.items.map((each) => each.name)).toEqual(['Autumn sale', 'Spring']);
    const second = await library(t, { limit: '2', after: first.next ?? '' });
    expect(second.items.map((each) => each.name)).toEqual(['Two-step lead funnel']);
    expect(second.next).toBeNull();
    expect(await issuesOf(library(t, { after: 'bm9wZQ' }))).toEqual([
      { path: '/after', code: 'invalid_cursor' },
    ]);
    expect(spring.id).not.toBe(autumn.id);
  });

  it('is changed and deleted by whoever may, from the revision read', async () => {
    const t = await harness.tenant();
    const source = await funnel(t);
    const saved = await save(t, { source: { type: 'site', siteId: source.site.id }, name: 'Ours' });
    const change = (body: Record<string, unknown>, invocation = t.as()) =>
      t.call('updateSiteTemplate', { params: { id: saved.id }, body }, invocation);
    const changed = siteTemplate.parse(
      await change({
        revision: 1,
        name: 'Renamed',
        description: 'New',
        category: null,
        pageType: 'About',
        tags: ['a'],
        colors: [],
        previewFileId: null,
      }),
    );
    expect(changed).toMatchObject({
      name: 'Renamed',
      description: 'New',
      pageType: 'About',
      tags: ['a'],
      revision: 2,
    });
    await expect(change({ revision: 1, name: 'Stale' })).rejects.toBeInstanceOf(ConflictError);
    // A file of nobody is not a preview.
    expect(
      await issuesOf(change({ revision: 2, previewFileId: toPublicId('file', t.businessId) })),
    ).toEqual([{ path: '/previewFileId', code: 'invalid_file' }]);
    expect(
      await issuesOf(
        save(t, {
          source: { type: 'site', siteId: source.site.id },
          name: 'With a preview',
          previewFileId: toPublicId('file', t.businessId),
        }),
      ),
    ).toEqual([{ path: '/previewFileId', code: 'invalid_file' }]);

    await t.call('setSiteTemplateFavorite', { params: { id: saved.id }, body: { favorite: true } });
    await t.call('deleteSiteTemplate', { params: { id: saved.id } });
    await expect(t.call('getSiteTemplate', { params: { id: saved.id } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await library(t, { list: 'favorites' })).total).toBe(0);
  });

  it('stops at five hundred of its own', async () => {
    const t = await harness.tenant();
    const source = await funnel(t);
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `insert into sites.templates (agency_id, business_id, kind, name, format, content, created_by_kind)
         select app.agency_id(), app.business_id(), 'section', 'T ' || n, 1, '{"kind": "section"}', 'user'
         from generate_series(1, $1) n`,
        [SITE_TEMPLATE_LIMITS.templates],
      ),
    );
    expect(
      await issuesOf(
        save(t, { source: { type: 'site', siteId: source.site.id }, name: 'One more' }),
      ),
    ).toEqual([{ path: '/name', code: 'limit_reached' }]);
    // One the schema no longer reads is refused when read or used, not shown as something else.
    const [broken] = (await library(t, { kind: 'section', list: 'mine', limit: '1' })).items;
    await expect(
      t.call('getSiteTemplate', { params: { id: broken?.id ?? '' } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('an agency template', () => {
  it('is saved by whoever may share, and read by every business of the agency as shared with it', async () => {
    const a = await harness.tenant();
    const b = await harness.tenant(a.agencyId);
    const stranger = await harness.tenant();
    const source = await funnel(a);
    const body = {
      source: { type: 'site', siteId: source.site.id },
      name: 'Agency funnel',
      scope: 'agency',
    };
    await expect(
      a.call('createSiteTemplate', { body }, a.as(['sites.manage'])),
    ).rejects.toMatchObject({ permission: 'sites.share' });
    const shared = await save(a, body);
    expect(shared).toMatchObject({ scope: 'agency', canManage: true });

    expect((await library(b, { list: 'shared' })).items.map((each) => each.id)).toEqual([
      shared.id,
    ]);
    expect((await library(b, { list: 'mine' })).total).toBe(0);
    expect((await library(stranger, { list: 'shared' })).total).toBe(0);
    // Someone who may manage their own templates may not change the agency's.
    const mine = b.as(['sites.manage']);
    expect((await library(b, { list: 'shared' }, mine)).items[0]?.canManage).toBe(false);
    expect((await library(b, {}, mine)).canShare).toBe(false);
    for (const work of [
      () =>
        b.call(
          'updateSiteTemplate',
          { params: { id: shared.id }, body: { revision: 1, name: 'x' } },
          mine,
        ),
      () => b.call('deleteSiteTemplate', { params: { id: shared.id } }, mine),
    ])
      await expect(work()).rejects.toMatchObject({ permission: 'sites.share' });
    await expect(
      stranger.call('getSiteTemplate', { params: { id: shared.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Business B starts a funnel from it: its own rows, and one more use for everyone.
    const made = await b.site({ templateId: shared.id });
    expect(made.stepCount).toBe(2);
    expect((await library(a, { list: 'shared' })).items[0]?.uses).toBe(1);
  });
});

describe('favourites', () => {
  it("are a person's own in a business, for any template they can use", async () => {
    const t = await harness.tenant();
    const id = builtIn('Two-step lead funnel');
    const favorite = async (flag: boolean, templateId = id, invocation = t.as()) =>
      siteTemplateSummary.parse(
        await t.call(
          'setSiteTemplateFavorite',
          { params: { id: templateId }, body: { favorite: flag } },
          invocation,
        ),
      );
    expect((await favorite(true)).favorite).toBe(true);
    // Twice is once.
    expect((await favorite(true)).favorite).toBe(true);
    expect((await library(t, { list: 'favorites' })).items.map((each) => each.id)).toEqual([id]);
    expect((await library(t, {})).items[0]?.favorite).toBe(true);
    expect(siteTemplate.parse(await t.call('getSiteTemplate', { params: { id } })).favorite).toBe(
      true,
    );
    // A colleague has their own.
    const colleague = await harness.database.fixtures.user();
    const theirs = {
      ...t.as(),
      context: { ...t.as().context, userId: colleague.id, actorId: colleague.id },
    };
    expect((await library(t, { list: 'favorites' }, theirs)).total).toBe(0);
    expect((await favorite(false)).favorite).toBe(false);
    expect((await library(t, { list: 'favorites' })).total).toBe(0);

    await expect(favorite(true, toPublicId('site_template', t.businessId))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // A machine has no favourites to keep.
    const machine = { ...t.as(), context: { ...t.as().context, actorKind: 'api_key' as const } };
    const { userId: _userId, ...withoutUser } = machine.context;
    await expect(favorite(true, id, { ...machine, context: withoutUser })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await library(t, {}, { ...machine, context: withoutUser })).items[0]?.favorite).toBe(
      false,
    );
  });
});

describe('saved sections', () => {
  it('belong to the business or to one site, and change everywhere from the revision read', async () => {
    const t = await harness.tenant();
    const site = await t.site();
    const step = await t.step(site.id);
    const create = (body: Record<string, unknown>) => t.call('createSiteSection', { body });
    const header = siteSection.parse(
      await create({ name: ' Header ', document: section('header') }),
    );
    expect(header).toMatchObject({ name: 'Header', siteId: null, revision: 1 });
    const footer = siteSection.parse(
      await create({
        siteId: site.id,
        name: 'Footer',
        document: section('footer', [button('go', { type: 'step', stepId: step.id })]),
      }),
    );
    expect(footer.siteId).toBe(site.id);
    expect(await issuesOf(create({ name: 'header', document: section('h') }))).toEqual([
      { path: '/name', code: 'taken' },
    ]);
    // The same name is free on a site, which has its own.
    await create({ siteId: site.id, name: 'Header', document: section('h') });

    const list = async (query: Record<string, unknown> = {}) =>
      siteSectionList
        .parse(await t.call('listSiteSections', { query }))
        .items.map((each) => each.name);
    expect(await list()).toEqual(['Header']);
    expect(await list({ site: site.id })).toEqual(['Footer', 'Header', 'Header']);

    // A section of the whole business can go to no step; a site's only to its own.
    const toStep = section('x', [button('go', { type: 'step', stepId: step.id })]);
    expect(await issuesOf(create({ name: 'Wide', document: toStep }))).toEqual([
      { path: '/document', code: 'invalid_step' },
    ]);
    const elsewhere = await t.site();
    expect(
      await issuesOf(create({ siteId: elsewhere.id, name: 'Away', document: toStep })),
    ).toEqual([{ path: '/document', code: 'invalid_step' }]);

    const change = (id: string, body: Record<string, unknown>) =>
      t.call('updateSiteSection', { params: { id }, body });
    const changed = siteSection.parse(
      await change(header.id, {
        revision: 1,
        name: 'Top',
        document: section('header', [headline('h1', 'New')]),
      }),
    );
    expect(changed).toMatchObject({ name: 'Top', revision: 2 });
    expect(JSON.stringify(changed.document)).toContain('New');
    await expect(
      change(header.id, { revision: 1, name: 'Stale', document: section('header') }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await issuesOf(change(header.id, { revision: 2, name: 'Top', document: toStep })),
    ).toEqual([{ path: '/document', code: 'invalid_step' }]);
  });

  it('cannot be deleted while a page uses them in its newest or live version', async () => {
    const t = await harness.tenant();
    const step = await t.step((await t.site()).id);
    const header = siteSection.parse(
      await t.call('createSiteSection', { body: { name: 'Header', document: section('header') } }),
    );
    const remove = () => t.call('deleteSiteSection', { params: { id: header.id } });
    const using = await t.save(
      await t.page(step.pages[0]?.id ?? ''),
      pageWith([], [{ id: 'top', type: 'saved_section', sectionId: header.id }]),
    );
    await expect(remove()).rejects.toBeInstanceOf(ConflictError);
    await t.save(using, pageWith([]));
    // No page's newest or live version names it any more.
    await remove();
    await expect(remove()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('stop at two hundred in a business', async () => {
    const t = await harness.tenant();
    await harness.database.withTenant(t.as().context, (sql) =>
      sql.query(
        `insert into sites.saved_sections (business_id, name, format, document, created_by_kind)
         select app.business_id(), 'S ' || n, 1, '{}', 'user' from generate_series(1, $1) n`,
        [SITE_TEMPLATE_LIMITS.sections],
      ),
    );
    expect(
      await issuesOf(
        t.call('createSiteSection', { body: { name: 'More', document: section('s') } }),
      ),
    ).toEqual([{ path: '', code: 'limit_reached' }]);
  });
});

describe('sharing a site', () => {
  it('carries it as a signed bundle into another business of the agency', async () => {
    const a = await harness.tenant();
    const b = await harness.tenant(a.agencyId);
    const source = await funnel(a);
    await a.call('updateSite', {
      params: { id: source.site.id },
      body: { revision: source.site.revision, headCode: '<script>tracker()</script>' },
    });
    const { bundle } = siteBundle.parse(
      await a.call('exportSite', { params: { id: source.site.id } }),
    );

    const folder = (await b.call('createSiteFolder', {
      body: { kind: 'funnel', name: 'Imported' },
    })) as {
      id: string;
    };
    const imported = siteContract.parse(
      await b.call('importSite', { body: { bundle, folderId: folder.id } }),
    );
    expect(imported).toMatchObject({
      name: 'Spring offer',
      kind: 'funnel',
      folderId: folder.id,
      // What belongs to the business it came from does not travel.
      headCode: '',
      domain: null,
      stepCount: 2,
    });
    expect(imported.steps.map((step) => step.path)).toEqual(['landing', 'thanks']);
    const first = await b.page(imported.steps[0]?.pages[0]?.id ?? '');
    expect(first).toMatchObject({ currentVersion: 1, publishedVersion: null });
    const text = JSON.stringify(first.document);
    expect(text).toContain('{{custom_values.business_phone}}');
    expect(text).toContain(imported.steps[1]?.id);
    expect(text).not.toContain(source.site.steps[1]?.id);
    const sections = siteSectionList.parse(
      await b.call('listSiteSections', { query: { site: imported.id } }),
    );
    expect(sections.items.map((each) => [each.name, each.siteId])).toEqual([
      ['Footer', imported.id],
      ['Header', imported.id],
    ]);
    const renamed = siteContract.parse(
      await b.call('importSite', { body: { bundle, name: 'Again' } }),
    );
    expect(renamed.name).toBe('Again');
    // The audit log keeps how large the bundle was, never the bundle.
    const audited = await harness.database.as('crm_owner', (sql) =>
      sql.query<{ input: Record<string, unknown> }>(
        `select input from audit.commands where command = 'site.import' and business_id = $1`,
        [b.businessId],
      ),
    );
    expect(audited[0]?.input).toMatchObject({ bundleLength: bundle.length });
    expect(JSON.stringify(audited)).not.toContain(bundle.slice(0, 40));
  });

  it('refuses a bundle that was changed, made elsewhere, from another agency or of no site', async () => {
    const a = await harness.tenant();
    const stranger = await harness.tenant();
    const source = await funnel(a);
    const { bundle } = siteBundle.parse(
      await a.call('exportSite', { params: { id: source.site.id } }),
    );
    const refusal = (t: Tenant, text: string) =>
      issuesOf(t.call('importSite', { body: { bundle: text } }));
    const [body = '', signature = ''] = bundle.split('.');
    expect(await refusal(a, `${body.slice(0, -2)}AA.${signature}`)).toEqual([
      { path: '/bundle', code: 'invalid_bundle' },
    ]);
    expect(await refusal(a, 'not a bundle')).toEqual([{ path: '/bundle', code: 'invalid_bundle' }]);
    expect(await refusal(a, signBundle('another-install-secret-of-32-characters', {}))).toEqual([
      { path: '/bundle', code: 'invalid_bundle' },
    ]);
    // Signed by this install, but not what a bundle holds.
    expect(
      await refusal(a, signBundle(BUNDLE_SECRET, { type: 'crm.site-bundle', version: 2 })),
    ).toEqual([{ path: '/bundle', code: 'invalid_bundle' }]);
    expect(await refusal(stranger, bundle)).toEqual([{ path: '/bundle', code: 'foreign_bundle' }]);
    const payload = {
      type: 'crm.site-bundle',
      version: 1,
      agency: a.agencyId,
      exportedAt: '2026-10-11T12:00:00.000Z',
      name: 'A section',
      content: { kind: 'section', section: section('s') },
    };
    expect(await refusal(a, signBundle(BUNDLE_SECRET, payload))).toEqual([
      { path: '/bundle', code: 'invalid_bundle' },
    ]);
    // Two steps at one path cannot both be made.
    const step = {
      id: source.site.steps[0]?.id,
      name: 'One',
      path: 'same',
      document: pageWith([]),
    };
    expect(
      await refusal(
        a,
        signBundle(BUNDLE_SECRET, {
          ...payload,
          content: { kind: 'funnel', steps: [step, { ...step, name: 'Two' }], sections: [] },
        }),
      ),
    ).toEqual([{ path: '/steps', code: 'duplicate_path' }]);
    expect(
      (await a.call('listSites', { query: { kind: 'funnel' } })) as { total: number },
    ).toMatchObject({
      total: 1,
    });
  });

  it('takes sites.share to export and sites.manage to import, and is not offered without a secret', async () => {
    const t = await harness.tenant();
    const source = await funnel(t);
    await expect(
      t.call(
        'exportSite',
        { params: { id: source.site.id } },
        t.as(['sites.manage', 'sites.publish']),
      ),
    ).rejects.toMatchObject({ permission: 'sites.share' });
    await expect(
      t.call('importSite', { body: { bundle: 'x.y' } }, t.as(['sites.share'])),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.callWith({}, 'exportSite', { params: { id: source.site.id } })).rejects.toThrow(
      'No route serves exportSite.',
    );
    await expect(
      t.call('exportSite', { params: { id: toPublicId('site', t.businessId) } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(parsePublicId('site', source.site.id)).toBeDefined();
  });
});
