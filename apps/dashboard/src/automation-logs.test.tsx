// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationId,
  contactIds,
  harborSetup,
  runIds,
  stepRunList,
} from '../e2e/automation-fixtures';
import { momentsOf } from './automation-history-rules';
import ExecutionLogs from './automation-logs';
import type { AutomationsSearch } from './automation-navigation';

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
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...anchor
  }: {
    to: string;
    params: Record<string, string>;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      {...anchor}
      href={Object.entries(params).reduce(
        (address, [name, value]) => address.replace(`$${name}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const queries = (): unknown[] =>
  server.calls
    .filter((call) => call.operation === 'listAutomationStepRuns')
    .map((call) => (call.input as { query: unknown }).query);

const actions = [
  { id: 'send_guide', name: 'Send the email “Pricing guide”' },
  { id: 'wait_2_days', name: 'Wait 2 days' },
];

function open(): { user: ReturnType<typeof userEvent.setup>; went: AutomationsSearch[] } {
  const went: AutomationsSearch[] = [];
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <ExecutionLogs
          automationId={automationId}
          setup={harborSetup}
          actions={actions}
          navigation={{
            hrefFor: (to) => `?view=${to.view ?? ''}&run=${to.run ?? ''}`,
            go: (to) => {
              went.push(to);
            },
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup({ delay: null }), went };
}

const contacts = {
  items: [
    { id: contactIds.maya, name: 'Maya Thompson', email: 'maya@example.test', phone: null },
    { id: contactIds.priya, name: null, email: 'priya@example.test', phone: null },
    { id: contactIds.jordan, name: null, email: null, phone: null },
  ],
  next: null,
  canManage: true,
};

describe('the execution logs', () => {
  it('lists every action taken, newest first: who for, what, how it went and when', async () => {
    server.answer = () => stepRunList;
    const { user, went } = open();
    expect(screen.getByRole('status').textContent).toBe('Loading the logs…');
    const table = await screen.findByRole('table', { name: 'Execution logs' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Record', 'Action', 'Status', 'Executed on', 'Actions']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Maya Thompson',
      'Maya Thompson',
      'Priya Nair',
      'Maya Thompson',
      'Maya Thompson',
    ]);
    const cells = (index: number): (string | null)[] =>
      within(rows[index] ?? table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells(0).slice(0, 2)).toEqual([
      'Send textText them “Here’s our video sample reel.”',
      'Done',
    ]);
    expect(cells(1).slice(0, 2)).toEqual(['If / elseIf services includes “video”', 'Done']);
    // Why an action failed is said beside its status, in words.
    expect(cells(2).slice(0, 2)).toEqual([
      'Send emailSend the email “Pricing guide”',
      "FailedThe contact hasn't agreed to marketing messages on this channel.",
    ]);
    expect(cells(3)[0]).toBe('WaitWait 2 days');
    expect(cells(0)[2]).toMatch(/Oct 8, 2026/);
    expect(
      within(rows[0] ?? table)
        .getByRole('link', { name: 'Maya Thompson' })
        .getAttribute('href'),
    ).toBe(`/b/harbor/contacts/${contactIds.maya}`);
    const opener = within(rows[2] ?? table).getByRole('link', {
      name: /^Open the run of Priya Nair that took this action at /,
    });
    expect(opener.getAttribute('href')).toBe(`?view=runs&run=${runIds.priya}`);
    await user.click(opener);
    expect(went).toEqual([{ automation: automationId, view: 'runs', run: runIds.priya }]);
    expect(queries()).toEqual([{}]);
  });

  it('names an action by its own label, by its type when its settings say nothing, or by its key', async () => {
    const [first] = stepRunList.items;
    server.answer = () => ({
      items: [
        { ...first, id: 'astep_1', label: 'Send the reel' },
        {
          ...first,
          id: 'astep_2',
          input: {},
          error: { code: 7 },
          status: 'failed',
          explanation: 'It broke.',
        },
        { ...first, id: 'astep_3', type: 'brand.new', input: {}, status: 'skipped' },
        {
          ...first,
          id: 'astep_4',
          type: null,
          input: {},
          status: 'waiting',
          record: { id: 'x', name: '', trashed: false },
        },
      ],
      nextCursor: null,
    });
    open();
    const table = await screen.findByRole('table', { name: 'Execution logs' });
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (index: number): (string | null)[] =>
      within(rows[index] ?? table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells(0)[0]).toBe('Send textSend the reel');
    expect(cells(1).slice(0, 2)).toEqual(['Send textSend text', 'FailedIt broke.']);
    expect(cells(2).slice(0, 2)).toEqual(['brand.newbrand.new', 'Skipped']);
    expect(cells(3).slice(0, 2)).toEqual(['send_reelsend_reel', 'Waiting']);
    expect(within(rows[3] ?? table).getByRole('rowheader').textContent).toBe('Unnamed');
    expect(
      within(rows[3] ?? table).getByRole('link', {
        name: /^Open the run of Unnamed that took this action at /,
      }),
    ).toBeDefined();
  });

  it('narrows by action, by status and by days, asking the server each time', async () => {
    server.answer = (_operation, input) =>
      JSON.stringify(input).includes('"status":"failed"')
        ? { items: [], nextCursor: null }
        : stepRunList;
    const { user } = open();
    await screen.findByRole('table', { name: 'Execution logs' });
    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'All actions',
      'Send the email “Pricing guide”',
      'Wait 2 days',
    ]);
    await user.click(screen.getByRole('option', { name: 'Wait 2 days' }));
    await waitFor(() => {
      expect(queries().at(-1)).toEqual({ step: 'wait_2_days' });
    });
    const days = screen.getByRole('group', { name: 'Date range' });
    fireEvent.change(within(days).getByLabelText('From'), { target: { value: '2026-10-06' } });
    fireEvent.change(within(days).getByLabelText('To'), { target: { value: '2026-10-08' } });
    await waitFor(() => {
      expect(queries().at(-1)).toEqual({
        ...momentsOf('2026-10-06', '2026-10-08'),
        step: 'wait_2_days',
      });
    });
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'All statuses',
      'Done',
      'Waiting',
      'Running',
      'Failed',
      'Skipped',
    ]);
    await user.click(screen.getByRole('option', { name: 'Failed' }));
    expect(await screen.findByText('No action matches that.')).toBeDefined();
    expect(queries().at(-1)).toEqual({
      ...momentsOf('2026-10-06', '2026-10-08'),
      step: 'wait_2_days',
      status: 'failed',
    });
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'All statuses' }));
    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByRole('option', { name: 'All actions' }));
    await waitFor(() => {
      expect(queries().at(-1)).toEqual(momentsOf('2026-10-06', '2026-10-08'));
    });
  });

  it('narrows to one contact, found by name, and shows everyone again', async () => {
    let searching = 'ok';
    server.answer = (operation, input) => {
      if (operation !== 'listContacts') return stepRunList;
      if (searching === 'fails') throw new TypeError('Failed to fetch');
      return JSON.stringify(input).includes('nobody') ? { ...contacts, items: [] } : contacts;
    };
    const { user } = open();
    await screen.findByRole('table', { name: 'Execution logs' });
    const box = screen.getByRole('searchbox', { name: 'Search contacts' });
    await user.type(box, 'nobody');
    expect(await screen.findByText('No contacts match.')).toBeDefined();
    await user.clear(box);
    await waitFor(() => {
      expect(screen.queryByText('No contacts match.')).toBeNull();
    });
    await user.type(box, 'a');
    const found = await screen.findByRole('list', { name: 'Contacts found' });
    expect(
      within(found)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Maya Thompsonmaya@example.test', 'priya@example.test', 'Unnamed']);
    await user.click(within(found).getByRole('button', { name: /^Maya Thompson/ }));
    await waitFor(() => {
      expect(queries().at(-1)).toEqual({ record: contactIds.maya });
    });
    expect(screen.getByText('Contact: Maya Thompson')).toBeDefined();
    expect(screen.queryByRole('searchbox', { name: 'Search contacts' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show every contact again' }));
    await waitFor(() => {
      expect(queries().at(-1)).toEqual({});
    });

    searching = 'fails';
    await user.type(screen.getByRole('searchbox', { name: 'Search contacts' }), 'zed');
    expect((await screen.findByRole('alert')).textContent).toBe(
      "The contacts couldn't be searched.",
    );
  });

  it('loads more from where the page ended, and refreshes on request', async () => {
    const [first, second] = stepRunList.items;
    server.answer = (_operation, input) =>
      JSON.stringify(input).includes('"after"')
        ? { items: [second], nextCursor: null }
        : { items: [first], nextCursor: first['id'] };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(3);
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(queries().slice(0, 2)).toEqual([{}, { after: first['id'] }]);
    const before = queries().length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(queries().length).toBeGreaterThan(before);
    });
  });

  it('says so when no action has run yet', async () => {
    server.answer = () => ({ items: [], nextCursor: null });
    open();
    expect(await screen.findByText(/^No action has run yet\./)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says when the logs could not be loaded, never that there are none, and tries again', async () => {
    let failing = true;
    server.answer = () => {
      if (failing) throw new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503 });
      return stepRunList;
    };
    const { user } = open();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /We couldn't load the execution logs\./,
    );
    expect(screen.queryByText(/^No action/)).toBeNull();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Execution logs' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
