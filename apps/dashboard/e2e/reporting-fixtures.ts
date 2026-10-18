// Stands in for the server's Reporting API: the catalogue built from the contract's own
// sources as the server builds it, saved reports kept in the test's memory, the Template
// Library, the two fixed reports, and a query runner that answers any query the contract
// accepts with rows shaped as the contract says. Every body the page sends is checked
// against the contract first, so a page that sends what the server would refuse fails its
// test here.
import type { Page, Route } from '@playwright/test';
import {
  BLANK_REPORT_DEFINITION,
  createReportInput,
  REPORT_LIMITS,
  reportFilterOperators,
  reportPresets,
  reportQuery,
  reportSourceKeys,
  reportSources,
  updateReportInput,
  type AppointmentOverview,
  type AttributionReport,
  type Calendar,
  type ContactAttributions,
  type Report,
  type ReportCatalog,
  type ReportCell,
  type ReportQuery,
  type ReportResolvedRange,
  type ReportResult,
  type ReportSourceSpec,
  type ReportTemplate,
} from '@repo/contracts';

/** The catalogue as GET /reports/catalog gives it (packages/modules/reporting, readCatalog). */
export function catalogOf(canManage = true): ReportCatalog {
  return {
    sources: reportSourceKeys.map((key) => {
      const spec: ReportSourceSpec = reportSources[key];
      return {
        key,
        label: spec.label,
        description: spec.description,
        allowed: true,
        permission: spec.permission,
        measures: Object.entries(spec.measures).map(([measure, each]) => ({
          key: measure,
          label: each.label,
          kind: each.kind,
          description: each.description,
        })),
        dimensions: Object.entries(spec.dimensions).map(([dimension, each]) => ({
          key: dimension,
          label: each.label,
          kind: each.kind,
          ...(each.choices === undefined ? {} : { choices: [...each.choices] }),
          ...(each.reference === undefined ? {} : { reference: each.reference }),
          attribution: each.attribution === true,
          multiple: each.multiple === true,
          operators: [...reportFilterOperators(each.kind)],
        })),
        numberFilters: spec.numberFilters.map((field) => ({
          key: field,
          label: spec.measures[field]?.label ?? field,
          operators: [...reportFilterOperators('number')],
        })),
        dateProperties: Object.entries(spec.dateProperties).map(([property, each]) => ({
          key: property,
          label: each.label,
        })),
        defaultDate: spec.defaultDate,
        attribution: [...spec.attribution],
      };
    }),
    presets: [...reportPresets],
    limits: {
      measures: REPORT_LIMITS.measures,
      groupBy: REPORT_LIMITS.groupBy,
      rangeDays: REPORT_LIMITS.rangeDays,
      rows: REPORT_LIMITS.rows,
      widgetsPerPage: REPORT_LIMITS.widgetsPerPage,
      pages: REPORT_LIMITS.pages,
    },
    canManage,
  };
}

/** A resolved range: the days given, in Nairobi (UTC+3, no daylight saving). */
export function resolvedRange(
  from = '2026-09-13',
  to = '2026-10-12',
  preset: ReportResolvedRange['preset'] = 'last_30_days',
): ReportResolvedRange {
  const before = new Date(Date.parse(`${from}T00:00:00Z`) - 3 * 3_600_000).toISOString();
  const after = new Date(Date.parse(`${to}T00:00:00Z`) + 21 * 3_600_000).toISOString();
  return { preset, from, to, fromInstant: before, toInstant: after };
}

export const TIME_ZONE = 'Africa/Nairobi';

let serial = 0;
/** A public id of the kind, unlike any other the stand-in made (a UUIDv7 inside, as checked). */
export function reportingId(prefix: 'rpt' | 'con' | 'cal' | 'mem'): string {
  serial += 1;
  return `${prefix}_01h455vb4pex5vsknk084s${String(serial).padStart(4, '0')}`;
}

const only = (field: string, value: string) => ({
  match: 'all' as const,
  groups: [
    {
      match: 'all' as const,
      conditions: [{ field, operator: 'any_of' as const, values: [value] }],
    },
  ],
});

