// Blocked slots: time nobody can book, added, changed and removed one at a time, as
// GoHighLevel's "+ New → Blocked slot" does. A slot blocks a team member on every calendar
// of this business, a whole calendar, or a member on one calendar. It keeps new bookings
// out; the appointments already in it stay.
//
// Who may block: whoever may manage calendars, for anyone, as for a person's hours
// (calendars.manage, "Configure calendars, team availability and booking settings"). A
// title is private, as an absence's reason was: only they read it.
//
// A block and a booking never interleave: both take the business lock first
// (CalendarOptions.business.lockActive, FOR NO KEY UPDATE on the business row), so a
// booking either sees the block or was made before it.
//
// A block is this business's. The person's other businesses do not see it: their bookings
// are one diary across businesses, their time off in each business is that business's to
// say.
import { createHash } from 'node:crypto';
import {
  defineCommand,
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Command,
  type Invocation,
} from '@repo/commands';
import {
  BLOCKED_SLOTS_LIMIT,
  blockedSlotInput,
  createBlockedSlot,
  deleteBlockedSlot,
  getBlockedSlot,
  listBlockedSlots,
  parseInput,
  updateBlockedSlot,
  updateBlockedSlotInput,
  type BlockedSlot,
  type BlockedSlotList,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import type { CalendarOptions } from './calendars.js';
import type { CalendarEventOptions } from './events.js';

/** What blocked slots need from the modules that own the business and its team. */
export interface BlockedSlotOptions {
  readonly business: CalendarOptions['business'];
  readonly members: CalendarOptions['members'];
  readonly people: CalendarEventOptions['people'];
}

/** PostgreSQL keeps microseconds; a JavaScript Date would drop them from a block. */
const instantText = (column: 'x.starts_at' | 'x.ends_at') =>
  sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Row {
  readonly id: string;
  readonly user_id: string | null;
  readonly calendar_id: string | null;
  readonly calendar_name: string | null;
  readonly title: string;
  readonly starts: string;
  readonly ends: string;
}

function rows(trx: DatabaseTransaction, businessId: string) {
  return trx
    .selectFrom('calendar.blocked_slots as x')
    .leftJoin('calendar.calendars as c', (join) =>
      join.onRef('c.business_id', '=', 'x.business_id').onRef('c.id', '=', 'x.calendar_id'),
    )
    .select(['x.id', 'x.user_id', 'x.calendar_id', 'c.name as calendar_name', 'x.title'])
    .select(instantText('x.starts_at').as('starts'))
    .select(instantText('x.ends_at').as('ends'))
    .where('x.business_id', '=', businessId);
}

/** Stored values only, microseconds included, so a change elsewhere always changes it. */
const revisionOf = (row: Row): string =>
  createHash('sha256')
    .update(JSON.stringify([row.user_id, row.calendar_id, row.title, row.starts, row.ends]))
    .digest('hex');

/** The blocked slots as the API shows them, each person named as the team list names them. */
async function present(
  trx: DatabaseTransaction,
  context: TenantContext,
  found: readonly Row[],
  options: BlockedSlotOptions,
): Promise<BlockedSlot[]> {
  const people = [...new Set(found.flatMap((row) => (row.user_id === null ? [] : [row.user_id])))];
  const memberships = await options.members.memberships(trx, context, people);
  const names = await options.people.names(trx, [...memberships.keys()]);
  return found.map((row) => ({
    id: toPublicId('blocked_slot', row.id),
    member:
      row.user_id === null
        ? null
        : {
            membershipId: memberships.get(row.user_id) ?? null,
            you: context.actorKind === 'user' && context.userId === row.user_id,
            name: memberships.has(row.user_id) ? (names.get(row.user_id) ?? '') : '',
          },
    calendar:
      row.calendar_id === null
        ? null
        : // The foreign key keeps the calendar while its block exists.
          { id: toPublicId('calendar', row.calendar_id), name: row.calendar_name ?? '' },
    title: row.title,
    startsAt: row.starts,
    endsAt: row.ends,
    revision: revisionOf(row),
  }));
}

async function rowOf(trx: DatabaseTransaction, businessId: string, publicId: string): Promise<Row> {
  const id = parsePublicId('blocked_slot', publicId);
  const row =
    id === undefined
      ? undefined
      : await rows(trx, businessId).where('x.id', '=', id).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Blocked slot', publicId);
  return row;
}

async function readOne(
  trx: DatabaseTransaction,
  context: TenantContext,
  publicId: string,
  options: BlockedSlotOptions,
): Promise<BlockedSlot> {
  const [slot] = await present(
    trx,
    context,
    [await rowOf(trx, requireBusiness(context), publicId)],
    options,
  );
  if (slot === undefined) throw new NotFoundError('Blocked slot', publicId);
  return slot;
}

/** A team member of this business now, or a refusal that names the field. */
async function memberOf(
  options: BlockedSlotOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  membershipId: string,
): Promise<string> {
  try {
    return await options.members.resolve(trx, context, membershipId);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    throw new ValidationError([
      {
        path: '/membershipId',
        code: 'unavailable_member',
        message: 'Choose someone on this business team.',
      },
    ]);
  }
}

type Place = Pick<z.output<typeof blockedSlotInput>, 'membershipId' | 'calendarId'>;

/** Whom the input blocks: a member of the team, a calendar of the business, or both. */
async function placeOf(
  options: BlockedSlotOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  input: Place,
): Promise<{ readonly userId: string | null; readonly calendarId: string | null }> {
  const businessId = requireBusiness(context);
  const userId =
    input.membershipId === null ? null : await memberOf(options, trx, context, input.membershipId);
  if (input.calendarId === null) return { userId, calendarId: null };
  const calendarId = parsePublicId('calendar', input.calendarId) ?? '';
  const calendar = await trx
    .selectFrom('calendar.calendars')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', calendarId)
    .executeTakeFirst();
  if (calendar === undefined)
    throw new ValidationError([
      {
        path: '/calendarId',
        code: 'unknown_calendar',
        message: 'Choose a calendar of this business.',
      },
    ]);
  if (userId !== null) {
    // A person blocked on one calendar is a person who takes bookings on it.
    const serves = await trx
      .selectFrom('calendar.calendar_members')
      .select('user_id')
      .where('business_id', '=', businessId)
      .where('calendar_id', '=', calendarId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (serves === undefined)
      throw new ValidationError([
        {
          path: '/calendarId',
          code: 'not_on_calendar',
          message: "This person doesn't take bookings on this calendar.",
        },
      ]);
  }
  return { userId, calendarId };
}

/** The title is private: the audit log keeps whom and when, never what it says. */
const auditOf = (input: z.output<typeof blockedSlotInput>) => ({
  membershipId: input.membershipId,
  calendarId: input.calendarId,
  startsAt: input.startsAt,
  endsAt: input.endsAt,
});

export function createBlockedSlotCommand(
  options: BlockedSlotOptions,
): Command<typeof blockedSlotInput, BlockedSlot> {
  return defineCommand({
    name: 'calendar.blocked_slot.create',
    permission: 'calendars.manage',
    input: blockedSlotInput,
    audit: auditOf,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      await options.business.lockActive(trx, command.context);
      const place = await placeOf(options, trx, command.context, input);
      const row = await trx
        .insertInto('calendar.blocked_slots')
        .values({
          business_id: businessId,
          user_id: place.userId,
          calendar_id: place.calendarId,
          title: input.title,
          // As sent: a Date would drop microseconds.
          starts_at: input.startsAt,
          ends_at: input.endsAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'calendar.blocked_slot.created',
        subject: { kind: 'blocked_slot', id: row.id },
        payload: auditOf(input),
      });
      return readOne(trx, command.context, toPublicId('blocked_slot', row.id), options);
    },
  });
}

const updateInput = updateBlockedSlotInput.safeExtend(updateBlockedSlot.params.shape);

export function updateBlockedSlotCommand(
  options: BlockedSlotOptions,
): Command<typeof updateInput, BlockedSlot> {
  return defineCommand({
    name: 'calendar.blocked_slot.update',
    permission: 'calendars.manage',
    input: updateInput,
    audit: (input) => ({
      blockedSlotId: input.blockedSlotId,
      revision: input.revision,
      ...auditOf(input),
    }),
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      await options.business.lockActive(trx, command.context);
      const current = await rowOf(trx, businessId, input.blockedSlotId);
      if (revisionOf(current) !== input.revision)
        throw new ConflictError('This blocked slot changed since you opened it. Reload it first.');
      const place = await placeOf(options, trx, command.context, input);
      await trx
        .updateTable('calendar.blocked_slots')
        .set({
          user_id: place.userId,
          calendar_id: place.calendarId,
          title: input.title,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', current.id)
        .execute();
      await command.emit({
        type: 'calendar.blocked_slot.updated',
        subject: { kind: 'blocked_slot', id: current.id },
        payload: auditOf(input),
      });
      return readOne(trx, command.context, input.blockedSlotId, options);
    },
  });
}

export function deleteBlockedSlotCommand(
  options: BlockedSlotOptions,
): Command<typeof deleteBlockedSlot.params, undefined> {
  return defineCommand({
    name: 'calendar.blocked_slot.delete',
    permission: 'calendars.manage',
    input: deleteBlockedSlot.params,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      await options.business.lockActive(trx, command.context);
      const current = await rowOf(trx, businessId, input.blockedSlotId);
      await trx
        .deleteFrom('calendar.blocked_slots')
        .where('business_id', '=', businessId)
        .where('id', '=', current.id)
        .execute();
      await command.emit({
        type: 'calendar.blocked_slot.deleted',
        subject: { kind: 'blocked_slot', id: current.id },
        payload: { startsAt: current.starts, endsAt: current.ends },
      });
      return undefined;
    },
  });
}

/** A team member's blocked slots that have not ended: their Time away, by start. */
async function readMemberBlockedSlots(
  trx: DatabaseTransaction,
  invocation: Invocation,
  membershipId: string,
  options: BlockedSlotOptions,
): Promise<BlockedSlotList> {
  const businessId = requireBusiness(invocation.context);
  let userId: string;
  try {
    userId = await options.members.resolve(trx, invocation.context, membershipId);
  } catch (error) {
    if (error instanceof ValidationError) throw new NotFoundError('Team member', membershipId);
    throw error;
  }
  const found = await rows(trx, businessId)
    .where('x.user_id', '=', userId)
    .where('x.ends_at', '>', sql<Date>`now()`)
    .orderBy('x.starts_at')
    .orderBy('x.id')
    .limit(BLOCKED_SLOTS_LIMIT + 1)
    .execute();
  return {
    items: await present(trx, invocation.context, found.slice(0, BLOCKED_SLOTS_LIMIT), options),
    truncated: found.length > BLOCKED_SLOTS_LIMIT,
  };
}

/**
 * The blocked time that keeps bookings on one calendar from its members between two
 * instants, by member: each one's own (on every calendar, or on this one) and the
 * calendar's own, which blocks them all. Titles are never read here.
 */
export async function readBlockedTime(
  trx: DatabaseTransaction,
  scope: { readonly business_id: string; readonly calendar_id: string },
  userIds: readonly string[],
  window: { readonly from: Date; readonly to: Date },
): Promise<ReadonlyMap<string, readonly { readonly startsAt: string; readonly endsAt: string }[]>> {
  if (userIds.length === 0) return new Map();
  const found = await trx
    .selectFrom('calendar.blocked_slots as x')
    .select(['x.user_id'])
    .select(instantText('x.starts_at').as('startsAt'))
    .select(instantText('x.ends_at').as('endsAt'))
    .where('x.business_id', '=', scope.business_id)
    .where((eb) =>
      eb.or([eb('x.calendar_id', 'is', null), eb('x.calendar_id', '=', scope.calendar_id)]),
    )
    .where((eb) =>
      eb.or([eb('x.user_id', 'is', null), eb('x.user_id', 'in', [...new Set(userIds)])]),
    )
    .where('x.starts_at', '<', window.to)
    .where('x.ends_at', '>', window.from)
    .execute();
  return new Map(
    userIds.map((userId) => [
      userId,
      found
        .filter((row) => row.user_id === null || row.user_id === userId)
        .map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
    ]),
  );
}

/** Reading shows private titles, so it needs the permission that writes them. */
export function createBlockedSlotRoutes(options: BlockedSlotOptions): readonly ApiRoute[] {
  const create = createBlockedSlotCommand(options);
  const update = updateBlockedSlotCommand(options);
  const remove = deleteBlockedSlotCommand(options);
  return [
    {
      endpoint: listBlockedSlots,
      async run({ invocation, params }, services) {
        await requirePermission(
          services,
          { name: 'calendar.blocked_slot.list', permission: 'calendars.manage' },
          invocation,
        );
        requireBusiness(invocation.context);
        const { membershipId } = parseInput(listBlockedSlots.params, params);
        return withTenant(services.db, invocation.context, (trx) =>
          readMemberBlockedSlots(trx, invocation, membershipId, options),
        );
      },
    },
    {
      endpoint: getBlockedSlot,
      async run({ invocation, params }, services) {
        await requirePermission(
          services,
          { name: 'calendar.blocked_slot.read', permission: 'calendars.manage' },
          invocation,
        );
        requireBusiness(invocation.context);
        const { blockedSlotId } = parseInput(getBlockedSlot.params, params);
        return withTenant(services.db, invocation.context, (trx) =>
          readOne(trx, invocation.context, blockedSlotId, options),
        );
      },
    },
    {
      endpoint: createBlockedSlot,
      command: create,
      run: ({ invocation, body }, services) => runCommand(services, create, body, invocation),
    },
    {
      endpoint: updateBlockedSlot,
      command: update,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          update,
          {
            ...parseInput(updateBlockedSlotInput, body),
            ...parseInput(updateBlockedSlot.params, params),
          },
          invocation,
        ),
    },
    {
      endpoint: deleteBlockedSlot,
      command: remove,
      run: ({ invocation, params }, services) =>
        runCommand(services, remove, parseInput(deleteBlockedSlot.params, params), invocation),
    },
  ];
}
