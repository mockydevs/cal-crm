// Stand-ins for what the Calendars pages read: the events between two instants, the
// calendars and the team. Times are written with Nairobi's offset; the specs run the
// browser in that zone, so a wall time here is the wall time on screen.
import { expect, type Page } from '@playwright/test';
import {
  cancelAppointmentInput,
  createAppointmentInput,
  listAppointmentsQuery,
  rescheduleAppointmentInput,
  setAppointmentNotesInput,
  setAppointmentStatusInput,
  type AppointmentDetail,
  type AppointmentRow,
  calendar,
  type Calendar,
  type CalendarEvent,
} from '@repo/contracts';
import { harbor } from './session';

export const zone = 'Africa/Nairobi';
/** Wednesday 14 October 2026, a quarter past ten in the morning in Nairobi. */
export const now = new Date('2026-10-14T10:15:00+03:00');

export const danaId = 'mem_01h455vb4pex5vsknk084sn02q';
export const leeId = 'mem_01h455vb4pex5vsknk084sn02r';
export const toursId = 'cal_01h455vb4pex5vsknk084sn02q';
export const tastingsId = 'cal_01h455vb4pex5vsknk084sn02r';

type Appointment = Extract<CalendarEvent, { kind: 'appointment' }>;

const instant = (day: number, time: string): string =>
  new Date(`2026-10-${String(day).padStart(2, '0')}T${time}:00+03:00`).toISOString();

export function appointmentOf(
  number: number,
  title: string,
  day: number,
  from: string,
  to: string,
  rest: Partial<Appointment> = {},
): Appointment {
  return {
    kind: 'appointment',
    id: `appt_01h455vb4pex5vsknk084sn0${String(number).padStart(2, '0')}`,
    title,
    startsAt: instant(day, from),
    endsAt: instant(day, to),
    status: 'confirmed',
    calendar: { id: toursId, name: 'Venue tours' },
    contact: { id: 'con_01h455vb4pex5vsknk084sn02q', name: 'Maya Thompson', trashed: false },
    assignee: { membershipId: leeId, you: false },
    ...rest,
  };
}

export const tour = appointmentOf(1, 'Venue tour', 14, '09:00', '10:00');
export const tasting = appointmentOf(2, 'Menu tasting', 15, '13:00', '13:30', {
  status: 'cancelled',
  calendar: { id: tastingsId, name: 'Tastings' },
  assignee: null,
});
export const walkthrough = appointmentOf(3, 'Final walkthrough', 16, '15:00', '16:00', {
  status: 'booked',
  assignee: { membershipId: danaId, you: true },
});
export const leave: CalendarEvent = {
  kind: 'blocked',
  id: 'blk_01h455vb4pex5vsknk084sn02q',
  startsAt: instant(16, '12:00'),
  endsAt: instant(16, '14:00'),
  user: { membershipId: danaId, you: true, name: 'Dana Brooks' },
  calendar: null,
  title: 'Dentist',
};

export function calendarOf(id: string, name: string, rest: Partial<Calendar> = {}): Calendar {
  // Parsed, so a calendar here has every setting a real answer has, at its default.
  return calendar.parse({
    id,
    name,
    description: '',
    kind: 'personal',
    timezone: zone,
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
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-09T09:00:00.000Z',
    ...rest,
  });
}

export const calendars = [
  calendarOf(toursId, 'Venue tours'),
  calendarOf(tastingsId, 'Tastings', { kind: 'round_robin', isActive: false, bookable: false }),
];

const member = (id: string, name: string, email: string, isSelf: boolean) => ({
  id,
  name,
  email,
  roleId: 'role_01h455vb4pex5vsknk084sn02q',
  roleName: isSelf ? 'Owner' : 'Member',
  isSelf,
  isOwner: isSelf,
});

const names: Readonly<Record<string, string>> = { [danaId]: 'Dana Brooks', [leeId]: 'Lee Park' };
const mayaId = 'con_01h455vb4pex5vsknk084sn02q';

