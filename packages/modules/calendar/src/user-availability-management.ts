import { createHash } from 'node:crypto';
import {
  defineCommand,
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Command,
} from '@repo/commands';
import {
  getCalendarUserAvailability,
  parseInput,
  updateCalendarUserAvailability,
  updateCalendarUserAvailabilityInput,
  type CalendarUserAvailability,
  type CalendarUserAvailabilityProfile,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, ValidationError, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import type { CalendarOptions } from './calendars.js';
import type { UserAvailabilityProfile } from './user-availability.js';

const ROWS_PER_INSERT = 1000;
const utcDate = (instant: number) => new Date(instant).toISOString().slice(0, 10);
interface OverrideRow {
  readonly date: string;
  readonly start_minute: number | null;
  readonly end_minute: number | null;
}
/** One group per date: a closed date is a row without minutes, and has no ranges. */
function groupOverrides(rows: readonly OverrideRow[]) {
  return [...Map.groupBy(rows, (row) => row.date)].map(([date, items]) => ({
    date,
    ranges: items.flatMap((item) =>
      item.start_minute === null || item.end_minute === null
        ? []
        : [{ startMinute: item.start_minute, endMinute: item.end_minute }],
    ),
  }));
}

/**
 * The person's business team membership, as the tenancy port sees it now. Someone removed
 * from the business, disabled, or in another business is not found: a stored schedule
 * gives nobody a place on the team.
 */
async function memberUserId(
  options: CalendarOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  membershipId: string,
): Promise<string> {
  try {
    return await options.members.resolve(trx, context, membershipId);
  } catch (error) {
    if (error instanceof ValidationError) throw new NotFoundError('Team member', membershipId);
    throw error;
  }
}

/** The whole stored schedule in the contract's order, or null when the person has none. */
async function readProfile(
  trx: DatabaseTransaction,
  businessId: string,
  userId: string,
): Promise<CalendarUserAvailabilityProfile | null> {
  const schedule = await trx
    .selectFrom('calendar.user_schedules')
    .select(['timezone', 'inherit_calendar_hours'])
    .where('business_id', '=', businessId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (schedule === undefined) return null;
  const weekly = await trx
    .selectFrom('calendar.user_weekly_hours')
    .select(['weekday', 'start_minute', 'end_minute'])
    .where('business_id', '=', businessId)
    .where('user_id', '=', userId)
    .orderBy('weekday')
    .orderBy('start_minute')
    .execute();
  const overrides = await trx
    .selectFrom('calendar.user_date_overrides')
    .select(['start_minute', 'end_minute'])
    .select(sql<string>`on_date::text`.as('date'))
    .where('business_id', '=', businessId)
    .where('user_id', '=', userId)
    .orderBy('on_date')
    .orderBy('start_minute')
    .execute();
  return {
    timezone: schedule.timezone,
    inheritCalendarHours: schedule.inherit_calendar_hours,
    weeklyHours: weekly.map((row) => ({
      weekday: row.weekday,
      startMinute: row.start_minute,
      endMinute: row.end_minute,
    })),
    dateOverrides: groupOverrides(overrides),
  };
}

/** Stored values only, so a save elsewhere always changes it. */
function viewOf(
  membershipId: string,
  profile: CalendarUserAvailabilityProfile | null,
): CalendarUserAvailability {
  return {
    membershipId,
    profile,
    revision: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
  };
}

async function insertInBatches<Row>(
  rows: readonly Row[],
  insert: (batch: readonly Row[]) => Promise<unknown>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += ROWS_PER_INSERT)
    await insert(rows.slice(index, index + ROWS_PER_INSERT));
}

const updateInput = updateCalendarUserAvailabilityInput.extend(
  updateCalendarUserAvailability.params.shape,
);

export function updateCalendarUserAvailabilityCommand(
  options: CalendarOptions,
): Command<typeof updateInput, CalendarUserAvailability> {
  return defineCommand({
    name: 'calendar.user_availability.update',
    permission: 'calendars.manage',
    input: updateInput,
    async handle(trx, input, command): Promise<CalendarUserAvailability> {
      const businessId = requireBusiness(command.context);
      // Every calendar writer and every booking takes this lock first, so a schedule
      // change and a booking never interleave, and two saves run one after the other.
      await options.business.lockActive(trx, command.context);
      const userId = await memberUserId(options, trx, command.context, input.membershipId);
      const current = viewOf(input.membershipId, await readProfile(trx, businessId, userId));
      if (current.revision !== input.revision)
        throw new ConflictError('This availability changed since you opened it. Reload it first.');
      const { profile } = input;
      const owner = { business_id: businessId, user_id: userId };
      if (profile === null)
        await trx
          .deleteFrom('calendar.user_schedules')
          .where('business_id', '=', businessId)
          .where('user_id', '=', userId)
          .execute();
      else {
        const timezone = await options.timeZones.find(trx, profile.timezone);
        if (timezone === undefined)
          throw new ValidationError([
            {
              path: '/profile/timezone',
              code: 'time_zone_unknown',
              message: "This isn't a time zone this server knows, such as Africa/Nairobi.",
            },
          ]);
        const schedule = { timezone, inherit_calendar_hours: profile.inheritCalendarHours };
        await trx
          .insertInto('calendar.user_schedules')
          .values({ ...owner, ...schedule })
          .onConflict((conflict) =>
            conflict.columns(['business_id', 'user_id']).doUpdateSet(schedule),
          )
          .execute();
        await trx
          .deleteFrom('calendar.user_weekly_hours')
          .where('business_id', '=', businessId)
          .where('user_id', '=', userId)
          .execute();
        await trx
          .deleteFrom('calendar.user_date_overrides')
          .where('business_id', '=', businessId)
          .where('user_id', '=', userId)
          .execute();
        await insertInBatches(profile.weeklyHours, (batch) =>
          trx
            .insertInto('calendar.user_weekly_hours')
            .values(
              batch.map((range) => ({
                ...owner,
                weekday: range.weekday,
                start_minute: range.startMinute,
                end_minute: range.endMinute,
              })),
            )
            .execute(),
        );
        await insertInBatches(
          profile.dateOverrides.flatMap((override) =>
            (override.ranges.length === 0
              ? [{ startMinute: null, endMinute: null }]
              : override.ranges
            ).map((range) => ({
              ...owner,
              on_date: override.date,
              start_minute: range.startMinute,
              end_minute: range.endMinute,
            })),
          ),
          (batch) => trx.insertInto('calendar.user_date_overrides').values(batch).execute(),
        );
      }
      await command.emit({
        type: 'calendar.user_availability.updated',
        subject: { kind: 'user', id: userId },
        payload: { reset: profile === null },
      });
      return viewOf(input.membershipId, await readProfile(trx, businessId, userId));
    },
  });
}

/** Reading a person's hours needs the permission that edits them. */
export function userAvailabilityRoutes(options: CalendarOptions): readonly ApiRoute[] {
  const update = updateCalendarUserAvailabilityCommand(options);
  return [
    {
      endpoint: getCalendarUserAvailability,
      async run({ invocation, params }, services) {
        await requirePermission(
          services,
          { name: 'calendar.user_availability.read', permission: 'calendars.manage' },
          invocation,
        );
        const businessId = requireBusiness(invocation.context);
        const { membershipId } = parseInput(getCalendarUserAvailability.params, params);
        return withTenant(services.db, invocation.context, async (trx) => {
          const userId = await memberUserId(options, trx, invocation.context, membershipId);
          return viewOf(membershipId, await readProfile(trx, businessId, userId));
        });
      },
    },
    {
      endpoint: updateCalendarUserAvailability,
      command: update,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          update,
          {
            ...parseInput(updateCalendarUserAvailabilityInput, body),
            ...parseInput(updateCalendarUserAvailability.params, params),
          },
          invocation,
        ),
    },
  ];
}

