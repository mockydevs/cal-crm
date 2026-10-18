// @vitest-environment jsdom
// Settings → External Tracking, its three tabs as GoHighLevel lays them out: Installation
// (the script to copy and the events it tracks), Troubleshoot (what the script reported) and
// Settings (what it records, where it answers, and a new tracking id). The API is a small
// world shaped by the contract's own types (e2e/external-tracking-fixtures.ts).
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  heardFrom,
  isRefusal,
  permissionsOf,
  regenerateIn,
  trackedContactId,
  trackingId,
  trackingWorldOf,
  updateTrackingIn,
  type TrackingWorld,
} from '../../e2e/external-tracking-fixtures';
import InstallationTab from './installation-tab';
import SettingsTab from './settings-tab';
import TroubleshootTab from './troubleshoot-tab';

interface Input {
  readonly body?: unknown;
}
const server = vi.hoisted((): { world: TrackingWorld | undefined; writes: unknown[] } => ({
  world: undefined,
  writes: [],
}));

vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: Input) =>
      Promise.resolve().then(() => {
        const world = server.world;
        if (world === undefined) throw new Error('no server');
        if (input.body !== undefined) server.writes.push(input.body);
        const answers: Record<string, () => unknown> = {
          getExternalTracking: () => world.settings,
          getExternalTrackingActivity: () => world.activity,
          getMyPermissions: () => permissionsOf(world),
          updateExternalTracking: () => updateTrackingIn(world, input.body),
          regenerateTrackingId: () => regenerateIn(world, input.body),
        };
        const answer = answers[endpoint.operationId]?.();
        if (answer === undefined) throw new Error(`unexpected ${endpoint.operationId}`);
        if (isRefusal(answer))
          throw new ApiError({ type: 'about:blank', title: 'Refused', ...answer });
        return answer;
      }),
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Acme Roofing', slug: 'acme' }),
}));
vi.mock('../shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.world = undefined;
  server.writes = [];
});
afterEach(cleanup);

function show(part: ReactNode, world: TrackingWorld = trackingWorldOf()) {
  server.world = world;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>{part}</I18nProvider>
    </QueryClientProvider>,
  );
  return { world, user: userEvent.setup() };
}

const tag = (id: string) =>
  `<script src="${window.location.origin}/tracking/external-tracking.js" data-tracking-id="${id}"></script>`;

it('Installation gives the script to copy, in GoHighLevel’s words, and the events it tracks', async () => {
  const { user } = show(<InstallationTab />);
  expect(await screen.findByRole('heading', { level: 1, name: 'External Tracking' })).toBeDefined();
  expect(
    screen.getByText(
      'Use our tracking script on your external sites to bring all your analytics - all in one place, with no extra tools needed.',
    ),
  ).toBeDefined();
  expect(
    screen.getByRole('heading', { name: 'External Tracking Script Installation' }),
  ).toBeDefined();
  const code = await screen.findByRole('textbox', { name: 'Tracking script' });
  await waitFor(() => {
    expect((code as HTMLTextAreaElement).value).toBe(tag(trackingId));
  });
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await user.click(screen.getByRole('button', { name: 'Copy Script' }));
  expect(writeText).toHaveBeenCalledWith(tag(trackingId));
  expect(await screen.findByText('Script copied.')).toBeDefined();
  writeText.mockRejectedValueOnce(new Error('denied'));
  await user.click(screen.getByRole('button', { name: 'Copy Script' }));
  expect(
    await screen.findByText("The script couldn't be copied. Select it and copy it yourself."),
  ).toBeDefined();
  const events = screen.getByRole('region', { name: 'Events Tracked' });
  expect(within(events).getByText('Page Views')).toBeDefined();
  expect(within(events).getByText('Form Fills / Optins')).toBeDefined();
  expect(within(events).getByText(/Give every field a name attribute/)).toBeDefined();
});

it('Installation says when the script is off for page views or forms', async () => {
  const world = trackingWorldOf();
  world.settings = { ...world.settings, pageViews: false, formCapture: false };
  show(<InstallationTab />, world);
  expect(await screen.findByText('Page views are turned off in Settings.')).toBeDefined();
  expect(screen.getByText('Form capture is turned off in Settings.')).toBeDefined();
});

