// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createCalendarInput, type BusinessSummary } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  avaId,
  calendarOf,
  danaId,
  fakeCalendarApi,
  leeId,
  problem,
  type FakeApi,
} from '../e2e/calendar-settings-fake';
import { calendarCarryKey, type CalendarDraft } from './calendar-settings-rules';
import { CalendarsPage, type CalendarsTab } from './calendars';

const went = vi.hoisted(() => ({ toNew: [] as string[] }));
vi.mock('./shell/page', () => ({ usePageTitle: () => undefined }));
vi.mock('./calendar-settings-links', () => ({
  EditCalendarLink: ({
    calendarId,
    children,
    slug: _slug,
    ...rest
  }: {
    calendarId: string;
    slug: string;
    children: ReactNode;
  }) => (
    <a href={`/calendars/${calendarId}`} {...rest}>
      {children}
    </a>
  ),
  PersonLink: ({
    membershipId,
    children,
    slug: _slug,
    ...rest
  }: {
    membershipId: string;
    slug: string;
    children: ReactNode;
  }) => (
    <a href={`/users/${membershipId}`} {...rest}>
      {children}
    </a>
  ),
  useCalendarNavigation: () => ({
    toList: () => undefined,
    toCalendar: () => undefined,
    toNew: (kind: string) => {
      went.toNew.push(kind);
    },
  }),
}));

// A busy machine (another lane's build, a two-core runner) answers late: wait longer for it.
configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);
beforeEach(() => {
  went.toNew = [];
});

const business: BusinessSummary = {
  id: 'biz_01k8e2wzr0e008000000000001',
  name: 'Harbor Lights Events',
  slug: 'harbor',
  status: 'active',
};

let cache: QueryClient;
function show(api: FakeApi, tab: CalendarsTab = 'calendars') {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={cache}>
        <main>
          <CalendarsPage tab={tab} client={api.client} business={business} agencySlug="bluebird" />
        </main>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return userEvent.setup();
}
const rowOf = async (name: string) => {
  const cell = await screen.findByRole('rowheader', { name: new RegExp(name) });
  const row = cell.closest('tr');
  if (row === null) throw new Error('A row header is in a row.');
  return within(row);
};
const choose = async (user: ReturnType<typeof userEvent.setup>, name: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
};
const lastList = (api: FakeApi) => api.of('listCalendars').at(-1)?.query;

const tours = calendarOf('21', 'Venue tours');
const tastings = calendarOf('22', 'Tastings', {
  kind: 'round_robin',
  isActive: false,
  bookable: false,
});
const classes = calendarOf('23', 'Dance class', {
  kind: 'class',
  isActive: false,
  supported: false,
  bookable: false,
});
const stuck = calendarOf('24', 'Consultations', { bookable: false });

