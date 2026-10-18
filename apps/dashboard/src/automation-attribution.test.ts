// Where a lead came from, in the builder's rules: the fields listed under their three
// headings, the comparisons each kind takes, how a card says a condition, a trigger's
// filters and an opportunity's source, and the built-in lead sources a value is chosen
// from. Every path offered is one the validator accepts.
import { i18n } from '@lingui/core';
import {
  attributionLeaves,
  attributionPaths,
  leadSources,
  validateAutomation,
} from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { harborSetup } from '../e2e/automation-fixtures';
import { attributionFields } from './automation-attribution';
import {
  arrivalFilterWords,
  attributionValueWords,
  attributionWords,
  choiceName,
  createdSourceWords,
  dealSourceMode,
  isAttributionText,
} from './automation-attribution-words';
import { fieldsOf, settingWords, shownFields } from './automation-fields';
import {
  conditionOf,
  fieldAt,
  filterFields,
  operatorName,
  operatorsFor,
  valueKind,
  withField,
  emptyRow,
} from './automation-filters';
import {
  customSources,
  leadSourceNames,
  sourcesOf,
  suggestionsFor,
  toggledSource,
} from './automation-lead-sources';
import { grouped, sourceFields, tokenOf, writeRowOf } from './automation-record-rules';
import {
  conditionWords,
  fieldWords,
  holdsText,
  listed,
  stepSummary,
  triggerSummary,
} from './automation-summary';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const or = (parts: readonly string[]): string => listed(parts, 'disjunction');

