import { expect, it } from 'vitest';
import { BOOKING_NOTIFICATION_WORDING, publicBookingInput } from './booking.js';

const validBooking = {
  bookingRequestId: '5ef5926d-d3b7-4b95-a513-198a51a2c5d1',
  startsAt: '2026-11-01T05:30:00Z',
  contact: { firstName: 'Maya', email: ' maya@EXAMPLE.test ' },
  notificationConsent: true,
  contactTimezone: 'Africa/Nairobi',
  renderToken: `1793000000000.${'A'.repeat(43)}`,
};

it('refuses caller-controlled booking scope, duration and privileged contact fields', () => {
  for (const injected of [
    { businessId: 'other' },
    { contactId: 'other' },
    { assignedUserId: 'other' },
    { endsAt: '2026-11-01T10:00:00Z' },
  ])
    expect(publicBookingInput.safeParse({ ...validBooking, ...injected }).success).toBe(false);
  for (const injected of [
    { doNotContact: false },
    { ownerUserId: 'other' },
    { aiSource: 'forms' },
    { confidence: 1 },
  ])
    expect(
      publicBookingInput.safeParse({
        ...validBooking,
        contact: { ...validBooking.contact, ...injected },
      }).success,
    ).toBe(false);
  expect(publicBookingInput.parse(validBooking).contact.email).toBe('maya@example.test');
});

it('refuses unbounded or malformed instants before slot lookup', () => {
  for (const startsAt of [
    '0000-01-01T00:00:00Z',
    '+010000-01-01T00:00:00Z',
    '2026-02-30T10:00:00Z',
    '2026-11-01T05:30:00',
    '2026-11-01T05:30:00Z '.repeat(100),
  ]) {
    expect(publicBookingInput.safeParse({ ...validBooking, startsAt }).success).toBe(false);
  }
  expect(
    publicBookingInput.safeParse({ ...validBooking, startsAt: '0099-01-01T00:00:00Z' }).success,
  ).toBe(true);
  expect(
    publicBookingInput.safeParse({ ...validBooking, startsAt: '2026-11-01T08:30:00+03:00' })
      .success,
  ).toBe(true);
});

it('bounds management capabilities without accepting whitespace or alternative encodings', async () => {
  const { appointmentCapability } = await import('./booking.js');
  expect(appointmentCapability.safeParse('A'.repeat(43)).success).toBe(true);
  for (const token of [
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}B`,
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(42)}+`,
    ` ${'A'.repeat(43)}`,
    `${'A'.repeat(43)}/contact`,
  ]) {
    expect(appointmentCapability.safeParse(token).success).toBe(false);
  }
});

it('requires distinct operation keys and a bounded revision for appointment changes', async () => {
  const { publicCancellationInput, publicRescheduleInput } = await import('./booking.js');
  const operation = { operationRequestId: validBooking.bookingRequestId, revision: 'a'.repeat(64) };
  expect(publicCancellationInput.safeParse(operation).success).toBe(true);
  expect(
    publicRescheduleInput.safeParse({ ...operation, startsAt: validBooking.startsAt }).success,
  ).toBe(true);
  for (const invalid of [
    { ...operation, operationRequestId: 'arbitrary' },
    { ...operation, revision: 'a'.repeat(63) },
    { ...operation, revision: 'A'.repeat(64) },
    { ...operation, contactId: 'other' },
    { revision: operation.revision },
  ]) {
    expect(publicCancellationInput.safeParse(invalid).success).toBe(false);
    expect(
      publicRescheduleInput.safeParse({ ...invalid, startsAt: validBooking.startsAt }).success,
    ).toBe(false);
  }
  expect(
    publicCancellationInput.safeParse({ ...operation, startsAt: validBooking.startsAt }).success,
  ).toBe(false);
  expect(publicRescheduleInput.safeParse(operation).success).toBe(false);
  expect(
    publicRescheduleInput.safeParse({ ...operation, startsAt: '0000-01-01T00:00:00Z' }).success,
  ).toBe(false);
});

