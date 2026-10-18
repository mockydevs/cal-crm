// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { AppointmentDetail, AppointmentRow } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppointmentsPage } from './appointments';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const at = (day: number, hour = 0, minute = 0): string =>
  new Date(2026, 9, day, hour, minute).toISOString();
const row = (id: string, rest: Partial<AppointmentRow>): AppointmentRow => ({
  kind: 'appointment',
  id,
  title: 'Venue tour',
  startsAt: at(15, 9),
  endsAt: at(15, 10),
  status: 'confirmed',
  calendar: { id: 'cal_tours', name: 'Venue tours' },
  contact: { id: 'con_maya', name: 'Maya Thompson', trashed: false },
  assignee: { membershipId: 'mem_lee', you: false, name: 'Lee Park' },
  createdAt: at(1, 9),
  source: 'user',
  ...rest,
});
const tour = row('appt_tour', {});
const mine = row('appt_mine', {
  title: 'Morning call',
  status: 'no_show',
  assignee: { membershipId: 'mem_dana', you: true, name: 'Dana Brooks' },
});
const orphan = row('appt_orphan', {
  title: '',
  status: 'cancelled',
  contact: { id: 'con_omar', name: 'Omar Haddad', trashed: true },
  assignee: { membershipId: null, you: false, name: '' },
});
const nobody = row('appt_nobody', { title: 'Walk-in', assignee: null });
const detail: AppointmentDetail = {
  ...tour,
  notes: '',
  location: null,
  timezone: 'UTC',
  updatedAt: at(1, 9),
  cancelledAt: null,
  cancelReason: null,
  createdBy: { name: 'Dana Brooks' },
  revision: 'a'.repeat(64),
  canManage: true,
  history: [],
};
const team = {
  members: [
    { id: 'mem_dana', name: 'Dana Brooks', email: 'dana@harborlights.example', isSelf: true },
    { id: 'mem_lee', name: 'Lee Park', email: 'lee@harborlights.example', isSelf: false },
  ],
  roles: [],
  invitations: [],
  canManage: true,
};

type Query = Record<string, string | number>;
function serve(
  page: (query: Query) => { items: AppointmentRow[]; next?: string | null; total?: number } | Error,
  canManage = true,
): void {
  server.answer = (operation, input) => {
    if (operation === 'listTeam') return team;
    if (operation === 'listCalendars')
      return { items: [{ id: 'cal_tours', name: 'Venue tours' }], nextCursor: null };
    if (operation === 'getAppointment') return detail;
    if (operation !== 'listAppointments') return undefined;
    const answer = page((input as { query: Query }).query);
    if (answer instanceof Error) throw answer;
    return {
      items: answer.items,
      next: answer.next ?? null,
      total: answer.total ?? answer.items.length,
      canManage,
    };
  };
}

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <AppointmentsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const lastQuery = (): Query =>
  (
    server.calls.findLast((call) => call.operation === 'listAppointments')?.input as {
      query: Query;
    }
  ).query;