describe('the attribution fields a person chooses from', () => {
  it('lists every leaf under each of the three headings, in the contract order', () => {
    const fields = attributionFields();
    expect(fields.map((field) => field.path).toSorted()).toEqual(attributionPaths.toSorted());
    // The arrival first: typing "Lead source" in a list lands on it.
    expect([...new Set(fields.map((field) => field.heading))]).toEqual([
      "This lead's arrival",
      'Attribution (first)',
      'Attribution (latest)',
    ]);
    expect(fields.filter((field) => field.scope === 'trigger').map((field) => field.label)).toEqual(
      [
        'Lead source',
        'Lead source rule',
        'Session source',
        'Medium',
        'UTM source',
        'UTM medium',
        'UTM campaign',
        'UTM content',
        'UTM term',
        'Match type',
        'Campaign ID',
        'Ad group ID',
        'Ad ID',
        'Referrer domain',
        'Landing page',
        'Page of the form or booking',
        'Date',
        'Has a Google click ID',
        'Has a Meta click ID',
        'Has a Microsoft click ID',
        'Has a TikTok click ID',
        'Has a LinkedIn click ID',
      ],
    );
    // No click id is offered as a value, under any heading.
    expect(
      fields.some((field) => /clid|ClickId$/.test(field.path) && field.type !== 'boolean'),
    ).toBe(false);
  });

  it('names a session source and a medium as the lists call them', () => {
    const session = attributionFields().find(
      (field) => field.path === 'trigger.attribution.sessionSource',
    );
    expect(session?.options.slice(0, 3)).toEqual([
      { key: 'paid_search', label: 'Paid Search' },
      { key: 'paid_social', label: 'Paid Social' },
      { key: 'social_media', label: 'Social Media' },
    ]);
    expect(choiceName('calendar')).toBe('Calendar');
    expect(choiceName('something_new')).toBe('something_new');
    expect(choiceName('constructor')).toBe('constructor');
  });

  it('adds them to the fields a condition compares, after the opportunity, with headings', () => {
    const fields = filterFields(harborSetup);
    const attribution = fields.filter((field) => field.group === 'attribution');
    expect(attribution.map((field) => field.path).toSorted()).toEqual(attributionPaths.toSorted());
    expect(attribution[0]?.heading).toBe("This lead's arrival");
    expect(fields.at(-1)?.heading).toBe('Attribution (latest)');
    // A closed list shows only the name of what is chosen: the touch is part of it.
    expect(fieldAt(fields, 'contact.attribution.first.utmCampaign', harborSetup)?.label).toBe(
      'UTM campaign (first)',
    );
    expect(fieldAt(fields, 'contact.attribution.latest.source', harborSetup)?.label).toBe(
      'Lead source (latest)',
    );
    expect(new Set(fields.map((field) => field.label)).size).toBe(fields.length);
    expect(fieldAt(fields, 'trigger.attribution.nothing', harborSetup)).toBeUndefined();
  });

  it('offers each kind its comparisons, and the value its control', () => {
    const fields = filterFields(harborSetup);
    const at = (path: string) => {
      const field = fieldAt(fields, path, harborSetup);
      if (field === undefined) throw new Error(`No field ${path}.`);
      return field;
    };
    const source = at('trigger.attribution.source');
    expect(operatorsFor(source.type)).toEqual([
      'equals',
      'not_equals',
      'includes',
      'excludes',
      'starts_with',
      'is_set',
      'is_empty',
    ]);
    expect(operatorName('starts_with', source.type)).toBe('Starts with');
    expect(valueKind(source, 'equals')).toBe('text');
    expect(valueKind(source, 'is_empty')).toBe('none');
    const session = at('contact.attribution.latest.sessionSource');
    expect(operatorsFor(session.type)).toEqual(['equals', 'not_equals', 'is_set', 'is_empty']);
    expect(valueKind(session, 'equals')).toBe('choice');
    const clicked = at('contact.attribution.first.hasGoogleClickId');
    expect(operatorsFor(clicked.type)).toEqual(['equals', 'is_set', 'is_empty']);
    expect(valueKind(clicked, 'equals')).toBe('yes_no');
    expect(valueKind(at('trigger.attribution.touchedAt'), 'within_last')).toBe('duration');
    expect(withField(emptyRow, source)).toEqual({
      field: 'trigger.attribution.source',
      operator: 'equals',
      value: undefined,
    });
  });

  it('offers only paths and comparisons the validator accepts', () => {
    for (const field of filterFields(harborSetup).filter((each) => each.group === 'attribution'))
      for (const operator of operatorsFor(field.type)) {
        const kind = valueKind(field, operator);
        const value =
          kind === 'yes_no'
            ? true
            : kind === 'choice'
              ? field.options[0]?.key
              : kind === 'duration'
                ? 'P7D'
                : kind === 'date'
                  ? '2026-10-01'
                  : 'Google Ads';
        const result = validateAutomation(
          {
            name: 'Leads',
            triggers: [{ id: 'sent', type: 'form.submitted', config: {} }],
            start: 'check',
            steps: {
              check: {
                type: 'condition',
                config: { if: conditionOf([{ field: field.path, operator, value }]) },
              },
            },
          },
          harborSetup,
        );
        expect([field.path, operator, result.errors]).toEqual([field.path, operator, []]);
      }
  });

  it('adds them to the fields a message inserts, each a merge field the validator accepts', () => {
    const groups = grouped(sourceFields(harborSetup, true));
    expect(groups.map((group) => group.label)).toEqual(
      expect.arrayContaining([
        'Attribution (first)',
        'Attribution (latest)',
        "This lead's arrival",
      ]),
    );
    const arrival = groups.find((group) => group.group === 'arrival');
    expect(arrival?.fields).toHaveLength(attributionLeaves.length);
    const text = sourceFields(harborSetup)
      .filter((field) => field.group === 'arrival' || field.group === 'first')
      .map((field) => tokenOf(field.path))
      .join(' ');
    const result = validateAutomation(
      {
        name: 'Leads',
        triggers: [{ id: 'sent', type: 'form.submitted', config: {} }],
        start: 'say',
        steps: { say: { type: 'note.create', config: { text } } },
      },
      harborSetup,
    );
    expect(result.errors).toEqual([]);
    // One attribution merge field alone is a copy from that field, as any other is.
    expect(writeRowOf('contact.custom.x', '{{trigger.attribution.utmSource}}').written).toEqual({
      mode: 'copy',
      from: 'trigger.attribution.utmSource',
    });
  });
});

