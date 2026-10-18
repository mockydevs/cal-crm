// Request logs end on the day their business keeps them to (ARCHITECTURE.md section 8.6).
import { randomUUID } from 'node:crypto';

import { allowEveryone } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { expireAiProposals, expireAiRequestLogs } from './index.js';

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

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}
const call = (context: TenantContext, expires: string | null) =>
  database.withTenant(context, (sql) =>
    sql.one<{ id: string }>(
      `insert into ai.requests (business_id, job, provider, model, key_source, status, cost_estimate,
                                input_tokens, actor_kind, finished_at, log, log_expires_at)
       values (app.business_id(), 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'ok', 0.0054,
               1200, 'ai_agent', now(), $1, $2::timestamptz)
       returning id`,
      [expires === null ? null : { request: { system: 'What was said.' } }, expires],
    ),
  );
const record = (context: TenantContext, id: string) =>
  database.withTenant(context, (sql) =>
    sql.one<{
      log: unknown;
      log_expires_at: Date | null;
      cost_estimate: string;
      input_tokens: number;
    }>('select log, log_expires_at, cost_estimate, input_tokens from ai.requests where id = $1', [
      id,
    ]),
  );

it('clears what was said once its day has come, in every business, and keeps the spend', async () => {
  const one = await business();
  const other = await business();
  const past = await call(one, '2026-01-01T00:00:00Z');
  const pastElsewhere = await call(other, '2026-01-02T00:00:00Z');
  const future = await call(one, '2999-01-01T00:00:00Z');
  const never = await call(other, null);

  expect(await expireAiRequestLogs({ db, authorize: allowEveryone })).toBe(2);
  for (const [context, id] of [
    [one, past.id],
    [other, pastElsewhere.id],
  ] as const)
    expect(await record(context, id)).toEqual({
      log: null,
      log_expires_at: null,
      cost_estimate: '0.005400',
      input_tokens: 1200,
    });
  expect(await record(one, future.id)).toMatchObject({
    log: { request: { system: 'What was said.' } },
  });
  expect(await record(other, never.id)).toMatchObject({ log: null });
  // Nothing is left to clear.
  expect(await expireAiRequestLogs({ db, authorize: allowEveryone })).toBe(0);
});

it('removes the extraction job’s runs of a month ago with the hourly sweep, in every business, and keeps the rest', async () => {
  const one = await business();
  const other = await business();
  const run = async (context: TenantContext, createdAt: string | null) => {
    const contact = await database.fixtures.contact(context);
    return database.withTenant(context, async (sql) => {
      const conversation = await sql.one<{ id: string }>(
        `insert into messaging.conversations (business_id, contact_id)
         values (app.business_id(), $1) returning id`,
        [contact.id],
      );
      return sql.one<{ id: string }>(
        `insert into ai.extractions (business_id, conversation_id, contact_id, revision, created_at)
         values (app.business_id(), $1, $2, 'thread:1', coalesce($3::timestamptz, now()))
         returning id`,
        [conversation.id, contact.id, createdAt],
      );
    });
  };
  const old = await run(one, '2026-01-01T00:00:00Z');
  const oldElsewhere = await run(other, '2026-01-02T00:00:00Z');
  const recent = await run(one, null);
  // The sweep answers with the proposals it closed: there were none.
  expect(await expireAiProposals({ db, authorize: allowEveryone })).toBe(0);
  const left = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>('select id from ai.extractions where id = any($1::uuid[])', [
      [old.id, oldElsewhere.id, recent.id],
    ]),
  );
  expect(left).toEqual([{ id: recent.id }]);
});
