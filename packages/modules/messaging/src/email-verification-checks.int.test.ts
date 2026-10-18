// What other modules ask of email verification: a check made now for a workflow step,
// with a recent result reused and no lock held while the provider answers; the checks a
// bulk action queues within the day's limit; the preview of what those would do; and the
// one-word state a condition reads. Real Postgres; the provider and DNS are stand-ins.
import { randomUUID } from 'node:crypto';

import { runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { fixtureResolver } from '@repo/mail-checks/testing';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it, vi } from 'vitest';

import {
  checkEmailAddressNow,
  emailVerificationState,
  previewContactEmailChecks,
  startContactEmailChecks,
  BULK_CHECK_PRIORITY,
} from './email-verification-checks.js';
import { emailAddressCommands, queueEmailVerification } from './email-verification.js';
import { createVerifyEmailAddressTask } from './email-verification-task.js';
import { toPublicId } from '@repo/kernel';

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

const resolve = fixtureResolver({
  'example.com': { MX: [{ exchange: 'mail.example.com', priority: 10 }] },
});
const result = (status: 'valid' | 'risky' | 'invalid' | 'unknown') => ({
  kind: 'result' as const,
  status,
  reasons: [],
  raw: { state: status, reason: null },
  charged: status !== 'unknown',
});

async function fixture(options: { limit?: number; connected?: boolean } = {}) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = {
    ...business.context,
    correlationId: randomUUID(),
    actorKind: 'system' as const,
  };
  const invocation: Invocation = { context, permissions: 'all' };
  const services: Services = { db, authorize: () => true };
  await database.withTenant(context, async (client) => {
    await client.query(
      'insert into messaging.settings (business_id,email_verification_daily_limit,quiet_hours_enabled) values (app.business_id(),$1,false)',
      [options.limit ?? 1000],
    );
    if (options.connected === true) {
      const secret = await client.one<{ id: string }>(
        "insert into vault.secrets (agency_id,business_id,purpose,key_version,enc,ciphertext) values ($1,app.business_id(),'email.emailable.key',1,decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex')) returning id",
        [context.agencyId],
      );
      await client.query(
        "insert into messaging.provider_connections (agency_id,business_id,provider,label,account_ref,secret_id,status) values ($1,app.business_id(),'emailable','Checks','verification',$2,'connected')",
        [context.agencyId, secret.id],
      );
    }
  });
  const verify = vi.fn(() => Promise.resolve(result('valid')));
  const provider = {
    name: 'emailable',
    verify,
    account: () => Promise.resolve({ kind: 'ok' as const, availableCredits: 10, testMode: true }),
  };
  const contact = async (email?: string) => {
    const made = await database.fixtures.contact(
      business.context,
      email === undefined ? {} : { email },
    );
    return made.id;
  };
  const tx = <T>(work: (trx: DatabaseTransaction) => Promise<T>) => withTenant(db, context, work);
  const row = (address: string) =>
    database.withTenant(context, (client) =>
      client.one<{
        status: string | null;
        current_check_id: string | null;
        next_attempt_at: Date | null;
        excluded: boolean;
      }>(
        'select status,current_check_id,next_attempt_at,excluded from messaging.email_verifications where address_normalized=$1',
        [address],
      ),
    );
  const jobs = () =>
    database.as('crm_owner', (client) =>
      client.query<{ n: string }>(
        "select count(*)::text as n from graphile_worker._private_jobs where key like 'email-verification:%' and payload->>'businessId'=$1",
        [context.businessId],
      ),
    );
  const now = (address: string, maxAgeDays = 90) =>
    checkEmailAddressNow(services, invocation, { address, maxAgeDays }, { resolve, provider });
  return { context, invocation, services, provider, verify, contact, tx, row, jobs, now };
}