describe('how a card says where a lead came from', () => {
  it('says a path in a sentence: the arrival plainly, the other two by which touch', () => {
    expect(attributionWords('trigger.attribution.source')).toBe('lead source');
    expect(attributionWords('contact.attribution.first.source')).toBe('first lead source');
    expect(attributionWords('contact.attribution.latest.utmCampaign')).toBe('latest UTM campaign');
    expect(attributionWords('trigger.attribution.adGroupId')).toBe('ad group ID');
    expect(attributionWords('trigger.attribution.hasGoogleClickId')).toBe('has a Google click ID');
    expect(attributionWords('contact.firstName')).toBeUndefined();
    expect(attributionWords('trigger.attribution.nothing')).toBeUndefined();
    expect(fieldWords('trigger.attribution.sessionSource')).toBe('session source');
    expect(fieldWords('contact.attribution.first.landingPage')).toBe('first landing page');
  });

  it('reads a condition on it as a sentence', () => {
    const says = (field: string, operator: string, value?: unknown) =>
      conditionWords(
        { field, operator, ...(value === undefined ? {} : { value }) },
        false,
        harborSetup,
      );
    expect(says('trigger.attribution.source', 'equals', 'Google Ads')).toBe(
      'lead source is “Google Ads”',
    );
    expect(says('contact.attribution.first.sessionSource', 'equals', 'paid_search')).toBe(
      'first session source is Paid Search',
    );
    expect(says('trigger.attribution.medium', 'not_equals', 'calendar')).toBe(
      'medium is not Calendar',
    );
    expect(says('trigger.attribution.utmCampaign', 'includes', 'spring')).toBe(
      'UTM campaign contains “spring”',
    );
    expect(says('trigger.attribution.landingPage', 'starts_with', 'https://x.test/promo')).toBe(
      'landing page starts with “https://x.test/promo”',
    );
    expect(says('contact.attribution.latest.hasMetaClickId', 'equals', true)).toBe(
      'latest has a Meta click ID is yes',
    );
    expect(says('trigger.attribution.utmTerm', 'is_empty')).toBe('UTM term is empty');
    expect(holdsText('trigger.attribution.utmCampaign')).toBe(true);
    expect(holdsText('trigger.attribution.sessionSource')).toBe(false);
    expect(isAttributionText(undefined)).toBe(false);
    expect(attributionValueWords('trigger.attribution.source', 'Google Ads')).toBeUndefined();
    expect(attributionValueWords('contact.email', 'paid_search')).toBeUndefined();
    expect(attributionValueWords(7, 'paid_search')).toBeUndefined();
    expect(attributionValueWords('trigger.attribution.sessionSource', 3)).toBeUndefined();
  });

  it('says the lead sources and session sources a trigger starts for', () => {
    expect(arrivalFilterWords({}, or)).toBeUndefined();
    expect(arrivalFilterWords({ sources: [], sessionSources: 'paid' }, or)).toBeUndefined();
    expect(arrivalFilterWords({ sources: ['Google Ads', 'Facebook Ads', 7] }, or)).toBe(
      'from Google Ads or Facebook Ads',
    );
    expect(arrivalFilterWords({ sessionSources: ['paid_search', 'organic_search'] }, or)).toBe(
      'through Paid Search or Organic Search',
    );
    expect(
      arrivalFilterWords({ sources: ['Google Ads'], sessionSources: ['paid_search'] }, or),
    ).toBe('from Google Ads, through Paid Search');
    expect(
      triggerSummary({ type: 'form.submitted', config: { sources: ['Google Ads'] } }, harborSetup),
    ).toBe('Someone submits a form, from Google Ads');
    expect(
      triggerSummary(
        { type: 'form.submitted', config: { form: 'frm_quote', sessionSources: ['paid_social'] } },
        harborSetup,
      ),
    ).toBe('Someone submits “Request a quote”, through Paid Social');
    expect(
      triggerSummary(
        { type: 'appointment.booked', config: { sources: ['Google Ads', 'Organic Search'] } },
        harborSetup,
      ),
    ).toBe('Someone books an appointment, from Google Ads or Organic Search');
  });

  it("says where an opportunity's source comes from", () => {
    expect(dealSourceMode(undefined)).toBe('unset');
    expect(dealSourceMode(null)).toBe('none');
    expect(dealSourceMode('Website')).toBe('text');
    expect(dealSourceMode({ from: 'arrival' })).toBe('arrival');
    expect(dealSourceMode({ from: 'arrival', more: 1 })).toBe('other');
    expect(dealSourceMode({ from: 'elsewhere' })).toBe('other');
    expect(dealSourceMode(7)).toBe('other');
    expect(createdSourceWords(undefined)).toBe('Source: from how they arrived');
    expect(createdSourceWords({ from: 'arrival' })).toBe('Source: from how they arrived');
    expect(createdSourceWords(null)).toBe('No source');
    expect(createdSourceWords('{{contact.source}}')).toBe('Source: {{contact.source}}');
    expect(createdSourceWords(7)).toBeUndefined();
    const create = (source?: unknown) =>
      stepSummary(
        {
          type: 'deal.create',
          config: {
            pipeline: 'pip_sales',
            stage: 'stg_new',
            ...(source === undefined ? {} : { source }),
          },
        },
        harborSetup,
      );
    expect(create()).toBe(
      'Create an opportunity in Sales, at New lead. Source: from how they arrived',
    );
    expect(create(null)).toBe('Create an opportunity in Sales, at New lead. No source');
    expect(create('Referral')).toBe(
      'Create an opportunity in Sales, at New lead. Source: Referral',
    );
    expect(create(7)).toBe('Create an opportunity in Sales, at New lead');
  });

  it("has the two filters on the triggers that come with a touch, and the source on a new opportunity's panel", () => {
    for (const type of ['form.submitted', 'appointment.booked'])
      expect(shownFields('trigger', type, {}).map((field) => field.key)).toEqual(
        expect.arrayContaining(['sources', 'sessionSources']),
      );
    const form = fieldsOf('trigger', 'form.submitted') ?? [];
    expect(form.find((field) => field.key === 'form')?.required).toBe(false);
    const sources = form.find((field) => field.key === 'sources');
    const sessions = form.find((field) => field.key === 'sessionSources');
    const source = (fieldsOf('step', 'deal.create') ?? []).find((field) => field.key === 'source');
    if (sources === undefined || sessions === undefined || source === undefined)
      throw new Error('A setting is missing.');
    expect(settingWords(sources, ['Google Ads', 'Facebook Ads'], harborSetup)).toBe(
      'Google Ads or Facebook Ads',
    );
    expect(settingWords(sources, 'Google Ads', harborSetup)).toBe('“Google Ads”');
    expect(settingWords(sessions, ['paid_search'], harborSetup)).toBe('Paid Search');
    expect(settingWords(source, { from: 'arrival' }, harborSetup)).toBe(
      'Source: from how they arrived',
    );
    expect(settingWords(source, 7, harborSetup)).toBe('7');
  });
});