/** The Template Library's template, as the server's (templates/pipeline-attribution.ts). */
export const pipelineTemplate: ReportTemplate = {
  key: 'pipeline_attribution',
  version: 1,
  name: 'Pipeline & Attribution Report',
  description:
    'Open, won and lost opportunities with their value, the pipeline as a funnel, leads by session source, won value by source, and appointments by status.',
  definition: {
    version: 1,
    range: { preset: 'last_30_days' },
    compare: 'previous_period',
    theme: { accent: null, logo: 'business' },
    cover: { title: 'Pipeline & Attribution Report', subtitle: '' },
    pages: [
      {
        name: 'Pipeline',
        widgets: [
          {
            id: 'open',
            kind: 'stat',
            title: 'Open opportunities',
            query: {
              source: 'opportunities',
              measures: ['count', 'value'],
              groupBy: [],
              filters: only('status', 'open'),
              time: { property: 'created' },
            },
            w: 4,
            h: 2,
          },
          {
            id: 'won',
            kind: 'stat',
            title: 'Won opportunities',
            query: {
              source: 'opportunities',
              measures: ['count', 'value'],
              groupBy: [],
              filters: only('status', 'won'),
              time: { property: 'closed' },
            },
            w: 4,
            h: 2,
          },
          {
            id: 'funnel',
            kind: 'funnel',
            title: 'Funnel',
            query: {
              source: 'opportunities',
              measures: ['count'],
              groupBy: ['stage'],
              order: { by: 'group', direction: 'asc' },
            },
            w: 12,
            h: 4,
          },
        ],
      },
      {
        name: 'Attribution',
        widgets: [
          {
            id: 'leads_by_source',
            kind: 'donut',
            title: 'Leads by session source',
            query: { source: 'contacts', measures: ['count'], groupBy: ['sessionSource'] },
            w: 6,
            h: 4,
          },
          {
            id: 'won_by_source',
            kind: 'hbar',
            title: 'Won value by session source',
            query: {
              source: 'opportunities',
              measures: ['value', 'count'],
              groupBy: ['sessionSource'],
              filters: only('status', 'won'),
              time: { property: 'closed' },
            },
            w: 6,
            h: 4,
          },
          {
            id: 'leads_over_time',
            kind: 'line',
            title: 'Leads over time',
            query: {
              source: 'contacts',
              measures: ['count'],
              groupBy: [],
              time: { grain: 'day' },
            },
            w: 12,
            h: 4,
          },
          {
            id: 'appointments_by_status',
            kind: 'bar',
            title: 'Appointments by status',
            query: {
              source: 'appointments',
              measures: ['count'],
              groupBy: ['status'],
              order: { by: 'group', direction: 'asc' },
            },
            w: 12,
            h: 4,
          },
        ],
      },
    ],
  },
};

const DAY = 86_400_000;

/** The groups the stand-in has for each dimension: a choice by its keys, the rest by name. */
function groupsOf(
  source: ReportQuery['source'],
  dimension: string,
): { key: string; label: string }[] {
  const spec: ReportSourceSpec = reportSources[source];
  const found = spec.dimensions[dimension];
  if (found?.kind === 'weekday')
    return ['Monday', 'Tuesday', 'Wednesday'].map((label, index) => ({
      key: String(index + 1),
      label,
    }));
  if (dimension === 'sessionSource')
    return [
      { key: 'others', label: 'Others' },
      { key: 'crm_ui', label: 'CRM UI' },
      { key: 'paid_social', label: 'Paid Social' },
    ];
  if (found?.choices !== undefined)
    return found.choices.slice(0, 3).map((choice) => ({
      key: choice,
      label: `${choice.charAt(0).toUpperCase()}${choice.slice(1).replace(/_/g, ' ')}`,
    }));
  return [
    { key: `${dimension}-a`, label: `${found?.label ?? dimension} A` },
    { key: `${dimension}-b`, label: `${found?.label ?? dimension} B` },
  ];
}

