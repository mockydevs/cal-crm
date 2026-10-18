import { randomUUID } from 'node:crypto';
import { runCommand, type JobRun } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import type { MailboxOutcome, ProviderProblem } from '@repo/email-checks';
import { fixtureResolver } from '@repo/mail-checks/testing';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it, vi } from 'vitest';
import { createVerifyEmailAddressTask } from './email-verification-task.js';
import {
  emailAddressCommands,
  emailVerificationAdmission,
  readEmailVerification,
} from './email-verification.js';
import {
  queueOutboundMessage,
  createDispatchOutboundTask,
  type OutboundSender,
} from './outbound.js';
import { recordBounceCommand } from './bounces.js';
import { sql } from 'kysely';

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

async function fixture(status: 'valid' | 'risky' | 'invalid' | 'unknown' = 'valid', limit = 1000) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context, {
    email: 'person@example.com',
  });
  const context = { ...business.context, correlationId: randomUUID() };
  const invocation = { context, permissions: 'all' as const };
  const services = { db, authorize: () => true };
  const identity = await database.withTenant(context, async (sql) => {
    await sql.query(
      'insert into messaging.settings (business_id,email_verification_daily_limit,quiet_hours_enabled) values (app.business_id(),$1,false)',
      [limit],
    );
    return sql.one<{ id: string }>('select id from crm.contact_identities where contact_id=$1', [
      contact.id,
    ]);
  });
  const input = {
    contactId: toPublicId('contact', contact.id),
    addressId: toPublicId('contact_identity', identity.id),
  };
  const verify = vi.fn(() =>
    Promise.resolve({
      kind: 'result' as const,
      status,
      reasons: [],
      raw: { state: status, reason: null },
      charged: status !== 'unknown',
    }),
  );
  const provider = {
    name: 'emailable',
    verify,
    account: () => Promise.resolve({ kind: 'ok' as const, availableCredits: 10, testMode: true }),
  };
  const task = createVerifyEmailAddressTask({ resolve, provider });
  const job: JobRun = { invocation, services };
  const queued = async () => {
    const row = await database.withTenant(context, (sql) =>
      sql.one<{ id: string; current_check_id: string }>(
        'select id,current_check_id from messaging.email_verifications',
      ),
    );
    return { verificationId: row.id, checkId: row.current_check_id };
  };
  const request = () => runCommand(services, emailAddressCommands.verify, input, invocation);
  const read = () =>
    withTenant(db, context, (trx) => readEmailVerification(trx, 'person@example.com'));
  const admission = () =>
    withTenant(db, context, (trx) =>
      emailVerificationAdmission()(trx, context, {
        messageId: randomUUID(),
        accountId: randomUUID(),
        channel: 'email',
        purpose: 'marketing',
        to: 'person@example.com',
        subject: null,
        text: 'Body',
        html: null,
        reply: { inReplyTo: null, references: [] },
        attachments: [],
        lane: 'campaign',
      }),
    );
  return {
    context,
    invocation,
    services,
    input,
    provider,
    task,
    job,
    queued,
    request,
    read,
    identity,
    contact,
    admission,
  };
}

it('turning verification off allows unchecked addresses without a provider call', async () => {
  const f = await fixture();
  expect(await f.admission()).toMatchObject({ action: 'defer', reason: 'verification_pending' });
  const queued = await f.queued();
  await database.withTenant(f.context, (sql) =>
    sql.query('update messaging.settings set email_verification_enabled=false'),
  );
  expect(await f.admission()).toEqual({ action: 'allow' });
  await f.task.run(queued, f.job);
  expect(f.provider.verify).not.toHaveBeenCalled();
});

it('turning re-verification off keeps a result older than ninety days usable', async () => {
  const f = await fixture();
  await f.request();
  await f.task.run(await f.queued(), f.job);
  await database.withTenant(f.context, (sql) =>
    sql.query("update messaging.email_verifications set checked_at=now()-interval '91 days'"),
  );
  expect(await f.admission()).toMatchObject({ action: 'defer', reason: 'verification_pending' });
  await database.withTenant(f.context, (sql) =>
    sql.query('update messaging.settings set email_reverify_after_90_days=false'),
  );
  expect(await f.admission()).toEqual({ action: 'allow' });
  expect(await f.read()).toHaveProperty('expiresAt', null);
});

it('charges once on concurrent/retried jobs, with network outside the recording transaction', async () => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  await Promise.all([f.task.run(data, f.job), f.task.run(data, f.job)]);
  await f.task.run(data, f.job);
  expect(f.provider.verify).toHaveBeenCalledTimes(1);
  expect(await f.read()).toMatchObject({ status: 'valid', depth: 'mailbox' });
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.query('select charged,outcome from messaging.email_verification_checks'),
    ),
  ).toEqual([{ charged: true, outcome: 'valid' }]);
});

