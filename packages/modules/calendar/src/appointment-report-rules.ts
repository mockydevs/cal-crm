// The Dashboard's booking numbers, put together from one count of a business's appointments
// by day, by calendar and by assignee. Pure: no clock, no database. appointment-report.ts
// does the counting and names the calendars and people.
import { appointmentStatuses, type AppointmentReport } from '@repo/contracts';

type Status = (typeof appointmentStatuses)[number];

/**
 * How many appointments share a status and one key: a calendar day of the business
 * (YYYY-MM-DD), a calendar's id, or an assignee's user id (empty: nobody is assigned).
 * Every appointment of the range is counted once under each of the three.
 */
export interface AppointmentCount {
  readonly by: 'day' | 'calendar' | 'assignee';
  readonly key: string;
  readonly status: Status;
  readonly count: number;
}

type Tally = Pick<AppointmentReport, 'count' | 'statuses'>;
type Numbers = Pick<AppointmentReport, 'count' | 'statuses' | 'days' | 'calendars' | 'teamMembers'>;

export interface ReportNames {
  /** Each calendar's name, by its stored id. */
  readonly calendars: ReadonlyMap<string, { readonly id: string; readonly name: string }>;
  /** Each assignee as the API shows a person, by user id. */
  readonly people: ReadonlyMap<
    string,
    { readonly membershipId: string | null; readonly name: string }
  >;
}

/** The counts added up, with every status named in the contract's order. */
export function tally(counts: readonly AppointmentCount[]): Tally {
  return {
    count: counts.reduce((total, each) => total + each.count, 0),
    statuses: appointmentStatuses.map((status) => ({
      status,
      count: counts
        .filter((each) => each.status === status)
        .reduce((total, each) => total + each.count, 0),
    })),
  };
}

/** The counts of one kind, gathered by their key in the order the keys first appear. */
function gathered(
  counts: readonly AppointmentCount[],
  by: AppointmentCount['by'],
): Map<string, AppointmentCount[]> {
  const groups = new Map<string, AppointmentCount[]>();
  for (const each of counts) {
    if (each.by !== by) continue;
    const group = groups.get(each.key);
    if (group === undefined) groups.set(each.key, [each]);
    else group.push(each);
  }
  return groups;
}

// U+FFFF has the highest weight a collation gives: after every name.
const LAST = '\uFFFF';

/** The busiest first, then by name. */
function ranked<Row extends Tally>(rows: readonly Row[], nameOf: (row: Row) => string): Row[] {
  return [...rows].sort(
    (left, right) => right.count - left.count || nameOf(left).localeCompare(nameOf(right)),
  );
}

/**
 * The report's numbers. `days` is every calendar day of the range, in order: a day without
 * appointments is a row of zeros. The totals are those of the days. A calendar without a
 * name here is not listed (it is not this business's); an assignee without one is listed
 * with no name and no membership, as someone who left the team is.
 */
export function appointmentNumbers(
  days: readonly string[],
  counts: readonly AppointmentCount[],
  names: ReportNames,
): Numbers {
  const byDay = gathered(counts, 'day');
  const dated = days.flatMap((date) => byDay.get(date) ?? []);
  return {
    ...tally(dated),
    days: days.map((date) => ({ date, ...tally(byDay.get(date) ?? []) })),
    calendars: ranked(
      [...gathered(counts, 'calendar')].flatMap(([key, group]) => {
        const calendar = names.calendars.get(key);
        return calendar === undefined ? [] : [{ calendar, ...tally(group) }];
      }),
      (row) => row.calendar.name,
    ),
    teamMembers: ranked(
      [...gathered(counts, 'assignee')].map(([key, group]) => ({
        assignee: key === '' ? null : (names.people.get(key) ?? { membershipId: null, name: '' }),
        ...tally(group),
      })),
      // Nobody assigned: last among rows as busy.
      (row) => row.assignee?.name ?? LAST,
    ),
  };
}