/**
 * An answer to a query, shaped as the contract says: its columns from the query, a row for
 * each bucket and group with small steady numbers, totals that are the rows added up, and
 * the comparison when asked. Money is in KES. Not the server's arithmetic: enough for a
 * screen to draw.
 */
export function answerOf(query: ReportQuery): ReportResult {
  const spec: ReportSourceSpec = reportSources[query.source];
  const grain = query.time?.grain;
  const range =
    'preset' in query.range
      ? resolvedRange(undefined, undefined, query.range.preset)
      : resolvedRange(query.range.from, query.range.to, null);
  const columns: ReportResult['columns'] = [
    ...(grain === undefined
      ? []
      : [
          {
            key: grain,
            role: 'time' as const,
            label: `${grain.charAt(0).toUpperCase()}${grain.slice(1)}`,
            kind: grain,
          },
        ]),
    ...query.groupBy.map((dimension) => ({
      key: dimension,
      role: 'group' as const,
      label: spec.dimensions[dimension]?.label ?? dimension,
      kind: spec.dimensions[dimension]?.kind ?? ('text' as const),
    })),
    ...query.measures.map((measure) => ({
      key: measure,
      role: 'measure' as const,
      label: spec.measures[measure]?.label ?? measure,
      kind: spec.measures[measure]?.kind ?? ('count' as const),
    })),
  ];
  // Seven buckets at most, from the first day of the range, so a chart has a line to draw.
  const buckets =
    grain === undefined
      ? [undefined]
      : Array.from({ length: 7 }, (_, index) =>
          new Date(Date.parse(`${range.from}T00:00:00Z`) + index * DAY).toISOString().slice(0, 10),
        );
  const groupLists = query.groupBy.map((dimension) => groupsOf(query.source, dimension));
  const combinations = groupLists.reduce<{ key: string; label: string }[][]>(
    (all, list) => all.flatMap((sofar) => list.map((each) => [...sofar, each])),
    [[]],
  );
  // A filter narrows the answer: fewer in every row, so a screen can show it changed.
  const narrowed = query.filters === undefined ? 0 : 1;
  const cellOf = (measure: string, seed: number): ReportCell => {
    const amount = Math.max(seed - narrowed, 0);
    return spec.measures[measure]?.kind === 'money'
      ? amount === 0
        ? []
        : [{ currency: 'KES', amount: `${String(amount * 25000)}.0000` }]
      : amount;
  };
  const rows: ReportResult['rows'] = buckets.flatMap((bucket, bucketIndex) =>
    combinations.map((combination, index) => {
      const seed = ((bucketIndex * 2 + index * 3) % 5) + 1;
      return {
        group: [...(bucket === undefined ? [] : [{ key: bucket, label: '' }]), ...combination],
        other: false,
        values: query.measures.map((measure) => cellOf(measure, seed)),
        ...(query.compare === undefined
          ? {}
          : { compare: query.measures.map((measure) => cellOf(measure, Math.max(seed - 1, 1))) }),
      };
    }),
  );
  const sum = (cells: readonly ReportCell[]): ReportCell => {
    if (cells.every((cell) => typeof cell === 'number'))
      return cells.reduce<number>(
        (total, cell) => total + (typeof cell === 'number' ? cell : 0),
        0,
      );
    const amount = cells.reduce<number>(
      (total, cell) => total + (Array.isArray(cell) ? Number(cell[0]?.amount ?? 0) : 0),
      0,
    );
    return amount === 0 ? [] : [{ currency: 'KES', amount: `${String(amount)}.0000` }];
  };
  return {
    source: query.source,
    range,
    timeZone: TIME_ZONE,
    dateProperty: query.time?.property ?? spec.defaultDate,
    attribution: query.attribution ?? spec.attribution[0] ?? 'first',
    columns,
    rows,
    totals: query.measures.map((_, index) => sum(rows.map((row) => row.values[index] ?? null))),
    ...(query.compare === undefined
      ? {}
      : {
          compare: {
            mode: query.compare,
            range: resolvedRange('2026-08-14', '2026-09-12', null),
            totals: query.measures.map((_, index) =>
              sum(rows.map((row) => row.compare?.[index] ?? null)),
            ),
          },
        }),
    truncated: { other: false, incomplete: false, limit: query.limit ?? 50 },
  };
}

