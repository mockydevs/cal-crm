// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  createCalendarInput,
  updateCalendarAvailabilityInput,
  updateCalendarInput,
  type BusinessSummary,
  type CalendarConfiguration,
  type CalendarKind,
} from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calendarOf,
  danaId,
  fakeCalendarApi,
  leeId,
  problem,
  senderId,
  type FakeApi,
} from '../e2e/calendar-settings-fake';
import { CalendarEditorPage } from './calendar-settings-editor';
import {
  calendarCarryKey,
  calendarNoticeKey,
  newDraft,
  type CalendarDraft,
} from './calendar-settings-rules';

const went = vi.hoisted(() => ({ toCalendar: [] as string[] }));
vi.mock('./shell/page', () => ({ usePageTitle: () => undefined }));
vi.mock('./calendar-settings-links', () => ({
  CalendarsLink: ({ children, slug: _slug, ...rest }: { slug: string; children: ReactNode }) => (
    <a href="/calendars" {...rest}>
      {children}
    </a>
  ),
  useCalendarNavigation: () => ({
    toList: () => undefined,
    toNew: () => undefined,
    toCalendar: (id: string) => {
      went.toCalendar.push(id);
    },
  }),
}));
// The reminders line in Notifications links to Automation; there is no router here.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// A busy machine (another lane's build, a two-core runner) answers late: wait longer for it.
configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);
beforeEach(() => {
  went.toCalendar = [];
});

const business: BusinessSummary = {
  id: 'biz_01k8e2wzr0e008000000000001',
  name: 'Harbor Lights Events',
  slug: 'harbor',
  status: 'active',
};

let cache: QueryClient;
function show(
  api: FakeApi,
  page: { calendarId?: string; kind?: CalendarKind; carried?: CalendarDraft; said?: string } = {},
) {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (page.carried !== undefined) cache.setQueryData(calendarCarryKey(business.id), page.carried);
  if (page.said !== undefined) cache.setQueryData(calendarNoticeKey(business.id), page.said);
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={cache}>
        <main>
          <CalendarEditorPage
            client={api.client}
            business={business}
            agencySlug="bluebird"
            {...(page.calendarId === undefined ? {} : { calendarId: page.calendarId })}
            {...(page.kind === undefined ? {} : { kind: page.kind })}
          />
        </main>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return userEvent.setup();
}
type User = ReturnType<typeof userEvent.setup>;
const choose = async (user: User, name: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
};
const openSection = async (user: User, name: string, heading: string = name) => {
  await user.click(screen.getByRole('tab', { name }));
  await screen.findByRole('heading', { level: 2, name: heading });
};
const save = async (user: User) => {
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
};
const retype = async (user: User, label: string, text: string) => {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  if (text !== '') await user.type(field, text);
};

const consultation = calendarOf('31', 'Consultation', { isActive: false, bookable: false });
function saved(rest: Partial<CalendarConfiguration> = {}): CalendarConfiguration {
  return {
    calendar: consultation,
    members: [{ membershipId: danaId, weight: 1, locations: [] }],
    weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
    dateOverrides: [],
    revision: 'a'.repeat(64),
    canManage: true,
    ...rest,
  };
}
const existing = (rest: Partial<CalendarConfiguration> = {}, canManage = true) =>
  fakeCalendarApi({ configurations: [saved(rest)], groups: ['Sales'], canManage });

