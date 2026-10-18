// What a report asks and what it is answered. A query
// names a source of the catalogue, up to four of its measures, up to two of its dimensions,
// a range of the business's calendar days and, if wanted, a grain of time, a comparison and
// conditions. Nobody writes SQL: the server compiles the document, and only from what the
// catalogue lists. Everything here is checked without a database; what only the business
// can say (whether a pipeline or a tag is its own) is the engine's to check.
import * as z from 'zod';

import {
  contactFilterKinds,
  contactFilterOperands,
  contactFilterOperators,
  MAX_CONTACT_FILTER_CONDITIONS,
  MAX_CONTACT_FILTER_GROUPS,
  MAX_CONTACT_FILTER_VALUES,
  type ContactFilterOperator,
} from './contact-filters.js';
import { OPPORTUNITY_REPORT_MAX_DAYS } from './opportunity-report.js';
import { reportDay } from './report-range.js';
import {
  reportSourceKeys,
  reportSources,
  type ReportDimensionSpec,
  type ReportSourceKey,
  type ReportSourceSpec,
} from './reporting-sources.js';
import { timestamp } from './timestamps.js';

/** The limits of one query. A query past one is refused, never cut short without saying. */
export const REPORT_LIMITS = {
  measures: 4,
  groupBy: 2,
  /** The longest range, in days: three years, as the dashboard's reports. */
  rangeDays: OPPORTUNITY_REPORT_MAX_DAYS,
  /** The most rows an answer holds. */
  rows: 500,
  /** The most rows an answer to the assistant holds, to fit its tool result. */
  assistantRows: 200,
  /** Groups shown when a query grouped by a dimension names no limit; the rest are "Other". */
  defaultGroups: 50,
  /** Groups shown for each bucket of time when a query names no limit. */
  defaultSeriesGroups: 10,
  /** The most groups the server reads before it stops: past it, "Other" is incomplete. */
  groupsRead: 2000,
  /** How long one statement may run, in milliseconds. */
  statementTimeoutMs: 5000,
  /** Queries one person may run in a minute. */
  queriesPerMinute: 120,
  widgetsPerPage: 20,
  pages: 20,
} as const;

export const reportGrains = ['day', 'week', 'month'] as const;
export type ReportGrain = (typeof reportGrains)[number];

/** Ranges the server works out from today in the business's time zone. Weeks start on Monday. */
export const reportPresets = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'last_12_months',
] as const;
export type ReportPreset = (typeof reportPresets)[number];

const DAY = 86_400_000;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY;

/**
 * A range of the business's own calendar days: a preset, or a first and a last day, both
 * included. The server turns the days into instants in the business's time zone.
 */
export const reportRangeInput = z
  .union([
    z.strictObject({ preset: z.enum(reportPresets) }),
    z
      .strictObject({
        from: reportDay.meta({ description: 'The first day, included.' }),
        to: reportDay.meta({
          description: `The last day, included. Not before the first, and at most ${String(REPORT_LIMITS.rangeDays)} days in all.`,
        }),
      })
      .superRefine((range, context) => {
        const days = dayNumber(range.to) - dayNumber(range.from) + 1;
        if (days < 1)
          context.addIssue({
            code: 'custom',
            path: ['to'],
            message: 'End the range on or after the day it starts.',
            params: { code: 'range_order' },
          });
        else if (days > REPORT_LIMITS.rangeDays)
          context.addIssue({
            code: 'custom',
            path: ['to'],
            message: `Ask for at most ${String(REPORT_LIMITS.rangeDays)} days at a time.`,
            params: { code: 'range_too_long' },
          });
      }),
  ])
  .meta({ id: 'ReportRangeInput' });
export type ReportRangeInput = z.output<typeof reportRangeInput>;

export const reportCompareModes = ['previous_period', 'previous_year'] as const;
export type ReportCompareMode = (typeof reportCompareModes)[number];

const value = z.string().max(1000, { error: 'Use at most 1000 characters.' });

