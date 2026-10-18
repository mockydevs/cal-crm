// The Dashboard's booking numbers, worked out by hand for a few days of counts and held
// against the rules. No database: appointment-report.int.test.ts counts real appointments.
import { describe, expect, it } from 'vitest';

import {
  appointmentNumbers,
  tally,
  type AppointmentCount,
  type ReportNames,
} from './appointment-report-rules.js';

const DAYS = ['2026-03-01', '2026-03-02', '2026-03-03'];
const count = (
  by: AppointmentCount['by'],
  key: string,
  status: AppointmentCount['status'],
  n: number,
): AppointmentCount => ({ by, key, status, count: n });
/** Every status in the contract's order, with the counts given and zero for the rest. */
const statuses = (counts: Partial<Record<AppointmentCount['status'], number>> = {}) =>
  (['booked', 'confirmed', 'cancelled', 'no_show', 'completed', 'invalid'] as const).map(
    (status) => ({ status, count: counts[status] ?? 0 }),
  );
const NAMES: ReportNames = {
  calendars: new Map([
    ['c1', { id: 'cal_visits', name: 'Visits' }],
    ['c2', { id: 'cal_calls', name: 'Calls' }],
  ]),
  people: new Map([
    ['u1', { membershipId: 'mem_ada', name: 'Ada Owner' }],
    ['u2', { membershipId: 'mem_ben', name: 'Ben Staff' }],
  ]),
};

describe('adding appointments up', () => {
  it('names every status in order, with zero where there is none', () => {
    expect(tally([])).toEqual({ count: 0, statuses: statuses() });
    expect(
      tally([
        count('day', '2026-03-01', 'completed', 2),
        count('day', '2026-03-02', 'completed', 3),
        count('day', '2026-03-02', 'no_show', 1),
      ]),
    ).toEqual({ count: 6, statuses: statuses({ completed: 5, no_show: 1 }) });
  });
});

describe('the booking numbers of a range', () => {
  it('are zeros for every day when there are no appointments', () => {
    expect(appointmentNumbers(DAYS, [], NAMES)).toEqual({
      count: 0,
      statuses: statuses(),
      days: DAYS.map((date) => ({ date, count: 0, statuses: statuses() })),
      calendars: [],
      teamMembers: [],
    });
  });

  it('count each day by status, and total the days', () => {
    const numbers = appointmentNumbers(
      DAYS,
      [
        count('day', '2026-03-01', 'booked', 2),
        count('day', '2026-03-01', 'cancelled', 1),
        count('day', '2026-03-03', 'completed', 4),
        count('day', '2026-03-03', 'booked', 1),
      ],
      NAMES,
    );
    expect(numbers.days).toEqual([
      { date: '2026-03-01', count: 3, statuses: statuses({ booked: 2, cancelled: 1 }) },
      { date: '2026-03-02', count: 0, statuses: statuses() },
      { date: '2026-03-03', count: 5, statuses: statuses({ booked: 1, completed: 4 }) },
    ]);
    expect(numbers.count).toBe(8);
    expect(numbers.statuses).toEqual(statuses({ booked: 3, cancelled: 1, completed: 4 }));
  });

  it('list the calendars with appointments, the busiest first and then by name', () => {
    const { calendars } = appointmentNumbers(
      DAYS,
      [
        count('calendar', 'c1', 'booked', 2),
        count('calendar', 'c2', 'booked', 1),
        count('calendar', 'c2', 'no_show', 1),
        // Not one of this business's calendars by name: it is not listed.
        count('calendar', 'c9', 'booked', 9),
      ],
      NAMES,
    );
    expect(calendars).toEqual([
      {
        calendar: { id: 'cal_calls', name: 'Calls' },
        count: 2,
        statuses: statuses({ booked: 1, no_show: 1 }),
      },
      {
        calendar: { id: 'cal_visits', name: 'Visits' },
        count: 2,
        statuses: statuses({ booked: 2 }),
      },
    ]);
  });

  it('list the people assigned, the unassigned as a row of their own, and someone who left without a name', () => {
    const { teamMembers } = appointmentNumbers(
      DAYS,
      [
        count('assignee', '', 'booked', 3),
        count('assignee', 'u2', 'confirmed', 3),
        count('assignee', 'u1', 'completed', 5),
        count('assignee', 'u1', 'cancelled', 1),
        count('assignee', 'gone', 'completed', 3),
      ],
      NAMES,
    );
    expect(teamMembers).toEqual([
      {
        assignee: { membershipId: 'mem_ada', name: 'Ada Owner' },
        count: 6,
        statuses: statuses({ completed: 5, cancelled: 1 }),
      },
      {
        assignee: { membershipId: null, name: '' },
        count: 3,
        statuses: statuses({ completed: 3 }),
      },
      {
        assignee: { membershipId: 'mem_ben', name: 'Ben Staff' },
        count: 3,
        statuses: statuses({ confirmed: 3 }),
      },
      { assignee: null, count: 3, statuses: statuses({ booked: 3 }) },
    ]);
  });

  it('leave a day outside the range out of the rows and the totals', () => {
    const numbers = appointmentNumbers(
      DAYS,
      [count('day', '2026-02-28', 'booked', 7), count('day', '2026-03-02', 'booked', 1)],
      NAMES,
    );
    expect(numbers.count).toBe(1);
    expect(numbers.days.map((day) => day.count)).toEqual([0, 1, 0]);
  });
});