/** The Appointment report on a little data: eleven appointments over two calendars. */
export function appointmentOverviewOf(
  rest: Partial<AppointmentOverview> = {},
): AppointmentOverview {
  const consult = { id: 'cal_01h455vb4pex5vsknk084sn02q', name: 'Consultations' };
  const tasting = { id: 'cal_01h455vb4pex5vsknk084sn02r', name: 'Tastings' };
  return {
    range: resolvedRange(),
    timeZone: TIME_ZONE,
    dateProperty: 'starts',
    attribution: 'first',
    total: 11,
    statuses: [
      { status: 'booked', count: 4 },
      { status: 'confirmed', count: 2 },
      { status: 'cancelled', count: 1 },
      { status: 'no_show', count: 1 },
      { status: 'completed', count: 2 },
      { status: 'invalid', count: 1 },
    ],
    channels: [
      { channel: 'booking_page', count: 6 },
      { channel: 'user', count: 4 },
      { channel: 'ai_agent', count: 1 },
    ],
    sources: [
      { sessionSource: 'direct', count: 6 },
      { sessionSource: 'crm_ui', count: 4 },
      { sessionSource: null, count: 1 },
    ],
    calendars: [
      { calendar: consult, count: 7 },
      { calendar: tasting, count: 4 },
    ],
    teamMembers: [
      {
        assignee: { membershipId: 'mem_01h455vb4pex5vsknk084sn02q', name: 'Dana Brooks' },
        count: 8,
      },
      { assignee: null, count: 3 },
    ],
    weekdays: [3, 2, 0, 1, 4, 1, 0].map((count, index) => ({ weekday: index + 1, count })),
    cancellations: [{ calendar: consult, count: 2 }],
    reschedules: null,
    ...rest,
  };
}

const kes = (amount: string): ReportCell => [{ currency: 'KES', amount }];

/** The Attribution report on a little data, as the dev database had it and a little more. */
export function attributionReportOf(rest: Partial<AttributionReport> = {}): AttributionReport {
  const contact = { id: 'con_01h455vb4pex5vsknk084sn02q', name: 'Maya Thompson' };
  return {
    range: resolvedRange(),
    timeZone: TIME_ZONE,
    attribution: 'first',
    totals: {
      leads: 4,
      appointments: 2,
      opportunities: 4,
      won: 1,
      wonValue: [
        { currency: 'KES', amount: '125000.0000' },
        { currency: 'USD', amount: '900.5000' },
      ],
    },
    sources: [
      {
        sessionSource: 'others',
        leads: 2,
        appointments: 1,
        opportunities: 3,
        won: 1,
        wonValue: kes('125000.0000'),
      },
      {
        sessionSource: 'crm_ui',
        leads: 2,
        appointments: 1,
        opportunities: 1,
        won: 0,
        wonValue: [],
      },
    ],
    campaigns: [
      {
        utmSource: 'fb_ad',
        utmCampaign: 'spring-open-day',
        other: false,
        leads: 2,
        appointments: 1,
        opportunities: 2,
        won: 1,
        wonValue: kes('125000.0000'),
      },
      {
        utmSource: 'newsletter',
        utmCampaign: 'october',
        other: false,
        leads: 1,
        appointments: 0,
        opportunities: 1,
        won: 0,
        wonValue: [],
      },
      {
        utmSource: null,
        utmCampaign: null,
        other: false,
        leads: 1,
        appointments: 1,
        opportunities: 1,
        won: 0,
        wonValue: [],
      },
      {
        utmSource: null,
        utmCampaign: null,
        other: true,
        leads: 0,
        appointments: 0,
        opportunities: 0,
        won: 0,
        wonValue: [],
      },
    ],
    referrers: [
      { referrerDomain: 'facebook.com', other: false, leads: 2 },
      { referrerDomain: null, other: false, leads: 2 },
    ],
    series: {
      grain: 'day',
      points: Array.from({ length: 30 }, (_, index) => ({
        date: new Date(Date.parse('2026-09-13T00:00:00Z') + index * DAY).toISOString().slice(0, 10),
        leads: index === 3 ? 1 : index === 20 ? 2 : index === 28 ? 1 : 0,
      })),
    },
    touches: [
      {
        touchedAt: '2026-10-11T09:15:00.000Z',
        contact,
        first: true,
        medium: 'form',
        sessionSource: 'paid_social',
        utmSource: 'fb_ad',
        utmMedium: 'spring-set',
        utmCampaign: 'spring-open-day',
        utmContent: 'video-a',
        referrerDomain: 'facebook.com',
        landingUrl: 'https://harborlights.example/open-day',
      },
      {
        touchedAt: '2026-10-09T14:00:00.000Z',
        contact: { id: 'con_01h455vb4pex5vsknk084sn03q', name: null },
        first: false,
        medium: 'manual',
        sessionSource: 'crm_ui',
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        referrerDomain: null,
        landingUrl: null,
      },
    ],
    ...rest,
  };
}