it('checks an address now and answers what the provider found, at its cost', async () => {
  const f = await fixture();
  expect(await f.now('Ada@Example.com')).toEqual({
    kind: 'checked',
    reused: false,
    status: 'valid',
    depth: 'mailbox',
  });
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(await f.tx((trx) => emailVerificationState(trx, 'ada@example.com'))).toBe('valid');
  expect(
    await database.withTenant(f.context, (client) =>
      client.query('select charged,outcome from messaging.email_verification_checks'),
    ),
  ).toEqual([{ charged: true, outcome: 'valid' }]);
});

it('reuses a result no older than asked, and checks again once it is', async () => {
  const f = await fixture();
  await f.now('ada@example.com');
  expect(await f.now('ada@example.com', 30)).toMatchObject({ kind: 'checked', reused: true });
  expect(f.verify).toHaveBeenCalledTimes(1);
  await database.withTenant(f.context, (client) =>
    client.query("update messaging.email_verifications set checked_at=now()-interval '31 days'"),
  );
  f.verify.mockResolvedValueOnce(result('risky'));
  expect(await f.now('ada@example.com', 30)).toEqual({
    kind: 'checked',
    reused: false,
    status: 'risky',
    depth: 'mailbox',
  });
  expect(f.verify).toHaveBeenCalledTimes(2);
});

it('holds no lock on the business or the address while the provider answers', async () => {
  const f = await fixture();
  f.verify.mockImplementationOnce(async () => {
    await withTenant(db, f.context, async (trx) => {
      await sql`select id from tenancy.businesses where id=${f.context.businessId}::uuid for update nowait`.execute(
        trx,
      );
      await sql`select id from messaging.email_verifications for update nowait`.execute(trx);
    });
    return result('valid');
  });
  expect(await f.now('ada@example.com')).toMatchObject({ kind: 'checked', status: 'valid' });
});

it('says an excluded address is excluded, and checks nothing while verification is off', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (client) =>
    client.query(
      "insert into messaging.email_verifications (business_id,address_normalized,excluded) values (app.business_id(),'ada@example.com',true)",
    ),
  );
  expect(await f.now('ada@example.com')).toEqual({ kind: 'excluded' });
  expect(await f.tx((trx) => emailVerificationState(trx, 'ada@example.com'))).toBe('excluded');
  await database.withTenant(f.context, (client) =>
    client.query('update messaging.settings set email_verification_enabled=false'),
  );
  expect(await f.now('bea@example.com')).toEqual({ kind: 'off' });
  expect(f.verify).not.toHaveBeenCalled();
  expect(await f.tx((trx) => emailVerificationState(trx, 'bea@example.com'))).toBe('unchecked');
});

it('makes the pending check rather than a second one, so it is paid for once', async () => {
  const f = await fixture();
  const contactId = await f.contact('ada@example.com');
  const identity = await database.withTenant(f.context, (client) =>
    client.one<{ id: string }>('select id from crm.contact_identities where contact_id=$1', [
      contactId,
    ]),
  );
  await runCommand(
    f.services,
    emailAddressCommands.verify,
    {
      contactId: toPublicId('contact', contactId),
      addressId: toPublicId('contact_identity', identity.id),
    },
    f.invocation,
  );
  const pending = (await f.row('ada@example.com')).current_check_id;
  expect(await f.now('ada@example.com')).toMatchObject({ kind: 'checked', reused: false });
  // The queued job of that same check then finds it made, and asks nothing.
  await createVerifyEmailAddressTask({ resolve, provider: f.provider }).run(
    {
      verificationId: (
        await database.withTenant(f.context, (client) =>
          client.one<{ id: string }>('select id from messaging.email_verifications'),
        )
      ).id,
      checkId: pending ?? '',
    },
    { invocation: f.invocation, services: f.services },
  );
  expect(f.verify).toHaveBeenCalledTimes(1);
});

