// Canonical SMS schema: isolation, constraints, grants and atomic bounded intake.
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const hex = (length: number) => randomBytes(length).toString('hex').slice(0, length);
const digest = () => hex(64);

/** A business with a sealed-looking secret and a Twilio connection that has a webhook digest. */
async function connection() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const webhookDigest = digest();
  const ids = await database.withTenant(business.context, async (sql) => {
    // These bytes exercise foreign keys only; the vault has its own tests.
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'sms.twilio.credentials', 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))
       returning id`,
      [agency.id, business.id],
    );
    const row = await sql.one<{ id: string }>(
      `insert into messaging.provider_connections
         (agency_id, business_id, provider, label, account_ref, secret_id, account_type, account_status, webhook_digest)
       values ($1, $2, 'twilio', 'Fixture', $3, $4, 'full', 'active', $5) returning id`,
      [agency.id, business.id, `AC${hex(32)}`, secret.id, webhookDigest],
    );
    return { secretId: secret.id, connectionId: row.id };
  });
  return { agency, business, context: business.context, webhookDigest, ...ids };
}

const accept = (webhookDigest: string, endpoint: string, body = 'Body=hi', headers = '{}') =>
  database.as('crm_app', (sql) =>
    sql.one<{ outcome: string; webhook_id: string | null }>(
      'select outcome, webhook_id from private.accept_sms_webhook($1, $2, $3::jsonb, $4)',
      [webhookDigest, endpoint, headers, Buffer.from(body)],
    ),
  );

it('indexes connection references for processed webhooks as well as waiting ones', async () => {
  const support = await database.as('crm_owner', (sql) =>
    sql.one<{ supported: boolean }>(
      `select exists (
         select 1 from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid
           and a.attname = 'provider_connection_id'
         where i.indrelid = 'intake.webhooks'::regclass
           and i.indisvalid and i.indisready
           and i.indkey[0] = a.attnum and i.indpred is null
       ) as supported`,
    ),
  );
  expect(support.supported).toBe(true);
});

it('keeps each business’s attempts, listed numbers and deliveries to itself', async () => {
  const a = await connection();
  const b = await connection();
  await database.withTenant(a.context, async (sql) => {
    await sql.query(
      `insert into messaging.sms_connection_attempts (business_id, label, account_ref, secret_id)
       values ($1, 'Pending', $2, $3)`,
      [a.business.id, `AC${hex(32)}`, a.secretId],
    );
    await sql.query(
      `insert into messaging.provider_numbers (business_id, connection_id, provider_number_ref, e164, capabilities)
       values ($1, $2, $3, '+15017122661', '{sms}')`,
      [a.business.id, a.connectionId, `PN${hex(32)}`],
    );
  });
  for (const table of ['messaging.sms_connection_attempts', 'messaging.provider_numbers']) {
    expect(
      await database.withTenant(a.context, (sql) => sql.query(`select * from ${table}`)),
    ).toHaveLength(1);
    expect(
      await database.withTenant(b.context, (sql) => sql.query(`select * from ${table}`)),
    ).toEqual([]);
  }
  expect(
    await database.withTenant(b.context, (sql) =>
      sql.query('select * from messaging.sms_deliveries'),
    ),
  ).toEqual([]);
  // Writing a row for another business is refused by the row-level policy.
  await expect(
    database.withTenant(b.context, (sql) =>
      sql.query(
        `insert into messaging.provider_numbers (business_id, connection_id, provider_number_ref, e164)
         values ($1, $2, 'PNx', '+15017122662')`,
        [a.business.id, a.connectionId],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  // An attempt can't name another business's secret.
  await expect(
    database.withTenant(b.context, (sql) =>
      sql.query(
        `insert into messaging.sms_connection_attempts (business_id, label, account_ref, secret_id)
         values ($1, 'Other', $2, $3)`,
        [b.business.id, `AC${hex(32)}`, a.secretId],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('allows one pending attempt per account and requires the secret to be cleared on completion', async () => {
  const c = await connection();
  const account = `AC${hex(32)}`;
  const insert = (sql: Parameters<Parameters<typeof database.withTenant>[1]>[0]) =>
    sql.one<{ id: string }>(
      `insert into messaging.sms_connection_attempts (business_id, label, account_ref, secret_id)
       values ($1, 'Pending', $2, $3) returning id`,
      [c.business.id, account, c.secretId],
    );
  const attempt = await database.withTenant(c.context, insert);
  await expect(database.withTenant(c.context, insert)).rejects.toMatchObject({
    code: '23505',
    constraint: 'sms_attempts_pending_account_unique',
  });
  // Connected or failed while still holding the secret: refused.
  for (const change of [
    "status = 'failed', failure_code = 'expired', finished_at = now()",
    "status = 'connected', connection_id = $2, result = '{}', finished_at = now()",
  ])
    await expect(
      database.withTenant(c.context, (sql) =>
        sql.query(
          `update messaging.sms_connection_attempts set ${change} where id = $1`,
          change.includes('$2') ? [attempt.id, c.connectionId] : [attempt.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'sms_attempts_completion_consistent' });
  await database.withTenant(c.context, (sql) =>
    sql.query(
      "update messaging.sms_connection_attempts set status = 'failed', failure_code = 'authentication', secret_id = null, finished_at = now() where id = $1",
      [attempt.id],
    ),
  );
  await expect(
    database.withTenant(c.context, (sql) =>
      sql.query(
        "update messaging.sms_connection_attempts set failure_code = 'because' where id = $1",
        [attempt.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

it('checks the new connection columns and the Twilio Account SID format', async () => {
  const c = await connection();
  const update = (change: string) =>
    database.withTenant(c.context, (sql) =>
      sql.query(`update messaging.provider_connections set ${change} where id = $1`, [
        c.connectionId,
      ]),
    );
  for (const change of [
    "account_type = 'Trial'",
    "account_status = 'gone'",
    "webhook_digest = 'short'",
    "account_ref = 'AC123'",
  ])
    await expect(update(change), change).rejects.toMatchObject({ code: '23514' });
  // Two connections can't share a webhook digest.
  const other = await connection();
  await expect(
    database.as('postgres', (sql) =>
      sql.query('update messaging.provider_connections set webhook_digest = $1 where id = $2', [
        c.webhookDigest,
        other.connectionId,
      ]),
    ),
  ).rejects.toMatchObject({ code: '23505' });
});

it('lists expired pending attempts across businesses, identifiers only', async () => {
  const c = await connection();
  await database.as('postgres', (sql) =>
    sql.query(
      `insert into messaging.sms_connection_attempts (business_id, label, account_ref, secret_id, created_at, expires_at)
       values ($1, 'Old', $2, $3, now() - interval '1 hour', now() - interval '50 minutes')`,
      [c.business.id, `AC${hex(32)}`, c.secretId],
    ),
  );
  const rows = await database.as('crm_app', (sql) =>
    sql.query('select * from private.expired_sms_connection_attempts(1000)'),
  );
  const mine = rows.filter((row) => row['business_id'] === c.business.id);
  expect(mine).toHaveLength(1);
  expect(Object.keys(mine[0] ?? {}).sort()).toEqual(['agency_id', 'attempt_id', 'business_id']);
});

it('stores a webhook and queues its verification in one statement, scoped by the connection', async () => {
  const c = await connection();
  const messageId = '0198a5d0-0000-7000-8000-000000000001';
  const accepted = await accept(
    c.webhookDigest,
    `status?m=${messageId}`,
    'MessageStatus=delivered',
    '{"x-twilio-signature":"abc"}',
  );
  expect(accepted.outcome).toBe('accepted');
  const [stored] = await database.as('postgres', (sql) =>
    sql.query(
      `select provider, endpoint, headers, convert_from(body, 'utf8') as body, signature_valid,
              business_id, provider_connection_id, processed_at
       from intake.webhooks where id = $1`,
      [accepted.webhook_id],
    ),
  );
  expect(stored).toEqual({
    provider: 'twilio',
    endpoint: `status?m=${messageId}`,
    headers: { 'x-twilio-signature': 'abc' },
    body: 'MessageStatus=delivered',
    // Not checked yet: the app can't open the signing secret.
    signature_valid: null,
    business_id: c.business.id,
    provider_connection_id: c.connectionId,
    processed_at: null,
  });
  const jobs = await database.as('postgres', (sql) =>
    sql.query<{ task_identifier: string; queue_name: string; key: string; payload: unknown }>(
      // The public view leaves the payload out; it is in the worker's own table.
      `select j.task_identifier, j.queue_name, j.key, p.payload
       from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id = j.id
       where j.key = $1`,
      [`sms-webhook:${String(accepted.webhook_id)}`],
    ),
  );
  expect(jobs).toEqual([
    {
      task_identifier: 'sms.apply_webhook',
      queue_name: `sms-webhooks:${c.business.id}`,
      key: `sms-webhook:${String(accepted.webhook_id)}`,
      payload: {
        agencyId: c.agency.id,
        businessId: c.business.id,
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        causationId: null,
        data: { webhookId: accepted.webhook_id },
      },
    },
  ]);
});

it('stores nothing for an unknown digest, a malformed request, or a connection that can’t take it', async () => {
  const c = await connection();
  const count = async () =>
    (await database.as('postgres', (sql) => sql.query('select id from intake.webhooks'))).length;
  const before = await count();
  expect((await accept(digest(), 'inbound')).outcome).toBe('unknown');
  expect((await accept('not-a-digest', 'inbound')).outcome).toBe('unknown');
  for (const endpoint of [
    '',
    'other',
    'status',
    'status?m=x',
    'inbound?m=1',
    '/webhooks/twilio/x/inbound',
  ])
    expect((await accept(c.webhookDigest, endpoint)).outcome, endpoint).toBe('refused');
  expect((await accept(c.webhookDigest, 'inbound', 'x'.repeat(65_537))).outcome).toBe('refused');
  expect((await accept(c.webhookDigest, 'inbound', 'Body=hi', '[]')).outcome).toBe('refused');
  expect(
    (await accept(c.webhookDigest, 'inbound', 'Body=hi', JSON.stringify({ big: 'x'.repeat(5000) })))
      .outcome,
  ).toBe('refused');
  expect(await count()).toBe(before);

  await database.as('postgres', (sql) =>
    sql.query("update messaging.provider_connections set status = 'disconnected' where id = $1", [
      c.connectionId,
    ]),
  );
  expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('unknown');
  const suspended = await connection();
  await database.as('postgres', (sql) =>
    sql.query("update tenancy.businesses set status = 'suspended' where id = $1", [
      suspended.business.id,
    ]),
  );
  expect((await accept(suspended.webhookDigest, 'inbound')).outcome).toBe('unknown');
  expect(await count()).toBe(before);
});

it('fails closed at 500 waiting requests for one connection, without affecting another', async () => {
  const c = await connection();
  const other = await connection();
  await database.as('postgres', (sql) =>
    sql.query(
      `insert into intake.webhooks (provider, endpoint, headers, body, signature_valid, business_id, provider_connection_id,received_at)
       select 'twilio', 'inbound', '{}', ''::bytea, null, $1, $2,clock_timestamp()-interval '2 minutes' from generate_series(1, 499)`,
      [c.business.id, c.connectionId],
    ),
  );
  expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('accepted');
  expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('over_capacity');
  expect((await accept(other.webhookDigest, 'inbound')).outcome).toBe('accepted');
  // Verified or refused requests no longer count.
  await database.as('postgres', (sql) =>
    sql.query('update intake.webhooks set processed_at = now() where provider_connection_id = $1', [
      c.connectionId,
    ]),
  );
  expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('accepted');
});

it('admits only one concurrent connection into the final global waiting slot', async () => {
  const seed = await connection();
  const first = await connection();
  const second = await connection();
  const barrier = 459271;
  await database.as('postgres', async (sql) => {
    await sql.query(
      `with accounts as (
         insert into messaging.provider_connections
           (agency_id,business_id,provider,label,account_ref,secret_id,account_type,account_status)
         select $1,$2,'twilio','Capacity fixture','AC'||md5(n::text),$3,'full','active'
         from generate_series(1,40) n returning id
       ), numbered as (select id,row_number() over(order by id) as position from accounts)
       insert into intake.webhooks
         (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at)
       select 'twilio','inbound','{}',''::bytea,null,$2,id,clock_timestamp()-interval '2 minutes'
       from numbered cross join generate_series(1,500) slot
       where (position-1)*500+slot <= 19999-(
         select count(*) from intake.webhooks
         where provider_connection_id is not null and processed_at is null
       )`,
      [seed.agency.id, seed.business.id, seed.secretId],
    );
    // Pause real inserts after admission checks. Both calls are observed waiting on
    // actual PostgreSQL locks; with global serialization the second waits upstream.
    await sql.query(`
      create function util.sms_capacity_test_barrier() returns trigger
      language plpgsql as $$ begin
        perform pg_advisory_xact_lock_shared(${String(barrier)});
        return new;
      end $$;
      create trigger sms_capacity_test_barrier before insert on intake.webhooks
      for each row execute function util.sms_capacity_test_barrier()
    `);
  });
  await database.as('postgres', async (sql) => {
    await sql.query('select pg_advisory_lock($1)', [barrier]);
    const pending = Promise.all([
      accept(first.webhookDigest, 'inbound'),
      accept(second.webhookDigest, 'inbound'),
    ]);
    try {
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      while (waiting < 2 && Date.now() < deadline) {
        const row = await database.as('postgres', (observer) =>
          observer.one<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
           where datname=current_database() and wait_event_type='Lock'
             and query like '%private.accept_sms_webhook%'`,
          ),
        );
        waiting = row.waiting;
        if (waiting < 2) await delay(5);
      }
      expect(waiting).toBe(2);
    } finally {
      await sql.query('select pg_advisory_unlock($1)', [barrier]);
    }
    try {
      const outcomes = await pending;
      expect(outcomes.map((row) => row.outcome).sort()).toEqual(['accepted', 'over_capacity']);
      const count = await sql.one<{ waiting: number }>(
        `select count(*)::int as waiting from intake.webhooks
         where provider_connection_id is not null and processed_at is null`,
      );
      expect(count.waiting).toBe(20_000);
    } finally {
      await pending;
      await sql.query('drop trigger sms_capacity_test_barrier on intake.webhooks');
      await sql.query('drop function util.sms_capacity_test_barrier()');
      await sql.query(`delete from intake.webhooks where business_id=any($1::uuid[])`, [
        [seed.business.id, first.business.id, second.business.id],
      ]);
    }
  });
});

