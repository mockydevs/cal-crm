// A form's numbers, with no database: the range of days that was asked for, and the totals
// and the row for each day made from what was counted. Days are calendar days, written
// YYYY-MM-DD; whose calendar they are is the caller's to say (the business's time zone).
import { FORM_LIMITS, type FormAnalytics } from '@repo/contracts';
import type { Issue } from '@repo/kernel';

const DAY_MS = 86_400_000;
/** Days a range covers when only its last day is known: that day and the 29 before it. */
const DEFAULT_DAYS = 30;

const at = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const dayOf = (moment: number): string => new Date(moment).toISOString().slice(0, 10);

export type AnalyticsRange =
  | { readonly ok: true; readonly from: string; readonly to: string }
  | { readonly ok: false; readonly issue: Issue };

/**
 * The days to count: the ones that were named, the last defaulting to today and the first
 * to 29 days before the last. A range the request alone could not show to be wrong (its
 * first day after today, or more days than are read at once) is refused here.
 */
export function analyticsRange(
  query: { readonly from?: string | undefined; readonly to?: string | undefined },
  today: string,
): AnalyticsRange {
  const to = query.to ?? today;
  const from = query.from ?? dayOf(at(to) - (DEFAULT_DAYS - 1) * DAY_MS);
  const days = (at(to) - at(from)) / DAY_MS + 1;
  if (days < 1)
    return {
      ok: false,
      issue: {
        path: '/from',
        code: 'range_order',
        message: 'Start the range on or before the day it ends.',
      },
    };
  if (days > FORM_LIMITS.analyticsDays)
    return {
      ok: false,
      issue: {
        path: '/from',
        code: 'range_too_long',
        message: `Ask for at most ${String(FORM_LIMITS.analyticsDays)} days at a time.`,
      },
    };
  return { ok: true, from, to };
}

/** What was counted on one day. A day with nothing has no entry. */
export interface CountedDay {
  readonly day: string;
  readonly views: number;
  readonly timedSubmissions: number;
  readonly fillSeconds: number;
}

interface Sum {
  readonly views: number;
  readonly responses: number;
  readonly timed: number;
  readonly seconds: number;
}

const numbers = (sum: Sum): FormAnalytics['totals'] => ({
  views: sum.views,
  responses: sum.responses,
  // Never over 1: a form shown on one day and sent on the next, or shown before views
  // were counted, has more responses than views for a while.
  completionRate:
    sum.views === 0 ? null : Math.min(1, Math.round((sum.responses / sum.views) * 10_000) / 10_000),
  averageSeconds: sum.timed === 0 ? null : Math.round((sum.seconds / sum.timed) * 10) / 10,
});

/** The totals of a range and one row for each of its days, in order, quiet days included. */
export function formNumbers(
  range: { readonly from: string; readonly to: string; readonly timeZone: string },
  counted: readonly CountedDay[],
  responses: ReadonlyMap<string, number>,
): FormAnalytics {
  const byDay = new Map(counted.map((each) => [each.day, each]));
  const days: FormAnalytics['days'] = [];
  let total: Sum = { views: 0, responses: 0, timed: 0, seconds: 0 };
  for (let moment = at(range.from); moment <= at(range.to); moment += DAY_MS) {
    const date = dayOf(moment);
    const found = byDay.get(date);
    const sum: Sum = {
      views: found?.views ?? 0,
      responses: responses.get(date) ?? 0,
      timed: found?.timedSubmissions ?? 0,
      seconds: found?.fillSeconds ?? 0,
    };
    days.push({ date, ...numbers(sum) });
    total = {
      views: total.views + sum.views,
      responses: total.responses + sum.responses,
      timed: total.timed + sum.timed,
      seconds: total.seconds + sum.seconds,
    };
  }
  return { from: range.from, to: range.to, timeZone: range.timeZone, totals: numbers(total), days };
}

/**
 * The whole seconds a visitor took, from the moment the server signed when it showed the
 * form to the moment it took the submission: never negative, and never more than the
 * time a shown form is accepted for.
 */
export function fillSeconds(shownAt: number, now: number): number {
  const most = FORM_LIMITS.renderHours * 3600;
  return Math.min(most, Math.max(0, Math.round((now - shownAt) / 1000)));
}
