// Reporting's endpoints: the catalogue, one query, saved reports and their templates, and
// the two fixed reports the Reporting page shows as tabs. Reading needs `reports.view`;
// making and changing a report needs `reports.manage`.
import * as z from 'zod';

import { appointmentSources } from './appointments.js';
import { appointmentStatuses } from './calendar-events.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { permissions } from './permissions.js';
import { reportDay } from './report-range.js';
import { attributionMediums, sessionSources } from './reporting-attribution.js';
import {
  REPORT_LIMITS,
  reportCell,
  reportCompareModes,
  reportPresets,
  reportQuery,
  reportRangeInput,
  reportResolvedRange,
  reportResult,
  reportWidgetQuery,
} from './reporting-query.js';
import { reportReferences, reportSourceKeys } from './reporting-sources.js';
import { timestamp } from './timestamps.js';

const group = 'Reports';

// The catalogue ------------------------------------------------------------------------

const measureEntry = z.looseObject({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['count', 'money']),
  description: z.string(),
});
const dimensionEntry = z.looseObject({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'choice', 'reference', 'weekday']),
  choices: z.array(z.string()).optional(),
  reference: z.enum(reportReferences).optional(),
  attribution: z.boolean().meta({
    description: "True for the contact's attribution, read from its first or latest touch.",
  }),
  multiple: z.boolean().meta({
    description: 'True when one row can be in several groups, as a contact with two tags.',
  }),
  operators: z.array(z.string()).meta({
    description: 'The operators a condition on it takes. None: it can only be grouped by.',
  }),
});

export const reportCatalog = z
  .looseObject({
    sources: z.array(
      z.looseObject({
        key: z.enum(reportSourceKeys),
        label: z.string(),
        description: z.string(),
        allowed: z.boolean().meta({ description: 'Whether your role may read this source.' }),
        permission: z.enum(permissions).nullable().meta({
          description: 'What reading it needs beside reports.view. Null for nothing more.',
        }),
        measures: z.array(measureEntry),
        dimensions: z.array(dimensionEntry),
        numberFilters: z.array(
          z.looseObject({ key: z.string(), label: z.string(), operators: z.array(z.string()) }),
        ),
        dateProperties: z.array(z.looseObject({ key: z.string(), label: z.string() })),
        defaultDate: z.string(),
        attribution: z.array(z.enum(['first', 'latest', 'all'])),
      }),
    ),
    presets: z.array(z.enum(reportPresets)),
    limits: z.looseObject({
      measures: z.int(),
      groupBy: z.int(),
      rangeDays: z.int(),
      rows: z.int(),
      widgetsPerPage: z.int(),
      pages: z.int(),
    }),
    canManage: z.boolean().meta({ description: 'Whether you may make and change reports.' }),
  })
  .meta({ id: 'ReportCatalog' });
export type ReportCatalog = z.output<typeof reportCatalog>;

export const getReportCatalog = defineEndpoint({
  operationId: 'getReportCatalog',
  method: 'get',
  path: '/reports/catalog',
  summary: 'Read what a report can ask: sources, measures, dimensions, dates and limits',
  group,
  response: { status: 200, description: 'The catalogue.', schema: reportCatalog },
});

export const runReportQuery = defineEndpoint({
  operationId: 'runReportQuery',
  method: 'post',
  path: '/reports/query',
  summary: 'Run one report query',
  group,
  body: reportQuery,
  response: {
    status: 200,
    description:
      "Counted from the rows you may see, as they are now, over the business's own calendar days. A read: nothing is stored.",
    schema: reportResult,
  },
});

// A report's definition ----------------------------------------------------------------