it('counts processed invalid requests toward the connection minute limit and leaves another connection available', async () => {
  const c = await connection();
  const other = await connection();
  try {
    await database.as('postgres', (sql) =>
      sql.query(
        `insert into intake.webhooks
          (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at,processed_at)
         select 'twilio','inbound','{}',''::bytea,false,$1,$2,clock_timestamp()-interval '30 seconds',now()
         from generate_series(1,59)`,
        [c.business.id, c.connectionId],
      ),
    );
    expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('accepted');
    expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('over_capacity');
    expect((await accept(other.webhookDigest, 'inbound')).outcome).toBe('accepted');
  } finally {
    await database.as('postgres', (sql) =>
      sql.query('delete from intake.webhooks where business_id=any($1::uuid[])', [
        [c.business.id, other.business.id],
      ]),
    );
  }
});

it('timestamps admission at the current clock rather than the transaction start', async () => {
  const c = await connection();
  const admission = await database.as('crm_app', async (sql) => {
    const { observed } = await sql.one<{ observed: string }>(
      'select clock_timestamp()::text as observed',
    );
    const accepted = await sql.one<{ outcome: string; webhook_id: string }>(
      'select outcome,webhook_id from private.accept_sms_webhook($1,$2,$3::jsonb,$4)',
      [c.webhookDigest, 'inbound', '{}', Buffer.from('Body=hi')],
    );
    return { accepted, observed };
  });
  expect(admission.accepted.outcome).toBe('accepted');
  expect(
    await database.as('postgres', (observer) =>
      observer.one<{ current_clock: boolean }>(
        'select received_at >= $2::timestamptz as current_clock from intake.webhooks where id=$1',
        [admission.accepted.webhook_id, admission.observed],
      ),
    ),
  ).toEqual({ current_clock: true });
});

