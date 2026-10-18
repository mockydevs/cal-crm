import { siteKeepArrival, type Site, type SiteStepSummary } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  chosenStep,
  hasHeader,
  keepArrivalChoices,
  listQueryOf,
  listSplat,
  movedStep,
  noTemplateFilters,
  pageOf,
  pathOf,
  placeOf,
  rateText,
  settingsChangeOf,
  settingsDraftOf,
  siteSplat,
  templateQueryOf,
  templatesNarrowed,
  toggled,
  weightOf,
} from './sites-rules';

const siteId = 'site_01h455vb4pex5vsknk084sn02q';
const folderId = 'sfld_01h455vb4pex5vsknk084sn02q';
const stepId = 'sstp_01h455vb4pex5vsknk084sn02q';
const at = '2026-10-11T09:00:00.000Z';

function stepOf(id: string, rest: Partial<SiteStepSummary> = {}): SiteStepSummary {
  return {
    id,
    name: 'Landing Page',
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
        hasUnpublishedChanges: true,
      },
    ],
    revision: 1,
    updatedAt: at,
    ...rest,
  };
}

function siteOf(rest: Partial<Site> = {}): Site {
  return {
    id: siteId,
    kind: 'funnel',
    name: 'Spring offer',
    folderId: null,
    stepCount: 0,
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
    steps: [],
    originTemplateId: null,
    revision: 4,
    canManage: true,
    canPublish: true,
    canShare: true,
    ...rest,
  };
}

describe('placeOf', () => {
  it('opens the Funnels list for nothing, and each list by its word', () => {
    expect(placeOf(undefined)).toEqual({ at: 'list', kind: 'funnel', folderId: undefined });
    expect(placeOf('')).toEqual({ at: 'list', kind: 'funnel', folderId: undefined });
    expect(placeOf('funnels/')).toEqual({ at: 'list', kind: 'funnel', folderId: undefined });
    expect(placeOf('websites')).toEqual({ at: 'list', kind: 'website', folderId: undefined });
  });

  it('reads a folder, a site, its tabs and a chosen step', () => {
    expect(placeOf(`funnels/folder/${folderId}`)).toEqual({ at: 'list', kind: 'funnel', folderId });
    expect(placeOf(`websites/${siteId}`)).toEqual({
      at: 'site',
      kind: 'website',
      siteId,
      tab: 'steps',
      stepId: undefined,
    });
    expect(placeOf(`funnels/${siteId}/settings`)).toEqual({
      at: 'site',
      kind: 'funnel',
      siteId,
      tab: 'settings',
      stepId: undefined,
    });
    expect(placeOf(`funnels/${siteId}/steps/${stepId}`)).toEqual({
      at: 'site',
      kind: 'funnel',
      siteId,
      tab: 'steps',
      stepId,
    });
  });

  it('answers nowhere for anything else', () => {
    for (const splat of [
      'stores',
      'funnels/folder',
      'funnels/folder/nope',
      `funnels/folder/${folderId}/more`,
      'funnels/not-an-id',
      `funnels/${siteId}/sales`,
      `funnels/${siteId}/stats/${stepId}`,
      `funnels/${siteId}/steps/nope`,
      `funnels/${siteId}/steps/${stepId}/more`,
    ]) {
      expect(placeOf(splat), splat).toEqual({ at: 'nowhere' });
    }
  });

  it('is undone by the two address builders', () => {
    expect(listSplat('funnel')).toBe('funnels');
    expect(placeOf(listSplat('website', folderId))).toEqual({
      at: 'list',
      kind: 'website',
      folderId,
    });
    expect(siteSplat('funnel', siteId)).toBe(`funnels/${siteId}`);
    expect(siteSplat('funnel', siteId, 'stats')).toBe(`funnels/${siteId}/stats`);
    expect(siteSplat('website', siteId, 'steps', stepId)).toBe(
      `websites/${siteId}/steps/${stepId}`,
    );
  });
});

describe('listQueryOf', () => {
  const base = {
    kind: 'funnel',
    folderId: undefined,
    text: '',
    view: 'recent',
    limit: 20,
  } as const;

  it('asks Home for the sites in no folder, newest change first', () => {
    expect(listQueryOf({ ...base, after: undefined })).toEqual({
      kind: 'funnel',
      sort: 'updated',
      limit: 20,
      folder: 'none',
    });
  });

  it('searches every folder from Home, and one folder from inside it', () => {
    expect(listQueryOf({ ...base, text: '  spring ', view: 'list', after: 'abc' })).toEqual({
      kind: 'funnel',
      sort: 'name',
      limit: 20,
      q: 'spring',
      after: 'abc',
    });
    expect(listQueryOf({ ...base, folderId, text: 'spring', after: undefined })).toEqual({
      kind: 'funnel',
      sort: 'updated',
      limit: 20,
      folder: folderId,
      q: 'spring',
    });
  });
});

