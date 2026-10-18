import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_CANCEL_REASON_MAX,
  APPOINTMENT_LOCATION_MAX,
  APPOINTMENT_NOTES_MAX,
  appointmentDetail,
  appointmentEndpoints,
  appointmentList,
  appointmentRow,
  cancelAppointment,
  cancelAppointmentInput,
  createAppointment,
  createAppointmentInput,
  getAppointment,
  listAppointmentsQuery,
  rescheduleAppointment,
  rescheduleAppointmentInput,
  setAppointmentNotes,
  setAppointmentNotesInput,
  setAppointmentStatus,
  setAppointmentStatusInput,
} from './appointments.js';
import { toPublicId } from '@repo/kernel';

describe('the appointment list query', () => {
  it('opens Upcoming ordered by appointment time with fifty rows', () => {
    expect(listAppointmentsQuery.parse({})).toEqual({
      view: 'upcoming',
      sort: 'startsAt',
      direction: 'asc',
      limit: 50,
    });
  });
  it('accepts a title search, status and a half-open start-time window', () => {
    expect(
      listAppointmentsQuery.parse({
        view: 'all',
        q: '  Site visit  ',
        status: 'confirmed',
        from: '2026-11-01T00:00:00Z',
        to: '2026-12-01T00:00:00Z',
      }),
    ).toEqual({
      view: 'all',
      sort: 'startsAt',
      direction: 'asc',
      limit: 50,
      q: 'Site visit',
      status: 'confirmed',
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
    });
  });
  it('accepts only typed calendar, membership and appointment ids', () => {
    const calendar = toPublicId('calendar', '00000000-0000-7000-8000-000000000001');
    const user = toPublicId('membership', '00000000-0000-7000-8000-000000000002');
    const after = toPublicId('appointment', '00000000-0000-7000-8000-000000000003');
    expect(listAppointmentsQuery.parse({ calendar, user, after })).toMatchObject({
      calendar,
      user,
      after,
    });
    expect(listAppointmentsQuery.safeParse({ calendar: user }).success).toBe(false);
    expect(listAppointmentsQuery.safeParse({ user: calendar }).success).toBe(false);
    expect(listAppointmentsQuery.safeParse({ after: calendar }).success).toBe(false);
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: 'NaN' },
    { q: 'x'.repeat(201) },
    { status: 'pretend' },
    { direction: 'sideways' },
    { sort: 'sql' },
    { view: 'deleted' },
    { from: 'yesterday' },
    { extra: true },
    { from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' },
    { from: '2026-11-02T00:00:00Z', to: '2026-11-02T00:00:00Z' },
  ])('refuses an invalid filter %j', (query) => {
    expect(listAppointmentsQuery.safeParse(query).success).toBe(false);
  });
  it('allows either date bound alone and coerces valid page sizes', () => {
    expect(
      listAppointmentsQuery.parse({ from: '2026-11-02T00:00:00Z', limit: '100' }),
    ).toMatchObject({ limit: 100 });
    expect(listAppointmentsQuery.parse({ to: '2026-11-02T00:00:00Z', limit: '1' })).toMatchObject({
      limit: 1,
    });
  });
});

const ids = {
  calendar: toPublicId('calendar', '00000000-0000-7000-8000-000000000001'),
  membership: toPublicId('membership', '00000000-0000-7000-8000-000000000002'),
  appointment: toPublicId('appointment', '00000000-0000-7000-8000-000000000003'),
  contact: toPublicId('contact', '00000000-0000-7000-8000-000000000004'),
};
const row = {
  kind: 'appointment',
  id: ids.appointment,
  title: 'Site visit',
  startsAt: '2026-11-02T09:00:00.000Z',
  endsAt: '2026-11-02T09:30:00.000Z',
  status: 'confirmed',
  calendar: { id: ids.calendar, name: 'Visits' },
  contact: { id: ids.contact, name: 'Amina', trashed: false },
  assignee: { membershipId: ids.membership, you: false, name: 'Ada' },
  createdAt: '2026-11-01T09:00:00.000Z',
  source: 'user',
};
const revision = 'a'.repeat(64);

