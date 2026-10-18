// Calendar groups: a business sorts its calendars into named groups. A calendar is in one
// group or none; deleting a group leaves its calendars.
import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Command,
  type Invocation,
} from '@repo/commands';
import {
  CALENDAR_LIMITS,
  calendarGroupInput,
  createCalendarGroup,
  deleteCalendarGroup,
  listCalendarGroups,
  parseInput,
  renameCalendarGroup,
  type CalendarGroup,
  type CalendarGroupList,
} from '@repo/contracts';
import { explainUniqueViolation, withTenant, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

const duplicateName = explainUniqueViolation({
  calendar_groups_name_unique: () =>
    new ValidationError([
      { path: '/name', code: 'duplicate', message: 'Another group already has this name.' },
    ]),
});

interface GroupRow {
  readonly id: string;
  readonly name: string;
  readonly calendars: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}
const asGroup = (row: GroupRow): CalendarGroup => ({
  id: toPublicId('calendar_group', row.id),
  name: row.name,
  calendarCount: row.calendars,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const groupRows = (trx: DatabaseTransaction, businessId: string, id?: string) =>
  sql<GroupRow>`
    select g.id, g.name, g.created_at, g.updated_at,
           (select count(*)::int from calendar.calendars c
             where c.business_id = g.business_id and c.group_id = g.id) as calendars
    from calendar.calendar_groups g
    where g.business_id = ${businessId} and (${id ?? null}::uuid is null or g.id = ${id ?? null}::uuid)
    order by lower(btrim(g.name)), g.id
  `.execute(trx);

async function groupOf(
  trx: DatabaseTransaction,
  businessId: string,
  publicId: string,
): Promise<GroupRow> {
  const id = parsePublicId('calendar_group', publicId);
  const [row] = id === undefined ? [] : (await groupRows(trx, businessId, id)).rows;
  if (row === undefined) throw new NotFoundError('Calendar group', publicId);
  return row;
}

/** The groups by name, with how many calendars each holds and how many are in none. */
export async function readCalendarGroups(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<CalendarGroupList> {
  const businessId = requireBusiness(invocation.context);
  const { rows } = await groupRows(trx, businessId);
  const counted = await sql<{ total: number; ungrouped: number }>`
    select count(*)::int as total, (count(*) filter (where group_id is null))::int as ungrouped
    from calendar.calendars where business_id = ${businessId}
  `.execute(trx);
  return {
    items: rows.map(asGroup),
    ungroupedCount: counted.rows[0]?.ungrouped ?? 0,
    calendarCount: counted.rows[0]?.total ?? 0,
    canManage: invocation.permissions === 'all' || invocation.permissions.has('calendars.manage'),
  };
}

export const createCalendarGroupCommand: Command<typeof calendarGroupInput, CalendarGroup> =
  defineCommand({
    name: 'calendar_group.create',
    permission: 'calendars.manage',
    input: calendarGroupInput,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      // The rows are locked by the business they are all of, so two at once count the same.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`calendar-groups:${businessId}`}, 0))`.execute(
        trx,
      );
      const existing = await sql<{ groups: number }>`
        select count(*)::int as groups from calendar.calendar_groups where business_id = ${businessId}
      `.execute(trx);
      if ((existing.rows[0]?.groups ?? 0) >= CALENDAR_LIMITS.groups)
        throw new ValidationError([
          {
            path: '/name',
            code: 'too_many_groups',
            message: 'A business can have 100 calendar groups. Delete one first.',
          },
        ]);
      const row = await trx
        .insertInto('calendar.calendar_groups')
        .values({ business_id: businessId, name: input.name })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch(duplicateName);
      await command.emit({
        type: 'calendar_group.created',
        subject: { kind: 'calendar_group', id: row.id },
        payload: { name: input.name },
      });
      return asGroup(await groupOf(trx, businessId, toPublicId('calendar_group', row.id)));
    },
  });

const renameInput = z.strictObject({
  ...renameCalendarGroup.params.shape,
  ...calendarGroupInput.shape,
});
export const renameCalendarGroupCommand: Command<typeof renameInput, CalendarGroup> = defineCommand(
  {
    name: 'calendar_group.rename',
    permission: 'calendars.manage',
    input: renameInput,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const group = await groupOf(trx, businessId, input.groupId);
      await trx
        .updateTable('calendar.calendar_groups')
        .set({ name: input.name })
        .where('business_id', '=', businessId)
        .where('id', '=', group.id)
        .execute()
        .catch(duplicateName);
      await command.emit({
        type: 'calendar_group.renamed',
        subject: { kind: 'calendar_group', id: group.id },
        payload: { name: input.name },
      });
      return asGroup(await groupOf(trx, businessId, input.groupId));
    },
  },
);

export const deleteCalendarGroupCommand: Command<typeof deleteCalendarGroup.params, undefined> =
  defineCommand({
    name: 'calendar_group.delete',
    permission: 'calendars.manage',
    input: deleteCalendarGroup.params,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const group = await groupOf(trx, businessId, input.groupId);
      // Its calendars stay, in no group: the foreign key lets go of them.
      await trx
        .deleteFrom('calendar.calendar_groups')
        .where('business_id', '=', businessId)
        .where('id', '=', group.id)
        .execute();
      await command.emit({
        type: 'calendar_group.deleted',
        subject: { kind: 'calendar_group', id: group.id },
        payload: { name: group.name, calendars: group.calendars },
      });
      return undefined;
    },
  });

export const calendarGroupRoutes: readonly ApiRoute[] = [
  {
    endpoint: listCalendarGroups,
    run: ({ invocation }, { db }) =>
      withTenant(db, invocation.context, (trx) => readCalendarGroups(trx, invocation)),
  },
  {
    endpoint: createCalendarGroup,
    command: createCalendarGroupCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createCalendarGroupCommand, body, invocation),
  },
  {
    endpoint: renameCalendarGroup,
    command: renameCalendarGroupCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        renameCalendarGroupCommand,
        {
          ...parseInput(calendarGroupInput, body),
          ...parseInput(renameCalendarGroup.params, params),
        },
        invocation,
      ),
  },
  {
    endpoint: deleteCalendarGroup,
    command: deleteCalendarGroupCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        deleteCalendarGroupCommand,
        parseInput(deleteCalendarGroup.params, params),
        invocation,
      ),
  },
];
