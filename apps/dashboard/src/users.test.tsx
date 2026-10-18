// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { User, UserList } from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersPage } from './users';
import type { UsersPlace } from './users-links';
import { usersNoticeKey } from './users-rules';

vi.mock('./shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
vi.mock('./users-links', () => ({
  NewUserLink: ({ children }: { children: ReactNode }) => <a href="/new">{children}</a>,
  EditUserLink: ({
    userId,
    children,
    ...rest
  }: {
    userId: string;
    place: unknown;
    children: ReactNode;
  }) => {
    const { place: _place, ...link } = rest;
    return (
      <a href={`/edit/${userId}`} {...link}>
        {children}
      </a>
    );
  },
}));

// A busy machine (another lane's build, a two-core runner) answers late: wait longer for it.
configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const role = (key: string, name: string, permissions: string[], tail: string) => ({
  id: `role_01m4bd188ff82s0add91b7pz6${tail}`,
  name,
  key,
  isBuiltin: true,
  permissions,
});
const admin = role('admin', 'Admin', ['team.manage'], '3');
const member = role('member', 'Member', [], '4');

function person(tail: string, name: string, rest: Partial<User> = {}): User {
  const [firstName = '', lastName = ''] = name.split(' ');
  const id = `mem_01m4bd9fteedat3be9bqgx20${tail}`;
  return {
    id,
    membershipId: id,
    invitationId: null,
    status: 'active',
    firstName,
    lastName,
    name,
    email: `${firstName.toLowerCase()}@example.test`,
    phone: null,
    extension: null,
    avatarFileId: null,
    userType: 'account',
    roleId: member.id,
    roleKey: 'member',
    roleName: 'Member',
    isSelf: false,
    isOwner: false,
    canEdit: true,
    canRemove: true,
    ...rest,
  };
}
const ava = person('41', 'Ava Agency', {
  userType: 'agency',
  roleId: admin.id,
  roleKey: 'admin',
  roleName: 'Admin',
  canEdit: false,
  canRemove: false,
});
const dana = person('42', 'Dana Brooks', {
  roleId: admin.id,
  roleKey: 'admin',
  roleName: 'Admin',
  isSelf: true,
  canRemove: false,
  phone: '+13055550123',
  extension: '42',
});
const riley = person('43', 'Riley Brooks');
const invitedId = 'inv_01m4bd9fteedat3be9bqgx2044';
const sam = person('44', 'Sam Okoro', {
  id: invitedId,
  membershipId: null,
  invitationId: invitedId,
  status: 'invited',
  canEdit: false,
});

interface Call {
  readonly operation: string;
  readonly input: { readonly query?: Record<string, unknown>; readonly params?: unknown };
}
let calls: Call[] = [];
let people: User[] = [];
let canManage = true;
let refuse: ((call: Call) => Error | undefined) | undefined;

const client = {
  request: (endpoint: { operationId: string }, input: Call['input']) => {
    const call = { operation: endpoint.operationId, input };
    calls.push(call);
    return Promise.resolve().then((): unknown => {
      const refused = refuse?.(call);
      if (refused instanceof Error) throw refused;
      if (call.operation !== 'listUsers') {
        const { id } = (input.params ?? {}) as { id?: string };
        if (call.operation === 'resendInvitation')
          return { id, email: 'sam@example.test', roleId: member.id, roleName: 'Member' };
        people = people.filter((each) => each.id !== id);
        return undefined;
      }
      const query = input.query ?? {};
      const q = typeof query['q'] === 'string' ? query['q'].toLowerCase() : '';
      const found = people
        .filter((each) => query['role'] === undefined || each.roleId === query['role'])
        .filter((each) => query['type'] === undefined || each.userType === query['type'])
        .filter((each) => each.name.toLowerCase().includes(q));
      const limit = Number(query['limit'] ?? 20);
      const start =
        typeof query['after'] === 'string'
          ? found.findIndex((each) => each.id === query['after']) + 1
          : 0;
      const items = found.slice(start, start + limit);
      const list: UserList = {
        items,
        total: found.length,
        next: start + limit < found.length ? (items.at(-1)?.id ?? null) : null,
        roles: [admin, member],
        canManage,
      };
      return list;
    });
  },
} as unknown as Client;

const lists = () => calls.filter((call) => call.operation === 'listUsers');
const lastList = () => lists().at(-1)?.input.query;

function show(place: UsersPlace = { kind: 'business', slug: 'harbor' }, notice?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (notice !== undefined) queryClient.setQueryData(usersNoticeKey('ws'), notice);
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <UsersPage client={client} workspace="ws" place={place} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return userEvent.setup();
}
const rowOf = async (name: string) => {
  const cell = await screen.findByRole('rowheader', { name: new RegExp(name) });
  const row = cell.closest('tr');
  if (row === null) throw new Error('A row header is in a row.');
  return within(row);
};

beforeEach(() => {
  calls = [];
  people = [ava, dana, riley, sam];
  canManage = true;
  refuse = undefined;
});

describe('the Users list', () => {
  it('shows each kind of person with their type, phone and what may be done to them', async () => {
    show();
    const agency = await rowOf('Ava Agency');
    expect(agency.getByText('Agency - admin')).toBeDefined();
    expect(agency.getByText('-')).toBeDefined();
    const edit = agency.getByRole('button', { name: 'Edit Ava Agency' });
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    expect(edit.getAttribute('title')).toBe("Managed in the agency's Users");
    expect(
      agency
        .getByRole('button', { name: 'Remove Ava Agency from this account' })
        .getAttribute('aria-disabled'),
    ).toBe('true');

    const self = await rowOf('Dana Brooks');
    expect(self.getByText('(you)')).toBeDefined();
    expect(self.getByText('Account - admin')).toBeDefined();
    expect(self.getByText('+13055550123 ext. 42')).toBeDefined();
    expect(self.getByRole('link', { name: 'Edit Dana Brooks' }).getAttribute('href')).toBe(
      `/edit/${dana.id}`,
    );
    expect(
      self
        .getByRole('button', { name: 'Remove Dana Brooks from this account' })
        .getAttribute('title'),
    ).toBe("You can't remove yourself.");

    const account = await rowOf('Riley Brooks');
    expect(account.getByText('Account - member')).toBeDefined();
    expect(account.getByText(`id: ${riley.id}`)).toBeDefined();
    expect(
      account
        .getByRole('button', { name: 'Remove Riley Brooks from this account' })
        .getAttribute('aria-disabled'),
    ).toBeNull();
    expect(account.queryByRole('button', { name: /Resend/ })).toBeNull();

    const invited = await rowOf('Sam Okoro');
    expect(invited.getByText('Invited')).toBeDefined();
    expect(
      invited.getByRole('button', { name: 'Edit Sam Okoro' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      invited.getByRole('button', { name: 'Resend the invitation to Sam Okoro' }),
    ).toBeDefined();
    expect(screen.getByText('1 - 4 of 4')).toBeDefined();
    expect(lastList()).toEqual({ limit: 20 });
  });

  it('marks an invitation that has run out', async () => {
    people = [{ ...sam, status: 'invitation_expired' }];
    show();
    expect((await rowOf('Sam Okoro')).getByText('Invitation expired')).toBeDefined();
  });

  it('asks the server for what is searched and filtered, and clears the filter', async () => {
    const user = show();
    await rowOf('Riley Brooks');
    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'riley');
    await waitFor(() => {
      expect(lastList()).toEqual({ limit: 20, q: 'riley' });
    });
    await waitFor(() => {
      expect(screen.queryByText('Dana Brooks')).toBeNull();
    });
    await user.clear(screen.getByRole('searchbox', { name: 'Search users' }));
    await rowOf('Dana Brooks');

    await user.click(screen.getByRole('combobox', { name: 'User role' }));
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    await waitFor(() => {
      expect(lastList()).toEqual({ limit: 20, role: admin.id });
    });
    await waitFor(() => {
      expect(screen.queryByText('Riley Brooks')).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Clear the user role filter' }));
    await rowOf('Riley Brooks');
    expect(lastList()).toEqual({ limit: 20 });

    await user.click(screen.getByRole('combobox', { name: 'User role' }));
    await user.click(await screen.findByRole('option', { name: 'Agency users' }));
    await waitFor(() => {
      expect(lastList()).toEqual({ limit: 20, type: 'agency' });
    });
  });

  it('offers no kinds of user at the agency, where everyone is the agency’s', async () => {
    const user = show({ kind: 'agency' });
    await rowOf('Riley Brooks');
    await user.click(screen.getByRole('combobox', { name: 'User role' }));
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'All',
      'Admin',
      'Member',
    ]);
  });

  it('says so when nothing matches', async () => {
    const user = show();
    await rowOf('Riley Brooks');
    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'nobody');
    expect(await screen.findByText('No users match.')).toBeDefined();
  });

  it('walks the pages with the cursor the server gave', async () => {
    people = Array.from({ length: 12 }, (_, index) =>
      person(String(50 + index), `Person ${String(index + 1).padStart(2, '0')}`),
    );
    const user = show();
    await rowOf('Person 01');
    await user.click(screen.getByRole('combobox', { name: 'Rows per page' }));
    await user.click(await screen.findByRole('option', { name: '10' }));
    expect(await screen.findByText('1 - 10 of 12')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('11 - 12 of 12')).toBeDefined();
    expect(lastList()).toEqual({ limit: 10, after: people[9]?.id });
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('1 - 10 of 12')).toBeDefined();
  });

  it('copies an id and says so', async () => {
    const user = show();
    const row = await rowOf('Riley Brooks');
    await user.click(row.getByRole('button', { name: 'Copy the id of Riley Brooks' }));
    expect(await screen.findByText(`Copied ${riley.id}`)).toBeDefined();
    expect(await navigator.clipboard.readText()).toBe(riley.id);
  });

  it('asks before removing someone, and removes them from this account', async () => {
    const user = show();
    const row = await rowOf('Riley Brooks');
    await user.click(row.getByRole('button', { name: 'Remove Riley Brooks from this account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Riley Brooks?' });
    expect(calls.some((call) => call.operation === 'removeTeamMember')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(calls.some((call) => call.operation === 'removeTeamMember')).toBe(false);

    await user.click(row.getByRole('button', { name: 'Remove Riley Brooks from this account' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    expect(await screen.findByText('Riley Brooks was removed.')).toBeDefined();
    expect(calls.find((call) => call.operation === 'removeTeamMember')?.input).toEqual({
      params: { id: riley.id },
    });
    await waitFor(() => {
      expect(screen.queryByRole('rowheader', { name: /Riley Brooks/ })).toBeNull();
    });
  });

  it('says why a removal was refused, and keeps the question open', async () => {
    refuse = (call) =>
      call.operation === 'removeTeamMember'
        ? new ApiError({
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'The last admin stays.',
          })
        : undefined;
    const user = show();
    const row = await rowOf('Riley Brooks');
    await user.click(row.getByRole('button', { name: 'Remove Riley Brooks from this account' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The last admin stays.');
  });

  it('revokes an invitation after asking, and resends one at once', async () => {
    const user = show();
    const row = await rowOf('Sam Okoro');
    await user.click(row.getByRole('button', { name: 'Resend the invitation to Sam Okoro' }));
    expect(
      await screen.findByText('Invitation resent. The previous link no longer works.'),
    ).toBeDefined();
    expect(calls.find((call) => call.operation === 'resendInvitation')?.input).toEqual({
      params: { id: invitedId },
    });

    await user.click(row.getByRole('button', { name: 'Revoke the invitation of Sam Okoro' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke the invitation of Sam Okoro?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Invitation revoked.')).toBeDefined();
    expect(calls.find((call) => call.operation === 'revokeInvitation')?.input).toEqual({
      params: { id: invitedId },
    });
  });

  it('is read-only for someone who may not manage users', async () => {
    canManage = false;
    people = [
      { ...riley, canEdit: false, canRemove: false },
      { ...sam, canRemove: false },
    ];
    show();
    const row = await rowOf('Riley Brooks');
    expect(screen.queryByRole('link', { name: 'Add user' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Edit/ })).toBeNull();
    for (const button of [
      row.getByRole('button', { name: 'Edit Riley Brooks' }),
      row.getByRole('button', { name: 'Remove Riley Brooks from this account' }),
      (await rowOf('Sam Okoro')).getByRole('button', {
        name: 'Resend the invitation to Sam Okoro',
      }),
    ]) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('title')).toBe('You need permission to manage users.');
    }
    expect(screen.getByText(/needs permission to\s+manage users/)).toBeDefined();
  });

  it('says once what the Add or Edit page left for it', async () => {
    show(undefined, 'Sam Okoro was invited. They join when they accept the email.');
    await rowOf('Riley Brooks');
    expect(
      screen.getByText('Sam Okoro was invited. They join when they accept the email.'),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: 'Add user' })).toBeDefined();
  });

  it('says the server’s own words when the list is refused', async () => {
    refuse = () =>
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Not yours.' });
    show();
    expect((await screen.findByRole('alert')).textContent).toContain('Not yours.');
  });
});