it('counts processed requests toward the global minute limit before storing or queuing more work', async () => {
  const seed = await connection();
  const target = await connection();
  try {
    await database.as('postgres', (sql) =>
      sql.query(
        `insert into intake.webhooks
          (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at,processed_at)
         select 'twilio','inbound','{}',''::bytea,true,$1,$2,clock_timestamp()-interval '30 seconds',now()
         from generate_series(1,1000-(
           select count(*)::int from intake.webhooks
           where provider_connection_id is not null and received_at>clock_timestamp()-interval '1 minute'
         ))`,
        [seed.business.id, seed.connectionId],
      ),
    );
    expect((await accept(target.webhookDigest, 'inbound')).outcome).toBe('over_capacity');
    expect(
      await database.as('postgres', (sql) =>
        sql.query('select id from intake.webhooks where business_id=$1', [target.business.id]),
      ),
    ).toEqual([]);
  } finally {
    await database.as('postgres', (sql) =>
      sql.query('delete from intake.webhooks where business_id=any($1::uuid[])', [
        [seed.business.id, target.business.id],
      ]),
    );
  }
});

it('bounds retained connection bytes including headers after verification has completed', async () => {
  const c = await connection();
  try {
    await database.as('postgres', (sql) =>
      sql.query(
        `insert into intake.webhooks
          (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at,processed_at)
         select 'twilio','inbound','{}',convert_to(repeat('x',65534),'utf8'),true,$1,$2,
           clock_timestamp()-interval '2 minutes',now()
         from generate_series(1,256)`,
        [c.business.id, c.connectionId],
      ),
    );
    expect((await accept(c.webhookDigest, 'inbound', '')).outcome).toBe('over_capacity');
    expect(
      await database.as('postgres', (sql) =>
        sql.one<{ count: number }>(
          'select count(*)::int as count from intake.webhooks where provider_connection_id=$1',
          [c.connectionId],
        ),
      ),
    ).toEqual({ count: 256 });
  } finally {
    await database.as('postgres', (sql) =>
      sql.query('delete from intake.webhooks where provider_connection_id=$1', [c.connectionId]),
    );
  }
});