it('keeps public receipts minimal and never accepts private contact or member data', async () => {
  const { publicAppointmentReceipt, publicBookingReceipt } = await import('./booking.js');
  const receipt = {
    status: 'booked',
    startsAt: validBooking.startsAt,
    endsAt: '2026-11-01T06:00:00Z',
  };
  expect(publicAppointmentReceipt.safeParse(receipt).success).toBe(true);
  expect(publicBookingReceipt.safeParse(receipt).success).toBe(true);
  expect(
    publicBookingReceipt.safeParse({
      ...receipt,
      managementUrl: 'https://crm.example.test/appointments/' + 'A'.repeat(43),
    }).success,
  ).toBe(true);
  for (const privateField of [
    { contactId: 'other' },
    { contact: { email: 'private@example.test' } },
    { assignedUserId: 'other' },
    { senderAddress: 'private@example.test' },
    { token: 'A'.repeat(43) },
  ]) {
    expect(publicAppointmentReceipt.safeParse({ ...receipt, ...privateField }).success).toBe(false);
    expect(publicBookingReceipt.safeParse({ ...receipt, ...privateField }).success).toBe(false);
  }
  expect(
    publicAppointmentReceipt.safeParse({
      ...receipt,
      managementUrl: 'https://crm.example.test/private',
    }).success,
  ).toBe(false);
  expect(
    publicBookingReceipt.safeParse({ ...receipt, managementUrl: 'javascript:alert(1)' }).success,
  ).toBe(false);
});

it('bounds public calendar scope and one local slot date without accepting identity queries', async () => {
  const { publicCalendarParams, publicSlotQuery } = await import('./booking.js');
  const params = {
    agencySlug: 'agency',
    businessSlug: 'harbor-lights',
    calendarSlug: 'consultation',
  };
  expect(publicCalendarParams.safeParse(params).success).toBe(true);
  for (const calendarSlug of [
    '../private',
    'calendar/other',
    'Calendar',
    'cаlendar',
    'a'.repeat(64),
  ]) {
    expect(publicCalendarParams.safeParse({ ...params, calendarSlug }).success).toBe(false);
  }
  expect(publicCalendarParams.safeParse({ ...params, businessId: 'other' }).success).toBe(false);
  expect(publicSlotQuery.safeParse({ date: '2026-11-01' }).success).toBe(true);
  for (const query of [
    { date: '0000-01-01' },
    { date: '2026-02-30' },
    { date: '2026-11-01', assignedUserId: 'other' },
    { date: ['2026-11-01', '2026-11-02'] },
  ]) {
    expect(publicSlotQuery.safeParse(query).success).toBe(false);
  }
});

