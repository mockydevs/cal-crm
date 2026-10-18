// A contact's time zone and do-not-contact flag against a migrated Postgres, as crm_app
// under row-level security. These tests need only contact-settings.ts: a command made here
// locks the contact's row and hands it over, as the contact command will. What the contact
// command itself adds (the reason's rule, the trash, contact.updated) is tested with it.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  requireBusiness,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, isTimeZone, NotFoundError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  changeContactPreferences,
  findTimeZone,
  preferencesOf,
  preferencesRevisionOf,
  readTimeZones,
} from './contact-settings.js';

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

const changeInput = z.strictObject({
  id: z.uuid(),
  timeZone: z.string().nullable().optional(),
  doNotContact: z.boolean().optional(),
  doNotContactReason: z.string().optional(),
  preferencesRevision: z.string().optional(),
});

/** Called once the contact's row is locked, before anything is changed. */
let whenLocked: () => Promise<void> = () => Promise.resolve();

// The contact command's part, as its patch has it: lock the row, then hand it over.
const change = defineCommand({
  name: 'test.contact.preferences',
  permission: 'contacts.manage',
  input: changeInput,
  async handle(trx, input, command) {
    const businessId = requireBusiness(command.context);
    const row = await trx
      .selectFrom('crm.contacts')
      .select(['id', 'timezone', 'do_not_contact'])
      .where('business_id', '=', businessId)
      .where('id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Contact', input.id);
    await whenLocked();
    return changeContactPreferences(trx, command, businessId, row, input);
  },
});

// A caller that hands over a row it never read: the row of another business's contact.
const changeUnread = defineCommand({
  name: 'test.contact.preferences_unread',
  permission: 'contacts.manage',
  input: changeInput,
  handle: (trx, input, command) =>
    changeContactPreferences(
      trx,
      command,
      requireBusiness(command.context),
      { id: input.id, timezone: null, do_not_contact: false },
      input,
    ),
});

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const invocation = (): Invocation => ({
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  });
  const stored = () =>
    database.as('crm_owner', (sql) =>
      sql.one<{ timezone: string | null; do_not_contact: boolean }>(
        'select timezone, do_not_contact from crm.contacts where id = $1',
        [contact.id],
      ),
    );
  /** The revision of what is stored now, as a contact shows it. */
  const revision = async () => preferencesOf(await stored()).preferencesRevision;
  const save = async (input: Omit<z.input<typeof changeInput>, 'id' | 'preferencesRevision'>) =>
    runCommand(
      services,
      change,
      { id: contact.id, ...input, preferencesRevision: await revision() },
      invocation(),
    );
  const events = () =>
    database.as('crm_owner', (sql) =>
      sql.query<{ type: string; subject_kind: string; subject_id: string; payload: unknown }>(
        `select type, subject_kind, subject_id, payload from events.events
         where business_id = $1 order by recorded_at, id`,
        [business.id],
      ),
    );
  const timeline = () =>
    database.as('crm_owner', (sql) =>
      sql.query<{ event_type: string }>(
        `select event_type from crm.timeline_entries
         where business_id = $1 and record_id = $2 order by event_recorded_at, event_id`,
        [business.id, contact.id],
      ),
    );
  const audit = () =>
    database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string; error_code: string | null; input: unknown }>(
        `select command, outcome, error_code, input from audit.commands
         where business_id = $1 order by recorded_at, id`,
        [business.id],
      ),
    );
  return { business, contact, invocation, stored, revision, save, events, timeline, audit };
}

/** The names this server's PostgreSQL lists, which is what the send check joins on. */
async function listedZones(): Promise<Set<string>> {
  const rows = await database.as('crm_owner', (sql) =>
    sql.query<{ name: string }>('select name from pg_catalog.pg_timezone_names'),
  );
  return new Set(rows.map((row) => row.name));
}

/** What a refused time zone fails with. */
const unknownTimeZone = { issues: [{ path: '/timeZone', code: 'time_zone_unknown' }] };

