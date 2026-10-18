// What the Enrollment history and Execution logs tabs work out before they ask: the
// moments a pair of calendar days stands for, in the reader's own time zone.

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight at the start of a calendar day here, a number of days on, as the API reads it. */
function startOf(day: string, daysOn: number): string | undefined {
  const match = DAY.exec(day);
  if (match === null) return undefined;
  // A day past the end of its month is the day it runs on to, as the calendar counts.
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + daysOn).toISOString();
}

export interface Moments {
  /** Included. */
  readonly from?: string;
  /** Not included. */
  readonly to?: string;
}

/**
 * The range two days chosen in the date boxes stand for: from the start of the first to the
 * end of the last, both days included. A box left empty leaves that side open.
 */
export function momentsOf(firstDay: string, lastDay: string): Moments {
  const from = startOf(firstDay, 0);
  const to = startOf(lastDay, 1);
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/** The statuses one step of a run can have, in the order the filter lists them. */
export const stepStatuses = ['succeeded', 'waiting', 'running', 'failed', 'skipped'] as const;
export type StepStatus = (typeof stepStatuses)[number];