/** A contact's first and latest touch: a Facebook ad first, a booking later. */
export const contactTouches: ContactAttributions = {
  first: {
    touchedAt: '2026-09-20T08:30:00.000Z',
    medium: 'form',
    sessionSource: 'paid_social',
    utmSource: 'fb_ad',
    utmMedium: 'spring-set',
    utmCampaign: 'spring-open-day',
    utmContent: 'video-a',
    utmTerm: null,
    matchType: null,
    campaignId: '120211',
    adGroupId: null,
    adId: null,
    referrerDomain: 'facebook.com',
    landingUrl: 'https://harborlights.example/open-day',
    pageUrl: 'https://harborlights.example/open-day',
    source: 'Facebook Ads',
    sourceRule: 'facebook_ads',
    clickIds: ['fbclid'],
  },
  latest: {
    touchedAt: '2026-10-08T11:00:00.000Z',
    medium: 'calendar',
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
    landingUrl: 'https://harborlights.example/book',
    pageUrl: 'https://harborlights.example/book',
    source: 'Direct',
    sourceRule: 'direct',
    clickIds: [],
  },
};

export function reportOf(name: string, rest: Partial<Report> = {}): Report {
  return {
    id: rest.id ?? reportingId('rpt'),
    name,
    templateKey: null,
    createdBy: { kind: 'user', name: 'Dana Brooks' },
    scheduleFrequency: null,
    revision: 1,
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T09:00:00.000Z',
    definition: BLANK_REPORT_DEFINITION,
    canManage: true,
    ...rest,
  };
}

const problem = (
  route: Route,
  status: number,
  detail: string,
  rest: Record<string, unknown> = {},
): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify({ type: 'about:blank', title: 'Refused', status, detail, ...rest }),
  });

export interface ReportingStandIn {
  reports: Report[];
  canManage: boolean;
  /** False: every read of Reporting is refused, as for someone without reports.view. */
  canView: boolean;
  appointments: AppointmentOverview;
  attribution: AttributionReport;
  /** The calendars the Appointment report's filter lists. */
  calendars: Calendar[];
  /** What the page asked the fixed reports for, in order. */
  readonly asked: { readonly operation: string; readonly query: Record<string, string> }[];
  /** Every query a widget ran, in order. */
  readonly queries: ReportQuery[];
  /** What the page sent that changed something, in order. */
  readonly changes: { readonly operation: string; readonly input: unknown }[];
  /** How the next save is answered, once: a 409 as if someone else saved first. */
  conflictOnSave: boolean;
  /** An answer to a query in place of the usual one; undefined for the usual. */
  answer: (query: ReportQuery) => ReportResult | undefined;
  /** A refusal of a query in place of an answer: its status and its code; undefined for none. */
  refuse: (query: ReportQuery) => { status: number; code: string } | undefined;
}

