import {
  leadSourceKeys,
  leadSourceLabels,
  leadSourceRuleDescriptions,
  leadSources,
  leadSourceTagName,
  PAID_MEDIUM,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { leadSourceCases, leadSourcePage } from '../../test/lead-source-cases.js';
import { leadSourceOf, leadSourceOfVisit } from './lead-source.js';
import {
  hasPaidMarker,
  isSearchEngine,
  isWebmail,
  NO_VISIT,
  paidClickOf,
  platformOf,
  platformOfHost,
  platformOfSource,
  readVisit,
  sessionSourceOf,
} from './session-source.js';

const visitOf = (query = '', referrer?: string) =>
  readVisit({ pageUrl: leadSourcePage(query), referrer });

describe('the name and the channel of one visit', () => {
  // Every mix of what a link can name, what can say it was paid, the click ids and the
  // site they came from, a mailbox read in a browser among them: 8,505 visits.
  const SOURCES = [
    '',
    'google',
    'adwords',
    'bing',
    'yahoo',
    'facebook',
    'fb_ad',
    'instagram',
    'tiktok',
    'linkedin_ad',
    'youtube',
    'twitter_ad',
    'reddit',
    'taboola',
    'newsletter',
  ];
  const MEDIUMS = ['', 'cpc', 'paid_social', 'email', 'sms', 'social', 'organic'];
  const EXTRAS = [
    '',
    'campaign_id=5',
    'ad_id=9',
    'gclid=a',
    'msclkid=a',
    'fbclid=a',
    'ctwa_clid=a',
    'ttclid=a',
    'li_fat_id=a',
  ];
  const REFERRERS = [
    undefined,
    'https://www.google.com/',
    'https://www.bing.com/',
    'https://duckduckgo.com/',
    'https://l.facebook.com/',
    'https://www.instagram.com/',
    'https://www.youtube.com/',
    'https://blog.partner.example/',
    'https://mail.google.com/',
  ];
  const visits = SOURCES.flatMap((source) =>
    MEDIUMS.flatMap((medium) =>
      EXTRAS.flatMap((extra) =>
        REFERRERS.map((referrer) => {
          const query = [
            source === '' ? '' : `utm_source=${source}`,
            medium === '' ? '' : `utm_medium=${medium}`,
            extra,
          ].filter((part) => part !== '');
          return { query: query.length === 0 ? '' : `?${query.join('&')}`, referrer };
        }),
      ),
    ),
  );
  const SEARCH_ADS = new Set(['google_ads', 'microsoft_ads']);
  const SOCIAL_ADS = new Set(['facebook_ads', 'instagram_ads', 'tiktok_ads', 'linkedin_ads']);
  /** The article's rule 3: a labelled visit from Google is paid search, whatever it names. */
  const byRuleThree = (query: string, referrer: string | undefined) =>
    referrer === 'https://www.google.com/' && /utm_(source|medium)=/u.test(query);

  it('never disagree: an Ads name sits beside its own paid channel, and a paid channel beside a paid name', () => {
    expect(visits).toHaveLength(8505);
    let checked = 0;
    for (const { query, referrer } of visits) {
      const visit = visitOf(query, referrer);
      const { key } = leadSourceOfVisit(visit);
      const channel = sessionSourceOf('form', visit);
      const paid = paidClickOf(visit);
      const about = `${query} from ${String(referrer)}: ${key}, ${channel}`;
      const named = SEARCH_ADS.has(key) || SOCIAL_ADS.has(key);
      // The name reads the one decision: Ads only for a paid click, on its own channel.
      if (paid === undefined) expect(named, about).toBe(false);
      else {
        expect(named || key === 'paid_other', about).toBe(true);
        if (SEARCH_ADS.has(key)) expect(paid.channel, about).toBe('paid_search');
        if (SOCIAL_ADS.has(key)) expect(paid.channel, about).toBe('paid_social');
      }
      // The channel reads it too. Apart only where the article's rule 3 speaks first.
      if (byRuleThree(query, referrer)) continue;
      checked += 1;
      const paidChannel = channel === 'paid_search' || channel === 'paid_social';
      if (paid === undefined) expect(paidChannel, about).toBe(false);
      else expect(channel, about).toBe(paid.channel);
    }
    expect(checked).toBeGreaterThan(7000);
  });

  it('a campaign id or an ad id on an email or sms link makes no ad, wherever it was opened', () => {
    let checked = 0;
    for (const { query, referrer } of visits) {
      if (!/utm_medium=(email|sms)(&(campaign_id|ad_id)=\d)?$/u.test(query)) continue;
      // The article's own conventions still mark a click: adwords, and a source ending _ad.
      if (/utm_source=(adwords|\w+_ad)/u.test(query)) continue;
      checked += 1;
      const visit = visitOf(query, referrer);
      const about = `${query} from ${String(referrer)}`;
      expect(hasPaidMarker(visit), about).toBe(false);
      expect(paidClickOf(visit), about).toBeUndefined();
      expect(leadSourceOfVisit(visit).key, about).toBe(
        query.includes('utm_medium=sms') && !query.includes('utm_source=email') ? 'sms' : 'email',
      );
    }
    expect(checked).toBe(11 * 2 * 3 * 9);
  });

  it('a mailbox read in a browser is no search engine and names no platform', () => {
    for (const host of [
      'mail.google.com',
      'mail.yahoo.com',
      'uk.mail.yahoo.com',
      'mail.yandex.ru',
      'outlook.live.com',
      'outlook.office.com',
      'mail.proton.me',
      'webmail.partner.example',
    ]) {
      expect(isWebmail(host), host).toBe(true);
      expect(isSearchEngine(host), host).toBe(false);
      expect(platformOfHost(host), host).toBeUndefined();
    }
    for (const host of ['www.google.com', 'www.bing.com', 'search.yahoo.com', 'mailchimp.com'])
      expect(isWebmail(host), host).toBe(false);
    // An untagged link opened in Gmail came from a site, and that is all that is known.
    const plain = visitOf('', 'https://mail.google.com/');
    expect(leadSourceOfVisit(plain).key).toBe('referral');
    expect(sessionSourceOf('form', plain)).toBe('referral');
    // Tagged email, it is Email, and the article's rule 3 does not call it paid search.
    const tagged = visitOf('?utm_source=newsletter&utm_medium=email', 'https://mail.google.com/');
    expect(leadSourceOfVisit(tagged).key).toBe('email');
    expect(sessionSourceOf('form', tagged)).toBe('referral');
    // A click id is still what it is, whatever page it was opened from.
    const ad = visitOf('?gclid=abc', 'https://mail.google.com/');
    expect(leadSourceOfVisit(ad).key).toBe('google_ads');
    expect(sessionSourceOf('form', ad)).toBe('paid_search');
  });

  it('the edge that was: a paid medium from Bing is Microsoft Ads and Paid search', () => {
    const visit = visitOf('?utm_medium=cpc', 'https://www.bing.com/');
    expect(leadSourceOfVisit(visit).key).toBe('microsoft_ads');
    expect(sessionSourceOf('form', visit)).toBe('paid_search');
    expect(paidClickOf(visit)).toEqual({
      channel: 'paid_search',
      platform: 'microsoft',
      rule: 'ours',
    });
  });

  it('says what it leaves apart: rule 3 without a paid marker, and paid on no platform', () => {
    // A newsletter link opened from Google: the article calls it paid search; the name
    // says what the link says.
    const newsletter = visitOf(
      '?utm_source=newsletter&utm_medium=email',
      'https://www.google.com/',
    );
    expect(sessionSourceOf('form', newsletter)).toBe('paid_search');
    expect(leadSourceOfVisit(newsletter).key).toBe('email');
    expect(paidClickOf(newsletter)).toBeUndefined();
    // Paid, on nobody's platform: the article has no channel for it.
    const unknown = visitOf('?utm_source=taboola&utm_medium=cpc');
    expect(sessionSourceOf('form', unknown)).toBe('others');
    expect(leadSourceOfVisit(unknown).key).toBe('paid_other');
  });
});

describe('the lead source of a visit', () => {
  it.each(leadSourceCases)('$name is $expected', ({ query, referrer, expected, label }) => {
    const lead = leadSourceOfVisit(visitOf(query, referrer));
    expect(lead.key).toBe(expected);
    expect(lead.label).toBe(expected === 'source_param' ? label : leadSourceLabels[expected]);
  });

  it('has a case for every built-in rule', () => {
    const covered = new Set(leadSourceCases.map((each) => each.expected));
    expect(leadSourceKeys.filter((key) => !covered.has(key))).toEqual([]);
  });

  it('is decided by the first rule that fits, in the published order', () => {
    // Each visit meets its own rule and every rule after the arrow; the earlier one wins.
    const order = [
      ['?source=Radio&gclid=a&msclkid=b&utm_medium=cpc', 'source_param'],
      ['?gclid=a&msclkid=b&utm_source=facebook&utm_medium=cpc', 'google_ads'],
      ['?msclkid=b&utm_source=facebook&utm_medium=cpc', 'microsoft_ads'],
      ['?utm_source=facebook&utm_medium=cpc', 'facebook_ads'],
      ['?utm_source=tiktok&utm_medium=cpc', 'tiktok_ads'],
      ['?utm_source=linkedin&utm_medium=cpc', 'linkedin_ads'],
      ['?utm_source=email&utm_medium=cpc', 'paid_other'],
      ['?utm_source=facebook&utm_medium=email', 'email'],
      ['?utm_source=google&utm_medium=sms', 'sms'],
    ] as const;
    for (const [query, expected] of order)
      expect(leadSourceOfVisit(visitOf(query, 'https://blog.partner.example/')).key, query).toBe(
        expected,
      );
    // Search before social before any other site, when only the site is known.
    expect(leadSourceOfVisit(visitOf('', 'https://www.google.com/')).key).toBe('organic_search');
    expect(leadSourceOfVisit(visitOf('?utm_source=google', 'https://www.facebook.com/')).key).toBe(
      'organic_search',
    );
  });

  it('gives a name that a contact’s Source and a tag can hold', () => {
    for (const { key, label } of leadSources) {
      expect(label, key).toMatch(/^\P{Cc}{1,200}$/u);
      expect(leadSourceTagName(label), key).toBe(`Source: ${label}`);
      expect(leadSourceRuleDescriptions[key]).not.toBe('');
    }
    expect(leadSources.map((each) => each.key)).toEqual(
      leadSourceKeys.filter((key) => key !== 'source_param'),
    );
    // A name an address chose can be too long for a tag: it then has none.
    expect(leadSourceTagName('a'.repeat(52))).toBe(`Source: ${'a'.repeat(52)}`);
    expect(leadSourceTagName('a'.repeat(53))).toBeUndefined();
    expect(leadSourceTagName('   ')).toBeUndefined();
  });

  it('keeps the text of source= as it was written, and refuses what a Source cannot hold', () => {
    expect(leadSourceOfVisit(visitOf('?source=%20Trade%20fair%202026%20')).label).toBe(
      'Trade fair 2026',
    );
    expect(leadSourceOfVisit(visitOf(`?source=${'a'.repeat(200)}`)).label).toHaveLength(200);
    // Too long, or more than one line: not read at all, never cut short.
    expect(leadSourceOfVisit(visitOf(`?source=${'a'.repeat(201)}`)).key).toBe('direct');
    expect(leadSourceOfVisit(visitOf('?source=two%0Alines')).key).toBe('direct');
  });

  it('names a lead by a click id or a label longer than 200 characters, never Direct', () => {
    const long = 'G'.repeat(250);
    expect(leadSourceOfVisit(visitOf(`?gclid=${long}`)).key).toBe('google_ads');
    expect(leadSourceOfVisit(visitOf(`?wbraid=${long}`)).key).toBe('google_ads');
    expect(leadSourceOfVisit(visitOf(`?msclkid=${long}`)).key).toBe('microsoft_ads');
    expect(leadSourceOfVisit(visitOf(`?ctwa_clid=${long}`)).key).toBe('facebook_ads');
    expect(leadSourceOfVisit(visitOf(`?fbclid=${long}`)).key).toBe('facebook');
    expect(leadSourceOfVisit(visitOf(`?ttclid=${long}`)).key).toBe('tiktok');
    expect(leadSourceOfVisit(visitOf(`?li_fat_id=${long}`)).key).toBe('linkedin');
    expect(
      leadSourceOfVisit(
        visitOf(`?utm_source=google&utm_medium=cpc&utm_campaign=${'s'.repeat(201)}`),
      ).key,
    ).toBe('google_ads');
    expect(leadSourceOfVisit(visitOf(`?utm_campaign=${'s'.repeat(201)}`)).key).toBe('other');
  });

  it('is only of a visit to a page', () => {
    const paid = visitOf('?gclid=abc');
    for (const medium of ['form', 'calendar', 'chat'] as const)
      expect(leadSourceOf(medium, paid)).toEqual({ key: 'google_ads', label: 'Google Ads' });
    for (const medium of [
      'manual',
      'api',
      'import',
      'message',
      'automation',
      'assistant',
      'unknown',
    ] as const)
      expect(leadSourceOf(medium, paid)).toBeNull();
    // A chat knows only its website: nothing is known of how the visitor arrived.
    expect(leadSourceOf('chat', { ...NO_VISIT, landingUrl: 'https://www.example.com' })).toEqual({
      key: 'direct',
      label: 'Direct',
    });
  });
});

describe('the paid marker', () => {
  const marked = (query: string) => hasPaidMarker(visitOf(query));

  it('is a medium that matches Google Analytics’ expression', () => {
    for (const medium of [
      'cpc',
      'CPC',
      'ppc',
      'cpm',
      'cpv',
      'cpa',
      'paid',
      'paid_social',
      'paidsocial',
      'paid-search',
      'retargeting',
      'ecpc',
    ])
      expect(marked(`?utm_medium=${medium}`), medium).toBe(true);
    for (const medium of ['social', 'organic', 'email', 'referral', 'pp', 'unpaid', 'retarget'])
      expect(marked(`?utm_medium=${medium}`), medium).toBe(false);
    expect(PAID_MEDIUM.source).toBe('^(.*cp.*|ppc|retargeting|paid.*)$');
  });

  it('is a source that ends _ad or contains adwords, or a campaign or ad id', () => {
    expect(marked('?utm_source=fb_ad')).toBe(true);
    expect(marked('?utm_source=FB_AD')).toBe(true);
    expect(marked('?utm_source=google-adwords')).toBe(true);
    expect(marked('?campaign_id=1')).toBe(true);
    expect(marked('?utm_id=1')).toBe(true);
    expect(marked('?ad_id=1')).toBe(true);
    // Not an ad group id by itself, not a click id, not a label.
    expect(marked('?adset_id=1')).toBe(false);
    expect(marked('?fbclid=abc')).toBe(false);
    expect(marked('?utm_source=fb_ads')).toBe(false);
    expect(marked('?utm_campaign=paid')).toBe(false);
    expect(marked('')).toBe(false);
  });
});

describe('the platform of a visit', () => {
  it('is what utm_source names, by its words', () => {
    expect(platformOfSource('fb_ad')).toBe('facebook');
    expect(platformOfSource('Facebook')).toBe('facebook');
    expect(platformOfSource('ig-story')).toBe('instagram');
    expect(platformOfSource('google.com')).toBe('google');
    expect(platformOfSource('bing')).toBe('microsoft');
    expect(platformOfSource('yahoo')).toBe('search');
    expect(platformOfSource('twitter')).toBe('x');
    expect(platformOfSource('snapchat')).toBe('social');
    // A word is whole: these name nothing.
    for (const source of ['fbx', 'mygoogle', 'newsletter', 'constructor', '', null])
      expect(platformOfSource(source), String(source)).toBeUndefined();
  });

  it('is the site they came from, by its name or its short address', () => {
    expect(platformOfHost('www.google.co.uk')).toBe('google');
    expect(platformOfHost('www.bing.com')).toBe('microsoft');
    expect(platformOfHost('search.yahoo.com')).toBe('search');
    expect(platformOfHost('l.messenger.com')).toBe('facebook');
    expect(platformOfHost('fb.me')).toBe('facebook');
    expect(platformOfHost('l.instagram.com')).toBe('instagram');
    expect(platformOfHost('mobile.x.com')).toBe('x');
    expect(platformOfHost('twitter.com')).toBe('x');
    expect(platformOfHost('www.pinterest.com')).toBe('social');
    expect(platformOfHost('wa.me')).toBe('social');
    expect(platformOfHost('blog.partner.example')).toBeUndefined();
    expect(platformOfHost(null)).toBeUndefined();
  });

  it('takes the link’s word first, then a click id, then the site', () => {
    expect(platformOf(visitOf('?utm_source=instagram&fbclid=a', 'https://www.google.com/'))).toBe(
      'instagram',
    );
    expect(platformOf(visitOf('?fbclid=a', 'https://www.google.com/'))).toBe('facebook');
    expect(platformOf(visitOf('?ctwa_clid=a'))).toBe('facebook');
    expect(platformOf(visitOf('?ttclid=a'))).toBe('tiktok');
    expect(platformOf(visitOf('?li_fat_id=a'))).toBe('linkedin');
    expect(platformOf(visitOf('?utm_source=newsletter', 'https://www.google.com/'))).toBe('google');
    expect(platformOf(visitOf(''))).toBeUndefined();
  });
});