it('holds no business transaction open across a provider request', async () => {
  const f = await fixture();
  await f.request();
  f.provider.verify.mockImplementationOnce(async () => {
    await withTenant(db, f.context, (trx) =>
      sql`select id from tenancy.businesses where id=${f.context.businessId}::uuid for update nowait`.execute(
        trx,
      ),
    );
    return {
      kind: 'result',
      status: 'valid',
      reasons: [],
      raw: { state: 'valid', reason: null },
      charged: true,
    };
  });
  await f.task.run(await f.queued(), f.job);
  expect(await f.read()).toMatchObject({ status: 'valid', depth: 'mailbox' });
});

it.each([
  'manual',
  'hard_bounce',
  'complaint',
  'unsubscribe',
  'verification:mailbox_not_found',
] as const)('a valid result lifts only a verification suppression: %s', async (reason) => {
  const f = await fixture();
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason,detail) values (app.business_id(),'email','person@example.com',$1,$2)",
      [reason.startsWith('verification:') ? 'invalid' : reason, reason],
    ),
  );
  await f.request();
  await f.task.run(await f.queued(), f.job);
  const row = await database.withTenant(f.context, (sql) =>
    sql.one<{ live: boolean }>(
      'select expires_at is null or expires_at>now() as live from messaging.suppressions',
    ),
  );
  expect(row.live).toBe(!reason.startsWith('verification:'));
});

it('over the daily limit runs free domain checks and schedules the next business day', async () => {
  const f = await fixture('valid', 0);
  await f.request();
  await f.task.run(await f.queued(), f.job);
  expect(f.provider.verify).not.toHaveBeenCalled();
  expect(await f.read()).toMatchObject({ status: 'valid', depth: 'domain' });
  const row = await database.withTenant(f.context, (sql) =>
    sql.one<{ due: boolean }>(
      'select next_attempt_at>now() as due from messaging.email_verifications',
    ),
  );
  expect(row.due).toBe(true);
});

it('schedules the mailbox check over the limit within the hour from 00:05 the next day in the business zone', async () => {
  const f = await fixture('valid', 0);
  await database.withTenant(f.context, (sql) =>
    sql.query("update tenancy.businesses set timezone='Pacific/Kiritimati' where id=$1", [
      f.context.businessId,
    ]),
  );
  await f.request();
  await f.task.run(await f.queued(), f.job);
  const next = await database.withTenant(f.context, (sql) =>
    sql.one<{ local: string; tomorrow: boolean }>(
      `select to_char(v.next_attempt_at at time zone b.timezone,'HH24:MI') as local,
          (v.next_attempt_at at time zone b.timezone)::date = (now() at time zone b.timezone)::date + 1 as tomorrow
        from messaging.email_verifications v join tenancy.businesses b on b.id=v.business_id`,
    ),
  );
  expect(next.tomorrow).toBe(true);
  // Spread over the hour by the check's id, so a day's backlog does not arrive at once.
  expect(next.local >= '00:05' && next.local < '01:05').toBe(true);
});

it('queues a lost check again when a deferred send asks, so the send is not held forever', async () => {
  const f = await fixture();
  const mine = async () => {
    const { checkId } = await f.queued();
    return (await database.runJobs(['messaging.verify_address'])).filter((job) =>
      JSON.stringify(job.payload).includes(checkId),
    );
  };
  expect(await f.admission()).toMatchObject({ action: 'defer', reason: 'verification_pending' });
  // The worker took the job and lost it: the check is still pending, with no job left.
  expect(await mine()).toHaveLength(1);
  expect(await f.admission()).toMatchObject({ action: 'defer', reason: 'verification_pending' });
  expect(await mine()).toHaveLength(1);
  await f.task.run(await f.queued(), f.job);
  expect(await f.admission()).toEqual({ action: 'allow' });
  expect(f.provider.verify).toHaveBeenCalledTimes(1);
});

it('has domain depth without a provider and never silently labels it mailbox-verified', async () => {
  const f = await fixture();
  await f.request();
  await createVerifyEmailAddressTask({ resolve }).run(await f.queued(), f.job);
  expect(await f.read()).toMatchObject({ status: 'valid', depth: 'domain' });
});

