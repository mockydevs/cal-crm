import { randomUUID } from 'node:crypto';
import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';
import { readContactConsent } from './consent-read.js';
import { createRecordContactConsentCommand, recordConsent } from './consent-record.js';
import { createDispatchOutboundTask, queueOutboundMessage } from './outbound.js';

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

const actorNames = {
  user: (_trx: unknown, ids: readonly string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, 'Dana Brooks']))),
};
const record = createRecordContactConsentCommand(actorNames);
const note = 'Asked at the front desk to get the newsletter.';

interface LedgerRow {
  readonly channel: string;
  readonly purpose: string;
  readonly status: string;
  readonly source: string;
  readonly proof: Record<string, unknown>;
  readonly recorded_by_kind: string;
  readonly recorded_by_id: string | null;
}

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const contact = await database.fixtures.contact(business.context, {
    email: 'recipient@example.test',
  });
  const sender = await database.withTenant(business.context, async (sql) => {
    // Quiet hours are another test's subject: off, so only consent decides here.
    await sql.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled) values (app.business_id(),false)',
    );
    const identity = await sql.one<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Fixture sender') returning id",
    );
    return { identityId: identity.id, accountId: account.id };
  });
  const as = (permissions: readonly Permission[] | 'all' = ['contacts.manage']): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: permissions === 'all' ? 'all' : new Set(permissions),
  });
  const id = toPublicId('contact', contact.id);
  const system = { ...business.context, correlationId: randomUUID() };
  return {
    business,
    contact,
    user,
    id,
    as,
    change: (
      patch: Partial<{
        channel: string;
        purpose: string;
        status: string;
        note: string;
        replacesWithdrawal: boolean;
      }> = {},
      invocation: Invocation = as(),
    ) =>
      runCommand(
        services,
        record,
        { id, channel: 'email', purpose: 'marketing', status: 'granted', note, ...patch },
        invocation,
      ),
    read: (invocation: Invocation = as()) =>
      withTenant(db, invocation.context, (trx) =>
        readContactConsent(trx, invocation, id, actorNames),
      ),
    ledger: () =>
      database.withTenant(business.context, (sql) =>
        sql.query<LedgerRow>(
          `select channel,purpose,status,source,proof,recorded_by_kind,recorded_by_id
           from messaging.consents where contact_id=$1 order by recorded_at,id`,
          [contact.id],
        ),
      ),
    /** What the send check decides for a new marketing email, by its recorded reason. */
    async sendCheck(): Promise<string> {
      const messageId = await withTenant(db, system, (trx) =>
        queueOutboundMessage(trx, system, {
          ...sender,
          channel: 'email',
          purpose: 'marketing',
          lane: 'campaign',
          idempotencyKey: randomUUID(),
          subject: 'Fixture',
          text: 'Body',
        }),
      );
      const row = await database.withTenant(system, (sql) =>
        sql.one<{ status: string; error_code: string | null }>(
          'select status,error_code from messaging.messages where id=$1',
          [messageId],
        ),
      );
      return row.status === 'queued' && row.error_code === null
        ? 'allowed'
        : (row.error_code ?? row.status);
    },
    queue: () =>
      withTenant(db, system, (trx) =>
        queueOutboundMessage(trx, system, {
          ...sender,
          channel: 'email',
          purpose: 'marketing',
          lane: 'campaign',
          idempotencyKey: randomUUID(),
          subject: 'Fixture',
          text: 'Body',
        }),
      ),
    system,
  };
}

const stateOf = async (f: Awaited<ReturnType<typeof fixture>>, channel = 'email') =>
  (await f.read()).current.find((row) => row.channel === channel && row.purpose === 'marketing')
    ?.status;

