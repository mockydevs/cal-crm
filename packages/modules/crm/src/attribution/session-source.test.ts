import { ATTRIBUTION_PARAMETERS } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { sessionSourceCases } from '../../test/session-source-cases.js';
import {
  isSearchEngine,
  isSocialSite,
  NO_VISIT,
  readVisit,
  sessionSourceOf,
} from './session-source.js';

describe('the session source of a touch', () => {
  it.each(sessionSourceCases)('$name is $expected', ({ medium, pageUrl, referrer, expected }) => {
    expect(sessionSourceOf(medium, readVisit({ pageUrl, referrer }))).toBe(expected);
  });
});

describe('what is read of a visit', () => {
  it('is nothing when nothing was said', () => {
    expect(readVisit({})).toEqual(NO_VISIT);
  });

  it('reads the labels, the ids and the click ids from the page’s query, and nothing else of it', () => {
    const visit = readVisit({
      pageUrl:
        'https://www.example.com/offer/?utm_source=adwords&utm_medium=Ad+One&utm_campaign=Spring&utm_content=Group&utm_keyword=venue&utm_matchtype=e&campaign_id=111&ad_group_id=222&ad_id=333&gclid=g&gbraid=gb&wbraid=wb&fbclid=fb&msclkid=ms&ctwa_clid=wa&ttclid=tt&li_fat_id=li&source=Trade+fair&email=maya%40example.com#top',
      referrer: 'https://WWW.Google.com/search?q=venue+hire',
    });
    expect(visit).toEqual({
      utmSource: 'adwords',
      utmMedium: 'Ad One',
      utmCampaign: 'Spring',
      utmContent: 'Group',
      utmTerm: 'venue',
      matchType: 'e',
      campaignId: '111',
      adGroupId: '222',
      adId: '333',
      gclid: 'g',
      gbraid: 'gb',
      wbraid: 'wb',
      fbclid: 'fb',
      msclkid: 'ms',
      ctwaClid: 'wa',
      ttclid: 'tt',
      liFatId: 'li',
      sourceParam: 'Trade fair',
      // Only the host of where they came from, and the page without its query.
      referrerDomain: 'www.google.com',
      landingUrl: 'https://www.example.com/offer/',
    });
    expect(JSON.stringify(visit)).not.toContain('maya');
  });

  it('takes the first name of a parameter that has several', () => {
    const read = (query: string) => readVisit({ pageUrl: `https://www.example.com/?${query}` });
    expect(read('utm_term=a&utm_keyword=b').utmTerm).toBe('a');
    expect(read('utm_keyword=b').utmTerm).toBe('b');
    expect(read('matchtype=p').matchType).toBe('p');
    expect(read('utm_id=9').campaignId).toBe('9');
    expect(read('adset_id=7').adGroupId).toBe('7');
    expect(read('adgroup_id=8&adset_id=7').adGroupId).toBe('8');
    // An empty first name falls to the next.
    expect(read('utm_term=&utm_keyword=b').utmTerm).toBe('b');
  });

  it('leaves out a value that is empty or more than one line', () => {
    const read = (value: string) =>
      readVisit({ pageUrl: `https://www.example.com/?utm_source=${encodeURIComponent(value)}` })
        .utmSource;
    expect(read('  ')).toBeNull();
    expect(read('a'.repeat(200))).toBe('a'.repeat(200));
    expect(read('two\nlines')).toBeNull();
    expect(read(`${'a'.repeat(150)}\n${'a'.repeat(150)}`)).toBeNull();
    expect(read('  padded ')).toBe('padded');
  });

  it('cuts a label or an id longer than 200 characters to its first 200, and keeps it', () => {
    const read = (parameter: string, value: string) =>
      readVisit({
        pageUrl: `https://www.example.com/?${parameter}=${encodeURIComponent(value)}`,
      });
    const long = `${'c'.repeat(199)}${'d'.repeat(2)}`;
    expect(read('utm_campaign', long).utmCampaign).toBe('c'.repeat(199) + 'd');
    expect(read('utm_source', 'a'.repeat(201)).utmSource).toBe('a'.repeat(200));
    expect(read('campaign_id', '9'.repeat(500)).campaignId).toBe('9'.repeat(200));
    // What the cut leaves is trimmed again.
    expect(read('utm_term', `${'t'.repeat(199)} x`).utmTerm).toBe('t'.repeat(199));
    // Counted in characters, as the database counts them: a character outside the basic
    // plane is two UTF-16 units and is never split in half.
    // Written as is: escaped, 201 of them would make the address longer than 2000.
    const emoji = readVisit({
      pageUrl: `https://www.example.com/?utm_content=${'\u{1F600}'.repeat(201)}`,
    }).utmContent;
    expect(Array.from(emoji ?? '')).toEqual(Array.from('\u{1F600}'.repeat(200)));
  });

  it.each([
    ['gclid', 'gclid'],
    ['gbraid', 'gbraid'],
    ['wbraid', 'wbraid'],
    ['fbclid', 'fbclid'],
    ['msclkid', 'msclkid'],
    ['ctwa_clid', 'ctwaClid'],
    ['ttclid', 'ttclid'],
    ['li_fat_id', 'liFatId'],
  ] as const)('keeps a %s longer than 200 characters, cut to its first 200', (parameter, fact) => {
    const id = `${'A1-_'.repeat(62)}xy`;
    expect(id).toHaveLength(250);
    const visit = readVisit({ pageUrl: `https://www.example.com/offer?${parameter}=${id}` });
    expect(visit[fact]).toBe(id.slice(0, 200));
  });

  it('attributes a lead whose click id is longer than 200 characters', () => {
    const page = (query: string) => readVisit({ pageUrl: `https://www.example.com/?${query}` });
    const long = 'G'.repeat(250);
    expect(sessionSourceOf('form', page(`gclid=${long}`))).toBe('paid_search');
    expect(sessionSourceOf('form', page(`gbraid=${long}`))).toBe('paid_search');
    expect(sessionSourceOf('form', page(`wbraid=${long}`))).toBe('paid_search');
    expect(sessionSourceOf('form', page(`msclkid=${long}`))).toBe('paid_search');
    expect(sessionSourceOf('form', page(`ctwa_clid=${long}`))).toBe('paid_social');
    // A click id no rule reads alone is still tracking: Others, not Direct.
    expect(sessionSourceOf('form', page(`fbclid=${long}`))).toBe('others');
    expect(sessionSourceOf('form', page(`utm_campaign=${'s'.repeat(201)}`))).toBe('others');
  });

  it('reads only web addresses of a sane length', () => {
    expect(readVisit({ pageUrl: 'not an address', referrer: 'nor this' })).toEqual(NO_VISIT);
    expect(readVisit({ pageUrl: 'ftp://example.com/?utm_source=x' })).toEqual(NO_VISIT);
    expect(readVisit({ pageUrl: `https://example.com/?q=${'a'.repeat(2000)}` })).toEqual(NO_VISIT);
    expect(readVisit({ referrer: 'https://partner.example/a?b=c' })).toEqual({
      ...NO_VISIT,
      referrerDomain: 'partner.example',
    });
    expect(readVisit({ pageUrl: 'http://localhost:5173/form?utm_source=x' })).toMatchObject({
      utmSource: 'x',
      landingUrl: 'http://localhost:5173/form',
    });
  });

  it('reads nothing of a page that is not on the website it was admitted from', () => {
    const visit = {
      pageUrl: 'https://evil.example/?utm_source=adwords',
      referrer: 'https://x.com/',
    };
    expect(readVisit(visit, 'https://www.example.com')).toEqual({
      ...NO_VISIT,
      referrerDomain: 'x.com',
    });
    expect(readVisit(visit, 'https://evil.example').utmSource).toBe('adwords');
  });

  it('counts a referrer on the page’s own site as none', () => {
    expect(
      readVisit({
        pageUrl: 'https://www.example.com/contact',
        referrer: 'https://www.example.com/pricing',
      }).referrerDomain,
    ).toBeNull();
    // Another host of the same company is another site.
    expect(
      readVisit({
        pageUrl: 'https://www.example.com/contact',
        referrer: 'https://blog.example.com/post',
      }).referrerDomain,
    ).toBe('blog.example.com');
  });
});

