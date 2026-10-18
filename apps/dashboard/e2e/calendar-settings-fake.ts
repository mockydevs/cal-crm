// A stand-in for the API behind Settings → Calendars, for the unit tests of its screens. It
// keeps calendars and groups as the server does, parses every body with the contract's own
// schema, and records each call in order.
import {
  calendar,
  calendarGroupInput,
  createCalendarInput,
  listCalendarsQuery,
  updateCalendarAvailabilityInput,
  updateCalendarInput,
  type Calendar,
  type CalendarConfiguration,
  type CalendarGroup,
  type CalendarUserAvailability,
  type GoogleConnections,
  type User,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';

export const danaId = 'mem_01h455vb4pex5vsknk084sn02q';
export const leeId = 'mem_01h455vb4pex5vsknk084sn02r';
export const avaId = 'mem_01h455vb4pex5vsknk084sn02s';
export const senderId = 'mbx_01h455vb4pex5vsknk084sn02q';
export const formId = 'form_01h455vb4pex5vsknk084sn02q';
const at = '2026-10-09T09:00:00.000Z';

export function person(id: string, name: string, rest: Partial<User> = {}): User {
  const [firstName = '', lastName = ''] = name.split(' ');
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
    roleId: 'role_01h455vb4pex5vsknk084sn02q',
    roleKey: 'member',
    roleName: 'Member',
    isSelf: false,
    isOwner: false,
    canEdit: true,
    canRemove: true,
    ...rest,
  };
}

/** Dana and Lee of the account, Ava of the agency, and Sam who has not joined yet. */
export const everyone: readonly User[] = [
  person(avaId, 'Ava Agency', { userType: 'agency' }),
  person(danaId, 'Dana Brooks'),
  person(leeId, 'Lee Park'),
  person('inv_01h455vb4pex5vsknk084sn02t', 'Sam Okoro', {
    membershipId: null,
    invitationId: 'inv_01h455vb4pex5vsknk084sn02t',
    status: 'invited',
  }),
];

export function calendarOf(tail: string, name: string, rest: Partial<Calendar> = {}): Calendar {
  return calendar.parse({
    id: `cal_01h455vb4pex5vsknk084sn0${tail}`,
    name,
    kind: 'personal',
    timezone: 'Africa/Nairobi',
    bookingSlug: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'),
    isActive: true,
    supported: true,
    bookable: true,
    createdAt: at,
    updatedAt: at,
    ...rest,
  });
}

export function problem(status: number, body: Record<string, unknown> = {}): ApiError {
  return new ApiError({ type: 'about:blank', title: 'Refused', status, ...body });
}