it.each(['valid', 'risky', 'invalid'] as const)(
  'defers a send for verification then handles %s through suppression policy',
  async (status) => {
    const f = await fixture(status);
    const account = await database.withTenant(f.context, async (sql) => {
      await sql.query(
        "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'email','marketing','granted','user','system')",
        [f.contact.id],
      );
      return sql.one<{ id: string }>(
        "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Sender') returning id",
      );
    });
    const messageId = await withTenant(db, f.context, (trx) =>
      queueOutboundMessage(trx, f.context, {
        identityId: f.identity.id,
        accountId: account.id,
        channel: 'email',
        purpose: 'marketing',
        lane: 'campaign',
        text: 'Example',
        idempotencyKey: randomUUID(),
      }),
    );
    const deliver = vi.fn(() =>
      Promise.resolve({ outcome: 'accepted' as const, providerId: 'fixture' }),
    );
    const dispatch = createDispatchOutboundTask({ deliver }, emailVerificationAdmission());
    // A worker has taken the original immediate dispatch before it creates the retry.
    await database.as('crm_owner', (sql) =>
      sql.query('select graphile_worker.remove_job($1)', [`outbound:${messageId}`]),
    );
    await dispatch.run({ messageId }, f.job);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      await database.withTenant(f.context, (sql) =>
        sql.one<{ error_code: string }>('select error_code from messaging.messages where id=$1', [
          messageId,
        ]),
      ),
    ).toHaveProperty('error_code', 'verification_pending');
    const retry = () =>
      database.as('crm_owner', (sql) =>
        sql.one<{ due: boolean }>(
          'select run_at<=now() as due from graphile_worker.jobs where key=$1',
          [`outbound:${messageId}`],
        ),
      );
    expect(await retry()).toEqual({ due: false });
    await f.task.run(await f.queued(), f.job);
    expect(await retry()).toEqual({ due: true });
    if (status === 'valid') {
      const other = await database.fixtures.business(f.context.agencyId);
      await expect(
        database.withTenant(other.context, (sql) =>
          sql.query('select private.wake_verified_outbound($1::uuid)', [messageId]),
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        database.withTenant(f.context, (sql) =>
          sql.query('select graphile_worker.reschedule_jobs(array[1::bigint],run_at:=now())'),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await dispatch.run({ messageId }, f.job);
    expect(deliver).toHaveBeenCalledTimes(status === 'invalid' ? 0 : 1);
    if (status === 'invalid')
      expect(
        await database.withTenant(f.context, (sql) =>
          sql.one<{ error_code: string }>('select error_code from messaging.messages where id=$1', [
            messageId,
          ]),
        ),
      ).toHaveProperty('error_code', 'suppressed');
  },
);

it('exclusion skips the gate while existing suppressions still win', async () => {
  const f = await fixture();
  await runCommand(f.services, emailAddressCommands.exclude, f.input, f.invocation);
  const admission = emailVerificationAdmission();
  const decision = await withTenant(db, f.context, (trx) =>
    admission(trx, f.context, {
      messageId: randomUUID(),
      accountId: randomUUID(),
      channel: 'email',
      purpose: 'marketing',
      to: 'person@example.com',
      subject: null,
      text: 'Body',
      html: null,
      reply: { inReplyTo: null, references: [] },
      attachments: [],
      lane: 'campaign',
    }),
  );
  expect(decision).toEqual({ action: 'allow' });
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason) values (app.business_id(),'email','person@example.com','manual')",
    ),
  );
  expect(await f.admission()).toEqual({ action: 'refuse', reason: 'suppressed' });
});

it('unknown retries at one hour, six hours and one day, then stops', async () => {
  const f = await fixture('unknown');
  await f.request();
  for (const seconds of [3600, 21600, 86400, null]) {
    await f.task.run(await f.queued(), f.job);
    const row = await database.withTenant(f.context, (sql) =>
      sql.one<{ seconds: number | null; current_check_id: string | null }>(
        'select round(extract(epoch from next_attempt_at-now()))::integer as seconds,current_check_id from messaging.email_verifications',
      ),
    );
    if (seconds === null) expect(row).toEqual({ seconds: null, current_check_id: null });
    else {
      expect(row.seconds).toBeGreaterThanOrEqual(seconds - 2);
      expect(row.seconds).toBeLessThanOrEqual(seconds);
    }
    await database.withTenant(f.context, (sql) =>
      sql.query(
        "update messaging.email_verifications set next_attempt_at=now()-interval '1 second' where current_check_id is not null",
      ),
    );
  }
  expect(f.provider.verify).toHaveBeenCalledTimes(4);
});

it('a crashed in-flight attempt becomes unknown without a second paid request', async () => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "update messaging.email_verifications set claimed_check_id=current_check_id,claimed_at=now()-interval '3 minutes',provider_reserved_at=now()-interval '3 minutes'",
    ),
  );
  await f.task.run(data, f.job);
  await f.task.run(data, f.job);
  expect(f.provider.verify).not.toHaveBeenCalled();
  expect(await f.read()).toMatchObject({ status: 'unknown', reasons: ['provider_error'] });
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.query('select charged,outcome from messaging.email_verification_checks'),
    ),
  ).toEqual([{ charged: false, outcome: 'abandoned' }]);
});

