import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  calendarConfiguration,
  calendarGroup,
  calendarGroupList,
  calendarHours,
  calendarList,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  toPublicId,
  parsePublicId,
  ConflictError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '@repo/kernel';
import { findTimeZone } from '@repo/module-crm';
import {
  resolveCalendarMember,
  readCalendarMemberMemberships,
  lockActiveBusiness,
} from '@repo/module-tenancy';
import {
  resolveCalendarSender,
  readCalendarSenderChoices,
  readEligibleCalendarSenders,
} from '@repo/module-messaging';
import {
  createSealingVault,
  newSecretsKey,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createCalendarRoutes } from './index.js';

it('refuses sender metadata before querying a locked mailbox table when calendar management is absent', async () => {
  const ours = await fixture();
  const acquired = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const holding = database.as('crm_owner', async (sql) => {
    await sql.query('lock table messaging.channel_accounts in access exclusive mode');
    acquired.resolve(undefined);
    await release.promise;
  });
  await acquired.promise;
  const request = call('listCalendarSenders', { ...ours.invocation, permissions: new Set() }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    expect(await Promise.race([request, delay(1500, 'queried_before_permission')])).toBeInstanceOf(
      ForbiddenError,
    );
  } finally {
    release.resolve(undefined);
    await Promise.all([holding, request]);
  }
});