it('describes eight public operations under the public API scope with minimal validated responses', async () => {
  const { publicBookingEndpoints, publicCalendarPage, publicAppointmentPage } =
    await import('./booking.js');
  expect(publicBookingEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
    'get /public/book/{agencySlug}/{businessSlug}/{calendarSlug}',
    'get /public/book/{agencySlug}/{businessSlug}/{calendarSlug}/slots',
    'post /public/book/{agencySlug}/{businessSlug}/{calendarSlug}/appointments',
    'get /public/appointments/{token}',
    'post /public/appointments/{token}/cancel',
    'post /public/appointments/{token}/reschedule',
    'get /public/appointments/{token}/slots',
    // The bot challenge of a calendar that asks for one.
    'post /public/book/{agencySlug}/{businessSlug}/{calendarSlug}/challenge',
  ]);
  expect(new Set(publicBookingEndpoints.map((endpoint) => endpoint.operationId)).size).toBe(8);
  const calendar = {
    name: 'Consultation',
    description: 'Discuss an event',
    timezone: 'America/New_York',
    slotMinutes: 30,
    durations: [30, 60],
    notificationWording: BOOKING_NOTIFICATION_WORDING,
    renderToken: validBooking.renderToken,
    appearance: {
      style: 'neo',
      primaryColor: '#178af6',
      backgroundColor: '#ffffff80',
      buttonText: '',
      logoUrl: 'https://crm.example.test/m/abc/logo.png',
      coverUrl: null,
    },
  };
  expect(publicCalendarPage.safeParse(calendar).success).toBe(true);
  // The look is part of every page, and names pictures only by a web address.
  expect(publicCalendarPage.safeParse({ ...calendar, appearance: undefined }).success).toBe(false);
  for (const appearance of [
    { ...calendar.appearance, logoUrl: 'javascript:alert(1)' },
    { ...calendar.appearance, primaryColor: 'red' },
    { ...calendar.appearance, buttonText: 'x'.repeat(41) },
    { ...calendar.appearance, logoFileId: 'file_private' },
  ])
    expect(publicCalendarPage.safeParse({ ...calendar, appearance }).success).toBe(false);
  // A calendar may ask for no box: then it sends no email.
  expect(publicCalendarPage.safeParse({ ...calendar, notificationWording: null }).success).toBe(
    true,
  );
  expect(publicCalendarPage.safeParse({ ...calendar, durations: [] }).success).toBe(false);
  expect(publicCalendarPage.safeParse({ ...calendar, members: ['private'] }).success).toBe(false);
  const appointment = {
    status: 'booked',
    startsAt: validBooking.startsAt,
    endsAt: '2026-11-01T06:00:00Z',
    timezone: calendar.timezone,
    calendarName: calendar.name,
    revision: 'a'.repeat(64),
  };
  expect(publicAppointmentPage.safeParse(appointment).success).toBe(true);
  expect(
    publicAppointmentPage.safeParse({ ...appointment, email: 'private@example.test' }).success,
  ).toBe(false);
});

it('marks every independently mounted booking descriptor explicitly public', async () => {
  const { publicBookingEndpoints } = await import('./booking.js');
  expect(publicBookingEndpoints.map((endpoint) => endpoint.audience)).toEqual(
    Array.from({ length: 8 }, () => 'public'),
  );
});

it('takes consent only as ticked, needs the page’s proof, and an explicit valid contact timezone', () => {
  expect(
    publicBookingInput.safeParse({
      bookingRequestId: validBooking.bookingRequestId,
      startsAt: validBooking.startsAt,
      contact: validBooking.contact,
      renderToken: validBooking.renderToken,
    }).success,
  ).toBe(false);
  // Left out: the calendar asks for no box (the server checks which it asks).
  const { notificationConsent: _left, ...unticked } = validBooking;
  expect(publicBookingInput.parse(unticked)).toMatchObject({ trap: '' });
  // Without the page's proof, or with a malformed one, nothing is booked.
  const { renderToken: _proof, ...unproved } = validBooking;
  expect(publicBookingInput.safeParse(unproved).success).toBe(false);
  expect(publicBookingInput.safeParse({ ...validBooking, renderToken: 'nope' }).success).toBe(
    false,
  );
  expect(publicBookingInput.safeParse({ ...validBooking, minutes: 4 }).success).toBe(false);
  expect(publicBookingInput.safeParse({ ...validBooking, trap: 'x'.repeat(201) }).success).toBe(
    false,
  );
  expect(
    publicBookingInput.safeParse({
      ...validBooking,
      notificationConsent: false,
      contactTimezone: 'Africa/Nairobi',
    }).success,
  ).toBe(false);
  expect(
    publicBookingInput.safeParse({
      ...validBooking,
      notificationConsent: true,
      contactTimezone: 'Invalid/Zone',
    }).success,
  ).toBe(false);
  expect(
    publicBookingInput.safeParse({
      ...validBooking,
      notificationConsent: true,
      contactTimezone: 'Africa/Nairobi',
    }).success,
  ).toBe(true);
});
