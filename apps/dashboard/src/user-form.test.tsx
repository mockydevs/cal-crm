// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { userList, type NoteDocument, type UserDetail } from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserFormPage } from './user-form';
import type { UsersPlace } from './users-links';
import { usersKey, usersNoticeKey, type SignatureDraft } from './users-rules';

const went = vi.hoisted(() => ({ toUsers: 0 }));
vi.mock('./shell/page', () => ({ usePageTitle: () => undefined }));
// The blocked slot form reads the team and the calendars of the business it is in.
vi.mock('./api', () => ({ api: client, apiIn: () => client }));
vi.mock('./users-links', () => ({
  UsersLink: ({ children, place: _place, ...rest }: { children: ReactNode; place: unknown }) => (
    <a href="/users" {...rest}>
      {children}
    </a>
  ),
  CalendarSettingsLink: ({ children }: { children: ReactNode }) => (
    <a href="/calendars">{children}</a>
  ),
  useGoToUsers: () => () => {
    went.toUsers += 1;
  },
}));
// The rich-text engine needs a real browser's layout; the browser tests drive it. Here it is
// a plain box that tells the form what a signature would.
vi.mock('./user-signature-editor', () => ({
  default: ({
    label,
    initial,
    onChange,
  }: {
    label: string;
    initial: NoteDocument | null;
    onChange: (signature: SignatureDraft) => void;
  }) => (
    <textarea
      aria-label={label}
      defaultValue={initial === null ? '' : 'saved signature'}
      onChange={(event) => {
        const text = event.target.value;
        onChange(
          text === ''
            ? { document: null, valid: true }
            : text === 'too long'
              ? { document: null, valid: false }
              : {
                  document: {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
                  },
                  valid: true,
                },
        );
      }}
    />
  ),
}));

// A busy machine (another lane's build, a two-core runner) answers late: wait longer for it.
configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

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
const owner = role('owner', 'Owner', ['team.manage', 'tags.manage'], '2');
const admin = role('admin', 'Admin', ['team.manage', 'tags.manage'], '3');
const member = role('member', 'Member', ['tags.manage'], '4');
const rileyId = 'mem_01m4bd9fteedat3be9bqgx2043';
const riley: UserDetail = {
  id: rileyId,
  membershipId: rileyId,
  invitationId: null,
  status: 'active',
  firstName: 'Riley',
  lastName: 'Brooks',
  name: 'Riley Brooks',
  email: 'riley@example.test',
  phone: '+254712345678',
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
  calendarId: null,
  signature: { enabled: false, document: null },
};
const at = '2026-10-11T09:00:00.000Z';
const calendar = (tail: string, name: string) => ({
  id: `cal_01m4bd9fteedat3be9bqgx20${tail}`,
  name,
  description: '',
  kind: 'personal' as const,
  timezone: 'UTC',
  slotMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 60,
  maxDaysAhead: 60,
  bookingSlug: name.toLowerCase().replaceAll(' ', '-'),
  confirmationSenderId: null,
  isActive: true,
  supported: true,
  bookable: true,
  createdAt: at,
  updatedAt: at,
});
const consults = calendar('61', 'Consultations');
const tours = calendar('62', 'Venue tours');
const fileId = 'file_01m4bd9fteedat3be9bqgx2071';
const revision = 'a'.repeat(64);

interface Call {
  readonly operation: string;
  readonly input: {
    readonly query?: Record<string, unknown>;
    readonly params?: Record<string, string>;
    readonly body?: unknown;
    readonly upload?: unknown;
  };
}
let calls: Call[] = [];
let person: UserDetail = riley;
let canManage = true;
let country: string | null = null;
let answer: ((call: Call) => unknown) | undefined;

