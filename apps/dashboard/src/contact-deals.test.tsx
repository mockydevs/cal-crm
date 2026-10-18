// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ContactDeals as ContactDealsAnswer, Deal } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactDeals } from './contact-deals';

// The dialog itself is the Opportunities page's (e2e/deals.spec.ts and
// e2e/contact-page.spec.ts drive it): here, what it is opened with and what follows it.
const added = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('./contact-deal-add', () => ({
  default: (props: {
    contact: { id: string; name: string };
    onSaved: (deal: { name: string }) => void;
    onClose: () => void;
  }) => {
    added.props.push({ ...props });
    return (
      <div role="dialog" aria-label="Add new opportunity">
        <p>{props.contact.name}</p>
        <button
          type="button"
          onClick={() => {
            props.onSaved({ name: 'Garden party' });
          }}
        >
          Create
        </button>
        <button type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    );
  },
}));

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
    children,
    search,
    className,
  }: {
    children: ReactNode;
    search: Record<string, string>;
    className?: string;
  }) => (
    <a href={`/b/harbor/deals?${new URLSearchParams(search).toString()}`} className={className}>
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  added.props.length = 0;
});
afterEach(cleanup);

const contactId = 'con_01m4bd188ff82s0add91b7pz61';
const at = '2026-10-08T12:00:00.000Z';
const wedding: Deal = {
  id: 'deal_01m4bd188ff82s0add91b7pz63',
  name: 'Maya’s wedding',
  pipelineId: 'pipe_01m4bd188ff82s0add91b7pz63',
  stageId: 'stage_01m4bd188ff82s0add91b7pz63',
  pipelineName: 'Weddings',
  stageName: 'New lead',
  amount: '11000.0000',
  currency: 'KES',
  expectedCloseDate: null,
  status: 'open',
  outcomeReason: null,
  closedAt: null,
  stageEnteredAt: at,
  createdAt: at,
  updatedAt: at,
  trashedAt: null,
  revision: 'a'.repeat(64),
  canManage: true,
};
const answerOf = (changes: Partial<ContactDealsAnswer> = {}): ContactDealsAnswer => ({
  items: [
    { deal: wedding, primary: true },
    {
      deal: {
        ...wedding,
        id: 'deal_01m4bd188ff82s0add91b7pz64',
        name: 'Gala',
        status: 'won',
        amount: null,
      },
      primary: false,
    },
  ],
  more: false,
  canManage: true,
  ...changes,
});

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <ContactDeals contactId={contactId} contactName="Maya Thompson" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe("a contact's opportunities", () => {
  it('lists each with its pipeline and stage, status and value, and whether the contact is its primary', async () => {
    server.answer = () => answerOf();
    show();
    const list = await screen.findByRole('list', { name: 'Opportunities of this contact' });
    const [first, second] = within(list).getAllByRole('listitem');
    if (first === undefined || second === undefined) throw new Error('Two opportunities expected.');
    expect(within(first).getByRole('link', { name: 'Maya’s wedding' }).getAttribute('href')).toBe(
      `/b/harbor/deals?deal=${wedding.id}&pipelineId=${wedding.pipelineId}&status=all`,
    );
    expect(within(first).getByText('Weddings: New lead')).toBeTruthy();
    expect(within(first).getByText('KES 11,000.0000')).toBeTruthy();
    expect(within(first).getByText('Open')).toBeTruthy();
    expect(within(first).getByText('Primary contact')).toBeTruthy();
    expect(within(second).getByText('Won')).toBeTruthy();
    expect(within(second).queryByText('Primary contact')).toBeNull();
    expect(within(second).queryByText('—')).toBeNull();
    expect(server.calls).toEqual([
      { operation: 'listContactDeals', input: { params: { id: contactId }, query: {} } },
    ]);
    expect(screen.queryByText(/more opportunities than are listed/)).toBeNull();
  });

  it('says when the contact has more than are listed, and when it has none', async () => {
    server.answer = () => answerOf({ more: true });
    show();
    expect(await screen.findByText(/more opportunities than are listed/)).toBeTruthy();
    cleanup();
    server.answer = () => answerOf({ items: [] });
    show();
    expect(await screen.findByText('This contact is with no opportunity yet.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('adds an opportunity with the contact as its primary contact, then lists it', async () => {
    server.answer = () => answerOf({ items: [] });
    const user = show();
    const add = await screen.findByRole('button', { name: 'Add opportunity' });
    // Nothing of the dialog is asked for until the button is pressed.
    expect(added.props).toHaveLength(0);
    await user.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add new opportunity' });
    expect(within(dialog).getByText('Maya Thompson')).toBeTruthy();
    expect(added.props[0]).toMatchObject({
      businessId: 'biz_test',
      contact: { id: contactId, name: 'Maya Thompson' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');

    server.calls.length = 0;
    server.answer = () => answerOf();
    await user.click(screen.getByRole('button', { name: 'Add opportunity' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await screen.findByRole('status')).textContent).toBe('Garden party saved.');
    // The list is read again, and now has the opportunities.
    expect(await screen.findByRole('list', { name: 'Opportunities of this contact' })).toBeTruthy();
    expect(server.calls.map((call) => call.operation)).toEqual(['listContactDeals']);
  });

  it('offers no way to add one to someone who may not add opportunities', async () => {
    server.answer = () => answerOf({ canManage: false });
    show();
    await screen.findByRole('list', { name: 'Opportunities of this contact' });
    expect(screen.queryByRole('button', { name: 'Add opportunity' })).toBeNull();
  });

  it('says so when they did not load, and reads them again when asked', async () => {
    server.answer = () => {
      throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    };
    const user = show();
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't be loaded");
    server.answer = () => answerOf();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Gala' })).toBeTruthy();
  });
});
