import {
  MAX_CONTACT_FILTER_CONDITIONS,
  MAX_CONTACT_FILTER_GROUPS,
  REPORT_LIMITS,
  reportDefinition,
  reportQuery,
  type ReportDefinition,
  type ReportFilter,
  type ReportWidgetQuery,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { catalogOf, pipelineTemplate } from '../../e2e/reporting-fixtures';
import {
  addCondition,
  addGroup,
  allowedSources,
  canAddCondition,
  canAddGroup,
  choiceOfRange,
  conditionCount,
  daysOfRange,
  defaultQuery,
  definitionIssues,
  filterFields,
  fitQuery,
  kindShape,
  newCondition,
  operandOf,
  placeIssues,
  queryOfWidget,
  rangeOfSearch,
  refusalOf,
  removeCondition,
  replaceRange,
  runnableOf,
  setCondition,
  setDateProperty,
  setGrain,
  setGroup,
  setMatch,
  sourceOf,
  toggleMeasure,
  usesAttribution,
  valuesOfText,
  withCustomDays,
  withOperator,
  withoutKeys,
  withRangeChoice,
  type CatalogSource,
  type ChartKind,
  type FilterField,
} from './query-rules';

const catalog = catalogOf();
const limits = catalog.limits;
function source(key: string): CatalogSource {
  const found = sourceOf(catalog, key);
  if (found === undefined) throw new Error(`no source ${key}`);
  return found;
}
function field(of: CatalogSource, key: string): FilterField {
  const found = filterFields(of).find((each) => each.key === key);
  if (found === undefined) throw new Error(`no field ${key}`);
  return found;
}
const contacts = source('contacts');
const opportunities = source('opportunities');
const appointments = source('appointments');
const attribution = source('attribution');
const dates = { range: { preset: 'last_30_days' as const }, compare: null };

describe('ranges', () => {
  it('reads the default range from an empty address, and a preset by its name', () => {
    expect(rangeOfSearch({})).toEqual({
      ok: true,
      input: { preset: 'last_30_days' },
      choice: 'last_30_days',
    });
    expect(rangeOfSearch({ range: 'this_quarter' })).toEqual({
      ok: true,
      input: { preset: 'this_quarter' },
      choice: 'this_quarter',
    });
  });

  it('reads a custom range of two days', () => {
    expect(rangeOfSearch({ range: 'custom', from: '2026-10-01', to: '2026-10-12' })).toEqual({
      ok: true,
      input: { from: '2026-10-01', to: '2026-10-12' },
      choice: 'custom',
    });
  });

  it('says why a custom range cannot be asked for', () => {
    expect(rangeOfSearch({ range: 'custom', from: '2026-10-01' })).toEqual({
      ok: false,
      reason: 'incomplete',
      choice: 'custom',
    });
    expect(rangeOfSearch({ range: 'custom', to: '2026-10-01' })).toMatchObject({
      reason: 'incomplete',
    });
    expect(rangeOfSearch({ range: 'custom', from: '2026-10-12', to: '2026-10-01' })).toMatchObject({
      ok: false,
      reason: 'order',
    });
    expect(rangeOfSearch({ range: 'custom', from: '2020-01-01', to: '2026-10-01' })).toMatchObject({
      ok: false,
      reason: 'too_long',
    });
  });

  it('takes the longest range the contract allows, and not a day more', () => {
    expect(REPORT_LIMITS.rangeDays).toBe(1096);
    // 1 January 2024 to 31 December 2026 is 1096 days, both included.
    expect(rangeOfSearch({ range: 'custom', from: '2024-01-01', to: '2026-12-31' }).ok).toBe(true);
    expect(rangeOfSearch({ range: 'custom', from: '2023-12-31', to: '2026-12-31' }).ok).toBe(false);
  });

  it('writes the address for a chosen range, leaving the default out', () => {
    expect(withRangeChoice('last_30_days', undefined)).toEqual({});
    expect(withRangeChoice('last_week', undefined)).toEqual({ range: 'last_week' });
    expect(withRangeChoice('custom', { from: '2026-09-13', to: '2026-10-12' })).toEqual({
      range: 'custom',
      from: '2026-09-13',
      to: '2026-10-12',
    });
    expect(withRangeChoice('custom', undefined)).toEqual({ range: 'custom' });
    expect(withCustomDays('2026-10-01', '')).toEqual({ range: 'custom', from: '2026-10-01' });
  });

  it('replaces the range of an address and keeps the rest', () => {
    expect(
      replaceRange(
        { range: 'custom', from: '2026-10-01', to: '2026-10-02', attribution: 'latest' },
        { range: 'today' },
      ),
    ).toEqual({ attribution: 'latest', range: 'today' });
    expect(replaceRange({ range: 'today', view: 'source' }, {})).toEqual({ view: 'source' });
  });

  it('names the range a report keeps, and the days its fields show', () => {
    expect(choiceOfRange({ preset: 'this_year' })).toBe('this_year');
    expect(choiceOfRange({ from: '2026-10-01', to: '2026-10-02' })).toBe('custom');
    expect(daysOfRange({ from: '2026-10-01', to: '2026-10-02' }, undefined)).toEqual({
      from: '2026-10-01',
      to: '2026-10-02',
    });
    expect(daysOfRange({ preset: 'today' }, { from: '2026-10-12', to: '2026-10-12' })).toEqual({
      from: '2026-10-12',
      to: '2026-10-12',
    });
    expect(daysOfRange({ preset: 'today' }, undefined)).toEqual({ from: '', to: '' });
  });

  it('drops keys without touching the object given', () => {
    const search = { range: 'today', by: 'created' } as const;
    expect(withoutKeys(search, 'by')).toEqual({ range: 'today' });
    expect(search).toEqual({ range: 'today', by: 'created' });
  });
});

describe('the catalogue', () => {
  it('finds a source by its key, and offers only the ones the role may read', () => {
    expect(sourceOf(catalog, 'contacts')?.label).toBe('Contacts');
    expect(sourceOf(catalog, 'ads')).toBeUndefined();
    expect(allowedSources(catalog).map((each) => each.key)).toEqual([
      'contacts',
      'opportunities',
      'appointments',
      'attribution',
    ]);
    const limited = {
      ...catalog,
      sources: catalog.sources.map((each) =>
        each.key === 'opportunities' ? { ...each, allowed: false } : each,
      ),
    };
    expect(allowedSources(limited).map((each) => each.key)).not.toContain('opportunities');
  });

  it('offers for conditions every dimension that takes an operator, then the numbers', () => {
    const fields = filterFields(appointments);
    // A weekday is grouped by, never filtered on.
    expect(fields.map((each) => each.key)).not.toContain('weekday');
    expect(fields.map((each) => each.key)).toContain('status');
    const value = field(opportunities, 'value');
    expect(value).toEqual({
      key: 'value',
      label: 'Value',
      kind: 'number',
      operators: ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
    });
  });

  it('offers each kind of dimension only its own operators', () => {
    expect(field(contacts, 'utmCampaign').operators).toEqual([
      'is',
      'is_not',
      'contains',
      'not_contains',
      'any_of',
      'none_of',
      'is_empty',
      'is_not_empty',
    ]);
    const choice = ['any_of', 'none_of', 'is_empty', 'is_not_empty'];
    expect(field(contacts, 'sessionSource')).toMatchObject({ kind: 'choice', operators: choice });
    expect(field(contacts, 'sessionSource').choices).toContain('paid_social');
    expect(field(contacts, 'tag')).toMatchObject({
      kind: 'reference',
      reference: 'tag',
      operators: choice,
    });
  });

  it('knows what each operator needs', () => {
    expect(operandOf('is')).toBe('value');
    expect(operandOf('any_of')).toBe('values');
    expect(operandOf('between')).toBe('range');
    expect(operandOf('is_empty')).toBe('none');
    expect(operandOf('in_last')).toBe('days');
    expect(operandOf('sounds_like')).toBe('none');
  });
});

describe('conditions', () => {
  const status = field(opportunities, 'status');
  const campaign = field(opportunities, 'utmCampaign');
  const value = field(opportunities, 'value');

  it('starts a condition with the field’s first operator and nothing given', () => {
    expect(newCondition(status)).toEqual({ field: 'status', operator: 'any_of', values: [] });
    expect(newCondition(campaign)).toEqual({ field: 'utmCampaign', operator: 'is', value: '' });
    expect(newCondition({ ...status, operators: ['sounds_like'] })).toEqual({
      field: 'status',
      operator: 'is_empty',
    });
  });

  it('keeps what a condition had where another operator takes it', () => {
    const typed = { field: 'utmCampaign', operator: 'is' as const, value: 'spring' };
    expect(withOperator(typed, 'contains')).toEqual({
      field: 'utmCampaign',
      operator: 'contains',
      value: 'spring',
    });
    expect(withOperator(typed, 'any_of')).toEqual({
      field: 'utmCampaign',
      operator: 'any_of',
      values: ['spring'],
    });
    expect(
      withOperator({ field: 'utmCampaign', operator: 'any_of', values: ['a', 'b'] }, 'is'),
    ).toEqual({ field: 'utmCampaign', operator: 'is', value: 'a' });
    expect(withOperator(typed, 'is_empty')).toEqual({ field: 'utmCampaign', operator: 'is_empty' });
    expect(withOperator({ field: 'value', operator: 'gt', value: '5' }, 'between')).toEqual({
      field: 'value',
      operator: 'between',
      from: '',
      to: '',
    });
    expect(
      withOperator({ field: 'value', operator: 'between', from: '1', to: '9' }, 'between'),
    ).toEqual({ field: 'value', operator: 'between', from: '1', to: '9' });
    expect(withOperator({ field: 'value', operator: 'is_empty' }, 'any_of')).toEqual({
      field: 'value',
      operator: 'any_of',
      values: [],
    });
    expect(withOperator({ field: 'value', operator: 'is_empty' }, 'in_last')).toEqual({
      field: 'value',
      operator: 'in_last',
      value: '',
    });
    // An operator this dashboard does not know changes nothing.
    expect(withOperator(typed, 'sounds_like')).toBe(typed);
  });

  it('splits typed values at commas, once each, up to the limit', () => {
    expect(valuesOfText(' spring , autumn,, spring ')).toEqual(['spring', 'autumn']);
    expect(valuesOfText('')).toEqual([]);
    expect(
      valuesOfText(Array.from({ length: 80 }, (_, index) => `v${String(index)}`).join(',')),
    ).toHaveLength(50);
  });

  it('adds a first group as alternatives whose conditions all hold', () => {
    const filters = addGroup(undefined, status);
    expect(filters).toEqual({
      match: 'any',
      groups: [{ match: 'all', conditions: [{ field: 'status', operator: 'any_of', values: [] }] }],
    });
    const two = addGroup(filters, value);
    expect(two.groups).toHaveLength(2);
    expect(two.match).toBe('any');
    expect(conditionCount(two)).toBe(2);
    expect(conditionCount(undefined)).toBe(0);
  });

  it('adds, changes and removes conditions; an empty group and an empty filter go', () => {
    let filters: ReportFilter | undefined = addGroup(undefined, status);
    filters = addCondition(filters, 0, campaign);
    expect(filters.groups[0]?.conditions.map((each) => each.field)).toEqual([
      'status',
      'utmCampaign',
    ]);
    filters = addGroup(filters, value);
    filters = setCondition(filters, 0, 1, { field: 'utmCampaign', operator: 'is', value: 'x' });
    expect(filters.groups[0]?.conditions[1]).toEqual({
      field: 'utmCampaign',
      operator: 'is',
      value: 'x',
    });
    // The other group is untouched by a change to the first.
    expect(filters.groups[1]?.conditions[0]?.field).toBe('value');
    expect(addCondition(filters, 1, status).groups[0]?.conditions).toHaveLength(2);
    filters = removeCondition(filters, 0, 0);
    expect(filters?.groups[0]?.conditions.map((each) => each.field)).toEqual(['utmCampaign']);
    filters = filters === undefined ? undefined : removeCondition(filters, 0, 0);
    expect(filters?.groups).toHaveLength(1);
    expect(filters?.groups[0]?.conditions[0]?.field).toBe('value');
    expect(filters === undefined ? 'gone' : removeCondition(filters, 0, 0)).toBeUndefined();
  });

  it('sets whether all or any must hold, for the groups or inside one', () => {
    const filters = addGroup(addGroup(undefined, status), value);
    expect(setMatch(filters, 'all').match).toBe('all');
    const inside = setMatch(filters, 'any', 1);
    expect(inside.match).toBe('any');
    expect(inside.groups.map((group) => group.match)).toEqual(['all', 'any']);
  });

  it('stops at the contract’s limits of conditions and groups', () => {
    let filters = addGroup(undefined, status);
    for (let index = 1; index < MAX_CONTACT_FILTER_GROUPS; index += 1)
      filters = addGroup(filters, status);
    expect(filters.groups).toHaveLength(MAX_CONTACT_FILTER_GROUPS);
    expect(canAddGroup(filters)).toBe(false);
    expect(addGroup(filters, status)).toBe(filters);
    expect(canAddCondition(filters)).toBe(true);
    for (let index = MAX_CONTACT_FILTER_GROUPS; index < MAX_CONTACT_FILTER_CONDITIONS; index += 1)
      filters = addCondition(filters, 0, status);
    expect(conditionCount(filters)).toBe(MAX_CONTACT_FILTER_CONDITIONS);
    expect(canAddCondition(filters)).toBe(false);
    expect(addCondition(filters, 0, status)).toBe(filters);
    expect(canAddGroup(undefined)).toBe(true);
    expect(canAddCondition(undefined)).toBe(true);
  });
});

describe('the shape each kind draws', () => {
  it('takes its limits from the catalogue', () => {
    expect(kindShape('stat', limits)).toEqual({ time: 'never', groups: [0, 0], measures: 4 });
    expect(kindShape('line', limits)).toEqual({ time: 'required', groups: [0, 1], measures: 4 });
    expect(kindShape('area', limits)).toEqual(kindShape('line', limits));
    expect(kindShape('bar', limits)).toEqual({ time: 'optional', groups: [0, 2], measures: 4 });
    expect(kindShape('hbar', limits)).toEqual(kindShape('bar', limits));
    expect(kindShape('donut', limits)).toEqual({ time: 'never', groups: [1, 1], measures: 1 });
    expect(kindShape('funnel', limits)).toEqual(kindShape('donut', limits));
    expect(kindShape('table', limits)).toEqual({ time: 'optional', groups: [0, 2], measures: 4 });
    const tight = { ...limits, measures: 2, groupBy: 1 };
    expect(kindShape('table', tight)).toEqual({ time: 'optional', groups: [0, 1], measures: 2 });
  });

  it('starts every kind on every source with a query the contract accepts', () => {
    const kinds: ChartKind[] = ['stat', 'line', 'area', 'bar', 'hbar', 'donut', 'table', 'funnel'];
    for (const each of catalog.sources)
      for (const kind of kinds) {
        const query = defaultQuery(kind, each, limits);
        const parsed = reportQuery.safeParse({ ...query, range: dates.range });
        expect(parsed.success, `${kind} on ${each.key}`).toBe(true);
      }
  });

  it('starts a chart as its kind draws it', () => {
    expect(defaultQuery('stat', contacts, limits)).toEqual({
      source: 'contacts',
      measures: ['count'],
      groupBy: [],
    });
    expect(defaultQuery('line', contacts, limits)).toEqual({
      source: 'contacts',
      measures: ['count'],
      groupBy: [],
      time: { grain: 'day' },
    });
    // The first dimension a row is in only once: not the tag, which a contact has several of.
    expect(defaultQuery('bar', contacts, limits).groupBy).toEqual(['createdSource']);
    expect(defaultQuery('table', opportunities, limits).groupBy).toEqual(['status']);
    expect(defaultQuery('donut', attribution, limits)).toEqual({
      source: 'attribution',
      measures: ['touches'],
      // The lead source leads the attribution dimensions.
      groupBy: ['leadSource'],
    });
    const bare = { ...contacts, measures: [], dimensions: [] };
    expect(defaultQuery('donut', bare, limits)).toEqual({
      source: 'contacts',
      measures: ['count'],
      groupBy: [],
    });
  });

  it('groups by a dimension a row is in several times only when there is no other', () => {
    const tagged = {
      ...contacts,
      dimensions: contacts.dimensions.filter((dimension) => dimension.multiple),
    };
    expect(defaultQuery('bar', tagged, limits).groupBy).toEqual(['tag']);
  });

  it('fits a query to another kind', () => {
    const wide: ReportWidgetQuery = {
      source: 'opportunities',
      measures: ['count', 'value'],
      groupBy: ['status', 'pipeline'],
      time: { property: 'closed', grain: 'week' },
      order: { by: 'value' },
    };
    expect(fitQuery('table', wide, opportunities, limits)).toEqual(wide);
    expect(fitQuery('stat', wide, opportunities, limits)).toEqual({
      source: 'opportunities',
      measures: ['count', 'value'],
      groupBy: [],
      time: { property: 'closed' },
      order: { by: 'value' },
    });
    // One measure, one group, no grain; the order named a measure that is gone.
    expect(fitQuery('donut', wide, opportunities, limits)).toEqual({
      source: 'opportunities',
      measures: ['count'],
      groupBy: ['status'],
      time: { property: 'closed' },
    });
    expect(fitQuery('line', wide, opportunities, limits).groupBy).toEqual(['status']);
    const plain: ReportWidgetQuery = { source: 'contacts', measures: ['count'], groupBy: [] };
    expect(fitQuery('line', plain, contacts, limits).time).toEqual({ grain: 'day' });
    expect(fitQuery('funnel', plain, contacts, limits).groupBy).toEqual(['createdSource']);
    expect(fitQuery('hbar', plain, contacts, limits).groupBy).toEqual(['createdSource']);
    const daily = { ...plain, time: { grain: 'day' as const } };
    // A bar chart over time needs no group; a number card has no grain, so no time at all.
    expect(fitQuery('bar', daily, contacts, limits)).toEqual(daily);
    expect(fitQuery('stat', daily, contacts, limits)).toEqual(plain);
    expect(fitQuery('donut', { ...plain, order: { by: 'group' } }, contacts, limits).order).toEqual(
      { by: 'group' },
    );
    const none = { ...contacts, dimensions: [] };
    expect(fitQuery('donut', plain, none, limits).groupBy).toEqual([]);
    expect(fitQuery('bar', plain, none, limits).groupBy).toEqual([]);
  });

  it('adds and takes away measures within the limit, and keeps the last one', () => {
    const query: ReportWidgetQuery = {
      source: 'opportunities',
      measures: ['count'],
      groupBy: [],
      order: { by: 'count' },
    };
    expect(toggleMeasure(query, 'count', 4)).toBe(query);
    const two = toggleMeasure(query, 'value', 4);
    expect(two.measures).toEqual(['count', 'value']);
    expect(toggleMeasure(two, 'averageValue', 2)).toBe(two);
    // The order named the measure taken away: it goes with it.
    expect(toggleMeasure(two, 'count', 4)).toEqual({
      source: 'opportunities',
      measures: ['value'],
      groupBy: [],
    });
  });

  it('groups by a dimension at a place, once each', () => {
    const query: ReportWidgetQuery = { source: 'contacts', measures: ['count'], groupBy: [] };
    const one = setGroup(query, 0, 'sessionSource');
    expect(one.groupBy).toEqual(['sessionSource']);
    const two = setGroup(one, 1, 'type');
    expect(two.groupBy).toEqual(['sessionSource', 'type']);
    expect(setGroup(two, 1, 'sessionSource').groupBy).toEqual(['sessionSource']);
    expect(setGroup(two, 0, undefined).groupBy).toEqual(['type']);
  });

  it('sets and clears the grain and the date a range is read by', () => {
    const query: ReportWidgetQuery = { source: 'opportunities', measures: ['count'], groupBy: [] };
    const weekly = setGrain(query, 'week');
    expect(weekly.time).toEqual({ grain: 'week' });
    expect(setGrain(weekly, undefined)).toEqual(query);
    const closed = setDateProperty(weekly, 'closed', opportunities);
    expect(closed.time).toEqual({ grain: 'week', property: 'closed' });
    expect(setGrain(closed, undefined).time).toEqual({ property: 'closed' });
    // The source's own default date is left out.
    expect(setDateProperty(closed, 'created', opportunities).time).toEqual({ grain: 'week' });
    expect(
      setDateProperty(setDateProperty(query, 'closed', opportunities), 'created', opportunities),
    ).toEqual(query);
  });

  it('knows when first or latest attribution matters', () => {
    const query: ReportWidgetQuery = { source: 'contacts', measures: ['count'], groupBy: [] };
    expect(usesAttribution(query, contacts)).toBe(false);
    expect(usesAttribution({ ...query, groupBy: ['type'] }, contacts)).toBe(false);
    expect(usesAttribution({ ...query, groupBy: ['sessionSource'] }, contacts)).toBe(true);
    expect(
      usesAttribution(
        {
          ...query,
          filters: addGroup(undefined, field(contacts, 'utmCampaign')),
        },
        contacts,
      ),
    ).toBe(true);
    expect(
      usesAttribution(
        { ...query, filters: addGroup(undefined, field(contacts, 'type')) },
        contacts,
      ),
    ).toBe(false);
    expect(
      usesAttribution({ source: 'attribution', measures: ['touches'], groupBy: [] }, attribution),
    ).toBe(true);
  });
});

describe('running a widget', () => {
  const query: ReportWidgetQuery = { source: 'contacts', measures: ['count'], groupBy: [] };

  it('sends the report’s range and comparison, or the widget’s own', () => {
    expect(queryOfWidget({ query }, dates)).toEqual({ ...query, range: dates.range });
    expect(queryOfWidget({ query }, { ...dates, compare: 'previous_year' })).toEqual({
      ...query,
      range: dates.range,
      compare: 'previous_year',
    });
    expect(
      queryOfWidget(
        { query, range: { preset: 'today' }, compare: null },
        { ...dates, compare: 'previous_year' },
      ),
    ).toEqual({ ...query, range: { preset: 'today' } });
    expect(queryOfWidget({ query, compare: 'previous_period' }, dates)).toMatchObject({
      compare: 'previous_period',
    });
  });

  it('checks the query against the contract before it is sent', () => {
    const fine = runnableOf({ query }, dates);
    expect(fine).toEqual({ ok: true, query: { ...query, range: dates.range } });
    const broken = runnableOf(
      {
        query: {
          ...query,
          measures: ['nothing'],
          filters: {
            match: 'all',
            groups: [
              {
                match: 'all',
                conditions: [
                  { field: 'utmCampaign', operator: 'is' },
                  { field: 'utmSource', operator: 'is' },
                ],
              },
            ],
          },
        },
      },
      dates,
    );
    // Each sentence once, however many conditions it is about.
    expect(broken).toEqual({
      ok: false,
      messages: ['Choose a measure of this source.', 'Give a value.'],
    });
    expect(runnableOf({}, dates).ok).toBe(false);
  });
});

describe('saving', () => {
  const definition: ReportDefinition = pipelineTemplate.definition;

  it('finds nothing wrong with the template', () => {
    expect(reportDefinition.safeParse(definition).success).toBe(true);
    expect(definitionIssues('Pipeline & Attribution Report', definition)).toEqual([]);
  });

  it('finds what the contract would refuse, with a pointer to it', () => {
    const [first, ...rest] = definition.pages;
    if (first === undefined) throw new Error('no page');
    const [open, ...others] = first.widgets;
    if (open === undefined) throw new Error('no widget');
    const broken: ReportDefinition = {
      ...definition,
      pages: [
        {
          name: '',
          widgets: [
            {
              ...open,
              query: { ...open.query, source: 'opportunities', measures: [], groupBy: [] },
            },
            ...others,
          ],
        },
        ...rest,
      ],
    };
    const issues = definitionIssues('  ', broken);
    expect(issues).toContainEqual({ path: '/name', message: 'Name the report.' });
    expect(issues).toContainEqual({ path: '/pages/0/name', message: 'Name the page.' });
    expect(issues).toContainEqual({
      path: '/pages/0/widgets/0/query/measures',
      message: 'Choose a measure.',
    });
    expect(definitionIssues('x'.repeat(121), definition)).toEqual([
      { path: '/name', message: 'Use at most 120 characters.' },
    ]);
  });

  it('puts each sentence of a refusal where it points', () => {
    const placed = placeIssues(definition, [
      { path: '/name', message: 'Name the report.' },
      { path: '/name', message: 'A second thing about the name.' },
      { path: '/definition/pages/0/widgets/1/query/measures/0', message: 'Choose a measure.' },
      { path: '/pages/0/widgets/1/query/measures/0', message: 'Choose a measure.' },
      { path: '/pages/0/widgets/1/title', message: 'Use one line of plain text.' },
      { path: '/pages/1/name', message: 'Name the page.' },
      { path: '/pages/1/widgets/99/id', message: 'A widget that is not there.' },
      { path: '/pages/7/name', message: 'A page that is not there.' },
      { path: '/pages/x', message: 'Not a page.' },
      { path: '/range/to', message: 'End the range on or after the day it starts.' },
      { path: '', message: 'The report as a whole.' },
    ]);
    expect(placed).toEqual({
      name: 'Name the report.',
      widgets: { won: ['Choose a measure.', 'Use one line of plain text.'] },
      pages: { 1: ['Name the page.', 'A widget that is not there.'] },
      form: [
        'A page that is not there.',
        'Not a page.',
        'End the range on or after the day it starts.',
        'The report as a whole.',
      ],
    });
  });
});

describe('refusals', () => {
  it('tells apart what a failed request was refused for', () => {
    expect(refusalOf(undefined)).toEqual({ kind: 'fault', messages: [] });
    expect(refusalOf({ status: 500, detail: 'It broke.' })).toEqual({
      kind: 'fault',
      messages: [],
    });
    expect(refusalOf({ status: 403, detail: 'It needs reports.view.' })).toEqual({
      kind: 'forbidden',
      messages: ['It needs reports.view.'],
    });
    expect(refusalOf({ status: 404 })).toEqual({ kind: 'not_found', messages: [] });
    expect(refusalOf({ status: 409, detail: 'Changed.' }).kind).toBe('conflict');
    expect(refusalOf({ status: 429 }).kind).toBe('rate_limited');
    expect(
      refusalOf({
        status: 422,
        errors: [{ code: 'rate_limited', message: 'Wait a minute.' }],
      }),
    ).toEqual({ kind: 'rate_limited', messages: ['Wait a minute.'] });
    expect(
      refusalOf({
        status: 422,
        detail: 'Invalid.',
        errors: [{ code: 'query_timeout', message: 'The query took too long.' }],
      }),
    ).toEqual({ kind: 'timeout', messages: ['The query took too long.'] });
    expect(
      refusalOf({
        status: 422,
        errors: [
          { code: 'unknown_reference', message: 'Choose a tag of this business.' },
          { message: 'And another thing.' },
        ],
      }),
    ).toEqual({
      kind: 'invalid',
      messages: ['Choose a tag of this business.', 'And another thing.'],
    });
    expect(refusalOf({ status: 400, errors: [] })).toEqual({ kind: 'invalid', messages: [] });
  });
});
