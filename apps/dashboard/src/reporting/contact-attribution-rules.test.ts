import type { ContactAttribution } from '@repo/contracts';
import { expect, it } from 'vitest';
import {
  allTouchRows,
  heldClickIds,
  isCarried,
  isOneTouch,
  touchFactKeys,
  touchFacts,
  touchRows,
} from './contact-attribution-rules';

const touchOf = (patch: Partial<ContactAttribution> = {}): ContactAttribution => ({
  touchedAt: '2026-10-10T09:00:00.000Z',
  medium: 'form',
  sessionSource: 'direct',
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  matchType: null,
  campaignId: null,
  adGroupId: null,
  adId: null,
  referrerDomain: null,
  landingUrl: null,
  pageUrl: null,
  source: 'Direct',
  sourceRule: 'direct',
  clickIds: [],
  ...patch,
});

it('lists what a visit said, in the order the page shows it, and nothing it did not say', () => {
  const ad = touchOf({
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'spring',
    utmTerm: 'wedding venue',
    matchType: 'e',
    campaignId: '4242',
    adGroupId: '77',
    adId: '9001',
    referrerDomain: 'google.com',
    landingUrl: 'https://harborlights.example/open-day',
    pageUrl: 'https://harborlights.example/open-day',
  });
  expect(touchFacts(ad)).toEqual([
    { key: 'utmSource', value: 'google' },
    { key: 'utmMedium', value: 'cpc' },
    { key: 'utmCampaign', value: 'spring' },
    { key: 'utmTerm', value: 'wedding venue' },
    { key: 'matchType', value: 'e' },
    { key: 'campaignId', value: '4242' },
    { key: 'adGroupId', value: '77' },
    { key: 'adId', value: '9001' },
    { key: 'referrerDomain', value: 'google.com' },
    // The page of the form is the page they landed on: said once.
    { key: 'landingUrl', value: 'https://harborlights.example/open-day' },
  ]);
  expect(touchFacts(touchOf())).toEqual([]);
  expect(touchFacts(touchOf({ utmContent: '' }))).toEqual([]);
});

it('says the page of the interaction when it is not the page they landed on', () => {
  expect(
    touchFacts(
      touchOf({
        landingUrl: 'https://harborlights.example/open-day',
        pageUrl: 'https://harborlights.example/open-day/book',
      }),
    ),
  ).toEqual([
    { key: 'landingUrl', value: 'https://harborlights.example/open-day' },
    { key: 'pageUrl', value: 'https://harborlights.example/open-day/book' },
  ]);
  expect(touchFacts(touchOf({ pageUrl: 'https://harborlights.example/form' }))).toEqual([
    { key: 'pageUrl', value: 'https://harborlights.example/form' },
  ]);
});

it('names whose click ids are held and never an id', () => {
  const touch = touchOf({
    clickIds: ['gclid', 'fbclid', 'wbraid'],
    // The API sends no click id: these stand for an answer that still carried some, which
    // the schema would let through. Nothing here reads them.
    gclid: 'Cj0KCQ-secret-google',
    fbclid: 'IwAR0-secret-meta',
  });
  expect(heldClickIds(touch)).toEqual(['google', 'meta']);
  expect(JSON.stringify(heldClickIds(touch))).not.toContain('secret');
  expect(JSON.stringify(touchFacts(touch))).not.toContain('secret');
  expect(heldClickIds(touchOf())).toEqual([]);
});

it('knows when the first and the latest touch are one', () => {
  const first = touchOf();
  expect(isOneTouch(first, touchOf())).toBe(true);
  expect(isOneTouch(first, touchOf({ touchedAt: '2026-10-11T09:00:00.000Z' }))).toBe(false);
  expect(isOneTouch(first, null)).toBe(false);
  expect(isOneTouch(null, first)).toBe(false);
  expect(isOneTouch(null, null)).toBe(false);
});

it('says both pages of an arrival that was carried, even when they are one address', () => {
  const page = 'https://harborlights.example/open-day';
  const same = touchOf({ landingUrl: page, pageUrl: page });
  expect(isCarried(same)).toBe(false);
  expect(touchFacts(same).map((fact) => fact.key)).toEqual(['landingUrl']);
  const carried = touchOf({ landingUrl: page, pageUrl: page, arrivalCarried: true });
  expect(isCarried(carried)).toBe(true);
  expect(touchFacts(carried).map((fact) => fact.key)).toEqual(['landingUrl', 'pageUrl']);
  expect(isCarried(touchOf({ arrivalCarried: false }))).toBe(false);
});

it('lists every field when all are asked for, with nothing for what the visit did not say', () => {
  const touch = touchOf({ utmSource: 'google', utmContent: '', landingUrl: 'https://a.example/' });
  const rows = allTouchRows(touch);
  expect(rows.map((row) => row.key)).toEqual([...touchFactKeys]);
  expect(rows.find((row) => row.key === 'utmSource')?.value).toBe('google');
  expect(rows.find((row) => row.key === 'utmContent')?.value).toBeNull();
  expect(rows.find((row) => row.key === 'adId')?.value).toBeNull();
  expect(touchRows(touch, true)).toEqual(rows);
  expect(touchRows(touch, false)).toEqual(touchFacts(touch));
});