it('records a check whose run was lost as abandoned, with no second paid call', async () => {
  const f = await fixture();
  const lost = randomUUID();
  await database.withTenant(f.context, (client) =>
    client.query(
      "insert into messaging.email_verifications (business_id,address_normalized,current_check_id,claimed_check_id,claimed_at,provider_reserved_at) values (app.business_id(),'ada@example.com',$1,$1,now()-interval '5 minutes',now()-interval '5 minutes')",
      [lost],
    ),
  );
  expect(await f.now('ada@example.com')).toEqual({
    kind: 'checked',
    reused: false,
    status: 'unknown',
    depth: 'domain',
  });
  expect(f.verify).not.toHaveBeenCalled();
  expect(
    await database.withTenant(f.context, (client) =>
      client.query('select id,charged,outcome from messaging.email_verification_checks'),
    ),
  ).toEqual([{ id: lost, charged: false, outcome: 'abandoned' }]);
});

it('says what the run did when it recorded nothing, never an old result as new', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (client) =>
    client.query(
      "insert into messaging.email_verifications (business_id,address_normalized,status,depth,checked_at) values (app.business_id(),'old@example.com','valid','mailbox',now()-interval '400 days')",
    ),
  );
  // Verification is turned off after the check was decided and before it is claimed.
  let transactions = 0;
  const turnedOff = new Proxy(db, {
    get(target, property) {
      if (property !== 'transaction') return Reflect.get(target, property, target) as unknown;
      return () => {
        const transaction = target.transaction();
        transactions += 1;
        if (transactions !== 2) return transaction;
        return {
          execute: async (work: Parameters<typeof transaction.execute>[0]) => {
            await database.withTenant(f.context, (client) =>
              client.query('update messaging.settings set email_verification_enabled=false'),
            );
            return transaction.execute(work);
          },
        };
      };
    },
  });
  expect(
    await checkEmailAddressNow(
      { ...f.services, db: turnedOff },
      f.invocation,
      { address: 'old@example.com', maxAgeDays: 90 },
      { resolve, provider: f.provider },
    ),
  ).toEqual({ kind: 'off' });
  expect(f.verify).not.toHaveBeenCalled();
});

it('waits while another run is calling, and when the provider asks to wait', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (client) =>
    client.query(
      "insert into messaging.email_verifications (business_id,address_normalized,current_check_id,claimed_check_id,claimed_at) values (app.business_id(),'ada@example.com',$1,$1,now())",
      [randomUUID()],
    ),
  );
  const busy = await f.now('ada@example.com');
  expect(busy).toMatchObject({ kind: 'waiting' });
  expect(f.verify).not.toHaveBeenCalled();

  f.verify.mockResolvedValueOnce({
    kind: 'failed',
    problem: 'rate_limited',
    connectionFailing: false,
    retryAfterMs: 20_000,
  } as never);
  const limited = await f.now('bea@example.com');
  expect(limited).toMatchObject({ kind: 'waiting' });
  if (limited.kind !== 'waiting') throw new Error('Expected to wait.');
  expect(limited.retryAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
  expect((await f.row('bea@example.com')).status).toBeNull();
  // Asked again before then, it still waits, and asks the provider nothing.
  expect(await f.now('bea@example.com')).toMatchObject({ kind: 'waiting' });
  expect(f.verify).toHaveBeenCalledTimes(1);
});

/** Queues contacts' checks as one batch of a bulk action does, from its first place. */
const queueAll = (
  f: Awaited<ReturnType<typeof fixture>>,
  ids: readonly string[],
  since = new Date(),
) =>
  f.tx(async (trx) => {
    const batch = await startContactEmailChecks(trx);
    const outcomes = [];
    for (const [index, id] of ids.entries())
      outcomes.push(await batch.queue(trx, id, { position: index + 1, since }));
    return outcomes;
  });

/** The verification jobs as graphile-worker takes them: priority first, then time. */
const queue = (f: Awaited<ReturnType<typeof fixture>>) =>
  database.as('crm_owner', (client) =>
    client.query<{ key: string | null; priority: number; run_at: Date }>(
      `select key, priority, run_at from graphile_worker._private_jobs
       where payload->>'businessId' = $1 order by priority asc, run_at asc, id asc`,
      [f.context.businessId],
    ),
  );

