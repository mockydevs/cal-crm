// How a lead arrived, in the parts of the engine that need no database: a trigger's filters
// by lead source and session source (held together with why one did not pass, and the
// words for it), a touch as the values a condition reads, the source an opportunity step
// gives a deal, and the same in a test run.
import {
  attributionLeaves,
  attributionPath,
  automationDocument,
  automationTrigger,
  evaluateCondition,
  type AutomationDocumentInput,
  type ConditionValue,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { arrivalSource, createdDealSource } from './actions-deal-choice.js';
import {
  arrivalFromLatest,
  arrivalOf,
  hasArrival,
  touchValues,
  type TouchRow,
} from './attribution-values.js';
import { simulateAutomation } from './simulate.js';
import { explainEvaluation } from './trigger-evaluation-words.js';
import { ARRIVAL, eventPassesTrigger, triggerMismatch } from './triggers.js';

const trigger = (input: unknown) => automationTrigger.parse(input);

const googleAd: TouchRow = {
  touched_at: new Date('2026-10-13T09:00:00Z'),
  medium: 'form',
  session_source: 'paid_search',
  source_label: 'Google Ads',
  source_rule: 'google_ads',
  utm_source: 'google',
  utm_medium: 'cpc',
  utm_campaign: 'Spring sale',
  utm_content: 'banner',
  utm_term: 'wedding video',
  match_type: 'e',
  campaign_id: '111',
  ad_group_id: '222',
  ad_id: '333',
  referrer_domain: 'www.google.com',
  landing_url: 'https://example.test/offer',
  page_url: 'https://example.test/offer',
  has_google: true,
  has_meta: false,
  has_microsoft: false,
  has_tiktok: false,
  has_linkedin: false,
};

describe('a touch as the values a workflow reads', () => {
  it('gives every leaf under its prefix, and click ids only as yes or no', () => {
    const values = touchValues('trigger', googleAd);
    expect(Object.keys(values)).toEqual(
      attributionLeaves.map((leaf) => attributionPath('trigger', leaf.key)),
    );
    expect(values).toMatchObject({
      'trigger.attribution.source': 'Google Ads',
      'trigger.attribution.sourceKey': 'google_ads',
      'trigger.attribution.sessionSource': 'paid_search',
      'trigger.attribution.medium': 'form',
      'trigger.attribution.utmSource': 'google',
      'trigger.attribution.utmMedium': 'cpc',
      'trigger.attribution.utmCampaign': 'Spring sale',
      'trigger.attribution.utmContent': 'banner',
      'trigger.attribution.utmTerm': 'wedding video',
      'trigger.attribution.matchType': 'e',
      'trigger.attribution.campaignId': '111',
      'trigger.attribution.adGroupId': '222',
      'trigger.attribution.adId': '333',
      'trigger.attribution.referrerDomain': 'www.google.com',
      'trigger.attribution.landingPage': 'https://example.test/offer',
      'trigger.attribution.page': 'https://example.test/offer',
      'trigger.attribution.touchedAt': '2026-10-13T09:00:00.000Z',
      'trigger.attribution.hasGoogleClickId': true,
      'trigger.attribution.hasMetaClickId': false,
      'trigger.attribution.hasMicrosoftClickId': false,
      'trigger.attribution.hasTikTokClickId': false,
      'trigger.attribution.hasLinkedInClickId': false,
    });
    expect(touchValues('first', googleAd)['contact.attribution.first.source']).toBe('Google Ads');
    expect(touchValues('latest', googleAd)['contact.attribution.latest.adId']).toBe('333');
  });

  it('has every leaf, empty, without a touch: no click id is held by nothing', () => {
    const values = touchValues('latest', undefined);
    for (const leaf of attributionLeaves)
      expect(values[attributionPath('latest', leaf.key)], leaf.key).toBe(
        leaf.type === 'boolean' ? false : null,
      );
    const now = new Date('2026-10-13T10:00:00Z');
    const holds = (operator: 'is_empty' | 'is_set', leaf: 'source' | 'hasGoogleClickId') =>
      evaluateCondition({ field: attributionPath('latest', leaf), operator }, values, now);
    expect(holds('is_empty', 'source')).toBe(true);
    expect(holds('is_set', 'source')).toBe(false);
    expect(
      evaluateCondition(
        { field: attributionPath('latest', 'hasGoogleClickId'), operator: 'equals', value: false },
        values,
        now,
      ),
    ).toBe(true);
  });

  it('judges the comparisons each kind takes', () => {
    const values = touchValues('trigger', googleAd);
    const now = new Date('2026-10-13T10:00:00Z');
    const holds = (
      leaf: Parameters<typeof attributionPath>[1],
      operator: string,
      value?: unknown,
    ) =>
      evaluateCondition(
        { field: attributionPath('trigger', leaf), operator, value } as never,
        values,
        now,
      );
    expect(holds('source', 'equals', 'google ads')).toBe(true);
    expect(holds('source', 'not_equals', 'Facebook Ads')).toBe(true);
    expect(holds('utmCampaign', 'includes', 'spring')).toBe(true);
    expect(holds('utmCampaign', 'excludes', 'summer')).toBe(true);
    expect(holds('landingPage', 'starts_with', 'https://example.test/')).toBe(true);
    expect(holds('landingPage', 'starts_with', 'https://other.test/')).toBe(false);
    expect(holds('sessionSource', 'equals', 'paid_search')).toBe(true);
    expect(holds('sessionSource', 'equals', 'paid_social')).toBe(false);
    expect(holds('hasGoogleClickId', 'equals', true)).toBe(true);
    expect(holds('hasMetaClickId', 'equals', true)).toBe(false);
    expect(holds('touchedAt', 'within_last', 'P1D')).toBe(true);
    expect(holds('utmTerm', 'is_set')).toBe(true);
  });

  it('reads the latest touch as the arrival of a run no event started', () => {
    const held: Record<string, ConditionValue> = touchValues('latest', googleAd);
    const arrived = arrivalFromLatest(held);
    expect(arrived['trigger.attribution.source']).toBe('Google Ads');
    expect(arrived['trigger.attribution.hasGoogleClickId']).toBe(true);
    expect(Object.keys(arrived)).toHaveLength(attributionLeaves.length);
    // A sample contact has no touch at all.
    expect(arrivalFromLatest({})).toEqual(touchValues('trigger', undefined));
  });

  it('knows which events come with a touch of their own', () => {
    expect(hasArrival('form.submitted')).toBe(true);
    expect(hasArrival('appointment.booked')).toBe(true);
    expect(hasArrival('message.received')).toBe(false);
    expect(arrivalOf(googleAd)).toEqual({ source: 'Google Ads', sessionSource: 'paid_search' });
    expect(arrivalOf(undefined)).toEqual({ source: null, sessionSource: null });
  });
});

describe("a trigger's filters by how the lead arrived", () => {
  const google = { [ARRIVAL]: { source: 'Google Ads', sessionSource: 'paid_search' } };
  const facebook = { [ARRIVAL]: { source: 'Facebook Ads', sessionSource: 'paid_social' } };
  const anyForm = (config: Record<string, unknown>) =>
    trigger({ id: 'sent', type: 'form.submitted', config });

  it('start on any form when none is named', () => {
    expect(eventPassesTrigger(anyForm({}), 'form.submitted', { formId: 'whichever' })).toBe(true);
    expect(triggerMismatch(anyForm({}), 'form.submitted', {})).toBeUndefined();
  });

  it.each([
    [
      'one of the lead sources listed',
      { sources: ['Google Ads', 'Organic Search'] },
      google,
      undefined,
    ],
    ['whatever its capitals', { sources: ['  google ads '] }, google, undefined],
    [
      'no other lead source',
      { sources: ['Google Ads'] },
      facebook,
      { filter: 'sources', expected: ['Google Ads'], actual: 'Facebook Ads' },
    ],
    [
      'no event that recorded no touch',
      { sources: ['Google Ads'] },
      { [ARRIVAL]: { source: null, sessionSource: null } },
      { filter: 'sources', expected: ['Google Ads'], actual: null },
    ],
    [
      'no payload the touch was not read beside',
      { sources: ['Google Ads'] },
      {},
      { filter: 'sources', expected: ['Google Ads'], actual: null },
    ],
    [
      'no touch that is not one',
      { sessionSources: ['paid_search'] },
      { [ARRIVAL]: 'Google Ads' },
      { filter: 'sessionSources', expected: ['paid_search'], actual: null },
    ],
    ['one of the session sources listed', { sessionSources: ['paid_search'] }, google, undefined],
    [
      'no other session source',
      { sessionSources: ['paid_search', 'organic_search'] },
      facebook,
      {
        filter: 'sessionSources',
        expected: ['paid_search', 'organic_search'],
        actual: 'paid_social',
      },
    ],
    [
      'both, when both are set',
      { sources: ['Facebook Ads'], sessionSources: ['paid_social'] },
      facebook,
      undefined,
    ],
    [
      'the lead source first, when both fail',
      { sources: ['Google Ads'], sessionSources: ['paid_search'] },
      facebook,
      { filter: 'sources', expected: ['Google Ads'], actual: 'Facebook Ads' },
    ],
  ])('pass %s', (_name, config, payload, mismatch) => {
    for (const given of [
      anyForm(config),
      trigger({ id: 'booked', type: 'appointment.booked', config }),
    ]) {
      const eventType = given.type;
      // The two are held together: an event passes exactly when nothing mismatches.
      expect(triggerMismatch(given, eventType, payload)).toEqual(mismatch);
      expect(eventPassesTrigger(given, eventType, payload)).toBe(mismatch === undefined);
    }
  });

  it('still asks for the form named, before the lead source', () => {
    const form = '0192f3a0-1111-7222-8333-444455556666';
    const named = anyForm({ form, sources: ['Google Ads'] });
    expect(eventPassesTrigger(named, 'form.submitted', { ...google, formId: form })).toBe(true);
    expect(triggerMismatch(named, 'form.submitted', { ...google, formId: 'another' })).toEqual({
      filter: 'form',
      expected: form,
      actual: 'another',
    });
  });

  it.each([
    [
      { filter: 'sources', expected: ['Google Ads', 'Organic Search'], actual: 'Facebook Ads' },
      "The trigger starts only for a lead source of Google Ads, Organic Search, and this lead's source was Facebook Ads.",
    ],
    [
      { filter: 'sources', expected: ['Google Ads'], actual: null },
      'The trigger starts only for a lead source of Google Ads, and nothing was recorded of how this lead arrived.',
    ],
    [
      { filter: 'sessionSources', expected: ['paid_search'], actual: 'direct' },
      "The trigger starts only for a session source of paid_search, and this lead's was direct.",
    ],
  ])('says why one did not pass, in words: %j', (detail, words) => {
    expect(explainEvaluation('filter_mismatch', detail)).toBe(words);
  });
});

describe("an opportunity step's source", () => {
  it('is how the lead arrived for a step at version 2 that names none, and nothing before', () => {
    expect(createdDealSource(undefined, 2)).toEqual({ from: 'arrival' });
    expect(createdDealSource(undefined, 1)).toBeUndefined();
    expect(createdDealSource(undefined, undefined)).toBeUndefined();
    expect(createdDealSource(null, 2)).toBeNull();
    expect(createdDealSource('Website', 2)).toBe('Website');
    expect(createdDealSource({ from: 'arrival' }, 1)).toEqual({ from: 'arrival' });
  });

  it("is the lead source of the run's touch, else the contact's Source, else nothing", () => {
    const source = attributionPath('trigger', 'source');
    expect(arrivalSource({ [source]: 'Google Ads', 'contact.source': 'Enquiry form' })).toBe(
      'Google Ads',
    );
    expect(arrivalSource({ [source]: null, 'contact.source': ' Enquiry form ' })).toBe(
      'Enquiry form',
    );
    expect(arrivalSource({ [source]: '  ', 'contact.source': null })).toBeUndefined();
    expect(arrivalSource({})).toBeUndefined();
    expect(arrivalSource({ [source]: 'x'.repeat(300) })).toHaveLength(200);
  });
});

describe('a test run of the steps that give a deal its source', () => {
  const run = (
    steps: AutomationDocumentInput['steps'],
    values: Record<string, ConditionValue>,
    start = Object.keys(steps)[0] ?? '',
  ) =>
    simulateAutomation({
      document: automationDocument.parse({
        name: 'Leads',
        triggers: [{ id: 'sent', type: 'form.submitted', config: {} }],
        start,
        steps,
      }),
      values,
      events: [],
      start: new Date('2026-10-13T09:00:00Z'),
      timeZone: 'UTC',
      enrolmentId: 't',
      deals: { found: {}, names: {} },
    });
  const create = (config: Record<string, unknown>, typeVersion?: number) => ({
    open: {
      type: 'deal.create' as const,
      config: { pipeline: 'pip_sales', stage: 'stg_new', ...config },
      ...(typeVersion === undefined ? {} : { typeVersion }),
      next: 'say',
    },
    say: { type: 'note.create' as const, config: { text: 'From {{deal.source}}' } },
  });
  const arrived = {
    'contact.name': 'Ada Lovelace',
    'contact.source': 'Enquiry form',
    ...touchValues('trigger', googleAd),
  };

  it('takes the arrival by default at version 2, and says so', () => {
    const trace = run(create({}, 2), arrived);
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps[0]?.explanation).toBe(
      'Would create deal with the source "Google Ads"; nothing is sent or changed in a test run. The run would have it in hand: the deal steps after it act on it.',
    );
  });

  it("falls back to the contact's Source, and to no source at all", () => {
    const direct = { ...arrived, ...touchValues('trigger', undefined) };
    expect(run(create({ source: { from: 'arrival' } }), direct).steps[0]?.explanation).toContain(
      'with the source "Enquiry form"',
    );
    const unknown = run(create({ source: { from: 'arrival' } }), {
      ...direct,
      'contact.source': null,
    });
    expect(unknown.steps[0]?.explanation).toMatch(/^Would create deal; nothing/);
    // The note's merge field has nothing to fill in, as in a real run.
    expect(unknown.outcome).toMatchObject({ kind: 'failed' });
  });

  it('gives none to a step from before the setting, and none when told so', () => {
    for (const steps of [create({}), create({}, 1), create({ source: null }, 2)])
      expect(run(steps, arrived).steps[0]?.explanation).toMatch(/^Would create deal; nothing/);
  });

  it('fills merge fields into a source that is written', () => {
    const trace = run(
      create({ source: '{{trigger.attribution.utmCampaign}} ({{trigger.attribution.source}})' }, 2),
      arrived,
    );
    expect(trace.steps[0]?.explanation).toContain('with the source "Spring sale (Google Ads)"');
  });

  it('sets, clears or leaves the source on an update', () => {
    const update = (source: unknown, values: Record<string, ConditionValue> = arrived) =>
      run(
        {
          open: {
            type: 'deal.create',
            config: { pipeline: 'pip_sales', stage: 'stg_new', source: 'Imported' },
            next: 'fix',
          },
          fix: { type: 'deal.update', config: { source } as never, next: 'check' },
          check: {
            type: 'condition',
            config: { if: { field: 'deal.source', operator: 'is_set' } },
            next: { yes: 'say' },
          },
          say: { type: 'note.create', config: { text: 'From {{deal.source}}' } },
        },
        values,
      );
    const said = (trace: ReturnType<typeof update>) =>
      trace.steps.find((step) => step.step === 'fix')?.explanation;
    expect(said(update({ from: 'arrival' }))).toBe(
      'Would update "Ada Lovelace", the deal the run has in hand: source. Nothing is changed in a test run.',
    );
    expect(update(null).steps.find((step) => step.step === 'check')?.branch).toBe('no');
    // Nothing known of the arrival: the source the deal had is left as it was.
    const nothing = update(
      { from: 'arrival' },
      { ...arrived, ...touchValues('trigger', undefined), 'contact.source': null },
    );
    expect(said(nothing)).toContain('nothing it names would differ');
    expect(nothing.steps.find((step) => step.step === 'check')?.branch).toBe('yes');
  });
});