const client = {
  request: (endpoint: { operationId: string }, input: Call['input']) => {
    const call = { operation: endpoint.operationId, input };
    calls.push(call);
    return Promise.resolve().then((): unknown => {
      const special = answer?.(call);
      if (special instanceof Error) throw special;
      if (special !== undefined) return special;
      switch (call.operation) {
        case 'listUsers':
          return { items: [], total: 0, next: null, roles: [owner, admin, member], canManage };
        case 'getUser':
          return person;
        case 'addUser':
          return { ...riley, name: 'Sam Okoro', status: 'invited' };
        case 'updateUser':
          return { ...person, name: 'Rae Brooks' };
        case 'listCalendars':
          return { items: [consults, tours], nextCursor: null, canManage: true };
        case 'getCalendar':
          return {
            calendar: input.params?.['id'] === consults.id ? consults : tours,
            members:
              input.params?.['id'] === consults.id ? [{ membershipId: rileyId, weight: 1 }] : [],
            weeklyHours: [],
            dateOverrides: [],
            revision,
            canManage: true,
          };
        case 'getBusinessProfile':
          return { address: country === null ? null : { country } };
        case 'uploadFile':
          return { id: fileId };
        case 'createFileLink':
          return { url: 'https://files.example/avatar.png', expiresAt: at };
        case 'listBlockedSlots':
          return { items: [], truncated: false };
        case 'listTeam':
          return { members: [], roles: [], invitations: [], canManage: false };
        case 'createBlockedSlot':
          return {
            id: 'blk_new',
            member: { membershipId: rileyId, you: false, name: 'Riley' },
            calendar: null,
            title: '',
            ...(input.body as object),
            revision,
          };
        case 'getCalendarUserAvailability':
          return { membershipId: rileyId, profile: null, revision };
        case 'updateCalendarUserAvailability':
          return {
            membershipId: rileyId,
            profile: (input.body as { profile: unknown }).profile,
            revision: 'b'.repeat(64),
          };
        default:
          throw new Error(`The fake client does not answer ${call.operation}.`);
      }
    });
  },
} as unknown as Client;

const sent = (operation: string) => calls.find((call) => call.operation === operation)?.input;
let cache: QueryClient;

function show(
  userId?: string,
  place: UsersPlace = { kind: 'business', slug: 'harbor' },
): ReturnType<typeof userEvent.setup> {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={cache}>
        <UserFormPage
          client={client}
          workspace="ws"
          place={place}
          {...(userId === undefined ? {} : { userId })}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return userEvent.setup();
}
/** The form, once its lazily fetched phone field is there. */
const ready = () => screen.findByRole('textbox', { name: 'Phone' });
const choose = async (user: ReturnType<typeof userEvent.setup>, name: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
};

beforeEach(() => {
  calls = [];
  person = riley;
  canManage = true;
  country = null;
  answer = undefined;
  went.toUsers = 0;
});