it('a reply to an inbound address skips verification', async () => {
  const f = await fixture();
  await database.withTenant(f.context, async (sql) => {
    const conversation = await sql.one<{ id: string }>(
      'insert into messaging.conversations (business_id,contact_id) values (app.business_id(),$1) returning id',
      [f.contact.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Inbox') returning id",
    );
    await sql.query(
      "insert into messaging.messages (business_id,conversation_id,channel_account_id,channel,direction,status,from_address,author_kind) values (app.business_id(),$1,$2,'email','inbound','received','person@example.com','system')",
      [conversation.id, account.id],
    );
  });
  const admission = emailVerificationAdmission();
  expect(
    await withTenant(db, f.context, (trx) =>
      admission(trx, f.context, {
        messageId: randomUUID(),
        accountId: randomUUID(),
        channel: 'email',
        purpose: 'transactional',
        to: 'person@example.com',
        subject: null,
        text: 'Reply',
        html: null,
        reply: { inReplyTo: null, references: [] },
        attachments: [],
        lane: 'reply',
      }),
    ),
  ).toEqual({ action: 'allow' });
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.query('select id from messaging.email_verifications'),
    ),
  ).toEqual([]);
  const copy = await withTenant(db, f.context, (trx) =>
    admission(trx, f.context, {
      messageId: randomUUID(),
      accountId: randomUUID(),
      channel: 'email',
      purpose: 'transactional',
      to: 'person@example.com',
      cc: ['copy@example.com'],
      subject: null,
      text: 'Reply',
      html: null,
      reply: { inReplyTo: null, references: [] },
      attachments: [],
      lane: 'reply',
    }),
  );
  // Only the main recipient waits for a check: an unchecked copy is sent to as it is.
  expect(copy).toEqual({ action: 'allow' });
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.query('select id from messaging.email_verifications'),
    ),
  ).toEqual([]);
});

it('hard bounce marks verification invalid and prevents a stale valid callback from clearing it', async () => {
  const f = await fixture();
  const account = await database.withTenant(f.context, async (sql) => {
    await sql.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'email','marketing','granted','user','system')",
      [f.contact.id],
    );
    return sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Sender') returning id",
    );
  });
  const messageId = await withTenant(db, f.context, (trx) =>
    queueOutboundMessage(trx, f.context, {
      identityId: f.identity.id,
      accountId: account.id,
      channel: 'email',
      purpose: 'marketing',
      lane: 'campaign',
      text: 'Example',
      idempotencyKey: randomUUID(),
    }),
  );
  await createDispatchOutboundTask({
    deliver: () => Promise.resolve({ outcome: 'accepted' as const, providerId: 'fixture' }),
  }).run({ messageId }, f.job);
  await f.request();
  f.provider.verify.mockImplementationOnce(async () => {
    await runCommand(
      f.services,
      recordBounceCommand,
      {
        mailboxId: account.id,
        report: {
          originalMessageId: `<crm-outbound.${messageId}@crm.invalid>`,
          recipients: [
            {
              finalRecipient: 'person@example.com',
              originalRecipient: null,
              status: '5.1.1',
              bounce: 'hard',
            },
          ],
        },
      },
      f.invocation,
    );
    return {
      kind: 'result',
      status: 'valid',
      reasons: [],
      raw: { state: 'valid', reason: null },
      charged: true,
    };
  });
  await f.task.run(await f.queued(), f.job);
  expect(await f.read()).toMatchObject({ status: 'invalid', reasons: ['hard_bounce'] });
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.one<{ reason: string; expires_at: Date | null }>(
        'select reason,expires_at from messaging.suppressions',
      ),
    ),
  ).toEqual({ reason: 'hard_bounce', expires_at: null });
});

