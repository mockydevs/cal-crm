// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ManualAction } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionOf, people, workflows } from '../e2e/conversation-extras-fixtures';
import { ManualActionsPage } from './manual-actions';

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
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
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

const conflict = (): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 });

interface Queue {
  actions: ManualAction[];
  canWork: boolean;
  canAssign: boolean;
}

/** A server holding this queue: closing an action takes it out of the pending list. */
function serve(
  queue: Queue,
  on: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listManualActions') {
      const items = queue.actions.filter((each) => each.status === 'pending');
      return {
        items,
        total: items.length,
        next: null,
        canWork: queue.canWork,
        canAssign: queue.canAssign,
      };
    }
    if (operation === 'listAutomations')
      return { canManage: false, items: Object.values(workflows), nextCursor: null };
    if (operation === 'listConversationAssignees')
      return { items: Object.values(people), nextCursor: null };
    const { params } = input as { params: { actionId: string } };
    const at = queue.actions.findIndex((each) => each.id === params.actionId);
    const old = queue.actions[at];
    if (old === undefined) throw new Error('No such action.');
    if (operation === 'completeManualAction' || operation === 'skipManualAction') {
      const closed: ManualAction = {
        ...old,
        status: operation === 'completeManualAction' ? 'completed' : 'skipped',
      };
      queue.actions[at] = closed;
      return closed;
    }
    if (operation === 'assignManualAction') {
      const { body } = input as { body: { assignee: string | null } };
      const saved: ManualAction = {
        ...old,
        assignee:
          body.assignee === null
            ? null
            : { membershipId: people.dana.id, name: people.dana.name, you: true },
        revision: 'e'.repeat(64),
      };
      queue.actions[at] = saved;
      return saved;
    }
    return old;
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
        <ManualActionsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

const queueOf = (over: Partial<Queue> = {}): Queue => ({
  actions: [
    actionOf(1, 'call', 'Ada Park', { body: 'Ask about the venue.' }),
    actionOf(2, 'sms', 'Ben Cole'),
  ],
  canWork: true,
  canAssign: true,
  ...over,
});

describe('the Manual Actions page', () => {
  it('lists the pending queue, oldest first, as the server filters it', async () => {
    serve(queueOf());
    show();
    const row = (await screen.findByRole('link', { name: 'Ada Park' })).closest('tr');
    if (row === null) throw new Error('No row.');
    expect(within(row).getByText('New lead follow-up')).toBeTruthy();
    expect(within(row).getByText('Unassigned')).toBeTruthy();
    expect(within(row).getByText('Call')).toBeTruthy();
    expect(within(row).getByText('Pending')).toBeTruthy();
    expect(inputOf('listManualActions')).toEqual({
      query: { status: 'pending', assignee: 'anyone', limit: 20 },
    });
  });

  it('shows one action, and completes it from the revision it was read at', async () => {
    const queue = queueOf();
    serve(queue);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open the action for Ada Park' }));
    const panel = await screen.findByRole('dialog', { name: 'Call to place' });
    expect(within(panel).getByText('Ask about the venue.')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: '+14155550001' })).toHaveProperty(
      'href',
      'tel:+14155550001',
    );
    expect(within(panel).getByText(/Completing does not place the call/)).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Complete' }));
    await waitFor(() => {
      expect(inputOf('completeManualAction')).toEqual({
        params: { actionId: queue.actions[0]?.id },
        body: { revision: actionOf(1, 'call', 'Ada Park').revision },
      });
    });
    expect(await screen.findByText('Action completed.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Ada Park' })).toBeNull();
    });
  });

  it('walks the queue from "Let\'s start": closing one action opens the next', async () => {
    const queue = queueOf();
    serve(queue);
    const user = show();
    await screen.findByRole('link', { name: 'Ada Park' });
    await user.click(screen.getByRole('button', { name: "Let's start" }));
    const first = await screen.findByRole('dialog', { name: 'Call to place' });
    await user.click(within(first).getByRole('button', { name: 'Skip' }));
    const second = await screen.findByRole('dialog', { name: 'Text to send' });
    expect(inputOf('skipManualAction')).toMatchObject({
      params: { actionId: queue.actions[0]?.id },
    });
    expect(within(second).getByText('Hi Ben Cole, are you still looking?')).toBeTruthy();
    expect(within(second).getByText(/Completing does not send the text/)).toBeTruthy();
    expect(within(second).getByRole('button', { name: 'Copy message' })).toBeTruthy();
    await user.click(within(second).getByRole('button', { name: 'Complete' }));
    expect(await screen.findByText('Good work!')).toBeTruthy();
    expect(screen.getByText('You have no pending tasks.')).toBeTruthy();
    expect(screen.getByRole('button', { name: "Let's start" })).toHaveProperty('disabled', true);
  });

  it('lets someone who only replies take an action and put it back', async () => {
    const queue = queueOf({ canAssign: false });
    serve(queue);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open the action for Ada Park' }));
    const panel = await screen.findByRole('dialog', { name: 'Call to place' });
    // Giving it to someone else is not theirs to do.
    expect(within(panel).queryByRole('combobox', { name: 'Assigned to' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Assign to me' }));
    await waitFor(() => {
      expect(inputOf('assignManualAction')).toEqual({
        params: { actionId: queue.actions[0]?.id },
        body: { assignee: 'me', revision: actionOf(1, 'call', 'Ada Park').revision },
      });
    });
    expect(await within(panel).findByText('Dana Brooks (you)')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Put it back' }));
    await waitFor(() => {
      expect(inputOf('assignManualAction')).toEqual({
        params: { actionId: queue.actions[0]?.id },
        body: { assignee: null, revision: 'e'.repeat(64) },
      });
    });
  });

  it('shows the action as someone else left it when it changed first', async () => {
    const queue = queueOf();
    const theirs: ManualAction = {
      ...actionOf(1, 'call', 'Ada Park', { body: 'Ask about the venue.' }),
      assignee: { membershipId: people.eli.id, name: people.eli.name, you: false },
      revision: 'd'.repeat(64),
    };
    serve(queue, (operation) => {
      if (operation === 'completeManualAction') throw conflict();
      if (operation === 'getManualAction') return theirs;
      return undefined;
    });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open the action for Ada Park' }));
    const panel = await screen.findByRole('dialog', { name: 'Call to place' });
    await user.click(within(panel).getByRole('button', { name: 'Complete' }));
    expect(
      await within(panel).findByText('Someone else changed this action. This is how it is now.'),
    ).toBeTruthy();
    expect(inputOf('getManualAction')).toEqual({ params: { actionId: theirs.id } });
    // Still open, and still to do.
    expect(within(panel).getByRole('button', { name: 'Complete' })).toBeTruthy();
  });

  it('only shows the queue to someone who may not work it', async () => {
    serve(queueOf({ canWork: false, canAssign: false }));
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open the action for Ada Park' }));
    const panel = await screen.findByRole('dialog', { name: 'Call to place' });
    expect(within(panel).queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Assign to me' })).toBeNull();
    expect(screen.queryByRole('button', { name: "Let's start" })).toBeNull();
  });

  it('says what is needed when the server refuses the queue', async () => {
    serve(queueOf(), (operation) => {
      if (operation === 'listManualActions')
        throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return undefined;
    });
    show();
    expect(
      await screen.findByText(
        'Working the manual actions queue needs permission to manage or to reply to conversations.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(server.calls.some((call) => call.operation === 'listAutomations')).toBe(false);
  });
});
