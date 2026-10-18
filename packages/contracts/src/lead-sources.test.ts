import { expect, it } from 'vitest';
import * as z from 'zod';

import { endpoints } from './api.js';
import {
  ensureLeadSourceTags,
  ensureLeadSourceTagsInput,
  LEAD_SOURCE_LIMITS,
  LEAD_SOURCE_TAG_GROUP,
  leadSourceKeys,
  leadSourceLabels,
  leadSourcePreview,
  leadSourceRuleDescriptions,
  leadSources,
  leadSourceTagName,
  PAID_MEDIUM,
  previewLeadSource,
  previewLeadSourceInput,
} from './lead-sources.js';
import { clickIdNames, contactAttribution } from './reporting-attribution.js';
import { reportSources } from './reporting-sources.js';

it('names every built-in lead source once, with a key that never changes', () => {
  // Stored on every touch (crm.contact_attributions.source_rule): changing one is a migration.
  expect(leadSourceKeys).toEqual([
    'source_param',
    'google_ads',
    'microsoft_ads',
    'facebook_ads',
    'instagram_ads',
    'tiktok_ads',
    'linkedin_ads',
    'paid_other',
    'email',
    'sms',
    'organic_search',
    'facebook',
    'instagram',
    'linkedin',
    'tiktok',
    'youtube',
    'x',
    'social',
    'referral',
    'other',
    'direct',
  ]);
  expect(new Set(leadSourceKeys).size).toBe(leadSourceKeys.length);
  expect(Object.keys(leadSourceLabels)).toEqual(
    leadSourceKeys.filter((key) => key !== 'source_param'),
  );
  expect(Object.keys(leadSourceRuleDescriptions).sort()).toEqual([...leadSourceKeys].sort());
  const names = leadSources.map((each) => each.label);
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
  expect(leadSourceLabels.google_ads).toBe('Google Ads');
  expect(leadSourceLabels.facebook_ads).toBe('Facebook Ads');
  // The keys fit what the database lets a system tag be called (0091: lead_source:<key>).
  for (const key of leadSourceKeys) expect(key).toMatch(/^[a-z][a-z_]{0,39}$/);
});

it('names the tag of a lead source, when a tag can hold it', () => {
  expect(leadSourceTagName('Google Ads')).toBe('Source: Google Ads');
  expect(leadSourceTagName('  Spring flyer ')).toBe('Source: Spring flyer');
  expect(leadSourceTagName('')).toBeUndefined();
  expect(leadSourceTagName('x'.repeat(LEAD_SOURCE_LIMITS.tagNameLength))).toBeUndefined();
  for (const { label } of leadSources)
    expect(leadSourceTagName(label)?.length).toBeLessThanOrEqual(LEAD_SOURCE_LIMITS.tagNameLength);
  expect(LEAD_SOURCE_TAG_GROUP).toBe('Lead source');
});

it('knows a paid medium by Google Analytics’ expression', () => {
  for (const medium of ['cpc', 'ppc', 'cpm', 'paid', 'paid_social', 'retargeting'])
    expect(PAID_MEDIUM.test(medium), medium).toBe(true);
  for (const medium of ['', 'organic', 'social', 'email', 'referral'])
    expect(PAID_MEDIUM.test(medium), medium).toBe(false);
});

