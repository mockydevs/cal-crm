// @vitest-environment jsdom
// The appointment panel: booking a new appointment, one appointment's details and what is
// done to it there, and moving one. The server is stood in for at `apiIn`.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { AppointmentDetail } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppointmentPanels, type OpenedAppointment } from './appointment-panels';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ to, params, children }: { to: string; params: object; children: ReactNode }) => (
    <a href={`${to}#${Object.values(params).join('/')}`}>{children}</a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 14, 10, 15));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wall = (value: string): string => new Date(value).toISOString();
const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);
const tour: AppointmentDetail = {
  kind: 'appointment',
  id: 'appt_tour',
  title: 'Venue tour',
  startsAt: wall('2026-10-20T09:00'),
  endsAt: wall('2026-10-20T10:00'),
  status: 'confirmed',
  calendar: { id: 'cal_tours', name: 'Venue tours' },
  contact: { id: 'con_maya', name: 'Maya Thompson', trashed: false },
  assignee: { membershipId: 'mem_lee', you: false, name: 'Lee Park' },
  createdAt: wall('2026-10-01T09:00'),
  source: 'user',
  notes: 'Bring the floor plan.',
  location: 'Pier 4',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  updatedAt: wall('2026-10-01T09:00'),
  cancelledAt: null,
  cancelReason: null,
  createdBy: { name: 'Dana Brooks' },
  revision: revisionA,
  canManage: true,
  history: [
    { type: 'booked', at: wall('2026-10-01T09:00'), actor: { kind: 'user', name: 'Dana Brooks' } },
    {
      type: 'status_changed',
      at: wall('2026-10-02T09:00'),
      actor: { kind: 'contact', name: null },
      status: 'confirmed',
      previousStatus: 'booked',
    },
  ],
};

const conflict = (detail: string): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, detail });
const invalid = (path: string, message: string): ApiError =>
  new ApiError({
    type: 'about:blank',
    title: 'Unprocessable',
    status: 422,
    errors: [{ path, code: 'refused', message }],
  });

let current = tour;
function serve(on: (operation: string, input: unknown) => unknown = () => undefined): void {
  current = tour;
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own instanceof Error) throw own;
    if (own !== undefined) return own;
    if (operation === 'listTeam')
      return {
        members: [
          { id: 'mem_dana', name: 'Dana Brooks', email: 'dana@harborlights.example', isSelf: true },
          { id: 'mem_lee', name: 'Lee Park', email: 'lee@harborlights.example', isSelf: false },
        ],
      };
    if (operation === 'listCalendars')
      return {
        items: [
          { id: 'cal_tours', name: 'Venue tours', supported: true, isActive: true },
          { id: 'cal_draft', name: 'Tastings', supported: true, isActive: false },
        ],
        nextCursor: null,
      };
    if (operation === 'getCalendar') return { members: [{ membershipId: 'mem_lee', weight: 1 }] };
    if (operation === 'listContacts')
      return { items: [{ id: 'con_maya', name: 'Maya Thompson', email: 'maya@example.test' }] };
    if (operation === 'getAppointment') return current;
    if (operation === 'getGoogleConnections') return { available: false, mine: null, team: null };
    return undefined;
  };
}

function Harness({ start }: { readonly start: OpenedAppointment }): ReactElement {
  const [opened, setOpened] = useState<OpenedAppointment | undefined>(start);
  const focusRef = useRef<HTMLElement | null>(null);
  return (
    <AppointmentPanels
      opened={opened}
      returnFocus={focusRef}
      onOpen={setOpened}
      onClose={() => {
        setOpened(undefined);
      }}
    />
  );
}

function show(start: OpenedAppointment): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <Harness start={start} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const sent = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

async function fillBooking(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const panel = await screen.findByRole('dialog', { name: 'New appointment' });
  await choose(
    user,
    await within(panel).findByRole('combobox', { name: 'Calendar' }),
    'Venue tours',
  );
  await user.type(within(panel).getByRole('searchbox', { name: 'Contact' }), 'maya');
  await user.click(await within(panel).findByRole('button', { name: /^Maya Thompson/ }));
  return panel;
}

