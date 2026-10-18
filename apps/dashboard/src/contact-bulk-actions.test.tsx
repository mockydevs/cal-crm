// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bulkActionOf, bulkItemOf } from '../e2e/contact-bulk-fixtures';
import { ContactBulkActionsPage } from './contact-bulk-actions';

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
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ params, children }: { params: { contactId: string }; children: ReactNode }) => (
    <a href={`/contacts/${params.contactId}`}>{children}</a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <ContactBulkActionsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

const going = (): ReturnType<typeof bulkActionOf> =>
  bulkActionOf(2, {
    name: 'Give the north region to Eli',
    action: 'assign_owner',
    status: 'running',
    requested: 250,
    done: 90,
    unchanged: 7,
    skipped: 3,
    finishedAt: null,
    canCancel: true,
  });

describe('the Contacts bulk actions page', () => {
  it('lists the actions with who started each, its status and how far it has got', async () => {
    server.answer = () => ({
      items: [going(), bulkActionOf(1, { name: 'Tag trade fair leads' })],
      next: null,
    });
    show();
    const running = await screen.findByRole('row', { name: /Give the north region to Eli/ });
    expect(within(running).getByText('Assign owner')).toBeDefined();
    expect(within(running).getByText('Processing')).toBeDefined();
    expect(within(running).getByText('100 of 250')).toBeDefined();
    expect(within(running).getByText('Not yet')).toBeDefined();
    const ended = screen.getByRole('row', { name: /Tag trade fair leads/ });
    expect(within(ended).getByText('Complete')).toBeDefined();
    expect(within(ended).getByText('Dana Brooks (you)')).toBeDefined();
    // Only an action the server says can be stopped offers it.
    expect(within(ended).queryByRole('button', { name: /^Stop / })).toBeNull();
    expect(inputOf('listContactBulkActions')).toEqual({ query: {} });
  });

  it("names an email verification by GoHighLevel's name, and offers it as a filter", async () => {
    server.answer = () => ({
      items: [bulkActionOf(3, { name: 'Check the fair list', action: 'verify_emails' })],
      next: null,
    });
    const user = show();
    const row = await screen.findByRole('row', { name: /Check the fair list/ });
    expect(within(row).getByText('Email verification')).toBeDefined();
    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByRole('option', { name: 'Email verification' }));
    await waitFor(() => {
      expect(inputOf('listContactBulkActions')).toEqual({ query: { action: 'verify_emails' } });
    });
  });

  it('labels an unnamed action by when it was started', async () => {
    const unnamed = bulkActionOf(5);
    server.answer = () => ({ items: [unnamed], next: null });
    show();
    const started = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(unnamed.createdAt));
    expect(await screen.findByRole('rowheader', { name: started })).toBeDefined();
  });

  it('shows what became of each contact, and asks the server for one outcome', async () => {
    const action = bulkActionOf(1, { name: 'Tag trade fair leads' });
    server.answer = (operation, input) => {
      if (operation === 'listContactBulkActions') return { items: [action], next: null };
      const { query } = input as { query: { outcome?: string } };
      const all = [
        bulkItemOf(1, 'Mara Ellison', 'done'),
        bulkItemOf(2, null, 'skipped', {
          code: 'not_found',
          message: 'This contact no longer exists.',
        }),
      ];
      return {
        items: query.outcome === undefined ? all : all.filter((each) => each.outcome === 'skipped'),
        next: null,
      };
    };
    const user = show();
    await user.click(
      await screen.findByRole('button', { name: 'Show stats for Tag trade fair leads' }),
    );
    const stats = await screen.findByRole('dialog', { name: 'Bulk action stats' });
    expect(await within(stats).findByRole('link', { name: 'Mara Ellison' })).toBeDefined();
    // A contact that is gone is named in words, not linked.
    expect(within(stats).getByText('Contact not found')).toBeDefined();
    expect(within(stats).queryByRole('link', { name: 'Contact not found' })).toBeNull();
    expect(within(stats).getByText('This contact no longer exists.')).toBeDefined();
    expect(inputOf('listContactBulkActionItems')).toEqual({
      params: { id: action.id },
      query: {},
    });
  });

  it('stops an action and says what stopping does', async () => {
    const queue = { items: [going()] };
    server.answer = (operation) => {
      if (operation === 'cancelContactBulkAction') {
        const stopped = { ...going(), status: 'cancelled' as const, canCancel: false };
        queue.items = [stopped];
        return stopped;
      }
      return { items: queue.items, next: null };
    };
    const user = show();
    await user.click(
      await screen.findByRole('button', { name: 'Stop Give the north region to Eli' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Action stopped. What was already done stays done.')).toBeDefined();
    });
    expect(inputOf('cancelContactBulkAction')).toEqual({ params: { id: going().id } });
    const row = await screen.findByRole('row', { name: /Give the north region to Eli/ });
    await waitFor(() => {
      expect(within(row).getByText('Cancelled')).toBeDefined();
    });
  });

  it('says so when stopping is refused, and keeps the row as it was', async () => {
    server.answer = (operation) => {
      if (operation === 'cancelContactBulkAction')
        throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return { items: [going()], next: null };
    };
    const user = show();
    await user.click(
      await screen.findByRole('button', { name: 'Stop Give the north region to Eli' }),
    );
    expect(await screen.findByText("You don't have permission to stop this action.")).toBeDefined();
    expect(screen.getByText('Processing')).toBeDefined();
  });

  it('says what is needed when the server refuses the list', async () => {
    server.answer = () => {
      throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    };
    show();
    expect(
      await screen.findByText('Seeing the bulk actions needs permission to manage contacts.'),
    ).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