describe('Add user', () => {
  it('uses the member role when workspace roles arrive after the form opens', async () => {
    answer = (call) =>
      call.operation === 'listUsers'
        ? userList.parse({ items: [], total: 0, next: null, roles: [], canManage: true })
        : undefined;
    const user = show();
    await ready();
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Sam');
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'Okoro');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'sam@example.test');
    cache.setQueryData(
      [...usersKey('ws'), 'roles'],
      userList.parse({
        items: [],
        total: 0,
        next: null,
        roles: [owner, admin, member],
        canManage: true,
      }),
    );
    await user.click(screen.getByRole('tab', { name: 'Roles & permissions' }));
    expect(screen.getByRole('combobox', { name: 'User role' }).textContent).toContain('Member');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(went.toUsers).toBe(1);
    });
    expect(sent('addUser')?.body).toMatchObject({
      firstName: 'Sam',
      lastName: 'Okoro',
      email: 'sam@example.test',
      roleId: member.id,
    });
  });

  it('keeps a chosen role when the workspace roles refresh', async () => {
    const user = show();
    await ready();
    await user.click(screen.getByRole('tab', { name: 'Roles & permissions' }));
    await choose(user, 'User role', 'Admin');
    cache.setQueryData(
      [...usersKey('ws'), 'roles'],
      userList.parse({
        items: [],
        total: 0,
        next: null,
        roles: [owner, member, admin],
        canManage: true,
      }),
    );
    await user.click(screen.getByRole('combobox', { name: 'User role' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Member',
      'Admin',
    ]);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('combobox', { name: 'User role' }).textContent).toContain('Admin');
  });

  it('refuses to invite when ownership is the only available role and still allows cancellation', async () => {
    answer = (call) =>
      call.operation === 'listUsers'
        ? userList.parse({ items: [], total: 0, next: null, roles: [owner], canManage: true })
        : undefined;
    const user = show();
    await ready();
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Sam');
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'Okoro');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'sam@example.test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const select = screen.getByRole('combobox', { name: 'User role' });
    expect(select.hasAttribute('disabled')).toBe(true);
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(sent('addUser')).toBeUndefined();
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('/users');
  });

  it('has the five tabs of the screenshot, moved between with the arrow keys', async () => {
    const user = show();
    await ready();
    expect(screen.getByRole('heading', { level: 1, name: 'Add user' })).toBeDefined();
    const tabs = within(screen.getByRole('tablist', { name: 'Add user' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'User info',
      'Roles & permissions',
      'Call & voicemail',
      'User availability',
      'Calendar configuration',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    tabs[0]?.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true');
    expect(
      screen.getByText(
        "Calls and voicemail need the phone system, which isn't set up in this version.",
      ),
    ).toBeDefined();
    await user.keyboard('{End}');
    expect(tabs[4]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Calendar configuration' })).toBeDefined();
    await user.keyboard('{ArrowDown}');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('asks for the required details before the next tab, and sends nothing', async () => {
    const user = show();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Give the first name.')).toBeDefined();
    expect(screen.getByText('Give the last name.')).toBeDefined();
    expect(screen.getByText('Enter the email address.')).toBeDefined();
    expect(screen.getByRole('tab', { name: 'User info' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'First name' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(sent('addUser')).toBeUndefined();
    // What is wrong with a field goes as the field changes.
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Sam');
    expect(screen.queryByText('Give the first name.')).toBeNull();
  });

  it('has no password to type, and says the person is sent an invitation', async () => {
    show();
    await ready();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByText('Advanced settings')).toBeNull();
    expect(
      screen.getByText(/Saving sends this person an email invitation. They set their own password/),
    ).toBeDefined();
  });

  it('invites the person with everything the tabs hold', async () => {
    const user = show();
    await ready();
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Sam');
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'Okoro');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'Sam@Example.test');
    await choose(user, 'Phone country', 'Kenya (+254)');
    await user.type(screen.getByRole('textbox', { name: 'Phone' }), '0712 345 678');
    await user.type(screen.getByRole('textbox', { name: 'Extension' }), '42');
    await choose(user, 'Calendar', 'Venue tours');
    await user.click(screen.getByRole('switch', { name: 'Add signature to outgoing emails' }));
    await user.type(screen.getByRole('textbox', { name: 'Email signature' }), 'Sam, Harbor');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByRole('tab', { name: 'Roles & permissions' }).getAttribute('aria-selected'),
    ).toBe('true');
    // Everyday work unless someone chooses otherwise; ownership is never offered.
    await user.click(screen.getByRole('combobox', { name: 'User role' }));
    expect((await screen.findAllByRole('option')).map((each) => each.textContent)).toEqual([
      'Admin',
      'Member',
    ]);
    await user.click(screen.getByRole('option', { name: 'Admin' }));
    expect(
      within(screen.getByRole('region', { name: 'What this role can do' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(went.toUsers).toBe(1);
    });
    expect(sent('addUser')).toEqual({
      body: {
        email: 'sam@example.test',
        firstName: 'Sam',
        lastName: 'Okoro',
        phone: '+254712345678',
        extension: '42',
        avatarFileId: null,
        roleId: admin.id,
        calendarId: tours.id,
        signature: {
          enabled: true,
          document: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sam, Harbor' }] }],
          },
        },
      },
    });
    expect(cache.getQueryData(usersNoticeKey('ws'))).toBe(
      'Sam Okoro was invited. They join when they accept the email.',
    );
  });

  it('starts the phone in the business’s own country', async () => {
    country = 'KE';
    show();
    await ready();
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Phone country' }).textContent).toContain(
        'Kenya (+254)',
      );
    });
  });

  it('refuses a number the country does not have, on the tab that holds it', async () => {
    const user = show();
    await ready();
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Sam');
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'Okoro');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'sam@example.test');
    expect(screen.getByRole('combobox', { name: 'Phone country' }).textContent).toContain(
      'United States (+1)',
    );
    await user.type(screen.getByRole('textbox', { name: 'Phone' }), '12345');
    await user.click(screen.getByRole('tab', { name: 'Call & voicemail' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Enter a phone number of the country chosen, or leave it empty.'),
    ).toBeDefined();
    expect(screen.getByRole('tab', { name: 'User info' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(sent('addUser')).toBeUndefined();
  });

  it('puts what the server refuses under the field it names', async () => {
    answer = (call) =>
      call.operation === 'addUser'
        ? new ApiError({
            type: 'about:blank',
            title: 'Unprocessable',
            status: 422,
            errors: [
              { path: '/email', code: 'taken', message: 'This person is already on the team.' },
            ],
          })
        : undefined;
    const user = show();
    await ready();
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Sam');
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'Okoro');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'sam@example.test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This person is already on the team.')).toBeDefined();
    expect(went.toUsers).toBe(0);
  });

  it('says the server’s reason when adding is refused outright', async () => {
    answer = (call) =>
      call.operation === 'addUser'
        ? new ApiError({
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'Email delivery must be configured before adding people.',
          })
        : undefined;
    const user = show();
    await ready();
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Sam');
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'Okoro');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'sam@example.test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Email delivery must be configured before adding people.',
    );
  });

  it('refuses an image that is too big or of the wrong kind before sending it', async () => {
    const user = show();
    await ready();
    const input = screen.getByLabelText('Choose a profile image');
    await user.upload(
      input,
      new File([new Uint8Array(2_500_001)], 'big.png', { type: 'image/png' }),
    );
    expect(
      await screen.findByText('That image is bigger than 2.5 MB. Choose a smaller one.'),
    ).toBeDefined();
    expect(sent('uploadFile')).toBeUndefined();
    await user.upload(input, new File(['x'], 'me.png', { type: 'image/png' }));
    expect(await screen.findByRole('img', { name: 'Profile preview' })).toBeDefined();
    expect(sent('uploadFile')?.query).toEqual({ filename: 'me.png' });
    expect(sent('createFileLink')?.params).toEqual({ id: fileId });
    expect(screen.queryByText(/Choose a smaller one/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(screen.queryByRole('img', { name: 'Profile preview' })).toBeNull();
  });

  it('says availability and calendars wait for the person to join', async () => {
    const user = show();
    await ready();
    await user.click(screen.getByRole('tab', { name: 'User availability' }));
    expect(screen.getByText(/Availability can be set once this person has joined/)).toBeDefined();
    await user.click(screen.getByRole('tab', { name: 'Calendar configuration' }));
    expect(
      screen.getByText(/Once this person has joined, the calendars they are on/),
    ).toBeDefined();
    expect(sent('getCalendarUserAvailability')).toBeUndefined();
  });

  it('has no calendar to choose at the agency', async () => {
    show(undefined, { kind: 'agency' });
    await ready();
    expect(screen.queryByRole('combobox', { name: 'Calendar' })).toBeNull();
    expect(sent('listCalendars')).toBeUndefined();
    expect(sent('getBusinessProfile')).toBeUndefined();
  });
});

describe('Edit user', () => {
  it('opens on the person as saved, with an address that is not changed here', async () => {
    show(rileyId);
    await ready();
    expect(screen.getByRole('heading', { level: 1, name: 'Edit user' })).toBeDefined();
    expect(sent('getUser')).toEqual({ params: { userId: rileyId } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'First name' }).value).toBe(
      'Riley',
    );
    const email = screen.getByRole<HTMLInputElement>('textbox', { name: 'Email' });
    expect(email.value).toBe('riley@example.test');
    expect(email.readOnly).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Phone country' }).textContent).toContain(
      'Kenya (+254)',
    );
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Phone' }).value).toBe(
      '0712 345678',
    );
    expect(screen.queryByText(/Saving sends this person an email invitation/)).toBeNull();
  });

  it('saves the name, the role and the signature as a whole', async () => {
    const user = show(rileyId);
    await ready();
    const first = screen.getByRole('textbox', { name: 'First name' });
    await user.clear(first);
    await user.type(first, 'Rae');
    await user.click(screen.getByRole('switch', { name: 'Add signature to outgoing emails' }));
    await user.type(screen.getByRole('textbox', { name: 'Email signature' }), 'Rae');
    await user.click(screen.getByRole('tab', { name: 'Roles & permissions' }));
    await choose(user, 'User role', 'Admin');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(went.toUsers).toBe(1);
    });
    expect(sent('updateUser')).toEqual({
      params: { userId: rileyId },
      body: {
        firstName: 'Rae',
        lastName: 'Brooks',
        phone: '+254712345678',
        extension: null,
        avatarFileId: null,
        roleId: admin.id,
        calendarId: null,
        signature: {
          enabled: true,
          document: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rae' }] }],
          },
        },
      },
    });
    expect(cache.getQueryData(usersNoticeKey('ws'))).toBe('Rae Brooks was saved.');
  });

  it('refuses a signature the editor could not make a document of', async () => {
    const user = show(rileyId);
    await ready();
    await user.type(screen.getByRole('textbox', { name: 'Email signature' }), 'too long');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The signature is too long. Shorten it.')).toBeDefined();
    expect(sent('updateUser')).toBeUndefined();
  });

  it('keeps one’s own role and an owner’s as they are, and says why', async () => {
    person = { ...riley, isSelf: true };
    const user = show(rileyId);
    await ready();
    await user.click(screen.getByRole('tab', { name: 'Roles & permissions' }));
    expect(screen.getByRole('combobox', { name: 'User role' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText("You can't change your own role.")).toBeDefined();
    cleanup();

    person = { ...riley, isOwner: true, roleId: owner.id, roleKey: 'owner', roleName: 'Owner' };
    const again = show(rileyId);
    await ready();
    await again.click(screen.getByRole('tab', { name: 'Roles & permissions' }));
    const select = screen.getByRole('combobox', { name: 'User role' });
    expect(select.hasAttribute('disabled')).toBe(true);
    expect(select.textContent).toContain('Owner');
    expect(screen.getByText(/Ownership is assigned separately/)).toBeDefined();
  });

  it('is read-only for someone managed elsewhere: no Save, and it says where', async () => {
    person = { ...riley, userType: 'agency', canEdit: false };
    show(rileyId);
    await ready();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText(/Change them in the agency's Users/)).toBeDefined();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'First name' }).disabled).toBe(
      true,
    );
    expect(screen.queryByLabelText('Choose a profile image')).toBeNull();
  });

  it('is read-only for someone who may not manage users', async () => {
    canManage = false;
    show(rileyId);
    await ready();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText(/needs permission to manage users/)).toBeDefined();
  });

  it('says so when the person is no longer there', async () => {
    answer = (call) =>
      call.operation === 'getUser'
        ? new ApiError({ type: 'about:blank', title: 'Not found', status: 404 })
        : undefined;
    show(rileyId);
    expect(await screen.findByText("This person isn't in this workspace any more.")).toBeDefined();
  });

  it('lists the calendars the person is on', async () => {
    const user = show(rileyId);
    await ready();
    await user.click(screen.getByRole('tab', { name: 'Calendar configuration' }));
    const panel = within(screen.getByRole('tabpanel', { name: 'Calendar configuration' }));
    expect(await panel.findByText('Consultations')).toBeDefined();
    expect(panel.queryByText('Venue tours')).toBeNull();
    expect(panel.getByRole('link', { name: 'Settings, Calendars' })).toBeDefined();
  });

  it('gives the person hours of their own, saved in minutes on the revision read', async () => {
    const user = show(rileyId);
    await ready();
    await user.click(screen.getByRole('tab', { name: 'User availability' }));
    const inherit = await screen.findByRole('switch', { name: "Use each calendar's hours" });
    expect(inherit.getAttribute('aria-checked')).toBe('true');
    expect(sent('getCalendarUserAvailability')).toEqual({ params: { membershipId: rileyId } });
    await user.click(inherit);
    await user.click(screen.getByRole('button', { name: 'Add hours' }));
    const hours = within(screen.getByRole('group', { name: 'Hours 1' }));
    await user.click(hours.getByRole('checkbox', { name: 'Until midnight' }));
    const zone = screen.getByRole('combobox', { name: 'Time zone' });
    await user.clear(zone);
    await user.type(zone, 'Africa/Nairobi');
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(await screen.findByText('Availability saved.')).toBeDefined();
    expect(sent('updateCalendarUserAvailability')).toEqual({
      params: { membershipId: rileyId },
      body: {
        revision,
        profile: {
          timezone: 'Africa/Nairobi',
          inheritCalendarHours: false,
          weeklyHours: [{ weekday: 1, startMinute: 540, endMinute: 1440 }],
          dateOverrides: [],
        },
      },
    });
    // The person's own details were not sent by saving their hours.
    expect(sent('updateUser')).toBeUndefined();
  });

  it('lists dates with their own hours and time away, and offers the saved version when stale', async () => {
    answer = (call) =>
      call.operation === 'getCalendarUserAvailability'
        ? {
            membershipId: rileyId,
            revision,
            profile: {
              timezone: 'UTC',
              inheritCalendarHours: true,
              weeklyHours: [],
              dateOverrides: [
                { date: '2026-12-25', ranges: [] },
                { date: '2026-12-31', ranges: [{ startMinute: 540, endMinute: 780 }] },
              ],
            },
          }
        : call.operation === 'listBlockedSlots'
          ? {
              items: [
                {
                  id: 'blk_training',
                  member: { membershipId: rileyId, you: false, name: 'Riley' },
                  calendar: null,
                  title: 'Training',
                  startsAt: '2026-11-02T09:00:00.000000Z',
                  endsAt: '2026-11-03T09:00:00.000000Z',
                  revision,
                },
              ],
              truncated: false,
            }
          : call.operation === 'updateCalendarUserAvailability'
            ? new ApiError({
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                detail: 'This availability changed since you opened it. Reload it first.',
              })
            : undefined;
    const user = show(rileyId);
    await ready();
    await user.click(screen.getByRole('tab', { name: 'User availability' }));
    const overrides = within(
      await screen.findByRole('region', { name: 'Dates with their own hours' }),
    );
    expect(overrides.getByText(/Dec 25, 2026: Closed all day/)).toBeDefined();
    expect(overrides.getByText(/Dec 31, 2026: 09:00 - 13:00/)).toBeDefined();
    expect(
      await within(screen.getByRole('region', { name: 'Time away' })).findByText(/Training/),
    ).toBeDefined();
    expect(sent('listBlockedSlots')).toEqual({ params: { membershipId: rileyId } });
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(
      await screen.findByText('This availability changed since you opened it. Reload it first.'),
    ).toBeDefined();
    const before = calls.filter((call) => call.operation === 'getCalendarUserAvailability').length;
    await user.click(screen.getByRole('button', { name: 'Reload saved availability' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.operation === 'getCalendarUserAvailability').length).toBe(
        before + 1,
      );
    });
  });

  it('adds time away for the person: a blocked slot of theirs, on every calendar or on one', async () => {
    const user = show(rileyId);
    await ready();
    await user.click(screen.getByRole('tab', { name: 'User availability' }));
    const away = within(await screen.findByRole('region', { name: 'Time away' }));
    expect(await away.findByText('No time away is coming up.')).toBeDefined();
    await user.click(away.getByRole('button', { name: 'Add time away' }));
    const panel = within(await screen.findByRole('dialog', { name: 'Add time away' }));
    // Whose time it is is already chosen.
    expect(panel.queryByRole('combobox', { name: 'Team member' })).toBeNull();
    await user.type(await panel.findByLabelText('Title'), 'Conference');
    const starts = panel.getByLabelText(/^Starts \(/);
    await user.clear(starts);
    await user.type(starts, '2026-11-09T09:00');
    const ends = panel.getByLabelText(/^Ends \(/);
    await user.clear(ends);
    await user.type(ends, '2026-11-11T17:00');
    await user.click(panel.getByRole('button', { name: 'Block time' }));
    expect(await screen.findByText('Blocked slot added.')).toBeDefined();
    // Typed by this machine's clock here: no business zone was read in this test.
    expect(sent('createBlockedSlot')).toEqual({
      body: {
        title: 'Conference',
        membershipId: rileyId,
        calendarId: null,
        startsAt: new Date(2026, 10, 9, 9).toISOString(),
        endsAt: new Date(2026, 10, 11, 17).toISOString(),
      },
    });
  });

  it('says what availability needs when the person may not manage calendars', async () => {
    answer = (call) =>
      call.operation === 'getCalendarUserAvailability'
        ? new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 })
        : undefined;
    const user = show(rileyId);
    await ready();
    await user.click(screen.getByRole('tab', { name: 'User availability' }));
    expect(await screen.findByText(/needs permission to manage calendars/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save availability' })).toBeNull();
  });

  it('sets availability business by business, not at the agency', async () => {
    const user = show(rileyId, { kind: 'agency' });
    await ready();
    await user.click(screen.getByRole('tab', { name: 'User availability' }));
    expect(screen.getByText(/Availability is set business by business/)).toBeDefined();
    expect(sent('getCalendarUserAvailability')).toBeUndefined();
  });
});