it('queues a contact’s check, keeps a current result, and skips what it cannot check', async () => {
  const f = await fixture();
  const fresh = await f.contact('fresh@example.com');
  const stale = await f.contact('stale@example.com');
  const excluded = await f.contact('out@example.com');
  const none = await f.contact();
  const unknown = await f.contact('unknown@example.com');
  await database.withTenant(f.context, (client) =>
    client.query(
      `insert into messaging.email_verifications (business_id,address_normalized,status,depth,checked_at,excluded) values
        (app.business_id(),'fresh@example.com','valid','domain',now()-interval '10 days',false),
        (app.business_id(),'stale@example.com','valid','mailbox',now()-interval '100 days',false),
        (app.business_id(),'out@example.com',null,null,null,true),
        (app.business_id(),'unknown@example.com','unknown','domain',now(),false)`,
    ),
  );
  // Without a provider, a domain result is as deep as a check can go: it is current.
  expect(await queueAll(f, [fresh, stale, excluded, none, unknown])).toEqual([
    'current',
    'queued',
    'excluded',
    'no_email',
    'queued',
  ]);
  expect((await f.row('stale@example.com')).current_check_id).not.toBeNull();
  expect(await f.jobs()).toEqual([{ n: '2' }]);
  // Asked again, a pending check is left as it is queued, never doubled.
  expect(await queueAll(f, [stale])).toEqual(['queued']);
  expect(await f.jobs()).toEqual([{ n: '2' }]);
  // Re-verification after 90 days turned off keeps old results for sending, but a bulk
  // check still counts its own 90 days.
  await database.withTenant(f.context, (client) =>
    client.query(
      "update messaging.settings set email_reverify_after_90_days=false; update messaging.email_verifications set current_check_id=null where address_normalized='stale@example.com'",
    ),
  );
  expect(await queueAll(f, [stale])).toEqual(['queued']);
  await database.withTenant(f.context, (client) =>
    client.query('update messaging.settings set email_verification_enabled=false'),
  );
  expect(await queueAll(f, [fresh])).toEqual(['off']);
});

it('with a provider connected, counts only a recent mailbox result as current', async () => {
  const f = await fixture({ connected: true });
  const ids = [
    await f.contact('mailbox@example.com'),
    await f.contact('domain@example.com'),
    await f.contact('unknown@example.com'),
    await f.contact('invalid@example.com'),
  ];
  await database.withTenant(f.context, (client) =>
    client.query(
      `insert into messaging.email_verifications (business_id,address_normalized,status,depth,checked_at) values
        (app.business_id(),'mailbox@example.com','risky','mailbox',now()-interval '5 days'),
        (app.business_id(),'domain@example.com','valid','domain',now()-interval '5 days'),
        (app.business_id(),'unknown@example.com','unknown','mailbox',now()-interval '5 days'),
        (app.business_id(),'invalid@example.com','invalid','mailbox',now()-interval '5 days')`,
    ),
  );
  expect(await f.tx((trx) => previewContactEmailChecks(trx, ids))).toMatchObject({
    current: 2,
    checks: 2,
  });
  expect(await queueAll(f, ids)).toEqual(['current', 'queued', 'queued', 'current']);
  // The step checks a domain-only result again, and uses a recent mailbox result.
  await database.withTenant(f.context, (client) =>
    client.query(
      "update messaging.email_verifications set current_check_id=null where address_normalized='domain@example.com'",
    ),
  );
  expect(await f.now('domain@example.com', 30)).toMatchObject({ kind: 'checked', reused: false });
  expect(await f.now('mailbox@example.com', 30)).toMatchObject({ kind: 'checked', reused: true });
  expect(f.verify).toHaveBeenCalledTimes(1);
});

