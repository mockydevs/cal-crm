// A stand-in for the API behind Settings → Users, which keeps people as the server does:
// the list (searched, filtered and paged there), one person, adding (an invitation) and
// changing, the team's own removal and invitation actions, the business's calendars, a
// person's availability, and a profile image's upload and link. Every request is parsed
// with the contract's own schema before it is answered, and every answer with the schema it
// is promised under, so a screen that sends or expects anything the contract does not have
// fails here.
import { expect, type Page, type Route } from '@playwright/test';
import {
  addUserInput,
  businessProfile,
  calendarConfiguration,
  calendarList,
  calendarUserAvailability,
  createFileLinkInput,
  fileLink,
  getCalendar,
  getCalendarUserAvailability,
  getUser,
  invitationIdInput,
  listCalendars,
  listUsersQuery,
  membershipIdInput,
  storedFile,
  teamInvitation,
  updateCalendarUserAvailabilityInput,
  updateUserInput,
  uploadFileQuery,
  userDetail,
  userList,
  calendar,
  type Calendar,
  type CalendarUserAvailability,
  type ListUsersQuery,
  type UserDetail,
  type UserList,
} from '@repo/contracts';
import { harbor } from './session';

const at = '2026-10-11T09:00:00.000Z';
const letters = '0123456789abcdefghjkmnpqrstvwxyz';
let made = 0;
/** An id as the server makes one: the prefix, then a UUIDv7 in base32. */
export function idOf(prefix: string): string {
  made += 1;
  const tail = `${letters[Math.floor(made / 32) % 32] ?? '0'}${letters[made % 32] ?? '0'}`;
  return `${prefix}_01h455vb4pex5vsknk084sn0${tail}`;
}

export type Role = UserList['roles'][number];

export function roleOf(key: string, name: string, permissions: string[]): Role {
  return { id: idOf('role'), name, key, isBuiltin: true, permissions };
}

/** A business's built-in roles, as the server lists them: by name. */
export function builtinRoles(): { admin: Role; member: Role; owner: Role; viewer: Role } {
  return {
    admin: roleOf('admin', 'Admin', ['team.manage', 'tags.manage', 'calendars.manage']),
    member: roleOf('member', 'Member', ['tags.manage']),
    owner: roleOf('owner', 'Owner', ['team.manage', 'tags.manage', 'calendars.manage']),
    viewer: roleOf('viewer', 'Viewer', []),
  };
}

/** Someone who has joined, with the role given; `rest` says what differs. */
export function memberOf(name: string, role: Role, rest: Partial<UserDetail> = {}): UserDetail {
  const [firstName = '', ...last] = name.split(' ');
  const id = idOf('mem');
  return {
    id,
    membershipId: id,
    invitationId: null,
    status: 'active',
    firstName,
    lastName: last.join(' '),
    name,
    email: `${firstName.toLowerCase()}@harborlights.example`,
    phone: null,
    extension: null,
    avatarFileId: null,
    userType: 'account',
    roleId: role.id,
    roleKey: role.key,
    roleName: role.name,
    isSelf: false,
    isOwner: role.key === 'owner',
    canEdit: true,
    canRemove: role.key !== 'owner',
    calendarId: null,
    signature: { enabled: false, document: null },
    ...rest,
  };
}

/** Someone invited who has not joined: no membership, never edited, removed by revoking. */
export function invitedOf(name: string, role: Role, rest: Partial<UserDetail> = {}): UserDetail {
  const id = idOf('inv');
  return memberOf(name, role, {
    id,
    membershipId: null,
    invitationId: id,
    status: 'invited',
    canEdit: false,
    canRemove: true,
    ...rest,
  });
}

export function calendarOf(name: string): Calendar {
  // Parsed, so a calendar here has every setting a real answer has, at its default.
  return calendar.parse({
    id: idOf('cal'),
    name,
    description: '',
    kind: 'personal',
    timezone: 'Africa/Nairobi',
    slotMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 60,
    maxDaysAhead: 60,
    bookingSlug: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'),
    confirmationSenderId: null,
    isActive: true,
    supported: true,
    bookable: true,
    createdAt: at,
    updatedAt: at,
  });
}

