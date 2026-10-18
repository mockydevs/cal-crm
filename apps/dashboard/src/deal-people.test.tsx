// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { DealDetails } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DealPeople from './deal-people';

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

const dealId = 'deal_01m4bd188ff82s0add91b7pz63';
const maya = {
  id: 'con_01m4bd188ff82s0add91b7pz61',
  name: 'Maya Thompson',
  email: 'maya@example.com',
  phone: { number: '+254712345678', display: '0712 345678' },
  trashed: false,
};
const omar = { ...maya, id: 'con_01m4bd188ff82s0add91b7pz62', name: 'Omar Said', email: null };
const dana = { membershipId: 'mem_01m4bd188ff82s0add91b7pz61', name: 'Dana Brooks', you: true };
const lee = { membershipId: 'mem_01m4bd188ff82s0add91b7pz62', name: 'Lee Park', you: false };
const details: DealDetails = {
  id: dealId,
  owner: lee,
  ownerRevision: 'a'.repeat(64),
  followers: [dana],
  primaryContact: maya,
  additionalContacts: [omar],
  contactsRevision: 'b'.repeat(64),
  createdBy: { kind: 'user', name: 'Lee Park', you: false },
  createdAt: '2026-10-08T12:00:00.000Z',
  canManage: true,
  canReadAudit: true,
};
const team = {
  items: [
    { id: dana.membershipId, name: dana.name, you: true },
    { id: lee.membershipId, name: lee.name, you: false },
  ],
  nextCursor: null,
};

/** A server holding these details; `on` answers the operations a test cares about. */
function serve(
  held: DealDetails,
  on: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'getDealDetails') return held;
    if (operation === 'listTaskAssignees') return team;
    return undefined;
  };
}

