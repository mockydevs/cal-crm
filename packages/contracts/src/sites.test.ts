import { describe, expect, it } from 'vitest';

import { EMPTY_PAGE_DOCUMENT } from './sites-document.js';
import {
  createSiteDomainInput,
  createSiteRedirectInput,
  siteDomainEndpoints,
  updateSiteRedirectInput,
} from './sites-domains.js';
import {
  createSiteStepInput,
  declareSiteWinnerInput,
  publishSitePageInput,
  reorderSiteStepsInput,
  saveSitePageDraftInput,
  setSiteSplitTestInput,
  sitePageElementInfo,
  sitePageProblem,
  sitePageVersion,
  sitePublicStatus,
  SITE_PAGE_AUTOSAVE_IDLE_MINUTES,
  siteStatsQuery,
  siteStepEndpoints,
  updateSiteStepInput,
} from './sites-steps.js';
import {
  createSiteTemplateInput,
  importSiteInput,
  listSiteTemplatesQuery,
  siteBundlePayload,
  siteTemplateContent,
  siteTemplateEndpoints,
  SITE_TEMPLATE_LIMITS,
  updateSiteTemplateInput,
} from './sites-templates.js';
import {
  createSiteFolderInput,
  createSiteInput,
  listSitesQuery,
  setSiteSecurityHeadersInput,
  site,
  siteEndpoints,
  sitePath,
  sitePreviewToken,
  sitePublicKey,
  siteStepSummary,
  siteKeepArrival,
  updateSiteInput,
} from './sites.js';
import { parseInput } from './validation.js';

const SITE = 'site_01h455vb4pex5vsknk084sn02q';
const STEP = 'sstp_01h455vb4pex5vsknk084sn02q';
const PAGE = 'spg_01h455vb4pex5vsknk084sn02q';
const DOMAIN = 'sdom_01h455vb4pex5vsknk084sn02q';
const TEMPLATE = 'stpl_01h455vb4pex5vsknk084sn02q';
const ok = (schema: Parameters<typeof parseInput>[0], input: unknown) =>
  schema.safeParse(input).success;

describe('sites and folders', () => {
  it('creates a funnel or a website, blank or from a template, in no folder by default', () => {
    expect(parseInput(createSiteInput, { kind: 'funnel', name: '  Spring offer ' })).toEqual({
      kind: 'funnel',
      name: 'Spring offer',
      folderId: null,
    });
    expect(ok(createSiteInput, { kind: 'website', name: 'Site', templateId: TEMPLATE })).toBe(true);
    expect(ok(createSiteInput, { kind: 'store', name: 'Shop' })).toBe(false);
    expect(ok(createSiteInput, { kind: 'funnel', name: ' ' })).toBe(false);
    expect(ok(createSiteFolderInput, { kind: 'funnel', name: 'Campaigns' })).toBe(true);
  });

  it('lists a kind, newest change first unless asked by name, fifteen to a page', () => {
    expect(parseInput(listSitesQuery, { kind: 'funnel' })).toEqual({
      kind: 'funnel',
      sort: 'updated',
      limit: 15,
    });
    expect(
      ok(listSitesQuery, { kind: 'website', folder: 'none', sort: 'name', limit: '100' }),
    ).toBe(true);
    expect(ok(listSitesQuery, {})).toBe(false);
    expect(ok(listSitesQuery, { kind: 'funnel', limit: '101' })).toBe(false);
  });

  it('changes only the settings named, and takes an empty path for the domain itself', () => {
    expect(parseInput(updateSiteInput, { revision: 1, path: '' })).toEqual({
      revision: 1,
      path: '',
    });
    expect(ok(updateSiteInput, { revision: 1, domainId: DOMAIN, path: 'offers/spring' })).toBe(
      true,
    );
    expect(ok(updateSiteInput, { revision: 1, faviconUrl: 'javascript:alert(1)' })).toBe(false);
    expect(ok(updateSiteInput, { name: 'No revision' })).toBe(false);
    // Whether the site's pages keep how a visitor arrived: one of three, and nothing else.
    for (const keepArrival of siteKeepArrival)
      expect(ok(updateSiteInput, { revision: 1, keepArrival })).toBe(true);
    for (const keepArrival of ['on', 'off', true, null, ''])
      expect(ok(updateSiteInput, { revision: 1, keepArrival }), String(keepArrival)).toBe(false);
    expect([...siteKeepArrival]).toEqual(['always', 'unless_opted_out', 'never']);
    expect(ok(updateSiteInput, { revision: 1, steps: [] })).toBe(false);
  });

  it('holds a path to lowercase parts with single slashes between', () => {
    for (const path of ['a', 'offers/spring', 'a-b/c-d', '2026/offer'])
      expect(sitePath.safeParse(path).success, path).toBe(true);
    for (const path of ['', '/a', 'a/', 'A', 'a//b', '-a', 'a b', 'a?b'])
      expect(sitePath.safeParse(path).success, path).toBe(false);
  });

  it('refuses a header the server controls, a repeated name and a value on two lines', () => {
    const headers = (list: unknown) =>
      ok(setSiteSecurityHeadersInput, { revision: 1, headers: list });
    expect(headers([{ name: 'Content-Security-Policy', value: "default-src 'self'" }])).toBe(true);
    expect(headers([])).toBe(true);
    expect(headers([{ name: 'Set-Cookie', value: 'a=b' }])).toBe(false);
    expect(headers([{ name: 'X-A', value: 'a\r\nX-B: b' }])).toBe(false);
    expect(
      headers([
        { name: 'X-Frame-Options', value: 'DENY' },
        { name: 'x-frame-options', value: 'SAMEORIGIN' },
      ]),
    ).toBe(false);
  });
});