it('takes a web address to check, and nothing else', () => {
  expect(previewLeadSource).toMatchObject({ method: 'post', path: '/lead-sources/preview' });
  expect(endpoints.map((endpoint) => endpoint.operationId)).toContain('previewLeadSource');
  expect(
    previewLeadSourceInput.parse({
      url: 'https://www.example.com/offer?utm_source=facebook&utm_medium=cpc',
      referrer: 'https://l.facebook.com/',
      formId: 'form_01h455vb4pex5vsknk084sn02q',
    }),
  ).toMatchObject({ url: 'https://www.example.com/offer?utm_source=facebook&utm_medium=cpc' });
  for (const input of [
    {},
    { url: 'www.example.com' },
    { url: 'javascript:alert(1)' },
    { url: 'ftp://example.com/' },
    { url: `https://example.com/?q=${'a'.repeat(2000)}` },
    { url: 'https://example.com/', referrer: 'facebook' },
    { url: 'https://example.com/', formId: 'tag_01h455vb4pex5vsknk084sn02q' },
    { url: 'https://example.com/', contactId: 'con_01h455vb4pex5vsknk084sn02q' },
  ])
    expect(previewLeadSourceInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
});

it('answers a preview with names of click ids, never their values', () => {
  const answer = {
    sessionSource: 'paid_search',
    source: 'Google Ads',
    sourceRule: 'google_ads',
    reason: leadSourceRuleDescriptions.google_ads,
    facts: {
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      matchType: null,
      campaignId: '11',
      adGroupId: null,
      adId: null,
      referrerDomain: null,
      landingUrl: 'https://www.example.com/offer',
    },
    clickIds: ['gclid'],
    form: {
      id: 'form_01h455vb4pex5vsknk084sn02q',
      contactSource: 'Google Ads',
      tags: [
        { name: 'Wedding enquiry', kind: 'form', exists: true },
        { name: 'Source: Google Ads', kind: 'source', exists: false },
      ],
    },
    warnings: [{ code: 'no_tracking', message: 'It would read as Direct.' }],
  };
  expect(leadSourcePreview.parse(answer)).toEqual(answer);
  expect(leadSourcePreview.parse({ ...answer, form: null }).form).toBeNull();
  expect(leadSourcePreview.safeParse({ ...answer, clickIds: ['Cj0abc'] }).success).toBe(false);
  expect(leadSourcePreview.safeParse({ ...answer, sourceRule: 'vip' }).success).toBe(false);
});

it('gives a touch its lead source, its page and the names of the click ids it holds', () => {
  const touch = {
    touchedAt: '2026-10-13T09:00:00.000Z',
    medium: 'form',
    sessionSource: 'paid_social',
    utmSource: 'facebook',
    utmMedium: 'cpc',
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    matchType: null,
    campaignId: '11',
    adGroupId: '22',
    adId: '33',
    gclid: null,
    gbraid: null,
    wbraid: null,
    fbclid: 'IwAR0',
    msclkid: null,
    ctwaClid: null,
    ttclid: null,
    liFatId: null,
    referrerDomain: 'l.facebook.com',
    landingUrl: 'https://www.example.com/offer',
    pageUrl: 'https://www.example.com/offer',
    source: 'Facebook Ads',
    sourceRule: 'facebook_ads',
    clickIds: ['fbclid'],
  };
  expect(contactAttribution.parse(touch)).toEqual(touch);
  expect(contactAttribution.safeParse({ ...touch, clickIds: ['fbc'] }).success).toBe(false);
  expect(contactAttribution.safeParse({ ...touch, source: undefined }).success).toBe(false);
  // The schema, and so the published API description, has no field for a click id's value:
  // not under the name it has in an address, and not under the name it had here before.
  const declared = Object.keys(contactAttribution.shape);
  for (const key of [...clickIdNames, 'ctwaClid', 'liFatId']) expect(declared).not.toContain(key);
  expect(declared).toContain('clickIds');
  expect(clickIdNames).toEqual([
    'gclid',
    'gbraid',
    'wbraid',
    'fbclid',
    'msclkid',
    'ctwa_clid',
    'ttclid',
    'li_fat_id',
  ]);
});

it('carries no click id in any response of the API, only their names', () => {
  // Every response schema of every endpoint, as JSON Schema: no property is named after a
  // click id. `clickIds` lists the names held; the workflow paths say yes or no.
  const named = new Set<string>([...clickIdNames, 'ctwaClid', 'liFatId']);
  const propertiesOf = (schema: unknown, found: string[] = []): string[] => {
    if (Array.isArray(schema)) for (const each of schema) propertiesOf(each, found);
    else if (typeof schema === 'object' && schema !== null)
      for (const [key, value] of Object.entries(schema) as [string, unknown][]) {
        if (key === 'properties' && typeof value === 'object' && value !== null)
          found.push(...Object.keys(value));
        propertiesOf(value, found);
      }
    return found;
  };
  const leaking = endpoints.flatMap((endpoint) => {
    const response = endpoint.response.schema;
    if (response === undefined) return [];
    return propertiesOf(z.toJSONSchema(response, { unrepresentable: 'any', io: 'output' }))
      .filter((property) => named.has(property))
      .map((property) => `${endpoint.operationId}.${property}`);
  });
  expect(leaking).toEqual([]);
  // The check sees what it looks for: the names of the labels a touch does show.
  expect(
    propertiesOf(z.toJSONSchema(contactAttribution, { unrepresentable: 'any', io: 'output' })),
  ).toEqual(expect.arrayContaining(['utmSource', 'campaignId', 'clickIds']));
});

it('finds or makes the tags of built-in lead sources by key, from a closed list', () => {
  expect(ensureLeadSourceTags).toMatchObject({ method: 'post', path: '/lead-sources/tags' });
  expect(endpoints.map((endpoint) => endpoint.operationId)).toContain('ensureLeadSourceTags');
  expect(
    ensureLeadSourceTagsInput.parse({ sources: ['google_ads', 'facebook_ads', 'direct'] }).sources,
  ).toEqual(['google_ads', 'facebook_ads', 'direct']);
  // Every fixed name may be asked for, and nothing else: no name, no key of one's own, and
  // not the rule whose name is whatever a link says.
  expect(
    ensureLeadSourceTagsInput.safeParse({ sources: leadSources.map((each) => each.key) }).success,
  ).toBe(true);
  for (const input of [
    {},
    { sources: [] },
    { sources: ['source_param'] },
    { sources: ['vip'] },
    { sources: ['Source: Google Ads'] },
    { sources: ['google_ads'], name: 'Mine' },
    { sources: Array.from({ length: 21 }, () => 'direct') },
  ])
    expect(ensureLeadSourceTagsInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
});

it('lets every report source be grouped and filtered by the lead source', () => {
  for (const [key, source] of Object.entries(reportSources))
    expect(source.dimensions.leadSource, key).toEqual({
      label: 'Lead source',
      kind: 'text',
      attribution: true,
    });
});