describe('steps', () => {
  it('suggests a path from a name', () => {
    expect(pathOf('Thank You!')).toBe('thank-you');
    expect(pathOf('  Offers / Spring 2026 ')).toBe('offers-spring-2026');
    expect(pathOf('***')).toBe('');
  });

  it('moves a step one place and stops at the ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(movedStep(ids, 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(movedStep(ids, 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(movedStep(ids, 'a', 'up')).toBe(ids);
    expect(movedStep(ids, 'c', 'down')).toBe(ids);
    expect(movedStep(ids, 'z', 'down')).toBe(ids);
  });

  it('chooses the step the address names, or the first', () => {
    const steps = [stepOf('one'), stepOf('two')];
    expect(chosenStep(steps, 'two')?.id).toBe('two');
    expect(chosenStep(steps, 'gone')?.id).toBe('one');
    expect(chosenStep(steps, undefined)?.id).toBe('one');
    expect(chosenStep([], 'two')).toBeUndefined();
  });

  it('finds a page by its role', () => {
    const step = stepOf('one');
    expect(pageOf(step, 'control')?.weight).toBe(100);
    expect(pageOf(step, 'variation')).toBeUndefined();
  });

  it('reads a share of a hundred', () => {
    expect(weightOf('50')).toBe(50);
    expect(weightOf(' 100 ')).toBe(100);
    expect(weightOf('0')).toBe(0);
    expect(weightOf('101')).toBeUndefined();
    expect(weightOf('5.5')).toBeUndefined();
    expect(weightOf('')).toBeUndefined();
  });
});

describe('settings', () => {
  it('sends nothing when nothing changed', () => {
    const site = siteOf();
    expect(settingsChangeOf(site, settingsDraftOf(site))).toBeUndefined();
    expect(
      settingsChangeOf(site, { ...settingsDraftOf(site), name: ' Spring offer ' }),
    ).toBeUndefined();
  });

  it('sends the revision and only what changed', () => {
    const site = siteOf();
    expect(
      settingsChangeOf(site, {
        ...settingsDraftOf(site),
        name: 'Summer offer',
        path: ' offers/summer ',
        faviconUrl: 'https://cdn.example/icon.png',
        headCode: '<script></script>',
        privacyFonts: true,
        optimizeImages: false,
      }),
    ).toEqual({
      revision: 4,
      name: 'Summer offer',
      path: 'offers/summer',
      faviconUrl: 'https://cdn.example/icon.png',
      headCode: '<script></script>',
      privacyFonts: true,
      optimizeImages: false,
    });
  });

  it('keeps how visitors arrived as one of three answers, and sends it only when changed', () => {
    const site = siteOf();
    expect(keepArrivalChoices).toEqual(['unless_opted_out', 'always', 'never']);
    expect(settingsDraftOf(site).keepArrival).toBe('unless_opted_out');
    for (const choice of keepArrivalChoices) {
      const saved = siteOf({ keepArrival: choice });
      expect(settingsDraftOf(saved).keepArrival).toBe(choice);
      expect(settingsChangeOf(saved, settingsDraftOf(saved))).toBeUndefined();
      for (const other of keepArrivalChoices.filter((each) => each !== choice))
        expect(settingsChangeOf(saved, { ...settingsDraftOf(saved), keepArrival: other })).toEqual({
          revision: 4,
          keepArrival: other,
        });
    }
    // Every answer the API takes is offered, and no other.
    expect([...keepArrivalChoices].toSorted()).toEqual([...siteKeepArrival].toSorted());
  });

  it('removes a domain, a widget and a favicon with null', () => {
    const site = siteOf({
      domain: { id: 'sdom_01h455vb4pex5vsknk084sn02q', hostname: 'go.example', verified: true },
      chatWidgetId: 'wcw_01h455vb4pex5vsknk084sn02q',
      faviconUrl: 'https://cdn.example/icon.png',
    });
    const draft = settingsDraftOf(site);
    expect(draft.domainId).toBe('sdom_01h455vb4pex5vsknk084sn02q');
    expect(
      settingsChangeOf(site, { ...draft, domainId: '', chatWidgetId: '', faviconUrl: ' ' }),
    ).toEqual({ revision: 4, domainId: null, chatWidgetId: null, faviconUrl: null });
  });
});

describe('security headers and statistics', () => {
  it('knows a header by its name, whatever its capitals', () => {
    const headers = [{ name: 'X-Frame-Options', value: 'DENY' }];
    expect(hasHeader(headers, ' x-frame-options ')).toBe(true);
    expect(hasHeader(headers, 'Referrer-Policy')).toBe(false);
  });

  it('writes a rate as a percentage', () => {
    expect(rateText(0.125, 'en')).toBe('12.5%');
    expect(rateText(0, 'en')).toBe('0%');
  });
});

describe('template library', () => {
  it('asks for a list as it stands', () => {
    expect(templateQueryOf('funnel', noTemplateFilters, undefined)).toEqual({
      kind: 'funnel',
      list: 'all',
      sort: 'recent',
      limit: 24,
    });
    expect(templatesNarrowed(noTemplateFilters)).toBe(false);
  });

  it('joins several values with commas and leaves out one that holds a comma', () => {
    const filters = {
      ...noTemplateFilters,
      list: 'favorites',
      categories: ['Coaching', 'Business, Coaching and Consulting', 'Creative'],
      types: ['Checkout'],
      tags: ['spring'],
      text: ' offer ',
      sort: 'popular',
    } as const;
    expect(templateQueryOf('website', filters, 'next')).toEqual({
      kind: 'website',
      list: 'favorites',
      sort: 'popular',
      limit: 24,
      category: 'Coaching,Creative',
      type: 'Checkout',
      tag: 'spring',
      q: 'offer',
      after: 'next',
    });
    expect(templatesNarrowed(filters)).toBe(true);
    expect(templatesNarrowed({ ...noTemplateFilters, text: 'x' })).toBe(true);
  });

  it('ticks and unticks a value', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });
});