/** One condition: the shape and the operators of a contact filter's (contact-filters.ts). */
export const reportFilterCondition = z
  .strictObject({
    field: z
      .string()
      .max(60)
      .meta({
        description:
          "One of the source's dimensions or number fields, as the catalogue lists them.",
        examples: ['status'],
      }),
    operator: z.enum(contactFilterOperators),
    value: value.optional(),
    values: z
      .array(value)
      .min(1, { error: 'Give at least one value.' })
      .max(MAX_CONTACT_FILTER_VALUES)
      .optional()
      .meta({
        description:
          'For any_of and none_of. A choice by its key; a pipeline, stage, calendar, tag or lost reason by its id; a team member by membership id or "me".',
      }),
    from: value.optional(),
    to: value.optional(),
  })
  .meta({ id: 'ReportFilterCondition' });
export type ReportFilterCondition = z.output<typeof reportFilterCondition>;

const match = z.enum(['all', 'any']).meta({
  description: 'Whether every one must hold (all, AND) or at least one (any, OR).',
});

export const reportFilter = z
  .strictObject({
    match,
    groups: z
      .array(
        z.strictObject({
          match,
          conditions: z.array(reportFilterCondition).min(1).max(MAX_CONTACT_FILTER_CONDITIONS),
        }),
      )
      .min(1)
      .max(MAX_CONTACT_FILTER_GROUPS),
  })
  .meta({
    id: 'ReportFilter',
    description:
      'Groups of conditions. `match` says whether all or any must hold, for the groups and inside each group.',
  });
export type ReportFilter = z.output<typeof reportFilter>;

/** The operators a condition on a field of this kind takes. */
export function reportFilterOperators(
  kind: ReportDimensionSpec['kind'] | 'number',
): readonly ContactFilterOperator[] {
  if (kind === 'text') return contactFilterKinds.text;
  if (kind === 'number') return contactFilterKinds.number;
  // A weekday is grouped by, never filtered on.
  return kind === 'weekday' ? [] : contactFilterKinds.choice;
}

type Problem = (path: (string | number)[], code: string, message: string) => void;

function checkCondition(
  spec: ReportSourceSpec,
  condition: ReportFilterCondition,
  path: (string | number)[],
  problem: Problem,
): void {
  const dimension = Object.hasOwn(spec.dimensions, condition.field)
    ? spec.dimensions[condition.field]
    : undefined;
  const kind = dimension?.kind ?? (spec.numberFilters.includes(condition.field) ? 'number' : null);
  if (kind === null) {
    problem([...path, 'field'], 'unknown_field', 'Choose a field this source can be filtered by.');
    return;
  }
  if (!reportFilterOperators(kind).includes(condition.operator)) {
    problem([...path, 'operator'], 'invalid_operator', 'This field cannot be compared this way.');
    return;
  }
  const operand = contactFilterOperands[condition.operator];
  const given = {
    value: condition.value !== undefined,
    values: condition.values !== undefined,
    range: condition.from !== undefined || condition.to !== undefined,
  };
  if (operand === 'value' && !given.value) problem([...path, 'value'], 'required', 'Give a value.');
  if (operand === 'values' && !given.values)
    problem([...path, 'values'], 'required', 'Give the values.');
  if (operand === 'range' && (condition.from === undefined || condition.to === undefined))
    problem(
      [...path, condition.from === undefined ? 'from' : 'to'],
      'required',
      'Give both ends of the range.',
    );
  for (const [name, member] of [
    ['value', 'value'],
    ['values', 'values'],
    ['range', 'from'],
  ] as const)
    if (given[name] && operand !== name)
      problem([...path, member], 'not_taken', 'This operator does not take it.');
  if (dimension?.choices !== undefined)
    for (const [index, chosen] of (condition.values ?? []).entries())
      if (!dimension.choices.includes(chosen))
        problem(
          [...path, 'values', index],
          'unknown_choice',
          `Choose one of ${dimension.choices.join(', ')}.`,
        );
}

