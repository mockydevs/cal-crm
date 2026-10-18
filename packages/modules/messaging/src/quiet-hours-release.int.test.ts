// On the real send path: a message is held during quiet
// hours in the contact's time zone and released afterwards.
//
// The send check reads PostgreSQL's now(), so no clock can be injected. These tests move
// the window instead of the clock: they pick a time zone by its current local hour and
// set a window that is open or closed now, or that ends a few real seconds from now. The
// only time that is skipped is the five-minute wait between rechecks, by moving the
// message's and its job's due time back; the check itself always runs at the real time.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';
import {
  createDispatchOutboundTask,
  queueOutboundMessage,
  type OutboundInput,
} from './outbound.js';

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

// Finding a zone can wait out the end of an hour, and one test waits for a window to end.
const patient = 150_000;

interface MessageState {
  readonly id: string;
  readonly status: string;
  readonly error_code: string | null;
  readonly held_minutes: number | null;
}

/**
 * A fixed-offset zone whose local time is in the given hour now, with at least a minute
 * of that hour left, so a test can't straddle the hour.
 */
async function zoneAtHour(hour: number): Promise<string> {
  for (;;) {
    const [left] = await database.as('crm_owner', (sql) =>
      sql.query<{ seconds: number }>(
        "select extract(epoch from date_trunc('hour',now())+interval '1 hour'-now())::float8 as seconds",
      ),
    );
    if (left !== undefined && left.seconds > 60) break;
    await sleep(((left?.seconds ?? 1) + 1) * 1000);
  }
  const zone = await database.as('crm_owner', (sql) =>
    sql.one<{ name: string }>(
      `select name from pg_catalog.pg_timezone_names
       where name ~ '^Etc/GMT[+-][0-9]+$' and extract(hour from now() at time zone name)=$1
       order by name limit 1`,
      [hour],
    ),
  );
  return zone.name;
}