describe('steps, pages and split tests', () => {
  it('names a step and its path, and changes at least one of them', () => {
    expect(ok(createSiteStepInput, { name: 'Landing', path: 'landing' })).toBe(true);
    expect(ok(createSiteStepInput, { name: 'Landing', path: 'Landing Page' })).toBe(false);
    expect(ok(updateSiteStepInput, { revision: 1, path: 'thanks' })).toBe(true);
    expect(ok(updateSiteStepInput, { revision: 1 })).toBe(false);
    expect(ok(reorderSiteStepsInput, { revision: 1, stepIds: [STEP, STEP] })).toBe(false);
    expect(ok(reorderSiteStepsInput, { revision: 1, stepIds: [STEP] })).toBe(true);
  });

  it('saves a whole valid document from the version it started at', () => {
    expect(ok(saveSitePageDraftInput, { baseVersion: 1, document: EMPTY_PAGE_DOCUMENT })).toBe(
      true,
    );
    expect(ok(saveSitePageDraftInput, { document: EMPTY_PAGE_DOCUMENT })).toBe(false);
    expect(ok(saveSitePageDraftInput, { baseVersion: 1, document: { format: 1 } })).toBe(false);
    expect(
      ok(saveSitePageDraftInput, {
        baseVersion: 1,
        document: { ...EMPTY_PAGE_DOCUMENT, format: 2 },
      }),
    ).toBe(false);
    expect(ok(publishSitePageInput, { revision: 3 })).toBe(true);
    expect(ok(publishSitePageInput, { revision: 3, version: 0 })).toBe(false);
  });

  it('splits visitors in whole percent and names the page that wins', () => {
    expect(ok(setSiteSplitTestInput, { revision: 1, active: true, controlWeight: 70 })).toBe(true);
    expect(ok(setSiteSplitTestInput, { revision: 1, active: true, controlWeight: 101 })).toBe(
      false,
    );
    expect(ok(setSiteSplitTestInput, { revision: 1, active: true, controlWeight: 33.3 })).toBe(
      false,
    );
    expect(ok(declareSiteWinnerInput, { revision: 1, pageId: PAGE })).toBe(true);
    expect(ok(declareSiteWinnerInput, { revision: 1, pageId: STEP })).toBe(false);
    expect(ok(siteStatsQuery, { from: '2026-10-01', to: '2026-10-11' })).toBe(true);
    expect(ok(siteStatsQuery, { from: '11/10/2026' })).toBe(false);
  });
});