it('admits exactly the remaining connection bytes and releases retained capacity after deletion', async () => {
  const c = await connection();
  try {
    await database.as('postgres', (sql) =>
      sql.query(
        `insert into intake.webhooks
          (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at,processed_at)
         select 'twilio','inbound','{}',convert_to(repeat('x',case when n=256 then 65525 else 65534 end),'utf8'),true,$1,$2,
           clock_timestamp()-interval '2 minutes',now()
         from generate_series(1,256) n`,
        [c.business.id, c.connectionId],
      ),
    );
    // Body=hi is seven bytes; the serialized empty header object contributes two.
    expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('accepted');
    expect((await accept(c.webhookDigest, 'inbound', '')).outcome).toBe('over_capacity');
    await database.as('postgres', (sql) =>
      sql.query('delete from intake.webhooks where provider_connection_id=$1', [c.connectionId]),
    );
    expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('accepted');
  } finally {
    await database.as('postgres', (sql) =>
      sql.query('delete from intake.webhooks where provider_connection_id=$1', [c.connectionId]),
    );
  }
});

it('never admits another provider through the Twilio intake capability', async () => {
  const c = await connection();
  await database.as('postgres', (sql) =>
    sql.query("update messaging.provider_connections set provider='telnyx' where id=$1", [
      c.connectionId,
    ]),
  );
  expect((await accept(c.webhookDigest, 'inbound')).outcome).toBe('unknown');
  expect(
    await database.as('postgres', (sql) =>
      sql.query('select id from intake.webhooks where provider_connection_id=$1', [c.connectionId]),
    ),
  ).toEqual([]);
});