async function fixture(timezone: string | null) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context, {
    email: 'recipient@example.test',
  });
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const rows = await database.withTenant(context, async (sql) => {
    await sql.query('update crm.contacts set timezone=$1 where id=$2', [timezone, contact.id]);
    await sql.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled) values (app.business_id(),true)',
    );
    for (const purpose of ['marketing', 'transactional'])
      await sql.query(
        `insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,proof,recorded_by_kind)
         values (app.business_id(),$1,'email',$2,'granted','user','{"note":"Fixture consent."}','system')`,
        [contact.id, purpose],
      );
    const identity = await sql.one<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Fixture sender') returning id",
    );
    return { identity, account };
  });
  const input: OutboundInput = {
    identityId: rows.identity.id,
    accountId: rows.account.id,
    channel: 'email',
    purpose: 'marketing',
    lane: 'campaign',
    idempotencyKey: randomUUID(),
    subject: 'Fixture',
    text: 'Body',
  };
  const delivered: string[] = [];
  const task = createDispatchOutboundTask({
    deliver(message) {
      delivered.push(message.messageId);
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  return {
    context,
    delivered,
    queue: (patch: Partial<OutboundInput> = {}) =>
      withTenant(db, context, (trx) =>
        queueOutboundMessage(trx, context, {
          ...input,
          idempotencyKey: randomUUID(),
          ...patch,
        }),
      ),
    businessZone: (zone: string) =>
      database.withTenant(context, (sql) =>
        sql.query('update tenancy.businesses set timezone=$1 where id=app.business_id()', [zone]),
      ),
    /** Sets the window in the contact's local time, relative to now. */
    window: (start: string, end: string) =>
      database.withTenant(context, (sql) =>
        sql.query(
          `update messaging.settings set quiet_hours_start=${start}, quiet_hours_end=${end}`,
        ),
      ),
    messages: () =>
      database.withTenant(context, (sql) =>
        sql.query<MessageState>(
          `select id,status,error_code,
             round(extract(epoch from scheduled_for-now())/60)::integer as held_minutes
           from messaging.messages order by created_at,id`,
        ),
      ),
    job: (messageId: string) =>
      database.as('crm_owner', (sql) =>
        sql.query<{ due: boolean }>(
          'select run_at<=now() as due from graphile_worker._private_jobs where key=$1',
          [`outbound:${messageId}`],
        ),
      ),
    /**
     * Takes the jobs that are due as the worker does and runs this business's through the
     * real dispatch task. Gives how many of them were this business's.
     */
    async work(): Promise<number> {
      let mine = 0;
      for (const job of await database.runJobs(['messaging.dispatch'])) {
        const payload = z
          .object({
            agencyId: z.uuid(),
            businessId: z.uuid(),
            correlationId: z.uuid(),
            data: z.object({ messageId: z.uuid() }),
          })
          .parse(job.payload);
        // A job another test left behind is not this test's to send.
        if (payload.businessId !== context.businessId) continue;
        mine += 1;
        await task.run(payload.data, {
          invocation: {
            context: {
              agencyId: payload.agencyId,
              businessId: payload.businessId,
              actorKind: 'system',
              correlationId: payload.correlationId,
            },
            permissions: 'all',
          },
          services: { db, authorize: () => true },
        });
      }
      return mine;
    },
    /** The five minutes between rechecks pass: the message and its job fall due. */
    async fiveMinutesPass(messageId: string): Promise<void> {
      await database.withTenant(context, (sql) =>
        sql.query(
          "update messaging.messages set scheduled_for=now()-interval '1 second' where id=$1",
          [messageId],
        ),
      );
      await database.as('crm_owner', (sql) =>
        sql.query(
          "update graphile_worker._private_jobs set run_at=now()-interval '1 second' where key=$1",
          [`outbound:${messageId}`],
        ),
      );
    },
    /** Waits, on the database's own clock, until the contact's local time passes the window's end. */
    async untilWindowEnds(zone: string): Promise<void> {
      for (;;) {
        const state = await database.withTenant(context, (sql) =>
          sql.one<{ ended: boolean }>(
            'select (now() at time zone $1)::time>=quiet_hours_end as ended from messaging.settings',
            [zone],
          ),
        );
        if (state.ended) return;
        await sleep(250);
      }
    },
  };
}

// A window that is open now and ends by itself a few seconds from now, in the contact's
// local time. At local noon the window is within one day; just after local midnight it
// starts the evening before, so it wraps midnight and takes the other branch of the check.
const endingSoon = [
  { label: 'a daytime window', hour: 12, start: "'11:00'" },
  { label: 'a window that wraps midnight', hour: 0, start: "'22:00'" },
] as const;

it.each(endingSoon)(
  'holds a message during $label and sends it once, by itself, after the window ends',
  async ({ hour, start }) => {
    const zone = await zoneAtHour(hour);
    const f = await fixture(zone);
    await f.window(start, `((now() at time zone '${zone}')+interval '15 seconds')::time`);

    const messageId = await f.queue();
    // Held, with the reason, and due for a recheck five minutes on.
    expect(await f.messages()).toEqual([
      { id: messageId, status: 'queued', error_code: 'quiet_hours', held_minutes: 5 },
    ]);
    expect(await f.job(messageId)).toEqual([{ due: false }]);
    // The worker has nothing to do yet, and nothing was sent.
    expect(await f.work()).toBe(0);
    expect(f.delivered).toEqual([]);

    // Still inside the window when a recheck comes: held again, for another five minutes.
    await f.fiveMinutesPass(messageId);
    expect(await f.work()).toBe(1);
    expect(f.delivered).toEqual([]);
    expect(await f.messages()).toEqual([
      { id: messageId, status: 'queued', error_code: 'quiet_hours', held_minutes: 5 },
    ]);
    expect(await f.job(messageId)).toEqual([{ due: false }]);

    // The window ends by the clock alone: no setting, contact or message is changed.
    await f.untilWindowEnds(zone);
    expect(await f.work()).toBe(0);
    expect(f.delivered).toEqual([]);

    // The next recheck finds the window over and sends.
    await f.fiveMinutesPass(messageId);
    expect(await f.work()).toBe(1);
    expect(f.delivered).toEqual([messageId]);
    expect(await f.messages()).toEqual([
      { id: messageId, status: 'sent', error_code: null, held_minutes: null },
    ]);

    // Exactly once: no job is left, and a repeated job changes nothing.
    expect(await f.job(messageId)).toEqual([]);
    expect(await f.work()).toBe(0);
    const task = createDispatchOutboundTask({
      deliver(message) {
        f.delivered.push(message.messageId);
        return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
      },
    });
    await task.run(
      { messageId },
      {
        invocation: { context: f.context, permissions: 'all' },
        services: { db, authorize: () => true },
      },
    );
    expect(f.delivered).toEqual([messageId]);
  },
  patient,
);

it(
  "decides by the contact's local time, not the business's or the server's",
  async () => {
    const noon = await zoneAtHour(12);
    const afternoon = await zoneAtHour(15);
    // One window for both contacts at the same instant: 11:00 to 13:00.
    const held = await fixture(noon);
    await held.window("'11:00'", "'13:00'");
    await held.businessZone(afternoon);
    const heldId = await held.queue();
    expect(await held.messages()).toMatchObject([{ status: 'queued', error_code: 'quiet_hours' }]);
    expect(await held.work()).toBe(0);

    const free = await fixture(afternoon);
    await free.window("'11:00'", "'13:00'");
    await free.businessZone(noon);
    const freeId = await free.queue();
    expect(await free.messages()).toMatchObject([{ status: 'queued', error_code: null }]);
    expect(await free.work()).toBe(1);
    expect(free.delivered).toEqual([freeId]);
    expect(held.delivered).toEqual([]);
    expect(heldId).not.toBe(freeId);
  },
  patient,
);

it(
  'holds transactional messages and replies too, in every lane',
  async () => {
    const zone = await zoneAtHour(12);
    const f = await fixture(zone);
    await f.window("'11:00'", "'13:00'");
    await f.queue({ purpose: 'marketing', lane: 'campaign' });
    await f.queue({ purpose: 'marketing', lane: 'automation' });
    await f.queue({ purpose: 'transactional', lane: 'transactional' });
    await f.queue({ purpose: 'transactional', lane: 'reply' });
    // What the code does today: a reply waits, as a booking confirmation does. Whether a
    // reply should wait is still an open question.
    expect((await f.messages()).map((row) => [row.status, row.error_code])).toEqual([
      ['queued', 'quiet_hours'],
      ['queued', 'quiet_hours'],
      ['queued', 'quiet_hours'],
      ['queued', 'quiet_hours'],
    ]);
    expect(await f.work()).toBe(0);
    expect(f.delivered).toEqual([]);
  },
  patient,
);

it(
  'sends at any hour when quiet hours are off, time zone or not',
  async () => {
    for (const timezone of [await zoneAtHour(12), null]) {
      const f = await fixture(timezone);
      await f.window("'00:00'", "'23:59'");
      await database.withTenant(f.context, (sql) =>
        sql.query('update messaging.settings set quiet_hours_enabled=false'),
      );
      const messageId = await f.queue();
      expect(await f.work()).toBe(1);
      expect(f.delivered).toEqual([messageId]);
    }
  },
  patient,
);

it("holds a contact with no time zone by the business's own while quiet hours are on", async () => {
  const f = await fixture(null);
  // Quiet now in Nairobi, the business's zone, and nowhere near it in UTC: the business's
  // own zone is used, never an implicit UTC.
  await f.window(
    "((now() at time zone 'Africa/Nairobi')-interval '1 hour')::time",
    "((now() at time zone 'Africa/Nairobi')+interval '1 hour')::time",
  );
  await f.businessZone('Africa/Nairobi');
  await f.queue();
  expect(await f.messages()).toMatchObject([{ status: 'queued', error_code: 'quiet_hours' }]);
  expect(f.delivered).toEqual([]);
});

it('PostgreSQL gives every instant one local time, also across a daylight-saving change', async () => {
  // Not the send path: this pins down what `now() at time zone` means for the check when
  // clocks change, which can't be reached at the real time of a test run.
  const local = (instant: string) =>
    database
      .as('crm_owner', (sql) =>
        sql.one<{ time: string }>(
          "select ($1::timestamptz at time zone 'America/New_York')::time::text as time",
          [instant],
        ),
      )
      .then((row) => row.time);
  // 8 March 2026: 02:00 to 03:00 doesn't exist. The local time goes from 01:59:59 to
  // 03:00:00, so a window ending at 02:30 is over at 03:00.
  expect(await local('2026-03-08T06:59:59Z')).toBe('01:59:59');
  expect(await local('2026-03-08T07:00:00Z')).toBe('03:00:00');
  // 1 November 2026: 01:00 to 02:00 happens twice, so a window that starts or ends inside
  // that hour is crossed twice.
  expect(await local('2026-11-01T05:30:00Z')).toBe('01:30:00');
  expect(await local('2026-11-01T06:30:00Z')).toBe('01:30:00');
});