describe('booking an appointment', () => {
  it('starts at the next half hour and offers only calendars that take bookings', async () => {
    serve();
    const user = show({ kind: 'new' });
    const panel = await screen.findByRole('dialog', { name: 'New appointment' });
    expect(await within(panel).findByLabelText(/^Starts/)).toHaveProperty(
      'value',
      '2026-10-14T10:30',
    );
    await user.click(within(panel).getByRole('combobox', { name: 'Calendar' }));
    expect(await screen.findByRole('option', { name: 'Venue tours' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Tastings' })).toBeNull();
  });

  it('sends what the form holds with an id of its own, then shows the appointment', async () => {
    serve((operation) => (operation === 'createAppointment' ? tour : undefined));
    const user = show({ kind: 'new' });
    const panel = await fillBooking(user);
    fireEvent.change(within(panel).getByLabelText(/^Starts/), {
      target: { value: '2026-10-20T09:00' },
    });
    await choose(
      user,
      within(panel).getByRole('combobox', { name: 'Appointment owner' }),
      'Lee Park',
    );
    await user.type(within(panel).getByLabelText('Title'), 'Venue tour');
    await user.type(within(panel).getByLabelText('Location'), 'Pier 4');
    await user.type(within(panel).getByLabelText('Notes'), 'Bring the floor plan.');
    // No end is asked for while the calendar decides the length.
    expect(within(panel).queryByLabelText(/^Ends/)).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Book appointment' }));

    const details = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(details).findByText('Bring the floor plan.')).toBeTruthy();
    const [first] = sent('createAppointment') as { body: Record<string, unknown> }[];
    expect(first?.body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      calendarId: 'cal_tours',
      contactId: 'con_maya',
      startsAt: wall('2026-10-20T09:00'),
      ignoreAvailability: false,
      assignee: 'mem_lee',
      title: 'Venue tour',
      status: 'confirmed',
      location: 'Pier 4',
      notes: 'Bring the floor plan.',
    });
    expect(document.querySelector('p.sr-only[role="status"]')?.textContent).toBe(
      'Appointment booked.',
    );
  });

  it("says Google isn't checked when the chosen owner's Google Calendar is disconnected", async () => {
    const google = (status: 'connected' | 'disconnected') => ({
      available: true,
      mine: null,
      team: [
        {
          membershipId: 'mem_lee',
          status,
          disconnectedReason: status === 'disconnected' ? 'expired_or_revoked' : null,
          busyCheckedAt: null,
          busyFailing: false,
        },
      ],
    });
    let status: 'connected' | 'disconnected' = 'disconnected';
    serve((operation) => (operation === 'getGoogleConnections' ? google(status) : undefined));
    const user = show({ kind: 'new' });
    const panel = await fillBooking(user);
    const note = /^Google not checked: Lee Park's Google Calendar is disconnected/;
    // Nobody chosen yet: the calendar decides, and nothing is said.
    expect(within(panel).queryByText(note)).toBeNull();
    await choose(
      user,
      within(panel).getByRole('combobox', { name: 'Appointment owner' }),
      'Lee Park',
    );
    expect(await within(panel).findByText(note)).toBeTruthy();
    // A time set exactly sets the calendars aside anyway.
    await user.click(within(panel).getByRole('checkbox', { name: /Ignore availability/ }));
    expect(within(panel).queryByText(note)).toBeNull();
    cleanup();
    status = 'connected';
    const again = show({ kind: 'new' });
    const connected = await fillBooking(again);
    await choose(
      again,
      within(connected).getByRole('combobox', { name: 'Appointment owner' }),
      'Lee Park',
    );
    await waitFor(() => {
      expect(sent('getGoogleConnections').length).toBeGreaterThan(1);
    });
    expect(within(connected).queryByText(note)).toBeNull();
  });

  it('says what is missing before anything is sent', async () => {
    serve();
    const user = show({ kind: 'new' });
    const panel = await screen.findByRole('dialog', { name: 'New appointment' });
    await user.click(await within(panel).findByRole('button', { name: 'Book appointment' }));
    expect(await within(panel).findAllByText('This is needed.')).toHaveLength(2);
    expect(sent('createAppointment')).toEqual([]);
  });

  it('puts a double booking beside the start, and sends a new id on the next try', async () => {
    let taken = true;
    serve((operation) =>
      operation !== 'createAppointment'
        ? undefined
        : taken
          ? conflict('This appointment time is unavailable.')
          : tour,
    );
    const user = show({ kind: 'new' });
    const panel = await fillBooking(user);
    await user.click(within(panel).getByRole('button', { name: 'Book appointment' }));
    expect(await within(panel).findByText('This appointment time is unavailable.')).toBeTruthy();
    expect(
      within(panel)
        .getByLabelText(/^Starts/)
        .getAttribute('aria-invalid'),
    ).toBe('true');

    // Another time is chosen, and the booking is sent again as a new request.
    taken = false;
    fireEvent.change(within(panel).getByLabelText(/^Starts/), {
      target: { value: '2026-10-20T11:00' },
    });
    await user.click(within(panel).getByRole('button', { name: 'Book appointment' }));
    await screen.findByRole('dialog', { name: 'Appointment' });
    const ids = (sent('createAppointment') as { body: { requestId: string } }[]).map(
      (each) => each.body.requestId,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('asks for an end only when availability is ignored, and shows a refusal by its field', async () => {
    serve((operation) =>
      operation === 'createAppointment'
        ? invalid('/assignee', 'Choose who the appointment is with.')
        : undefined,
    );
    const user = show({ kind: 'new' });
    const panel = await fillBooking(user);
    fireEvent.change(within(panel).getByLabelText(/^Starts/), {
      target: { value: '2026-10-20T07:00' },
    });
    await user.click(within(panel).getByRole('checkbox', { name: 'Ignore availability' }));
    expect(within(panel).getByText(/never books a person twice at the same time/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText(/^Ends/), {
      target: { value: '2026-10-20T06:00' },
    });
    await user.click(within(panel).getByRole('button', { name: 'Book appointment' }));
    expect(await within(panel).findByText('End the appointment after it starts.')).toBeTruthy();
    expect(sent('createAppointment')).toEqual([]);

    fireEvent.change(within(panel).getByLabelText(/^Ends/), {
      target: { value: '2026-10-20T07:45' },
    });
    await user.click(within(panel).getByRole('button', { name: 'Book appointment' }));
    expect(await within(panel).findByText('Choose who the appointment is with.')).toBeTruthy();
    expect((sent('createAppointment')[0] as { body: object }).body).toMatchObject({
      startsAt: wall('2026-10-20T07:00'),
      endsAt: wall('2026-10-20T07:45'),
      ignoreAvailability: true,
    });
  });
});

describe("an appointment's details", () => {
  it('shows what the server keeps and its history', async () => {
    serve();
    show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(panel).findByText('Venue tour')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Maya Thompson' })).toBeTruthy();
    expect(within(panel).getByText('Lee Park')).toBeTruthy();
    expect(within(panel).getByText('Pier 4')).toBeTruthy();
    expect(within(panel).getByText('Dana Brooks booked it')).toBeTruthy();
    expect(within(panel).getByText('The contact set it to Confirmed')).toBeTruthy();
  });

  it('shows no actions to someone who may not change appointments', async () => {
    serve((operation) =>
      operation === 'getAppointment' ? { ...tour, canManage: false } : undefined,
    );
    show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(panel).findByText('Confirmed')).toBeTruthy();
    expect(within(panel).queryByRole('combobox')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Reschedule' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Cancel appointment' })).toBeNull();
  });

  it('sets the status with the revision it read', async () => {
    serve((operation) => {
      if (operation !== 'setAppointmentStatus') return undefined;
      current = { ...tour, status: 'no_show', revision: revisionB };
      return current;
    });
    const user = show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    await choose(user, await within(panel).findByRole('combobox', { name: 'Status' }), 'No show');
    expect(await within(panel).findByText('Status changed.')).toBeTruthy();
    expect(sent('setAppointmentStatus')).toEqual([
      { params: { id: 'appt_tour' }, body: { revision: revisionA, status: 'no_show' } },
    ]);
    // Neither booked nor confirmed: it cannot be moved until its status says so again.
    expect(within(panel).queryByRole('button', { name: 'Reschedule' })).toBeNull();
  });

  it('cancels after asking, with the reason given', async () => {
    serve((operation) => {
      if (operation !== 'cancelAppointment') return undefined;
      current = {
        ...tour,
        status: 'cancelled',
        revision: revisionB,
        cancelledAt: wall('2026-10-14T10:15'),
        cancelReason: 'Venue closed',
      };
      return current;
    });
    const user = show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    await user.click(await within(panel).findByRole('button', { name: 'Cancel appointment' }));
    expect(sent('cancelAppointment')).toEqual([]);
    const asking = within(panel).getByRole('region', { name: 'Cancel this appointment' });
    await user.type(within(asking).getByLabelText('Reason (optional)'), ' Venue closed ');
    await user.click(within(asking).getByRole('button', { name: 'Cancel appointment' }));
    expect(await within(panel).findByText('Appointment cancelled.')).toBeTruthy();
    expect(sent('cancelAppointment')).toEqual([
      { params: { id: 'appt_tour' }, body: { revision: revisionA, reason: 'Venue closed' } },
    ]);
    expect(within(panel).getByText('Venue closed')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Cancel appointment' })).toBeNull();
  });

  it('reads the appointment again when someone changed it first, and says so', async () => {
    serve((operation) => {
      if (operation !== 'setAppointmentStatus') return undefined;
      current = { ...tour, title: 'Venue tour (moved)', revision: revisionB };
      return conflict('This appointment changed. Reload before continuing.');
    });
    const user = show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    await choose(user, await within(panel).findByRole('combobox', { name: 'Status' }), 'Completed');
    expect(await within(panel).findByText(/Someone changed this appointment first/)).toBeTruthy();
    expect(within(panel).getByText('Venue tour (moved)')).toBeTruthy();
  });

  it('says a time is taken when a status change is refused and nothing else changed', async () => {
    serve((operation) =>
      operation === 'setAppointmentStatus'
        ? conflict('This appointment time is unavailable.')
        : operation === 'getAppointment'
          ? { ...tour, status: 'cancelled' }
          : undefined,
    );
    const user = show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    await choose(user, await within(panel).findByRole('combobox', { name: 'Status' }), 'Confirmed');
    expect(await within(panel).findByText('This appointment time is unavailable.')).toBeTruthy();
  });
});

describe('moving an appointment', () => {
  it('opens from the details with the time it has, and sends the new one with the revision', async () => {
    serve((operation) => {
      if (operation !== 'rescheduleAppointment') return undefined;
      current = {
        ...tour,
        startsAt: wall('2026-10-21T11:00'),
        endsAt: wall('2026-10-21T12:00'),
        revision: revisionB,
      };
      return current;
    });
    const user = show({ kind: 'view', id: 'appt_tour' });
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }));
    const panel = await screen.findByRole('dialog', { name: 'Reschedule appointment' });
    const starts = await within(panel).findByLabelText(/^Starts/);
    expect(starts).toHaveProperty('value', '2026-10-20T09:00');
    // Who it is with and what it is about do not change in a move.
    expect(within(panel).queryByLabelText('Title')).toBeNull();
    fireEvent.change(starts, { target: { value: '2026-10-21T11:00' } });
    await user.click(within(panel).getByRole('button', { name: 'Move appointment' }));

    await screen.findByRole('dialog', { name: 'Appointment' });
    expect(sent('rescheduleAppointment')).toEqual([
      {
        params: { id: 'appt_tour' },
        body: {
          revision: revisionA,
          startsAt: wall('2026-10-21T11:00'),
          ignoreAvailability: false,
        },
      },
    ]);
    expect(document.querySelector('p.sr-only[role="status"]')?.textContent).toBe(
      'Appointment moved.',
    );
  });

  it('tells a change made by someone else from a time that is taken', async () => {
    let step: 'stale' | 'taken' | 'free' = 'stale';
    serve((operation) => {
      if (operation !== 'rescheduleAppointment') return undefined;
      if (step === 'stale') {
        current = { ...tour, revision: revisionB };
        return conflict('This appointment changed. Reload before continuing.');
      }
      if (step === 'taken') return conflict('This appointment time is unavailable.');
      return current;
    });
    const user = show({ kind: 'move', appointment: tour });
    const panel = await screen.findByRole('dialog', { name: 'Reschedule appointment' });
    await user.click(await within(panel).findByRole('button', { name: 'Move appointment' }));
    expect(
      await within(panel).findByText(/This appointment changed while you were moving it/),
    ).toBeTruthy();

    // The next try carries the revision just read; a taken time is said beside the start.
    step = 'taken';
    await user.click(within(panel).getByRole('button', { name: 'Move appointment' }));
    expect(await within(panel).findByText('This appointment time is unavailable.')).toBeTruthy();
    await waitFor(() => {
      expect(
        (sent('rescheduleAppointment') as { body: { revision: string } }[]).map(
          (each) => each.body.revision,
        ),
      ).toEqual([revisionA, revisionB]);
    });
    expect(
      within(panel)
        .getByLabelText(/^Starts/)
        .getAttribute('aria-invalid'),
    ).toBe('true');
  });

  it('goes back to the details when the move is given up', async () => {
    serve();
    const user = show({ kind: 'move', appointment: tour });
    const panel = await screen.findByRole('dialog', { name: 'Reschedule appointment' });
    await user.click(await within(panel).findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Appointment' })).toBeTruthy();
    expect(sent('rescheduleAppointment')).toEqual([]);
  });
});

describe('booking for a contact already chosen', () => {
  it('names the contact instead of searching, and books for them', async () => {
    serve((operation) => (operation === 'createAppointment' ? tour : undefined));
    const user = show({ kind: 'new', contact: { id: 'con_maya', name: 'Maya Thompson' } });
    const panel = await screen.findByRole('dialog', { name: 'New appointment' });
    expect(await within(panel).findByText('Maya Thompson')).toBeTruthy();
    expect(within(panel).queryByRole('searchbox', { name: 'Contact' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Remove Maya Thompson' })).toBeTruthy();
    await choose(
      user,
      await within(panel).findByRole('combobox', { name: 'Calendar' }),
      'Venue tours',
    );
    await user.click(within(panel).getByRole('button', { name: 'Book appointment' }));
    await screen.findByRole('dialog', { name: 'Appointment' });
    expect((sent('createAppointment')[0] as { body: object }).body).toMatchObject({
      calendarId: 'cal_tours',
      contactId: 'con_maya',
    });
    expect(sent('listContacts')).toEqual([]);
  });
});

describe("an appointment's notes", () => {
  it('writes them with the revision read, kept as typed', async () => {
    serve((operation, input) => {
      if (operation !== 'setAppointmentNotes') return undefined;
      const { notes } = (input as { body: { notes: string } }).body;
      current = { ...tour, notes, revision: revisionB };
      return current;
    });
    const user = show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    await user.click(await within(panel).findByRole('button', { name: 'Edit notes' }));
    const box = within(panel).getByRole('textbox', { name: 'Notes' });
    expect(box).toHaveProperty('value', 'Bring the floor plan.');
    expect(document.activeElement).toBe(box);
    expect(within(panel).getByText('For the team only: the contact never sees them.')).toBeTruthy();
    await user.clear(box);
    await user.type(box, 'Bring the floor plan.{Enter}Ask about parking.');
    await user.click(within(panel).getByRole('button', { name: 'Save notes' }));
    expect(await within(panel).findByText('Notes saved.')).toBeTruthy();
    expect(sent('setAppointmentNotes')).toEqual([
      {
        params: { id: 'appt_tour' },
        body: { revision: revisionA, notes: 'Bring the floor plan.\nAsk about parking.' },
      },
    ]);
    expect(within(panel).queryByRole('textbox', { name: 'Notes' })).toBeNull();
    expect(within(panel).getByText(/Ask about parking\./)).toBeTruthy();
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Edit notes' }));
  });

  it('offers to add notes when there are none, and lets the writing be dropped', async () => {
    serve((operation) => (operation === 'getAppointment' ? { ...tour, notes: '' } : undefined));
    const user = show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(panel).findByText('No notes yet.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Add notes' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Notes' }), 'Never sent.');
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(within(panel).queryByRole('textbox', { name: 'Notes' })).toBeNull();
    expect(sent('setAppointmentNotes')).toEqual([]);
  });

  it('keeps what was typed when someone saved notes first, shows theirs, and saves on the newer revision', async () => {
    let first = true;
    serve((operation, input) => {
      if (operation !== 'setAppointmentNotes') return undefined;
      if (first) {
        first = false;
        current = { ...tour, notes: 'Lee: the client prefers mornings.', revision: revisionB };
        return conflict('This appointment changed. Reload before continuing.');
      }
      const { notes } = (input as { body: { notes: string } }).body;
      current = { ...current, notes, revision: 'c'.repeat(64) };
      return current;
    });
    const user = show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    await user.click(await within(panel).findByRole('button', { name: 'Edit notes' }));
    const box = within(panel).getByRole('textbox', { name: 'Notes' });
    await user.type(box, ' Mine.');
    await user.click(within(panel).getByRole('button', { name: 'Save notes' }));
    expect(await within(panel).findByText(/Someone changed this appointment first/)).toBeTruthy();
    expect(within(panel).getByText('The notes now read:')).toBeTruthy();
    expect(within(panel).getByText('Lee: the client prefers mornings.')).toBeTruthy();
    expect(within(panel).getByRole('textbox', { name: 'Notes' })).toHaveProperty(
      'value',
      'Bring the floor plan. Mine.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Save notes' }));
    expect(await within(panel).findByText('Notes saved.')).toBeTruthy();
    expect(
      (sent('setAppointmentNotes') as { body: { revision: string } }[]).map(
        (each) => each.body.revision,
      ),
    ).toEqual([revisionA, revisionB]);
  });

  it('shows the notes, and no way to change them, to someone who may not', async () => {
    serve((operation) =>
      operation === 'getAppointment' ? { ...tour, canManage: false } : undefined,
    );
    show({ kind: 'view', id: 'appt_tour' });
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(panel).findByText('Bring the floor plan.')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /notes/ })).toBeNull();
  });
});
