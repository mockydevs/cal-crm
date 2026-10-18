// The rules around the two settings, without a database. PostgreSQL's own list of zones is
// read only in contact-settings.int.test.ts; here a recording driver answers that one
// statement from a short list that has the same kinds of name as PostgreSQL's.
import type { CommandContext, EventDraft } from '@repo/commands';
import type { DB } from '@repo/db';
import { ConflictError, isTimeZone, NotFoundError, ValidationError } from '@repo/kernel';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';
import {
  changeContactPreferences,
  preferencesOf,
  preferencesRevisionOf,
  findTimeZone,
  readTimeZones,
  resolveTimeZone,
  timeZoneReader,
  type ContactPreferenceChange,
  type ContactPreferenceRow,
} from './contact-settings.js';

// Names as pg_timezone_names has them: current ones, aliases, and two that only
// PostgreSQL uses. It lists no abbreviation such as EAT, and no offset.
const listed = [
  'Africa/Nairobi',
  'America/Argentina/ComodRivadavia',
  'America/New_York',
  'Asia/Calcutta',
  'Asia/Kolkata',
  'Etc/GMT+3',
  'Etc/UTC',
  'Factory',
  'US/Eastern',
  'UTC',
  'posixrules',
];

function database(names: readonly string[] = listed, found = true) {
  const sent: CompiledQuery[] = [];
  class RecordingDriver extends DummyDriver {
    override acquireConnection() {
      return Promise.resolve({
        executeQuery: (query: CompiledQuery) => {
          sent.push(query);
          // An update says how many rows it changed, as PostgreSQL does: the contact's one.
          if (query.sql.startsWith('update'))
            return Promise.resolve({ rows: [], numAffectedRows: found ? 1n : 0n });
          if (!query.sql.includes('pg_timezone_names')) return Promise.resolve({ rows: [] });
          return Promise.resolve({ rows: names.map((name) => ({ name })) as never[] });
        },
        streamQuery: (): AsyncIterableIterator<never> => {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  /** The statements that change the contact, with their values. */
  const updates = () =>
    sent
      .filter((query) => query.sql.startsWith('update'))
      .map((query) => ({ sql: query.sql, parameters: [...query.parameters] }));
  return { db, sent, updates };
}

const businessId = '0199c0de-0000-7000-8000-00000000000b';
const contactId = '0199c0de-0000-7000-8000-00000000000c';
const rowOf = (timezone: string | null = null, doNotContact = false): ContactPreferenceRow => ({
  id: contactId,
  timezone,
  do_not_contact: doNotContact,
});

/** Runs a change as the contact command would, and gives what it wrote and reported. */
async function change(row: ContactPreferenceRow, input: ContactPreferenceChange, found = true) {
  const { db, sent, updates } = database(listed, found);
  const events: EventDraft[] = [];
  const command: CommandContext = {
    context: {
      agencyId: '0199c0de-0000-7000-8000-00000000000a',
      businessId,
      actorKind: 'user',
      correlationId: '0199c0de-0000-7000-8000-00000000000d',
    },
    permissions: 'all',
    emit: (event) => {
      events.push(event);
      return Promise.resolve('0199c0de-0000-7000-8000-00000000000e');
    },
    enqueue: () => undefined,
  };
  const outcome = await db
    .transaction()
    .execute((trx) => changeContactPreferences(trx, command, businessId, row, input))
    .then(
      (fields): { fields?: string[]; error?: unknown } => ({ fields }),
      (error: unknown): { fields?: string[]; error?: unknown } => ({ error }),
    );
  await db.destroy();
  return { ...outcome, events, updates: updates(), statements: sent.length };
}

const revisionOf = (row: ContactPreferenceRow): string => preferencesOf(row).preferencesRevision;

it('names the two values with a revision that changes when either does', () => {
  const none = preferencesRevisionOf({ timeZone: null, doNotContact: false });
  expect(none).toMatch(/^[0-9a-f]{64}$/);
  expect(preferencesRevisionOf({ timeZone: null, doNotContact: false })).toBe(none);
  const others = [
    preferencesRevisionOf({ timeZone: null, doNotContact: true }),
    preferencesRevisionOf({ timeZone: 'UTC', doNotContact: false }),
    preferencesRevisionOf({ timeZone: 'Etc/UTC', doNotContact: false }),
    // The literal text "null" is not the absence of a time zone.
    preferencesRevisionOf({ timeZone: 'null', doNotContact: false }),
  ];
  expect(new Set([none, ...others]).size).toBe(5);
  expect(preferencesOf({ timezone: 'Africa/Nairobi', do_not_contact: true })).toEqual({
    timeZone: 'Africa/Nairobi',
    doNotContact: true,
    preferencesRevision: preferencesRevisionOf({ timeZone: 'Africa/Nairobi', doNotContact: true }),
  });
});

it.each([
  ['Africa/Nairobi', 'Africa/Nairobi'],
  ['africa/nairobi', 'Africa/Nairobi'],
  ['AFRICA/NAIROBI', 'Africa/Nairobi'],
  ['  Africa/Nairobi ', 'Africa/Nairobi'],
  ['america/new_york', 'America/New_York'],
  ['America/Argentina/ComodRivadavia', 'America/Argentina/ComodRivadavia'],
  // An alias stays the name that was given: both are listed.
  ['Asia/Calcutta', 'Asia/Calcutta'],
  ['asia/kolkata', 'Asia/Kolkata'],
  ['utc', 'UTC'],
  ['etc/utc', 'Etc/UTC'],
  ['us/eastern', 'US/Eastern'],
  ['etc/gmt+3', 'Etc/GMT+3'],
])('stores %j as PostgreSQL spells it: %s', async (given, stored) => {
  const { db } = database();
  const zones = timeZoneReader();
  expect(await db.transaction().execute((trx) => resolveTimeZone(trx, given, zones))).toBe(stored);
  await db.destroy();
});

/** The pg_timezone_names reads a database was sent. */
const reads = (sent: readonly CompiledQuery[]): CompiledQuery[] =>
  sent.filter((query) => query.sql.includes('pg_timezone_names'));

it.each([
  // Intl takes this abbreviation, and PostgreSQL's list of names has none such.
  'EAT',
  // Offsets and blanks never reach the database.
  '+03:00',
  '-05:00',
  '',
  '   ',
  'UTC+3',
  'America/New York',
  // Names PostgreSQL lists and the app can't use.
  'posixrules',
  'Factory',
  // Not listed at all.
  'Europe/Atlantis',
])('refuses %j as a time zone', async (given) => {
  const { db, sent } = database();
  const zones = timeZoneReader();
  const failure = await db
    .transaction()
    .execute((trx) => resolveTimeZone(trx, given, zones))
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ValidationError);
  expect(failure).toMatchObject({
    issues: [{ path: '/timeZone', code: 'time_zone_unknown' }],
  });
  expect(await db.transaction().execute((trx) => findTimeZone(trx, given, zones))).toBeUndefined();
  // PostgreSQL is asked only about a region zone the app's own check takes.
  expect(reads(sent)).toHaveLength(isTimeZone(given.trim()) && given.includes('/') ? 1 : 0);
  await db.destroy();
});

it('refuses a name the app takes when this PostgreSQL does not list it', async () => {
  const { db, sent } = database(['UTC']);
  await expect(
    db.transaction().execute((trx) => resolveTimeZone(trx, 'Africa/Nairobi', timeZoneReader())),
  ).rejects.toBeInstanceOf(ValidationError);
  // It was asked: the refusal is PostgreSQL's answer, not a guess.
  expect(reads(sent)).toHaveLength(1);
  await db.destroy();
});

it('finds a place under the name this PostgreSQL has for it when the given one is not listed', async () => {
  // A server without the older names, as Debian ships them from version 13.
  const { db } = database(['Africa/Nairobi', 'Asia/Kolkata', 'Europe/Kyiv', 'UTC']);
  const zones = timeZoneReader();
  const found = (given: string) =>
    db.transaction().execute((trx) => findTimeZone(trx, given, zones));
  // What a browser reports for India and Ukraine.
  expect(await found('Asia/Calcutta')).toBe('Asia/Kolkata');
  expect(await found('asia/calcutta')).toBe('Asia/Kolkata');
  expect(await found('Europe/Kiev')).toBe('Europe/Kyiv');
  // A listed name is never traded for another, and a place with no listed name is not found.
  expect(await found('Asia/Kolkata')).toBe('Asia/Kolkata');
  expect(await found('America/New_York')).toBeUndefined();
  // An abbreviation is not a place, whatever zone Intl files it under.
  expect(await found('EAT')).toBeUndefined();
  await db.destroy();
});

it('turns US zone abbreviations into the region zone they mean and refuses the rest', async () => {
  // PostgreSQL lists EST and MST as fixed offsets with no summer time.
  const { db } = database([
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'EST',
    'MST',
    'EST5EDT',
    'UTC',
  ]);
  const zones = timeZoneReader();
  const found = (given: string) =>
    db.transaction().execute((trx) => findTimeZone(trx, given, zones));
  expect(await found('EST')).toBe('America/New_York');
  expect(await found('edt')).toBe('America/New_York');
  expect(await found(' Eastern ')).toBe('America/New_York');
  expect(await found('CST')).toBe('America/Chicago');
  expect(await found('MDT')).toBe('America/Denver');
  expect(await found('PST')).toBe('America/Los_Angeles');
  expect(await found('AKST')).toBe('America/Anchorage');
  expect(await found('HST')).toBe('Pacific/Honolulu');
  // Denver keeps summer time and Phoenix does not: MST names no single place.
  expect(await found('MST')).toBeUndefined();
  expect(await found('EST5EDT')).toBeUndefined();
  expect(await found('UTC')).toBe('UTC');
  await db.destroy();
});

it('prefers the name ICU itself uses when a place has several listed names and none is the given one', async () => {
  const { db } = database(['Asia/Kolkata', 'Europe/London', 'GB', 'GB-Eire']);
  const zones = timeZoneReader();
  const found = (given: string) =>
    db.transaction().execute((trx) => findTimeZone(trx, given, zones));
  // Belfast is London's zone, listed here under three names: not the first by the alphabet.
  expect(await found('Europe/Belfast')).toBe('Europe/London');
  // Nepal's zone is not India's: only names of the same zone stand in for each other.
  expect(await found('Asia/Katmandu')).toBeUndefined();
  await db.destroy();
});

it('lists the names the app can use, in order, and reads PostgreSQL again only after a while', async () => {
  const { db, sent } = database(['UTC', 'posixrules', 'Africa/Nairobi', 'Factory', 'Asia/Kolkata']);
  let now = 1_000;
  const zones = timeZoneReader(60_000, () => now);
  const read = () => db.transaction().execute((trx) => readTimeZones(trx, zones));
  expect(await read()).toEqual(['Africa/Nairobi', 'Asia/Kolkata', 'UTC']);
  now += 59_999;
  expect(await read()).toEqual(['Africa/Nairobi', 'Asia/Kolkata', 'UTC']);
  await db.transaction().execute((trx) => resolveTimeZone(trx, 'utc', zones));
  expect(reads(sent)).toHaveLength(1);
  expect(reads(sent)[0]?.sql.replace(/\s+/g, ' ').trim()).toBe(
    'select name from pg_catalog.pg_timezone_names',
  );
  now += 1;
  await read();
  expect(reads(sent)).toHaveLength(2);
  await db.destroy();
});

it('sets a time zone in the spelling PostgreSQL returned, and reports only the field', async () => {
  const row = rowOf();
  const done = await change(row, {
    timeZone: 'africa/nairobi',
    preferencesRevision: revisionOf(row),
  });
  expect(done.fields).toEqual(['timeZone']);
  expect(done.updates).toEqual([
    {
      sql: 'update "crm"."contacts" set "timezone" = $1 where "business_id" = $2 and "id" = $3',
      parameters: ['Africa/Nairobi', businessId, contactId],
    },
  ]);
  expect(done.events).toEqual([]);
});

it('clears a time zone with null, without asking PostgreSQL anything', async () => {
  const row = rowOf('Africa/Nairobi');
  const done = await change(row, { timeZone: null, preferencesRevision: revisionOf(row) });
  expect(done.fields).toEqual(['timeZone']);
  expect(done.updates).toEqual([
    expect.objectContaining({ parameters: [null, businessId, contactId] }),
  ]);
  expect(done.statements).toBe(1);
});

it('changes nothing when the time zone is refused', async () => {
  const row = rowOf('Africa/Nairobi');
  const done = await change(row, { timeZone: 'EAT', preferencesRevision: revisionOf(row) });
  expect(done.error).toBeInstanceOf(ValidationError);
  expect(done.updates).toEqual([]);
  expect(done.events).toEqual([]);
});

it.each([
  [true, 'contact.do_not_contact_set'],
  [false, 'contact.do_not_contact_cleared'],
])('turns do not contact to %j and reports it as %s, with nothing personal', async (to, type) => {
  const row = rowOf('Africa/Nairobi', !to);
  const done = await change(row, { doNotContact: to, preferencesRevision: revisionOf(row) });
  // Not a field of contact.updated: it has its own event.
  expect(done.fields).toEqual([]);
  expect(done.updates).toEqual([
    {
      sql: 'update "crm"."contacts" set "do_not_contact" = $1 where "business_id" = $2 and "id" = $3',
      parameters: [to, businessId, contactId],
    },
  ]);
  expect(done.events).toEqual([
    { type, subject: { kind: 'contact', id: contactId }, records: [contactId] },
  ]);
});

it('changes both in one statement', async () => {
  const row = rowOf();
  const done = await change(row, {
    timeZone: 'UTC',
    doNotContact: true,
    preferencesRevision: revisionOf(row),
  });
  expect(done.fields).toEqual(['timeZone']);
  expect(done.updates).toEqual([
    expect.objectContaining({ parameters: ['UTC', true, businessId, contactId] }),
  ]);
  expect(done.events.map((event) => event.type)).toEqual(['contact.do_not_contact_set']);
});

it('refuses a change based on values that have since changed, and changes nothing', async () => {
  const stale = revisionOf(rowOf());
  for (const row of [rowOf('UTC'), rowOf(null, true)])
    for (const input of [
      { timeZone: 'Africa/Nairobi' },
      { timeZone: null },
      { doNotContact: true },
      { doNotContact: false },
    ]) {
      const done = await change(row, { ...input, preferencesRevision: stale });
      expect(done.error).toBeInstanceOf(ConflictError);
      expect(done.statements).toBe(0);
      expect(done.events).toEqual([]);
    }
  // A change that names no revision is refused the same way.
  const unnamed = await change(rowOf(), { doNotContact: true });
  expect(unnamed.error).toBeInstanceOf(ConflictError);
  expect(unnamed.statements).toBe(0);
});

it('does nothing, and reports nothing, when the values are already these', async () => {
  const row = rowOf('Africa/Nairobi', true);
  const done = await change(row, {
    timeZone: 'africa/nairobi',
    doNotContact: true,
    preferencesRevision: revisionOf(row),
  });
  expect(done.fields).toEqual([]);
  expect(done.updates).toEqual([]);
  expect(done.events).toEqual([]);
});

it('leaves a contact change that is about neither alone, whatever revision it carries', async () => {
  for (const input of [{}, { preferencesRevision: 'f'.repeat(64) }]) {
    const done = await change(rowOf('UTC', true), input);
    expect(done.fields).toEqual([]);
    expect(done.statements).toBe(0);
    expect(done.events).toEqual([]);
  }
});

it('reports nothing when the row it was given is not there to change', async () => {
  const row = rowOf();
  const done = await change(
    row,
    { timeZone: 'UTC', doNotContact: true, preferencesRevision: revisionOf(row) },
    false,
  );
  expect(done.error).toBeInstanceOf(NotFoundError);
  expect(done.updates).toHaveLength(1);
  expect(done.events).toEqual([]);
});

it('reports do not contact only when it changed, even when the time zone did', async () => {
  const row = rowOf('UTC', true);
  const done = await change(row, {
    timeZone: 'Africa/Nairobi',
    doNotContact: true,
    preferencesRevision: revisionOf(row),
  });
  expect(done.fields).toEqual(['timeZone']);
  expect(done.updates).toEqual([
    expect.objectContaining({ parameters: ['Africa/Nairobi', businessId, contactId] }),
  ]);
  expect(done.events).toEqual([]);
});