it('queues bulk checks behind other work, paced, so a job queued later runs first', async () => {
  const f = await fixture({ connected: true });
  const ids = [await f.contact('a@example.com'), await f.contact('b@example.com')];
  // A start ahead of the database's clock: a place in the past runs at now(), and this
  // machine's clock and the database's can differ by a few milliseconds.
  const since = new Date(Date.now() + 60_000);
  expect(await queueAll(f, ids, since)).toEqual(['queued', 'queued']);
  // A send held for a check of another address, queued after the bulk action.
  await f.tx(async (trx) => {
    await queueEmailVerification(trx, 'later@example.com');
  });
  const jobs = await queue(f);
  expect(jobs.map((job) => job.priority)).toEqual([0, BULK_CHECK_PRIORITY, BULK_CHECK_PRIORITY]);
  const [, first, second] = jobs;
  // One provider check a second, from when the action started.
  expect((second?.run_at.getTime() ?? 0) - (first?.run_at.getTime() ?? 0)).toBe(1000);
  // A send that needs a check a bulk action already queued takes it to the front.
  await f.tx(async (trx) => {
    await queueEmailVerification(trx, 'b@example.com');
  });
  expect((await queue(f)).map((job) => job.priority)).toEqual([0, 0, BULK_CHECK_PRIORITY]);
  // And a bulk action never moves a check something else is waiting for to the back.
  expect(await queueAll(f, [await f.contact('later@example.com')])).toEqual(['queued']);
  expect((await queue(f)).map((job) => job.priority)).toEqual([0, 0, BULK_CHECK_PRIORITY]);
});

it('queues no more provider checks than the day’s limit leaves, counting those waiting', async () => {
  const f = await fixture({ limit: 2, connected: true });
  const ids = [
    await f.contact('a@example.com'),
    await f.contact('b@example.com'),
    await f.contact('c@example.com'),
  ];
  expect(await queueAll(f, ids)).toEqual(['queued', 'queued', 'daily_limit']);
  // Checks already waiting count against the day in the next batch too.
  expect(await queueAll(f, [await f.contact('d@example.com')])).toEqual(['daily_limit']);
  // A contact whose check is already waiting needs none of what is left.
  expect(await queueAll(f, [ids[0] ?? ''])).toEqual(['queued']);
  // Without a working provider only the free checks run, which have no limit.
  const free = await fixture({ limit: 0 });
  const id = await free.contact('d@example.com');
  expect(await queueAll(free, [id])).toEqual(['queued']);
});

it('previews what checking contacts would do, as the queue would decide each', async () => {
  const f = await fixture({ limit: 3, connected: true });
  const ids = [
    await f.contact('fresh@example.com'),
    await f.contact('out@example.com'),
    await f.contact(),
    await f.contact('a@example.com'),
    await f.contact('b@example.com'),
    await f.contact('c@example.com'),
  ];
  await database.withTenant(f.context, (client) =>
    client.query(
      `insert into messaging.email_verifications (business_id,address_normalized,status,depth,checked_at,excluded) values
        (app.business_id(),'fresh@example.com','risky','mailbox',now(),false),
        (app.business_id(),'out@example.com','valid','mailbox',now(),true)`,
    ),
  );
  // One check was made today already: two are left.
  await database.withTenant(f.context, (client) =>
    client.query(
      "insert into messaging.email_verification_checks (business_id,id,address_normalized,provider,charged,outcome,actor_kind) values (app.business_id(),$1,'fresh@example.com','emailable',true,'risky','system')",
      [randomUUID()],
    ),
  );
  expect(await f.tx((trx) => previewContactEmailChecks(trx, [...ids, ids[0] ?? '']))).toEqual({
    contacts: 6,
    noEmail: 1,
    excluded: 1,
    current: 1,
    checks: 3,
    providerCalls: 2,
    overLimit: 1,
    remainingToday: 2,
    provider: 'connected',
    enabled: true,
  });
  const free = await fixture();
  const id = await free.contact('e@example.com');
  expect(await free.tx((trx) => previewContactEmailChecks(trx, [id]))).toMatchObject({
    checks: 1,
    providerCalls: 0,
    overLimit: 0,
    remainingToday: null,
    provider: null,
  });
});
