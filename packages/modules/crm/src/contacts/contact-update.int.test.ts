// PARKED: needs root-seam.patch applied (and @repo/contracts rebuilt). Then it moves to
// src/contacts/contact-update.int.test.ts, where the integration run finds it.
//
// A contact's time zone and do-not-contact flag through the contact's own endpoints
// (GET and PATCH /contacts/{id}, the contact.update command), against a migrated Postgres
// as crm_app under row-level security. Bodies go in as a caller sends them, unparsed, so
// the contract's rules (the revision, the reason) are tested where the API applies them.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { contactRoutes } from './routes.js';

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

// What these tests read of a contact, checked on its way out of the API.
const shown = z.looseObject({
  id: z.string(),
  firstName: z.string().nullable(),
  timeZone: z.string().nullable(),
  doNotContact: z.boolean(),
  preferencesRevision: z.string().regex(/^[0-9a-f]{64}$/),
  trashedAt: z.string().nullable(),
  canManage: z.boolean(),
});
type Shown = z.infer<typeof shown>;

async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; body?: unknown } = {},
): Promise<Shown> {
  const route = contactRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return shown.parse(
    await route.run(
      { invocation, params: request.params ?? {}, body: request.body, query: {} },
      services,
    ),
  );
}

const reason = 'Asked by phone on 9 October to stop.';

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const invocation = (): Invocation => ({
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  });
  const created = await call('createContact', invocation(), {
    body: { firstName: 'Maya', emails: ['maya@example.com'] },
  });
  const id = created.id;
  const read = () => call('getContact', invocation(), { params: { id } });
  const update = (body: unknown, as: Invocation = invocation()) =>
    call('updateContact', as, { params: { id }, body });
  /** A change to the settings, based on what the contact shows now. */
  const save = async (body: Record<string, unknown>) =>
    update({ ...body, preferencesRevision: (await read()).preferencesRevision });
  const stored = () =>
    database.as('crm_owner', (sql) =>
      sql.one<{ timezone: string | null; do_not_contact: boolean }>(
        'select timezone, do_not_contact from crm.contacts where id = $1',
        [parsePublicId('contact', id)],
      ),
    );
  const events = () =>
    database.as('crm_owner', (sql) =>
      sql.query<{ type: string; payload: unknown }>(
        `select type, payload from events.events
         where business_id = $1 and type <> 'contact.created' order by recorded_at, id`,
        [business.id],
      ),
    );
  const lastAudit = () =>
    database.as('crm_owner', (sql) =>
      sql.one<{ command: string; outcome: string; error_code: string | null; input: unknown }>(
        `select command, outcome, error_code, input from audit.commands
         where business_id = $1 order by recorded_at desc, id desc limit 1`,
        [business.id],
      ),
    );
  return { business, invocation, created, id, read, update, save, stored, events, lastAudit };
}

/** The issues of the validation error a call fails with, as path and code. */
async function issuesOf(attempt: Promise<unknown>): Promise<Pick<Issue, 'path' | 'code'>[]> {
  const error: unknown = await attempt.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return error instanceof ValidationError
    ? error.issues.map(({ path, code }) => ({ path, code }))
    : [];
}

describe('reading a contact', () => {
  it('shows no time zone, do not contact off, and the revision of those two', async () => {
    const f = await fixture();
    expect(f.created).toMatchObject({ timeZone: null, doNotContact: false });
    const read = await f.read();
    expect(read).toMatchObject({ timeZone: null, doNotContact: false });
    expect(read.preferencesRevision).toBe(f.created.preferencesRevision);
  });
});

