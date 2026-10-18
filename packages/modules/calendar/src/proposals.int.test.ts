import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { calendarConfiguration, type ProposalKind } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@repo/kernel';
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
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createCalendarProposables, createCalendarRoutes, type CalendarOptions } from './index.js';

const options: CalendarOptions = {
  business: { lockActive: lockActiveBusiness },
  timeZones: { find: findTimeZone },
  members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
  senders: {
    resolve: resolveCalendarSender,
    choices: readCalendarSenderChoices,
    eligible: readEligibleCalendarSenders,
  },
};
const routes = createCalendarRoutes(options);
const proposables = createCalendarProposables(options);
let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return { context: { ...business.context, correlationId: randomUUID() }, permissions: 'all' };
}
const draft = () => ({
  name: 'Consultation',
  kind: 'personal',
  timezone: 'UTC',
  bookingSlug: 'consultation',
  members: [],
  weeklyHours: [],
  dateOverrides: [],
});
const settings = () => ({
  name: 'Reviewed consultation',
  kind: 'personal',
  timezone: 'UTC',
  bookingSlug: 'consultation',
});
function proposal(kind: ProposalKind) {
  const found = proposables.find((entry) => entry.kind === kind);
  if (!found) throw new Error('Missing native calendar proposal.');
  return found;
}
async function call(operationId: string, invocation: Invocation, body?: unknown, id?: string) {
  const route = routes.find((entry) => entry.endpoint.operationId === operationId);
  if (!route) throw new Error('Missing native calendar route.');
  return route.run({ invocation, body, params: id ? { id } : {}, query: {} }, services);
}
const read = async (invocation: Invocation, id: string) =>
  calendarConfiguration.parse(await call('getCalendar', invocation, undefined, id));
const create = async (invocation: Invocation) =>
  calendarConfiguration.parse(await call('createCalendar', invocation, draft()));

it('presents creation without creating a calendar, and detects native configuration changes', async () => {
  const invocation = await fixture();
  const item = proposal('calendar_create');
  const input = draft();
  const before = await withTenant(db, invocation.context, async (trx) => {
    expect(await item.subject(trx, input)).toEqual({});
    expect(await item.present(trx, input, invocation)).toMatchObject({
      operationId: 'createCalendar',
      name: input.name,
      details: input,
    });
    expect(await trx.selectFrom('calendar.calendars').select('id').execute()).toEqual([]);
    return item.revision(trx, input);
  });
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  await create(invocation);
  expect(await withTenant(db, invocation.context, (trx) => item.revision(trx, input))).not.toBe(
    before,
  );
});

it('shows the exact proposed settings without changing them and refuses a stale settings revision', async () => {
  const invocation = await fixture();
  const saved = await create(invocation);
  const item = proposal('calendar_update');
  const input = { id: saved.calendar.id, settings: { ...settings(), revision: saved.revision } };
  const before = await withTenant(db, invocation.context, async (trx) => {
    expect(await item.subject(trx, input)).toEqual({});
    expect(await item.present(trx, input, invocation)).toMatchObject({
      operationId: 'updateCalendar',
      name: 'Reviewed consultation',
      details: { calendarId: input.id, settings: input.settings },
    });
    return item.revision(trx, input);
  });
  expect((await read(invocation, input.id)).calendar.name).toBe('Consultation');
  await call('updateCalendar', invocation, { ...settings(), revision: saved.revision }, input.id);
  expect(await withTenant(db, invocation.context, (trx) => item.revision(trx, input))).not.toBe(
    before,
  );
  await expect(
    withTenant(db, invocation.context, (trx) => item.present(trx, input, invocation)),
  ).rejects.toBeInstanceOf(ConflictError);
});

it('includes complete availability and detects changes to native hours before approval', async () => {
  const invocation = await fixture();
  const saved = await create(invocation);
  const item = proposal('calendar_availability');
  const input = {
    id: saved.calendar.id,
    revision: saved.revision,
    members: [],
    weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '10:00' }],
    dateOverrides: [],
  };
  const before = await withTenant(db, invocation.context, async (trx) => {
    expect(await item.subject(trx, input)).toEqual({});
    expect(await item.present(trx, input, invocation)).toMatchObject({
      operationId: 'updateCalendarAvailability',
      name: saved.calendar.name,
      details: {
        calendarId: input.id,
        members: input.members,
        weeklyHours: input.weeklyHours,
        dateOverrides: [],
      },
    });
    return item.revision(trx, input);
  });
  expect((await read(invocation, input.id)).weeklyHours).toEqual([]);
  await call(
    'updateCalendarAvailability',
    invocation,
    {
      revision: input.revision,
      members: input.members,
      weeklyHours: input.weeklyHours,
      dateOverrides: [],
    },
    input.id,
  );
  expect(await withTenant(db, invocation.context, (trx) => item.revision(trx, input))).not.toBe(
    before,
  );
  await expect(
    withTenant(db, invocation.context, (trx) => item.present(trx, input, invocation)),
  ).rejects.toBeInstanceOf(ConflictError);
});

it('refuses foreign calendar fingerprints and presentations for both update kinds', async () => {
  const ours = await fixture();
  const foreign = await create(await fixture());
  for (const kind of ['calendar_update', 'calendar_availability'] as const) {
    const item = proposal(kind);
    const input =
      kind === 'calendar_update'
        ? { id: foreign.calendar.id, settings: { ...settings(), revision: foreign.revision } }
        : {
            id: foreign.calendar.id,
            revision: foreign.revision,
            members: [],
            weeklyHours: [],
            dateOverrides: [],
          };
    await expect(
      withTenant(db, ours.context, (trx) => item.revision(trx, input)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withTenant(db, ours.context, (trx) => item.present(trx, input, ours)),
    ).rejects.toBeInstanceOf(NotFoundError);
  }
});

it('keeps the native management permission on all writes and creates no effects when it is absent', async () => {
  const invocation = await fixture();
  const saved = await create(invocation);
  const refused: Invocation = { ...invocation, permissions: new Set() };
  expect(proposables.map((entry) => entry.permission)).toEqual([
    'calendars.manage',
    'calendars.manage',
    'calendars.manage',
  ]);
  await expect(
    call('createCalendar', refused, { ...draft(), bookingSlug: 'denied' }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call('updateCalendar', refused, { ...settings(), revision: saved.revision }, saved.calendar.id),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call(
      'updateCalendarAvailability',
      refused,
      { members: [], weeklyHours: [], dateOverrides: [], revision: saved.revision },
      saved.calendar.id,
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect((await read(invocation, saved.calendar.id)).calendar.name).toBe('Consultation');
});
