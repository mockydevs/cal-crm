// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { DealBulkAction } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealBulkActionsPage } from './deal-bulk-actions';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const entry = (number: number, changes: Partial<DealBulkAction> = {}): DealBulkAction => ({
  id: `bulk_01m4bd188ff82s0add91b7pz6${String(number)}`,
  action: 'trash',
  requested: 5,
  done: 3,
  unchanged: 1,
  skipped: 1,
  actor: { kind: 'user', name: 'Dana Brooks', you: false },
  createdAt: '2026-10-08T12:00:00.000Z',
  completedAt: '2026-10-08T12:00:01.000Z',
  ...changes,
});

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <DealBulkActionsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('Opportunities → Bulk Actions', () => {
  it('lists each bulk action with who ran it and what became of the opportunities', async () => {
    server.answer = () => ({
      items: [
        entry(1),
        entry(2, { action: 'assign_owner', actor: { kind: 'user', name: null, you: true } }),
      ],
      next: null,
    });
    show();
    const first = (await screen.findByRole('rowheader', { name: 'Delete opportunities' })).closest(
      'tr',
    );
    if (first === null) throw new Error('No row.');
    expect(within(first).getByText('Dana Brooks')).toBeTruthy();
    expect(within(first).getAllByRole('cell').at(-1)?.textContent).toBe(
      '5 selected · 3 changed · 1 unchanged · 1 skipped',
    );
    const second = screen.getByRole('rowheader', { name: 'Change owner' }).closest('tr');
    if (second === null) throw new Error('No row.');
    expect(within(second).getByText('You')).toBeTruthy();
    expect(server.calls[0]).toEqual({ operation: 'listDealBulkActions', input: { query: {} } });
    expect(screen.queryByRole('button', { name: 'Load more bulk actions' })).toBeNull();
  });

  it('reads the next page from where the last one ended', async () => {
    server.answer = (_operation, input) =>
      (input as { query: { after?: string } }).query.after === undefined
        ? { items: [entry(1)], next: entry(1).id }
        : { items: [entry(2, { action: 'move' })], next: null };
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Load more bulk actions' }));
    expect(
      await screen.findByRole('rowheader', { name: 'Change pipeline and stage' }),
    ).toBeTruthy();
    expect(server.calls.at(-1)?.input).toEqual({ query: { after: entry(1).id } });
  });

  it('says there are none, and says so when the list did not load', async () => {
    server.answer = () => ({ items: [], next: null });
    show();
    expect(await screen.findByText('No bulk actions found.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();
    server.answer = () => {
      throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    };
    show();
    expect((await screen.findByRole('alert')).textContent).toContain(
      "We couldn't load the bulk actions.",
    );
    expect(screen.queryByText('No bulk actions found.')).toBeNull();
  });
});