it.each([
  ['connection', 5000, 1],
  ['install', 100000, 20],
] as const)('bounds retained %s rows even when none are waiting', async (scope, rows, members) => {
  const seed = await connection();
  const target = scope === 'connection' ? seed : await connection();
  try {
    await database.as('postgres', async (sql) => {
      if (scope === 'connection') {
        await sql.query(
          `insert into intake.webhooks
            (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at,processed_at)
           select 'twilio','inbound','{}',''::bytea,true,$1,$2,clock_timestamp()-interval '2 minutes',now()
           from generate_series(1,$3::int)`,
          [seed.business.id, seed.connectionId, rows],
        );
      } else {
        await sql.query(
          `with accounts as (
             insert into messaging.provider_connections
               (agency_id,business_id,provider,label,account_ref,secret_id,account_type,account_status)
             select $1,$2,'twilio','Retention fixture','AC'||md5(n::text),$3,'full','active'
             from generate_series(1,$4::int) n returning id
           )
           insert into intake.webhooks
             (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at,processed_at)
           select 'twilio','inbound','{}',''::bytea,true,$2,id,clock_timestamp()-interval '2 minutes',now()
           from accounts cross join generate_series(1,$5::int)`,
          [seed.agency.id, seed.business.id, seed.secretId, members, rows / members],
        );
      }
    });
    expect((await accept(target.webhookDigest, 'inbound')).outcome).toBe('over_capacity');
  } finally {
    await database.as('postgres', (sql) =>
      sql.query('delete from intake.webhooks where business_id=any($1::uuid[])', [
        [seed.business.id, target.business.id],
      ]),
    );
  }
});