const titles = (): (string | null)[] =>
  within(screen.getByRole('table'))
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent);
const tab = (name: string): HTMLElement =>
  within(screen.getByRole('group', { name: 'Appointment lists' })).getByRole('button', { name });

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('the appointment list', () => {
  it('asks for what is coming, soonest first, and shows a page of it with the count', async () => {
    serve(() => ({ items: [tour, mine, orphan, nobody], total: 41 }));
    show();

    const table = await screen.findByRole('table', { name: 'Appointments' });
    expect(lastQuery()).toEqual({
      view: 'upcoming',
      sort: 'startsAt',
      direction: 'asc',
      limit: 20,
    });
    expect(titles()).toEqual(['Venue tour', 'Morning call', 'Untitled', 'Walk-in']);
    expect(screen.getByText('41 appointments')).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('status').textContent,
    ).toBe('1 - 4 of 41');

    const first = within(table).getByRole('row', { name: /^Venue tour / });
    expect(within(first).getByRole('link', { name: 'Maya Thompson' })).toBeTruthy();
    expect(within(first).getByText('Confirmed')).toBeTruthy();
    expect(within(first).getByText('Lee Park')).toBeTruthy();
    // The owner as the server names them: you, someone who left, or nobody.
    expect(
      within(within(table).getByRole('row', { name: /^Morning call/ })).getByText('You'),
    ).toBeTruthy();
    const left = within(table).getByRole('row', { name: /^Untitled/ });
    expect(within(left).getByText('Former team member')).toBeTruthy();
    expect(within(left).queryByRole('link')).toBeNull();
    expect(
      within(within(table).getByRole('row', { name: /^Walk-in/ })).getByText('Unassigned'),
    ).toBeTruthy();
  });

  it('sends each tab, filter and the settled title search to the server', async () => {
    serve(() => ({ items: [tour] }));
    const user = show();
    await screen.findByRole('table');

    await user.click(tab('Cancelled'));
    await waitFor(() => {
      expect(lastQuery()['view']).toBe('cancelled');
    });
    await user.click(tab('All'));
    await choose(user, screen.getByRole('combobox', { name: 'Status' }), 'No show');
    await choose(user, screen.getByRole('combobox', { name: 'Calendar' }), 'Venue tours');
    await choose(
      user,
      await screen.findByRole('combobox', { name: 'Appointment owner' }),
      'Lee Park',
    );
    await user.type(screen.getByRole('searchbox', { name: 'Search by title' }), ' tour ');
    await waitFor(() => {
      expect(lastQuery()).toEqual({
        view: 'all',
        sort: 'startsAt',
        direction: 'asc',
        limit: 20,
        status: 'no_show',
        calendar: 'cal_tours',
        user: 'mem_lee',
        q: 'tour',
      });
    });
  });

  it('orders by the heading pressed, and turns it round on the second press', async () => {
    serve(() => ({ items: [tour] }));
    const user = show();
    const table = await screen.findByRole('table');
    const time = within(table).getByRole('columnheader', { name: /^Appointment time/ });
    expect(time.getAttribute('aria-sort')).toBe('ascending');

    await user.click(within(time).getByRole('button'));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ sort: 'startsAt', direction: 'desc' });
    });
    await user.click(
      within(screen.getByRole('columnheader', { name: 'Title' })).getByRole('button'),
    );
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ sort: 'title', direction: 'asc' });
    });
    expect(screen.getByRole('columnheader', { name: 'Title' }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(
      screen.getByRole('columnheader', { name: /^Appointment time/ }).hasAttribute('aria-sort'),
    ).toBe(false);
  });

  it('walks the pages with the cursor the server gave, and starts again when the list changes', async () => {
    serve((query) =>
      query['after'] === undefined
        ? { items: [tour], next: 'appt_tour', total: 2 }
        : { items: [mine], total: 2 },
    );
    const user = show();
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(titles()).toEqual(['Morning call']);
    });
    expect(lastQuery()['after']).toBe('appt_tour');
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);

    await user.click(tab('All'));
    await waitFor(() => {
      expect(lastQuery()).toEqual({ view: 'all', sort: 'startsAt', direction: 'asc', limit: 20 });
    });
  });

  it('says so when a list is empty, and offers all of them', async () => {
    serve((query) => ({ items: query['view'] === 'all' ? [orphan] : [] }));
    const user = show();

    expect(await screen.findByRole('heading', { name: 'No upcoming appointments' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('0 appointments')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'See all appointments' }));
    await waitFor(() => {
      expect(titles()).toEqual(['Untitled']);
    });
    expect(tab('All').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('1 appointment')).toBeTruthy();
  });

  it('opens an appointment from its title, and offers a new one only to someone who may book', async () => {
    serve(() => ({ items: [tour] }));
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Venue tour' }));
    const panel = await screen.findByRole('dialog', { name: 'Appointment' });
    expect(await within(panel).findByRole('button', { name: 'Reschedule' })).toBeTruthy();
    expect(server.calls.find((call) => call.operation === 'getAppointment')?.input).toEqual({
      params: { id: 'appt_tour' },
    });
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'New appointment' }));
    expect(await screen.findByRole('dialog', { name: 'New appointment' })).toBeTruthy();
    cleanup();

    serve(() => ({ items: [tour] }), false);
    show();
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'New appointment' })).toBeNull();
  });

  it('says when the list cannot be read, and reads it again', async () => {
    let fail = true;
    serve(() =>
      fail
        ? new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 })
        : { items: [tour] },
    );
    const user = show();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Appointments couldn't be loaded.");
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});