export interface Call {
  readonly operation: string;
  readonly params?: Record<string, string>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

interface Stored {
  calendar: Calendar;
  members: CalendarConfiguration['members'];
  weeklyHours: CalendarConfiguration['weeklyHours'];
  dateOverrides: CalendarConfiguration['dateOverrides'];
  revision: number;
  /** True for a calendar someone has been booked on: it is not deleted. */
  appointments: boolean;
}

export interface FakeApi {
  readonly client: Client;
  /** Answers one call as the server would, or throws its refusal: what the browser stand-in uses. */
  readonly ask: (call: Call) => Promise<unknown>;
  readonly calls: Call[];
  /** The calls of one operation, in order. */
  readonly of: (operation: string) => Call[];
  /** Fails the next call of an operation, once. */
  readonly refuse: (operation: string, error: Error) => void;
  /** Someone else saves a calendar: its revision moves on. */
  readonly touch: (id: string, change: Partial<Calendar>) => void;
  readonly calendars: () => Calendar[];
  readonly configuration: (id: string) => CalendarConfiguration;
}

const revisionOf = (count: number): string => count.toString(16).padStart(64, '0');

export function fakeCalendarApi({
  calendars = [],
  configurations = [],
  groups = [],
  people = everyone,
  canManage = true,
  schedules = {},
  timezone = 'Africa/Nairobi',
  booked = [],
  google = { available: false, mine: null, team: null },
}: {
  /** Google Calendar on the install and each member's connection: none by default. */
  readonly google?: GoogleConnections;
  readonly calendars?: readonly Calendar[];
  /** Calendars given with their team and hours. */
  readonly configurations?: readonly CalendarConfiguration[];
  readonly groups?: readonly string[];
  readonly people?: readonly User[];
  readonly canManage?: boolean;
  /** Each person's own schedule, by membership id. */
  readonly schedules?: Readonly<Record<string, CalendarUserAvailability['profile']>>;
  readonly timezone?: string;
  /** Ids of calendars that have appointments. */
  readonly booked?: readonly string[];
} = {}): FakeApi {
  let made = 0;
  const calls: Call[] = [];
  const refusals = new Map<string, Error>();
  /** The Media Storage files uploaded here, by id: a file uploaded outside it is not one. */
  const mediaFiles = new Map<string, { readonly name: string; public: boolean }>();
  const stored: Stored[] = [
    ...calendars.map((each) => ({
      calendar: each,
      members: [],
      weeklyHours: [],
      dateOverrides: [],
      revision: 1,
      appointments: booked.includes(each.id),
    })),
    ...configurations.map((each) => ({
      calendar: each.calendar,
      members: each.members,
      weeklyHours: each.weeklyHours,
      dateOverrides: each.dateOverrides,
      revision: 1,
      appointments: booked.includes(each.calendar.id),
    })),
  ];
  let groupList: CalendarGroup[] = groups.map((name, index) => ({
    id: `calg_01h455vb4pex5vsknk084sn0${String(index + 10)}`,
    name,
    calendarCount: 0,
    createdAt: at,
    updatedAt: at,
  }));
  const groupName = (id: string | null): string | null =>
    groupList.find((group) => group.id === id)?.name ?? null;
  const view = (each: Stored): CalendarConfiguration => ({
    calendar: { ...each.calendar, groupName: groupName(each.calendar.groupId) },
    members: each.members,
    weeklyHours: each.weeklyHours,
    dateOverrides: each.dateOverrides,
    revision: revisionOf(each.revision),
    canManage,
  });
  const find = (id: string | undefined): Stored => {
    const found = stored.find((each) => each.calendar.id === id);
    if (found === undefined) throw problem(404);
    return found;
  };
  const stale = problem(409, {
    detail: 'Calendar changed since you opened it. Reload before saving.',
  });
  const checkMembers = (members: readonly { membershipId: string }[]): void => {
    const strangers = members.some(
      (member) =>
        !people.some(
          (each) =>
            each.membershipId === member.membershipId &&
            each.userType === 'account' &&
            each.status === 'active',
        ),
    );
    if (strangers)
      throw problem(422, {
        errors: [
          {
            path: '/members',
            code: 'invalid',
            message: 'Choose a supported calendar and its business team.',
          },
        ],
      });
  };

  const answer = (call: Call): unknown => {
    const { operation, params = {}, query = {} } = call;
    switch (operation) {
      case 'listCalendars': {
        const asked = listCalendarsQuery.parse(query);
        const q = asked.q?.toLowerCase();
        const found = stored
          .map((each) => view(each).calendar)
          .filter(
            (each) =>
              (asked.status === undefined || each.isActive === (asked.status === 'active')) &&
              (asked.kind === undefined || each.kind === asked.kind) &&
              (asked.group === undefined ||
                (asked.group === 'none' ? each.groupId === null : each.groupId === asked.group)) &&
              (asked.member === undefined ||
                find(each.id).members.some((member) => member.membershipId === asked.member)) &&
              (q === undefined ||
                each.name.toLowerCase().includes(q) ||
                (each.groupName ?? '').toLowerCase().includes(q)),
          );
        const start =
          asked.after === undefined ? 0 : found.findIndex((each) => each.id === asked.after) + 1;
        const items = found.slice(start, start + asked.limit);
        return {
          items,
          nextCursor: start + asked.limit < found.length ? (items.at(-1)?.id ?? null) : null,
          total: found.length,
          canManage,
        };
      }
      case 'listCalendarGroups':
        return {
          items: groupList
            .map((group) => ({
              ...group,
              calendarCount: stored.filter((each) => each.calendar.groupId === group.id).length,
            }))
            .toSorted((one, other) => one.name.localeCompare(other.name)),
          ungroupedCount: stored.filter((each) => each.calendar.groupId === null).length,
          calendarCount: stored.length,
          canManage,
        };
      case 'createCalendarGroup':
      case 'renameCalendarGroup': {
        const { name } = calendarGroupInput.parse(call.body);
        if (groupList.some((group) => group.name === name && group.id !== params['groupId']))
          throw problem(422, {
            errors: [
              { path: '/name', code: 'duplicate', message: 'Another group already has this name.' },
            ],
          });
        if (operation === 'createCalendarGroup') {
          made += 1;
          const created: CalendarGroup = {
            id: `calg_01h455vb4pex5vsknk084sn0${String(made + 40)}`,
            name,
            calendarCount: 0,
            createdAt: at,
            updatedAt: at,
          };
          groupList = [...groupList, created];
          return created;
        }
        groupList = groupList.map((group) =>
          group.id === params['groupId'] ? { ...group, name } : group,
        );
        return groupList.find((group) => group.id === params['groupId']);
      }
      case 'deleteCalendarGroup':
        groupList = groupList.filter((group) => group.id !== params['groupId']);
        for (const each of stored)
          if (each.calendar.groupId === params['groupId'])
            each.calendar = { ...each.calendar, groupId: null };
        return undefined;
      case 'deleteCalendar': {
        const found = find(params['id']);
        if (found.appointments)
          throw problem(409, {
            detail: `"${found.calendar.name}" has appointments, so it can't be deleted. Make it inactive instead.`,
          });
        stored.splice(stored.indexOf(found), 1);
        return undefined;
      }
      case 'createCalendar': {
        const input = createCalendarInput.parse(call.body);
        checkMembers(input.members);
        made += 1;
        const { members, weeklyHours, dateOverrides, ...settings } = input;
        const created: Stored = {
          calendar: calendar.parse({
            ...settings,
            id: `cal_01h455vb4pex5vsknk084sn0${String(made + 60)}`,
            supported: settings.kind === 'personal' || settings.kind === 'round_robin',
            bookable: false,
            createdAt: at,
            updatedAt: at,
          }),
          members,
          weeklyHours,
          dateOverrides,
          revision: 1,
          appointments: false,
        };
        stored.push(created);
        return view(created);
      }
      case 'getCalendar':
        return view(find(params['id']));
      case 'updateCalendar': {
        const { revision, ...settings } = updateCalendarInput.parse(call.body);
        const found = find(params['id']);
        if (revision !== revisionOf(found.revision)) throw stale;
        found.calendar = { ...found.calendar, ...settings };
        found.revision += 1;
        return view(found);
      }
      case 'updateCalendarAvailability': {
        const { revision, ...availability } = updateCalendarAvailabilityInput.parse(call.body);
        const found = find(params['id']);
        if (revision !== revisionOf(found.revision)) throw stale;
        checkMembers(availability.members);
        Object.assign(found, availability);
        found.revision += 1;
        return view(found);
      }
      case 'listUsers': {
        const found = people.filter(
          (each) => query['type'] === undefined || each.userType === query['type'],
        );
        return { items: found, total: found.length, next: null, roles: [], canManage };
      }
      case 'getBusinessProfile':
        return { timezone };
      case 'getCalendarUserAvailability': {
        if (!canManage) throw problem(403);
        const membershipId = params['membershipId'] ?? '';
        return {
          membershipId,
          profile: schedules[membershipId] ?? null,
          revision: revisionOf(1),
        };
      }
      case 'listForms':
        return {
          items: [
            {
              id: formId,
              name: 'Enquiry form',
              status: 'published',
              hasUnpublishedChanges: false,
              submissionCount: 0,
              lastSubmissionAt: null,
              updatedAt: at,
            },
          ],
          nextCursor: null,
          canManage,
        };
      case 'listCalendarSenders':
        return {
          items: [{ id: senderId, name: 'Bookings', email: 'bookings@example.test' }],
          nextCursor: null,
        };
      case 'uploadFile': {
        const id = 'file_01h455vb4pex5vsknk084sn02q';
        const name = String(query['filename']);
        // Into Media Storage when asked, private until it is made public.
        if (query['library'] === 'true') mediaFiles.set(id, { name, public: false });
        return {
          id,
          filename: name,
          contentType: 'image/png',
          size: 1,
          sha256: 'a'.repeat(64),
          createdAt: at,
        };
      }
      case 'createFileLink':
        return { url: 'https://files.example.test/image.png', expiresAt: at };
      case 'getMediaFile':
      case 'updateMediaFile': {
        const id = params['id'] ?? '';
        const found = mediaFiles.get(id);
        if (found === undefined) throw problem(404);
        const asked = call.body as { public?: boolean } | undefined;
        if (operation === 'updateMediaFile' && asked?.public !== undefined)
          found.public = asked.public;
        return {
          id,
          name: found.name,
          contentType: 'image/png',
          kind: 'image',
          size: 1,
          folderId: null,
          public: found.public,
          publicUrl: found.public
            ? `https://crm.example.test/m/AbCdEfGhIjKlMnOpQrStUv/${found.name}`
            : null,
          previewUrl: 'https://files.example.test/image.png',
          createdAt: at,
          updatedAt: at,
          ...(operation === 'getMediaFile' ? { sha256: 'a'.repeat(64), usedIn: [] } : {}),
        };
      }
      case 'getGoogleConnections':
        return google;
      default:
        throw new Error(`The stand-in does not answer ${operation}.`);
    }
  };

  const ask = (call: Call): Promise<unknown> => {
    calls.push(call);
    return Promise.resolve().then(() => {
      const refused = refusals.get(call.operation);
      if (refused !== undefined) {
        refusals.delete(call.operation);
        throw refused;
      }
      return answer(call);
    });
  };
  const client = {
    request: (endpoint: { operationId: string }, input: Omit<Call, 'operation'> = {}) =>
      ask({ operation: endpoint.operationId, ...input }),
  } as unknown as Client;
  return {
    client,
    ask,
    calls,
    of: (operation) => calls.filter((call) => call.operation === operation),
    refuse: (operation, error) => {
      refusals.set(operation, error);
    },
    touch: (id, change) => {
      const found = find(id);
      found.calendar = { ...found.calendar, ...change };
      found.revision += 1;
    },
    calendars: () => stored.map((each) => view(each).calendar),
    configuration: (id) => view(find(id)),
  };
}
