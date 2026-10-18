// Which of two pages a touch is read from: the page the lead was taken on, or the page
// the visit began on, handed over by the browser (arrival.ts). One row a case.
import { ATTRIBUTION_LIMITS, ATTRIBUTION_PARAMETERS } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { readArrival, type SaidVisit } from './arrival.js';
import { leadSourceOfVisit } from './lead-source.js';
import { PARAMETERS, sessionSourceOf } from './session-source.js';

const SITE = 'https://crm.example.test';
const STEP_1 = `${SITE}/s/site/offer`;
const STEP_2 = `${SITE}/s/site/details`;
const BOOKING = `${SITE}/book/agency/events/tour`;
const GOOGLE_AD = '?utm_source=google&utm_medium=cpc&campaign_id=42&gclid=Cj0abc';
const META_AD = '?utm_source=facebook&utm_medium=paid_social&fbclid=IwAR1';
const NOW = Date.parse('2026-10-13T09:00:00.000Z');
const DAY = 86_400_000;

interface Case {
  readonly name: string;
  readonly said: SaidVisit;
  readonly origin?: string;
  /** The lead source, the page the visit began on, the page of the lead, and whether carried. */
  readonly gives: readonly [source: string, landing: string | null, page: string | null, boolean];
}

const CASES: readonly Case[] = [
  {
    name: 'a form on the landing page: the page’s own address, nothing carried',
    said: { pageUrl: `${STEP_1}${GOOGLE_AD}` },
    gives: ['Google Ads', STEP_1, STEP_1, false],
  },
  {
    name: 'the script hands the same page over as the first: still not carried',
    said: {
      pageUrl: `${STEP_1}${GOOGLE_AD}`,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW },
    },
    gives: ['Google Ads', STEP_1, STEP_1, false],
  },
  {
    name: 'a form on step 2 of a funnel reached from a Google ad on step 1',
    said: {
      pageUrl: STEP_2,
      referrer: `${STEP_1}${GOOGLE_AD}`,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, referrer: 'https://www.google.com', at: NOW },
    },
    origin: SITE,
    gives: ['Google Ads', STEP_1, STEP_2, true],
  },
  {
    name: 'the same with no first handed over: Direct, as before',
    said: { pageUrl: STEP_2, referrer: `${STEP_1}${GOOGLE_AD}` },
    origin: SITE,
    gives: ['Direct', STEP_2, STEP_2, false],
  },
  {
    name: 'the page’s own labels win over what was carried (a second ad click)',
    said: {
      pageUrl: `${STEP_2}${META_AD}`,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW - 3_600_000 },
    },
    gives: ['Facebook Ads', STEP_2, STEP_2, false],
  },
  {
    name: 'the page’s own source= wins too, though it is no tracking',
    said: {
      pageUrl: `${STEP_2}?source=Spring%20flyer`,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW },
    },
    gives: ['Spring flyer', STEP_2, STEP_2, false],
  },
  {
    name: 'a booking reached from a site page: the first page’s facts, the booking page kept',
    said: {
      pageUrl: `${BOOKING}?arr=${encodeURIComponent(`${STEP_1}${META_AD}`)}`,
      first: { pageUrl: `${STEP_1}${META_AD}`, at: NOW },
    },
    gives: ['Facebook Ads', STEP_1, BOOKING, true],
  },
  {
    name: 'an organic arrival carried by its referrer alone',
    said: {
      pageUrl: STEP_2,
      first: { pageUrl: STEP_1, referrer: 'https://www.google.com', at: NOW },
    },
    gives: ['Organic Search', STEP_1, STEP_2, true],
  },
  {
    name: 'a first that carries source= and nothing else',
    said: { pageUrl: STEP_2, first: { pageUrl: `${STEP_1}?source=Radio`, at: NOW } },
    gives: ['Radio', STEP_1, STEP_2, true],
  },
  {
    name: 'coming back from a payment page does not rename a named arrival',
    said: {
      pageUrl: STEP_2,
      referrer: 'https://pay.example/done',
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW },
    },
    gives: ['Google Ads', STEP_1, STEP_2, true],
  },
  {
    name: 'a first that says nothing never hides the site this page was reached from',
    said: {
      pageUrl: STEP_2,
      referrer: 'https://www.bing.com/search?q=x',
      first: { pageUrl: STEP_1, at: NOW },
    },
    gives: ['Organic Search', STEP_2, STEP_2, false],
  },
  {
    name: 'a visit that began from nowhere on another page: Direct, with its first page',
    said: { pageUrl: STEP_2, first: { pageUrl: STEP_1, at: NOW } },
    gives: ['Direct', STEP_1, STEP_2, true],
  },
  {
    name: 'a first on another website is not believed (a forged landing)',
    said: {
      pageUrl: STEP_2,
      first: { pageUrl: `https://www.rival.example/offer${GOOGLE_AD}`, at: NOW },
    },
    origin: SITE,
    gives: ['Direct', STEP_2, STEP_2, false],
  },
  {
    name: 'nor one on another website when no origin was admitted (a booking)',
    said: {
      pageUrl: BOOKING,
      first: { pageUrl: `https://www.rival.example/offer${GOOGLE_AD}`, at: NOW },
    },
    gives: ['Direct', BOOKING, BOOKING, false],
  },
  {
    name: 'nor one on the same host by another scheme or port',
    said: {
      pageUrl: STEP_2,
      first: { pageUrl: `http://crm.example.test:8080/s/site/offer${GOOGLE_AD}`, at: NOW },
    },
    gives: ['Direct', STEP_2, STEP_2, false],
  },
  {
    name: 'a page that is not on the admitted website vouches for no first',
    said: {
      pageUrl: 'https://elsewhere.example/contact',
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW },
    },
    origin: SITE,
    gives: ['Direct', null, null, false],
  },
  {
    name: 'a page that said no address vouches for no first',
    said: { first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW } },
    gives: ['Direct', null, null, false],
  },
  {
    name: 'a first that is no web address is not read',
    said: { pageUrl: STEP_2, first: { pageUrl: 'javascript:alert(1)' } },
    gives: ['Direct', STEP_2, STEP_2, false],
  },
  {
    name: 'a first longer than an address may be is not read',
    said: {
      pageUrl: STEP_2,
      first: { pageUrl: `${STEP_1}?gclid=x&pad=${'a'.repeat(ATTRIBUTION_LIMITS.urlLength)}` },
    },
    gives: ['Direct', STEP_2, STEP_2, false],
  },
  {
    name: 'a first exactly ninety days old is believed',
    said: {
      pageUrl: STEP_2,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW - 90 * DAY },
    },
    gives: ['Google Ads', STEP_1, STEP_2, true],
  },
  {
    name: 'one older than ninety days is not',
    said: {
      pageUrl: STEP_2,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW - 90 * DAY - 1 },
    },
    gives: ['Direct', STEP_2, STEP_2, false],
  },
  {
    name: 'one dated more than a day ahead is not (a clock may be off by hours, not days)',
    said: {
      pageUrl: STEP_2,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: NOW + DAY + 1 },
    },
    gives: ['Direct', STEP_2, STEP_2, false],
  },
  {
    name: 'one that says no moment is believed',
    said: { pageUrl: STEP_2, first: { pageUrl: `${STEP_1}${GOOGLE_AD}` } },
    gives: ['Google Ads', STEP_1, STEP_2, true],
  },
  {
    name: 'the referrer of a first on its own site counts as none',
    said: { pageUrl: STEP_2, first: { pageUrl: STEP_1, referrer: `${SITE}/s/site/home` } },
    gives: ['Direct', STEP_1, STEP_2, true],
  },
];

