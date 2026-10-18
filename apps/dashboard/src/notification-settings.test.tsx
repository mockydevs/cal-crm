// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { notificationKinds, updateNotificationPreferencesInput } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NotificationSettingsPage } from './notification-settings';

interface Server {
  calls: { operation: string; input: unknown }[];
  remindMinutes: number | null;
}
const server = vi.hoisted((): Server => ({ calls: [], remindMinutes: null }));
const preferences = () => ({
  items: notificationKinds.map((kind) =>
    kind === 'task.reminder'
      ? { kind, inApp: true, remindMinutes: server.remindMinutes }
      : { kind, inApp: kind !== 'message.received_other' },
  ),
});
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      if (endpoint.operationId === 'updateNotificationPreferences') {
        const saved = updateNotificationPreferencesInput.parse((input as { body: unknown }).body);
        server.remindMinutes =
          saved.items.find((item) => item.kind === 'task.reminder')?.remindMinutes ?? null;
      }
      return Promise.resolve(preferences());
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  server.remindMinutes = null;
});
afterEach(cleanup);

const page = () =>
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <NotificationSettingsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );

it('shows each kind’s switch and the reminder time read back in its largest unit', async () => {
  server.remindMinutes = 120;
  page();
  expect(
    await screen.findByRole('checkbox', { name: 'A task gets assigned to me' }),
  ).toHaveProperty('checked', true);
  expect(
    screen.getByRole('checkbox', { name: 'A contact writes in any other conversation' }),
  ).toHaveProperty('checked', false);
  expect(screen.getByRole('checkbox', { name: 'An integration needs attention' })).toHaveProperty(
    'checked',
    true,
  );
  expect(screen.getByRole('textbox', { name: 'Remind me' })).toHaveProperty('value', '2');
  expect(screen.getByRole('combobox', { name: 'Unit' }).textContent).toContain('Hours');
});

it('saves a reminder before tasks are due, in minutes, with every switch as shown', async () => {
  const user = userEvent.setup();
  page();
  const amount = await screen.findByRole('textbox', { name: 'Remind me' });
  await user.type(amount, '1');
  await user.click(screen.getByRole('combobox', { name: 'Unit' }));
  await user.click(await screen.findByRole('option', { name: 'Days' }));
  await user.click(screen.getByRole('checkbox', { name: 'A task assigned to me is due' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(server.calls.some((call) => call.operation === 'updateNotificationPreferences')).toBe(
      true,
    );
  });
  const saved = server.calls.find((call) => call.operation === 'updateNotificationPreferences')
    ?.input as { body: { items: { kind: string; inApp: boolean; remindMinutes?: number }[] } };
  expect(saved.body.items.find((item) => item.kind === 'task.reminder')).toEqual({
    kind: 'task.reminder',
    inApp: true,
    remindMinutes: 1440,
  });
  expect(saved.body.items.find((item) => item.kind === 'task.due')?.inApp).toBe(false);
  expect(saved.body.items).toHaveLength(notificationKinds.length);
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveProperty(
      'textContent',
      'Your notification settings are saved.',
    );
  });
  expect(screen.getByRole('textbox', { name: 'Remind me' })).toHaveProperty('value', '1');
});

it('refuses a time it cannot send, without saving', async () => {
  const user = userEvent.setup();
  page();
  await user.type(await screen.findByRole('textbox', { name: 'Remind me' }), '45');
  await user.click(screen.getByRole('combobox', { name: 'Unit' }));
  await user.click(await screen.findByRole('option', { name: 'Days' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    await screen.findByText('Give a whole number of minutes, hours or days, up to 30 days.'),
  ).toBeTruthy();
  expect(server.calls.some((call) => call.operation === 'updateNotificationPreferences')).toBe(
    false,
  );
});

it('marks the reminder time it cannot send, and takes no time while reminders are off', async () => {
  const user = userEvent.setup();
  page();
  const amount = await screen.findByRole('textbox', { name: 'Remind me' });
  await user.type(amount, '0');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Give a whole number of minutes, hours or days, up to 30 days.');
  expect(amount.getAttribute('aria-invalid')).toBe('true');
  const describedBy = amount.getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(describedBy)?.textContent).toBe(
    'Give a whole number of minutes, hours or days, up to 30 days.',
  );
  await user.click(
    screen.getByRole('checkbox', { name: 'A reminder before an upcoming task assigned to me' }),
  );
  expect(amount).toHaveProperty('disabled', true);
});