describe('a time zone', () => {
  it('is stored as PostgreSQL spells it, whatever letter case it came in', async () => {
    const f = await fixture();
    expect(await f.save({ timeZone: 'africa/nairobi' })).toEqual(['timeZone']);
    expect(await f.stored()).toEqual({ timezone: 'Africa/Nairobi', do_not_contact: false });
    expect(await f.save({ timeZone: 'AMERICA/NEW_YORK' })).toEqual(['timeZone']);
    expect(await f.stored()).toMatchObject({ timezone: 'America/New_York' });
    // The same zone in another case is no change, and writes nothing.
    expect(await f.save({ timeZone: 'america/new_york' })).toEqual([]);
    // One zone under two names: each is stored as given, never rewritten to the other. A
    // server may ship without the older name; the current one is always there.
    const listed = await listedZones();
    expect(listed.has('Asia/Kolkata')).toBe(true);
    for (const name of ['Asia/Kolkata', 'Asia/Calcutta'].filter((each) => listed.has(each))) {
      expect(await f.save({ timeZone: name.toLowerCase() }), name).toEqual(['timeZone']);
      expect(await f.stored(), name).toMatchObject({ timezone: name });
    }
    expect(await f.save({ timeZone: null })).toEqual(['timeZone']);
    expect(await f.stored()).toMatchObject({ timezone: null });
    // The helper leaves contact.updated to the contact command, so it wrote no event.
    expect(await f.events()).toEqual([]);
  });

  it('is one the send check finds: the stored name joins pg_timezone_names exactly', async () => {
    const f = await fixture();
    await f.save({ timeZone: 'europe/london' });
    // The join messaging's policyFacts makes (outbound.ts): tz.name = c.timezone.
    const [found] = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string }>(
        `select tz.name from crm.contacts c
         join pg_catalog.pg_timezone_names tz on tz.name = c.timezone where c.id = $1`,
        [f.contact.id],
      ),
    );
    expect(found).toEqual({ name: 'Europe/London' });
  });

  it.each([
    // Abbreviations: one no server lists, and one that names no single place.
    'EAT',
    'MST',
    // Fixed offsets, a made-up place, and a name only PostgreSQL uses.
    '+03:00',
    'UTC+3',
    'Europe/Atlantis',
    'posixrules',
  ])('is refused when it is %j, and nothing changes', async (timeZone) => {
    const f = await fixture();
    await f.save({ timeZone: 'Africa/Nairobi' });
    const failure: unknown = await f.save({ timeZone }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject(unknownTimeZone);
    expect(await f.stored()).toMatchObject({ timezone: 'Africa/Nairobi' });
    expect((await f.audit()).at(-1)).toMatchObject({
      outcome: 'invalid',
      error_code: 'validation',
    });
  });

  it('lists what PostgreSQL lists and the app can use, and takes every one of them', async ({
    annotate,
  }) => {
    const f = await fixture();
    const listed = await listedZones();
    const names = await withTenant(db, f.invocation().context, (trx) => readTimeZones(trx));
    expect(names.length).toBeGreaterThan(300);
    expect(names).toEqual([...names].sort());
    expect(names.every((name) => listed.has(name) && isTimeZone(name))).toBe(true);
    // Every region zone, and UTC; never an abbreviation or an old rule such as EST5EDT.
    expect(
      [...listed].filter(
        (name) =>
          isTimeZone(name) && (name.includes('/') || name === 'UTC') && !names.includes(name),
      ),
    ).toEqual([]);
    expect(names.filter((name) => !name.includes('/') && name !== 'UTC')).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['Africa/Nairobi', 'Asia/Kolkata', 'UTC']));
    // Every tenth listed name, in the wrong letter case, comes back as listed.
    const sample = names.filter((_, index) => index % 10 === 0);
    const answers = await withTenant(db, f.invocation().context, async (trx) => {
      const result: (string | undefined)[] = [];
      for (const name of sample) result.push(await findTimeZone(trx, name.toUpperCase()));
      return result;
    });
    expect(answers).toEqual(sample);

    // What a browser of this ICU reports: each is a listed zone, itself or under the name
    // this server has for the same place. The few that are neither are newer than the
    // server's data; a booking from one of those leaves the contact without a time zone.
    const reported = Intl.supportedValuesOf('timeZone');
    const found = await withTenant(db, f.invocation().context, async (trx) => {
      const result: { name: string; zone: string | undefined }[] = [];
      for (const name of reported) result.push({ name, zone: await findTimeZone(trx, name) });
      return result;
    });
    const unknown = found.filter(({ zone }) => zone === undefined).map(({ name }) => name);
    await annotate(
      `${String(names.length)} zones listed; of ${String(reported.length)} a browser reports, ${String(unknown.length)} unknown here: ${unknown.join(', ')}`,
    );
    for (const { zone } of found) if (zone !== undefined) expect(listed.has(zone)).toBe(true);
    expect(unknown.length, unknown.join(', ')).toBeLessThanOrEqual(reported.length / 20);
  });
});