describe('the lists of sites', () => {
  it('know a search engine by its name in the host', () => {
    for (const host of [
      'google.com',
      'www.google.co.uk',
      'search.yahoo.com',
      'yandex.ru',
      'search.brave.com',
    ])
      expect(isSearchEngine(host), host).toBe(true);
    for (const host of ['brave.com', 'google', 'googleads.example', 'example.com'])
      expect(isSearchEngine(host), host).toBe(false);
  });

  it('know a social site by its name, or by its short address whole', () => {
    for (const host of [
      'facebook.com',
      'm.facebook.com',
      'x.com',
      'mobile.x.com',
      'youtu.be',
      'wa.me',
      'www.tiktok.com',
    ])
      expect(isSocialSite(host), host).toBe(true);
    for (const host of ['box.com', 'fedex.com', 'at.co', 'example.com'])
      expect(isSocialSite(host), host).toBe(false);
  });
});

describe('the click ids of Microsoft, TikTok and LinkedIn', () => {
  // Each by the name its platform appends to a landing address: read alone, kept whole, and
  // nothing else filled.
  it.each([
    ['msclkid', 'msclkid'],
    ['ttclid', 'ttclid'],
    ['li_fat_id', 'liFatId'],
  ] as const)('%s is read from the address into its own fact', (parameter, fact) => {
    const visit = readVisit({ pageUrl: `https://www.example.com/offer?${parameter}=Abc-123_x` });
    expect(visit).toEqual({
      ...NO_VISIT,
      landingUrl: 'https://www.example.com/offer',
      [fact]: 'Abc-123_x',
    });
    expect(ATTRIBUTION_PARAMETERS).toContain(parameter);
    // Case matters to the platform that issued it: the value is not changed.
    expect(
      readVisit({ pageUrl: `https://www.example.com/?${parameter.toUpperCase()}=x` })[fact],
    ).toBeNull();
  });
});
