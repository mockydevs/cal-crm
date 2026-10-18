import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation, type Command } from '@repo/commands';
import {
  BOOKABLE_CALENDAR_KINDS,
  CALENDAR_KINDS,
  CALENDAR_LIMITS,
  calendarMemberLocation,
  createCalendarInput,
  deleteCalendar,
  updateCalendarInput,
  updateCalendar,
  updateCalendarAvailability,
  updateCalendarAvailabilityInput,
  type CalendarConfiguration,
  type CalendarKind,
  type CalendarList,
  type CalendarSenderChoices,
  type ListCalendarsQuery,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type DB } from '@repo/db';
import {
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  ConflictError,
  type TenantContext,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import * as z from 'zod';

export interface CalendarOptions {
  readonly business: {
    readonly lockActive: (trx: DatabaseTransaction, context: TenantContext) => Promise<void>;
  };
  readonly timeZones: {
    /** The zone as this server's PostgreSQL spells it, or undefined when it has none. */
    readonly find: (trx: DatabaseTransaction, value: string) => Promise<string | undefined>;
  };
  readonly senders: {
    readonly resolve: (
      trx: DatabaseTransaction,
      context: TenantContext,
      mailboxId: string,
    ) => Promise<string>;
    readonly choices: (
      trx: DatabaseTransaction,
      context: TenantContext,
      input: { after?: string | undefined; limit: number },
    ) => Promise<CalendarSenderChoices>;
    readonly eligible: (
      trx: DatabaseTransaction,
      context: TenantContext,
      accountIds: readonly string[],
    ) => Promise<ReadonlySet<string>>;
  };
  readonly members: {
    readonly resolve: (
      trx: DatabaseTransaction,
      context: TenantContext,
      membershipId: string,
    ) => Promise<string>;
    readonly memberships: (
      trx: DatabaseTransaction,
      context: TenantContext,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
}
const duplicateSlug = explainUniqueViolation({
  calendars_booking_slug_unique: () =>
    new ValidationError([
      {
        path: '/bookingSlug',
        code: 'duplicate',
        message: 'This booking link is already used. Choose another.',
      },
    ]),
});

type CalendarRow = Selectable<DB['calendar.calendars']>;
type Settings = z.output<typeof updateCalendarInput>;
type MemberInput = z.output<typeof createCalendarInput>['members'][number];

const isKind = (kind: string): kind is CalendarKind =>
  (CALENDAR_KINDS as readonly string[]).includes(kind);
function kindOf(row: Pick<CalendarRow, 'kind'>): CalendarKind {
  if (!isKind(row.kind)) throw new Error('Unsupported stored calendar kind.');
  return row.kind;
}
/** Whether a calendar of this type can take bookings at all. */
const isSupported = (kind: CalendarKind): boolean => BOOKABLE_CALENDAR_KINDS.includes(kind);

const publicOrNull = (kind: Parameters<typeof toPublicId>[0], id: string | null): string | null =>
  id === null ? null : toPublicId(kind, id);

/** A calendar's settings as the API shows them, in the order the revision is made from. */
function settingsOf(row: CalendarRow) {
  return {
    name: row.name,
    description: row.description,
    kind: kindOf(row),
    timezone: row.timezone,
    slotMinutes: row.slot_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    maxDaysAhead: row.max_days_ahead,
    bookingSlug: row.booking_slug,
    confirmationSenderId: publicOrNull('mailbox', row.confirmation_account_id),
    isActive: row.is_active,
    groupId: publicOrNull('calendar_group', row.group_id),
    logoFileId: publicOrNull('file', row.logo_file_id),
    inviteTitle: row.invite_title,
    slotIntervalMinutes: row.slot_interval_minutes,
    extraDurationMinutes: row.extra_duration_minutes,
    maxPerDay: row.max_per_day,
    maxPerSlot: row.max_per_slot,
    countAvailableDaysOnly: row.count_available_days_only,
    lookBusyPercent: row.look_busy_percent,
    consentEnabled: row.consent_enabled,
    consentText: row.consent_text,
    botProtection: row.bot_protection === 'altcha' ? ('altcha' as const) : ('off' as const),
    assignContactToMember: row.assign_contact_to_member,
    skipAssignIfOwned: row.skip_assign_if_owned,
    allowReschedule: row.allow_reschedule,
    rescheduleCutoffMinutes: row.reschedule_cutoff_minutes,
    allowCancel: row.allow_cancel,
    cancelCutoffMinutes: row.cancel_cutoff_minutes,
    coverFileId: publicOrNull('file', row.cover_file_id),
    widgetStyle: row.widget_style === 'classic' ? ('classic' as const) : ('neo' as const),
    primaryColor: row.primary_color,
    backgroundColor: row.background_color,
    buttonText: row.button_text,
  };
}

const invalid = (path: string, code: string, message: string) =>
  new ValidationError([{ path, code, message }]);

// A calendar's group, form and pictures are named by id in the body: one that is not this
// business's is a mistake in what was sent, not a missing page.
async function groupFor(
  trx: DatabaseTransaction,
  businessId: string,
  groupId: string | null,
): Promise<string | null> {
  if (groupId === null) return null;
  const found = await trx
    .selectFrom('calendar.calendar_groups')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', parsePublicId('calendar_group', groupId) ?? '')
    .executeTakeFirst();
  if (found === undefined)
    throw invalid('/groupId', 'unknown_group', 'Choose one of this business’s calendar groups.');
  return found.id;
}
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
async function imageFor(
  trx: DatabaseTransaction,
  businessId: string,
  fileId: string | null,
  path: string,
): Promise<string | null> {
  if (fileId === null) return null;
  const file = await trx
    .selectFrom('files.files')
    .select(['id', 'content_type', 'size_bytes'])
    .where('business_id', '=', businessId)
    .where('id', '=', parsePublicId('file', fileId) ?? '')
    .where('deleted_at', 'is', null)
    // A file kept for one purpose, such as a record's document, is no calendar's picture.
    .where('purpose', 'is', null)
    .executeTakeFirst();
  if (file === undefined)
    throw invalid(path, 'unknown_file', 'Upload the picture again: this file is not there.');
  if (!IMAGE_TYPES.includes(file.content_type))
    throw invalid(path, 'image_required', 'Choose a PNG, JPEG, GIF or WebP image.');
  if (Number(file.size_bytes) > CALENDAR_LIMITS.imageBytes)
    throw invalid(path, 'image_too_large', 'Choose a picture of at most 2.5 MB.');
  return file.id;
}

/** The stored columns of a calendar's settings, with what they name checked and resolved. */
async function columnsOf(
  trx: DatabaseTransaction,
  context: TenantContext,
  businessId: string,
  input: Omit<Settings, 'revision'>,
  options: CalendarOptions,
) {
  return {
    name: input.name,
    description: input.description,
    kind: input.kind,
    timezone: input.timezone,
    slot_minutes: input.slotMinutes,
    buffer_before_minutes: input.bufferBeforeMinutes,
    buffer_after_minutes: input.bufferAfterMinutes,
    min_notice_minutes: input.minNoticeMinutes,
    max_days_ahead: input.maxDaysAhead,
    booking_slug: input.bookingSlug,
    confirmation_account_id:
      input.confirmationSenderId === null
        ? null
        : await options.senders.resolve(trx, context, input.confirmationSenderId),
    is_active: input.isActive,
    group_id: await groupFor(trx, businessId, input.groupId),
    logo_file_id: await imageFor(trx, businessId, input.logoFileId, '/logoFileId'),
    invite_title: input.inviteTitle,
    slot_interval_minutes: input.slotIntervalMinutes,
    extra_duration_minutes: input.extraDurationMinutes,
    max_per_day: input.maxPerDay,
    max_per_slot: input.maxPerSlot,
    count_available_days_only: input.countAvailableDaysOnly,
    look_busy_percent: input.lookBusyPercent,
    consent_enabled: input.consentEnabled,
    consent_text: input.consentText,
    bot_protection: input.botProtection,
    assign_contact_to_member: input.assignContactToMember,
    skip_assign_if_owned: input.skipAssignIfOwned,
    allow_reschedule: input.allowReschedule,
    reschedule_cutoff_minutes: input.rescheduleCutoffMinutes,
    allow_cancel: input.allowCancel,
    cancel_cutoff_minutes: input.cancelCutoffMinutes,
    cover_file_id: await imageFor(trx, businessId, input.coverFileId, '/coverFileId'),
    widget_style: input.widgetStyle,
    primary_color: input.primaryColor,
    background_color: input.backgroundColor,
    button_text: input.buttonText,
  };
}

const storedLocations = z.array(calendarMemberLocation).catch([]);

async function insertMembers(
  trx: DatabaseTransaction,
  businessId: string,
  calendar: string,
  members: readonly { userId: string; weight: number; locations: MemberInput['locations'] }[],
): Promise<void> {
  for (const member of members)
    await trx
      .insertInto('calendar.calendar_members')
      .values({
        business_id: businessId,
        calendar_id: calendar,
        user_id: member.userId,
        weight: member.weight,
        locations: JSON.stringify(member.locations),
      })
      .execute();
}

const updateInput = z.strictObject({
  ...updateCalendar.params.shape,
  settings: updateCalendarInput,
});
const availabilityInput = updateCalendarAvailabilityInput.safeExtend(
  updateCalendarAvailability.params.shape,
);
export function updateCalendarAvailabilityCommand(
  options: CalendarOptions,
): Command<typeof availabilityInput, CalendarConfiguration> {
  return defineCommand({
    name: 'calendar.availability.update',
    permission: 'calendars.manage',
    input: availabilityInput,
    async handle(trx, input, command): Promise<CalendarConfiguration> {
      const businessId = requireBusiness(command.context);
      await options.business.lockActive(trx, command.context);
      const uuid = calendarId(input.id);
      const row = await trx
        .selectFrom('calendar.calendars')
        .select('id')
        .where('business_id', '=', businessId)
        .where('id', '=', uuid)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Calendar', input.id);
      const current = await readCalendar(trx, command, input.id, options);
      if (current.revision !== input.revision)
        throw new ConflictError('Calendar changed since you opened it. Reload before saving.');
      // A calendar that takes bookings keeps the team its type needs. A draft, of any type,
      // can be given its team before it can be switched on.
      if (
        current.calendar.isActive &&
        (current.calendar.kind === 'personal'
          ? input.members.length !== 1
          : input.members.length === 0)
      )
        throw new ValidationError([
          {
            path: '/members',
            code: 'members_required',
            message: 'Choose a supported calendar and its business team.',
          },
        ]);
      const members: { userId: string; weight: number; locations: MemberInput['locations'] }[] = [];
      for (const member of [...input.members].sort((a, b) =>
        a.membershipId.localeCompare(b.membershipId),
      ))
        members.push({
          userId: await options.members.resolve(trx, command.context, member.membershipId),
          weight: member.weight,
          locations: member.locations,
        });
      await trx
        .deleteFrom('calendar.calendar_members')
        .where('business_id', '=', businessId)
        .where('calendar_id', '=', uuid)
        .execute();
      await trx
        .deleteFrom('calendar.weekly_hours')
        .where('business_id', '=', businessId)
        .where('calendar_id', '=', uuid)
        .execute();
      await trx
        .deleteFrom('calendar.date_overrides')
        .where('business_id', '=', businessId)
        .where('calendar_id', '=', uuid)
        .execute();
      await insertMembers(trx, businessId, uuid, members);
      for (const hour of input.weeklyHours)
        await trx
          .insertInto('calendar.weekly_hours')
          .values({
            business_id: businessId,
            calendar_id: uuid,
            weekday: hour.weekday,
            start_time: hour.startTime,
            end_time: hour.endTime,
          })
          .execute();
      for (const override of input.dateOverrides)
        for (const range of override.ranges.length === 0
          ? [{ startTime: null, endTime: null }]
          : override.ranges)
          await trx
            .insertInto('calendar.date_overrides')
            .values({
              business_id: businessId,
              calendar_id: uuid,
              on_date: override.date,
              start_time: range.startTime,
              end_time: range.endTime,
            })
            .execute();
      await command.emit({
        type: 'calendar.updated',
        subject: { kind: 'calendar', id: uuid },
        payload: { changed: ['availability'] },
      });
      return readCalendar(trx, command, input.id, options);
    },
  });
}
export function updateCalendarCommand(
  options: CalendarOptions,
): Command<typeof updateInput, CalendarConfiguration> {
  return defineCommand({
    name: 'calendar.update',
    permission: 'calendars.manage',
    input: updateInput,
    audit: ({ id }) => ({ id }),
    async handle(trx, { id, settings: input }, command): Promise<CalendarConfiguration> {
      const businessId = requireBusiness(command.context);
      await options.business.lockActive(trx, command.context);
      const uuid = calendarId(id);
      const row = await trx
        .selectFrom('calendar.calendars')
        .select('id')
        .where('business_id', '=', businessId)
        .where('id', '=', uuid)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Calendar', id);
      const current = await readCalendar(trx, command, id, options);
      if (current.revision !== input.revision)
        throw new ConflictError('Calendar changed since you opened it. Reload before saving.');
      if (input.isActive) {
        const present = current.members.filter((member) => member.membershipId !== null);
        if (!teamCanBook(input.kind, current.members.length, present.length))
          throw new ValidationError([
            {
              path: '/isActive',
              code: 'members_required',
              message: 'Choose this business team before activating the calendar.',
            },
          ]);
        for (const member of current.members)
          if (member.membershipId !== null)
            await options.members.resolve(trx, command.context, member.membershipId);
      }
      const { revision: _revision, ...settings } = input;
      await trx
        .updateTable('calendar.calendars')
        .set(await columnsOf(trx, command.context, businessId, settings, options))
        .where('business_id', '=', businessId)
        .where('id', '=', uuid)
        .execute()
        .catch(duplicateSlug);
      await command.emit({
        type: 'calendar.updated',
        subject: { kind: 'calendar', id: uuid },
        payload: { changed: ['settings'] },
      });
      return readCalendar(trx, command, id, options);
    },
  });
}
/**
 * Whether a calendar has someone to book. A personal calendar is one person, who must be
 * on the business team. A round robin carries on with whoever still is: a member who left
 * stays listed (without a membership) until someone saves the team, and is never offered.
 */
function teamCanBook(kind: string, stored: number, present: number): boolean {
  return kind === 'personal' ? stored === 1 && present === 1 : present > 0;
}
function calendarId(id: string): string {
  const uuid = parsePublicId('calendar', id);
  if (uuid === undefined) throw new NotFoundError('Calendar', id);
  return uuid;
}

const likeOf = (text: string) => `%${text.replaceAll(/[\\%_]/g, (found) => `\\${found}`)}%`;

export async function readCalendars(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: Pick<ListCalendarsQuery, 'limit'> & Partial<ListCalendarsQuery>,
  options: CalendarOptions,
): Promise<CalendarList> {
  const businessId = requireBusiness(invocation.context);
  // Someone who is not on the business team is on no calendar: an empty list, not a refusal.
  const memberUserId =
    input.member === undefined
      ? undefined
      : await options.members
          .resolve(trx, invocation.context, input.member)
          .catch((error: unknown) => {
            if (error instanceof ValidationError || error instanceof NotFoundError) return null;
            throw error;
          });
  const groupUuid =
    input.group === undefined || input.group === 'none'
      ? undefined
      : (parsePublicId('calendar_group', input.group) ?? null);
  let matching = trx
    .selectFrom('calendar.calendars as c')
    .leftJoin('calendar.calendar_groups as g', (join) =>
      join.onRef('g.business_id', '=', 'c.business_id').onRef('g.id', '=', 'c.group_id'),
    )
    .where('c.business_id', '=', businessId);
  if (input.q !== undefined && input.q !== '') {
    const like = likeOf(input.q);
    matching = matching.where((where) =>
      where.or([where('c.name', 'ilike', like), where('g.name', 'ilike', like)]),
    );
  }
  if (input.status !== undefined)
    matching = matching.where('c.is_active', '=', input.status === 'active');
  if (input.kind !== undefined) matching = matching.where('c.kind', '=', input.kind);
  if (input.group === 'none') matching = matching.where('c.group_id', 'is', null);
  else if (groupUuid !== undefined)
    matching = matching.where('c.group_id', groupUuid === null ? 'is' : '=', groupUuid);
  if (input.group !== undefined && input.group !== 'none' && groupUuid === null)
    matching = matching.where(sql<boolean>`false`);
  if (memberUserId === null) matching = matching.where(sql<boolean>`false`);
  else if (memberUserId !== undefined)
    matching = matching.where((where) =>
      where.exists(
        where
          .selectFrom('calendar.calendar_members as m')
          .select('m.user_id')
          .whereRef('m.business_id', '=', 'c.business_id')
          .whereRef('m.calendar_id', '=', 'c.id')
          .where('m.user_id', '=', memberUserId),
      ),
    );
  const counted = await matching
    .select((select) => select.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  let query = matching.selectAll('c').select('g.name as group_name').orderBy('c.id').forShare('c');
  if (input.after !== undefined) query = query.where('c.id', '>', calendarId(input.after));
  const found = await query.limit(input.limit + 1).execute();
  const rows = found.slice(0, input.limit);
  const storedMembers =
    rows.length === 0
      ? []
      : await trx
          .selectFrom('calendar.calendar_members')
          .select(['calendar_id', 'user_id'])
          .where('business_id', '=', businessId)
          .where(
            'calendar_id',
            'in',
            rows.map((row) => row.id),
          )
          .execute();
  const memberships = await options.members.memberships(
    trx,
    invocation.context,
    storedMembers.map((member) => member.user_id),
  );
  const membersByCalendar = Map.groupBy(storedMembers, (member) => member.calendar_id);
  const items: CalendarList['items'] = rows.map((row): CalendarList['items'][number] => {
    const settings = settingsOf(row);
    const members = membersByCalendar.get(row.id) ?? [];
    const supported = isSupported(settings.kind);
    return {
      ...settings,
      id: toPublicId('calendar', row.id),
      groupName: row.group_name,
      supported,
      bookable:
        supported &&
        row.is_active &&
        teamCanBook(
          row.kind,
          members.length,
          members.filter((member) => memberships.has(member.user_id)).length,
        ),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
  const last = rows.at(-1);
  return {
    items,
    nextCursor:
      found.length > input.limit && last !== undefined ? toPublicId('calendar', last.id) : null,
    total: Number(counted.total),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('calendars.manage'),
  };
}
export async function readCalendar(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: CalendarOptions,
): Promise<CalendarConfiguration> {
  const businessId = requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('calendar.calendars')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('id', '=', calendarId(id))
    .forShare()
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Calendar', id);
  const settings = settingsOf(row);
  const group =
    row.group_id === null
      ? undefined
      : await trx
          .selectFrom('calendar.calendar_groups')
          .select('name')
          .where('business_id', '=', businessId)
          .where('id', '=', row.group_id)
          .executeTakeFirst();
  const storedMembers = await trx
    .selectFrom('calendar.calendar_members')
    .select(['user_id', 'weight', 'locations'])
    .where('business_id', '=', businessId)
    .where('calendar_id', '=', row.id)
    .orderBy('user_id')
    .execute();
  const memberships = await options.members.memberships(
    trx,
    invocation.context,
    storedMembers.map((member) => member.user_id),
  );
  const members = storedMembers.map((member) => ({
    membershipId: memberships.get(member.user_id) ?? null,
    weight: member.weight,
    locations: storedLocations.parse(member.locations),
  }));
  const hours = await trx
    .selectFrom('calendar.weekly_hours')
    .select(['weekday', 'start_time', 'end_time'])
    .where('business_id', '=', businessId)
    .where('calendar_id', '=', row.id)
    .orderBy('weekday')
    .orderBy('start_time')
    .execute();
  const weeklyHours = hours.map((hour) => ({
    weekday: hour.weekday,
    startTime: hour.start_time.slice(0, 5),
    endTime: hour.end_time.slice(0, 5),
  }));
  const overrides = await trx
    .selectFrom('calendar.date_overrides')
    .select(['start_time', 'end_time'])
    .select(sql<string>`on_date::text`.as('date'))
    .where('business_id', '=', businessId)
    .where('calendar_id', '=', row.id)
    .orderBy('on_date')
    .orderBy('start_time')
    .execute();
  const dateOverrides = [...Map.groupBy(overrides, (item) => item.date)].map(([date, items]) => ({
    date,
    ranges: items.flatMap((item) =>
      item.start_time === null || item.end_time === null
        ? []
        : [{ startTime: item.start_time.slice(0, 5), endTime: item.end_time.slice(0, 5) }],
    ),
  }));
  const supported = isSupported(settings.kind);
  return {
    calendar: {
      ...settings,
      id: toPublicId('calendar', row.id),
      groupName: group?.name ?? null,
      supported,
      bookable:
        supported &&
        row.is_active &&
        teamCanBook(
          row.kind,
          members.length,
          members.filter((member) => member.membershipId !== null).length,
        ),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    },
    members,
    weeklyHours,
    dateOverrides,
    revision: createHash('sha256')
      .update(JSON.stringify([settings, storedMembers, weeklyHours, dateOverrides]))
      .digest('hex'),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('calendars.manage'),
  };
}
export function createCalendarCommand(
  options: CalendarOptions,
): Command<typeof createCalendarInput, CalendarConfiguration> {
  return defineCommand({
    name: 'calendar.create',
    permission: 'calendars.manage',
    input: createCalendarInput,
    async handle(trx, input, command): Promise<CalendarConfiguration> {
      const businessId = requireBusiness(command.context);
      await options.business.lockActive(trx, command.context);
      const { members: chosen, weeklyHours, dateOverrides, ...settings } = input;
      const columns = await columnsOf(trx, command.context, businessId, settings, options);
      // Only people on this business's team: the port refuses anyone else.
      const members = await Promise.all(
        chosen.map(async (member) => ({
          userId: await options.members.resolve(trx, command.context, member.membershipId),
          weight: member.weight,
          locations: member.locations,
        })),
      );
      const row = await trx
        .insertInto('calendar.calendars')
        .values({ business_id: businessId, ...columns })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch(duplicateSlug);
      await insertMembers(trx, businessId, row.id, members);
      for (const hour of weeklyHours)
        await trx
          .insertInto('calendar.weekly_hours')
          .values({
            business_id: businessId,
            calendar_id: row.id,
            weekday: hour.weekday,
            start_time: hour.startTime,
            end_time: hour.endTime,
          })
          .execute();
      for (const override of dateOverrides) {
        const ranges =
          override.ranges.length === 0 ? [{ startTime: null, endTime: null }] : override.ranges;
        for (const range of ranges) {
          await trx
            .insertInto('calendar.date_overrides')
            .values({
              business_id: businessId,
              calendar_id: row.id,
              on_date: override.date,
              start_time: range.startTime,
              end_time: range.endTime,
            })
            .execute();
        }
      }
      await command.emit({ type: 'calendar.created', subject: { kind: 'calendar', id: row.id } });
      return readCalendar(trx, command, toPublicId('calendar', row.id), options);
    },
  });
}

/**
 * Deletes a calendar nobody was ever booked on. One with appointments stays: they are the
 * record of what was booked, so the calendar is made inactive instead.
 */
export function deleteCalendarCommand(
  options: CalendarOptions,
): Command<typeof deleteCalendar.params, undefined> {
  return defineCommand({
    name: 'calendar.delete',
    permission: 'calendars.manage',
    input: deleteCalendar.params,
    async handle(trx, input, command): Promise<undefined> {
      const businessId = requireBusiness(command.context);
      await options.business.lockActive(trx, command.context);
      const uuid = calendarId(input.id);
      const row = await trx
        .selectFrom('calendar.calendars')
        .select(['id', 'name'])
        .where('business_id', '=', businessId)
        .where('id', '=', uuid)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Calendar', input.id);
      const booked = await trx
        .selectFrom('calendar.appointments')
        .select('id')
        .where('business_id', '=', businessId)
        .where('calendar_id', '=', uuid)
        .limit(1)
        .executeTakeFirst();
      if (booked !== undefined)
        throw new ConflictError(
          `"${row.name}" has appointments, so it can't be deleted. Make it inactive instead.`,
        );
      await trx
        .deleteFrom('calendar.calendars')
        .where('business_id', '=', businessId)
        .where('id', '=', uuid)
        .execute();
      await command.emit({
        type: 'calendar.deleted',
        subject: { kind: 'calendar', id: uuid },
        payload: { name: row.name },
      });
      return undefined;
    },
  });
}