type Detail = AppointmentDetail;
type Change = 'create' | 'reschedule' | 'cancel' | 'status' | 'notes';
interface Refusal {
  readonly status: 409 | 422;
  readonly detail?: string;
  readonly errors?: readonly { path: string; code: string; message: string }[];
}

export interface CalendarApi {
  /** The query of every read of events, in order. */
  readonly reads: Record<string, string>[];
  /** The query of every read of the appointment list, in order. */
  readonly lists: Record<string, string>[];
  /** What each change was sent, in order. */
  readonly sent: Record<Change, unknown[]>;
  /** The appointments as the server has them now. */
  readonly appointments: Detail[];
  /** Answers the next change of a kind with a refusal, once. */
  refuse: (change: Change, refusal: Refusal) => void;
  /** Someone else changes an appointment: its revision moves on, with what they changed. */
  touch: (id: string, change?: Partial<Detail>) => void;
}

const revisionOf = (count: number): string => count.toString(16).padStart(64, '0');

function detailOf(event: Extract<CalendarEvent, { kind: 'appointment' }>, count: number): Detail {
  return {
    ...event,
    assignee:
      event.assignee === null
        ? null
        : { ...event.assignee, name: names[event.assignee.membershipId ?? ''] ?? '' },
    createdAt: '2026-10-01T09:00:00.000Z',
    source: 'booking_page',
    notes: '',
    location: null,
    timezone: zone,
    updatedAt: '2026-10-01T09:00:00.000Z',
    cancelledAt: event.status === 'cancelled' ? '2026-10-02T09:00:00.000Z' : null,
    cancelReason: null,
    createdBy: null,
    revision: revisionOf(count),
    canManage: true,
    history: [
      {
        type: 'booked',
        at: '2026-10-01T09:00:00.000Z',
        actor: { kind: 'contact', name: null },
      },
    ],
  };
}

/** The fields of a row, as `GET /appointments` lists it. */
function rowOf(detail: Detail): AppointmentRow {
  const { kind, id, title, startsAt, endsAt, status, calendar, contact, assignee } = detail;
  return {
    kind,
    id,
    title,
    startsAt,
    endsAt,
    status,
    calendar,
    contact,
    assignee,
    createdAt: detail.createdAt,
    source: detail.source,
  };
}

/**
 * Answers the Calendars pages as the server does: the events that overlap a window, the
 * appointment list with its filters, order and paging, one appointment, and the four
 * changes, each checked against the contract and against the revision it carries.
 */
