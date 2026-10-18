// Reporting stage 1: what a report may ask, checked with no database; what a saved report
// is made of; and who may read and manage one.
import { describe, expect, it } from 'vitest';

import {
  appointmentOverviewQuery,
  attributionMediums,
  attributionReportQuery,
  BLANK_REPORT_DEFINITION,
  builtInPermissions,
  contactFilterKinds,
  createReportInput,
  endpoints,
  permissionCatalog,
  ATTRIBUTION_LIMITS,
  ATTRIBUTION_PARAMETERS,
  publicBookingInput,
  publicFormSubmissionInput,
  publicArrival,
  publicVisit,
  REPORT_LIMITS,
  reportDefinition,
  reportFilterOperators,
  reportingEndpoints,
  reportPresets,
  reportQuery,
  reportRangeInput,
  reportSource,
  reportSourceKeys,
  reportSources,
  reportWeekdays,
  reportWidget,
  reportWidgetQuery,
  sessionSources,
  type ReportSourceSpec,
} from './index.js';

interface Parsed {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}
const paths = (result: Parsed) =>
  result.error?.issues.map((issue) => issue.path.map(String).join('/')) ?? [];
const range = { preset: 'last_30_days' };
const query = (extra: Record<string, unknown> = {}) => ({
  source: 'opportunities',
  measures: ['count'],
  range,
  ...extra,
});
const condition = (each: Record<string, unknown>) => ({
  filters: { match: 'all', groups: [{ match: 'all', conditions: [each] }] },
});
const at = 'filters/groups/0/conditions/0';