it('marks a bad provider key failing without persisting the credential', async () => {
  const f = await fixture();
  const connection = await database.withTenant(f.context, async (sql) => {
    const secret = await sql.one<{ id: string }>(
      "insert into vault.secrets (agency_id,business_id,purpose,key_version,enc,ciphertext) values ($1,app.business_id(),'email.emailable.key',1,decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex')) returning id",
      [f.context.agencyId],
    );
    return sql.one<{ id: string }>(
      "insert into messaging.provider_connections (agency_id,business_id,provider,label,account_ref,secret_id) values ($1,app.business_id(),'emailable','Checks','verification',$2) returning id",
      [f.context.agencyId, secret.id],
    );
  });
  await f.request();
  const task = createVerifyEmailAddressTask({
    resolve,
    provider: {
      ...f.provider,
      verify: () =>
        Promise.resolve({
          kind: 'failed' as const,
          problem: 'unauthorized' as const,
          connectionFailing: true,
        }),
    },
  });
  await task.run(await f.queued(), f.job);
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.one<{ status: string }>('select status from messaging.provider_connections where id=$1', [
        connection.id,
      ]),
    ),
  ).toEqual({ status: 'failing' });
  expect(await f.read()).toMatchObject({ status: 'unknown', reasons: ['provider_error'] });
  expect(
    JSON.stringify(
      await database.withTenant(f.context, (sql) => sql.query('select input from audit.commands')),
    ),
  ).not.toContain('person@example.com');
});

it('reserves the daily budget before concurrent paid calls', async () => {
  const f = await fixture('valid', 1);
  const second = await database.fixtures.contact(f.context, { email: 'second@example.com' });
  const identity = await database.withTenant(f.context, (sql) =>
    sql.one<{ id: string }>('select id from crm.contact_identities where contact_id=$1', [
      second.id,
    ]),
  );
  await f.request();
  const firstData = await f.queued();
  await runCommand(
    f.services,
    emailAddressCommands.verify,
    {
      contactId: toPublicId('contact', second.id),
      addressId: toPublicId('contact_identity', identity.id),
    },
    f.invocation,
  );
  const secondRow = await database.withTenant(f.context, (sql) =>
    sql.one<{ id: string; current_check_id: string }>(
      "select id,current_check_id from messaging.email_verifications where address_normalized='second@example.com'",
    ),
  );
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.provider.verify.mockImplementationOnce(async () => {
    entered();
    await waiting;
    return {
      kind: 'result',
      status: 'valid',
      reasons: [],
      raw: { state: 'valid', reason: null },
      charged: true,
    };
  });
  const first = f.task.run(firstData, f.job);
  await started;
  try {
    await f.task.run({ verificationId: secondRow.id, checkId: secondRow.current_check_id }, f.job);
  } finally {
    release();
    await first;
  }
  expect(f.provider.verify).toHaveBeenCalledTimes(1);
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.one<{ n: number }>(
        'select count(*)::integer as n from messaging.email_verification_checks where charged',
      ),
    ),
  ).toEqual({ n: 1 });
});

it('exclude/include while a paid check runs never loses its receipt or replaces the attempt fence', async () => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  f.provider.verify.mockImplementationOnce(async () => {
    await runCommand(f.services, emailAddressCommands.exclude, f.input, f.invocation);
    await runCommand(f.services, emailAddressCommands.include, f.input, f.invocation);
    await f.request();
    return {
      kind: 'result',
      status: 'valid',
      reasons: [],
      raw: { state: 'valid', reason: null },
      charged: true,
    };
  });
  await f.task.run(data, f.job);
  expect(f.provider.verify).toHaveBeenCalledTimes(1);
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.query('select charged,outcome from messaging.email_verification_checks'),
    ),
  ).toEqual([{ charged: true, outcome: 'valid' }]);
});

const failed = (problem: ProviderProblem, retryAfterMs?: number): MailboxOutcome => ({
  kind: 'failed',
  problem,
  connectionFailing: false,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});
const deliverable: MailboxOutcome = {
  kind: 'result',
  status: 'valid',
  reasons: [],
  raw: { state: 'deliverable', reason: null },
  charged: true,
};
/** A provider that gives these answers in turn. */
function answering(f: Awaited<ReturnType<typeof fixture>>, answers: MailboxOutcome[]) {
  const verify = vi.fn(() => Promise.resolve(answers.shift() ?? deliverable));
  const task = createVerifyEmailAddressTask({ resolve, provider: { ...f.provider, verify } });
  return { verify, task };
}
/** The address's check and its queued job, in seconds from now. */
async function checkState(f: Awaited<ReturnType<typeof fixture>>, checkId: string) {
  const row = await database.withTenant(f.context, (sql) =>
    sql.one<{
      id: string;
      status: string | null;
      attempts: number;
      current: boolean;
      claimed: boolean;
      reserved: boolean;
      wait: number | null;
    }>(
      `select id,status,attempts,current_check_id is not distinct from $1::uuid as current,
        claimed_check_id is not null as claimed,provider_reserved_at is not null as reserved,
        round(extract(epoch from next_attempt_at-now()))::integer as wait
      from messaging.email_verifications`,
      [checkId],
    ),
  );
  const jobs = await database.as('crm_owner', (sql) =>
    sql.query<{ job: number; check: string }>(
      `select round(extract(epoch from run_at-now()))::integer as job,payload->'data'->>'checkId' as check
      from graphile_worker._private_jobs where key=$1`,
      [`email-verification:${row.id}`],
    ),
  );
  return {
    status: row.status,
    attempts: row.attempts,
    current: row.current,
    claimed: row.claimed,
    reserved: row.reserved,
    wait: row.wait,
    job: jobs[0]?.job ?? null,
    jobCheck: jobs[0]?.check === checkId,
  };
}
/** Brings the queued early retry's time to now, as the worker would reach it. */
const reachRetry = (f: Awaited<ReturnType<typeof fixture>>) =>
  database.withTenant(f.context, (sql) =>
    sql.query("update messaging.email_verifications set next_attempt_at=now()-interval '1 second'"),
  );