describe('the calendars list', () => {
  it('has one heading, and no tabs of its own for what the top bar shows', async () => {
    show(fakeCalendarApi({ calendars: [tours] }));
    await rowOf('Venue tours');
    expect(screen.getAllByRole('heading', { level: 1 }).map((each) => each.textContent)).toEqual([
      'Calendars',
    ]);
    // GoHighLevel's Service menu, Rooms and Equipment have nothing behind them here.
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(screen.queryByText(/Service menu|Rooms|Equipment|available in this version/)).toBeNull();
  });

  it('shows each calendar with its id, type, status and what keeps it from booking', async () => {
    show(fakeCalendarApi({ calendars: [tours, tastings, classes, stuck] }));
    const first = await rowOf('Venue tours');
    expect(first.getByText(`Id: ${tours.id}`)).toBeDefined();
    expect(first.getByText('30 min')).toBeDefined();
    expect(first.getByText('Personal booking')).toBeDefined();
    expect(first.getByText('Active')).toBeDefined();
    expect(first.queryByText('Not bookable yet')).toBeNull();
    expect(first.getByRole('link', { name: 'Edit Venue tours' }).getAttribute('href')).toBe(
      `/calendars/${tours.id}`,
    );
    // No control that does nothing: no greyed Integrations button.
    expect(first.queryByRole('button', { name: /Integrations/ })).toBeNull();
    expect(screen.queryAllByRole('button').filter((each) => each.ariaDisabled === 'true')).toEqual(
      [],
    );

    const second = await rowOf('Tastings');
    expect(second.getByText('Round robin')).toBeDefined();
    expect(second.getByText('Inactive')).toBeDefined();
    expect(second.queryByText('Not bookable yet')).toBeNull();

    const third = await rowOf('Dance class');
    expect(third.getByText('Class booking')).toBeDefined();
    expect(third.getByText("this type can't take bookings yet.")).toBeDefined();

    const fourth = await rowOf('Consultations');
    expect(fourth.getByText('Active')).toBeDefined();
    expect(fourth.getByText('it needs its team.')).toBeDefined();
    expect(screen.getByText('1 - 4 of 4')).toBeDefined();
  });

  it('asks the server for what the filters and the search say', async () => {
    const api = fakeCalendarApi({
      configurations: [
        {
          calendar: tours,
          members: [{ membershipId: danaId, weight: 1, locations: [] }],
          weeklyHours: [],
          dateOverrides: [],
          revision: 'a'.repeat(64),
          canManage: true,
        },
      ],
      calendars: [tastings, classes],
    });
    const user = show(api);
    await rowOf('Venue tours');
    expect(lastList(api)).toEqual({ limit: 25 });

    await choose(user, 'Status', 'Status: Inactive');
    await waitFor(() => {
      expect(lastList(api)).toEqual({ limit: 25, status: 'inactive' });
    });
    await choose(user, 'Type', 'Type: Class booking');
    await waitFor(() => {
      expect(lastList(api)).toEqual({ limit: 25, status: 'inactive', kind: 'class' });
    });
    await rowOf('Dance class');
    expect(screen.queryByRole('rowheader', { name: /Tastings/ })).toBeNull();

    await choose(user, 'Status', 'Status: All');
    await choose(user, 'Type', 'Type: All');
    // Only people of the account own calendars: the agency's staff are not offered.
    await user.click(screen.getByRole('combobox', { name: 'Owned by' }));
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'Owned by: Anyone',
      'Owned by: Dana Brooks',
      'Owned by: Lee Park',
    ]);
    await user.click(screen.getByRole('option', { name: 'Owned by: Dana Brooks' }));
    await waitFor(() => {
      expect(lastList(api)).toEqual({ limit: 25, member: danaId });
    });

    await user.type(screen.getByRole('searchbox', { name: 'Calendar/group name' }), 'tour');
    await waitFor(() => {
      expect(lastList(api)).toEqual({ limit: 25, member: danaId, q: 'tour' });
    });
    expect(api.of('listUsers')[0]?.query).toEqual({ type: 'account', limit: 100 });
  });

  it('says so when no calendar matches, and when there is none at all', async () => {
    const api = fakeCalendarApi();
    const user = show(api);
    expect(
      await screen.findByText("Create a calendar to set your team's availability."),
    ).toBeDefined();
    await choose(user, 'Status', 'Status: Active');
    expect(await screen.findByText('No calendars match.')).toBeDefined();
  });

  it('deletes a calendar after asking, and shows why one with appointments stays', async () => {
    const api = fakeCalendarApi({ calendars: [tours, tastings], booked: [tours.id] });
    const user = show(api);
    await user.click(
      (await rowOf('Venue tours')).getByRole('button', { name: 'Actions for Venue tours' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete Venue tours?' }));
    await user.click(dialog.getByRole('button', { name: 'Delete' }));
    expect((await dialog.findByRole('alert')).textContent).toBe(
      '"Venue tours" has appointments, so it can\'t be deleted. Make it inactive instead.',
    );
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));

    await user.click(
      (await rowOf('Tastings')).getByRole('button', { name: 'Actions for Tastings' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete Tastings?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(await screen.findByText('Tastings was deleted.')).toBeDefined();
    expect(api.calendars().map((each) => each.name)).toEqual(['Venue tours']);
  });

  it('shows a row’s embed code for the business’s own website, and copies it', async () => {
    const user = show(fakeCalendarApi({ calendars: [tours] }));
    const written = vi.spyOn(navigator.clipboard, 'writeText');
    const trigger = (await rowOf('Venue tours')).getByRole('button', {
      name: 'Actions for Venue tours',
    });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Embed code' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Embed code' }));
    const code = dialog.getByLabelText<HTMLTextAreaElement>('Code for Venue tours').value;
    const origin = window.location.origin;
    expect(code).toBe(
      [
        `<iframe src="${origin}/book/bluebird/harbor/${tours.bookingSlug}" title="Venue tours" data-crm-booking width="100%" height="860" style="border:0;width:100%" loading="lazy"></iframe>`,
        `<script async src="${origin}/calendars/embed.js"></script>`,
      ].join('\n'),
    );
    await user.click(dialog.getByRole('button', { name: 'Copy code' }));
    expect(written).toHaveBeenCalledWith(code);
    expect(await dialog.findByText('Embed code copied.')).toBeDefined();
    await user.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Embed code' })).toBeNull();
    });
    // Focus goes back to the row's menu button it came from.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('offers nothing that changes a calendar to someone who may only look', async () => {
    const user = show(fakeCalendarApi({ calendars: [tours], groups: ['Sales'], canManage: false }));
    const row = await rowOf('Venue tours');
    expect(row.getByRole('link', { name: 'View Venue tours' })).toBeDefined();
    // The embed code is theirs to copy, as the booking link is; deleting is not.
    await user.click(row.getByRole('button', { name: 'Actions for Venue tours' }));
    expect((await screen.findAllByRole('menuitem')).map((each) => each.textContent)).toEqual([
      'Embed code',
    ]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'New calendar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for the group Sales' })).toBeNull();
  });

  it('keeps the table when the groups fail, and the groups when the table fails', async () => {
    const groupsDown = fakeCalendarApi({ calendars: [tours], groups: ['Sales'] });
    groupsDown.refuse('listCalendarGroups', problem(403));
    const user = show(groupsDown);
    await rowOf('Venue tours');
    const rail = within(screen.getByRole('navigation', { name: 'Calendar groups' }));
    expect((await rail.findByRole('alert')).textContent).toContain("We couldn't load the groups.");
    await user.click(rail.getByRole('button', { name: 'Try again' }));
    expect(await rail.findByRole('button', { name: /^Sales/ })).toBeDefined();
    expect(rail.getByRole('button', { name: 'All calendars (1)' })).toBeDefined();
    cleanup();

    const listDown = fakeCalendarApi({ calendars: [tours], groups: ['Sales'] });
    listDown.refuse('listCalendars', problem(403));
    const second = show(listDown);
    const region = within(await screen.findByRole('region', { name: 'Calendars' }));
    expect((await region.findByRole('alert')).textContent).toContain("We couldn't load calendars.");
    expect(
      await within(screen.getByRole('navigation', { name: 'Calendar groups' })).findByRole(
        'button',
        { name: /^Sales/ },
      ),
    ).toBeDefined();
    await second.click(region.getByRole('button', { name: 'Try again' }));
    await rowOf('Venue tours');
  });
});