describe('a range', () => {
  it('is a preset or two days, both included', () => {
    for (const preset of reportPresets)
      expect(reportRangeInput.safeParse({ preset }).success).toBe(true);
    expect(reportRangeInput.parse({ from: '2026-09-01', to: '2026-09-01' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-01',
    });
    for (const refused of [
      {},
      { preset: 'forever' },
      { from: '2026-09-01' },
      { preset: 'today', from: '2026-09-01', to: '2026-09-02' },
      { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
    ])
      expect(reportRangeInput.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
  });

  it('does not end before it starts, and is no longer than three years', () => {
    expect(paths(reportRangeInput.safeParse({ from: '2026-09-02', to: '2026-09-01' }))).toEqual([
      'to',
    ]);
    expect(REPORT_LIMITS.rangeDays).toBe(1096);
    // 1 January 2024 to 31 December 2026 is 1096 days; one more is too many.
    expect(reportRangeInput.safeParse({ from: '2024-01-01', to: '2026-12-31' }).success).toBe(true);
    expect(paths(reportRangeInput.safeParse({ from: '2023-12-31', to: '2026-12-31' }))).toEqual([
      'to',
    ]);
  });
});

describe('a query', () => {
  it('names a source, its measures and its dimensions, and nothing the catalogue lacks', () => {
    const parsed = reportQuery.parse(
      query({
        measures: ['count', 'value', 'averageValue'],
        groupBy: ['stage', 'sessionSource'],
        time: { property: 'closed', grain: 'week' },
        attribution: 'latest',
        compare: 'previous_year',
        order: { by: 'value', direction: 'asc' },
        limit: 10,
      }),
    );
    expect(parsed.groupBy).toEqual(['stage', 'sessionSource']);
    expect(reportQuery.parse(query()).groupBy).toEqual([]);
    expect(reportQuery.parse(query({ order: { by: 'group' } })).order).toEqual({ by: 'group' });

    expect(paths(reportQuery.safeParse(query({ source: 'payments' })))).toEqual(['source']);
    expect(
      paths(reportQuery.safeParse(query({ measures: ['revenue', 'count', 'count'] }))),
    ).toEqual(['measures/0', 'measures/2']);
    expect(
      paths(reportQuery.safeParse(query({ groupBy: ['calendar', 'stage', 'stage'] }))),
    ).toEqual(['groupBy', 'groupBy/0', 'groupBy/2']);
    expect(paths(reportQuery.safeParse(query({ groupBy: ['calendar', 'calendar'] })))).toEqual([
      'groupBy/0',
      'groupBy/1',
    ]);
    expect(paths(reportQuery.safeParse(query({ groupBy: ['stage', 'stage'] })))).toEqual([
      'groupBy/1',
    ]);
    expect(paths(reportQuery.safeParse(query({ time: { property: 'starts' } })))).toEqual([
      'time/property',
    ]);
    expect(paths(reportQuery.safeParse(query({ attribution: 'all' })))).toEqual(['attribution']);
    expect(paths(reportQuery.safeParse(query({ order: { by: 'value' } })))).toEqual(['order/by']);
    expect(paths(reportQuery.safeParse(query({ limit: 501 })))).toEqual(['limit']);
    expect(paths(reportQuery.safeParse(query({ measures: [] })))).toEqual(['measures']);
    expect(
      paths(
        reportQuery.safeParse(query({ measures: ['count', 'value', 'averageValue', 'a', 'b'] })),
      ),
    ).toEqual(['measures', 'measures/3', 'measures/4']);
    // Nothing else is taken: no text of a statement, no table, no column.
    expect(reportQuery.safeParse(query({ sql: 'select 1' })).success).toBe(false);
    expect(reportQuery.safeParse(query({ time: { grain: 'hour' } })).success).toBe(false);
  });

  it('counts every touch only for the attribution source', () => {
    const touches = { source: 'attribution', measures: ['touches', 'contacts'], range };
    expect(reportQuery.safeParse({ ...touches, attribution: 'all' }).success).toBe(true);
    expect(reportQuery.safeParse({ ...touches, attribution: 'first' }).success).toBe(true);
    expect(paths(reportQuery.safeParse({ ...touches, groupBy: ['status'] }))).toEqual([
      'groupBy/0',
    ]);
  });

  it('takes conditions on the source’s own fields, with the operators of each kind', () => {
    const accepted = [
      { field: 'source', operator: 'contains', value: 'fair' },
      { field: 'utmCampaign', operator: 'any_of', values: ['spring'] },
      { field: 'status', operator: 'any_of', values: ['won', 'lost'] },
      { field: 'sessionSource', operator: 'none_of', values: ['direct'] },
      { field: 'pipeline', operator: 'any_of', values: ['pipe_x'] },
      { field: 'owner', operator: 'is_empty' },
      { field: 'value', operator: 'between', from: '100', to: '500' },
      { field: 'value', operator: 'gte', value: '100' },
    ];
    for (const each of accepted)
      expect(reportQuery.safeParse(query(condition(each))).success, JSON.stringify(each)).toBe(
        true,
      );

    const refused: [Record<string, unknown>, string][] = [
      [{ field: 'nothing', operator: 'is', value: 'x' }, `${at}/field`],
      [{ field: 'calendar', operator: 'any_of', values: ['cal_x'] }, `${at}/field`],
      [{ field: 'status', operator: 'contains', value: 'w' }, `${at}/operator`],
      [{ field: 'value', operator: 'contains', value: '1' }, `${at}/operator`],
      [{ field: 'source', operator: 'gt', value: '1' }, `${at}/operator`],
      [{ field: 'source', operator: 'is' }, `${at}/value`],
      [{ field: 'status', operator: 'any_of' }, `${at}/values`],
      [{ field: 'value', operator: 'between', from: '1' }, `${at}/to`],
      [{ field: 'value', operator: 'between', to: '1' }, `${at}/from`],
      [{ field: 'source', operator: 'is_empty', value: 'x' }, `${at}/value`],
      [{ field: 'source', operator: 'is', value: 'x', values: ['y'] }, `${at}/values`],
      [{ field: 'source', operator: 'is', value: 'x', from: '1' }, `${at}/from`],
      [{ field: 'status', operator: 'any_of', values: ['won', 'abandoned'] }, `${at}/values/1`],
    ];
    for (const [each, path] of refused)
      expect(paths(reportQuery.safeParse(query(condition(each)))), JSON.stringify(each)).toEqual([
        path,
      ]);
  });

  it('never filters on the day of the week, and holds a filter to twenty conditions', () => {
    const weekday = { source: 'appointments', measures: ['count'], range, groupBy: ['weekday'] };
    expect(reportQuery.safeParse(weekday).success).toBe(true);
    expect(
      paths(
        reportQuery.safeParse({
          ...weekday,
          ...condition({ field: 'weekday', operator: 'any_of', values: ['1'] }),
        }),
      ),
    ).toEqual([`${at}/operator`]);
    const eleven = Array.from({ length: 11 }, () => ({
      field: 'source',
      operator: 'is_not_empty',
    }));
    const groups = [
      { match: 'all', conditions: eleven },
      { match: 'any', conditions: eleven },
    ];
    expect(paths(reportQuery.safeParse(query({ filters: { match: 'any', groups } })))).toEqual([
      'filters/groups',
    ]);
  });

  it('gives each kind of field the operators of the contact filters', () => {
    expect(reportFilterOperators('text')).toBe(contactFilterKinds.text);
    expect(reportFilterOperators('number')).toBe(contactFilterKinds.number);
    expect(reportFilterOperators('choice')).toBe(contactFilterKinds.choice);
    expect(reportFilterOperators('reference')).toBe(contactFilterKinds.choice);
    expect(reportFilterOperators('weekday')).toEqual([]);
  });
});

describe('the catalogue', () => {
  it.each(reportSourceKeys)('is whole for %s', (key) => {
    const spec: ReportSourceSpec = reportSources[key];
    expect(reportSource(key)).toBe(spec);
    expect(Object.keys(spec.measures).length).toBeGreaterThan(0);
    expect(spec.dateProperties).toHaveProperty(spec.defaultDate);
    expect(spec.attribution.length).toBeGreaterThan(0);
    for (const field of spec.numberFilters) expect(spec.dimensions).not.toHaveProperty(field);
    for (const dimension of Object.values(spec.dimensions)) {
      expect(dimension.label).not.toBe('');
      if (dimension.kind === 'choice') expect(dimension.choices?.length).toBeGreaterThan(0);
    }
    // A query of the source's first measure, grouped by each of its dimensions, is accepted.
    for (const dimension of Object.keys(spec.dimensions))
      expect(
        reportQuery.safeParse({
          source: key,
          measures: [Object.keys(spec.measures)[0]],
          groupBy: [dimension],
          range,
        }).success,
        `${key}.${dimension}`,
      ).toBe(true);
  });

  it('groups a contact’s attribution by the same words everywhere', () => {
    for (const key of reportSourceKeys) {
      const spec: ReportSourceSpec = reportSources[key];
      expect(spec.dimensions['sessionSource']).toMatchObject({
        kind: 'choice',
        choices: sessionSources,
        attribution: true,
      });
      expect(spec.dimensions['medium']?.choices).toBe(attributionMediums);
    }
    expect(reportWeekdays).toHaveLength(7);
    expect(reportWeekdays[0]).toBe('Monday');
  });
});

describe('a report’s definition', () => {
  const stat = {
    id: 'leads',
    kind: 'stat',
    title: 'Leads',
    query: { source: 'contacts', measures: ['count'] },
    w: 3,
    h: 2,
  };
  const text = { id: 'note', kind: 'text', title: '', text: 'Leads by source.', w: 12, h: 1 };

  it('is pages of widgets, each a query or a text', () => {
    const parsed = reportDefinition.parse({
      version: 1,
      range,
      pages: [{ name: 'Overview', widgets: [stat, text] }],
    });
    expect(parsed).toMatchObject({ compare: null, theme: { accent: null, logo: 'business' } });
    expect(reportDefinition.parse(BLANK_REPORT_DEFINITION)).toEqual(BLANK_REPORT_DEFINITION);
    expect(
      reportWidget.safeParse({ ...stat, range: { preset: 'today' }, compare: null }).success,
    ).toBe(true);
    // A widget's query carries no range: the report gives it one.
    expect(reportWidgetQuery.safeParse({ ...stat.query, range }).success).toBe(false);
  });

  it('refuses a widget that is neither, or both, or off the grid', () => {
    const { query: _query, ...bare } = stat;
    const { text: _text, ...silent } = text;
    expect(paths(reportWidget.safeParse(bare))).toEqual(['query']);
    expect(paths(reportWidget.safeParse({ ...stat, text: 'x' }))).toEqual(['text']);
    expect(paths(reportWidget.safeParse(silent))).toEqual(['text']);
    expect(paths(reportWidget.safeParse({ ...text, query: stat.query }))).toEqual(['query']);
    expect(paths(reportWidget.safeParse({ ...stat, w: 13 }))).toEqual(['w']);
    expect(paths(reportWidget.safeParse({ ...stat, id: 'Leads!' }))).toEqual(['id']);
    expect(paths(reportWidget.safeParse({ ...stat, kind: 'gauge' }))).toEqual(['kind']);
    expect(
      paths(reportWidget.safeParse({ ...stat, query: { source: 'contacts', measures: ['x'] } })),
    ).toEqual(['query/measures/0']);
  });

  it('gives each widget its own id, and holds pages and widgets to their limits', () => {
    const page = (widgets: unknown[], name = 'Page') => ({ name, widgets });
    const definition = (pages: unknown[]) => ({ version: 1, range, pages });
    expect(
      paths(
        reportDefinition.safeParse(
          definition([page([stat]), page([text, { ...text, id: 'leads' }])]),
        ),
      ),
    ).toEqual(['pages/1/widgets/1/id']);
    expect(paths(reportDefinition.safeParse(definition([])))).toEqual(['pages']);
    expect(paths(reportDefinition.safeParse(definition([page([], '')])))).toEqual(['pages/0/name']);
    const many = Array.from({ length: REPORT_LIMITS.widgetsPerPage + 1 }, (_each, index) => ({
      ...text,
      id: `note-${String(index)}`,
    }));
    expect(paths(reportDefinition.safeParse(definition([page(many)])))).toEqual([
      'pages/0/widgets',
    ]);
    expect(
      paths(
        reportDefinition.safeParse(
          definition(Array.from({ length: REPORT_LIMITS.pages + 1 }, () => page([]))),
        ),
      ),
    ).toEqual(['pages']);
    expect(reportDefinition.safeParse({ ...definition([page([])]), version: 2 }).success).toBe(
      false,
    );
    expect(
      paths(reportDefinition.safeParse({ ...definition([page([])]), theme: { accent: 'red' } })),
    ).toEqual(['theme/accent']);
  });

  it('starts blank, from a template or from a definition, never from two', () => {
    expect(createReportInput.safeParse({}).success).toBe(true);
    expect(createReportInput.safeParse({ templateKey: 'pipeline_attribution' }).success).toBe(true);
    expect(
      createReportInput.safeParse({ name: 'Mine', definition: BLANK_REPORT_DEFINITION }).success,
    ).toBe(true);
    expect(
      paths(
        createReportInput.safeParse({
          templateKey: 'pipeline_attribution',
          definition: BLANK_REPORT_DEFINITION,
        }),
      ),
    ).toEqual(['definition']);
    expect(paths(createReportInput.safeParse({ name: '  ' }))).toEqual(['name']);
  });
});

describe('the fixed reports', () => {
  it.each([
    ['appointment', appointmentOverviewQuery],
    ['attribution', attributionReportQuery],
  ] as const)('take a preset, or two days, or nothing for the %s report', (_name, schema) => {
    expect(schema.parse({})).toMatchObject({ attribution: 'first' });
    expect(schema.safeParse({ preset: 'this_month' }).success).toBe(true);
    expect(schema.safeParse({ from: '2026-09-01', to: '2026-09-30' }).success).toBe(true);
    expect(
      paths(schema.safeParse({ preset: 'today', from: '2026-09-01', to: '2026-09-30' })),
    ).toEqual(['preset']);
    expect(paths(schema.safeParse({ from: '2026-09-01' }))).toEqual(['to']);
    expect(paths(schema.safeParse({ to: '2026-09-01' }))).toEqual(['from']);
    expect(paths(schema.safeParse({ from: '2026-09-02', to: '2026-09-01' }))).toEqual(['to']);
    expect(schema.safeParse({ attribution: 'all' }).success).toBe(false);
  });

  it('read an appointment by when it takes place unless asked for when it was booked', () => {
    expect(appointmentOverviewQuery.parse({}).dateProperty).toBe('starts');
    expect(appointmentOverviewQuery.safeParse({ dateProperty: 'cancelled' }).success).toBe(false);
    expect(appointmentOverviewQuery.safeParse({ calendarId: 'pipe_x' }).success).toBe(false);
  });
});

describe('the endpoints', () => {
  it('are each published once, the static paths before a report’s id', () => {
    for (const endpoint of reportingEndpoints)
      expect(endpoints.filter((each) => each.operationId === endpoint.operationId)).toEqual([
        endpoint,
      ]);
    expect(reportingEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'get /reports/catalog',
      'post /reports/query',
      'get /reports/templates',
      'get /reports/appointment-overview',
      'get /reports/attribution',
      'get /reports',
      'post /reports',
      'get /reports/{id}',
      'put /reports/{id}',
      'post /reports/{id}/clone',
      'delete /reports/{id}',
    ]);
    expect(endpoints.map((endpoint) => endpoint.operationId)).toContain('getContactAttribution');
  });
});

describe('who may read and manage reports', () => {
  it('is owners, admins and members to read; owners and admins to manage; a viewer neither', () => {
    const { business, agency } = builtInPermissions;
    for (const role of [business['owner'], business['admin'], agency['owner'], agency['admin']]) {
      expect(role).toContain('reports.view');
      expect(role).toContain('reports.manage');
    }
    for (const role of [business['member'], agency['member']]) {
      expect(role).toContain('reports.view');
      expect(role).not.toContain('reports.manage');
    }
    expect(business['viewer']).toEqual(['assistant.use']);
    expect(permissionCatalog['reports.view'].scope).toBe('business');
    expect(permissionCatalog['reports.manage'].scope).toBe('business');
  });
});

describe('what a public page may say of a visit', () => {
  it('is two web addresses, each optional', () => {
    expect(publicVisit.parse({})).toEqual({});
    expect(
      publicVisit.safeParse({
        pageUrl: 'https://www.example.com/book?utm_source=adwords',
        referrer: 'https://www.google.com/',
      }).success,
    ).toBe(true);
    expect(publicVisit.safeParse({ pageUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(
      publicVisit.safeParse({ referrer: `https://example.com/${'a'.repeat(2000)}` }).success,
    ).toBe(false);
    expect(publicVisit.safeParse({ cookie: 'x' }).success).toBe(false);
  });

  it('may say how the visit began: a page, the site before it and the moment', () => {
    const first = {
      pageUrl: 'https://www.example.com/s/site/offer?utm_source=google&gclid=abc',
      referrer: 'https://www.google.com',
      at: 1_791_882_000_000,
    };
    expect(publicArrival.parse(first)).toEqual(first);
    expect(publicVisit.parse({ pageUrl: 'https://www.example.com/book', first })).toEqual({
      pageUrl: 'https://www.example.com/book',
      first,
    });
    // Only the page is needed; the rest is said when it is known.
    expect(publicArrival.parse({ pageUrl: first.pageUrl })).toEqual({ pageUrl: first.pageUrl });
    for (const bad of [
      {},
      { referrer: first.referrer },
      { pageUrl: 'javascript:alert(1)' },
      { pageUrl: 'ftp://www.example.com/a' },
      { pageUrl: `https://www.example.com/${'a'.repeat(ATTRIBUTION_LIMITS.urlLength)}` },
      { pageUrl: first.pageUrl, referrer: 'not an address' },
      { pageUrl: first.pageUrl, at: -1 },
      { pageUrl: first.pageUrl, at: 1.5 },
      { pageUrl: first.pageUrl, at: '1791882000000' },
      { pageUrl: first.pageUrl, at: Number.MAX_SAFE_INTEGER + 2 },
      { pageUrl: first.pageUrl, cookie: 'x' },
    ])
      expect(publicArrival.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    expect(publicVisit.safeParse({ first: {} }).success).toBe(false);
    // A booking and a form both take it, and neither needs it.
    expect(publicBookingInput.shape.visit.safeParse({ first }).success).toBe(true);
    expect(publicFormSubmissionInput.shape.first.safeParse(first).success).toBe(true);
    expect(publicFormSubmissionInput.shape.first.safeParse(undefined).success).toBe(true);
    expect(publicFormSubmissionInput.shape.first.safeParse({ at: 1 }).success).toBe(false);
    expect(ATTRIBUTION_LIMITS.arrivalDays).toBe(90);
  });

  it('names every parameter an address is read for, each once', () => {
    expect(new Set(ATTRIBUTION_PARAMETERS).size).toBe(ATTRIBUTION_PARAMETERS.length);
    for (const name of [
      'utm_source',
      'gclid',
      'fbclid',
      'msclkid',
      'ttclid',
      'li_fat_id',
      'source',
    ])
      expect(ATTRIBUTION_PARAMETERS).toContain(name);
    for (const name of ATTRIBUTION_PARAMETERS) expect(name).toMatch(/^[a-z_]+$/);
  });

  it('is taken by a booking and, as a referrer, by a form, and by neither when left out', () => {
    expect(publicBookingInput.shape.visit.safeParse(undefined).success).toBe(true);
    expect(
      publicBookingInput.shape.visit.safeParse({ pageUrl: 'https://www.example.com/book' }).success,
    ).toBe(true);
    expect(
      publicFormSubmissionInput.shape.referrer.safeParse('https://www.google.com').success,
    ).toBe(true);
    expect(publicFormSubmissionInput.shape.referrer.safeParse(undefined).success).toBe(true);
    expect(publicFormSubmissionInput.shape.referrer.safeParse('ftp://example.com').success).toBe(
      false,
    );
  });
});