describe('templates and bundles', () => {
  const step = { id: STEP, name: 'Landing', path: 'landing', document: EMPTY_PAGE_DOCUMENT };

  it('holds a funnel, a website, a step or a section, and nothing of one business', () => {
    expect(ok(siteTemplateContent, { kind: 'funnel', steps: [step], sections: [] })).toBe(true);
    expect(ok(siteTemplateContent, { kind: 'website', steps: [step], sections: [] })).toBe(true);
    expect(ok(siteTemplateContent, { kind: 'funnel', steps: [], sections: [] })).toBe(false);
    expect(
      ok(siteTemplateContent, { kind: 'step', document: EMPTY_PAGE_DOCUMENT, sections: [] }),
    ).toBe(true);
    expect(
      ok(siteTemplateContent, {
        kind: 'section',
        section: { id: 's', type: 'section', props: { width: 'full' }, rows: [] },
      }),
    ).toBe(true);
    expect(
      ok(siteTemplateContent, {
        kind: 'funnel',
        steps: [step],
        sections: [],
        headCode: '<script>',
      }),
    ).toBe(false);
  });

  it('is saved from a site, a step or a section, for the business unless the agency is named', () => {
    const saved = parseInput(createSiteTemplateInput, {
      source: { type: 'site', siteId: SITE },
      name: 'Our funnel',
    });
    expect(saved).toMatchObject({ scope: 'business', tags: [], colors: [], category: null });
    expect(
      ok(createSiteTemplateInput, {
        source: { type: 'section', pageId: PAGE, sectionId: 'hero' },
        name: 'Hero',
        scope: 'agency',
        tags: ['Lead', 'lead'],
      }),
    ).toBe(false);
    expect(ok(createSiteTemplateInput, { source: { type: 'page' }, name: 'x' })).toBe(false);
    expect(ok(updateSiteTemplateInput, { revision: 1, colors: ['#12ab9f'] })).toBe(true);
    expect(ok(updateSiteTemplateInput, { revision: 1, colors: ['red'] })).toBe(false);
  });

  it('lists a kind with the filters the library shows', () => {
    expect(parseInput(listSiteTemplatesQuery, { kind: 'funnel' })).toEqual({
      kind: 'funnel',
      list: 'all',
      sort: 'recent',
      limit: 24,
    });
    expect(
      ok(listSiteTemplatesQuery, {
        kind: 'step',
        list: 'favorites',
        category: 'Coaching,Creative',
        type: 'Coming Soon',
        tag: 'lead',
        q: 'spring',
        sort: 'popular',
      }),
    ).toBe(true);
    expect(ok(listSiteTemplatesQuery, { kind: 'funnel', list: 'theirs' })).toBe(false);
  });

  it('carries a bundle as text within what a request may hold', () => {
    expect(ok(importSiteInput, { bundle: 'x.y' })).toBe(true);
    expect(ok(importSiteInput, { bundle: '' })).toBe(false);
    expect(ok(importSiteInput, { bundle: 'x'.repeat(SITE_TEMPLATE_LIMITS.bundle + 1) })).toBe(
      false,
    );
    expect(
      ok(siteBundlePayload, {
        type: 'crm.site-bundle',
        version: 1,
        agency: 'a',
        exportedAt: '2026-10-11T12:00:00.000Z',
        name: 'Spring',
        content: { kind: 'funnel', steps: [step], sections: [] },
      }),
    ).toBe(true);
  });
});