it('refuses every configuration mutation when its business is suspended before calendar locks or writes', async () => {
  const { invocation } = await fixture();
  const settings = { name: 'Draft', kind: 'personal', timezone: 'UTC', bookingSlug: 'draft' };
  const availability = { members: [], weeklyHours: [], dateOverrides: [] };
  const saved = calendarConfiguration.parse(
    await call('createCalendar', invocation, { body: { ...settings, ...availability } }),
  );
  await database.withTenant(invocation.context, (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=app.business_id()"),
  );
  for (const [operation, body] of [
    ['createCalendar', { ...settings, bookingSlug: 'blocked', ...availability }],
    ['updateCalendar', { ...settings, name: 'Blocked', revision: saved.revision }],
    ['updateCalendarAvailability', { ...availability, revision: saved.revision }],
  ] as const)
    await expect(
      call(operation, invocation, { id: saved.calendar.id, body }),
    ).rejects.toBeInstanceOf(NotFoundError);
  const rows = await database.withTenant(invocation.context, (sql) =>
    sql.query('select name from calendar.calendars'),
  );
  expect(rows).toEqual([{ name: 'Draft' }]);
});

it('requires an explicit eligible sender for public bookability and restricts sender choices to calendar managers', async () => {
  const ours = await fixture();
  const other = await fixture();
  const settings = {
    name: 'Tours',
    kind: 'personal',
    timezone: 'UTC',
    bookingSlug: 'tours',
    isActive: true,
  };
  const saved = calendarConfiguration.parse(
    await call('createCalendar', ours.invocation, {
      body: { ...settings, members: [ours.member], weeklyHours: [], dateOverrides: [] },
    }),
  );
  // A sender is not needed to take bookings: without one, nothing is emailed.
  expect(saved.calendar).toMatchObject({
    isActive: true,
    bookable: true,
    confirmationSenderId: null,
  });
  const sender = await senderFor(ours.invocation);
  const foreign = await senderFor(other.invocation);
  await expect(
    call('updateCalendar', ours.invocation, {
      id: saved.calendar.id,
      body: { ...settings, confirmationSenderId: foreign, revision: saved.revision },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  const selected = calendarConfiguration.parse(
    await call('updateCalendar', ours.invocation, {
      id: saved.calendar.id,
      body: { ...settings, confirmationSenderId: sender, revision: saved.revision },
    }),
  );
  expect(selected.calendar).toMatchObject({
    isActive: true,
    bookable: true,
    confirmationSenderId: sender,
  });
  const choices = await call('listCalendarSenders', ours.invocation);
  expect(choices).toEqual({
    items: [{ id: sender, name: 'Bookings', email: 'bookings@example.test' }],
    nextCursor: null,
  });
  await expect(
    call('listCalendarSenders', { ...ours.invocation, permissions: new Set() }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const accountId = parsePublicId('mailbox', sender);
  await database.withTenant(ours.invocation.context, (sql) =>
    sql.query("update messaging.channel_accounts set status='paused' where id=$1", [accountId]),
  );
  expect(
    calendarConfiguration.parse(
      await call('getCalendar', ours.invocation, { id: saved.calendar.id }),
    ).calendar,
  ).toMatchObject({ isActive: true, bookable: true, confirmationSenderId: sender });
  expect(calendarList.parse(await call('listCalendars', ours.invocation)).items[0]).toMatchObject({
    isActive: true,
    bookable: true,
  });
  expect(await call('listCalendarSenders', ours.invocation)).toEqual({
    items: [],
    nextCursor: null,
  });
});

it('refuses invalid ranges and unsupported dates without creating or changing a calendar', async () => {
  const { invocation } = await fixture();
  const body = {
    name: 'Hours',
    kind: 'personal',
    timezone: 'UTC',
    bookingSlug: 'hours',
    members: [],
    weeklyHours: [],
    dateOverrides: [],
  };
  await expect(
    call('createCalendar', invocation, {
      body: { ...body, weeklyHours: [{ weekday: 1, startTime: '17:00', endTime: '09:00' }] },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('createCalendar', invocation, {
      body: { ...body, dateOverrides: [{ date: '0000-01-01', ranges: [] }] },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(calendarList.parse(await call('listCalendars', invocation)).items).toEqual([]);
  const saved = calendarConfiguration.parse(await call('createCalendar', invocation, { body }));
  await expect(
    call('updateCalendarAvailability', invocation, {
      id: saved.calendar.id,
      body: {
        members: [],
        weeklyHours: [
          { weekday: 1, startTime: '09:00', endTime: '12:00' },
          { weekday: 1, startTime: '11:00', endTime: '13:00' },
        ],
        dateOverrides: [],
        revision: saved.revision,
      },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(
    calendarConfiguration.parse(await call('getCalendar', invocation, { id: saved.calendar.id }))
      .revision,
  ).toBe(saved.revision);
});

it('keeps legacy and revoked-team state truthful while refusing invalid activation', async () => {
  const { invocation, member } = await fixture();
  const saved = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: {
        name: 'Legacy',
        kind: 'personal',
        timezone: 'UTC',
        bookingSlug: 'legacy',
        isActive: true,
        members: [member],
        weeklyHours: [],
        dateOverrides: [],
      },
    }),
  );
  await expect(
    call('updateCalendarAvailability', invocation, {
      id: saved.calendar.id,
      body: { members: [], weeklyHours: [], dateOverrides: [], revision: saved.revision },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where id=$1', [
      parsePublicId('membership', member.membershipId),
    ]),
  );
  const revoked = calendarConfiguration.parse(
    await call('getCalendar', invocation, { id: saved.calendar.id }),
  );
  expect(revoked.calendar).toMatchObject({ isActive: true, supported: true, bookable: false });
  expect(revoked.members).toEqual([{ membershipId: null, weight: 1, locations: [] }]);
  expect(revoked.revision).toBe(saved.revision);
  await database.as('crm_owner', (sql) =>
    sql.query("update calendar.calendars set kind='collective' where id=$1", [
      parsePublicId('calendar', saved.calendar.id),
    ]),
  );
  const legacy = calendarConfiguration.parse(
    await call('getCalendar', invocation, { id: saved.calendar.id }),
  );
  expect(legacy.calendar).toMatchObject({
    kind: 'collective',
    isActive: true,
    supported: false,
    bookable: false,
  });
  const list = calendarList.parse(await call('listCalendars', invocation));
  expect(list.items[0]).toMatchObject({
    kind: 'collective',
    isActive: true,
    supported: false,
    bookable: false,
  });
  await expect(
    call('updateCalendarAvailability', invocation, {
      id: saved.calendar.id,
      body: { members: [member], weeklyHours: [], dateOverrides: [], revision: legacy.revision },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('activates personal and weighted round-robin drafts only with eligible business members', async () => {
  const { invocation, member } = await fixture();
  const confirmationSenderId = await senderFor(invocation);
  const reader: Invocation = { ...invocation, permissions: new Set() };
  expect(calendarList.parse(await call('listCalendars', reader)).items).toEqual([]);
  const settings = {
    name: 'Tours',
    kind: 'personal',
    timezone: 'UTC',
    bookingSlug: 'tours',
    isActive: false,
    confirmationSenderId,
  };
  const draft = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: { ...settings, members: [member], weeklyHours: [], dateOverrides: [] },
    }),
  );
  const active = calendarConfiguration.parse(
    await call('updateCalendar', invocation, {
      id: draft.calendar.id,
      body: { ...settings, isActive: true, revision: draft.revision },
    }),
  );
  expect(active.calendar.bookable).toBe(true);
  expect(calendarList.parse(await call('listCalendars', reader)).items[0]?.bookable).toBe(true);
  const rrSettings = {
    ...settings,
    name: 'Team tours',
    kind: 'round_robin',
    bookingSlug: 'team-tours',
  };
  const rr = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: { ...rrSettings, members: [], weeklyHours: [], dateOverrides: [] },
    }),
  );
  await expect(
    call('updateCalendar', invocation, {
      id: rr.calendar.id,
      body: { ...rrSettings, isActive: true, revision: rr.revision },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  const assigned = calendarConfiguration.parse(
    await call('updateCalendarAvailability', invocation, {
      id: rr.calendar.id,
      body: {
        members: [{ ...member, weight: 3 }],
        weeklyHours: [],
        dateOverrides: [],
        revision: rr.revision,
      },
    }),
  );
  const rrActive = calendarConfiguration.parse(
    await call('updateCalendar', invocation, {
      id: rr.calendar.id,
      body: { ...rrSettings, isActive: true, revision: assigned.revision },
    }),
  );
  expect(rrActive.calendar.bookable).toBe(true);
  expect(
    calendarList.parse(await call('listCalendars', reader)).items.every((item) => item.bookable),
  ).toBe(true);
  await expect(
    call('updateCalendarAvailability', invocation, {
      id: rr.calendar.id,
      body: { members: [], weeklyHours: [], dateOverrides: [], revision: rrActive.revision },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where id=$1', [
      parsePublicId('membership', member.membershipId),
    ]),
  );
  await expect(
    call('updateCalendar', invocation, {
      id: draft.calendar.id,
      body: { ...settings, isActive: true, revision: active.revision },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('paginates calendars without disclosing another business calendar', async () => {
  const ours = await fixture();
  const other = await fixture();
  const create = async (invocation: Invocation, name: string) =>
    calendarConfiguration.parse(
      await call('createCalendar', invocation, {
        body: {
          name,
          kind: 'personal',
          timezone: 'UTC',
          bookingSlug: name.toLowerCase(),
          members: [],
          weeklyHours: [],
          dateOverrides: [],
        },
      }),
    );
  const first = await create(ours.invocation, 'First');
  const second = await create(ours.invocation, 'Second');
  await create(other.invocation, 'Hidden');
  const page = calendarList.parse(
    await call('listCalendars', ours.invocation, { query: { limit: 1 } }),
  );
  expect(page.items.map((item) => item.id)).toEqual([first.calendar.id]);
  expect(page.nextCursor).toBe(first.calendar.id);
  const next = calendarList.parse(
    await call('listCalendars', ours.invocation, { query: { limit: 1, after: page.nextCursor } }),
  );
  expect(next.items.map((item) => item.id)).toEqual([second.calendar.id]);
  expect(next.nextCursor).toBeNull();
});

let database: TestDatabase;
let db: Database;
let services: Services;
let vault: SealingVault;
const routes = createCalendarRoutes({
  members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
  business: { lockActive: lockActiveBusiness },
  timeZones: { find: findTimeZone },
  senders: {
    resolve: resolveCalendarSender,
    choices: readCalendarSenderChoices,
    eligible: readEligibleCalendarSenders,
  },
});

it('guards every configuration endpoint by business and every write by permission', async () => {
  const ours = await fixture();
  const other = await fixture();
  const body = {
    name: 'Private',
    kind: 'personal',
    timezone: 'UTC',
    bookingSlug: 'private',
    members: [ours.member],
    weeklyHours: [],
    dateOverrides: [],
  };
  const saved = calendarConfiguration.parse(
    await call('createCalendar', ours.invocation, { body }),
  );
  for (const operation of [
    'getCalendar',
    'getCalendarAvailability',
    'updateCalendar',
    'updateCalendarAvailability',
  ]) {
    await expect(
      call(operation, other.invocation, {
        id: saved.calendar.id,
        query: { date: '2026-12-25' },
        body: { ...body, revision: saved.revision },
      }),
    ).rejects.toBeInstanceOf(
      operation === 'updateCalendarAvailability' || operation === 'updateCalendar'
        ? ValidationError
        : NotFoundError,
    );
  }
  const reader: Invocation = { ...ours.invocation, permissions: new Set() };
  const read = calendarConfiguration.parse(
    await call('getCalendar', reader, { id: saved.calendar.id }),
  );
  expect(read.canManage).toBe(false);
  await expect(
    call('createCalendar', reader, { body: { ...body, bookingSlug: 'denied' } }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const { members, weeklyHours, dateOverrides, ...settings } = body;
  await expect(
    call('updateCalendar', reader, {
      id: saved.calendar.id,
      body: { ...settings, revision: saved.revision },
    }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('updateCalendarAvailability', reader, {
      id: saved.calendar.id,
      body: { members, weeklyHours, dateOverrides, revision: saved.revision },
    }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('updateCalendar', other.invocation, {
      id: saved.calendar.id,
      body: { ...settings, revision: saved.revision },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('updateCalendarAvailability', other.invocation, {
      id: saved.calendar.id,
      body: { members: [other.member], weeklyHours, dateOverrides, revision: saved.revision },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('reports a duplicate booking slug as a field validation error', async () => {
  const { invocation } = await fixture();
  const body = {
    name: 'Consultation',
    kind: 'personal',
    timezone: 'UTC',
    bookingSlug: 'consultation',
    members: [],
    weeklyHours: [],
    dateOverrides: [],
  };
  await call('createCalendar', invocation, { body });
  await expect(call('createCalendar', invocation, { body })).rejects.toBeInstanceOf(
    ValidationError,
  );
});

it('allows only one concurrent settings writer for the same revision', async () => {
  const { invocation } = await fixture();
  const settings = { name: 'Tour', kind: 'personal', timezone: 'UTC', bookingSlug: 'tour' };
  const saved = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: { ...settings, members: [], weeklyHours: [], dateOverrides: [] },
    }),
  );
  const results = await Promise.allSettled(
    ['First', 'Second'].map((name) =>
      call('updateCalendar', invocation, {
        id: saved.calendar.id,
        body: { ...settings, name, revision: saved.revision },
      }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  for (const result of results)
    if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictError);
});

it('saves settings atomically and refuses an editor with a stale revision', async () => {
  const { invocation } = await fixture();
  const settings = {
    name: 'Consultation',
    kind: 'personal',
    timezone: 'Africa/Nairobi',
    bookingSlug: 'consultation',
    isActive: false,
  };
  const original = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: { ...settings, members: [], weeklyHours: [], dateOverrides: [] },
    }),
  );
  const changed = calendarConfiguration.parse(
    await call('updateCalendar', invocation, {
      id: original.calendar.id,
      body: { ...settings, name: 'Venue tour', revision: original.revision },
    }),
  );
  expect(changed.calendar.name).toBe('Venue tour');
  expect(changed.revision).not.toBe(original.revision);
  await expect(
    call('updateCalendar', invocation, {
      id: original.calendar.id,
      body: { ...settings, name: 'Stale edit', revision: original.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  const persisted = calendarConfiguration.parse(
    await call('getCalendar', invocation, { id: original.calendar.id }),
  );
  expect(persisted.calendar.name).toBe('Venue tour');
});
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const keys = await newSecretsKey(1);
  vault = await createSealingVault(parseSecretsPublicKey(keys.publicKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const membership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      "with role as (insert into tenancy.roles (agency_id,scope,key,name) values ($1,'business','member','Member') returning id) insert into tenancy.memberships (agency_id,business_id,user_id,role_id) select $1,$2,$3,id from role returning id",
      [agency.id, business.id, user.id],
    ),
  );
  const invocation: Invocation = {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: 'all',
  };
  return {
    invocation,
    member: { membershipId: toPublicId('membership', membership.id), weight: 1 },
  };
}
async function senderFor(invocation: Invocation): Promise<string> {
  const businessId = invocation.context.businessId;
  if (businessId === undefined) throw new Error('Missing sender fixture business.');
  const secretId = await withTenant(db, invocation.context, (trx) =>
    vault.store(
      trx,
      { agencyId: invocation.context.agencyId, businessId, purpose: 'mailbox.credentials' },
      'sealed metadata fixture; never dispatched',
    ),
  );
  const account = await database.withTenant(invocation.context, async (sql) => {
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Bookings') returning id",
    );
    await sql.query(
      `insert into messaging.mailboxes(business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,use_for_conversations)
      values(app.business_id(),$1,'bookings@example.test','password','localhost',1025,'none','fixture',$2,true)`,
      [account.id, secretId],
    );
    return account;
  });
  return toPublicId('mailbox', account.id);
}
async function call(
  operationId: string,
  invocation: Invocation,
  request: { body?: unknown; id?: string; query?: unknown; params?: unknown } = {},
) {
  const route = routes.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.params ?? (request.id === undefined ? {} : { id: request.id }),
      body: request.body,
      query: request.query ?? {},
    },
    services,
  );
}

it('date overrides replace weekly hours, including closing a normally open day', async () => {
  const { invocation, member } = await fixture();
  const saved = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: {
        name: 'Consultation',
        kind: 'personal',
        timezone: 'Africa/Nairobi',
        bookingSlug: 'consultation',
        isActive: true,
        members: [member],
        weeklyHours: [{ weekday: 5, startTime: '09:00', endTime: '17:00' }],
        dateOverrides: [
          { date: '2026-12-25', ranges: [] },
          { date: '2027-01-01', ranges: [{ startTime: '10:00', endTime: '12:00' }] },
        ],
      },
    }),
  );
  const hours = async (date: string) =>
    calendarHours.parse(
      await call('getCalendarAvailability', invocation, { id: saved.calendar.id, query: { date } }),
    );
  expect(await hours('2026-12-25')).toEqual({
    date: '2026-12-25',
    timezone: 'Africa/Nairobi',
    source: 'override',
    ranges: [],
  });
  expect((await hours('2027-01-01')).ranges).toEqual([{ startTime: '10:00', endTime: '12:00' }]);
  expect((await hours('2027-01-08')).ranges).toEqual([{ startTime: '09:00', endTime: '17:00' }]);
});

it('changes availability atomically, rejects stale revisions and keeps foreign members out', async () => {
  const ours = await fixture();
  const other = await fixture();
  const original = calendarConfiguration.parse(
    await call('createCalendar', ours.invocation, {
      body: {
        name: 'Tour',
        kind: 'personal',
        timezone: 'UTC',
        bookingSlug: 'tour',
        isActive: true,
        members: [ours.member],
        weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
        dateOverrides: [],
      },
    }),
  );
  const replacement = {
    members: [ours.member],
    weeklyHours: [{ weekday: 2, startTime: '10:00', endTime: '12:00' }],
    dateOverrides: [{ date: '2026-12-25', ranges: [] }],
  };
  const changed = calendarConfiguration.parse(
    await call('updateCalendarAvailability', ours.invocation, {
      id: original.calendar.id,
      body: { ...replacement, revision: original.revision },
    }),
  );
  expect(changed.weeklyHours).toEqual(replacement.weeklyHours);
  expect(changed.dateOverrides).toEqual(replacement.dateOverrides);
  await expect(
    call('updateCalendarAvailability', ours.invocation, {
      id: original.calendar.id,
      body: { ...replacement, weeklyHours: [], revision: original.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call('updateCalendarAvailability', ours.invocation, {
      id: original.calendar.id,
      body: { ...replacement, members: [other.member], revision: changed.revision },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  const persisted = calendarConfiguration.parse(
    await call('getCalendar', ours.invocation, { id: original.calendar.id }),
  );
  expect(persisted.revision).toBe(changed.revision);
  expect(persisted.members).toEqual([{ ...ours.member, locations: [] }]);
});

it('persists explicit opening ranges when creating a calendar with a date override', async () => {
  const ours = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const dateOverrides = [{ date, ranges: [{ startTime: '10:00', endTime: '12:00' }] }];
  const saved = calendarConfiguration.parse(
    await call('createCalendar', ours.invocation, {
      body: {
        name: 'Special opening',
        kind: 'personal',
        timezone: 'UTC',
        bookingSlug: 'special-opening',
        members: [ours.member],
        weeklyHours: [],
        dateOverrides,
      },
    }),
  );
  expect(saved.weeklyHours).toEqual([]);
  expect(saved.dateOverrides).toEqual(dateOverrides);
  expect(
    calendarConfiguration.parse(
      await call('getCalendar', ours.invocation, { id: saved.calendar.id }),
    ),
  ).toEqual(saved);
  expect(
    await database.withTenant(ours.invocation.context, (sql) =>
      sql.query<{ start_time: string; end_time: string }>(
        'select start_time,end_time from calendar.date_overrides',
      ),
    ),
  ).toEqual([{ start_time: '10:00:00', end_time: '12:00:00' }]);
});

it('replaces a closed date override with explicit opening ranges through the revision-checked availability command', async () => {
  const ours = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const saved = calendarConfiguration.parse(
    await call('createCalendar', ours.invocation, {
      body: {
        name: 'Special opening',
        kind: 'personal',
        timezone: 'UTC',
        bookingSlug: 'changed-opening',
        members: [ours.member],
        weeklyHours: [],
        dateOverrides: [{ date, ranges: [] }],
      },
    }),
  );
  const dateOverrides = [{ date, ranges: [{ startTime: '14:00', endTime: '16:00' }] }];
  const changed = calendarConfiguration.parse(
    await call('updateCalendarAvailability', ours.invocation, {
      id: saved.calendar.id,
      body: { members: [ours.member], weeklyHours: [], dateOverrides, revision: saved.revision },
    }),
  );
  expect(changed.dateOverrides).toEqual(dateOverrides);
  expect(changed.revision).not.toBe(saved.revision);
  expect(
    calendarConfiguration.parse(
      await call('getCalendar', ours.invocation, { id: saved.calendar.id }),
    ),
  ).toEqual(changed);
  expect(
    await database.withTenant(ours.invocation.context, (sql) =>
      sql.query<{ start_time: string; end_time: string }>(
        'select start_time,end_time from calendar.date_overrides',
      ),
    ),
  ).toEqual([{ start_time: '14:00:00', end_time: '16:00:00' }]);
});

// Settings → Calendars as GoHighLevel's: what the "New calendar" form and its editor hold,
// groups, the list's search and filters, and deleting.
const draftOf = (slug: string, changed: Record<string, unknown> = {}) => ({
  name: 'Strategy call',
  kind: 'personal',
  timezone: 'UTC',
  bookingSlug: slug,
  members: [],
  weeklyHours: [],
  dateOverrides: [],
  ...changed,
});

it('saves and reads back everything the editor holds, and refuses a save made from an older reading', async () => {
  const { invocation, member } = await fixture();
  const group = calendarGroup.parse(
    await call('createCalendarGroup', invocation, { body: { name: 'Sales calls' } }),
  );
  const everything = {
    groupId: group.id,
    inviteTitle: 'Strategy call with {{contact.name}}',
    slotMinutes: 45,
    slotIntervalMinutes: 15,
    extraDurationMinutes: [60, 90],
    maxPerDay: 6,
    maxPerSlot: 2,
    countAvailableDaysOnly: true,
    lookBusyPercent: 20,
    consentEnabled: true,
    consentText: 'I agree to be contacted about my booking.',
    assignContactToMember: false,
    skipAssignIfOwned: true,
    allowReschedule: true,
    rescheduleCutoffMinutes: 120,
    allowCancel: false,
    cancelCutoffMinutes: null,
    widgetStyle: 'classic',
    primaryColor: '#0a7d4f',
    backgroundColor: '#fafafaff',
    buttonText: 'Book my call',
  };
  const place = { kind: 'custom', value: '12 Harbor Road', label: 'Studio' };
  const saved = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: draftOf('strategy', {
        ...everything,
        members: [{ ...member, locations: [place, { kind: 'phone', value: '+13055550123' }] }],
      }),
    }),
  );
  expect(saved.calendar).toMatchObject({
    ...everything,
    groupName: 'Sales calls',
    isActive: false,
  });
  expect(saved.members).toEqual([
    {
      membershipId: member.membershipId,
      weight: 1,
      locations: [place, { kind: 'phone', value: '+13055550123', label: null }],
    },
  ]);
  const read = calendarConfiguration.parse(
    await call('getCalendar', invocation, { id: saved.calendar.id }),
  );
  expect(read).toEqual(saved);

  // One setting changed: the rest stay, and the revision moves.
  const {
    id: _id,
    groupName: _groupName,
    supported: _supported,
    bookable: _bookable,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...settings
  } = saved.calendar;
  const changed = calendarConfiguration.parse(
    await call('updateCalendar', invocation, {
      id: saved.calendar.id,
      body: { ...settings, lookBusyPercent: 35, revision: saved.revision },
    }),
  );
  expect(changed.calendar).toMatchObject({ ...everything, lookBusyPercent: 35 });
  expect(changed.revision).not.toBe(saved.revision);
  await expect(
    call('updateCalendar', invocation, {
      id: saved.calendar.id,
      body: { ...settings, lookBusyPercent: 50, revision: saved.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  // A member's places are part of what a stale save is checked against.
  const moved = calendarConfiguration.parse(
    await call('updateCalendarAvailability', invocation, {
      id: saved.calendar.id,
      body: {
        members: [{ ...member, locations: [{ kind: 'address', value: '1 Dock Street' }] }],
        weeklyHours: [],
        dateOverrides: [],
        revision: changed.revision,
      },
    }),
  );
  expect(moved.members[0]?.locations).toEqual([
    { kind: 'address', value: '1 Dock Street', label: null },
  ]);
  expect(moved.revision).not.toBe(changed.revision);
});

it('saves every calendar type as a draft, and switches on only a type that can be booked', async () => {
  const { invocation, member } = await fixture();
  for (const kind of ['collective', 'class', 'service', 'event']) {
    const saved = calendarConfiguration.parse(
      await call('createCalendar', invocation, {
        body: draftOf(`draft-${kind}`, { kind, members: [member] }),
      }),
    );
    expect(saved.calendar).toMatchObject({
      kind,
      isActive: false,
      supported: false,
      bookable: false,
    });
    await expect(
      call('createCalendar', invocation, {
        body: draftOf(`live-${kind}`, { kind, isActive: true, members: [member] }),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  }
  const personal = calendarConfiguration.parse(
    await call('createCalendar', invocation, {
      body: draftOf('live-personal', { isActive: true, members: [member] }),
    }),
  );
  expect(personal.calendar).toMatchObject({ kind: 'personal', isActive: true, supported: true });
});

it('takes on a calendar only people of this business, and only its own group, form and pictures', async () => {
  const ours = await fixture();
  const theirs = await fixture();
  const staff = await database.fixtures.user();
  const agencyMembership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `with role as (
         insert into tenancy.roles (agency_id, scope, key, name)
         values ($1, 'agency', 'admin', 'Admin') returning id)
       insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
       select $1, null, $2, id from role returning id`,
      [ours.invocation.context.agencyId, staff.id],
    ),
  );
  const refused = async (changed: Record<string, unknown>, path: string) => {
    const error: unknown = await call('createCalendar', ours.invocation, {
      body: draftOf(`refused-${randomUUID().slice(0, 8)}`, changed),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error, path).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues.map((issue) => issue.path)).toEqual([path]);
  };
  // Someone of another business, and someone of the agency's own team who is not on this one.
  await refused({ members: [theirs.member] }, '/members');
  await refused(
    { members: [{ membershipId: toPublicId('membership', agencyMembership.id), weight: 1 }] },
    '/members',
  );
  const theirGroup = calendarGroup.parse(
    await call('createCalendarGroup', theirs.invocation, { body: { name: 'Theirs' } }),
  );
  await refused({ groupId: theirGroup.id }, '/groupId');
  const nothing = (kind: 'form' | 'file') =>
    toPublicId(kind, parsePublicId('calendar_group', theirGroup.id) ?? '');
  await refused({ logoFileId: nothing('file') }, '/logoFileId');
  await refused({ coverFileId: nothing('file') }, '/coverFileId');
  expect(calendarList.parse(await call('listCalendars', ours.invocation)).items).toEqual([]);
});

it('keeps calendars in named groups, counts them, and lets them go when a group is deleted', async () => {
  const { invocation } = await fixture();
  const group = async (name: string) =>
    calendarGroup.parse(await call('createCalendarGroup', invocation, { body: { name } }));
  const sales = await group('Sales calls');
  const support = await group('Support');
  await expect(group(' sales CALLS ')).rejects.toBeInstanceOf(ValidationError);
  const make = async (slug: string, groupId: string | null) =>
    calendarConfiguration.parse(
      await call('createCalendar', invocation, { body: draftOf(slug, { groupId }) }),
    );
  await make('one', sales.id);
  const two = await make('two', sales.id);
  await make('three', null);
  const groups = async () => calendarGroupList.parse(await call('listCalendarGroups', invocation));
  expect(await groups()).toMatchObject({
    items: [
      { id: sales.id, name: 'Sales calls', calendarCount: 2 },
      { id: support.id, name: 'Support', calendarCount: 0 },
    ],
    ungroupedCount: 1,
    calendarCount: 3,
    canManage: true,
  });
  expect(
    calendarGroup.parse(
      await call('renameCalendarGroup', invocation, {
        params: { groupId: support.id },
        body: { name: 'Customer support' },
      }),
    ),
  ).toMatchObject({ id: support.id, name: 'Customer support' });
  await expect(
    call('renameCalendarGroup', invocation, {
      params: { groupId: support.id },
      body: { name: 'Sales calls' },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await call('deleteCalendarGroup', invocation, { params: { groupId: sales.id } });
  expect(await groups()).toMatchObject({
    items: [{ name: 'Customer support', calendarCount: 0 }],
    ungroupedCount: 3,
    calendarCount: 3,
  });
  expect(
    calendarConfiguration.parse(await call('getCalendar', invocation, { id: two.calendar.id }))
      .calendar,
  ).toMatchObject({ groupId: null, groupName: null });
  await expect(
    call('deleteCalendarGroup', invocation, { params: { groupId: sales.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  // Someone who may not manage calendars reads the groups and changes none.
  const reading = { ...invocation, permissions: new Set<never>() };
  expect((await call('listCalendarGroups', reading)) as { canManage: boolean }).toMatchObject({
    canManage: false,
  });
  await expect(
    call('createCalendarGroup', reading, { body: { name: 'Nope' } }),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

it('finds calendars by name or group, and filters by status, type, group and person, with a count', async () => {
  const { invocation, member } = await fixture();
  const sales = calendarGroup.parse(
    await call('createCalendarGroup', invocation, { body: { name: 'Sales calls' } }),
  );
  const make = (slug: string, changed: Record<string, unknown>) =>
    call('createCalendar', invocation, { body: draftOf(slug, changed) });
  await make('strategy', { name: 'Business Strategy Call', groupId: sales.id, members: [member] });
  await make('vip', {
    name: '15 Min. VIP Partner',
    kind: 'round_robin',
    isActive: true,
    members: [member],
  });
  await make('workshop', { name: 'Content Marketing workshop', kind: 'class' });
  const names = async (query: Record<string, unknown>) => {
    const found = calendarList.parse(await call('listCalendars', invocation, { query }));
    expect(found.total).toBe(found.items.length);
    return found.items.map((item) => item.name).toSorted();
  };
  expect(await names({})).toHaveLength(3);
  expect(await names({ q: 'strategy' })).toEqual(['Business Strategy Call']);
  expect(await names({ q: 'sales' })).toEqual(['Business Strategy Call']);
  expect(await names({ q: '100%' })).toEqual([]);
  expect(await names({ status: 'active' })).toEqual(['15 Min. VIP Partner']);
  expect(await names({ status: 'inactive' })).toEqual([
    'Business Strategy Call',
    'Content Marketing workshop',
  ]);
  expect(await names({ kind: 'class' })).toEqual(['Content Marketing workshop']);
  expect(await names({ group: sales.id })).toEqual(['Business Strategy Call']);
  expect(await names({ group: 'none' })).toEqual([
    '15 Min. VIP Partner',
    'Content Marketing workshop',
  ]);
  expect(await names({ member: member.membershipId })).toEqual([
    '15 Min. VIP Partner',
    'Business Strategy Call',
  ]);
  expect(await names({ member: member.membershipId, status: 'inactive' })).toEqual([
    'Business Strategy Call',
  ]);
  // The count is of every match, whatever the page holds.
  const page = calendarList.parse(await call('listCalendars', invocation, { query: { limit: 2 } }));
  expect(page.items).toHaveLength(2);
  expect(page.total).toBe(3);
  expect(page.nextCursor).not.toBeNull();
});

it('deletes a calendar nobody was booked on, and keeps one that has appointments', async () => {
  const { invocation, member } = await fixture();
  const make = async (slug: string) =>
    calendarConfiguration.parse(
      await call('createCalendar', invocation, {
        body: draftOf(slug, {
          members: [member],
          weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
        }),
      }),
    );
  const unused = await make('unused');
  const booked = await make('booked');
  const contact = await database.fixtures.contact(invocation.context);
  await database.withTenant(invocation.context, (sql) =>
    sql.query(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
       values (app.business_id(), $1, $2, 'Strategy call', '2030-01-07T09:00:00Z',
         '2030-01-07T09:30:00Z', 'user')`,
      [parsePublicId('calendar', booked.calendar.id), contact.id],
    ),
  );
  await call('deleteCalendar', invocation, { id: unused.calendar.id });
  await expect(call('getCalendar', invocation, { id: unused.calendar.id })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(call('deleteCalendar', invocation, { id: booked.calendar.id })).rejects.toThrow(
    /has appointments/,
  );
  await expect(
    call(
      'deleteCalendar',
      { ...invocation, permissions: new Set<never>() },
      {
        id: booked.calendar.id,
      },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(
    calendarList.parse(await call('listCalendars', invocation)).items.map((item) => item.id),
  ).toEqual([booked.calendar.id]);
  expect(
    await database.withTenant(invocation.context, (sql) =>
      sql.query('select count(*)::int as rows from calendar.calendar_members'),
    ),
  ).toEqual([{ rows: 1 }]);
});