describe('the appointment list answer', () => {
  it('keeps the appointments of one contact by a contact id only', () => {
    expect(listAppointmentsQuery.parse({ contact: ids.contact })).toMatchObject({
      contact: ids.contact,
    });
    expect(listAppointmentsQuery.safeParse({ contact: ids.calendar }).success).toBe(false);
  });
  it('needs a total, and a row names its owner, when it was added and how', () => {
    const answer = { items: [row], next: null, total: 1, canManage: true };
    expect(appointmentList.parse(answer)).toEqual(answer);
    expect(appointmentList.safeParse({ ...answer, total: undefined }).success).toBe(false);
    expect(appointmentList.safeParse({ ...answer, total: -1 }).success).toBe(false);
    for (const missing of ['createdAt', 'source'] as const)
      expect(appointmentRow.safeParse({ ...row, [missing]: undefined }).success).toBe(false);
    expect(
      appointmentRow.safeParse({ ...row, assignee: { membershipId: null, you: false } }).success,
    ).toBe(false);
    expect(appointmentRow.parse({ ...row, assignee: null }).assignee).toBeNull();
    expect(appointmentRow.parse({ ...row, status: 'invalid' }).status).toBe('invalid');
    expect(appointmentRow.safeParse({ ...row, source: 'fax' }).success).toBe(false);
  });
  it('lists the seven endpoints, each under its own operation', () => {
    expect(appointmentEndpoints.map((endpoint) => endpoint.operationId)).toEqual([
      'listAppointments',
      'createAppointment',
      'getAppointment',
      'rescheduleAppointment',
      'cancelAppointment',
      'setAppointmentStatus',
      'setAppointmentNotes',
    ]);
  });
});

describe('one appointment', () => {
  const detail = {
    ...row,
    notes: 'Bring the plans.',
    location: null,
    timezone: 'Africa/Nairobi',
    updatedAt: '2026-11-01T09:00:00.000Z',
    cancelledAt: null,
    cancelReason: null,
    createdBy: { name: 'Ada' },
    revision,
    canManage: true,
    history: [
      {
        type: 'status_changed',
        at: '2026-11-01T10:00:00.000Z',
        actor: { kind: 'user', name: 'Ada' },
        status: 'confirmed',
        previousStatus: 'booked',
      },
    ],
  };
  it('carries its notes, place, zone, who booked it, a revision and its history', () => {
    expect(appointmentDetail.parse(detail)).toEqual(detail);
    expect(appointmentDetail.parse({ ...detail, createdBy: null }).createdBy).toBeNull();
    for (const missing of ['notes', 'timezone', 'revision', 'history', 'canManage'] as const)
      expect(appointmentDetail.safeParse({ ...detail, [missing]: undefined }).success).toBe(false);
    expect(appointmentDetail.safeParse({ ...detail, revision: 'short' }).success).toBe(false);
    expect(
      appointmentDetail.safeParse({
        ...detail,
        history: [{ type: 'deleted', at: detail.updatedAt, actor: { kind: 'user', name: null } }],
      }).success,
    ).toBe(false);
  });
});

describe('booking an appointment as the team', () => {
  const base = {
    requestId: '00000000-0000-4000-8000-000000000009',
    calendarId: ids.calendar,
    contactId: ids.contact,
    startsAt: '2026-11-02T09:00:00Z',
  };
  it('is confirmed, without notes and by the slots of the calendar unless said otherwise', () => {
    expect(createAppointmentInput.parse(base)).toEqual({
      ...base,
      status: 'confirmed',
      notes: '',
      ignoreAvailability: false,
    });
    expect(
      createAppointmentInput.parse({
        ...base,
        assignee: ids.membership,
        title: '  Roof survey ',
        status: 'booked',
        location: ' Gate B ',
        notes: 'Bring the plans.',
        ignoreAvailability: true,
        endsAt: '2026-11-02T10:15:00Z',
      }),
    ).toMatchObject({ title: 'Roof survey', location: 'Gate B', status: 'booked' });
  });
  it.each([
    [{ endsAt: '2026-11-02T10:00:00Z' }, 'end_not_allowed'],
    [{ ignoreAvailability: true }, 'end_required'],
    [{ ignoreAvailability: true, endsAt: '2026-11-02T09:00:00Z' }, 'window_order'],
    [{ ignoreAvailability: true, endsAt: '2026-11-02T08:00:00Z' }, 'window_order'],
  ])('says when it ends only when availability is set aside: %j', (more, code) => {
    const parsed = createAppointmentInput.safeParse({ ...base, ...more });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ['endsAt'], params: { code } });
    const moved = rescheduleAppointmentInput.safeParse({
      revision,
      startsAt: base.startsAt,
      ...more,
    });
    expect(moved.error?.issues[0]).toMatchObject({ path: ['endsAt'], params: { code } });
  });
  it.each([
    { requestId: 'not-a-uuid' },
    { calendarId: ids.contact },
    { contactId: ids.calendar },
    { assignee: ids.calendar },
    { startsAt: 'tomorrow' },
    { title: ' ' },
    { title: 'x'.repeat(201) },
    { status: 'cancelled' },
    { location: 'x'.repeat(APPOINTMENT_LOCATION_MAX + 1) },
    { notes: 'x'.repeat(APPOINTMENT_NOTES_MAX + 1) },
    { extra: true },
  ])('refuses %j', (more) => {
    expect(createAppointmentInput.safeParse({ ...base, ...more }).success).toBe(false);
  });
});