function show(readOnly = false): { user: ReturnType<typeof userEvent.setup>; pending: boolean[] } {
  const pending: boolean[] = [];
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <DealPeople
          businessId="biz_test"
          dealId={dealId}
          readOnly={readOnly}
          onPendingChange={(now) => {
            pending.push(now);
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), pending };
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

describe("an opportunity's contacts, owner and followers", () => {
  it('shows the primary contact with how to reach it, the others, the followers and who made it', async () => {
    serve(details);
    show();
    const contacts = await screen.findByRole('region', { name: 'Contact details' });
    expect(within(contacts).getByText('Maya Thompson')).toBeTruthy();
    expect(within(contacts).getByText('maya@example.com · 0712 345678')).toBeTruthy();
    expect(
      within(within(contacts).getByRole('list', { name: 'Additional contacts' })).getByText(
        'Omar Said',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Followers You' })).toBeTruthy();
    expect(screen.getByText('Created by Lee Park')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Audit logs' })).toBeTruthy();
    expect(inputOf('getDealDetails')).toEqual({ params: { id: dealId } });
  });

  it('only shows them to someone who may not change the opportunity, or for one in the trash', async () => {
    serve({ ...details, canManage: false, canReadAudit: false });
    show();
    expect(await screen.findByText('Lee Park')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Omar Said' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Audit logs' })).toBeNull();
    expect(server.calls.some((call) => call.operation === 'listTaskAssignees')).toBe(false);
    cleanup();
    serve(details);
    show(true);
    expect(await screen.findByText('Omar Said')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Omar Said' })).toBeNull();
  });

  it('removes an additional contact under the revision it read, and shows the answer', async () => {
    let answer: (() => void) | undefined;
    const saved = new Promise<DealDetails>((resolve) => {
      answer = () => {
        resolve({ ...details, additionalContacts: [], contactsRevision: 'c'.repeat(64) });
      };
    });
    serve(details, (operation) => (operation === 'setDealContacts' ? saved : undefined));
    const { user, pending } = show();
    await user.click(await screen.findByRole('button', { name: 'Remove Omar Said' }));
    // The opportunity's own form waits while the change is being saved.
    await waitFor(() => {
      expect(pending.at(-1)).toBe(true);
    });
    answer?.();
    await waitFor(() => {
      expect(screen.getByText('No additional contacts.')).toBeTruthy();
    });
    expect(inputOf('setDealContacts')).toEqual({
      params: { id: dealId },
      body: { primaryContactId: maya.id, additionalContactIds: [], revision: 'b'.repeat(64) },
    });
    await waitFor(() => {
      expect(pending.at(-1)).toBe(false);
    });
  });

  it('makes an additional contact the primary and keeps the one before among the others', async () => {
    serve(details, (operation) => (operation === 'setDealContacts' ? details : undefined));
    const { user } = show();
    await user.click(
      await screen.findByRole('button', { name: 'Make Omar Said the primary contact' }),
    );
    await waitFor(() => {
      expect(inputOf('setDealContacts')).toEqual({
        params: { id: dealId },
        body: {
          primaryContactId: omar.id,
          additionalContactIds: [maya.id],
          revision: 'b'.repeat(64),
        },
      });
    });
  });

  it('finds a contact on the server and adds the one chosen, never one already with it', async () => {
    const zuri = {
      id: 'con_01m4bd188ff82s0add91b7pz69',
      name: 'Zuri Kim',
      email: 'zuri@example.com',
    };
    serve(details, (operation) =>
      operation === 'listContacts'
        ? {
            items: [
              { ...zuri, phone: null, createdAt: details.createdAt },
              {
                id: omar.id,
                name: omar.name,
                email: null,
                phone: null,
                createdAt: details.createdAt,
              },
            ],
            next: null,
            canManage: true,
          }
        : operation === 'setDealContacts'
          ? details
          : undefined,
    );
    const { user } = show();
    await user.type(
      await screen.findByRole('searchbox', { name: 'Search for an additional contact' }),
      'zu',
    );
    const found = await screen.findByRole('list', { name: 'Matching contacts' });
    expect(within(found).queryByText('Omar Said')).toBeNull();
    expect(inputOf('listContacts')).toEqual({ query: { q: 'zu', limit: 8 } });
    await user.click(within(found).getByRole('button', { name: /Zuri Kim/ }));
    await waitFor(() => {
      expect(inputOf('setDealContacts')).toEqual({
        params: { id: dealId },
        body: {
          primaryContactId: maya.id,
          additionalContactIds: [omar.id, zuri.id],
          revision: 'b'.repeat(64),
        },
      });
    });
  });

  it('adds and removes a follower by membership', async () => {
    serve(details, (operation) =>
      operation === 'addDealFollowers' ? { ...details, followers: [dana, lee] } : undefined,
    );
    const { user } = show();
    await user.click(await screen.findByRole('button', { name: 'Followers You' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Lee Park' }));
    await waitFor(() => {
      expect(inputOf('addDealFollowers')).toEqual({
        params: { id: dealId },
        body: { followers: [lee.membershipId] },
      });
    });
    await user.click(await screen.findByRole('checkbox', { name: 'You' }));
    await waitFor(() => {
      expect(inputOf('removeDealFollowers')).toEqual({
        params: { id: dealId },
        body: { followers: [dana.membershipId] },
      });
    });
  });

  it('says a change someone else got in before was not made, and reads the latest again', async () => {
    serve(details, (operation) => {
      if (operation !== 'setDealContacts') return undefined;
      throw new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 });
    });
    const { user } = show();
    await user.click(await screen.findByRole('button', { name: 'Remove Omar Said' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Someone else changed this while you had it open',
    );
    await waitFor(() => {
      expect(server.calls.filter((call) => call.operation === 'getDealDetails')).toHaveLength(2);
    });
  });

  it('says so when the details did not load, and offers to try again', async () => {
    serve(details, (operation) => {
      if (operation !== 'getDealDetails') return undefined;
      throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    });
    const { user } = show();
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't be loaded");
    serve(details);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Maya Thompson')).toBeTruthy();
  });
});