describe('which page a touch is read from', () => {
  it.each(CASES)('$name', ({ said, origin, gives }) => {
    const arrival = readArrival(said, { pageOrigin: origin, now: NOW });
    expect([
      leadSourceOfVisit(arrival.visit).label,
      arrival.visit.landingUrl,
      arrival.pageUrl,
      arrival.carried,
    ]).toEqual([...gives]);
  });

  it('carries every fact of the first page, and none of the page it was handed to', () => {
    const { visit } = readArrival(
      {
        pageUrl: `${STEP_2}?plan=gold`,
        first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, referrer: 'https://www.google.com/', at: NOW },
      },
      { now: NOW },
    );
    expect(visit).toMatchObject({
      utmSource: 'google',
      utmMedium: 'cpc',
      campaignId: '42',
      gclid: 'Cj0abc',
      referrerDomain: 'www.google.com',
      landingUrl: STEP_1,
    });
    expect(sessionSourceOf('form', visit)).toBe('paid_search');
  });

  it('reads the clock itself when none is given', () => {
    const fresh = readArrival({
      pageUrl: STEP_2,
      first: { pageUrl: `${STEP_1}${GOOGLE_AD}`, at: Date.now() },
    });
    expect(fresh.carried).toBe(true);
    expect(readArrival({}).carried).toBe(false);
  });
});

describe('the parameters an address is read for', () => {
  it('are the one list the contract names, which the page script is held to as well', () => {
    expect(Object.values(PARAMETERS).flat().sort()).toEqual([...ATTRIBUTION_PARAMETERS].sort());
  });
});