/** What a widget keeps of a query: everything but its range and comparison. */
const queryShape = {
  source: z.enum(reportSourceKeys),
  measures: z
    .array(z.string().max(60))
    .min(1, { error: 'Choose a measure.' })
    .max(REPORT_LIMITS.measures, {
      error: `Choose at most ${String(REPORT_LIMITS.measures)} measures.`,
    }),
  groupBy: z
    .array(z.string().max(60))
    .max(REPORT_LIMITS.groupBy, {
      error: `Group by at most ${String(REPORT_LIMITS.groupBy)} dimensions.`,
    })
    .default([]),
  time: z
    .strictObject({
      property: z.string().max(60).optional().meta({
        description:
          "Which of the source's dates the range is read by. Left out, the source's default.",
      }),
      grain: z.enum(reportGrains).optional().meta({
        description:
          'One row for each day, week (from Monday) or month of the range, zeros included. Left out, the range is one total.',
      }),
    })
    .optional(),
  attribution: z.enum(['first', 'latest', 'all']).optional().meta({
    description:
      "Which touch a contact's attribution is read from: its first (the default) or its latest. `all`, for the attribution source only, counts every touch.",
  }),
  filters: reportFilter.optional(),
  order: z
    .strictObject({
      by: z.string().max(60).meta({
        description:
          'A measure of the query, or `group` for the groups in their own order (a stage by its place in the pipeline, a choice as listed, text by name).',
      }),
      direction: z.enum(['asc', 'desc']).optional().meta({
        description: 'Left out: largest first for a measure, first to last for the groups.',
      }),
    })
    .optional()
    .meta({ description: 'Left out: by the first measure, largest first.' }),
  limit: z.int().min(1).max(REPORT_LIMITS.rows).optional().meta({
    description:
      'How many groups to show; the rest are added up in one "Other" row. With a grain of time, for each bucket.',
  }),
};

function checkQuery(
  query: {
    readonly source: ReportSourceKey;
    readonly measures: readonly string[];
    readonly groupBy: readonly string[];
    readonly time?: { readonly property?: string | undefined } | undefined;
    readonly attribution?: 'first' | 'latest' | 'all' | undefined;
    readonly filters?: ReportFilter | undefined;
    readonly order?: { readonly by: string } | undefined;
  },
  context: z.RefinementCtx,
): void {
  const spec: ReportSourceSpec = reportSources[query.source];
  const problem: Problem = (path, code, message) => {
    context.addIssue({ code: 'custom', path, message, params: { code } });
  };
  for (const [index, measure] of query.measures.entries()) {
    if (!Object.hasOwn(spec.measures, measure))
      problem(['measures', index], 'unknown_measure', 'Choose a measure of this source.');
    else if (query.measures.indexOf(measure) !== index)
      problem(['measures', index], 'repeated', 'Name each measure once.');
  }
  for (const [index, dimension] of query.groupBy.entries()) {
    if (!Object.hasOwn(spec.dimensions, dimension))
      problem(['groupBy', index], 'unknown_dimension', 'Choose a dimension of this source.');
    else if (query.groupBy.indexOf(dimension) !== index)
      problem(['groupBy', index], 'repeated', 'Name each dimension once.');
  }
  const property = query.time?.property;
  if (property !== undefined && !Object.hasOwn(spec.dateProperties, property))
    problem(['time', 'property'], 'unknown_date', 'Choose a date of this source.');
  if (query.attribution !== undefined && !spec.attribution.includes(query.attribution))
    problem(['attribution'], 'invalid_attribution', 'This source reads the first or latest touch.');
  if (
    query.order !== undefined &&
    query.order.by !== 'group' &&
    !query.measures.includes(query.order.by)
  )
    problem(['order', 'by'], 'unknown_order', 'Order by a measure of the query, or by group.');
  let conditions = 0;
  for (const [groupIndex, group] of (query.filters?.groups ?? []).entries())
    for (const [index, condition] of group.conditions.entries()) {
      conditions += 1;
      checkCondition(
        spec,
        condition,
        ['filters', 'groups', groupIndex, 'conditions', index],
        problem,
      );
    }
  if (conditions > MAX_CONTACT_FILTER_CONDITIONS)
    problem(
      ['filters', 'groups'],
      'too_many_conditions',
      `Use at most ${String(MAX_CONTACT_FILTER_CONDITIONS)} conditions.`,
    );
}

/** A widget's query: a report's range and comparison are given to it when it is run. */
export const reportWidgetQuery = z
  .strictObject(queryShape)
  .superRefine(checkQuery)
  .meta({ id: 'ReportWidgetQuery' });