describe('domains and redirects', () => {
  it('takes a host name as typed and refuses what is not one', () => {
    expect(parseInput(createSiteDomainInput, { hostname: '  WWW.Example.COM ' })).toEqual({
      hostname: 'www.example.com',
    });
    for (const hostname of [
      'localhost',
      'https://example.com',
      'a..b.com',
      'example.com/path',
      '1.2.3.4',
    ])
      expect(ok(createSiteDomainInput, { hostname }), hostname).toBe(false);
  });

  it('redirects a path to a site of the business or to a web address', () => {
    expect(
      parseInput(createSiteRedirectInput, {
        domainId: DOMAIN,
        path: '/old',
        target: { type: 'site', siteId: SITE },
      }).status,
    ).toBe(301);
    expect(
      ok(updateSiteRedirectInput, {
        revision: 1,
        path: '/old',
        target: { type: 'url', url: 'https://example.com/new' },
        status: 302,
      }),
    ).toBe(true);
    for (const path of ['old', '/a?b', '/a#b', '/a b'])
      expect(
        ok(createSiteRedirectInput, {
          domainId: DOMAIN,
          path,
          target: { type: 'site', siteId: SITE },
        }),
        path,
      ).toBe(false);
    expect(
      ok(createSiteRedirectInput, {
        domainId: DOMAIN,
        path: '/x',
        target: { type: 'url', url: 'javascript:alert(1)' },
      }),
    ).toBe(false);
  });
});

describe('the Sites endpoints', () => {
  const all = [
    ...siteEndpoints,
    ...siteStepEndpoints,
    ...siteTemplateEndpoints,
    ...siteDomainEndpoints,
  ];
  it('are 54 operations in one group, each named once and each at its own address', () => {
    expect(all).toHaveLength(54);
    expect(new Set(all.map((endpoint) => endpoint.operationId)).size).toBe(all.length);
    expect(new Set(all.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).size).toBe(
      all.length,
    );
    expect(new Set(all.map((endpoint) => endpoint.group))).toEqual(new Set(['Sites']));
  });
});

describe('what publishing adds', () => {
  it('takes a site key and a preview token only in the shapes the server makes', () => {
    expect(sitePublicKey.safeParse('0123456789abcdef0123456789abcdef').success).toBe(true);
    for (const bad of [
      'short',
      '0123456789ABCDEF0123456789ABCDEF',
      '_preview',
      `${'a'.repeat(31)}/`,
    ])
      expect(sitePublicKey.safeParse(bad).success).toBe(false);
    expect(sitePreviewToken.safeParse(`${'A'.repeat(70)}.${'B'.repeat(22)}`).success).toBe(true);
    expect(sitePreviewToken.safeParse(`${'A'.repeat(70)}.${'B'.repeat(21)}`).success).toBe(false);
    // No key can be taken for the preview's own address, and no token for a key.
    expect(sitePublicKey.safeParse(`${'A'.repeat(70)}.${'B'.repeat(22)}`).success).toBe(false);
  });

  it('keeps the live address and the key optional, so an older reader still reads a site', () => {
    const step = {
      id: 'sstp_01h455vb4pex5vsknk084sn02q',
      name: 'Landing',
      path: 'landing',
      position: 0,
      splitTest: false,
      pages: [
        {
          id: 'spg_01h455vb4pex5vsknk084sn02q',
          role: 'control',
          weight: 100,
          currentVersion: 1,
          publishedVersion: null,
          publishedAt: null,
          hasUnpublishedChanges: false,
        },
      ],
      revision: 1,
      updatedAt: '2026-10-12T10:00:00.000Z',
    };
    expect(siteStepSummary.safeParse(step).success).toBe(true);
    expect(siteStepSummary.safeParse({ ...step, liveUrl: null }).success).toBe(true);
    expect(
      siteStepSummary.safeParse({ ...step, liveUrl: 'https://crm.example/s/k/landing' }).success,
    ).toBe(true);
    expect(siteStepSummary.safeParse({ ...step, liveUrl: 7 }).success).toBe(false);
    expect(site.shape.publicKey.safeParse(undefined).success).toBe(true);
    expect(site.shape.publicKey.safeParse('nope').success).toBe(false);
  });

  it('says a problem as a sentence about the page or one element, blocking or not', () => {
    expect(
      sitePageProblem.safeParse({
        code: 'empty_page',
        message: 'This page is empty.',
        nodeId: null,
        blocking: true,
      }).success,
    ).toBe(true);
    expect(sitePageProblem.safeParse({ code: 'x', message: 'y', nodeId: 'a' }).success).toBe(false);
    expect(
      sitePageElementInfo.safeParse({ type: 'form', rendering: 'embed', script: true, note: null })
        .success,
    ).toBe(true);
    expect(
      sitePageElementInfo.safeParse({
        type: 'marquee',
        rendering: 'static',
        script: false,
        note: null,
      }).success,
    ).toBe(false);
  });
});

