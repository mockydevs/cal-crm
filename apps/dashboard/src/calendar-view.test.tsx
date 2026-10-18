// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { CalendarEvent } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarViewPage } from './calendar-view';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
// The business's own zone, which the calendar is drawn in; none uses this machine's.
const workplace = vi.hoisted((): { timezone: string | undefined } => ({ timezone: undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({
    id: 'biz_test',
    name: 'Harbor Lights Events',
    slug: 'harbor',
    ...(workplace.timezone === undefined ? {} : { timezone: workplace.timezone }),
  }),
}));
vi.mock('./shell/page', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ to, params, children }: { to: string; params: object; children: ReactNode }) => (
    <a href={`${to}#${Object.values(params).join('/')}`}>{children}</a>
  ),
}));

// Wednesday 14 October 2026, a quarter past ten, by this machine's clock.
const at = (day: number, hour = 0, minute = 0): Date => new Date(2026, 9, day, hour, minute);

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(14, 10, 15));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tour: CalendarEvent = {
  kind: 'appointment',
  id: 'apt_tour',
  title: 'Venue tour',
  startsAt: at(14, 9).toISOString(),
  endsAt: at(14, 10).toISOString(),
  status: 'confirmed',
  calendar: { id: 'cal_tours', name: 'Venue tours' },
  contact: { id: 'con_maya', name: 'Maya Thompson', trashed: false },
  assignee: { membershipId: 'mem_lee', you: false },
};
const tasting: CalendarEvent = {
  kind: 'appointment',
  id: 'apt_tasting',
  title: '',
  startsAt: at(15, 13).toISOString(),
  endsAt: at(15, 13, 30).toISOString(),
  status: 'cancelled',
  calendar: { id: 'cal_tours', name: 'Venue tours' },
  contact: { id: 'con_omar', name: 'Omar Haddad', trashed: true },
  assignee: null,
};
const leave: CalendarEvent = {
  kind: 'blocked',
  id: 'blk_leave',
  startsAt: at(16, 12).toISOString(),
  endsAt: at(16, 14).toISOString(),
  user: { membershipId: 'mem_dana', you: true, name: 'Dana Brooks' },
  calendar: null,
  title: 'Dentist',
};
const team = {
  members: [
    { id: 'mem_dana', name: 'Dana Brooks', email: 'dana@harborlights.example', isSelf: true },
    { id: 'mem_lee', name: '', email: 'lee@harborlights.example', isSelf: false },
  ],
  roles: [],
  invitations: [],
  canManage: true,
};
const calendars = {
  items: [{ id: 'cal_tours', name: 'Venue tours' }],
  nextCursor: null,
  canManage: true,
};

const tourDetail = {
  ...tour,
  assignee: { membershipId: 'mem_lee', you: false, name: 'Lee Park' },
  createdAt: at(1, 9).toISOString(),
  updatedAt: at(1, 9).toISOString(),
  source: 'booking_page',
  notes: 'Bring the floor plan.',
  location: 'Pier 4',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  cancelledAt: null,
  cancelReason: null,
  createdBy: null,
  revision: 'a'.repeat(64),
  canManage: true,
  history: [{ type: 'booked', at: at(1, 9).toISOString(), actor: { kind: 'contact', name: null } }],
};
let mayBook = true;
let mayManage = true;
/** The blocked slot the stand-in keeps, as `getBlockedSlot` answers it. */
const leaveSlot = {
  id: 'blk_leave',
  member: { membershipId: 'mem_dana', you: true, name: 'Dana Brooks' },
  calendar: null,
  title: 'Dentist',
  startsAt: at(16, 12).toISOString(),
  endsAt: at(16, 14).toISOString(),
  revision: 'c'.repeat(64),
};

function serve(
  events: (query: Record<string, string>) => readonly CalendarEvent[] | Error,
  truncated = false,
): void {
  server.answer = (operation, input) => {
    if (operation === 'listTeam') return team;
    if (operation === 'listCalendars') return calendars;
    if (operation === 'listAppointments')
      return { items: [], next: null, total: 0, canManage: mayBook };
    if (operation === 'getAppointment') return tourDetail;
    if (operation === 'getBlockedSlot') return leaveSlot;
    if (operation === 'createBlockedSlot' || operation === 'updateBlockedSlot')
      return { ...leaveSlot, ...(input as { body: object }).body, revision: 'd'.repeat(64) };
    if (operation === 'deleteBlockedSlot') return undefined;
    if (operation !== 'listCalendarEvents') return undefined;
    const items = events((input as { query: Record<string, string> }).query);
    if (items instanceof Error) throw items;
    return { items, truncated, canManage: mayManage };
  };
}