export type ReportWidgetQuery = z.output<typeof reportWidgetQuery>;

export const reportQuery = z
  .strictObject({
    ...queryShape,
    range: reportRangeInput,
    compare: z.enum(reportCompareModes).optional().meta({
      description:
        'Also count the period of the same length just before the range, or the same days a year earlier.',
    }),
  })
  .superRefine(checkQuery)
  .meta({ id: 'ReportQuery' });
export type ReportQuery = z.output<typeof reportQuery>;

// The answer ---------------------------------------------------------------------------

const money = z.looseObject({
  currency: z.string().meta({ examples: ['KES'] }),
  amount: z.string().meta({
    description: 'A decimal, exact to four places.',
    examples: ['125000.0000'],
  }),
});

/**
 * One measure's value: a whole number for a count; for money, one amount for each currency
 * (none when nothing has a value); null where a value cannot be given, such as distinct
 * contacts in an "Other" row.
 */
export const reportCell = z.union([z.int(), z.array(money), z.null()]);
export type ReportCell = z.output<typeof reportCell>;

/** A range as the server resolved it. */
export const reportResolvedRange = z.looseObject({
  preset: z.enum(reportPresets).nullable(),
  from: reportDay.meta({ description: 'The first day, included.' }),
  to: reportDay.meta({ description: 'The last day, included.' }),
  fromInstant: timestamp.meta({
    description: "The start of the first day in the business's time zone.",
  }),
  toInstant: timestamp.meta({
    description: "The end of the last day in the business's time zone: what is dated before it.",
  }),
});
export type ReportResolvedRange = z.output<typeof reportResolvedRange>;

export const reportColumn = z.looseObject({
  key: z.string(),
  role: z.enum(['time', 'group', 'measure']),
  label: z.string(),
  kind: z.enum([
    'day',
    'week',
    'month',
    'text',
    'choice',
    'reference',
    'weekday',
    'count',
    'money',
  ]),
});

export const reportRow = z.looseObject({
  group: z
    .array(
      z.looseObject({
        key: z.string().nullable().meta({
          description:
            'A bucket by its first day; a choice by its key; a reference by its public id; text as it is. Null for rows without a value, and for "Other".',
        }),
        label: z.string().meta({
          description: 'What to show. Empty for rows without a value: the screen words those.',
        }),
      }),
    )
    .meta({ description: 'One for each time and group column, in the order of `columns`.' }),
  other: z.boolean().meta({
    description: 'True for the one row that adds up the groups past the limit.',
  }),
  values: z.array(reportCell).meta({ description: 'One for each measure, in order.' }),
  compare: z.array(reportCell).optional().meta({
    description:
      'The same measures over the comparison period, for the same group; for a bucket of time, the bucket in the same place of the comparison period.',
  }),
});
export type ReportRow = z.output<typeof reportRow>;

export const reportResult = z
  .looseObject({
    source: z.enum(reportSourceKeys),
    range: reportResolvedRange,
    timeZone: z.string().meta({
      description: "The business's time zone, by its IANA name. Days are calendar days there.",
      examples: ['Africa/Nairobi'],
    }),
    dateProperty: z.string(),
    attribution: z.enum(['first', 'latest', 'all']),
    columns: z.array(reportColumn),
    rows: z.array(reportRow),
    totals: z.array(reportCell).meta({
      description: 'Each measure over the whole range, whatever the grouping and the limit.',
    }),
    compare: z
      .looseObject({
        mode: z.enum(reportCompareModes),
        range: reportResolvedRange,
        totals: z.array(reportCell),
      })
      .optional(),
    truncated: z
      .looseObject({
        other: z.boolean().meta({
          description: 'Groups past the limit were added up in "Other" rows.',
        }),
        incomplete: z.boolean().meta({
          description: `There were more than ${String(REPORT_LIMITS.groupsRead)} groups: "Other" does not hold them all. The totals are still whole.`,
        }),
        limit: z.int().meta({ description: 'How many groups were kept.' }),
      })
      .meta({ description: 'What was cut, so a screen can say so.' }),
  })
  .meta({ id: 'ReportResult' });
export type ReportResult = z.output<typeof reportResult>;