describe('saving without a version each time', () => {
  const base = { baseVersion: 3, document: EMPTY_PAGE_DOCUMENT };
  it('takes an autosave only with the revision it was made from, and never with a name', () => {
    expect(ok(saveSitePageDraftInput, { ...base, autosave: true, revision: 7 })).toBe(true);
    expect(ok(saveSitePageDraftInput, { ...base, autosave: true })).toBe(false);
    expect(ok(saveSitePageDraftInput, { ...base, autosave: true, revision: 7, name: 'x' })).toBe(
      false,
    );
    expect(ok(saveSitePageDraftInput, { ...base, autosave: true, revision: 0 })).toBe(false);
  });

  it('keeps a save on purpose as it was, with a name and a revision if given', () => {
    expect(ok(saveSitePageDraftInput, base)).toBe(true);
    expect(ok(saveSitePageDraftInput, { ...base, autosave: false })).toBe(true);
    expect(ok(saveSitePageDraftInput, { ...base, name: ' Before the launch ' })).toBe(true);
    expect(saveSitePageDraftInput.parse({ ...base, name: ' Before the launch ' }).name).toBe(
      'Before the launch',
    );
    expect(ok(saveSitePageDraftInput, { ...base, name: '  ' })).toBe(false);
    expect(ok(saveSitePageDraftInput, { ...base, name: 'n'.repeat(121) })).toBe(false);
    expect(ok(saveSitePageDraftInput, { ...base, revision: 2 })).toBe(true);
    expect(SITE_PAGE_AUTOSAVE_IDLE_MINUTES).toBe(30);
  });

  it('lists a version with or without its kind, so an older reader still reads one', () => {
    const version = {
      number: 2,
      createdAt: '2026-10-13T10:00:00.000Z',
      createdBy: { kind: 'user', name: 'Ada' },
      restoredFrom: null,
      current: true,
      published: false,
    };
    expect(sitePageVersion.safeParse(version).success).toBe(true);
    expect(
      sitePageVersion.safeParse({
        ...version,
        kind: 'draft',
        name: null,
        updatedAt: '2026-10-13T10:05:00.000Z',
      }).success,
    ).toBe(true);
    expect(sitePageVersion.safeParse({ ...version, kind: 'autosave' }).success).toBe(false);
  });

  it('says whether public pages are served, with a sentence when they are not', () => {
    const scripts = { countdown: true, popup: true };
    expect(
      sitePublicStatus.safeParse({
        enabled: true,
        code: 'enabled',
        reason: null,
        baseUrl: 'https://crm.example/s',
        scripts,
      }).success,
    ).toBe(true);
    expect(
      sitePublicStatus.safeParse({
        enabled: false,
        code: 'no_public_secret',
        reason: 'Public pages are switched off on this install.',
        baseUrl: null,
        scripts: { countdown: false, popup: false },
      }).success,
    ).toBe(true);
    expect(
      sitePublicStatus.safeParse({ enabled: false, code: 'because', reason: null, baseUrl: null })
        .success,
    ).toBe(false);
  });
});