describe('the built-in lead sources', () => {
  it('are offered while a lead source is typed, and their keys for the rule', () => {
    expect(leadSourceNames).toEqual(leadSources.map((each) => each.label));
    expect(suggestionsFor('trigger.attribution.source')).toEqual(leadSourceNames);
    expect(suggestionsFor('contact.attribution.first.sourceKey')).toContain('google_ads');
    expect(suggestionsFor('trigger.attribution.utmSource')).toBeUndefined();
    expect(suggestionsFor('contact.email')).toBeUndefined();
  });

  it("reads a trigger's list, keeps the business's own names, and ticks one on or off", () => {
    expect(sourcesOf(undefined)).toEqual([]);
    expect(sourcesOf(['Google Ads', ' google ads ', '', 7, 'Spring flyer'])).toEqual([
      'Google Ads',
      'Spring flyer',
    ]);
    expect(customSources(['google ads', 'Spring flyer'])).toEqual(['Spring flyer']);
    expect(toggledSource([], 'Google Ads', true)).toEqual(['Google Ads']);
    expect(toggledSource(['Google Ads'], 'google ads', true)).toEqual(['Google Ads']);
    expect(toggledSource(['Google Ads', 'Facebook Ads'], 'google ads', false)).toEqual([
      'Facebook Ads',
    ]);
    expect(toggledSource(['Google Ads'], 'Google Ads', false)).toBeUndefined();
  });
});