describe('changing the time zone', () => {
  it('stores the name as PostgreSQL spells it and lists the field in one contact.updated', async () => {
    const f = await fixture();
    const saved = await f.save({ timeZone: 'africa/nairobi' });
    expect(saved).toMatchObject({ timeZone: 'Africa/Nairobi', doNotContact: false });
    expect(saved.preferencesRevision).not.toBe(f.created.preferencesRevision);
    expect(await f.stored()).toEqual({ timezone: 'Africa/Nairobi', do_not_contact: false });
    expect(await f.events()).toEqual([
      { type: 'contact.updated', payload: { changed: ['timeZone'] } },
    ]);
    // The same zone again is no change: no second event.
    await f.save({ timeZone: 'Africa/Nairobi' });
    expect(await f.events()).toHaveLength(1);
    expect(await f.save({ timeZone: null })).toMatchObject({
      timeZone: null,
      preferencesRevision: f.created.preferencesRevision,
    });
  });

  it('goes with a change to the name in the same event', async () => {
    const f = await fixture();
    expect(await f.save({ firstName: 'Maia', timeZone: 'UTC' })).toMatchObject({
      firstName: 'Maia',
      timeZone: 'UTC',
    });
    expect(await f.events()).toEqual([
      { type: 'contact.updated', payload: { changed: ['firstName', 'timeZone'] } },
    ]);
  });

  it('refuses what is not a time zone this server knows, on the field', async () => {
    const f = await fixture();
    for (const timeZone of ['EAT', '+03:00', 'Europe/Atlantis', '', 'x'.repeat(65)])
      expect(await issuesOf(f.save({ timeZone })), timeZone).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/timeZone' })]),
      );
    // PostgreSQL's answer, not the contract's: a place no server lists.
    expect(await issuesOf(f.save({ timeZone: 'EAT' }))).toEqual([
      { path: '/timeZone', code: expect.stringMatching(/^(time_zone_unknown|custom)$/) as string },
    ]);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });
    expect(await f.events()).toEqual([]);
  });
});

describe('changing do not contact', () => {
  it('needs a reason both ways, and reports each change once, apart from contact.updated', async () => {
    const f = await fixture();
    for (const doNotContact of [true, false]) {
      expect(await issuesOf(f.save({ doNotContact }))).toEqual([
        { path: '/doNotContactReason', code: 'reason_required' },
      ]);
      expect(await issuesOf(f.save({ doNotContact, doNotContactReason: 'too short' }))).toEqual([
        expect.objectContaining({ path: '/doNotContactReason' }),
      ]);
    }
    expect(await issuesOf(f.save({ timeZone: 'UTC', doNotContactReason: reason }))).toEqual([
      { path: '/doNotContactReason', code: 'reason_unexpected' },
    ]);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });

    expect(await f.save({ doNotContact: true, doNotContactReason: reason })).toMatchObject({
      doNotContact: true,
    });
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: true });
    expect(await f.events()).toEqual([{ type: 'contact.do_not_contact_set', payload: {} }]);
    // Who, when and why are kept with the command; the reason is in no event.
    expect(await f.lastAudit()).toMatchObject({
      command: 'contact.update',
      outcome: 'ok',
      input: { doNotContact: true, doNotContactReason: reason },
    });

    await f.save({ doNotContact: false, doNotContactReason: 'Asked in person to hear from us.' });
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });
    expect(await f.events()).toEqual([
      { type: 'contact.do_not_contact_set', payload: {} },
      { type: 'contact.do_not_contact_cleared', payload: {} },
    ]);
  });
});