it('stores who, when, the source and the note with a change a person records', async () => {
  const f = await fixture();
  const before = Date.now();
  const answer = await f.change();
  const after = Date.now();
  expect(await f.ledger()).toEqual([
    {
      channel: 'email',
      purpose: 'marketing',
      status: 'granted',
      source: 'user',
      proof: { note },
      recorded_by_kind: 'user',
      recorded_by_id: f.user.id,
    },
  ]);
  expect(answer.canManage).toBe(true);
  expect(answer.current).toHaveLength(8);
  expect(answer.current[0]).toMatchObject({
    channel: 'email',
    purpose: 'marketing',
    status: 'granted',
    source: 'user',
  });
  expect(answer.current.slice(1).every((row) => row.status === 'unknown')).toBe(true);
  expect(answer.history).toEqual([
    {
      channel: 'email',
      purpose: 'marketing',
      status: 'granted',
      source: 'user',
      recordedAt: answer.current[0]?.recordedAt,
      recordedBy: { kind: 'user', name: 'Dana Brooks', you: true },
      proof: {
        note,
        wording: null,
        keyword: null,
        ipAddress: null,
        pageUrl: null,
        linked: null,
      },
    },
  ]);
  const at = Date.parse(answer.history[0]?.recordedAt ?? '');
  expect(at).toBeGreaterThanOrEqual(before - 1000);
  expect(at).toBeLessThanOrEqual(after + 1000);
  // On the contact's timeline, without the note: events are kept forever.
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        `select e.type,e.payload,e.subject_id,e.actor_id from events.events e
         join crm.timeline_entries t on t.event_id=e.id where t.record_id=$1`,
        [f.contact.id],
      ),
    ),
  ).toEqual([
    {
      type: 'consent.granted',
      payload: { channel: 'email', purpose: 'marketing', source: 'user' },
      subject_id: f.contact.id,
      actor_id: f.user.id,
    },
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select outcome,input from audit.commands where command='consents.record'"),
    ),
  ).toEqual([
    {
      outcome: 'ok',
      input: {
        id: f.id,
        channel: 'email',
        purpose: 'marketing',
        status: 'granted',
        note,
        replacesWithdrawal: false,
      },
    },
  ]);
});