it('bounds retained install bytes across distinct connections after all requests were processed', async () => {
  const seed = await connection();
  const target = await connection();
  try {
    await database.as('postgres', (sql) =>
      sql.query(
        `with accounts as (
           insert into messaging.provider_connections
             (agency_id,business_id,provider,label,account_ref,secret_id,account_type,account_status)
           select $1,$2,'twilio','Byte fixture','AC'||md5(n::text),$3,'full','active'
           from generate_series(1,16) n returning id
         )
         insert into intake.webhooks
           (provider,endpoint,headers,body,signature_valid,business_id,provider_connection_id,received_at,processed_at)
         select 'twilio','inbound','{}',convert_to(repeat('x',65534),'utf8'),true,$2,id,
           clock_timestamp()-interval '2 minutes',now()
         from accounts cross join generate_series(1,256)`,
        [seed.agency.id, seed.business.id, seed.secretId],
      ),
    );
    expect((await accept(target.webhookDigest, 'inbound', '')).outcome).toBe('over_capacity');
  } finally {
    await database.as('postgres', (sql) =>
      sql.query('delete from intake.webhooks where business_id=any($1::uuid[])', [
        [seed.business.id, target.business.id],
      ]),
    );
  }
});

it('queues a stored webhook again only for its own business', async () => {
  const c = await connection();
  const other = await connection();
  const accepted = await accept(c.webhookDigest, 'inbound');
  const requeue = (context: typeof c.context, delay: number) =>
    database.withTenant(context, (sql) =>
      sql.query('select private.enqueue_sms_webhook($1::uuid, $2::integer)', [
        accepted.webhook_id,
        delay,
      ]),
    );
  await requeue(c.context, 5);
  const jobs = await database.as('postgres', (sql) =>
    sql.query<{ later: boolean; soon: boolean }>(
      "select run_at > now() as later, run_at < now() + interval '1 minute' as soon from graphile_worker.jobs where key = $1",
      [`sms-webhook:${String(accepted.webhook_id)}`],
    ),
  );
  // Replaced, not added: still one job, now delayed.
  expect(jobs).toEqual([{ later: true, soon: true }]);
  await expect(requeue(other.context, 0)).rejects.toThrow(
    'webhook is not available in this context',
  );
  // The delay is bounded, whatever is asked for.
  await requeue(c.context, 1_000_000);
  expect(
    await database.as('postgres', (sql) =>
      sql.query(
        "select run_at <= now() + interval '301 seconds' as bounded from graphile_worker.jobs where key = $1",
        [`sms-webhook:${String(accepted.webhook_id)}`],
      ),
    ),
  ).toEqual([{ bounded: true }]);
});

