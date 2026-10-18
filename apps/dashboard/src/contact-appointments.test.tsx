// @vitest-environment jsdom
// A contact's Appointments panel: Upcoming and Past from `listAppointments` for the
// contact, opening one in the appointment panel, and booking for the contact. The server is
// stood in for at `apiIn`.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { AppointmentDetail, AppointmentRow } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { MouseEvent, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactAppointments } from './contact-appointments';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => {
        const answer = server.answer(endpoint.operationId, input);
        if (answer instanceof Error) throw answer;
        return answer;
      });
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({
    to,
    params,
    search,
    children,
    onClick,
  }: {
    to: string;
    params: { slug: string };
    search?: { appointment?: string };
    children: ReactNode;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={`${to.replace('$slug', params.slug)}${search?.appointment === undefined ? '' : `?appointment=${search.appointment}`}`}
      onClick={onClick}
    >
      {children}
    </a>
  ),
}));

const now = new Date(2026, 9, 14, 10, 15);
beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wall = (value: string): string => new Date(value).toISOString();
const rowOf = (id: string, title: string, at: string, rest: Partial<AppointmentRow> = {}) =>
  ({
    kind: 'appointment',
    id,
    title,
    startsAt: wall(at),
    endsAt: new Date(Date.parse(wall(at)) + 3_600_000).toISOString(),
    status: 'confirmed',
    calendar: { id: 'cal_tours', name: 'Venue tours' },
    contact: { id: 'con_maya', name: 'Maya Thompson', trashed: false },
    assignee: { membershipId: 'mem_lee', you: false, name: 'Lee Park' },
    createdAt: wall('2026-10-01T09:00'),
    source: 'user',
    ...rest,
  }) satisfies AppointmentRow;

const tour = rowOf('appt_tour', 'Venue tour', '2026-10-20T09:00');
const tasting = rowOf('appt_tasting', 'Menu tasting', '2026-10-22T13:00', {
  status: 'cancelled',
  calendar: { id: 'cal_tastings', name: 'Tastings' },
  assignee: { membershipId: 'mem_dana', you: true, name: 'Dana Brooks' },
});
const call = rowOf('appt_call', 'First call', '2026-10-02T11:00', {
  status: 'completed',
  assignee: null,
});
const detail: AppointmentDetail = {
  ...tour,
  notes: '',
  location: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  updatedAt: wall('2026-10-01T09:00'),
  cancelledAt: null,
  cancelReason: null,
  createdBy: { name: 'Dana Brooks' },
  revision: 'a'.repeat(64),
  canManage: true,
  history: [],
};

interface Asked {
  readonly query: Record<string, unknown>;
}
const lists = (): Record<string, unknown>[] =>
  server.calls
    .filter((each) => each.operation === 'listAppointments')
    .map((each) => (each.input as Asked).query);

function serve({
  upcoming = [tour, tasting],
  past = [call],
  canManage = true,
  more = false,
}: {
  upcoming?: AppointmentRow[];
  past?: AppointmentRow[];
  canManage?: boolean;
  more?: boolean;
} = {}): void {
  server.answer = (operation, input) => {
    if (operation === 'listAppointments') {
      const { query } = input as Asked;
      const all = query['direction'] === 'asc' ? upcoming : past;
      const q = typeof query['q'] === 'string' ? query['q'].toLowerCase() : '';
      const matching = all.filter((each) => each.title.toLowerCase().includes(q));
      const first = query['after'] === undefined;
      return {
        items: more && first ? matching.slice(0, 1) : more ? matching.slice(1) : matching,
        next: more && first ? (matching[0]?.id ?? null) : null,
        total: matching.length,
        canManage,
      };
    }
    if (operation === 'getAppointment') return detail;
    if (operation === 'listCalendars')
      return {
        items: [{ id: 'cal_tours', name: 'Venue tours', supported: true, isActive: true }],
        nextCursor: null,
      };
    if (operation === 'listTeam') return { members: [] };
    return undefined;
  };
}