describe('do not contact', () => {
  it('is set and cleared, each reported once on the timeline with nothing personal', async () => {
    const f = await fixture();
    expect(
      await f.save({ doNotContact: true, doNotContactReason: 'Asked by phone to stop.' }),
    ).toEqual([]);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: true });
    const set = {
      type: 'contact.do_not_contact_set',
      subject_kind: 'contact',
      subject_id: f.contact.id,
      payload: {},
    };
    expect(await f.events()).toEqual([set]);

    // Already on: nothing is written and nothing is reported again.
    expect(
      await f.save({ doNotContact: true, doNotContactReason: 'Asked again, by email.' }),
    ).toEqual([]);
    expect(await f.events()).toEqual([set]);

    await f.save({ doNotContact: false, doNotContactReason: 'Asked in person to hear from us.' });
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });
    expect(await f.events()).toEqual([set, { ...set, type: 'contact.do_not_contact_cleared' }]);
    expect((await f.timeline()).map((entry) => entry.event_type)).toEqual([
      'contact.do_not_contact_set',
      'contact.do_not_contact_cleared',
    ]);
  });

  it('keeps the reason in the audit log with the command, and in no event', async () => {
    const f = await fixture();
    const reason = 'Solicitor letter of 9 October asks for no contact.';
    await f.save({ doNotContact: true, doNotContactReason: reason });
    expect((await f.audit()).at(-1)).toMatchObject({
      command: 'test.contact.preferences',
      outcome: 'ok',
      input: { doNotContact: true, doNotContactReason: reason },
    });
    expect(JSON.stringify(await f.events())).not.toContain('Solicitor');
  });

  it('changes with the time zone in one go', async () => {
    const f = await fixture();
    expect(
      await f.save({
        timeZone: 'utc',
        doNotContact: true,
        doNotContactReason: 'Asked by phone to stop.',
      }),
    ).toEqual(['timeZone']);
    expect(await f.stored()).toEqual({ timezone: 'UTC', do_not_contact: true });
    expect((await f.events()).map((event) => event.type)).toEqual(['contact.do_not_contact_set']);
  });
});

describe('a change based on what someone else has since changed', () => {
  it('is refused with a conflict and changes nothing', async () => {
    const f = await fixture();
    const opened = await f.revision();
    await f.save({ timeZone: 'Africa/Nairobi' });
    for (const input of [
      { timeZone: 'Europe/London' },
      { timeZone: null },
      { doNotContact: true, doNotContactReason: 'Asked by phone to stop.' },
    ]) {
      await expect(
        runCommand(
          services,
          change,
          { id: f.contact.id, ...input, preferencesRevision: opened },
          f.invocation(),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    }
    expect(await f.stored()).toEqual({ timezone: 'Africa/Nairobi', do_not_contact: false });
    expect(await f.events()).toEqual([]);
    expect((await f.audit()).at(-1)).toMatchObject({ outcome: 'failed', error_code: 'conflict' });
    // The revision names the values, so a change that puts them back is not stale.
    await f.save({ timeZone: null });
    expect(await f.revision()).toBe(opened);
    expect(opened).toBe(preferencesRevisionOf({ timeZone: null, doNotContact: false }));
  });

  it('lets exactly one of two overlapping changes from the same revision win', async () => {
    const f = await fixture();
    const opened = await f.revision();
    // The first change stops with the contact's row locked until the second is waiting for
    // that lock; only then does the first go on. So the two truly overlap.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const locked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let calls = 0;
    whenLocked = async () => {
      calls += 1;
      if (calls === 1) {
        reached();
        await held;
      }
    };
    try {
      const turnOn = (reason: string) =>
        runCommand(
          services,
          change,
          {
            id: f.contact.id,
            doNotContact: true,
            doNotContactReason: reason,
            preferencesRevision: opened,
          },
          f.invocation(),
        );
      const first = turnOn('Asked by phone to stop.');
      await locked;
      const second = turnOn('Asked by email to stop.');
      // Another role's wait events are hidden from crm_app, so the superuser watches.
      await expect
        .poll(
          () =>
            database.as('postgres', async (sql) => {
              const [row] = await sql.query<{ waiting: number }>(
                `select count(*)::int as waiting from pg_stat_activity
                 where datname = current_database() and wait_event_type = 'Lock'`,
              );
              return row?.waiting ?? 0;
            }),
          { timeout: 10_000, interval: 50 },
        )
        .toBe(1);
      release();
      const [won, lost] = await Promise.allSettled([first, second]);
      expect(won).toMatchObject({ status: 'fulfilled' });
      expect(lost).toMatchObject({ status: 'rejected' });
      expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ConflictError);
    } finally {
      release();
      whenLocked = () => Promise.resolve();
    }
    expect(calls).toBe(2);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: true });
    expect((await f.events()).map((event) => event.type)).toEqual(['contact.do_not_contact_set']);
  });
});

describe('another business', () => {
  it("can't see the contact, and a row handed over unread changes and reports nothing", async () => {
    const f = await fixture();
    const other = await fixture();
    const input = {
      id: f.contact.id,
      doNotContact: true,
      doNotContactReason: 'Asked by phone to stop.',
      preferencesRevision: await f.revision(),
    };
    // Row-level security hides the row from the lock, as it would from the contact command.
    await expect(runCommand(services, change, input, other.invocation())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Even a caller that skips the lock can't write it, or say on a timeline that it did.
    await expect(
      runCommand(services, changeUnread, input, other.invocation()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await f.stored()).toEqual({ timezone: null, do_not_contact: false });
    expect(await f.events()).toEqual([]);
    expect(await other.events()).toEqual([]);
    expect(await other.stored()).toEqual({ timezone: null, do_not_contact: false });
  });
});