const ledger = (f: Awaited<ReturnType<typeof fixture>>) =>
  database.withTenant(f.context, (sql) =>
    sql.query('select charged,outcome from messaging.email_verification_checks'),
  );

it('queues a rate-limited first check again for the wait the provider asks, without waiting in the job', async () => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  const run = answering(f, [failed('rate_limited', 3000)]);
  await run.task.run(data, f.job);
  expect(run.verify).toHaveBeenCalledTimes(1);
  const state = await checkState(f, data.checkId);
  expect(state).toMatchObject({
    status: null,
    attempts: 0,
    current: true,
    claimed: false,
    reserved: false,
    jobCheck: true,
  });
  expect(state.wait).toBeGreaterThanOrEqual(2);
  expect(state.wait).toBeLessThanOrEqual(3);
  expect(state.job).toBe(state.wait);
  expect(await ledger(f)).toEqual([]);
  await reachRetry(f);
  await run.task.run(data, f.job);
  expect(run.verify).toHaveBeenCalledTimes(2);
  expect(await f.read()).toMatchObject({ status: 'valid', depth: 'mailbox' });
  expect(await ledger(f)).toEqual([{ charged: true, outcome: 'valid' }]);
});

it.each([
  ['a wait longer than a minute', failed('rate_limited', 120_000), 60],
  ['an unavailable provider, no wait given', failed('unavailable'), 5],
  ['a slow provider', failed('slow'), 5],
] as const)('queues the early retry at most a minute away: %s', async (_name, answer, seconds) => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  const run = answering(f, [answer]);
  await run.task.run(data, f.job);
  const state = await checkState(f, data.checkId);
  expect(state.wait).toBeGreaterThanOrEqual(seconds - 1);
  expect(state.wait).toBeLessThanOrEqual(seconds);
  expect(state.job).toBe(state.wait);
});

it('records unknown with the hourly retry when the early retry fails too', async () => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  const run = answering(f, [failed('rate_limited', 1000), failed('rate_limited', 1000)]);
  await run.task.run(data, f.job);
  await reachRetry(f);
  await run.task.run(data, f.job);
  expect(run.verify).toHaveBeenCalledTimes(2);
  expect(await f.read()).toMatchObject({ status: 'unknown', reasons: ['provider_error'] });
  const state = await checkState(f, data.checkId);
  expect(state).toMatchObject({ attempts: 1, current: false, claimed: false, reserved: false });
  expect(Math.round((state.wait ?? 0) / 3600)).toBe(1);
  expect(await ledger(f)).toEqual([{ charged: false, outcome: 'unknown' }]);
});

it('a replay before the early retry is due asks nothing and keeps it queued', async () => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  const run = answering(f, [failed('rate_limited', 30_000)]);
  await run.task.run(data, f.job);
  await run.task.run(data, f.job);
  expect(run.verify).toHaveBeenCalledTimes(1);
  const state = await checkState(f, data.checkId);
  expect(state).toMatchObject({ status: null, current: true, claimed: false, jobCheck: true });
  expect(state.job).toBeGreaterThanOrEqual(state.wait ?? Infinity);
  expect(await ledger(f)).toEqual([]);
});

it('records a lost claim as the replay left it, with no second paid call', async () => {
  const f = await fixture();
  await f.request();
  const data = await f.queued();
  const run = answering(f, []);
  run.verify.mockImplementationOnce(async () => {
    // The call ran long enough for the claim to look abandoned, and a replay recorded it so.
    await database.withTenant(f.context, (sql) =>
      sql.query("update messaging.email_verifications set claimed_at=now()-interval '3 minutes'"),
    );
    await run.task.run(data, f.job);
    return failed('rate_limited', 1000);
  });
  await run.task.run(data, f.job);
  await reachRetry(f);
  await run.task.run(data, f.job);
  expect(run.verify).toHaveBeenCalledTimes(1);
  expect(await ledger(f)).toEqual([{ charged: false, outcome: 'abandoned' }]);
});

