// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { InvoiceReminder } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderSettingsCard } from './invoice-reminders';

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

const reminder = (name: string, more: Partial<InvoiceReminder> = {}): InvoiceReminder => ({
  id: `rem_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
  name,
  enabled: true,
  enabledSince: '2026-10-12T09:00:00.000Z',
  everyAmount: 3,
  everyUnit: 'days',
  direction: 'after',
  anchor: 'due_date',
  maxSends: 3,
  subject: 'Reminder: Invoice {{invoice.number}} is due',
  body: 'Hello {{contact.name}},\n\nYour invoice is due.',
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-12T09:00:00.000Z',
  ...more,
});

function serve(
  reminders: InvoiceReminder[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listInvoiceReminders') return { items: reminders };
    return undefined;
  };
}

function show(canManage = true): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <ReminderSettingsCard canManage={canManage} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

describe('ReminderSettingsCard', () => {
  it('lists each reminder with its frequency in words', async () => {
    serve([
      reminder('Upcoming due date', {
        everyAmount: 3,
        everyUnit: 'days',
        direction: 'before',
        anchor: 'due_date',
      }),
      reminder('Overdue reminder', {
        everyAmount: 3,
        everyUnit: 'days',
        direction: 'after',
        anchor: 'due_date',
        maxSends: 3,
      }),
    ]);
    show();
    expect(await screen.findByText('Upcoming due date')).toBeDefined();
    expect(screen.getByText('3 days before the due date')).toBeDefined();
    expect(screen.getByText('Overdue reminder')).toBeDefined();
    expect(screen.getByText('Every 3 days after the due date, up to 3 times')).toBeDefined();
  });

  it('adds a reminder and sends what was typed', async () => {
    serve([]);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Add reminder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add reminder' });

    await user.type(within(dialog).getByLabelText('Name'), 'First reminder');
    await user.type(within(dialog).getByLabelText('Email subject'), 'Invoice {{{{invoice.number}}');
    const message = within(dialog).getByLabelText('Message');
    await user.type(message, 'Please see ');
    await user.click(within(dialog).getByRole('button', { name: 'Insert invoice.url' }));
    expect((message as HTMLTextAreaElement).value).toBe('Please see {{invoice.url}}');

    const amount = within(dialog).getByLabelText('Every');
    await user.clear(amount);
    await user.type(amount, '5');

    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));

    await waitFor(() => {
      expect(inputOf('createInvoiceReminder')).toEqual({
        body: {
          name: 'First reminder',
          enabled: true,
          everyAmount: 5,
          everyUnit: 'days',
          direction: 'after',
          anchor: 'due_date',
          maxSends: 3,
          subject: 'Invoice {{invoice.number}}',
          body: 'Please see {{invoice.url}}',
        },
      });
    });
  });

  it('offers only the due date for a reminder before it', async () => {
    serve([]);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Add reminder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add reminder' });

    const direction = within(dialog).getByRole('combobox', { name: 'Direction' });
    await user.click(direction);
    await user.click(await screen.findByRole('option', { name: 'before' }));

    const anchor = within(dialog).getByRole('combobox', { name: 'Anchor date' });
    await user.click(anchor);
    const sentDateOption = await screen.findByRole('option', { name: /sent date/i });
    expect(sentDateOption.getAttribute('aria-disabled')).toBe('true');
    expect(
      within(dialog).getByText('A reminder before its date can only be before the due date.'),
    ).toBeDefined();
  });

  it('hides the maximum for a reminder before the due date', async () => {
    serve([]);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Add reminder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add reminder' });

    expect(within(dialog).getByLabelText('Up to')).toBeDefined();

    const direction = within(dialog).getByRole('combobox', { name: 'Direction' });
    await user.click(direction);
    await user.click(await screen.findByRole('option', { name: 'before' }));

    expect(within(dialog).queryByLabelText('Up to')).toBeNull();
  });

  it('turns a reminder off and on', async () => {
    serve([reminder('Overdue notice', { enabled: true })], (operation) => {
      if (operation === 'updateInvoiceReminder') {
        return reminder('Overdue notice', { enabled: false });
      }
      return undefined;
    });
    const user = show();
    const toggle = await screen.findByRole('switch', { name: /Overdue notice/i });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);

    await waitFor(() => {
      expect(inputOf('updateInvoiceReminder')).toEqual({
        params: { id: 'rem_overdue_notice' },
        body: { enabled: false, updatedAt: '2026-10-12T09:00:00.000Z' },
      });
    });
  });

  it('asks before deleting a reminder', async () => {
    serve([reminder('Old reminder')]);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Delete Old reminder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete reminder?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }));

    await waitFor(() => {
      expect(inputOf('deleteInvoiceReminder')).toEqual({
        params: { id: 'rem_old_reminder' },
      });
    });
  });

  it('shows a refusal beside its field', async () => {
    serve([], (operation) => {
      if (operation === 'createInvoiceReminder') {
        throw new ApiError({
          type: 'about:blank',
          title: 'Unprocessable',
          status: 422,
          errors: [{ path: '/name', code: 'invalid', message: 'Give the reminder a name.' }],
        });
      }
      return undefined;
    });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Add reminder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add reminder' });
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));

    expect(await within(dialog).findByText('Give the reminder a name.')).toBeDefined();

    // 21st reminder refusal: server 409 error
    serve([], (operation) => {
      if (operation === 'createInvoiceReminder') {
        throw new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A business may have at most 20 invoice reminders.',
        });
      }
      return undefined;
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    expect(
      await within(dialog).findByText('A business may have at most 20 invoice reminders.'),
    ).toBeDefined();
  });

  it('offers to reload after a stale save', async () => {
    serve([reminder('Overdue notice')], (operation) => {
      if (operation === 'updateInvoiceReminder') {
        throw new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'The invoice reminder changed since it was read.',
        });
      }
      return undefined;
    });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Edit Overdue notice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit reminder' });
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));

    expect(
      await within(dialog).findByText(
        'Someone changed these settings since you opened them. Reload the saved version, then make your changes again.',
      ),
    ).toBeDefined();

    await user.click(within(dialog).getByRole('button', { name: 'Reload saved version' }));
    expect(server.calls.filter((c) => c.operation === 'listInvoiceReminders').length).toBe(2);
  });

  it("shows the list read-only to someone who can't manage the settings", async () => {
    serve([reminder('Overdue notice')]);
    show(false);
    expect(await screen.findByText('Overdue notice')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add reminder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Overdue notice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Overdue notice' })).toBeNull();
    const toggle = screen.getByRole('switch', { name: /Overdue notice/i });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when there are no reminders', async () => {
    serve([]);
    show();
    expect(await screen.findByText('No reminders yet.')).toBeDefined();
  });
});