export const reportWidgetKinds = [
  'stat',
  'line',
  'area',
  'bar',
  'hbar',
  'donut',
  'table',
  'funnel',
  'text',
] as const;
export type ReportWidgetKind = (typeof reportWidgetKinds)[number];

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use at most ${String(max)} characters.` })
    .regex(/^\P{Cc}*$/u, { error: 'Use one line of plain text.' });

export const reportWidget = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
      .meta({ description: 'Unique within the report; chosen by whoever adds the widget.' }),
    kind: z.enum(reportWidgetKinds),
    title: line(120),
    query: reportWidgetQuery.optional().meta({
      description: 'What the widget shows. Every kind but text has one.',
    }),
    text: z.string().max(4000).optional().meta({
      description: 'For a text widget: a section title or a note, as plain text.',
    }),
    range: reportRangeInput.optional().meta({ description: "In place of the report's range." }),
    compare: z.enum(reportCompareModes).nullable().optional().meta({
      description: "In place of the report's comparison; null for none.",
    }),
    w: z.int().min(1).max(12).meta({ description: 'Columns of a 12-column grid.' }),
    h: z.int().min(1).max(12).meta({ description: 'Rows of the grid.' }),
  })
  .superRefine((widget, context) => {
    const problem = (path: string, code: string, message: string) => {
      context.addIssue({ code: 'custom', path: [path], message, params: { code } });
    };
    if (widget.kind === 'text') {
      if (widget.query !== undefined)
        problem('query', 'not_taken', 'A text widget shows no numbers.');
      if (widget.text === undefined) problem('text', 'required', 'Write the text.');
      return;
    }
    if (widget.text !== undefined) problem('text', 'not_taken', 'Only a text widget has text.');
    if (widget.query === undefined) problem('query', 'required', 'Choose what the widget shows.');
  })
  .meta({ id: 'ReportWidget' });
export type ReportWidget = z.output<typeof reportWidget>;

export const REPORT_DEFINITION_VERSION = 1;

export const reportDefinition = z
  .strictObject({
    version: z.literal(REPORT_DEFINITION_VERSION),
    range: reportRangeInput,
    compare: z.enum(reportCompareModes).nullable().default(null),
    theme: z
      .strictObject({
        accent: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i, { error: 'Give a colour as #rrggbb.' })
          .nullable()
          .default(null)
          .meta({ description: "Null uses the app's own accent." }),
        logo: z.enum(['business', 'none']).default('business'),
      })
      .default({ accent: null, logo: 'business' }),
    cover: z.strictObject({ title: line(120), subtitle: line(200).default('') }).optional(),
    pages: z
      .array(
        z.strictObject({
          name: line(80).min(1, { error: 'Name the page.' }),
          widgets: z.array(reportWidget).max(REPORT_LIMITS.widgetsPerPage, {
            error: `Use at most ${String(REPORT_LIMITS.widgetsPerPage)} widgets on a page.`,
          }),
        }),
      )
      .min(1, { error: 'A report has at least one page.' })
      .max(REPORT_LIMITS.pages, { error: `Use at most ${String(REPORT_LIMITS.pages)} pages.` }),
  })
  .superRefine((definition, context) => {
    const seen = new Set<string>();
    for (const [pageIndex, page] of definition.pages.entries())
      for (const [index, widget] of page.widgets.entries()) {
        if (seen.has(widget.id))
          context.addIssue({
            code: 'custom',
            path: ['pages', pageIndex, 'widgets', index, 'id'],
            message: 'Give each widget of the report its own id.',
            params: { code: 'repeated' },
          });
        seen.add(widget.id);
      }
  })
  .meta({
    id: 'ReportDefinition',
    description:
      "Pages of widgets on a 12-column grid, in order: a widget takes `w` columns and `h` rows and flows after the one before it. A widget is run by sending its query with its own range and comparison, or the report's.",
  });
export type ReportDefinition = z.output<typeof reportDefinition>;

/** An empty report: one page, the last 30 days. */
export const BLANK_REPORT_DEFINITION: ReportDefinition = {
  version: REPORT_DEFINITION_VERSION,
  range: { preset: 'last_30_days' },
  compare: null,
  theme: { accent: null, logo: 'business' },
  pages: [{ name: 'Page 1', widgets: [] }],
};

// Saved reports ------------------------------------------------------------------------

const reportId = publicId('report');
const reportName = line(120).min(1, { error: 'Name the report.' });
const revision = z.int().min(1).meta({
  description: 'Changes with every save. Send back the one you read.',
});

const reportSummary = {
  id: reportId,
  name: z.string(),
  templateKey: z.string().nullable().meta({
    description: 'The template it was made from, if any.',
  }),
  createdBy: z
    .looseObject({
      kind: z.enum(['user', 'template_library', 'other']).meta({
        description:
          'template_library for a report made from a template, whoever pressed the button.',
      }),
      name: z.string().nullable(),
    })
    .meta({ description: 'Who made it, as the list shows it.' }),
  scheduleFrequency: z.null().meta({
    description: 'Always null: schedules are not built yet (stage 3 of the reporting plan).',
  }),
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
};

export const reportListItem = z.looseObject(reportSummary).meta({ id: 'ReportListItem' });
export const report = z
  .looseObject({
    ...reportSummary,
    definition: reportDefinition,
    canManage: z.boolean(),
  })
  .meta({ id: 'Report' });
export type Report = z.output<typeof report>;

export const reportList = z
  .looseObject({
    items: z.array(reportListItem),
    nextCursor: reportId.nullable(),
    canManage: z.boolean(),
  })
  .meta({ id: 'ReportList' });
export type ReportList = z.output<typeof reportList>;

export const listReportsQuery = z.strictObject({
  q: z.string().trim().max(200).optional().meta({
    description: 'Finds reports by any part of their name.',
  }),
  after: reportId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(15),
});

export const createReportInput = z
  .strictObject({
    name: reportName.optional().meta({
      description: 'Left out: the template\'s name, or "Untitled report".',
    }),
    templateKey: z.string().max(60).optional().meta({
      description: 'Start from this template of GET /reports/templates.',
    }),
    definition: reportDefinition.optional().meta({
      description: 'Start from this definition. Not together with a template.',
    }),
  })
  .refine((input) => input.templateKey === undefined || input.definition === undefined, {
    path: ['definition'],
    error: 'Start from a template or from a definition, not both.',
  })
  .meta({ id: 'CreateReportInput' });

export const updateReportInput = z
  .strictObject({
    name: reportName,
    definition: reportDefinition,
    revision,
  })
  .meta({ id: 'UpdateReportInput' });

export const cloneReportInput = z
  .strictObject({
    name: reportName.optional().meta({ description: 'Left out: "Copy of" and its name.' }),
  })
  .meta({ id: 'CloneReportInput' });

export const deleteReportInput = z.strictObject({ revision }).meta({ id: 'DeleteReportInput' });

const reportParams = z.strictObject({ id: reportId });

export const updateReportCommandInput = updateReportInput.extend(reportParams.shape);
export const cloneReportCommandInput = cloneReportInput.extend(reportParams.shape);
export const deleteReportCommandInput = deleteReportInput.extend(reportParams.shape);

export const listReports = defineEndpoint({
  operationId: 'listReports',
  method: 'get',
  path: '/reports',
  summary: 'List saved reports, newest first',
  group,
  query: listReportsQuery,
  response: { status: 200, description: 'A page of reports.', schema: reportList },
});
export const createReport = defineEndpoint({
  operationId: 'createReport',
  method: 'post',
  path: '/reports',
  summary: 'Make a report: blank, from a template, or from a definition',
  group,
  body: createReportInput,
  response: { status: 201, description: 'The new report.', schema: report },
});
export const getReport = defineEndpoint({
  operationId: 'getReport',
  method: 'get',
  path: '/reports/{id}',
  summary: 'Read a saved report with its definition',
  group,
  params: reportParams,
  response: { status: 200, description: 'The report.', schema: report },
});
export const updateReport = defineEndpoint({
  operationId: 'updateReport',
  method: 'put',
  path: '/reports/{id}',
  summary: "Save a report's name and definition",
  group,
  params: reportParams,
  body: updateReportInput,
  response: {
    status: 200,
    description: 'The saved report. 409 when it changed since the revision sent.',
    schema: report,
  },
});
export const cloneReport = defineEndpoint({
  operationId: 'cloneReport',
  method: 'post',
  path: '/reports/{id}/clone',
  summary: 'Make a copy of a report',
  group,
  params: reportParams,
  body: cloneReportInput,
  response: { status: 201, description: 'The copy.', schema: report },
});
export const deleteReport = defineEndpoint({
  operationId: 'deleteReport',
  method: 'delete',
  path: '/reports/{id}',
  summary: 'Delete a report',
  group,
  params: reportParams,
  body: deleteReportInput,
  response: { status: 204, description: 'The report is gone from the list.' },
});

// Templates ----------------------------------------------------------------------------

export const reportTemplate = z
  .looseObject({
    key: z.string(),
    version: z.int().min(1),
    name: z.string(),
    description: z.string(),
    definition: reportDefinition,
  })
  .meta({ id: 'ReportTemplate' });
export type ReportTemplate = z.output<typeof reportTemplate>;

export const listReportTemplates = defineEndpoint({
  operationId: 'listReportTemplates',
  method: 'get',
  path: '/reports/templates',
  summary: 'List the Template Library',
  group,
  response: {
    status: 200,
    description:
      'The templates, each with its definition for a preview. A report made from one is a copy: later changes to the template do not reach it.',
    schema: z.looseObject({ items: z.array(reportTemplate) }),
  },
});

// The fixed reports --------------------------------------------------------------------

/** A fixed report's range: a preset, or both days. Left out, the last 30 days. */
const fixedRange = {
  preset: z.enum(reportPresets).optional(),
  from: reportDay.optional(),
  to: reportDay.optional(),
};

/** The range a fixed report's query names, or the problem with it. */
function checkFixedRange(
  query: {
    readonly preset?: string | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const problem = (path: string, code: string, message: string) => {
    context.addIssue({ code: 'custom', path: [path], message, params: { code } });
  };
  const days = query.from !== undefined || query.to !== undefined;
  if (query.preset !== undefined && days)
    problem('preset', 'not_taken', 'Name a preset or two days, not both.');
  else if (days && (query.from === undefined || query.to === undefined))
    problem(query.from === undefined ? 'from' : 'to', 'required', 'Give both days.');
  else if (days) {
    const range = reportRangeInput.safeParse({ from: query.from, to: query.to });
    if (!range.success)
      for (const issue of range.error.issues) problem('to', 'invalid_range', issue.message);
  }
}

const count = z.int().min(0);
const calendarRef = z.looseObject({ id: publicId('calendar').nullable(), name: z.string() });

export const appointmentOverviewQuery = z
  .strictObject({
    ...fixedRange,
    dateProperty: z.enum(['starts', 'created']).default('starts'),
    calendarId: publicId('calendar').optional().meta({ description: 'Only this calendar.' }),
    attribution: z.enum(['first', 'latest']).default('first'),
  })
  .superRefine(checkFixedRange)
  .meta({ id: 'AppointmentOverviewQuery' });

export const appointmentOverview = z
  .looseObject({
    range: reportResolvedRange,
    timeZone: z.string(),
    dateProperty: z.enum(['starts', 'created']),
    attribution: z.enum(['first', 'latest']),
    total: count,
    statuses: z.array(z.looseObject({ status: z.enum(appointmentStatuses), count })).meta({
      description:
        'Always booked, confirmed, cancelled, no_show, completed and invalid, in that order. completed is an appointment the contact showed up for.',
    }),
    channels: z.array(z.looseObject({ channel: z.enum(appointmentSources), count })).meta({
      description: 'How each was booked, the most used first.',
    }),
    sources: z
      .array(z.looseObject({ sessionSource: z.enum(sessionSources).nullable(), count }))
      .meta({
        description: "The session source of each appointment's contact, the largest first.",
      }),
    calendars: z.array(z.looseObject({ calendar: calendarRef, count })).meta({
      description: 'The five most booked calendars.',
    }),
    teamMembers: z
      .array(
        z.looseObject({
          assignee: z
            .looseObject({ membershipId: publicId('membership').nullable(), name: z.string() })
            .nullable(),
          count,
        }),
      )
      .meta({ description: 'The five people with the most appointments. Null: unassigned.' }),
    weekdays: z.array(z.looseObject({ weekday: z.int().min(1).max(7), count })).meta({
      description: 'All seven days, Monday (1) first, by the day of the date asked for.',
    }),
    cancellations: z.array(z.looseObject({ calendar: calendarRef, count })).meta({
      description: 'The five calendars with the most cancelled and invalid appointments.',
    }),
    reschedules: z.null().meta({
      description:
        'Always null: an appointment keeps no count of how often it was moved, so this cannot be answered yet.',
    }),
  })
  .meta({ id: 'AppointmentOverview' });
export type AppointmentOverview = z.output<typeof appointmentOverview>;

export const getAppointmentOverview = defineEndpoint({
  operationId: 'getAppointmentOverview',
  method: 'get',
  path: '/reports/appointment-overview',
  summary: 'Read the Appointment report: statuses, channels, sources, calendars, people and days',
  group,
  query: appointmentOverviewQuery,
  response: {
    status: 200,
    description: 'Counted from the appointments dated in the range, as they are now.',
    schema: appointmentOverview,
  },
});

export const attributionReportQuery = z
  .strictObject({
    ...fixedRange,
    attribution: z.enum(['first', 'latest']).default('first'),
  })
  .superRefine(checkFixedRange)
  .meta({ id: 'AttributionReportQuery' });

const funnelNumbers = {
  leads: count.meta({ description: 'Contacts added in the range.' }),
  appointments: count.meta({ description: 'Appointments booked in the range.' }),
  opportunities: count.meta({ description: 'Opportunities created in the range.' }),
  won: count.meta({ description: 'Opportunities won in the range, by the day they were won.' }),
  wonValue: reportCell.meta({ description: 'The value of those won, for each currency.' }),
};

export const attributionReport = z
  .looseObject({
    range: reportResolvedRange,
    timeZone: z.string(),
    attribution: z.enum(['first', 'latest']),
    totals: z.looseObject(funnelNumbers),
    sources: z
      .array(z.looseObject({ sessionSource: z.enum(sessionSources).nullable(), ...funnelNumbers }))
      .meta({
        description:
          'The conversion view: one row for each session source with anything in the range, the most leads first. Null: contacts with no touch recorded.',
      }),
    campaigns: z
      .array(
        z.looseObject({
          utmSource: z.string().nullable(),
          utmCampaign: z.string().nullable(),
          other: z.boolean(),
          ...funnelNumbers,
        }),
      )
      .meta({
        description:
          'The same numbers by UTM source and campaign: the 50 with the most leads, and one "other" row for the rest. Both null: contacts that came with no campaign label.',
      }),
    referrers: z
      .array(
        z.looseObject({ referrerDomain: z.string().nullable(), other: z.boolean(), leads: count }),
      )
      .meta({ description: 'Leads by the site they came from: the top 20 and "other".' }),
    series: z
      .looseObject({
        grain: z.enum(['day', 'week', 'month']),
        points: z.array(z.looseObject({ date: reportDay, leads: count })),
      })
      .meta({
        description:
          'Leads over the range, zeros included: by day up to 92 days, by week up to two years, by month beyond.',
      }),
    touches: z
      .array(
        z.looseObject({
          touchedAt: timestamp,
          contact: z.looseObject({ id: publicId('contact'), name: z.string().nullable() }),
          first: z.boolean(),
          medium: z.enum(attributionMediums),
          sessionSource: z.enum(sessionSources),
          utmSource: z.string().nullable(),
          utmMedium: z.string().nullable(),
          utmCampaign: z.string().nullable(),
          utmContent: z.string().nullable(),
          referrerDomain: z.string().nullable(),
          landingUrl: z.string().nullable(),
        }),
      )
      .meta({ description: 'The source view: the 100 newest touches of the range.' }),
  })
  .meta({ id: 'AttributionReport' });
export type AttributionReport = z.output<typeof attributionReport>;

export const getAttributionReport = defineEndpoint({
  operationId: 'getAttributionReport',
  method: 'get',
  path: '/reports/attribution',
  summary: 'Read the Attribution report: what each source produced, and the touches behind it',
  group,
  query: attributionReportQuery,
  response: {
    status: 200,
    description:
      "A lead is a contact, counted on the day it was added, under the session source of its first or latest touch. An opportunity is under its primary contact's.",
    schema: attributionReport,
  },
});

export const reportingEndpoints = [
  getReportCatalog,
  runReportQuery,
  listReportTemplates,
  getAppointmentOverview,
  getAttributionReport,
  listReports,
  createReport,
  getReport,
  updateReport,
  cloneReport,
  deleteReport,
] as const;