const personMustFix: MailboxOutcome = {
  kind: 'failed',
  problem: 'no_credits',
  connectionFailing: true,
};
it.each([
  ['a later attempt', failed('rate_limited', 1000), 1],
  ['a key or credits a person must fix', personMustFix, 0],
  ['a timeout that may have been charged', failed('timeout'), 0],
  ['an unreadable answer', failed('bad_response'), 0],
  ['a network failure', failed('network'), 0],
  ['an unexpected status', failed('unexpected_status'), 0],
] as const)(
  'records unknown at once, with no early retry, for %s',
  async (_name, answer, attempts) => {
    const f = await fixture();
    await f.request();
    await database.withTenant(f.context, (sql) =>
      sql.query('update messaging.email_verifications set attempts=$1', [attempts]),
    );
    const data = await f.queued();
    const run = answering(f, [answer]);
    await run.task.run(data, f.job);
    expect(run.verify).toHaveBeenCalledTimes(1);
    expect(await f.read()).toHaveProperty('status', 'unknown');
    expect(await checkState(f, data.checkId)).toMatchObject({ attempts: attempts + 1 });
  },
);

/** An email to the fixture's contact, already checked, with these copies. */
async function copiesFixture(copies: { cc?: string[]; bcc?: string[] }) {
  const f = await fixture();
  const account = await database.withTenant(f.context, async (sql) => {
    await sql.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'email','marketing','granted','user','system')",
      [f.contact.id],
    );
    await sql.query(
      "insert into messaging.email_verifications (business_id,address_normalized,status,depth,checked_at) values (app.business_id(),'person@example.com','valid','mailbox',now())",
    );
    return sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Sender') returning id",
    );
  });
  const messageId = await withTenant(db, f.context, (trx) =>
    queueOutboundMessage(trx, f.context, {
      identityId: f.identity.id,
      accountId: account.id,
      channel: 'email',
      purpose: 'marketing',
      lane: 'automation',
      text: 'Example',
      idempotencyKey: randomUUID(),
      ...copies,
    }),
  );
  const deliver = vi.fn<OutboundSender['deliver']>(() =>
    Promise.resolve({ outcome: 'accepted', providerId: 'fixture' }),
  );
  const dispatch = () =>
    createDispatchOutboundTask({ deliver }, emailVerificationAdmission()).run({ messageId }, f.job);
  const suppress = (address: string, reason: string, detail: string | null = null) =>
    database.withTenant(f.context, (sql) =>
      sql.query(
        "insert into messaging.suppressions (business_id,channel,address_normalized,reason,detail) values (app.business_id(),'email',$1,$2,$3)",
        [address, reason, detail],
      ),
    );
  const sent = () =>
    database.withTenant(f.context, (sql) =>
      sql.one<{
        status: string;
        error_code: string | null;
        cc_addresses: string[];
        bcc_addresses: string[];
        left_out_copies: unknown;
      }>(
        'select m.status,m.error_code,m.cc_addresses,m.bcc_addresses,d.left_out_copies from messaging.messages m join messaging.outbound_dispatch d on d.id=m.id where m.id=$1',
        [messageId],
      ),
    );
  return { ...f, messageId, deliver, dispatch, suppress, sent };
}

it('leaves out a suppressed Cc and sends to everyone else, noting who was left out and why', async () => {
  const f = await copiesFixture({
    cc: ['gone@example.com', 'kept@example.com'],
    bcc: ['unchecked@example.com'],
  });
  await f.suppress('gone@example.com', 'unsubscribe');
  await f.dispatch();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver.mock.calls[0]?.[0]).toMatchObject({
    to: 'person@example.com',
    cc: ['kept@example.com'],
    bcc: ['unchecked@example.com'],
  });
  expect(await f.sent()).toEqual({
    status: 'sent',
    error_code: null,
    cc_addresses: ['kept@example.com'],
    bcc_addresses: ['unchecked@example.com'],
    left_out_copies: [{ copy: 'cc', address: 'gone@example.com', reason: 'unsubscribe' }],
  });
  // An unchecked copy is neither held nor checked: only the main recipient is.
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.query('select address_normalized from messaging.email_verifications'),
    ),
  ).toEqual([{ address_normalized: 'person@example.com' }]);
  // The audit and the events of the send name no address that was left out.
  expect(
    JSON.stringify(
      await database.withTenant(f.context, async (sql) => [
        await sql.query('select input from audit.commands'),
        await sql.query('select payload from events.events'),
      ]),
    ),
  ).not.toContain('gone@example.com');
});