it('Troubleshoot says the script has not been heard from, and what to check', async () => {
  show(<TroubleshootTab />);
  expect(await screen.findByText('Not detected yet')).toBeDefined();
  expect(screen.getByText(/Google Tag Manager/)).toBeDefined();
  expect(screen.queryByRole('table')).toBeNull();
});

it('Troubleshoot shows the latest events and each page last seen', async () => {
  const { user } = show(<TroubleshootTab />, trackingWorldOf({ activity: heardFrom }));
  expect(await screen.findByText('Receiving events')).toBeDefined();
  const [events, pages] = screen.getAllByRole('table');
  if (events === undefined || pages === undefined) throw new Error('Two tables expected.');
  const eventRows = within(events).getAllByRole('row').slice(1);
  expect(eventRows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('Form submission'),
    expect.stringContaining('Page view'),
  ]);
  const [formRow, viewRow] = eventRows;
  if (formRow === undefined || viewRow === undefined) throw new Error('Two events expected.');
  const contact = within(formRow).getByRole('link', { name: 'View contact' });
  expect(contact.getAttribute('href')).toBe(`/b/acme/contacts/${trackedContactId}`);
  expect(within(viewRow).getByText('Unknown visitor')).toBeDefined();
  expect(
    within(pages)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent),
  ).toEqual([
    expect.stringContaining('www.acme-roofing.example/contact'),
    expect.stringContaining('www.acme-roofing.example/pricing'),
  ]);
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByText('Receiving events')).toBeDefined();
});

it('Settings changes what the script records and where it answers', async () => {
  const { user, world } = show(<SettingsTab />);
  const pageViews = await screen.findByRole('checkbox', { name: 'Track page views' });
  await waitFor(() => {
    expect((pageViews as HTMLInputElement).checked).toBe(true);
    expect((pageViews as HTMLInputElement).disabled).toBe(false);
  });
  await user.click(pageViews);
  const websites = screen.getByRole('textbox', { name: 'Allowed websites' });
  await user.type(websites, 'https://www.acme-roofing.example/home{Enter}acme.example');
  await user.click(screen.getByRole('radio', { name: /Never/ }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Settings saved.')).toBeDefined();
  expect(server.writes).toEqual([
    {
      pageViews: false,
      formCapture: true,
      allowedDomains: ['www.acme-roofing.example', 'acme.example'],
      visitorIds: 'never',
      revision: 1,
    },
  ]);
  expect(world.settings.revision).toBe(2);
});

it('Settings refuses a website that is not one, and says when someone else changed it first', async () => {
  const world = trackingWorldOf();
  const { user } = show(<SettingsTab />, world);
  const websites = await screen.findByRole('textbox', { name: 'Allowed websites' });
  await waitFor(() => {
    expect((websites as HTMLTextAreaElement).disabled).toBe(false);
  });
  await user.type(websites, 'not a website');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('These are not websites: not a website')).toBeDefined();
  expect(server.writes).toEqual([]);
  await user.clear(websites);
  world.settings = { ...world.settings, revision: 5 };
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    await screen.findByText(
      'The tracking settings changed since you opened them. Open them again.',
    ),
  ).toBeDefined();
});

it('Settings gives a new tracking id once it is confirmed', async () => {
  const { user, world } = show(<SettingsTab />);
  const button = await screen.findByRole('button', { name: 'Regenerate tracking ID' });
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  await user.click(button);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/stops working at once/)).toBeDefined();
  await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(await screen.findByText(world.settings.trackingId)).toBeDefined();
  expect(world.settings.trackingId).not.toBe(trackingId);
});

it('Settings can only be read by someone who may not manage sites', async () => {
  show(<SettingsTab />, trackingWorldOf({ mayManage: false }));
  expect(
    await screen.findByText('Only people who manage sites can change these settings.'),
  ).toBeDefined();
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Regenerate tracking ID' }).disabled,
  ).toBe(true);
});