describe('the revision', () => {
  it('is needed with either setting, and not with anything else', async () => {
    const f = await fixture();
    expect(await issuesOf(f.update({ timeZone: 'UTC' }))).toEqual([
      { path: '/preferencesRevision', code: 'revision_required' },
    ]);
    expect(await issuesOf(f.update({ doNotContact: true, doNotContactReason: reason }))).toEqual([
      { path: '/preferencesRevision', code: 'revision_required' },
    ]);
    expect(await f.update({ lastName: 'Thompson' })).toMatchObject({
      preferencesRevision: f.created.preferencesRevision,
    });
  });

  it('refuses a change based on settings someone else has since changed', async () => {
    const f = await fixture();
    const opened = f.created.preferencesRevision;
    await f.save({ doNotContact: true, doNotContactReason: reason });
    await expect(
      f.update({ timeZone: 'Africa/Nairobi', preferencesRevision: opened }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Nothing of the refused request is kept, its other fields included.
    await expect(
      f.update({ firstName: 'Maia', timeZone: 'Africa/Nairobi', preferencesRevision: opened }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await f.read()).toMatchObject({ firstName: 'Maya', timeZone: null, doNotContact: true });
    expect(await f.lastAudit()).toMatchObject({ outcome: 'failed', error_code: 'conflict' });
  });

  it("isn't made stale by a change to the contact's name", async () => {
    const f = await fixture();
    await f.update({ firstName: 'Maia' });
    expect(
      await f.update({ timeZone: 'UTC', preferencesRevision: f.created.preferencesRevision }),
    ).toMatchObject({ firstName: 'Maia', timeZone: 'UTC' });
  });
});

describe('what the contact command refuses', () => {
  it('changes neither setting when another field of the same request is refused', async () => {
    const f = await fixture();
    expect(
      await issuesOf(
        f.save({
          timeZone: 'UTC',
          doNotContact: true,
          doNotContactReason: reason,
          phones: ['not a phone number'],
        }),
      ),
    ).toEqual([expect.objectContaining({ path: '/phones/0' })]);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });
    expect(await f.events()).toEqual([]);
  });

  it('refuses a contact in the trash, and still shows its settings', async () => {
    const f = await fixture();
    await f.save({ timeZone: 'UTC' });
    await call('trashContact', f.invocation(), { params: { id: f.id } });
    await expect(f.save({ doNotContact: true, doNotContactReason: reason })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(f.save({ timeZone: null })).rejects.toBeInstanceOf(ConflictError);
    expect(await f.stored()).toEqual({ timezone: 'UTC', do_not_contact: false });
    const read = await f.read();
    expect(read).toMatchObject({ timeZone: 'UTC', doNotContact: false });
    expect(read.trashedAt).not.toBeNull();
  });

  it("refuses someone whose role can't change contacts", async () => {
    const f = await fixture();
    const reader: Invocation = { ...f.invocation(), permissions: new Set() };
    await expect(
      f.update(
        {
          doNotContact: true,
          doNotContactReason: reason,
          preferencesRevision: f.created.preferencesRevision,
        },
        reader,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });
    expect(await call('getContact', reader, { params: { id: f.id } })).toMatchObject({
      canManage: false,
      doNotContact: false,
    });
  });

  it('keeps another business from reading or changing the settings', async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      call('getContact', other.invocation(), { params: { id: f.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      f.update(
        {
          doNotContact: true,
          doNotContactReason: reason,
          preferencesRevision: f.created.preferencesRevision,
        },
        other.invocation(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });
    expect(await f.events()).toEqual([]);
    expect(await other.events()).toEqual([]);
  });
});

describe('the time zones a contact can have', () => {
  it('are listed for anyone in the business, and each one is taken by the contact', async () => {
    const f = await fixture();
    const route = contactRoutes.find((each) => each.endpoint.operationId === 'listTimeZones');
    if (route === undefined) throw new Error('Missing listTimeZones');
    const reader: Invocation = { ...f.invocation(), permissions: new Set() };
    const { items } = z
      .object({ items: z.array(z.string()) })
      .parse(
        await route.run({ invocation: reader, params: {}, query: {}, body: undefined }, services),
      );
    expect(items.length).toBeGreaterThan(300);
    expect(items).toEqual([...items].sort());
    expect(items).toEqual(expect.arrayContaining(['Africa/Nairobi', 'Asia/Kolkata', 'UTC']));
    // No offsets, and none of the names only PostgreSQL uses.
    expect(items.filter((name) => /^[+-]|^posix|^Factory$/.test(name))).toEqual([]);
    for (const timeZone of [items[0], items[Math.floor(items.length / 2)], items.at(-1)])
      expect(await f.save({ timeZone })).toMatchObject({ timeZone });
  });
});