it('leaves out a Bcc a check found invalid, and the note holds only reason codes', async () => {
  const f = await copiesFixture({ bcc: ['Bad@Example.com'] });
  await f.suppress('bad@example.com', 'invalid', 'verification:mailbox_not_found');
  await f.dispatch();
  expect(f.deliver.mock.calls[0]?.[0]).toMatchObject({ bcc: [] });
  expect(await f.sent()).toMatchObject({
    status: 'sent',
    bcc_addresses: [],
    left_out_copies: [{ copy: 'bcc', address: 'Bad@Example.com', reason: 'invalid' }],
  });
  for (const note of [
    '{}',
    '[{"copy":"to","address":"a@example.com","reason":"invalid"}]',
    '[{"copy":"cc","address":"a@example.com","reason":"verification:mailbox_not_found"}]',
    '[{"copy":"cc","address":"a@example.com","reason":"invalid","name":"A"}]',
    '[{"copy":"cc","reason":"invalid"}]',
    '[{"copy":"cc","address":"","reason":"invalid"}]',
    `[{"copy":"cc","address":"${'a'.repeat(321)}","reason":"invalid"}]`,
  ])
    await expect(
      database.withTenant(f.context, (sql) =>
        sql.query('update messaging.outbound_dispatch set left_out_copies=$1::jsonb where id=$2', [
          note,
          f.messageId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  // The longest address an email can have still fits.
  await database.withTenant(f.context, (sql) =>
    sql.query('update messaging.outbound_dispatch set left_out_copies=$1::jsonb where id=$2', [
      `[{"copy":"cc","address":"${'a'.repeat(320)}","reason":"invalid"}]`,
      f.messageId,
    ]),
  );
});

it('refuses the email when its main recipient is suppressed, whatever its copies', async () => {
  const f = await copiesFixture({ cc: ['kept@example.com'], bcc: ['gone@example.com'] });
  await f.suppress('person@example.com', 'manual');
  await f.suppress('gone@example.com', 'complaint');
  await f.dispatch();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.sent()).toEqual({
    status: 'failed',
    error_code: 'suppressed',
    cc_addresses: ['kept@example.com'],
    bcc_addresses: ['gone@example.com'],
    left_out_copies: [],
  });
});

/** The check's queued job: its priority, and its time in the business's zone. */
const queuedJob = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const { id } = await database.withTenant(f.context, (sql) =>
    sql.one<{ id: string }>('select id from messaging.email_verifications'),
  );
  const [job] = await database.as('crm_owner', (sql) =>
    sql.query<{ priority: number; local: string; tomorrow: boolean }>(
      `select j.priority, to_char(j.run_at at time zone b.timezone, 'HH24:MI') as local,
        (j.run_at at time zone b.timezone)::date = (now() at time zone b.timezone)::date + 1 as tomorrow
      from graphile_worker._private_jobs j join tenancy.businesses b on b.id = $2
      where j.key = $1`,
      [`email-verification:${id}`, f.context.businessId],
    ),
  );
  return job;
};
/** The job as a bulk action queued it: behind other work. */
const asBulk = (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.job, job: { priority: 100 } });

it('keeps a bulk check behind other work when the limit defers it, spread over the hour after 00:05', async () => {
  const f = await fixture('valid', 0);
  await f.request();
  await f.task.run(await f.queued(), asBulk(f));
  const job = await queuedJob(f);
  expect(job).toMatchObject({ priority: 100, tomorrow: true });
  expect(job?.local !== undefined && job.local >= '00:05' && job.local < '01:05').toBe(true);
  // The check waits for that same time.
  const { local } = await database.withTenant(f.context, (sql) =>
    sql.one<{ local: string }>(
      `select to_char(v.next_attempt_at at time zone b.timezone, 'HH24:MI') as local
       from messaging.email_verifications v join tenancy.businesses b on b.id = v.business_id`,
    ),
  );
  expect(local).toBe(job?.local);
});

it('keeps a bulk check behind other work when the provider asks it to wait', async () => {
  const f = await fixture();
  await f.request();
  const run = answering(f, [failed('rate_limited', 3000)]);
  await run.task.run(await f.queued(), asBulk(f));
  expect(await queuedJob(f)).toMatchObject({ priority: 100 });
});

it('keeps a check a send asked for at the ordinary priority when it is asked again', async () => {
  const f = await fixture();
  await f.request();
  const run = answering(f, [failed('rate_limited', 3000)]);
  await run.task.run(await f.queued(), { ...f.job, job: { priority: 0 } });
  expect(await queuedJob(f)).toMatchObject({ priority: 0 });
  const unknown = await fixture('unknown');
  await unknown.request();
  await unknown.task.run(await unknown.queued(), unknown.job);
  expect(await queuedJob(unknown)).toMatchObject({ priority: 0 });
});