function show(props: { readOnly?: boolean } = {}): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <ContactAppointments contactId="con_maya" contactName="Maya Thompson" {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe("a contact's appointments", () => {
  it('lists what is coming for the contact, soonest first, with status, calendar and owner', async () => {
    serve();
    show();
    const list = await screen.findByRole('list', { name: 'Upcoming appointments' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => within(item).getByRole('link').textContent)).toEqual([
      'Venue tour',
      'Menu tasting',
    ]);
    const [first, second] = items;
    if (first === undefined || second === undefined) throw new Error('Two appointments listed.');
    expect(within(first).getByText('Confirmed')).toBeTruthy();
    expect(within(first).getByText(/Venue tours · Lee Park/)).toBeTruthy();
    // A cancelled one still counts as coming, with its status.
    expect(within(second).getByText('Cancelled')).toBeTruthy();
    expect(within(second).getByText(/Tastings · You/)).toBeTruthy();
    expect(screen.getByText(`2 appointments, times in ${zone}`)).toBeTruthy();
    expect(within(first).getByRole('link').getAttribute('href')).toBe(
      '/b/harbor/calendar?appointment=appt_tour',
    );
    expect(lists()).toEqual([
      {
        view: 'all',
        contact: 'con_maya',
        sort: 'startsAt',
        from: now.toISOString(),
        direction: 'asc',
        limit: 20,
      },
    ]);
    expect(screen.getByRole('button', { name: 'Upcoming' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('lists what has started under Past, latest first, and searches by title', async () => {
    serve({ past: [call, rowOf('appt_old', 'Old tour', '2026-09-01T09:00')] });
    const user = show();
    await screen.findByRole('list', { name: 'Upcoming appointments' });
    await user.click(screen.getByRole('button', { name: 'Past' }));
    const list = await screen.findByRole('list', { name: 'Past appointments' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['First call', 'Old tour']);
    expect(within(list).getAllByRole('listitem')[0]?.textContent).toContain(
      'Venue tours · Unassigned',
    );
    expect(lists().at(-1)).toEqual({
      view: 'all',
      contact: 'con_maya',
      sort: 'startsAt',
      to: now.toISOString(),
      direction: 'desc',
      limit: 20,
    });

    await user.type(screen.getByRole('searchbox', { name: 'Search appointments' }), 'old');
    await waitFor(() => {
      expect(lists().at(-1)).toMatchObject({ q: 'old', direction: 'desc' });
    });
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Past appointments' }))
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Old tour']);
    });
    await user.type(screen.getByRole('searchbox', { name: 'Search appointments' }), 'x');
    expect(await screen.findByText('No appointments match your search.')).toBeTruthy();
  });

  it('reads the next page on request', async () => {
    serve({ more: true });
    const user = show();
    await screen.findByRole('list', { name: 'Upcoming appointments' });
    await user.click(screen.getByRole('button', { name: 'Show more appointments' }));
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });
    expect(lists().at(-1)).toMatchObject({ after: 'appt_tour' });
    expect(screen.queryByRole('button', { name: 'Show more appointments' })).toBeNull();
  });

  it('opens an appointment in the panel beside the page', async () => {
    serve();
    const user = show();
    const link = await screen.findByRole('link', { name: 'Venue tour' });
    await user.click(link);
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(panel).findByText('Venue tours', {}, { timeout: 5000 })).toBeTruthy();
    expect(server.calls.some((each) => each.operation === 'getAppointment')).toBe(true);
  });

  it('books for the contact from the panel, with the contact chosen already', async () => {
    serve();
    const user = show();
    await screen.findByRole('list', { name: 'Upcoming appointments' });
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    const form = await screen.findByRole('dialog', { name: 'New appointment' });
    // The form's code is fetched when the panel first opens.
    expect(
      await within(form).findByRole('button', { name: 'Remove Maya Thompson' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(within(form).queryByRole('searchbox', { name: 'Contact' })).toBeNull();
  });

  it('says when nothing is coming, and offers booking there', async () => {
    serve({ upcoming: [] });
    const user = show();
    expect(await screen.findByText('No upcoming appointments.')).toBeTruthy();
    // The one way to book is in the empty panel's own words.
    expect(screen.getAllByRole('button', { name: 'Book appointment' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByRole('dialog', { name: 'New appointment' })).toBeTruthy();
  });

  it('offers no booking to someone who may not, or for a contact in the trash', async () => {
    serve({ canManage: false });
    show();
    await screen.findByRole('list', { name: 'Upcoming appointments' });
    expect(screen.queryByRole('button', { name: 'Book appointment' })).toBeNull();
    cleanup();
    serve({ upcoming: [] });
    show({ readOnly: true });
    expect(await screen.findByText('No upcoming appointments.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book appointment' })).toBeNull();
  });

  it('says when the appointments could not be read, and reads them again on request', async () => {
    let failing = true;
    serve();
    const answer = server.answer;
    server.answer = (operation, input) =>
      operation === 'listAppointments' && failing
        ? // An answer that would be the same again, so it is not retried by itself.
          new ApiError({ type: 'about:blank', title: 'Bad Request', status: 400 })
        : answer(operation, input);
    const user = show();
    expect(await screen.findByText("The appointments couldn't be loaded.")).toBeTruthy();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Upcoming appointments' })).toBeTruthy();
  });
});