it('expires stored webhooks by their retention rule, and leaves other providers’ rows alone', async () => {
  const c = await connection();
  const row = async (age: string, valid: boolean | null, processed: boolean, linked = true) =>
    (
      await database.as('postgres', (sql) =>
        sql.one<{ id: string }>(
          `insert into intake.webhooks (provider, endpoint, headers, body, signature_valid, business_id, provider_connection_id, received_at, processed_at)
           values ('twilio', 'inbound', '{}', ''::bytea, $1, $2, $3, now() - $4::interval, case when $5 then now() end)
           returning id`,
          [valid, c.business.id, linked ? c.connectionId : null, age, processed],
        ),
      )
    ).id;
  const keep = [
    await row('29 days', true, true),
    await row('23 hours', false, true),
    await row('6 days', null, false),
    // Not linked to a provider connection: some other provider's webhook, left alone.
    await row('90 days', true, true, false),
  ];
  const drop = [
    await row('31 days', true, true),
    await row('2 days', false, true),
    await row('8 days', null, false),
  ];
  await database.as('crm_app', (sql) => sql.query('select private.expire_sms_webhooks(10000)'));
  const left = await database.as('postgres', (sql) =>
    sql.query<{ id: string }>('select id from intake.webhooks where id = any($1)', [
      [...keep, ...drop],
    ]),
  );
  expect(left.map((each) => each.id).sort()).toEqual([...keep].sort());
});

it('lets the app write deliveries but never delete them, and only for its own message', async () => {
  const c = await connection();
  // crm_app has no DELETE on messaging.sms_deliveries.
  await expect(
    database.withTenant(c.context, (sql) => sql.query('delete from messaging.sms_deliveries')),
  ).rejects.toMatchObject({ code: '42501' });
  // A delivery needs a message of the same business.
  await expect(
    database.withTenant(c.context, (sql) =>
      sql.query(
        `insert into messaging.sms_deliveries (business_id, message_id, provider_status, status_rank)
         values ($1, uuidv7(), 'queued', 1)`,
        [c.business.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
  for (const [status, rank] of [
    ['received', 1],
    ['queued', 0],
    ['queued', 6],
  ] as const)
    await expect(
      database.withTenant(c.context, (sql) =>
        sql.query(
          `insert into messaging.sms_deliveries (business_id, message_id, provider_status, status_rank)
           values ($1, uuidv7(), $2, $3)`,
          [c.business.id, status, rank],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
});

it('registers a provider number once per connection', async () => {
  const c = await connection();
  const ref = `PN${hex(32)}`;
  const register = (e164: string) =>
    database.withTenant(c.context, async (sql) => {
      const account = await sql.one<{ id: string }>(
        "insert into messaging.channel_accounts (business_id, channel, name) values ($1, 'sms', 'Line') returning id",
        [c.business.id],
      );
      await sql.query(
        `insert into messaging.phone_numbers (business_id, id, e164, provider_connection_id, provider_number_ref)
         values ($1, $2, $3, $4, $5)`,
        [c.business.id, account.id, e164, c.connectionId, ref],
      );
    });
  const digits = () => String(2_000_000 + Math.floor(Math.random() * 7_000_000));
  await register(`+1501${digits()}`);
  await expect(register(`+1501${digits()}`)).rejects.toMatchObject({
    code: '23505',
    constraint: 'phone_numbers_provider_ref_unique',
  });
});

it('keeps the three functions away from every role but the app', async () => {
  const c = await connection();
  for (const call of [
    "select * from private.accept_sms_webhook('x', 'inbound', '{}'::jsonb, ''::bytea)",
    'select private.enqueue_sms_webhook(uuidv7(), 0)',
    'select private.expire_sms_webhooks(1)',
    'select * from private.expired_sms_connection_attempts(1)',
  ])
    await expect(
      database.as('crm_auth', (sql) => sql.query(call)),
      call,
    ).rejects.toMatchObject({
      code: '42501',
    });
  expect(c.connectionId).toBeDefined();
});