describe('calendar groups', () => {
  it('counts the calendars of each group, and filters the table by one or by none', async () => {
    const api = fakeCalendarApi({ calendars: [tours, tastings], groups: ['Sales'] });
    const user = show(api);
    const rail = within(await screen.findByRole('navigation', { name: 'Calendar groups' }));
    expect(await rail.findByRole('button', { name: 'All calendars (2)' })).toBeDefined();
    expect(rail.getByRole('button', { name: 'Not grouped 2' })).toBeDefined();
    await user.click(rail.getByRole('button', { name: 'Sales 0' }));
    await waitFor(() => {
      expect(lastList(api)?.['group']).toMatch(/^calg_/);
    });
    expect(await screen.findByText('No calendars match.')).toBeDefined();
    await user.click(rail.getByRole('button', { name: 'Not grouped 2' }));
    await waitFor(() => {
      expect(lastList(api)).toEqual({ limit: 25, group: 'none' });
    });
    await rowOf('Venue tours');
  });

  it('creates, renames and deletes a group, refusing a name already used', async () => {
    const api = fakeCalendarApi({ calendars: [tours], groups: ['Sales'] });
    const user = show(api);
    const rail = within(await screen.findByRole('navigation', { name: 'Calendar groups' }));
    await user.click(await rail.findByRole('button', { name: 'New group' }));
    const create = within(await screen.findByRole('dialog', { name: 'New group' }));
    await user.click(create.getByRole('button', { name: 'Create group' }));
    expect((await create.findByRole('alert')).textContent).toBe('Give the group a name.');
    await user.type(create.getByLabelText('Group name'), 'Sales');
    await user.click(create.getByRole('button', { name: 'Create group' }));
    expect((await create.findByRole('alert')).textContent).toBe(
      'Another group already has this name.',
    );
    await user.clear(create.getByLabelText('Group name'));
    await user.type(create.getByLabelText('Group name'), 'Support');
    await user.click(create.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByText('Group Support created.')).toBeDefined();
    expect(await rail.findByRole('button', { name: 'Support 0' })).toBeDefined();

    await user.click(rail.getByRole('button', { name: 'Actions for the group Support' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const rename = within(await screen.findByRole('dialog', { name: 'Rename group' }));
    await user.clear(rename.getByLabelText('Group name'));
    await user.type(rename.getByLabelText('Group name'), 'Success');
    await user.click(rename.getByRole('button', { name: 'Save' }));
    expect(await rail.findByRole('button', { name: 'Success 0' })).toBeDefined();

    await user.click(rail.getByRole('button', { name: 'Actions for the group Success' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete the group Success?' })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    await waitFor(() => {
      expect(rail.queryByRole('button', { name: 'Success 0' })).toBeNull();
    });
    expect(api.of('deleteCalendarGroup')).toHaveLength(1);
  });
});

describe('the Availability tab', () => {
  it('leads each person of the account to their own hours in Users', async () => {
    show(fakeCalendarApi(), 'availability');
    const people = within(await screen.findByRole('list', { name: 'People of this account' }));
    expect(people.getAllByRole('link').map((each) => each.getAttribute('href'))).toEqual([
      `/users/${danaId}`,
      `/users/${leeId}`,
    ]);
    expect(screen.queryByText('Ava Agency')).toBeNull();
  });
});

describe('New calendar', () => {
  const openChooser = async (api: FakeApi) => {
    const user = show(api);
    await user.click(await screen.findByRole('button', { name: 'New calendar' }));
    const chooser = await screen.findByRole('dialog', { name: 'Choose calendar type' });
    return { user, chooser: within(chooser) };
  };
  const openModal = async (api: FakeApi, type: RegExp) => {
    const { user, chooser } = await openChooser(api);
    await user.click(chooser.getByRole('button', { name: type }));
    const modal = within(await screen.findByRole('dialog', { name: 'New calendar' }));
    return { user, modal };
  };

  it('asks for a type first, offering only the types that take bookings', async () => {
    const { chooser } = await openChooser(fakeCalendarApi());
    const types = within(chooser.getByRole('list', { name: 'Calendar types' }));
    expect(types.getAllByRole('button').map((each) => each.textContent)).toEqual([
      expect.stringMatching(
        /^Personal bookingSchedules one-on-one meetings with a specific team member\.E\.g\.: Client meetings, private consultations\.$/,
      ),
      expect.stringMatching(/^Round robinDistributes appointments among team members/),
    ]);
    for (const name of [/^Class booking/, /^Collective booking/, /^Service booking/, /^Event/])
      expect(chooser.queryByRole('button', { name })).toBeNull();
    expect(chooser.queryByRole('button', { name: 'Explore more types' })).toBeNull();
  });

  it('offers only people of the account, and creates a draft with weekday hours', async () => {
    const api = fakeCalendarApi();
    const { user, modal } = await openModal(api, /^Personal booking/);
    expect(modal.getByText('Type: Personal booking')).toBeDefined();
    expect(modal.getByText('/book/bluebird/harbor/')).toBeDefined();
    expect(modal.getByText('Weekdays, 8:00 AM to 5:00 PM')).toBeDefined();

    await user.type(modal.getByLabelText('Calendar name'), 'Outbound reach');
    expect(modal.getByLabelText<HTMLInputElement>('Custom URL').value).toBe('outbound-reach');
    await user.click(modal.getByRole('combobox', { name: 'Select team member' }));
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'Select a team member',
      'Dana Brooks',
      'Lee Park',
    ]);
    await user.click(screen.getByRole('option', { name: 'Dana Brooks' }));
    // The person's hours: the calendar's, since they keep no schedule of their own.
    const hours = within(modal.getByRole('region', { name: 'Booking availability' }));
    expect(await hours.findByText('Dana Brooks')).toBeDefined();
    expect(hours.getByText('Weekdays, 8:00 AM to 5:00 PM')).toBeDefined();
    await user.clear(modal.getByLabelText('Meeting duration'));
    await user.type(modal.getByLabelText('Meeting duration'), '1');
    await user.click(modal.getByRole('combobox', { name: 'Unit of Meeting duration' }));
    await user.click(await screen.findByRole('option', { name: 'Hours' }));

    await user.click(modal.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Outbound reach was created as a draft.')).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'New calendar' })).toBeNull();
    const [sent] = api.of('createCalendar');
    expect(createCalendarInput.parse(sent?.body)).toMatchObject({
      name: 'Outbound reach',
      kind: 'personal',
      bookingSlug: 'outbound-reach',
      timezone: 'Africa/Nairobi',
      isActive: false,
      slotMinutes: 60,
      members: [{ membershipId: danaId, weight: 1, locations: [] }],
      weeklyHours: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startTime: '08:00',
        endTime: '17:00',
      })),
    });
    await rowOf('Outbound reach');
  });

  it('shows a person’s own hours when they keep a schedule', async () => {
    const api = fakeCalendarApi({
      schedules: {
        [leeId]: {
          timezone: 'Africa/Nairobi',
          inheritCalendarHours: false,
          weeklyHours: [{ weekday: 2, startMinute: 600, endMinute: 780 }],
          dateOverrides: [],
        },
      },
    });
    const { user, modal } = await openModal(api, /^Round robin/);
    await user.click(modal.getByRole('combobox', { name: 'Select team members' }));
    await user.click(await screen.findByRole('option', { name: 'Lee Park' }));
    await user.keyboard('{Escape}');
    const hours = within(await modal.findByRole('region', { name: 'Booking availability' }));
    expect(await hours.findByText(/Tue, 10:00 AM to 1:00 PM/)).toBeDefined();
    expect(hours.getByText(/their own hours/)).toBeDefined();
  });

  it('says what is missing, and shows the server’s refusal of someone not on the team', async () => {
    const api = fakeCalendarApi();
    const { user, modal } = await openModal(api, /^Personal booking/);
    await user.click(modal.getByRole('button', { name: 'Confirm' }));
    expect(await modal.findByText('Give the calendar a name.')).toBeDefined();
    expect(
      modal.getByText('Use lowercase letters, numbers and hyphens, such as my-calendar.'),
    ).toBeDefined();
    expect(api.of('createCalendar')).toHaveLength(0);

    await user.type(modal.getByLabelText('Calendar name'), 'Tours');
    api.refuse(
      'createCalendar',
      problem(422, {
        errors: [
          {
            path: '/members',
            code: 'invalid',
            message: 'Choose a supported calendar and its business team.',
          },
        ],
      }),
    );
    await user.click(modal.getByRole('button', { name: 'Confirm' }));
    expect(
      await modal.findByText('Choose a supported calendar and its business team.'),
    ).toBeDefined();
    expect(avaId).not.toBe(danaId);
  });

  it('hands what was typed to the full editor from "Advanced settings", unsaved', async () => {
    const api = fakeCalendarApi();
    const { user, modal } = await openModal(api, /^Round robin/);
    await user.type(modal.getByLabelText('Calendar name'), 'Sales calls');
    await user.click(modal.getByRole('button', { name: 'Add description' }));
    await user.type(modal.getByLabelText('Description'), 'First calls');
    await user.click(modal.getByRole('button', { name: 'Advanced settings' }));
    expect(went.toNew).toEqual(['round_robin']);
    expect(cache.getQueryData<CalendarDraft>(calendarCarryKey(business.id))).toMatchObject({
      kind: 'round_robin',
      name: 'Sales calls',
      description: 'First calls',
      bookingSlug: 'sales-calls',
      timezone: 'Africa/Nairobi',
    });
    expect(api.of('createCalendar')).toHaveLength(0);
  });
});
