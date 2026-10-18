// The numbers behind the Dashboard's opportunity widgets: Opportunity status, Opportunity
// value, Conversion rate, Funnel and Stages distribution, for one pipeline over a range of
// dates. They are counted from the deals themselves in the request: daily rollups and the
// Reports screen are separate.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The longest range one read covers: three years. */
export const OPPORTUNITY_REPORT_MAX_DAYS = 1096;

const DAY = 86_400_000;

/**
 * Which of a deal's dates must fall in the range: when its status last became what it is
 * (its creation, a close or a reopening), or when it was created.
 */
export const opportunityReportDates = ['status_changed', 'created'] as const;
export type OpportunityReportDate = (typeof opportunityReportDates)[number];

export const opportunityReportQuery = z
  .strictObject({
    pipelineId: publicId('pipeline'),
    from: timestamp.meta({ description: 'The start of the range: deals dated at or after it.' }),
    to: timestamp.meta({
      description: `The end of the range: deals dated before it. After the start, and at most ${String(OPPORTUNITY_REPORT_MAX_DAYS)} days from it.`,
    }),
    dateProperty: z.enum(opportunityReportDates).default('status_changed'),
  })
  .superRefine((query, context) => {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    if (!(to > from))
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'End the range after it starts.',
        params: { code: 'range_order' },
      });
    else if (to - from > OPPORTUNITY_REPORT_MAX_DAYS * DAY)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Ask for at most ${String(OPPORTUNITY_REPORT_MAX_DAYS)} days at a time.`,
        params: { code: 'range_too_long' },
      });
  })
  .meta({ id: 'OpportunityReportQuery' });

const totals = z
  .array(
    z.looseObject({
      currency: z.string().meta({ examples: ['KES'] }),
      amount: z.string().meta({
        description: 'The sum as a decimal, exact to four places.',
        examples: ['125000.0000'],
      }),
    }),
  )
  .meta({
    description:
      'One sum for each currency, by currency code. Amounts in different currencies are never added together, and a deal without an amount adds nothing.',
  });
const tally = { count: z.int().min(0), totals };
const rate = z.number().min(0).max(1).nullable();

export const opportunityReport = z
  .looseObject({
    pipelineId: publicId('pipeline'),
    from: timestamp,
    to: timestamp,
    dateProperty: z.enum(opportunityReportDates),
    count: z.int().min(0).meta({ description: 'Every deal the range holds, whatever its status.' }),
    statuses: z.array(z.looseObject({ status: z.enum(['open', 'won', 'lost']), ...tally })).meta({
      description:
        'Opportunity status and Opportunity value: how many deals have each status, and what they add up to. Always open, won and lost, in that order.',
    }),
    conversion: z
      .looseObject({
        won: z.int().min(0),
        total: z.int().min(0),
        rate: rate.meta({
          description:
            'Won deals over all deals of the range, from 0 to 1. Null when there are none.',
        }),
        wonTotals: totals,
      })
      .meta({ description: 'Conversion rate, with the revenue of the deals won.' }),
    funnel: z
      .array(
        z.looseObject({
          stageId: publicId('stage'),
          name: z.string(),
          ...tally,
          cumulativeRate: rate.meta({
            description:
              "This section's deals over the first section's. Null when the first is empty.",
          }),
          nextStepRate: rate.meta({
            description:
              "This section's deals over the section before it. Null for the first, and when the one before is empty.",
          }),
        }),
      )
      .meta({
        description:
          'Funnel: one section for each active stage, in order. A section counts the open and won deals that are in its stage or a later one, so each is at most the one before. Lost deals are in no section.',
      }),
    stages: z
      .array(
        z.looseObject({
          stageId: publicId('stage'),
          name: z.string(),
          archived: z.boolean(),
          ...tally,
        }),
      )
      .meta({
        description:
          'Stages distribution: the open deals in each stage, in order. Every active stage is listed; an archived one only while an open deal is in it. Won and lost deals are apart, under statuses.',
      }),
  })
  .meta({ id: 'OpportunityReport' });
export type OpportunityReport = z.output<typeof opportunityReport>;

export const getOpportunityReport = defineEndpoint({
  operationId: 'getOpportunityReport',
  method: 'get',
  path: '/reports/opportunities',
  summary:
    "Read the numbers of the dashboard's opportunity widgets for a pipeline and a range of dates",
  group: 'Reports',
  query: opportunityReportQuery,
  response: {
    status: 200,
    description:
      'Counted from the deals not in the trash whose date falls in the range, as they are now: a deal moved or closed since is counted where it is today.',
    schema: opportunityReport,
  },
});

export const opportunityReportEndpoints = [getOpportunityReport] as const;
