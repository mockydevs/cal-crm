import {
  buildTrackingLink,
  leadSourceCondition,
  leadSourceFactNames,
  leadSourceLabels,
  sampleTrackingLink,
  trackingLinkPlatforms,
  trackingLinkTemplates,
  type LeadSourceCondition,
} from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { readArrival } from './arrival.js';
import { leadSourceOfVisit } from './lead-source.js';
import {
  addressParameter,
  decideLeadSource,
  leadFactValue,
  taggedAs,
  type ActiveLeadSourceRule,
  type LeadFacts,
} from './lead-source-rules.js';
import { PARAMETERS, readVisit, sessionSourceOf } from './session-source.js';

const RULE = '01890a5d-ac96-774b-bcce-b302099a80';
const TAG = '01890a5d-ac96-774b-bcce-b302099a90';
const FIELD = '01890a5d-ac96-774b-bcce-b302099aa0';
const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, '0')}`;

const condition = (given: unknown): LeadSourceCondition => leadSourceCondition.parse(given);

const rule = (
  n: number,
  conditions: readonly unknown[],
  does: {
    source?: string;
    tags?: readonly number[];
    writes?: readonly (readonly [number, string])[];
  },
): ActiveLeadSourceRule => ({
  id: id(RULE, n),
  position: n,
  name: `Rule ${String(n)}`,
  conditions: conditions.map(condition),
  source: does.source ?? null,
  tagIds: (does.tags ?? []).map((tag) => id(TAG, tag)),
  fieldWrites: (does.writes ?? []).map(([field, value]) => ({ fieldId: id(FIELD, field), value })),
});

const PAGE = 'https://www.harborlights.example/offer/step-2';
const facts = (query = '', referrer?: string, medium: LeadFacts['medium'] = 'form'): LeadFacts => {
  const address = `${PAGE}${query}`;
  const visit = readVisit({ pageUrl: address, referrer });
  return { medium, visit, pageUrl: visit.landingUrl, address };
};

const SPRING =
  '?utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring-2026&campaign_id=77';
const AUTUMN = '?utm_source=facebook&utm_medium=paid_social&utm_campaign=autumn&campaign_id=78';

describe('the business’s own rules', () => {
  const rename = rule(
    1,
    [
      { fact: 'lead_source', op: 'is', value: 'facebook_ads' },
      { fact: 'utm_campaign', op: 'contains', value: 'spring' },
    ],
    { source: 'Spring promo', tags: [1] },
  );

  it('rename the Facebook Ads leads of one campaign and add a tag, and leave the others alone', () => {
    const spring = decideLeadSource([rename], facts(SPRING));
    expect(spring.label).toBe('Spring promo');
    expect(spring.rule).toBe(toPublicId('lead_source_rule', id(RULE, 1)));
    expect(spring.builtIn).toEqual({ key: 'facebook_ads', label: 'Facebook Ads' });
    expect(spring.decidedBy?.id).toBe(id(RULE, 1));
    expect(spring.tagIds).toEqual([id(TAG, 1)]);

    const autumn = decideLeadSource([rename], facts(AUTUMN));
    expect(autumn).toMatchObject({
      label: 'Facebook Ads',
      rule: 'facebook_ads',
      decidedBy: undefined,
      matches: [],
      tagIds: [],
      fieldWrites: [],
    });
  });

  it('fall back to the built-in rules when no matching rule names a Source', () => {
    const tagOnly = rule(1, [{ fact: 'session_source', op: 'is', value: 'paid_social' }], {
      tags: [3],
      writes: [[1, 'Paid']],
    });
    const decided = decideLeadSource([tagOnly], facts(SPRING));
    expect(decided.label).toBe('Facebook Ads');
    expect(decided.rule).toBe('facebook_ads');
    expect(decided.decidedBy).toBeUndefined();
    expect(decided.matches).toEqual([tagOnly]);
    expect(decided.tagIds).toEqual([id(TAG, 3)]);
    expect(decided.fieldWrites).toEqual([{ fieldId: id(FIELD, 1), value: 'Paid' }]);
    // With no rule at all a lead is named exactly as before there were rules.
    for (const query of ['', '?gclid=a', '?source=Radio', SPRING]) {
      const bare = decideLeadSource([], facts(query));
      const builtIn = leadSourceOfVisit(facts(query).visit);
      expect(bare, query).toMatchObject({ label: builtIn.label, rule: builtIn.key });
      expect(taggedAs(bare)).toEqual(builtIn);
    }
  });

  it('let the first matching rule that names a Source decide, and apply every match’s tags and fields', () => {
    const rules = [
      rule(1, [{ fact: 'utm_medium', op: 'is', value: 'PAID_SOCIAL' }], {
        tags: [1, 2],
        writes: [[1, 'first']],
      }),
      rule(2, [{ fact: 'utm_campaign', op: 'starts_with', value: 'spring' }], {
        source: 'Spring promo',
        tags: [2, 3],
        writes: [
          [1, 'second'],
          [2, 'spring'],
        ],
      }),
      rule(3, [{ fact: 'campaign_id', op: 'is_one_of', values: ['77', '78'] }], {
        source: 'Campaign 77',
        tags: [4],
      }),
      rule(4, [{ fact: 'utm_source', op: 'is', value: 'google' }], { source: 'Never', tags: [9] }),
    ];
    const decided = decideLeadSource(rules, facts(SPRING));
    expect(decided.matches.map((each) => each.position)).toEqual([1, 2, 3]);
    // Rule 1 names none, so rule 2 decides; rule 3 matches too and names nothing.
    expect(decided.label).toBe('Spring promo');
    expect(decided.decidedBy?.position).toBe(2);
    // Tags of every match, each once, in rule order. A field goes to the first that names it.
    expect(decided.tagIds).toEqual([1, 2, 3, 4].map((tag) => id(TAG, tag)));
    expect(decided.fieldWrites).toEqual([
      { fieldId: id(FIELD, 1), value: 'first' },
      { fieldId: id(FIELD, 2), value: 'spring' },
    ]);
    // The order is the list's: the same two rules the other way round name it differently.
    const swapped = decideLeadSource(
      [rules[2], rules[1]].flatMap((each) => each ?? []),
      facts(SPRING),
    );
    expect(swapped.label).toBe('Campaign 77');
    // A name a rule gave is tagged like a name a link chose: the system makes no tag of it.
    expect(taggedAs(decided)).toEqual({ key: 'source_param', label: 'Spring promo' });
  });

  it('beat source= in the address, which is only the first built-in rule', () => {
    const radio = rule(1, [{ fact: 'parameter', name: 'source', op: 'is', value: 'radio' }], {
      source: 'Radio (all stations)',
    });
    expect(decideLeadSource([radio], facts('?source=Radio')).label).toBe('Radio (all stations)');
    expect(decideLeadSource([radio], facts('?source=TV')).label).toBe('TV');
  });

  it('fill at most ten fields a lead, from the rules in their order', () => {
    const rules = [1, 2, 3, 4, 5].map((n) =>
      rule(n, [{ fact: 'medium', op: 'is', value: 'form' }], {
        writes: [1, 2, 3].map((field) => [n * 10 + field, 'x'] as const),
      }),
    );
    const decided = decideLeadSource(rules, facts());
    expect(decided.fieldWrites).toHaveLength(10);
    expect(decided.fieldWrites.at(-1)?.fieldId).toBe(id(FIELD, 41));
  });

  it('match nothing with no condition, and need every condition to hold', () => {
    const none: ActiveLeadSourceRule = { ...rename, conditions: [] };
    expect(decideLeadSource([none], facts(SPRING)).matches).toEqual([]);
    expect(decideLeadSource([rename], facts('?utm_campaign=spring')).matches).toEqual([]);
  });
});

describe('the facts a condition reads', () => {
  const GOOGLE =
    '?utm_source=google&utm_medium=cpc&utm_campaign=c&utm_content=d&utm_term=kw&matchtype=p&campaign_id=1&ad_group_id=2&ad_id=3&gclid=abc&promo=Spring%20Sale';
  const all = facts(GOOGLE, 'https://www.google.com/search?q=x');
  const builtIn = leadSourceOfVisit(all.visit);
  const value = (fact: string, name?: string) =>
    leadFactValue(
      { fact: fact as LeadSourceCondition['fact'], ...(name === undefined ? {} : { name }) },
      all,
      builtIn,
    );

  it('are the visit’s own, one for each word of the vocabulary', () => {
    const read = Object.fromEntries(
      leadSourceFactNames.map((fact) => [
        fact,
        value(fact, fact === 'parameter' ? 'promo' : undefined),
      ]),
    );
    expect(read).toEqual({
      lead_source: 'google_ads',
      session_source: 'paid_search',
      medium: 'form',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'c',
      utm_content: 'd',
      utm_term: 'kw',
      match_type: 'p',
      campaign_id: '1',
      ad_group_id: '2',
      ad_id: '3',
      click_id_google: 'yes',
      click_id_meta: null,
      click_id_microsoft: null,
      click_id_tiktok: null,
      click_id_linkedin: null,
      referrer_domain: 'www.google.com',
      landing_page: PAGE,
      form_page: PAGE,
      site: 'www.harborlights.example',
      step: '/offer/step-2',
      parameter: 'Spring Sale',
    });
    expect(sessionSourceOf('form', all.visit)).toBe('paid_search');
  });

  it('say only whether a click id is there, for each platform', () => {
    const held = (query: string) =>
      (['google', 'meta', 'microsoft', 'tiktok', 'linkedin'] as const).filter(
        (platform) =>
          leadFactValue({ fact: `click_id_${platform}` }, facts(query), builtIn) !== null,
      );
    expect(held('?gbraid=a')).toEqual(['google']);
    expect(held('?wbraid=a&fbclid=b')).toEqual(['google', 'meta']);
    expect(held('?ctwa_clid=a')).toEqual(['meta']);
    expect(held('?msclkid=a&ttclid=b&li_fat_id=c')).toEqual(['microsoft', 'tiktok', 'linkedin']);
    expect(held('')).toEqual([]);
  });

  it('read a parameter by its name as any fact is read: trimmed, one line, at most 200 characters', () => {
    expect(addressParameter(`${PAGE}?promo=%20spring%20`, 'promo')).toBe('spring');
    expect(addressParameter(`${PAGE}?promo=a&promo=b`, 'promo')).toBe('a');
    expect(addressParameter(`${PAGE}?promo=`, 'promo')).toBeNull();
    expect(addressParameter(`${PAGE}?promo=${'x'.repeat(201)}`, 'promo')).toBeNull();
    expect(addressParameter(`${PAGE}?promo=a%0Ab`, 'promo')).toBeNull();
    expect(addressParameter(`${PAGE}?Promo=a`, 'promo')).toBeNull();
    expect(addressParameter(undefined, 'promo')).toBeNull();
    expect(addressParameter('not an address', 'promo')).toBeNull();
  });

  it('read the first page’s parameters when the arrival was carried to the form’s page', () => {
    const arrival = readArrival({
      pageUrl: PAGE,
      first: { pageUrl: 'https://www.harborlights.example/offer?utm_source=google&promo=spring' },
    });
    expect(arrival.carried).toBe(true);
    const carried: LeadFacts = {
      medium: 'form',
      visit: arrival.visit,
      pageUrl: arrival.pageUrl,
      address: arrival.address,
    };
    const promo = rule(1, [{ fact: 'parameter', name: 'promo', op: 'is', value: 'spring' }], {
      source: 'Spring promo',
    });
    const step = rule(2, [{ fact: 'step', op: 'is', value: '/offer/step-2' }], { tags: [1] });
    const landing = rule(3, [{ fact: 'landing_page', op: 'is_not', value: PAGE }], { tags: [2] });
    const decided = decideLeadSource([promo, step, landing], carried);
    expect(decided.label).toBe('Spring promo');
    expect(decided.matches.map((each) => each.position)).toEqual([1, 2, 3]);
    // A page of its own that carries nothing: its address is the one read.
    expect(readArrival({ pageUrl: `${PAGE}?promo=x` }).address).toBe(`${PAGE}?promo=x`);
    expect(readArrival({}).address).toBeUndefined();
  });

  it('are asked the same of a booking and a chat, which have a medium of their own', () => {
    const chat = rule(1, [{ fact: 'medium', op: 'is', value: 'chat' }], { source: 'Web chat' });
    expect(decideLeadSource([chat], facts('', undefined, 'chat')).label).toBe('Web chat');
    expect(decideLeadSource([chat], facts('', undefined, 'calendar')).label).toBe('Direct');
  });
});

describe('tracking link templates', () => {
  const BASE = 'https://www.harborlights.example/offer';

  it.each(trackingLinkTemplates.map((template) => [template.id, template] as const))(
    '%s: a link built from it is named as the template says',
    (_id, template) => {
      const link = sampleTrackingLink(template.id, BASE);
      expect(link).toBeDefined();
      const visit = readVisit({ pageUrl: link });
      const lead = leadSourceOfVisit(visit);
      expect(lead.key).toBe(template.leadSource);
      // An ad's link is a paid click on its own channel, with the ids that join reports.
      if (template.leadSource.endsWith('_ads')) {
        expect(lead.label).toBe(leadSourceLabels[template.leadSource as 'google_ads']);
        expect(sessionSourceOf('form', visit)).toBe(
          template.platform === 'google_ads' || template.platform === 'microsoft_ads'
            ? 'paid_search'
            : 'paid_social',
        );
        expect(visit.campaignId).not.toBeNull();
      }
      // Every parameter but the two that are for the advertiser's own analytics is read.
      const read = new Set(Object.values(PARAMETERS).flat());
      for (const parameter of template.parameters)
        if (!parameter.fills.startsWith('Not kept'))
          expect(read.has(parameter.name), `${template.id} ${parameter.name}`).toBe(true);
      // Every placeholder has a sample, so the example a screen shows is whole.
      for (const parameter of template.parameters)
        if (parameter.kind === 'placeholder')
          expect(template.sample[parameter.value], parameter.value).toBeDefined();
    },
  );

  it('names Instagram’s ads apart with Meta’s own {{site_source_name}}', () => {
    const named = (app: string) =>
      leadSourceOfVisit(
        readVisit({
          pageUrl: sampleTrackingLink('meta_ads_by_app', BASE, { '{{site_source_name}}': app }),
        }),
      ).key;
    expect(named('fb')).toBe('facebook_ads');
    expect(named('ig')).toBe('instagram_ads');
    for (const app of ['msg', 'th', 'an']) expect(named(app), app).toBe('paid_other');
  });

  it('has one default a platform, and Meta’s is facebook and paid_social', () => {
    for (const platform of trackingLinkPlatforms)
      expect(
        trackingLinkTemplates.filter((each) => each.platform === platform && each.default),
        platform,
      ).toHaveLength(1);
    const meta = buildTrackingLink({ templateId: 'meta_ads' });
    expect(meta).toMatchObject({ ok: true, kind: 'suffix' });
    expect(meta.ok && meta.text).toBe(
      'utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}',
    );
    const ghl = buildTrackingLink({ templateId: 'meta_ads_ghl' });
    expect(ghl.ok && ghl.text).toBe(
      'utm_source=fb_ad&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}',
    );
  });
});
