// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { MessagingSettings } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { QuietHoursSettings } from './quiet-hours-settings';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const settingsOf = (patch: Partial<MessagingSettings> = {}): MessagingSettings => ({
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  contactDailyLimit: 10,
  revision: 'a'.repeat(64),
  canManage: true,
  heldMessages: 0,
  contactsWithoutTimeZone: 0,
  ...patch,
});

function open(): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <QuietHoursSettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
const saves = (): unknown[] =>
  server.calls
    .filter((call) => call.operation === 'updateMessagingSettings')
    .map((call) => call.input);
const start = (): Promise<HTMLElement> => screen.findByLabelText('Quiet hours start');
const end = (): HTMLElement => screen.getByLabelText('Quiet hours end');
const limit = (): HTMLElement => screen.getByLabelText('Messages per contact in 24 hours');

it('shows the hours, says when messages wait, and what is waiting now', async () => {
  server.answer = () => settingsOf({ heldMessages: 3, contactsWithoutTimeZone: 1 });
  open();
  expect(await start()).toHaveProperty('value', '21:00');
  expect(end()).toHaveProperty('value', '08:00');
  expect(limit()).toHaveProperty('value', '10');
  expect(screen.getByLabelText('Hold messages during quiet hours')).toHaveProperty('checked', true);
  expect(screen.getByRole('region', { name: 'Quiet hours' })).toBeDefined();
  expect(screen.getByText('Messages wait from 21:00 until 08:00 the next morning.')).toBeDefined();
  expect(screen.getByText('3 messages are waiting for quiet hours to end.')).toBeDefined();
  expect(
    screen.getByText(
      "1 contact has no time zone of its own. Its workflow and campaign messages keep quiet hours by the business's time zone.",
    ),
  ).toBeDefined();
  expect(screen.getByText(/in each contact's own time zone/)).toBeDefined();
});

it('describes a window within one day, and one that is no window at all', async () => {
  server.answer = () => settingsOf({ quietHoursStart: '13:00', quietHoursEnd: '14:30' });
  open();
  await start();
  expect(screen.getByText('Messages wait from 13:00 until 14:30 the same day.')).toBeDefined();
  fireEvent.change(end(), { target: { value: '13:00' } });
  expect(
    screen.getByText('Choose a start and an end that differ, or turn quiet hours off.'),
  ).toBeDefined();
});

it('is read-only for someone whose role cannot change the settings', async () => {
  server.answer = () => settingsOf({ canManage: false });
  open();
  // The whole group is disabled, which each control inherits.
  for (const control of [
    await start(),
    end(),
    limit(),
    screen.getByLabelText('Hold messages during quiet hours'),
  ])
    expect(control.matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save quiet hours' })).toBeNull();
  expect(
    screen.getByText("You can see these settings, but your role can't change them."),
  ).toBeDefined();
  expect(saves()).toEqual([]);
});

it('saves the hours and the limit with the revision that was read', async () => {
  let settings = settingsOf();
  server.answer = (operation, input) => {
    if (operation === 'updateMessagingSettings') {
      const { body } = input as { body: Partial<MessagingSettings> };
      settings = settingsOf({ ...body, revision: 'b'.repeat(64) });
    }
    return settings;
  };
  const user = open();
  fireEvent.change(await start(), { target: { value: '22:30' } });
  fireEvent.change(end(), { target: { value: '07:15' } });
  await user.clear(limit());
  await user.type(limit(), '4');
  screen.getByRole('button', { name: 'Save quiet hours' }).focus();
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(saves()).toEqual([
      {
        body: {
          quietHoursEnabled: true,
          quietHoursStart: '22:30',
          quietHoursEnd: '07:15',
          contactDailyLimit: 4,
          revision: 'a'.repeat(64),
        },
      },
    ]);
  });
  expect(await screen.findByText('Quiet hours saved.')).toBeDefined();
  expect(await start()).toHaveProperty('value', '22:30');
  // The next save is based on what was just stored.
  await user.click(screen.getByLabelText('Hold messages during quiet hours'));
  expect(screen.getByText('Quiet hours are off: messages can go out at any time.')).toBeDefined();
  expect(await start()).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: 'Save quiet hours' }));
  await waitFor(() => {
    expect(saves()).toHaveLength(2);
  });
  expect(saves()[1]).toEqual({
    body: {
      quietHoursEnabled: false,
      quietHoursStart: '22:30',
      quietHoursEnd: '07:15',
      contactDailyLimit: 4,
      revision: 'b'.repeat(64),
    },
  });
});

it('sends nothing for the same start and end, or a limit outside 1 to 10,000', async () => {
  server.answer = () => settingsOf();
  const user = open();
  fireEvent.change(await start(), { target: { value: '08:00' } });
  await user.click(screen.getByRole('button', { name: 'Save quiet hours' }));
  expect(
    await screen.findByText("Quiet hours can't start and end at the same time."),
  ).toBeDefined();
  expect(saves()).toEqual([]);
  // With quiet hours off the same times are no longer a window, so they may be saved.
  fireEvent.change(await start(), { target: { value: '21:00' } });
  fireEvent.change(limit(), { target: { value: '0' } });
  fireEvent.submit(limit());
  await waitFor(() => {
    expect(screen.getByLabelText('Messages per contact in 24 hours')).toHaveProperty(
      'validity.valid',
      false,
    );
  });
  expect(saves()).toEqual([]);
});

it('shows the latest settings when someone else saved first, and asks for the change again', async () => {
  let settings = settingsOf();
  server.answer = (operation) => {
    if (operation === 'updateMessagingSettings') {
      settings = settingsOf({ contactDailyLimit: 25, revision: 'c'.repeat(64) });
      throw new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'These settings changed after you opened them. Reload the page and try again.',
      });
    }
    return settings;
  };
  const user = open();
  await start();
  await user.clear(limit());
  await user.type(limit(), '4');
  await user.click(screen.getByRole('button', { name: 'Save quiet hours' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Someone else changed these settings while you had them open.',
  );
  await waitFor(() => {
    expect(limit()).toHaveProperty('value', '25');
  });
  expect(screen.queryByText('Quiet hours saved.')).toBeNull();
});

it('says why when saving is refused or the connection fails, and keeps what was typed', async () => {
  const refusals: unknown[] = [
    new ApiError({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: "Your role doesn't allow this: it needs mailboxes.manage.",
    }),
    new TypeError('Failed to fetch'),
  ];
  server.answer = (operation) => {
    if (operation !== 'updateMessagingSettings') return settingsOf();
    throw refusals.shift();
  };
  const user = open();
  await start();
  await user.clear(limit());
  await user.type(limit(), '4');
  for (const message of [
    "Your role doesn't allow this: it needs mailboxes.manage.",
    "Quiet hours weren't saved. Check your connection and try again.",
  ]) {
    await user.click(screen.getByRole('button', { name: 'Save quiet hours' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(limit()).toHaveProperty('value', '4');
  }
});

it('offers a retry when the settings cannot be loaded', async () => {
  let fail = true;
  server.answer = () => {
    if (fail) throw new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503 });
    return settingsOf();
  };
  const user = open();
  expect((await screen.findByRole('alert')).textContent).toContain("We couldn't load quiet hours.");
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await start()).toHaveProperty('value', '21:00');
});
