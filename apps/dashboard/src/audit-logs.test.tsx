// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { AuditListEntry } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogsPage } from './audit-logs';

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
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params: object;
    search?: object;
    children: ReactNode;
  }) => (
    <a href={`${to}#${Object.values(params).join('/')}${JSON.stringify(search ?? {})}`}>
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

const lee = 'mem_01m4bd188ff82s0add91b7pz64';

function entryOf(number: number, rest: Partial<AuditListEntry> = {}): AuditListEntry {
  return {
    id: `aud_${String(number)}`,
    at: '2026-10-08T09:30:00.000Z',
    command: 'contact.update',
    outcome: 'ok',
    errorCode: null,
    actor: { kind: 'user', name: 'Dana Brooks', you: true },
    proposed: false,
    events: [{ id: `evt_${String(number)}`, type: 'contact.updated' }],
    detail: {},
    module: 'contacts',
    action: 'updated',
    record: { kind: 'contact', id: 'con_maya', name: 'Maya Thompson', exists: true },
    recordCount: 1,
    ...rest,
  };
}

const changed = entryOf(1, { detail: { reason: 'Asked by phone.', timeZone: 'Africa/Nairobi' } });
const bulk = entryOf(2, {
  command: 'task.bulk_update',
  module: 'tasks',
  record: null,
  recordCount: 4,
  actor: { kind: 'user', name: 'Lee Park', you: false },
  events: [],
});
const gone = entryOf(3, {
  command: 'task.delete',
  module: 'tasks',
  action: 'deleted',
  record: { kind: 'task', id: 'task_9', name: null, exists: false },
  actor: { kind: 'automation', name: null, you: false },
  proposed: true,
});
const pipeline = entryOf(4, {
  command: 'pipeline.create',
  module: 'opportunities',
  action: 'created',
  record: { kind: 'pipeline', id: 'pipe_1', name: null, exists: null },
});

function serve(
  items: readonly AuditListEntry[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listAudit') return { items, next: null };
    if (operation === 'listTaskAssignees')
      return {
        items: [
          { id: 'mem_01m4bd188ff82s0add91b7pz63', name: 'Dana Brooks', you: true },
          { id: lee, name: 'Lee Park', you: false },
        ],
        nextCursor: null,
      };
    return undefined;
  };
}

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
        <AuditLogsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const asked = (): unknown => server.calls.findLast((call) => call.operation === 'listAudit')?.input;

async function rows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table');
  return within(table).getAllByRole('row').slice(1);
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('Settings → Audit Logs', () => {
  it('lists who changed what: the record, the module, the action, who and when', async () => {
    serve([changed, bulk, gone, pipeline]);
    show();
    const [first, second, third, fourth] = await rows();
    if (first === undefined || second === undefined || third === undefined || fourth === undefined)
      throw new Error('Four rows.');
    expect(asked()).toEqual({ query: {} });
    expect(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((each) => each.textContent),
    ).toEqual([
      'Name',
      'Module',
      'Action',
      'Done By',
      expect.stringMatching(/^Date & Time/),
      'Details',
    ]);
    // A contact that is still there is a link, with its id under its name.
    expect(
      within(first).getByRole('link', { name: 'Maya Thompson' }).getAttribute('href'),
    ).toContain('con_maya');
    expect(within(first).getByText('con_maya')).toBeTruthy();
    expect(within(first).getByText('Contacts')).toBeTruthy();
    expect(within(first).getByText('Updated')).toBeTruthy();
    expect(within(first).getByText('Contact changed')).toBeTruthy();
    expect(within(first).getByText('You')).toBeTruthy();
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-08T09:30:00.000Z');
    // A bulk action names how many records, not which.
    expect(within(second).getByText('4 records')).toBeTruthy();
    expect(within(second).getByText('Lee Park')).toBeTruthy();
    expect(within(second).queryByRole('link')).toBeNull();
    // A task that is gone is not a link.
    expect(within(third).getByText('(no longer exists)')).toBeTruthy();
    expect(within(third).queryByRole('link')).toBeNull();
    expect(within(third).getByText('Deleted')).toBeTruthy();
    expect(within(third).getByText('Automation')).toBeTruthy();
    // A kind the log does not look up shows as its kind and id.
    expect(within(fourth).getByText('pipeline')).toBeTruthy();
    expect(within(fourth).getByText('pipe_1')).toBeTruthy();
    expect(within(fourth).queryByRole('link')).toBeNull();
  });

  it('says plainly what a bulk action and a record ID search mean', async () => {
    serve([changed]);
    show();
    await rows();
    expect(screen.getByText(/A bulk action is listed as Updated whatever it did/)).toBeTruthy();
    expect(
      screen.getByText(/a contact's ID finds changes to the contact, not to its tasks/),
    ).toBeTruthy();
  });

  it('asks the server for what each filter names', async () => {
    serve([changed]);
    const user = show();
    await rows();
    await choose(user, 'User', 'Lee Park');
    await waitFor(() => {
      expect(asked()).toEqual({ query: { member: lee } });
    });
    await choose(user, 'User', 'Me');
    await choose(user, 'Module', 'Tasks');
    await choose(user, 'Action', 'Deleted');
    await waitFor(() => {
      expect(asked()).toEqual({ query: { member: 'me', module: 'tasks', action: 'deleted' } });
    });
    await choose(user, 'User', 'Anyone');
    await choose(user, 'Module', 'All modules');
    await choose(user, 'Action', 'All actions');
    await choose(user, 'Show', 'Refused: no permission');
    await waitFor(() => {
      expect(asked()).toEqual({ query: { outcome: 'denied' } });
    });
    await choose(user, 'Show', 'Changes made');
    await user.type(screen.getByRole('searchbox', { name: 'Search by record ID' }), 'con_maya');
    await waitFor(() => {
      expect(asked()).toEqual({ query: { subject: 'con_maya' } });
    });
  });

  it('offers every module and action the server knows', async () => {
    serve([changed]);
    const user = show();
    await rows();
    await user.click(screen.getByRole('combobox', { name: 'Module' }));
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'All modules',
      'Contacts',
      'Companies',
      'Opportunities',
      'Tasks',
      'Notes',
      'Tags',
      'Custom Fields',
      'Custom Values',
      'Conversations',
      'Calendars',
      'Automation',
      'Forms',
      'Import Data',
      'Users',
      'AI assistant',
      'Settings',
      'Trash',
    ]);
  });

  it('asks for a range of days, and not at all for one that runs backwards', async () => {
    serve([changed]);
    show();
    await rows();
    const range = screen.getByRole('group', { name: 'Date range' });
    fireEvent.change(within(range).getByLabelText('From day'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(range).getByLabelText('To day'), { target: { value: '2026-10-31' } });
    await waitFor(() => {
      expect(asked()).toEqual({
        query: {
          from: new Date(2026, 9, 1).toISOString(),
          before: new Date(2026, 10, 1).toISOString(),
        },
      });
    });
    const before = server.calls.length;
    fireEvent.change(within(range).getByLabelText('To day'), { target: { value: '2026-09-01' } });
    expect((await screen.findByRole('alert')).textContent).toBe('The range ends before it starts.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(server.calls).toHaveLength(before);
  });

  it('walks the pages with the cursor, and starts again when a filter changes', async () => {
    const older = entryOf(7, { command: 'contact.create', action: 'created' });
    serve([changed], (operation, input) => {
      if (operation !== 'listAudit') return undefined;
      const { query } = input as { query: { after?: string } };
      return query.after === 'aud_1'
        ? { items: [older], next: null }
        : { items: [changed], next: 'aud_1' };
    });
    const user = show();
    await rows();
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('status').textContent).toBe('Page 1');
    expect(within(pages).getByRole('button', { name: 'Previous page' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(pages).getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Contact created')).toBeTruthy();
    expect(asked()).toEqual({ query: { after: 'aud_1' } });
    expect(within(pages).getByRole('status').textContent).toBe('Page 2');
    expect(within(pages).getByRole('button', { name: 'Next page' })).toHaveProperty(
      'disabled',
      true,
    );
    await choose(user, 'Module', 'Contacts');
    await waitFor(() => {
      expect(asked()).toEqual({ query: { module: 'contacts' } });
    });
    expect(within(pages).getByRole('status').textContent).toBe('Page 1');
  });

  it('opens an entry to show what it holds', async () => {
    serve([changed, gone]);
    const user = show();
    const [first, ,] = await rows();
    if (first === undefined) throw new Error('A row.');
    await user.click(within(first).getByRole('button', { name: /^Details of Contact changed/ }));
    const panel = await screen.findByRole('dialog', { name: 'Audit log entry' });
    expect(within(panel).getByText('Contact changed')).toBeTruthy();
    expect(within(panel).getByText('Reason: Asked by phone.')).toBeTruthy();
    expect(within(panel).getByText('contact.update')).toBeTruthy();
    expect(within(panel).getByText('Changes made')).toBeTruthy();
    expect(within(panel).getByText('timeZone')).toBeTruthy();
    expect(within(panel).getByText('Africa/Nairobi')).toBeTruthy();
    expect(within(panel).getByText('aud_1')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Maya Thompson' })).toBeTruthy();
    expect(
      within(within(panel).getByRole('list', { name: 'What it reported' })).getByRole('listitem')
        .textContent,
    ).toBe('Contact updated');
    expect(
      within(panel).getByText(/Values before and after a change are not recorded/),
    ).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Audit log entry' })).toBeNull();
    });
  });

  it('shows a refusal with its code, and an assistant proposal as one', async () => {
    const refused = entryOf(5, {
      outcome: 'denied',
      errorCode: 'forbidden',
      record: null,
      recordCount: 0,
      events: [],
    });
    serve([refused, gone]);
    const user = show();
    const [first, second] = await rows();
    if (first === undefined || second === undefined) throw new Error('Two rows.');
    expect(within(first).getByText('No record')).toBeTruthy();
    await user.click(within(first).getByRole('button', { name: /^Details of/ }));
    const panel = await screen.findByRole('dialog', { name: 'Audit log entry' });
    expect(within(panel).getByText('Refused: no permission')).toBeTruthy();
    expect(within(panel).getByText('forbidden')).toBeTruthy();
    expect(within(panel).queryByRole('list', { name: 'What it reported' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    await user.click(within(second).getByRole('button', { name: /^Details of/ }));
    expect(
      within(await screen.findByRole('dialog', { name: 'Audit log entry' })).getByText(
        'Proposed by the assistant',
      ),
    ).toBeTruthy();
  });

  it('says so when nothing is recorded, and when nothing matches', async () => {
    serve([]);
    const user = show();
    expect(await screen.findByText('Nothing has been recorded yet.')).toBeTruthy();
    await choose(user, 'Action', 'Restored');
    expect(await screen.findByText('Nothing in the audit log matches.')).toBeTruthy();
  });

  it('tells someone without the permission that they need it, and draws no filters', async () => {
    serve([], (operation) => {
      if (operation !== 'listAudit') return undefined;
      throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    });
    show();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You need permission to read audit logs.',
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers to try again when the log cannot be read', async () => {
    let fail = true;
    serve([changed], (operation) => {
      if (operation !== 'listAudit' || !fail) return undefined;
      throw new ApiError({ type: 'about:blank', title: 'Bad Request', status: 400 });
    });
    const user = show();
    expect((await screen.findByRole('alert')).textContent).toContain(
      "The audit log couldn't be loaded.",
    );
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Contact changed')).toBeTruthy();
  });
});
