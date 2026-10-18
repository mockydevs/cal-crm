// The range of dates the Dashboard's email and booking numbers are read over: two instants,
// as the opportunity numbers take them, and no longer than those allow. The days of the
// answer are the business's own calendar days.
import * as z from 'zod';

import { OPPORTUNITY_REPORT_MAX_DAYS } from './opportunity-report.js';
import { timestamp } from './timestamps.js';

const DAY = 86_400_000;

/** `from` and `to`, for a report's query. */
export const reportRange = {
  from: timestamp.meta({ description: 'The start of the range: what is dated at or after it.' }),
  to: timestamp.meta({
    description: `The end of the range: what is dated before it. After the start, and at most ${String(OPPORTUNITY_REPORT_MAX_DAYS)} days from it.`,
  }),
};

/** Refuses a range that ends before it starts, or is longer than the opportunity numbers allow. */
export function checkReportRange(
  query: { readonly from: string; readonly to: string },
  context: z.RefinementCtx,
): void {
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
}

/** A calendar day of the business, as its own time zone has it. */
export const reportDay = z.iso.date().meta({ examples: ['2026-10-07'] });

/** What every report says about the range it counted. */
export const reportRangeAnswer = {
  from: timestamp,
  to: timestamp,
  timeZone: z.string().meta({
    description:
      "The business's time zone, by its IANA name. The days of the answer are calendar days there.",
    examples: ['Africa/Nairobi'],
  }),
};