it.each([undefined, '', '         ', 'yes ok'])(
  'records nothing without a note that says how (%j)',
  async (given) => {
    const f = await fixture();
    await expect(
      runCommand(
        services,
        record,
        { id: f.id, channel: 'email', purpose: 'marketing', status: 'granted', note: given },
        f.as(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await f.ledger()).toEqual([]);
    expect(await stateOf(f)).toBe('unknown');
  },
);

it('never lets the caller choose the source, the recorder, the time or the proof', async () => {
  const f = await fixture();
  for (const extra of [
    { source: 'form' },
    { recordedAt: '2020-01-01T00:00:00Z' },
    { recordedById: randomUUID() },
    { proof: { wording: 'Invented' } },
  ])
    await expect(
      runCommand(
        services,
        record,
        { id: f.id, channel: 'email', purpose: 'marketing', status: 'granted', note, ...extra },
        f.as(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  expect(await f.ledger()).toEqual([]);
});

it('keeps the ledger append-only for the app: a change is a new row', async () => {
  const f = await fixture();
  await f.change();
  await f.change({ status: 'withdrawn', note: 'Asked by phone to stop the newsletter.' });
  expect((await f.ledger()).map((row) => row.status)).toEqual(['granted', 'withdrawn']);
  for (const statement of [
    "update messaging.consents set status='granted'",
    'update messaging.consents set proof=\'{"note":"rewritten"}\'',
    "update messaging.consents set recorded_at=now()-interval '1 year'",
    'delete from messaging.consents',
    'truncate messaging.consents',
  ])
    await expect(
      database.withTenant(f.business.context, (sql) => sql.query(statement)),
      statement,
    ).rejects.toThrow(/permission denied/);
  expect((await f.ledger()).map((row) => [row.status, row.proof['note']])).toEqual([
    ['granted', note],
    ['withdrawn', 'Asked by phone to stop the newsletter.'],
  ]);
});

it('shows the same current consent the send check enforces, change after change', async () => {
  const f = await fixture();
  const agree = async (expected: 'unknown' | 'granted' | 'withdrawn') => {
    expect(await stateOf(f)).toBe(expected);
    expect(await f.sendCheck()).toBe(
      { unknown: 'consent_required', granted: 'allowed', withdrawn: 'consent_withdrawn' }[expected],
    );
  };
  await agree('unknown');
  await f.change();
  await agree('granted');
  await f.change({ status: 'withdrawn' });
  await agree('withdrawn');
  await f.change({ replacesWithdrawal: true });
  await agree('granted');
  // Another channel or purpose never counts for this one.
  await f.change({ channel: 'sms', status: 'withdrawn' });
  await f.change({ purpose: 'transactional', status: 'withdrawn' });
  await agree('granted');
  // Rows written at the same instant, as an import in one statement writes them: the
  // greater id wins on both sides.
  const insert = (first: string, second: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into messaging.consents
           (business_id,id,contact_id,channel,purpose,status,source,proof,recorded_at,recorded_by_kind)
         select app.business_id(),v.id::uuid,$1,'email','marketing',v.status,'import','{"note":"Tie"}',
           at_once.instant,'system'
         from (select clock_timestamp()+interval '1 minute' as instant) at_once,
           (values ($2::text,'01990000-0000-7000-8000-000000000001'),($3::text,'01990000-0000-7000-8000-000000000002')) v(status,id)`,
        [f.contact.id, first, second],
      ),
    );
  await insert('granted', 'withdrawn');
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.one<{ instants: number }>(
        "select count(distinct recorded_at)::integer as instants from messaging.consents where source='import'",
      ),
    ),
  ).toEqual({ instants: 1 });
  await agree('withdrawn');
});

it('breaks a tie the other way round the same on both sides', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into messaging.consents
         (business_id,id,contact_id,channel,purpose,status,source,proof,recorded_at,recorded_by_kind)
       select app.business_id(),v.id::uuid,$1,'email','marketing',v.status,'import','{"note":"Tie"}',t.at,'system'
       from (select clock_timestamp() as at) t,
         (values ('withdrawn','01990000-0000-7000-8000-000000000001'),('granted','01990000-0000-7000-8000-000000000002')) v(status,id)`,
      [f.contact.id],
    ),
  );
  expect(await stateOf(f)).toBe('granted');
  expect(await f.sendCheck()).toBe('allowed');
});

it('makes a withdrawal count for the very next send, also for a message already queued', async () => {
  const f = await fixture();
  await f.change();
  const queued = await f.queue();
  await f.change({ status: 'withdrawn', note: 'Replied asking to be taken off the list.' });
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  await task.run(
    { messageId: queued },
    { invocation: { context: f.system, permissions: 'all' }, services },
  );
  expect(deliveries).toBe(0);
  expect(
    await database.withTenant(f.system, (sql) =>
      sql.one('select status,error_code from messaging.messages where id=$1', [queued]),
    ),
  ).toEqual({ status: 'failed', error_code: 'consent_withdrawn' });
  expect(await f.sendCheck()).toBe('consent_withdrawn');
});

it('refuses to undo a withdrawal unless the person confirms the contact asked again', async () => {
  const f = await fixture();
  await f.change();
  await f.change({ status: 'withdrawn' });
  await expect(f.change()).rejects.toMatchObject({
    name: 'ValidationError',
    issues: [{ path: '/replacesWithdrawal', code: 'consent_withdrawn' }],
  });
  expect(await stateOf(f)).toBe('withdrawn');
  expect((await f.ledger()).map((row) => row.status)).toEqual(['granted', 'withdrawn']);
  // The confirmation is for this channel and purpose only.
  await expect(f.change({ channel: 'sms' })).resolves.toBeDefined();
  await f.change({ replacesWithdrawal: true, note: 'Asked in person to rejoin the newsletter.' });
  expect(await stateOf(f)).toBe('granted');
  expect(await f.sendCheck()).toBe('allowed');
});

it('needs contacts.manage to record, and shows the consent read-only without it', async () => {
  const f = await fixture();
  for (const permissions of [[], ['tasks.manage', 'notes.manage']] as const) {
    await expect(f.change({}, f.as(permissions))).rejects.toBeInstanceOf(ForbiddenError);
    const answer = await f.read(f.as(permissions));
    expect(answer.canManage).toBe(false);
    expect(answer.current).toHaveLength(8);
  }
  expect(await f.ledger()).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select outcome,error_code from audit.commands where command='consents.record'"),
    ),
  ).toEqual([
    { outcome: 'denied', error_code: 'forbidden' },
    { outcome: 'denied', error_code: 'forbidden' },
  ]);
  expect((await f.read(f.as('all'))).canManage).toBe(true);
});

it('lets only a person or an API key record consent, each under its own source', async () => {
  const f = await fixture();
  for (const actorKind of ['ai_agent', 'automation', 'system', 'contact'] as const)
    await expect(
      f.change(
        {},
        {
          context: { ...f.business.context, actorKind, correlationId: randomUUID() },
          permissions: 'all',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await f.ledger()).toEqual([]);
  await f.change(
    {},
    {
      context: { ...f.business.context, actorKind: 'api_key', correlationId: randomUUID() },
      permissions: new Set<Permission>(['contacts.manage']),
    },
  );
  expect(await f.ledger()).toMatchObject([
    { source: 'api', recorded_by_kind: 'api_key', recorded_by_id: null, proof: { note } },
  ]);
});

it("keeps another business's contact out of reach, and its ledger unseen", async () => {
  const mine = await fixture();
  const theirs = await fixture();
  await theirs.change();
  await expect(
    runCommand(
      services,
      record,
      { id: theirs.id, channel: 'email', purpose: 'marketing', status: 'withdrawn', note },
      mine.as('all'),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  const reader = mine.as('all');
  await expect(
    withTenant(db, reader.context, (trx) => readContactConsent(trx, reader, theirs.id, actorNames)),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await mine.ledger()).toEqual([]);
  expect((await theirs.ledger()).map((row) => row.status)).toEqual(['granted']);
  expect(await stateOf(theirs)).toBe('granted');
  expect((await mine.read()).history).toEqual([]);
  // The agency's staff outside any business change nothing either.
  await expect(
    runCommand(
      services,
      record,
      { id: mine.id, channel: 'email', purpose: 'marketing', status: 'granted', note },
      {
        context: {
          agencyId: mine.business.agencyId,
          actorKind: 'user',
          correlationId: randomUUID(),
        },
        permissions: 'all',
      },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  for (const unknown of [toPublicId('contact', randomUUIDv7()), 'con_nonsense', mine.contact.id])
    await expect(
      withTenant(db, reader.context, (trx) => readContactConsent(trx, reader, unknown, actorNames)),
    ).rejects.toBeInstanceOf(NotFoundError);
});

// A UUIDv7 no row has: the public id format needs version 7.
function randomUUIDv7(): string {
  const random = randomUUID();
  return `${random.slice(0, 14)}7${random.slice(15)}`;
}

it('shows a contact in the trash read-only and records nothing for it', async () => {
  const f = await fixture();
  await f.change();
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at=now() where id=$1', [f.contact.id]),
  );
  const answer = await f.read(f.as('all'));
  expect(answer.canManage).toBe(false);
  expect(answer.history).toHaveLength(1);
  await expect(f.change({ status: 'withdrawn' })).rejects.toBeInstanceOf(NotFoundError);
  expect(await f.ledger()).toHaveLength(1);
});

it('shows do not contact, time zone and the addresses that cannot be sent to', async () => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({ doNotContact: false, timeZone: null, suppressions: [] });
  await database.withTenant(f.business.context, async (sql) => {
    await sql.query(
      "update crm.contacts set do_not_contact=true,timezone='Africa/Nairobi' where id=$1",
      [f.contact.id],
    );
    await sql.query(
      `insert into messaging.suppressions (business_id,channel,address_normalized,reason,expires_at) values
         (app.business_id(),'email','recipient@example.test','hard_bounce',null),
         (app.business_id(),'sms','recipient@example.test','invalid',null),
         (app.business_id(),'email','someone-else@example.test','complaint',null)`,
    );
  });
  const answer = await f.read();
  expect(answer).toMatchObject({ doNotContact: true, timeZone: 'Africa/Nairobi' });
  expect(answer.suppressions).toMatchObject([
    { channel: 'email', address: 'recipient@example.test', reason: 'hard_bounce', until: null },
  ]);
  // One that has run out stops nothing, so it isn't shown.
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update messaging.suppressions set expires_at=now()-interval '1 minute'"),
  );
  expect((await f.read()).suppressions).toEqual([]);
});

it('returns the newest hundred changes and says when there are more', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into messaging.consents
         (business_id,contact_id,channel,purpose,status,source,proof,recorded_at,recorded_by_kind)
       select app.business_id(),$1,'email','marketing',
         case when n%2=0 then 'granted' else 'withdrawn' end,'import',
         jsonb_build_object('note','Change '||n),now()-make_interval(mins => 200-n),'system'
       from generate_series(1,101) n`,
      [f.contact.id],
    ),
  );
  const answer = await f.read();
  expect(answer.historyTruncated).toBe(true);
  expect(answer.history).toHaveLength(100);
  expect(answer.history[0]?.proof.note).toBe('Change 101');
  expect(answer.history.at(-1)?.proof.note).toBe('Change 2');
  expect(answer.current[0]).toMatchObject({ status: 'withdrawn', source: 'import' });
});

// What the SMS keyword handler and the web chat widget call from their own commands.
const shared = defineCommand({
  name: 'test.consent.shared',
  permission: 'contacts.manage',
  input: z.strictObject({ input: z.unknown(), fail: z.boolean().default(false) }),
  audit: () => ({}),
  async handle(trx, { input, fail }, command) {
    // The test hands over exactly what a caller would, checked by recordConsent itself.
    const result = await recordConsent(trx, command, input as Parameters<typeof recordConsent>[2]);
    if (fail) throw new Error('The enclosing command failed.');
    return result;
  },
});

it('records a keyword or a form as the contact, with the evidence its source needs', async () => {
  const f = await fixture();
  const worker: Invocation = { context: f.system, permissions: 'all' };
  const messageId = randomUUID();
  const widgetId = randomUUID();
  const first = await runCommand(
    services,
    shared,
    {
      input: {
        contactId: f.contact.id,
        channel: 'sms',
        purpose: 'marketing',
        status: 'withdrawn',
        evidence: { source: 'keyword', keyword: 'STOP', messageId },
      },
    },
    worker,
  );
  expect(first.previous).toBe('unknown');
  const second = await runCommand(
    services,
    shared,
    {
      input: {
        contactId: f.contact.id,
        channel: 'sms',
        purpose: 'marketing',
        status: 'granted',
        evidence: {
          source: 'form',
          wording: 'Text me offers.',
          widgetId,
          pageUrl: 'https://example.test/pricing',
          ipAddress: '203.0.113.9',
        },
      },
    },
    worker,
  );
  expect(second.previous).toBe('withdrawn');
  expect(second.id).not.toBe(first.id);
  expect(await f.ledger()).toEqual([
    {
      channel: 'sms',
      purpose: 'marketing',
      status: 'withdrawn',
      source: 'keyword',
      proof: { keyword: 'STOP', messageId },
      recorded_by_kind: 'contact',
      recorded_by_id: f.contact.id,
    },
    {
      channel: 'sms',
      purpose: 'marketing',
      status: 'granted',
      source: 'form',
      proof: {
        wording: 'Text me offers.',
        widgetId,
        pageUrl: 'https://example.test/pricing',
        ipAddress: '203.0.113.9',
      },
      recorded_by_kind: 'contact',
      recorded_by_id: f.contact.id,
    },
  ]);
  const answer = await f.read();
  expect(answer.history.map((row) => [row.source, row.recordedBy.kind, row.proof.linked])).toEqual([
    ['form', 'contact', 'form'],
    ['keyword', 'contact', 'message'],
  ]);
  expect(JSON.stringify(answer)).not.toContain(messageId);
  expect(JSON.stringify(answer)).not.toContain(widgetId);
});

it('writes no row without evidence, for a foreign contact, or when its command fails', async () => {
  const f = await fixture();
  const other = await fixture();
  const worker: Invocation = { context: f.system, permissions: 'all' };
  const base = { contactId: f.contact.id, channel: 'sms', purpose: 'marketing', status: 'granted' };
  for (const evidence of [
    undefined,
    {},
    { source: 'keyword', keyword: 'START' },
    { source: 'form', wording: 'Text me offers.' },
    { source: 'user', note: '' },
    { source: 'keyword', keyword: 'START', messageId: randomUUID(), note: 'extra' },
  ])
    await expect(
      runCommand(services, shared, { input: { ...base, evidence } }, worker),
    ).rejects.toBeInstanceOf(ValidationError);
  const evidence = { source: 'keyword', keyword: 'START', messageId: randomUUID() };
  await expect(
    runCommand(
      services,
      shared,
      { input: { ...base, contactId: other.contact.id, evidence } },
      worker,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    runCommand(services, shared, { input: { ...base, evidence }, fail: true }, worker),
  ).rejects.toThrow('The enclosing command failed.');
  expect(await f.ledger()).toEqual([]);
  expect(await other.ledger()).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select id from events.events where type like 'consent.%'"),
    ),
  ).toEqual([]);
});

it('lets the change made last win, even when its transaction began first', async () => {
  const f = await fixture();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  // A withdrawal whose transaction is already open, as a slow keyword job's would be.
  const slow = defineCommand({
    name: 'test.consent.slow_withdrawal',
    permission: 'contacts.manage',
    input: z.strictObject({}),
    async handle(trx, _input, command) {
      // Fixes this transaction's now() before the grant below begins.
      await trx.selectFrom('crm.contacts').select('id').limit(1).execute();
      began();
      await gate;
      await recordConsent(trx, command, {
        contactId: f.contact.id,
        channel: 'email',
        purpose: 'marketing',
        status: 'withdrawn',
        evidence: { source: 'keyword', keyword: 'STOP', messageId: randomUUID() },
      });
    },
  });
  const withdrawal = runCommand(services, slow, {}, { context: f.system, permissions: 'all' });
  await started;
  await f.change();
  release();
  await withdrawal;
  expect((await f.ledger()).map((row) => row.status)).toEqual(['granted', 'withdrawn']);
  expect(await stateOf(f)).toBe('withdrawn');
  expect(await f.sendCheck()).toBe('consent_withdrawn');
});