describe('changing an appointment', () => {
  it('moves it with the revision the screen holds', () => {
    expect(
      rescheduleAppointmentInput.parse({ revision, startsAt: '2026-11-03T09:00:00Z' }),
    ).toEqual({ revision, startsAt: '2026-11-03T09:00:00Z', ignoreAvailability: false });
    expect(rescheduleAppointmentInput.safeParse({ startsAt: '2026-11-03T09:00:00Z' }).success).toBe(
      false,
    );
    expect(
      rescheduleAppointmentInput.safeParse({ revision, startsAt: '2026-11-03T09:00:00Z', x: 1 })
        .success,
    ).toBe(false);
  });
  it('cancels it with or without a reason of at most 500 characters', () => {
    expect(cancelAppointmentInput.parse({ revision })).toEqual({ revision });
    expect(cancelAppointmentInput.parse({ revision, reason: ' Asked to. ' }).reason).toBe(
      'Asked to.',
    );
    for (const reason of ['', ' ', 'x'.repeat(APPOINTMENT_CANCEL_REASON_MAX + 1)])
      expect(cancelAppointmentInput.safeParse({ revision, reason }).success).toBe(false);
    expect(cancelAppointmentInput.safeParse({}).success).toBe(false);
  });
  it('sets any of the six statuses, and no other word', () => {
    for (const status of ['booked', 'confirmed', 'cancelled', 'no_show', 'completed', 'invalid'])
      expect(setAppointmentStatusInput.parse({ revision, status })).toEqual({ revision, status });
    expect(setAppointmentStatusInput.safeParse({ revision, status: 'showed' }).success).toBe(false);
    expect(setAppointmentStatusInput.safeParse({ status: 'invalid' }).success).toBe(false);
  });
  it('replaces the notes with at most 5,000 characters, kept as written, or clears them', () => {
    const notes = '  Bring the floor plans.\n\nAsk about parking.  ';
    expect(setAppointmentNotesInput.parse({ revision, notes })).toEqual({ revision, notes });
    expect(setAppointmentNotesInput.parse({ revision, notes: '' }).notes).toBe('');
    expect(
      setAppointmentNotesInput.parse({ revision, notes: 'x'.repeat(APPOINTMENT_NOTES_MAX) }).notes,
    ).toHaveLength(APPOINTMENT_NOTES_MAX);
    expect(
      setAppointmentNotesInput.safeParse({ revision, notes: 'x'.repeat(APPOINTMENT_NOTES_MAX + 1) })
        .success,
    ).toBe(false);
    expect(setAppointmentNotesInput.safeParse({ revision }).success).toBe(false);
    expect(setAppointmentNotesInput.safeParse({ notes: 'No revision.' }).success).toBe(false);
    expect(
      setAppointmentNotesInput.safeParse({ revision, notes: 'x', title: 'Not here' }).success,
    ).toBe(false);
    expect(setAppointmentNotes.method).toBe('put');
    expect(setAppointmentNotes.path).toBe('/appointments/{id}/notes');
  });
  it('takes an appointment id in its address, and nothing else there', () => {
    for (const endpoint of [
      getAppointment,
      rescheduleAppointment,
      cancelAppointment,
      setAppointmentStatus,
      setAppointmentNotes,
    ]) {
      expect(endpoint.params.parse({ id: ids.appointment })).toEqual({ id: ids.appointment });
      expect(endpoint.params.safeParse({ id: ids.calendar }).success).toBe(false);
    }
    expect(createAppointment.response.status).toBe(201);
  });
});