export async function fakeCalendarApi(
  page: Page,
  events: readonly CalendarEvent[],
  { canManage = true }: { readonly canManage?: boolean } = {},
): Promise<CalendarApi> {
  let revisions = 1;
  const refusals = new Map<Change, Refusal>();
  const blocked = events.filter((event) => event.kind === 'blocked');
  const api: CalendarApi = {
    reads: [],
    lists: [],
    sent: { create: [], reschedule: [], cancel: [], status: [], notes: [] },
    appointments: events.flatMap((event) =>
      event.kind === 'appointment' ? [{ ...detailOf(event, revisions), canManage }] : [],
    ),
    refuse: (change, refusal) => {
      refusals.set(change, refusal);
    },
    touch: (id, change = {}) => {
      const index = api.appointments.findIndex((each) => each.id === id);
      const found = api.appointments[index];
      if (found === undefined) throw new Error('No such appointment in the stand-in.');
      revisions += 1;
      api.appointments[index] = { ...found, ...change, revision: revisionOf(revisions) };
    },
  };
  await page.route('**/api/v1/team', (route) =>
    route.fulfill({
      json: {
        members: [
          member(danaId, 'Dana Brooks', 'dana@harborlights.example', true),
          member(leeId, 'Lee Park', 'lee@harborlights.example', false),
        ],
        roles: [],
        invitations: [],
        canManage: true,
      },
    }),
  );
  await page.route(/\/api\/v1\/contacts\?(?:.*&)?q=/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: mayaId,
            name: 'Maya Thompson',
            email: 'maya@example.test',
            phone: null,
            createdAt: '2026-10-01T09:00:00.000Z',
          },
        ],
        next: null,
        canManage: true,
      },
    }),
  );
  await page.route(/\/api\/v1\/calendars(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: calendars, nextCursor: null, canManage: true } }),
  );
  await page.route(/\/api\/v1\/calendars\/cal_[0-9a-z]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({
      json: {
        calendar: calendars.find((each) => each.id === id),
        members: [
          { membershipId: leeId, weight: 1 },
          { membershipId: danaId, weight: 1 },
        ],
        weeklyHours: [],
        dateOverrides: [],
        revision: 'c'.repeat(64),
        canManage: true,
      },
    });
  });
  await page.route(/\/api\/v1\/calendars\/events\?/, async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    api.reads.push(query);
    const from = Date.parse(query['from'] ?? '');
    const to = Date.parse(query['to'] ?? '');
    const users = query['users']?.split(',');
    const chosen = query['calendars']?.split(',');
    const inWindow = (event: { startsAt: string; endsAt: string }): boolean =>
      Date.parse(event.startsAt) < to && Date.parse(event.endsAt) > from;
    const items: CalendarEvent[] = [
      ...(query['type'] === 'blocked'
        ? []
        : api.appointments
            .filter(
              (each) =>
                inWindow(each) &&
                (users === undefined || users.includes(each.assignee?.membershipId ?? '')) &&
                (chosen === undefined || chosen.includes(each.calendar.id)),
            )
            .map((each) => {
              const row = rowOf(each);
              return {
                ...row,
                assignee:
                  row.assignee === null
                    ? null
                    : { membershipId: row.assignee.membershipId, you: row.assignee.you },
              };
            })),
      ...(query['type'] === 'appointments'
        ? []
        : blocked.filter(
            (event) =>
              inWindow(event) &&
              (users === undefined || users.includes(event.user?.membershipId ?? '')),
          )),
    ].toSorted((one, other) => Date.parse(one.startsAt) - Date.parse(other.startsAt));
    await route.fulfill({ json: { items, truncated: false, canManage: true } });
  });

  const problem = (refusal: Refusal) => ({
    status: refusal.status,
    contentType: 'application/problem+json',
    json: {
      type: 'about:blank',
      title: refusal.status === 409 ? 'Conflict' : 'Unprocessable',
      status: refusal.status,
      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
      ...(refusal.errors === undefined ? {} : { errors: refusal.errors }),
    },
  });
  const stale: Refusal = {
    status: 409,
    detail: 'This appointment changed. Reload before continuing.',
  };

  await page.route(/\/api\/v1\/appointments(?:[/?].*)?$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const url = new URL(request.url());
    const [, , , , id, action] = url.pathname.split('/');
    const method = request.method();

    if (id === undefined && method === 'GET') {
      const query = Object.fromEntries(url.searchParams);
      api.lists.push(query);
      const asked = listAppointmentsQuery.parse(query);
      const q = asked.q?.toLowerCase();
      const matching = api.appointments
        .filter(
          (each) =>
            (asked.view === 'all' ||
              (asked.view === 'cancelled'
                ? each.status === 'cancelled'
                : each.status !== 'cancelled' && Date.parse(each.endsAt) > now.getTime())) &&
            (asked.status === undefined || each.status === asked.status) &&
            (asked.calendar === undefined || each.calendar.id === asked.calendar) &&
            (asked.user === undefined || each.assignee?.membershipId === asked.user) &&
            (asked.contact === undefined || each.contact.id === asked.contact) &&
            (asked.from === undefined || Date.parse(each.startsAt) >= Date.parse(asked.from)) &&
            (asked.to === undefined || Date.parse(each.startsAt) < Date.parse(asked.to)) &&
            (q === undefined || each.title.toLowerCase().includes(q)),
        )
        .toSorted((one, other) => {
          const order =
            asked.sort === 'title'
              ? one.title.localeCompare(other.title)
              : Date.parse(one[asked.sort]) - Date.parse(other[asked.sort]);
          return asked.direction === 'asc' ? order : -order;
        });
      const start =
        asked.after === undefined ? 0 : matching.findIndex((each) => each.id === asked.after) + 1;
      const items = matching.slice(start, start + asked.limit);
      await route.fulfill({
        json: {
          items: items.map(rowOf),
          next: start + asked.limit < matching.length ? (items.at(-1)?.id ?? null) : null,
          total: matching.length,
          canManage,
        },
      });
      return;
    }

    if (id === undefined) {
      const body = createAppointmentInput.parse(request.postDataJSON());
      api.sent.create.push(request.postDataJSON());
      const refusal = refusals.get('create');
      if (refusal !== undefined) {
        refusals.delete('create');
        await route.fulfill(problem(refusal));
        return;
      }
      const calendar = calendars.find((each) => each.id === body.calendarId);
      const owner = body.assignee ?? leeId;
      const created: Detail = {
        kind: 'appointment',
        id: `appt_01h455vb4pex5vsknk084sn09${String(api.appointments.length)}`,
        title: body.title ?? calendar?.name ?? '',
        startsAt: body.startsAt,
        endsAt: body.endsAt ?? new Date(Date.parse(body.startsAt) + 30 * 60_000).toISOString(),
        status: body.status,
        calendar: { id: body.calendarId, name: calendar?.name ?? '' },
        contact: { id: body.contactId, name: 'Maya Thompson', trashed: false },
        assignee: { membershipId: owner, you: owner === danaId, name: names[owner] ?? '' },
        createdAt: now.toISOString(),
        source: 'user',
        notes: body.notes,
        location: body.location ?? null,
        timezone: zone,
        updatedAt: now.toISOString(),
        cancelledAt: null,
        cancelReason: null,
        createdBy: { name: 'Dana Brooks' },
        revision: revisionOf((revisions += 1)),
        canManage,
        history: [
          { type: 'booked', at: now.toISOString(), actor: { kind: 'user', name: 'Dana Brooks' } },
        ],
      };
      api.appointments.push(created);
      await route.fulfill({ status: 201, json: created });
      return;
    }

    const index = api.appointments.findIndex((each) => each.id === id);
    const found = api.appointments[index];
    if (found === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Not found', status: 404 },
      });
      return;
    }
    if (action === undefined) {
      await route.fulfill({ json: found });
      return;
    }

    const change: Change =
      action === 'reschedule' || action === 'cancel' || action === 'notes' ? action : 'status';
    api.sent[change].push(request.postDataJSON());
    const input =
      change === 'reschedule'
        ? rescheduleAppointmentInput.parse(request.postDataJSON())
        : change === 'cancel'
          ? cancelAppointmentInput.parse(request.postDataJSON())
          : change === 'notes'
            ? setAppointmentNotesInput.parse(request.postDataJSON())
            : setAppointmentStatusInput.parse(request.postDataJSON());
    const refusal = input.revision === found.revision ? refusals.get(change) : stale;
    if (refusal !== undefined) {
      if (refusal !== stale) refusals.delete(change);
      await route.fulfill(problem(refusal));
      return;
    }
    const at = now.toISOString();
    const actor = { kind: 'user', name: 'Dana Brooks' };
    const saved: Detail =
      'notes' in input
        ? { ...found, notes: input.notes }
        : 'startsAt' in input
          ? {
              ...found,
              startsAt: input.startsAt,
              endsAt:
                input.endsAt ??
                new Date(
                  Date.parse(input.startsAt) +
                    (Date.parse(found.endsAt) - Date.parse(found.startsAt)),
                ).toISOString(),
              history: [...found.history, { type: 'rescheduled', at, actor }],
            }
          : 'status' in input && input.status !== 'cancelled'
            ? {
                ...found,
                status: input.status,
                cancelledAt: null,
                cancelReason: null,
                history: [
                  ...found.history,
                  { type: 'status_changed', at, actor, status: input.status },
                ],
              }
            : {
                ...found,
                status: 'cancelled',
                cancelledAt: at,
                cancelReason: 'reason' in input ? (input.reason ?? null) : null,
                history: [...found.history, { type: 'cancelled', at, actor }],
              };
    api.appointments[index] = { ...saved, revision: revisionOf((revisions += 1)) };
    await route.fulfill({ json: api.appointments[index] });
  });
  return api;
}
