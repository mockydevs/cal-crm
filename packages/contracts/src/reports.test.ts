// What the Dashboard's email and booking numbers are asked with, and what they answer. The
// numbers themselves are the modules' to prove.
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_REPORT_UPCOMING_DAYS,
  OPPORTUNITY_REPORT_MAX_DAYS,
  appointmentReport,
  appointmentReportQuery,
  appointmentStatuses,
  emailReport,
  emailReportQuery,
  emailReportSenders,
  endpoints,
  getAppointmentReport,
  getEmailReport,
} from './index.js';

const uuid = (last: number) => `01890a5d-ac96-774b-bcce-b302099a${String(last).padStart(4, '0')}`;
const range = { from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' };
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.map(String).join('/')) ?? [];
const answered = { ...range, timeZone: 'Africa/Nairobi' };

describe.each([
  ['email', emailReportQuery],
  ['booking', appointmentReportQuery],
] as const)("the range of the dashboard's %s numbers", (_name, query) => {
  it('is two instants, the second after the first', () => {
    expect(query.parse(range)).toMatchObject(range);
    expect(paths(query.safeParse({ ...range, to: range.from }))).toEqual(['to']);
    expect(paths(query.safeParse({ from: range.to, to: range.from }))).toEqual(['to']);
    for (const refused of [{}, { from: range.from }, { ...range, from: '2026-03-01' }])
      expect(query.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
  });

  it('is no longer than the opportunity numbers allow', () => {
    expect(OPPORTUNITY_REPORT_MAX_DAYS).toBe(1096);
    expect(
      query.safeParse({ from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }).success,
    ).toBe(true);
    expect(
      paths(query.safeParse({ from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00.001Z' })),
    ).toEqual(['to']);
  });

  it('takes nothing it does not know', () => {
    expect(query.safeParse({ ...range, timeZone: 'UTC' }).success).toBe(false);
    expect(query.safeParse({ ...range, pipelineId: 'x' }).success).toBe(false);
  });
});

describe("the dashboard's email numbers", () => {
  const counts = { sent: 12, notSent: 4, bounced: 3, received: 5, replies: 2, unsubscribed: 1 };
  const answer = {
    ...answered,
    totals: { ...counts, hardBounced: 2 },
    notSentReasons: [
      { reason: 'consent_required', count: 3 },
      { reason: 'suppressed', count: 1 },
    ],
    senders: emailReportSenders.map((sender, index) => ({ sender, count: index })),
    days: [{ date: '2026-03-01', ...counts }],
  };

  it('are asked with a range alone', () => {
    expect(emailReportQuery.parse(range)).toEqual(range);
    expect(getEmailReport).toMatchObject({
      operationId: 'getEmailReport',
      method: 'get',
      path: '/reports/email',
      group: 'Reports',
    });
  });

  it('are answered as counts for the range and for each of its days', () => {
    expect(emailReport.parse(answer)).toEqual(answer);
    expect(emailReport.safeParse({ ...answer, notSentReasons: [], days: [] }).success).toBe(true);
    for (const wrong of [
      { ...answer, totals: { ...answer.totals, sent: -1 } },
      { ...answer, totals: { ...answer.totals, sent: 1.5 } },
      { ...answer, totals: counts },
      { ...answer, senders: [{ sender: 'campaign', count: 1 }] },
      { ...answer, days: [{ date: '2026-03-01T00:00:00Z', ...counts }] },
      { ...answer, days: [{ date: '2026-03-01', ...counts, replies: undefined }] },
      { ...answer, timeZone: undefined },
    ])
      expect(emailReport.safeParse(wrong).success, JSON.stringify(wrong).slice(0, 90)).toBe(false);
  });

  it('promise nothing this server does not record: no opens, clicks or delivery', () => {
    const promised = [
      ...Object.keys(emailReport.shape),
      ...Object.keys(emailReport.shape.totals.shape),
      ...Object.keys(emailReport.shape.days.element.shape),
    ];
    for (const name of promised) expect(name).not.toMatch(/open|click|deliver/i);
    expect(emailReportSenders).toEqual(['workflow', 'person', 'assistant', 'other']);
  });
});

describe("the dashboard's booking numbers", () => {
  const statuses = appointmentStatuses.map((status, index) => ({ status, count: index }));
  const tally = { count: 15, statuses };
  const answer = {
    ...answered,
    dateProperty: 'starts',
    ...tally,
    days: [{ date: '2026-03-01', ...tally }],
    calendars: [
      { calendar: { id: toPublicId('calendar', uuid(1)), name: 'Site visits' }, ...tally },
    ],
    teamMembers: [
      {
        assignee: { membershipId: toPublicId('membership', uuid(2)), name: 'Ada Owner' },
        ...tally,
      },
      { assignee: { membershipId: null, name: '' }, ...tally },
      { assignee: null, ...tally },
    ],
    upcoming: { from: '2026-10-12T09:00:00.000Z', to: '2026-10-19T09:00:00.000Z', count: 4 },
  };

  it('are asked by when an appointment starts, unless told by when it was booked', () => {
    expect(appointmentReportQuery.parse(range)).toEqual({ ...range, dateProperty: 'starts' });
    expect(appointmentReportQuery.parse({ ...range, dateProperty: 'created' }).dateProperty).toBe(
      'created',
    );
    expect(appointmentReportQuery.safeParse({ ...range, dateProperty: 'ends' }).success).toBe(
      false,
    );
    expect(getAppointmentReport).toMatchObject({
      operationId: 'getAppointmentReport',
      method: 'get',
      path: '/reports/appointments',
      group: 'Reports',
    });
  });

  it('are answered by status for the range, each day, each calendar and each person', () => {
    expect(appointmentReport.parse(answer)).toEqual(answer);
    expect(
      appointmentReport.safeParse({ ...answer, days: [], calendars: [], teamMembers: [] }).success,
    ).toBe(true);
    for (const wrong of [
      { ...answer, statuses: [{ status: 'showed', count: 1 }] },
      { ...answer, statuses: [{ status: 'booked', count: -1 }] },
      { ...answer, dateProperty: 'ends' },
      { ...answer, calendars: [{ calendar: { id: uuid(1), name: 'Raw id' }, ...tally }] },
      {
        ...answer,
        teamMembers: [{ assignee: { membershipId: uuid(2), name: 'Raw id' }, ...tally }],
      },
      { ...answer, upcoming: { ...answer.upcoming, count: -1 } },
      { ...answer, upcoming: undefined },
    ])
      expect(appointmentReport.safeParse(wrong).success, JSON.stringify(wrong).slice(0, 90)).toBe(
        false,
      );
  });

  it('use the statuses an appointment has, and look a week ahead', () => {
    expect(appointmentStatuses).toEqual([
      'booked',
      'confirmed',
      'cancelled',
      'no_show',
      'completed',
      'invalid',
    ]);
    expect(APPOINTMENT_REPORT_UPCOMING_DAYS).toBe(7);
    expect(Object.keys(appointmentReport.shape)).not.toContain('rescheduled');
  });
});

describe('the reports', () => {
  it('are each described once in the API', () => {
    for (const operationId of ['getEmailReport', 'getAppointmentReport'])
      expect(
        endpoints.filter((endpoint) => endpoint.operationId === operationId),
        operationId,
      ).toHaveLength(1);
  });
});