describe('the sections', () => {
  it('lists four, then three more under "Advanced settings", with a tip for each', async () => {
    const user = show(existing(), { calendarId: consultation.id });
    expect(await screen.findByRole('heading', { level: 1, name: 'Consultation' })).toBeDefined();
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    expect(screen.getAllByRole('tab').map((each) => each.textContent)).toEqual([
      'Basic details',
      'Staff & location',
      'Availability',
      'Booking rules',
    ]);
    const tip = within(screen.getByRole('complementary', { name: 'Quick tip' }));
    expect(tip.getByText(/^Groups keep related calendars together/)).toBeDefined();

    const advanced = screen.getByRole('button', { name: 'Advanced settings' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    await user.click(advanced);
    expect(screen.getAllByRole('tab').map((each) => each.textContent)).toEqual([
      'Basic details',
      'Staff & location',
      'Availability',
      'Booking rules',
      'Confirmation consent',
      'Notifications & policies',
      'Widget appearance',
    ]);
    // GoHighLevel's Payments and Booking channels have nothing behind them here.
    expect(screen.queryByRole('tab', { name: 'Payments' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Booking channels' })).toBeNull();

    // The arrow keys walk every section shown, and wrap.
    screen.getByRole('tab', { name: 'Booking rules' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByRole('tab', { name: 'Confirmation consent' }).getAttribute('aria-selected'),
    ).toBe('true');
    await screen.findByRole('heading', { level: 2, name: 'Confirmation consent' });
    await user.keyboard('{End}{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'Basic details' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    // Nothing on any section is drawn off or said to be missing: every control does something.
    await user.click(screen.getByRole('tab', { name: 'Notifications & policies' }));
    await screen.findByRole('switch', { name: /Allow rescheduling/ });
    await openSection(user, 'Widget appearance', 'Customizations');
    expect(screen.queryByText(/available in this version|doesn't draw/)).toBeNull();
    expect([
      ...document.querySelectorAll('[aria-disabled="true"], [role="switch"][disabled]'),
    ]).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Integrations' })).toBeNull();

    // Closing "Advanced settings" on one of its sections goes back to the first.
    await user.click(advanced);
    expect(screen.getByRole('tab', { name: 'Basic details' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });
});

describe('a new calendar', () => {
  it('opens on "Create" with the type chosen, and is one createCalendar', async () => {
    const api = fakeCalendarApi({ groups: ['Sales'] });
    const user = show(api, { kind: 'round_robin' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Create' })).toBeDefined();
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    expect(screen.getByRole('combobox', { name: 'Calendar type' }).textContent).toContain(
      'Round robin',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Time zone').value).toBe('Africa/Nairobi');
    expect(screen.getByLabelText<HTMLInputElement>('Meeting invite title').value).toBe(
      '{{contact.name}}',
    );
    // No link before it is saved, so nothing to copy and no button for it.
    expect(screen.queryByRole('button', { name: 'Copy the booking link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Integrations' })).toBeNull();

    await save(user);
    expect(await screen.findByText('Give the calendar a name.')).toBeDefined();
    expect(api.of('createCalendar')).toHaveLength(0);

    await user.type(screen.getByLabelText('Calendar name'), 'Sales calls');
    await user.type(screen.getByLabelText('Custom URL'), 'sales-calls');
    await choose(user, 'Group', 'Sales');
    await user.click(screen.getByRole('button', { name: 'Insert a merge field' }));
    await user.click(await screen.findByRole('menuitem', { name: '{{contact.email}}' }));
    await openSection(user, 'Staff & location', 'Staff & meeting location');
    await user.click(
      screen.getByRole('combobox', { name: 'Select staff & assign meeting location' }),
    );
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'Dana Brooks',
      'Lee Park',
    ]);
    await user.click(screen.getByRole('option', { name: 'Dana Brooks' }));
    await user.click(screen.getByRole('option', { name: 'Lee Park' }));
    await user.keyboard('{Escape}');
    await retype(user, 'Booking weight for Lee Park', '3');
    await save(user);
    await waitFor(() => {
      expect(went.toCalendar).toHaveLength(1);
    });
    const sent = createCalendarInput.parse(api.of('createCalendar')[0]?.body);
    expect(sent).toMatchObject({
      name: 'Sales calls',
      kind: 'round_robin',
      bookingSlug: 'sales-calls',
      isActive: false,
      inviteTitle: '{{contact.name}}{{contact.email}}',
      members: [
        { membershipId: danaId, weight: 1, locations: [] },
        { membershipId: leeId, weight: 3, locations: [] },
      ],
    });
    expect(sent.groupId).toMatch(/^calg_/);
    expect(sent.weeklyHours).toHaveLength(5);
    expect(cache.getQueryData(calendarNoticeKey(business.id))).toBe('Calendar created.');
  });

  it('starts from what the "New calendar" modal typed, read once', async () => {
    const carried = {
      ...newDraft('personal', 'Europe/Paris'),
      name: 'Outbound reach',
      bookingSlug: 'outbound-reach',
    };
    show(fakeCalendarApi(), { kind: 'personal', carried });
    expect(await screen.findByLabelText<HTMLInputElement>('Calendar name')).toHaveProperty(
      'value',
      'Outbound reach',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Time zone').value).toBe('Europe/Paris');
    expect(cache.getQueryData(calendarCarryKey(business.id))).toBeUndefined();
  });

  it('offers a new calendar only the types that take bookings', async () => {
    const user = show(fakeCalendarApi(), { kind: 'personal' });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await user.click(screen.getByRole('combobox', { name: 'Calendar type' }));
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'Personal booking',
      'Round robin',
    ]);
  });
});

describe('a saved draft of a type that cannot take bookings yet', () => {
  const dance = calendarOf('32', 'Dance class', {
    kind: 'class',
    isActive: false,
    supported: false,
    bookable: false,
  });
  const draft = () =>
    fakeCalendarApi({ configurations: [saved({ calendar: dance })], groups: ['Sales'] });

  it('opens, says plainly it can’t take bookings, and offers no switch to turn it on', async () => {
    const user = show(draft(), { calendarId: dance.id });
    expect(await screen.findByRole('heading', { level: 1, name: 'Dance class' })).toBeDefined();
    expect(
      await screen.findByText(
        "This type of calendar can't take bookings yet, so it stays a draft. To take bookings, change its type to Personal booking or Round robin.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole('switch', { name: 'Active' })).toBeNull();
    // Its own type stays on offer beside the two that take bookings.
    await user.click(screen.getByRole('combobox', { name: 'Calendar type' }));
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'Personal booking',
      'Round robin',
      'Class booking',
    ]);
    await user.keyboard('{Escape}');
  });

  it('becomes a personal calendar that can be switched on', async () => {
    const api = draft();
    const user = show(api, { calendarId: dance.id });
    await screen.findByRole('heading', { level: 1, name: 'Dance class' });
    await choose(user, 'Calendar type', 'Personal booking');
    expect(screen.queryByText(/can't take bookings yet/)).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    await save(user);
    await waitFor(() => {
      expect(api.of('updateCalendar')).toHaveLength(1);
    });
    expect(updateCalendarInput.parse(api.of('updateCalendar')[0]?.body)).toMatchObject({
      kind: 'personal',
      isActive: true,
    });
  });
});

describe('a saved calendar', () => {
  it('says what the page before left to say', async () => {
    show(existing(), { calendarId: consultation.id, said: 'Calendar created.' });
    expect(await screen.findByText('Calendar created.')).toHaveProperty('role', 'status');
  });

  it('sends only the settings when the team and hours are as they were', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    await screen.findByLabelText('Calendar name');
    await retype(user, 'Calendar name', 'First consultation');
    await retype(user, 'Description', 'Thirty minutes with us.');
    await save(user);
    expect(await screen.findByText('Changes saved.')).toBeDefined();
    expect(api.of('updateCalendarAvailability')).toHaveLength(0);
    expect(updateCalendarInput.parse(api.of('updateCalendar')[0]?.body)).toMatchObject({
      name: 'First consultation',
      description: 'Thirty minutes with us.',
      revision: '1'.padStart(64, '0'),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'First consultation' }),
    ).toBeDefined();
  });

  it('saves the team and places first, then the settings on the revision that gave', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await openSection(user, 'Staff & location', 'Staff & meeting location');
    await user.click(screen.getByRole('button', { name: 'Add location for Dana Brooks' }));
    await choose(user, 'Kind of meeting location 1 of Dana Brooks', 'Address');
    await user.type(screen.getByLabelText('Meeting location 1 of Dana Brooks'), '1 Pier Road');
    await user.click(
      screen.getByRole('button', {
        name: 'Add display label to meeting location 1 of Dana Brooks',
      }),
    );
    await user.type(
      screen.getByLabelText('Display label of meeting location 1 of Dana Brooks'),
      'Office',
    );
    await user.click(screen.getByRole('tab', { name: 'Basic details' }));
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    await save(user);
    expect(await screen.findByText('Changes saved.')).toBeDefined();
    expect(api.calls.filter((call) => call.operation.startsWith('update'))).toMatchObject([
      { operation: 'updateCalendarAvailability' },
      { operation: 'updateCalendar' },
    ]);
    expect(
      updateCalendarAvailabilityInput.parse(api.of('updateCalendarAvailability')[0]?.body),
    ).toEqual({
      members: [
        {
          membershipId: danaId,
          weight: 1,
          locations: [{ kind: 'address', value: '1 Pier Road', label: 'Office' }],
        },
      ],
      weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
      dateOverrides: [],
      revision: '1'.padStart(64, '0'),
    });
    expect(updateCalendarInput.parse(api.of('updateCalendar')[0]?.body)).toMatchObject({
      isActive: true,
      revision: '2'.padStart(64, '0'),
    });
  });

  it('offers Google Meet only to someone whose Google Calendar is connected, and says why', async () => {
    const team = (dana: 'connected' | 'disconnected') => ({
      available: true,
      mine: null,
      team: [
        {
          membershipId: danaId,
          status: dana,
          disconnectedReason: dana === 'disconnected' ? ('member' as const) : null,
          busyCheckedAt: null,
          busyFailing: false,
        },
      ],
    });
    const calendar = (dana: 'connected' | 'disconnected') =>
      fakeCalendarApi({
        configurations: [
          saved({
            members: [
              {
                membershipId: danaId,
                weight: 1,
                locations: [{ kind: 'google_meet', value: 'Google Meet', label: null }],
              },
              { membershipId: leeId, weight: 1, locations: [] },
            ],
          }),
        ],
        google: team(dana),
      });
    const meetNote = /Dana Brooks's Google Calendar isn't connected, so no Meet can be made/;
    let user = show(calendar('connected'), { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await openSection(user, 'Staff & location', 'Staff & meeting location');
    // Lee never connected: no Meet among the kinds, and what would make it one.
    expect(
      await screen.findByText(
        /Google Meet becomes a choice once Lee Park connects their Google Calendar/,
      ),
    ).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Add location for Lee Park' }));
    await user.click(
      screen.getByRole('combobox', { name: 'Kind of meeting location 1 of Lee Park' }),
    );
    expect(screen.queryByRole('option', { name: 'Google Meet' })).toBeNull();
    await user.keyboard('{Escape}');
    // Dana is connected: her Meet is offered, with nothing to warn about.
    await user.click(screen.getByRole('button', { name: 'Add location for Dana Brooks' }));
    await user.click(
      screen.getByRole('combobox', { name: 'Kind of meeting location 2 of Dana Brooks' }),
    );
    expect(await screen.findByRole('option', { name: 'Google Meet' })).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByText(meetNote)).toBeNull();
    cleanup();

    // Dana disconnected: the Meet she has stays shown, and says what bookings get instead.
    user = show(calendar('disconnected'), { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await openSection(user, 'Staff & location', 'Staff & meeting location');
    expect(await screen.findByText(meetNote)).toBeDefined();
  });

  it('opens the section of a field that is wrong, and sends nothing', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await openSection(user, 'Booking rules');
    await retype(user, 'Meeting duration', '2');
    await user.click(screen.getByRole('tab', { name: 'Basic details' }));
    await save(user);
    expect(await screen.findByText('Enter a whole number, from 5 to 480 minutes.')).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Booking rules' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Meeting duration'));
    });
    expect(api.calls.some((call) => call.operation.startsWith('update'))).toBe(false);
  });

  it('saves every booking rule in minutes and days', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await openSection(user, 'Booking rules');
    await retype(user, 'Meeting interval', '15');
    await retype(user, 'Meeting duration', '1');
    await choose(user, 'Unit of Meeting duration', 'Hours');
    await user.click(screen.getByRole('button', { name: 'Add another duration' }));
    await user.type(screen.getByLabelText('Meeting duration 2'), '45');
    await retype(user, 'Minimum scheduling notice', '2');
    await choose(user, 'Unit of Minimum scheduling notice', 'Days');
    await retype(user, 'Date range', '30');
    await user.click(screen.getByRole('switch', { name: 'Count available days only' }));
    await retype(user, 'Pre buffer time', '10');
    await retype(user, 'Post buffer time', '5');
    await user.click(screen.getByRole('button', { name: 'Increase Maximum bookings per day' }));
    await user.click(screen.getByRole('button', { name: 'Increase Maximum bookings per day' }));
    await user.click(screen.getByRole('button', { name: 'Increase Maximum bookings per slot' }));
    await user.click(screen.getByRole('button', { name: 'Increase Maximum bookings per slot' }));
    expect(screen.getByLabelText('Look busy percentage').hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'Look busy' }));
    await retype(user, 'Look busy percentage', '25');
    await save(user);
    expect(await screen.findByText('Changes saved.')).toBeDefined();
    expect(updateCalendarInput.parse(api.of('updateCalendar')[0]?.body)).toMatchObject({
      slotIntervalMinutes: 15,
      slotMinutes: 60,
      extraDurationMinutes: [45],
      minNoticeMinutes: 2880,
      maxDaysAhead: 30,
      countAvailableDaysOnly: true,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 5,
      maxPerDay: 2,
      maxPerSlot: 2,
      lookBusyPercent: 25,
    });
  });

  it('saves the consent box, the policies and the widget’s looks', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await user.click(screen.getByRole('button', { name: 'Advanced settings' }));

    await openSection(user, 'Confirmation consent', 'Confirmation consent');
    const consent = screen.getByRole('switch', { name: 'Consent checkbox' });
    expect(consent.getAttribute('aria-checked')).toBe('true');
    // Off, the wording can't be typed: there is no box on the booking page to put it in.
    await user.click(consent);
    expect(screen.getByLabelText('Consent wording').hasAttribute('disabled')).toBe(true);
    await user.click(consent);
    await user.type(screen.getByLabelText('Consent wording'), 'I agree.');
    // Bot protection: off until chosen, then ALTCHA's proof of work.
    expect(screen.getByRole('combobox', { name: 'Bot protection' }).textContent).toContain('Off');
    await choose(user, 'Bot protection', 'Proof of work (ALTCHA)');

    await openSection(user, 'Notifications & policies', 'Notifications');
    await waitFor(() => {
      expect(screen.queryByText('Loading senders…')).toBeNull();
    });
    await choose(user, 'Confirmation sender', 'Bookings · bookings@example.test');
    const skip = screen.getByRole('switch', {
      name: 'Skip assigning Contact if the Contact has already an assigned user.',
    });
    expect(skip.hasAttribute('disabled')).toBe(false);
    await user.click(skip);
    await user.type(screen.getByLabelText('Rescheduling link will expire'), '2');
    await choose(user, 'Unit of Rescheduling link will expire', 'Hours');
    await user.click(screen.getByRole('switch', { name: 'Allow cancellation of meeting' }));
    expect(screen.getByLabelText('Cancellation link will expire').hasAttribute('disabled')).toBe(
      true,
    );

    await openSection(user, 'Widget appearance', 'Customizations');
    // Drawn on the booking page now: nothing says it isn't.
    expect(screen.queryByText(/doesn't draw/)).toBeNull();
    await retype(user, 'Primary color', '#0F766E');
    await retype(user, 'Background color', 'cream');
    await user.type(screen.getByLabelText('Button text'), 'Book now');
    // A wrong colour stays in sight under Classic, which otherwise hides Neo's colours.
    await user.click(screen.getByRole('radio', { name: 'Classic' }));
    await save(user);
    expect(await screen.findByText('Use a colour such as #178af6.')).toBeDefined();
    expect(api.of('updateCalendar')).toHaveLength(0);
    await retype(user, 'Background color', '#fffbeb');
    await user.click(screen.getByRole('radio', { name: 'Neo' }));
    expect(screen.getByLabelText<HTMLInputElement>('Primary color').value).toBe('#0F766E');
    // Classic keeps the standard colours and words, as GoHighLevel's does: they are kept,
    // not offered.
    await user.click(screen.getByRole('radio', { name: 'Classic' }));
    expect(screen.queryByLabelText('Primary color')).toBeNull();
    expect(screen.getByText(/The classic widget keeps the standard colours/)).toBeDefined();
    await save(user);
    expect(await screen.findByText('Changes saved.')).toBeDefined();
    expect(updateCalendarInput.parse(api.of('updateCalendar')[0]?.body)).toMatchObject({
      consentEnabled: true,
      consentText: 'I agree.',
      botProtection: 'altcha',
      confirmationSenderId: senderId,
      assignContactToMember: true,
      skipAssignIfOwned: true,
      allowReschedule: true,
      rescheduleCutoffMinutes: 120,
      allowCancel: false,
      cancelCutoffMinutes: null,
      widgetStyle: 'classic',
      primaryColor: '#0f766e',
      backgroundColor: '#fffbeb',
      buttonText: 'Book now',
    });
  });

  it('uploads a logo and keeps its file', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    const input = await screen.findByLabelText('Calendar logo');
    // A file the picker would not offer, as one dropped on the zone can be.
    await userEvent
      .setup({ applyAccept: false })
      .upload(input, new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('Choose a PNG, JPEG, GIF or WebP image.')).toBeDefined();
    await user.upload(input, new File(['x'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByRole('img', { name: 'Calendar logo preview' })).toBeDefined();
    // Into Media Storage, at a public address, so the booking page can show it.
    expect(
      await screen.findByText(
        "Shown on the booking page. It's in Media Storage, at an address anyone can open.",
      ),
    ).toBeDefined();
    expect(api.of('uploadFile')[0]?.query).toMatchObject({ filename: 'logo.png', library: 'true' });
    expect(api.of('updateMediaFile')[0]).toMatchObject({
      params: { id: 'file_01h455vb4pex5vsknk084sn02q' },
      body: { public: true },
    });
    await save(user);
    expect(await screen.findByText('Changes saved.')).toBeDefined();
    expect(updateCalendarInput.parse(api.of('updateCalendar')[0]?.body).logoFileId).toBe(
      'file_01h455vb4pex5vsknk084sn02q',
    );
  });

  it('says when a picture is private, and makes it public when asked', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    api.refuse(
      'updateMediaFile',
      problem(403, { detail: 'You need permission to manage Media Storage.' }),
    );
    await user.upload(
      await screen.findByLabelText('Calendar logo'),
      new File(['x'], 'logo.png', { type: 'image/png' }),
    );
    expect(
      await screen.findByText(/couldn't be given a public address.*permission to manage Media/),
    ).toBeDefined();
    expect(
      await screen.findByText(
        "This image is private in Media Storage, so the booking page doesn't show it.",
      ),
    ).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Make it public' }));
    expect(await screen.findByText(/^Shown on the booking page\./)).toBeDefined();
    expect(api.of('updateMediaFile')).toHaveLength(2);
  });

  it('says a picture stored outside Media Storage is not on the booking page', async () => {
    show(
      existing({ calendar: { ...consultation, logoFileId: 'file_01h455vb4pex5vsknk084sn03q' } }),
      {
        calendarId: consultation.id,
      },
    );
    expect(
      await screen.findByText(
        "This image isn't in Media Storage, so the booking page doesn't show it. Upload it again to show it.",
      ),
    ).toBeDefined();
  });

  it('edits the weekly hours and a date with hours of its own, midnight included', async () => {
    const api = existing({
      members: [
        { membershipId: danaId, weight: 1, locations: [] },
        // Someone who has left the team.
        { membershipId: null, weight: 1, locations: [] },
      ],
      weeklyHours: [{ weekday: 5, startTime: '18:00', endTime: '24:00' }],
      dateOverrides: [{ date: '2026-12-31', ranges: [{ startTime: '20:00', endTime: '22:00' }] }],
    });
    const user = show(api, { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await openSection(user, 'Staff & location', 'Staff & meeting location');
    expect(
      screen.getByText(/Someone on this calendar is no longer on the business team\./),
    ).toBeDefined();
    await openSection(user, 'Availability', 'Availability schedule');
    // Saved midnight hours come back as the ticked box, with no end time to type.
    const weekly = screen.getByRole('checkbox', { name: 'Open until midnight' });
    expect(weekly).toHaveProperty('checked', true);
    expect(screen.getByLabelText('End time').hasAttribute('disabled')).toBe(true);
    await user.click(weekly);
    expect(screen.getByLabelText<HTMLInputElement>('End time').value).toBe('23:59');
    await user.click(weekly);
    await user.click(screen.getByRole('checkbox', { name: 'Override open until midnight' }));
    expect(screen.getByLabelText('Override end time').hasAttribute('disabled')).toBe(true);
    await save(user);
    expect(await screen.findByText('Changes saved.')).toBeDefined();
    // The member who left is not sent back; the hours end at 24:00, not a minute before.
    expect(
      updateCalendarAvailabilityInput.parse(api.of('updateCalendarAvailability')[0]?.body),
    ).toEqual({
      members: [{ membershipId: danaId, weight: 1, locations: [] }],
      weeklyHours: [{ weekday: 5, startTime: '18:00', endTime: '24:00' }],
      dateOverrides: [{ date: '2026-12-31', ranges: [{ startTime: '20:00', endTime: '24:00' }] }],
      revision: '1'.padStart(64, '0'),
    });
  });

  it('keeps what was typed when someone else saved first, and reloads only when asked', async () => {
    const api = existing();
    const user = show(api, { calendarId: consultation.id });
    await screen.findByLabelText('Calendar name');
    await retype(user, 'Calendar name', 'Unsaved tour');
    api.touch(consultation.id, { name: 'Remote edit' });
    await save(user);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Calendar changed since you opened it.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Calendar name').value).toBe('Unsaved tour');
    await user.click(screen.getByRole('button', { name: 'Reload saved calendar' }));
    expect(await screen.findByText('Calendar reloaded.')).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('Calendar name').value).toBe('Remote edit');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the server’s refusal of the team under the staff', async () => {
    const api = existing({ members: [] });
    const user = show(api, { calendarId: consultation.id });
    await screen.findByRole('heading', { level: 2, name: 'Basic details' });
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    api.refuse(
      'updateCalendar',
      new (await import('@repo/sdk')).ApiError({
        type: 'about:blank',
        title: 'Unprocessable',
        status: 422,
        errors: [
          {
            path: '/isActive',
            code: 'invalid',
            message: 'Choose this business team before activating the calendar.',
          },
        ],
      }),
    );
    await save(user);
    expect(
      await screen.findByText('Choose this business team before activating the calendar.'),
    ).toBeDefined();
  });

  it('lets someone without the permission look, and change nothing', async () => {
    const api = existing({}, false);
    const user = show(api, { calendarId: consultation.id });
    expect(await screen.findByLabelText('Calendar name')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('switch', { name: 'Active' })).toHaveProperty('disabled', true);
    await openSection(user, 'Availability', 'Availability schedule');
    expect(screen.getByLabelText('Start time')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Add opening hours' })).toHaveProperty(
      'disabled',
      true,
    );
    // Other people's schedules are not read without the permission.
    expect(api.of('getCalendarUserAvailability')).toHaveLength(0);
  });

  it('says when the calendar is gone', async () => {
    show(fakeCalendarApi(), { calendarId: consultation.id });
    expect((await screen.findByRole('alert')).textContent).toBe(
      "This calendar isn't here any more.",
    );
  });
});