/** Keeps the appointment the address would name, as the route does. */
function Harness(): ReactElement {
  const [appointment, setAppointment] = useState<string>();
  return <CalendarViewPage appointment={appointment} onAppointment={setAppointment} />;
}

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <Harness />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const windows = (): { from: string; to: string }[] =>
  server.calls
    .filter((call) => call.operation === 'listCalendarEvents')
    .map((call) => (call.input as { query: { from: string; to: string } }).query);
const lastQuery = (): Record<string, string> =>
  (
    server.calls.findLast((call) => call.operation === 'listCalendarEvents')?.input as {
      query: Record<string, string>;
    }
  ).query;
const day = (name: string): HTMLElement => screen.getByRole('group', { name });

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('the calendar view', () => {
  it('opens on this week and puts each event in its day', async () => {
    serve(() => [tour, tasting, leave]);
    show();

    const wednesday = await screen.findByRole('group', { name: 'Wednesday, October 14, 2026' });
    expect(await within(wednesday).findByRole('button', { name: /^Venue tour, / })).toBeTruthy();
    expect(windows()[0]).toEqual({
      from: at(11).toISOString(),
      to: at(18).toISOString(),
      type: 'all',
    });
    // An appointment with no title goes by its contact; a blocked slot says whose it is.
    expect(
      within(day('Thursday, October 15, 2026')).getByRole('button', {
        name: /^Omar Haddad, .*, Cancelled$/,
      }),
    ).toBeTruthy();
    expect(
      within(day('Friday, October 16, 2026')).getByRole('button', {
        name: /^Blocked slot, .*, You$/,
      }),
    ).toBeTruthy();
    expect(within(day('Sunday, October 11, 2026')).queryByRole('button')).toBeNull();
    // Today is marked, and only today has the line at the present time.
    expect(screen.getByRole('button', { name: 'Show Wednesday, October 14, 2026' })).toHaveProperty(
      'ariaCurrent',
      'date',
    );
    expect(document.querySelectorAll('[data-now]')).toHaveLength(1);
    expect(wednesday.querySelector('[data-now]')).not.toBeNull();
    // The event is drawn at nine, an hour tall.
    const block = within(wednesday).getByRole('button', { name: /^Venue tour, / }).parentElement;
    expect(block?.style.top).toBe('504px');
    expect(block?.style.height).toBe('56px');
  });

  it('walks to the weeks around it and comes back to today', async () => {
    serve(() => []);
    const user = show();
    expect(await screen.findByText('Nothing is booked or blocked in this period.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => {
      expect(windows().at(-1)).toMatchObject({
        from: at(18).toISOString(),
        to: at(25).toISOString(),
      });
    });
    await user.click(screen.getByRole('button', { name: 'Previous week' }));
    await user.click(screen.getByRole('button', { name: 'Previous week' }));
    await waitFor(() => {
      expect(windows().at(-1)).toMatchObject({
        from: at(4).toISOString(),
        to: at(11).toISOString(),
      });
    });
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByRole('group', { name: 'Wednesday, October 14, 2026' })).toBeTruthy();
  });

  it('shows a month, and opens a day from it', async () => {
    const busy = [9, 10, 11, 12].map((hour): CalendarEvent => ({
      ...tour,
      id: `apt_${String(hour)}`,
      title: `Tour at ${String(hour)}`,
      startsAt: at(20, hour).toISOString(),
      endsAt: at(20, hour, 30).toISOString(),
    }));
    serve(() => busy);
    const user = show();
    await screen.findByRole('group', { name: 'Wednesday, October 14, 2026' });

    await choose(user, screen.getByRole('combobox', { name: 'View' }), 'Month view');
    await waitFor(() => {
      // Six weeks from the Sunday before the first.
      expect(windows().at(-1)).toMatchObject({
        from: new Date(2026, 8, 27).toISOString(),
        to: new Date(2026, 10, 8).toISOString(),
      });
    });
    expect(
      within(screen.getByRole('region', { name: 'Calendar view' })).getByRole('status').textContent,
    ).toBe('October 2026');
    const twentieth = await screen.findByRole('group', { name: 'Tuesday, October 20, 2026' });
    expect(within(twentieth).getAllByRole('listitem')).toHaveLength(3);
    await user.click(
      within(twentieth).getByRole('button', { name: '1 more on Tuesday, October 20, 2026' }),
    );

    // The day view of the twentieth, with all four.
    expect(await screen.findByRole('button', { name: 'Next day' })).toBeTruthy();
    expect(within(day('Tuesday, October 20, 2026')).getAllByRole('listitem')).toHaveLength(4);
    await waitFor(() => {
      expect(windows().at(-1)).toMatchObject({
        from: at(20).toISOString(),
        to: at(21).toISOString(),
      });
    });
    // The date in the day view goes back to its week.
    await user.click(
      screen.getByRole('button', { name: 'Show the week of Tuesday, October 20, 2026' }),
    );
    expect(await screen.findByRole('button', { name: 'Next week' })).toBeTruthy();
  });

  it('says what an event is in the panel at the right', async () => {
    serve(() => [tour, leave]);
    const user = show();

    // An appointment is read by its id, and shows what the server keeps of it.
    await user.click(await screen.findByRole('button', { name: /^Venue tour, / }));
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(panel).findByRole('link', { name: 'Maya Thompson' })).toBeTruthy();
    expect(server.calls.find((call) => call.operation === 'getAppointment')?.input).toEqual({
      params: { id: 'apt_tour' },
    });
    expect(within(panel).getByText('Venue tours')).toBeTruthy();
    expect(within(panel).getByText('Lee Park')).toBeTruthy();
    expect(within(panel).getByText('Pier 4')).toBeTruthy();
    expect(within(panel).getByText('Bring the floor plan.')).toBeTruthy();
    expect(within(panel).getByText('The contact booked it')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Reschedule' })).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await user.click(await screen.findByRole('button', { name: /^Blocked slot, / }));
    const blocked = await screen.findByRole('dialog', { name: 'Blocked slot' });
    expect(await within(blocked).findByText('Dentist')).toBeTruthy();
    expect(within(blocked).getByText('You')).toBeTruthy();
    expect(within(blocked).queryByText('Status')).toBeNull();
  });

  it('offers under New an appointment to someone who may book, and a blocked slot to someone who may manage calendars', async () => {
    serve(() => []);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'New' }));
    expect(await screen.findByRole('menuitem', { name: 'Blocked slot' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Appointment' }));
    const panel = await screen.findByRole('dialog', { name: 'New appointment' });
    expect(await within(panel).findByRole('button', { name: 'Book appointment' })).toBeTruthy();
    cleanup();

    mayBook = false;
    serve(() => []);
    const other = show();
    await screen.findByText('Nothing is booked or blocked in this period.');
    await other.click(await screen.findByRole('button', { name: 'New' }));
    expect(await screen.findByRole('menuitem', { name: 'Blocked slot' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Appointment' })).toBeNull();
    cleanup();

    mayManage = false;
    serve(() => []);
    show();
    await screen.findByText('Nothing is booked or blocked in this period.');
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    mayBook = true;
    mayManage = true;
  });

  it('blocks time from New, by the clock of the business’s zone, and reads the calendar again', async () => {
    // Chicago is UTC-5 in October 2026, whatever this machine's zone is.
    workplace.timezone = 'America/Chicago';
    serve(() => []);
    const user = show();
    await screen.findByText('Nothing is booked or blocked in this period.');
    const reads = windows().length;
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Blocked slot' }));
    const panel = await screen.findByRole('dialog', { name: 'New blocked slot' });
    await user.type(await within(panel).findByLabelText('Title'), 'Staff training');
    await choose(user, within(panel).getByRole('combobox', { name: 'Team member' }), 'Dana Brooks');
    const starts = within(panel).getByLabelText('Starts (America/Chicago)');
    await user.clear(starts);
    await user.type(starts, '2026-10-15T09:00');
    const ends = within(panel).getByLabelText('Ends (America/Chicago)');
    await user.clear(ends);
    await user.type(ends, '2026-10-15T11:30');
    await user.click(within(panel).getByRole('button', { name: 'Block time' }));
    expect(await screen.findByText('Blocked slot added.')).toBeTruthy();
    expect(server.calls.find((call) => call.operation === 'createBlockedSlot')?.input).toEqual({
      body: {
        title: 'Staff training',
        membershipId: 'mem_dana',
        calendarId: null,
        startsAt: '2026-10-15T14:00:00.000Z',
        endsAt: '2026-10-15T16:30:00.000Z',
      },
    });
    await waitFor(() => {
      expect(windows().length).toBeGreaterThan(reads);
    });
    workplace.timezone = undefined;
  });

  it('opens a blocked slot pressed on the calendar to edit or remove it', async () => {
    serve(() => [leave]);
    const user = show();
    await user.click(await screen.findByRole('button', { name: /^Blocked slot, / }));
    const details = await screen.findByRole('dialog', { name: 'Blocked slot' });
    expect(within(details).getByText('All their calendars')).toBeTruthy();
    await user.click(within(details).getByRole('button', { name: 'Edit' }));
    const panel = await screen.findByRole('dialog', { name: 'Edit blocked slot' });
    expect(server.calls.find((call) => call.operation === 'getBlockedSlot')?.input).toEqual({
      params: { blockedSlotId: 'blk_leave' },
    });
    const title = await within(panel).findByLabelText('Title');
    expect(title).toHaveProperty('value', 'Dentist');
    await user.clear(title);
    await user.type(title, 'Dentist, moved');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Blocked slot saved.')).toBeTruthy();
    expect(server.calls.find((call) => call.operation === 'updateBlockedSlot')?.input).toEqual({
      params: { blockedSlotId: 'blk_leave' },
      body: expect.objectContaining({
        title: 'Dentist, moved',
        membershipId: 'mem_dana',
        revision: 'c'.repeat(64),
      }) as unknown,
    });

    await user.click(await screen.findByRole('button', { name: /^Blocked slot, / }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Blocked slot' })).getByRole('button', {
        name: 'Edit',
      }),
    );
    const again = await screen.findByRole('dialog', { name: 'Edit blocked slot' });
    await user.click(await within(again).findByRole('button', { name: 'Delete' }));
    await user.click(within(again).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Blocked slot removed.')).toBeTruthy();
    expect(server.calls.find((call) => call.operation === 'deleteBlockedSlot')?.input).toEqual({
      params: { blockedSlotId: 'blk_leave' },
    });
  });

  it('draws the week in the business’s zone, and says which zone that is', async () => {
    // Nine in the morning in Chicago, on Wednesday the 14th.
    workplace.timezone = 'America/Chicago';
    serve(() => [{ ...tour, startsAt: '2026-10-14T14:00:00Z', endsAt: '2026-10-14T15:00:00Z' }]);
    show();
    const wednesday = await screen.findByRole('group', { name: 'Wednesday, October 14, 2026' });
    const block = (await within(wednesday).findByRole('button', { name: /^Venue tour, / }))
      .parentElement;
    expect(block?.style.top).toBe('504px');
    expect(screen.getByText('America/Chicago')).toBeTruthy();
    // The week from Chicago's Sunday midnight.
    expect(windows()[0]).toMatchObject({
      from: '2026-10-11T05:00:00.000Z',
      to: '2026-10-18T05:00:00.000Z',
    });
    workplace.timezone = undefined;
  });

  it('narrows the view from Manage view, by type, user and calendar', async () => {
    serve(() => []);
    const user = show();
    await screen.findByText('Nothing is booked or blocked in this period.');

    await user.click(screen.getByRole('button', { name: 'Manage view' }));
    const panel = await screen.findByRole('dialog', { name: 'Manage view' });
    await user.click(await within(panel).findByRole('radio', { name: 'Blocked slots' }));
    await user.click(await within(panel).findByRole('checkbox', { name: /^lee@harborlights/ }));
    await user.click(await within(panel).findByRole('checkbox', { name: 'Venue tours' }));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({
        type: 'blocked',
        users: 'mem_lee',
        calendars: 'cal_tours',
      });
    });
    expect(within(panel).getByRole('checkbox', { name: 'Dana Brooks (you)' })).toHaveProperty(
      'checked',
      false,
    );

    await user.click(within(panel).getByRole('button', { name: 'Show everything' }));
    await waitFor(() => {
      expect(lastQuery()).toEqual({
        from: at(11).toISOString(),
        to: at(18).toISOString(),
        type: 'all',
      });
    });
    await user.click(within(panel).getByRole('checkbox', { name: 'Venue tours' }));
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('button', { name: 'Manage view (1)' })).toBeTruthy();
    expect(await screen.findByText('Nothing in this period matches the view.')).toBeTruthy();
  });

  it('says when the period holds more than it shows, and when it cannot be read', async () => {
    let fail = false;
    serve(
      () =>
        fail ? new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }) : [tour],
      true,
    );
    const user = show();
    expect(await screen.findByText(/only the earliest events\s+show/)).toBeTruthy();

    fail = true;
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain("The calendar couldn't be loaded.");
    fail = false;
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