/**
 * The schedules that can decide bookings between two instants, by user. A person without
 * a stored schedule is absent from the map and follows the calendar's hours. Only the
 * overrides near the window are read: every zone's local date is within a day of the UTC
 * date. Blocked time is not part of a schedule: slots read it as busy time (booking.ts).
 */
export async function readUserAvailabilityProfiles(
  trx: DatabaseTransaction,
  businessId: string,
  userIds: readonly string[],
  window: { readonly from: Date; readonly to: Date },
): Promise<ReadonlyMap<string, UserAvailabilityProfile>> {
  if (userIds.length === 0) return new Map();
  const users = [...new Set(userIds)];
  const schedules = await trx
    .selectFrom('calendar.user_schedules')
    .select(['user_id', 'timezone', 'inherit_calendar_hours'])
    .where('business_id', '=', businessId)
    .where('user_id', 'in', users)
    .execute();
  if (schedules.length === 0) return new Map();
  const stored = schedules.map((schedule) => schedule.user_id);
  const weekly = await trx
    .selectFrom('calendar.user_weekly_hours')
    .select(['user_id', 'weekday', 'start_minute', 'end_minute'])
    .where('business_id', '=', businessId)
    .where('user_id', 'in', stored)
    .execute();
  const day = 86_400_000;
  const overrides = await trx
    .selectFrom('calendar.user_date_overrides')
    .select(['user_id', 'start_minute', 'end_minute'])
    .select(sql<string>`on_date::text`.as('date'))
    .where('business_id', '=', businessId)
    .where('user_id', 'in', stored)
    .where('on_date', '>=', sql<Date>`${utcDate(window.from.getTime() - day)}::date`)
    .where('on_date', '<=', sql<Date>`${utcDate(window.to.getTime() + day)}::date`)
    .execute();
  const weeklyByUser = Map.groupBy(weekly, (row) => row.user_id);
  const overridesByUser = Map.groupBy(overrides, (row) => row.user_id);
  return new Map(
    schedules.map((schedule) => [
      schedule.user_id,
      {
        timezone: schedule.timezone,
        inheritCalendarHours: schedule.inherit_calendar_hours,
        weeklyHours: (weeklyByUser.get(schedule.user_id) ?? []).map((row) => ({
          weekday: row.weekday,
          startMinute: row.start_minute,
          endMinute: row.end_minute,
        })),
        dateOverrides: groupOverrides(overridesByUser.get(schedule.user_id) ?? []),
      },
    ]),
  );
}