interface Refusal {
  readonly status: 403 | 404 | 409 | 422;
  readonly detail?: string;
  readonly errors?: readonly { path: string; code: string; message: string }[];
}

export interface UsersApi {
  people: UserDetail[];
  /** Each person's stored schedule, by membership id. None stored is a null profile. */
  readonly availability: Map<string, CalendarUserAvailability['profile']>;
  /** The query of every read of the list, in order, as the contract parsed it. */
  readonly listed: ListUsersQuery[];
  /** What each change was sent, in order: "METHOD /path" and the parsed body. */
  readonly sent: { readonly call: string; readonly body: unknown }[];
  /** Answers the next request whose "METHOD /path" matches with a refusal, once. */
  refuse: (call: RegExp, refusal: Refusal) => void;
}

const problem = (route: Route, refusal: Refusal): Promise<void> =>
  route.fulfill({
    status: refusal.status,
    contentType: 'application/problem+json',
    body: JSON.stringify({
      type: 'about:blank',
      title: 'Refused',
      status: refusal.status,
      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
      ...(refusal.errors === undefined ? {} : { errors: refusal.errors }),
    }),
  });

const cursorOf = (person: UserDetail): string =>
  Buffer.from(person.id, 'utf8').toString('base64url');
const digits = (text: string): string => text.replaceAll(/\D/g, '');
/** The revision the server gives a schedule: here, any 64 hexadecimal digits that follow it. */
function revisionOf(profile: CalendarUserAvailability['profile']): string {
  let sum = 7;
  for (const letter of JSON.stringify(profile))
    sum = (sum * 31 + (letter.codePointAt(0) ?? 0)) % 0xffffffff;
  return sum.toString(16).padStart(8, '0').repeat(8);
}

// The smallest PNG there is: one transparent pixel, for a profile image's preview.
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Answers Settings → Users as the server does. `workspace` is the business whose header
 * every request must carry, or null for the agency, whose requests carry none.
 * `canManage: false` is someone who may only read. `teams` says which members each calendar
 * has. `country` is the business profile's country.
 */