/** Answers the Reporting API from what the test may read and change. */
export async function fakeReportingApi(
  page: Page,
  start: Partial<Pick<ReportingStandIn, 'reports' | 'canManage' | 'canView'>> = {},
): Promise<ReportingStandIn> {
  const state: ReportingStandIn = {
    reports: start.reports ?? [],
    canManage: start.canManage ?? true,
    canView: start.canView ?? true,
    appointments: appointmentOverviewOf(),
    attribution: attributionReportOf(),
    calendars: [],
    asked: [],
    queries: [],
    changes: [],
    conflictOnSave: false,
    answer: () => undefined,
    refuse: () => undefined,
  };
  let clock = Date.parse('2026-10-12T09:00:00.000Z');
  const now = (): string => {
    clock += 60_000;
    return new Date(clock).toISOString();
  };
  const forbidden = (route: Route): Promise<void> =>
    problem(route, 403, 'It needs reports.view.', { permission: 'reports.view' });
  const readable = (report: Report): Report => ({ ...report, canManage: state.canManage });
  const queryOf = (route: Route): Record<string, string> =>
    Object.fromEntries(new URL(route.request().url()).searchParams.entries());

  await page.route('**/api/v1/reports/catalog', (route) =>
    state.canView ? route.fulfill({ json: catalogOf(state.canManage) }) : forbidden(route),
  );
  await page.route('**/api/v1/reports/templates', (route) =>
    state.canView ? route.fulfill({ json: { items: [pipelineTemplate] } }) : forbidden(route),
  );
  await page.route(/\/api\/v1\/reports\/appointment-overview(?:\?.*)?$/, (route) => {
    if (!state.canView) return forbidden(route);
    const query = queryOf(route);
    state.asked.push({ operation: 'getAppointmentOverview', query });
    return route.fulfill({
      json: {
        ...state.appointments,
        dateProperty: query['dateProperty'] ?? 'starts',
        attribution: query['attribution'] ?? 'first',
        range:
          query['from'] !== undefined && query['to'] !== undefined
            ? resolvedRange(query['from'], query['to'], null)
            : { ...state.appointments.range, preset: query['preset'] ?? 'last_30_days' },
      },
    });
  });
  await page.route(/\/api\/v1\/reports\/attribution(?:\?.*)?$/, (route) => {
    if (!state.canView) return forbidden(route);
    const query = queryOf(route);
    state.asked.push({ operation: 'getAttributionReport', query });
    const latest = query['attribution'] === 'latest';
    return route.fulfill({
      json: {
        ...state.attribution,
        attribution: latest ? 'latest' : 'first',
        // By the latest touch one lead moves from Others to CRM UI: the numbers change.
        sources: latest
          ? state.attribution.sources.map((row) =>
              row.sessionSource === 'others'
                ? { ...row, leads: row.leads - 1 }
                : row.sessionSource === 'crm_ui'
                  ? { ...row, leads: row.leads + 1 }
                  : row,
            )
          : state.attribution.sources,
        range:
          query['from'] !== undefined && query['to'] !== undefined
            ? resolvedRange(query['from'], query['to'], null)
            : { ...state.attribution.range, preset: query['preset'] ?? 'last_30_days' },
      },
    });
  });
  await page.route('**/api/v1/reports/query', async (route) => {
    if (!state.canView) return forbidden(route);
    const parsed = reportQuery.safeParse(route.request().postDataJSON());
    if (!parsed.success)
      return problem(route, 422, 'The query is not one the contract accepts.', {
        errors: parsed.error.issues.map((issue) => ({
          path: `/${issue.path.map(String).join('/')}`,
          code: 'invalid',
          message: issue.message,
        })),
      });
    state.queries.push(parsed.data);
    const refused = state.refuse(parsed.data);
    if (refused !== undefined)
      return problem(route, refused.status, 'Refused.', {
        errors: [{ path: '', code: refused.code, message: 'Refused.' }],
      });
    return route.fulfill({ json: state.answer(parsed.data) ?? answerOf(parsed.data) });
  });
  await page.route(/\/api\/v1\/reports(?:\?.*)?$/, async (route) => {
    if (!state.canView) return forbidden(route);
    if (route.request().method() === 'POST') {
      const input = createReportInput.parse(route.request().postDataJSON());
      state.changes.push({ operation: 'createReport', input });
      const template = input.templateKey === undefined ? undefined : pipelineTemplate;
      const at = now();
      const made = reportOf(input.name ?? template?.name ?? 'Untitled report', {
        templateKey: input.templateKey ?? null,
        createdBy:
          template === undefined
            ? { kind: 'user', name: 'Dana Brooks' }
            : { kind: 'template_library', name: null },
        definition: input.definition ?? template?.definition ?? BLANK_REPORT_DEFINITION,
        createdAt: at,
        updatedAt: at,
      });
      state.reports.unshift(made);
      return route.fulfill({ status: 201, json: readable(made) });
    }
    const query = queryOf(route);
    const wanted = query['q']?.toLowerCase();
    const limit = Number(query['limit'] ?? 15);
    const matching = state.reports.filter(
      (report) => wanted === undefined || report.name.toLowerCase().includes(wanted),
    );
    const from =
      query['after'] === undefined
        ? 0
        : matching.findIndex((report) => report.id === query['after']) + 1;
    const items = matching.slice(from, from + limit);
    const last = items.at(-1);
    return route.fulfill({
      json: {
        items: items.map(({ definition: _definition, canManage: _canManage, ...item }) => item),
        nextCursor: from + limit < matching.length && last !== undefined ? last.id : null,
        canManage: state.canManage,
      },
    });
  });
  await page.route(/\/api\/v1\/reports\/rpt_[^/?]+(?:\/clone)?$/, async (route) => {
    if (!state.canView) return forbidden(route);
    const url = new URL(route.request().url());
    const cloning = url.pathname.endsWith('/clone');
    const id = url.pathname.split('/').at(cloning ? -2 : -1) ?? '';
    const found = state.reports.find((report) => report.id === id);
    if (found === undefined) return problem(route, 404, 'There is no such report.');
    const method = route.request().method();
    if (cloning) {
      state.changes.push({ operation: 'cloneReport', input: { id } });
      const at = now();
      const copy = reportOf(`Copy of ${found.name}`, {
        templateKey: found.templateKey,
        definition: found.definition,
        createdAt: at,
        updatedAt: at,
      });
      state.reports.unshift(copy);
      return route.fulfill({ status: 201, json: readable(copy) });
    }
    if (method === 'PUT') {
      const input = updateReportInput.parse(route.request().postDataJSON());
      state.changes.push({ operation: 'updateReport', input: { id, ...input } });
      if (state.conflictOnSave) {
        state.conflictOnSave = false;
        // As if someone else had saved: the server's copy moves on.
        found.revision += 1;
        found.name = `${found.name} (theirs)`;
        return problem(route, 409, 'The report changed since you read it.');
      }
      if (input.revision !== found.revision)
        return problem(route, 409, 'The report changed since you read it.');
      found.name = input.name;
      found.definition = input.definition;
      found.revision += 1;
      found.updatedAt = now();
      return route.fulfill({ json: readable(found) });
    }
    if (method === 'DELETE') {
      const input = route.request().postDataJSON() as { revision: number };
      state.changes.push({ operation: 'deleteReport', input: { id, ...input } });
      if (input.revision !== found.revision)
        return problem(route, 409, 'The report changed since you read it.');
      state.reports = state.reports.filter((report) => report.id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: readable(found) });
  });
  // The calendar filter's list, and the lists a condition's values are chosen from.
  await page.route(/\/api\/v1\/calendars(?:\?.*)?$/, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            items: state.calendars,
            nextCursor: null,
            total: state.calendars.length,
            canManage: false,
          },
        })
      : route.fallback(),
  );
  return state;
}