export async function fakeUsersApi(
  page: Page,
  {
    people,
    roles,
    canManage = true,
    workspace = harbor.id,
    calendars = [],
    teams = {},
    country = '',
  }: {
    readonly people: readonly UserDetail[];
    readonly roles: readonly Role[];
    readonly canManage?: boolean;
    readonly workspace?: string | null;
    readonly calendars?: readonly Calendar[];
    readonly teams?: Readonly<Record<string, readonly string[]>>;
    readonly country?: string;
  },
): Promise<UsersApi> {
  const refusals: { call: RegExp; refusal: Refusal }[] = [];
  const api: UsersApi = {
    people: [...people],
    availability: new Map(),
    listed: [],
    sent: [],
    refuse: (call, refusal) => {
      refusals.push({ call, refusal });
    },
  };
  const sorted = (): UserDetail[] =>
    api.people.toSorted(
      (one, other) =>
        one.name.toLowerCase().localeCompare(other.name.toLowerCase(), 'en') ||
        one.id.localeCompare(other.id),
    );
  const roleOfId = (id: string): Role | undefined => roles.find((each) => each.id === id);
  const unknownRole: Refusal = {
    status: 422,
    errors: [
      { path: '/roleId', code: 'unknown_role', message: 'Choose one of this workspace’s roles.' },
    ],
  };

  await page.route('**/fake-files/avatar.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: pixel }),
  );

  await page.route(
    /\/api\/v1\/(?:users|team\/members|team\/invitations|calendars|business-profile|files)(?:[/?].*)?$/,
    async (route) => {
      const request = route.request();
      if (workspace === null) expect(request.headers()['business-id']).toBeUndefined();
      else expect(request.headers()['business-id']).toBe(workspace);
      const url = new URL(request.url());
      const path = url.pathname.replace('/api/v1', '');
      const method = request.method();
      const call = `${method} ${path}`;
      const parts = path.split('/').filter((part) => part !== '');
      const json = (value: unknown, status = 200): Promise<void> =>
        route.fulfill({ status, json: value });
      const none = (): Promise<void> => route.fulfill({ status: 204 });
      const refused = refusals.find((each) => each.call.test(call));
      if (refused !== undefined) {
        refusals.splice(refusals.indexOf(refused), 1);
        return problem(route, refused.refusal);
      }
      const change = <Input>(parsed: Input): Input => {
        api.sent.push({ call, body: parsed });
        return parsed;
      };

      if (parts[0] === 'files') {
        if (call === 'POST /files') {
          uploadFileQuery.parse(Object.fromEntries(url.searchParams));
          const type = request.headers()['content-type'] ?? '';
          const size = request.postDataBuffer()?.length ?? 0;
          change({ filename: url.searchParams.get('filename'), type, size });
          return json(
            storedFile.parse({
              id: idOf('file'),
              filename: url.searchParams.get('filename'),
              contentType: type,
              size,
              sha256: 'a'.repeat(64),
              createdAt: at,
            }),
            201,
          );
        }
        if (method === 'POST' && parts[2] === 'links') {
          createFileLinkInput.parse(request.postDataJSON());
          return json(
            fileLink.parse({
              url: new URL('/fake-files/avatar.png', url).toString(),
              expiresAt: '2026-10-11T10:00:00.000Z',
            }),
            201,
          );
        }
        throw new Error(`The stand-in does not answer ${call}.`);
      }

      if (parts[0] === 'business-profile') {
        if (workspace === null) throw new Error('The agency has no business profile.');
        return json(
          businessProfile.parse({
            id: workspace,
            name: harbor.name,
            timezone: 'Africa/Nairobi',
            locale: 'en',
            currency: 'KES',
            address:
              country === ''
                ? null
                : { line1: '', line2: '', city: '', region: '', postalCode: '', country },
            logoFileId: null,
            canManage: false,
          }),
        );
      }

      if (parts[0] === 'calendars') {
        if (workspace === null) throw new Error('The agency has no calendars.');
        // The person's Time away: none coming up.
        if (parts[1] === 'users' && parts[3] === 'blocked-slots' && method === 'GET')
          return route.fulfill({ json: { items: [], truncated: false } });
        if (parts[1] === 'users' && parts[3] === 'availability') {
          const { membershipId } = getCalendarUserAvailability.params.parse({
            membershipId: parts[2],
          });
          const person = api.people.find((each) => each.membershipId === membershipId);
          if (person?.userType !== 'account') return problem(route, { status: 404 });
          const stored = api.availability.get(membershipId) ?? null;
          const view = (profile: CalendarUserAvailability['profile']) =>
            json(
              calendarUserAvailability.parse({
                membershipId,
                profile,
                revision: revisionOf(profile),
              }),
            );
          if (method === 'GET') return view(stored);
          if (method === 'PUT') {
            const input = change(updateCalendarUserAvailabilityInput.parse(request.postDataJSON()));
            if (input.revision !== revisionOf(stored))
              return problem(route, {
                status: 409,
                detail: 'This availability changed since you opened it. Reload it first.',
              });
            api.availability.set(membershipId, input.profile);
            return view(input.profile);
          }
          throw new Error(`The stand-in does not answer ${call}.`);
        }
        if (call === 'GET /calendars') {
          listCalendars.query.parse(Object.fromEntries(url.searchParams));
          return json(calendarList.parse({ items: calendars, nextCursor: null, canManage }));
        }
        if (method === 'GET' && parts.length === 2) {
          const { id } = getCalendar.params.parse({ id: parts[1] });
          const calendar = calendars.find((each) => each.id === id);
          if (calendar === undefined) return problem(route, { status: 404 });
          return json(
            calendarConfiguration.parse({
              calendar,
              members: (teams[id] ?? []).map((membershipId) => ({ membershipId, weight: 1 })),
              weeklyHours: [],
              dateOverrides: [],
              revision: 'c'.repeat(64),
              canManage,
            }),
          );
        }
        throw new Error(`The stand-in does not answer ${call}.`);
      }

      if (parts[0] === 'team') {
        if (!canManage) return problem(route, { status: 403 });
        if (parts[1] === 'members' && method === 'DELETE') {
          const { id } = membershipIdInput.parse({ id: parts[2] });
          change(undefined);
          api.people = api.people.filter((each) => each.membershipId !== id);
          return none();
        }
        const { id } = invitationIdInput.parse({ id: parts[2] });
        const invited = api.people.find((each) => each.invitationId === id);
        if (invited === undefined) return problem(route, { status: 404 });
        if (method === 'DELETE' && parts.length === 3) {
          change(undefined);
          api.people = api.people.filter((each) => each.invitationId !== id);
          return none();
        }
        if (method === 'POST' && parts[3] === 'resend') {
          change(undefined);
          api.people = api.people.map((each) =>
            each.invitationId === id ? { ...each, status: 'invited' } : each,
          );
          return json(
            teamInvitation.parse({
              id,
              email: invited.email,
              roleId: invited.roleId,
              roleName: invited.roleName,
              expiresAt: '2026-10-18T09:00:00.000Z',
              status: 'pending',
              deliveryFailed: false,
            }),
          );
        }
        throw new Error(`The stand-in does not answer ${call}.`);
      }

      // /users
      if (call === 'GET /users') {
        const query = listUsersQuery.parse(Object.fromEntries(url.searchParams));
        api.listed.push(query);
        const wanted = (query.q ?? '').toLowerCase();
        const number = digits(query.q ?? '');
        const found = sorted()
          .filter((each) => query.role === undefined || each.roleId === query.role)
          .filter((each) => query.type === undefined || each.userType === query.type)
          .filter(
            (each) =>
              wanted === '' ||
              each.name.toLowerCase().includes(wanted) ||
              each.email.toLowerCase().includes(wanted) ||
              each.id.toLowerCase().includes(wanted) ||
              (number.length >= 3 && each.phone !== null && digits(each.phone).includes(number)),
          );
        const after =
          query.after === undefined
            ? -1
            : found.findIndex((each) => cursorOf(each) === query.after);
        const items = found.slice(after + 1, after + 1 + query.limit);
        const last = items.at(-1);
        return json(
          userList.parse({
            items: items.map(
              ({ calendarId: _calendar, signature: _signature, ...person }) => person,
            ),
            total: found.length,
            next:
              last !== undefined && after + 1 + query.limit < found.length ? cursorOf(last) : null,
            roles,
            canManage,
          }),
        );
      }
      if (call === 'POST /users') {
        if (!canManage) return problem(route, { status: 403 });
        const input = change(addUserInput.parse(request.postDataJSON()));
        const role = roleOfId(input.roleId);
        if (role === undefined || role.key === 'owner') return problem(route, unknownRole);
        if (api.people.some((each) => each.email === input.email))
          return problem(route, {
            status: 422,
            errors: [
              {
                path: '/email',
                code: 'already_member',
                message: 'This person is already on the team or has a pending invitation.',
              },
            ],
          });
        const { email, roleId: _role, signature, ...details } = input;
        const invited = invitedOf(`${input.firstName} ${input.lastName}`, role, {
          ...details,
          email,
          signature,
          userType: workspace === null ? 'agency' : 'account',
        });
        api.people.push(invited);
        return json(userDetail.parse({ ...invited, deliveryFailed: false }), 201);
      }
      const { userId } = getUser.params.parse({ userId: parts[1] });
      const person = api.people.find((each) => each.membershipId === userId);
      if (person === undefined) return problem(route, { status: 404 });
      if (method === 'GET') return json(userDetail.parse(person));
      if (method === 'PUT') {
        const input = change(updateUserInput.parse(request.postDataJSON()));
        if (!canManage || !person.canEdit) return problem(route, { status: 403 });
        const role = roleOfId(input.roleId);
        if (role === undefined) return problem(route, unknownRole);
        if (role.id !== person.roleId && (person.isSelf || person.isOwner || role.key === 'owner'))
          return problem(route, {
            status: 403,
            detail: person.isSelf
              ? "You can't change your own role."
              : 'Ownership is assigned separately. Choose another role.',
          });
        const { roleId: _role, ...details } = input;
        const saved: UserDetail = {
          ...person,
          ...details,
          name: `${input.firstName} ${input.lastName}`,
          roleId: role.id,
          roleKey: role.key,
          roleName: role.name,
        };
        api.people = api.people.map((each) => (each.id === saved.id ? saved : each));
        return json(userDetail.parse(saved));
      }
      throw new Error(`The stand-in does not answer ${call}.`);
    },
  );
  return api;
}
