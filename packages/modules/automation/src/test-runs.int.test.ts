// A test run never sends, writes or charges anything, and its
// trace matches what a real run would do. Real Postgres; the trace is stored for the builder.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readTestRun, testRunCommand } from './test-runs.js';

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

const draft = {
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  stopWhen: [{ event: 'message.received' }],
  start: 'is_ada',
  steps: {
    is_ada: {
      type: 'condition',
      config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
      next: { yes: 'tag', no: 'pause' },
    },
    tag: { type: 'tag.add', config: { tag: 'VIP' }, next: 'pause' },
    pause: { type: 'wait', config: { duration: 'P2D' }, next: 'text' },
    text: { type: 'sms.send', config: { message: 'Hi {{contact.firstName}}' } },
  },
};

async function setup(
  document: Record<string, unknown> = draft,
): Promise<{ context: TenantContext; automationId: string }> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const automationId = await withTenant(db, context, async (trx) => {
    await trx
      .insertInto('crm.tags')
      .values({ business_id: business.id, name: 'VIP', created_by_kind: 'user' })
      .execute();
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: 'Welcome',
        draft: JSON.stringify(document),
        created_by_kind: 'user',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return toPublicId('automation', id);
  });
  return { context, automationId };
}

const counts = (context: TenantContext) =>
  database.withTenant(context, (client) =>
    client.query<{ tags: number; messages: number; enrolments: number; events: number }>(
      `select (select count(*)::int from crm.record_tags) as tags,
              (select count(*)::int from messaging.messages) as messages,
              (select count(*)::int from automation.enrolments) as enrolments,
              (select count(*)::int from events.events where type <> 'contact.created') as events`,
    ),
  );

it('runs the draft on a real contact, fast-forwarded, stores its trace, and changes nothing', async () => {
  const { context, automationId } = await setup();
  const contact = await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    {
      context,
      permissions: 'all',
    },
  );
  const before = await counts(context);
  const run = await runCommand(
    services,
    testRunCommand,
    { id: automationId, contactId: contact.id, start: '2026-10-09T09:00:00Z' },
    { context, permissions: 'all' },
  );
  expect(run.outcome).toEqual({ kind: 'completed' });
  expect(run.steps.map((step) => [step.step, step.kind])).toEqual([
    ['is_ada', 'branched'],
    ['tag', 'would_change'],
    ['pause', 'waited'],
    ['text', 'would_send'],
  ]);
  expect(await counts(context)).toEqual(before);
  const stored = await database.withTenant(context, (client) =>
    client.query<{ status: string; trace: unknown[]; outcome: unknown }>(
      'select status, trace, outcome from automation.test_runs',
    ),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ status: 'passed' });
  expect(stored[0]?.trace).toHaveLength(4);
  expect(stored[0]?.outcome).toEqual({ kind: 'completed' });
  // The stored run reads back exactly as it was returned, and only through its automation.
  expect(run).toMatchObject({ draftVersion: 1, status: 'passed', contactId: contact.id });
  expect(await withTenant(db, context, (trx) => readTestRun(trx, automationId, run.id))).toEqual(
    run,
  );
  const other = await setup();
  await expect(
    withTenant(db, context, (trx) => readTestRun(trx, other.automationId, run.id)),
  ).rejects.toThrow(/was not found/);
});

it('takes sample values and simulated events instead of a contact', async () => {
  const { context, automationId } = await setup();
  const run = await runCommand(
    services,
    testRunCommand,
    {
      id: automationId,
      values: { 'contact.firstName': 'Grace' },
      events: [{ event: 'message.received', after: 'P1D' }],
      start: '2026-10-09T09:00:00Z',
    },
    { context, permissions: 'all' },
  );
  expect(run.outcome).toMatchObject({ kind: 'stopped', event: 'message.received' });
  expect(run.steps.map((step) => step.step)).toEqual(['is_ada', 'pause']);
});

it("never tests another business's automation", async () => {
  const { automationId } = await setup();
  const other = await setup();
  await expect(
    runCommand(
      services,
      testRunCommand,
      { id: automationId, values: {} },
      { context: other.context, permissions: 'all' },
    ),
  ).rejects.toThrow();
});

it('fails a run that reaches a step the draft does not have, starting from now', async () => {
  const { context, automationId } = await setup({ ...draft, start: 'greet' });
  const before = Date.now();
  const run = await runCommand(
    services,
    testRunCommand,
    { id: automationId },
    { context, permissions: 'all' },
  );
  expect(run).toMatchObject({
    status: 'failed',
    contactId: null,
    steps: [],
    outcome: { kind: 'failed', step: 'greet', error: 'missing_step' },
  });
  expect(new Date(run.createdAt).getTime()).toBeGreaterThanOrEqual(before - 60_000);
  const stored = await database.withTenant(context, (client) =>
    client.query<{ status: string }>('select status from automation.test_runs'),
  );
  expect(stored).toEqual([{ status: 'failed' }]);
});

it('refuses to test a draft that is not an automation document yet, and stores nothing', async () => {
  const { context, automationId } = await setup({ name: 'Half done', steps: {} });
  await expect(
    runCommand(services, testRunCommand, { id: automationId }, { context, permissions: 'all' }),
  ).rejects.toMatchObject({
    name: 'ValidationError',
    issues: [{ path: '/draft', code: 'invalid_draft' }],
  });
  expect(
    await database.withTenant(context, (client) =>
      client.query('select id from automation.test_runs'),
    ),
  ).toEqual([]);
});

it('finds no automation or test run under something that is not an id', async () => {
  const { context, automationId } = await setup();
  await expect(
    runCommand(services, testRunCommand, { id: 'welcome' }, { context, permissions: 'all' }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(db, context, (trx) => readTestRun(trx, automationId, 'latest')),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(db, context, (trx) => readTestRun(trx, 'welcome', 'latest')),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('fills each Send email step in for the contact as a send would, and fails where a send stops', async () => {
  const { context, automationId } = await setup({
    name: 'Still in need',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'still',
    steps: {
      still: { type: 'email.send', config: { template: 'Still in need' }, next: 'own' },
      // Words written in the step itself, filled in the same way.
      own: {
        type: 'email.send',
        config: { subject: 'Hello {{contact.firstName}}', body: 'See you soon.' },
      },
    },
  });
  await database.withTenant(context, (client) =>
    client.query(
      `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
       values (app.business_id(), 'Still in need', 'For {{contact.firstName}}',
               'Are you still in need of a {{contact.custom.service}} team?', 'user')`,
    ),
  );
  const as = { context, permissions: 'all' as const };
  const filled = await runCommand(
    services,
    testRunCommand,
    { id: automationId, values: { 'contact.firstName': 'Ada', 'contact.custom.service': 'DJ' } },
    as,
  );
  expect(filled).toMatchObject({
    status: 'passed',
    steps: [
      {
        step: 'still',
        kind: 'would_send',
        email: {
          subject: 'For Ada',
          firstLine: 'Are you still in need of a DJ team?',
          missingValues: [],
        },
      },
      {
        step: 'own',
        kind: 'would_send',
        email: { subject: 'Hello Ada', firstLine: 'See you soon.', missingValues: [] },
      },
    ],
  });
  const empty = await runCommand(
    services,
    testRunCommand,
    { id: automationId, values: { 'contact.firstName': 'Ada', 'contact.custom.service': null } },
    as,
  );
  expect(empty).toMatchObject({
    status: 'failed',
    outcome: { kind: 'failed', step: 'still', error: 'missing_values' },
    steps: [{ step: 'still', kind: 'ended', email: { missingValues: ['contact.custom.service'] } }],
  });
  // An archived template fails the step as it fails a send.
  await database.withTenant(context, (client) =>
    client.query('update messaging.templates set archived_at = now()'),
  );
  expect(await runCommand(services, testRunCommand, { id: automationId }, as)).toMatchObject({
    outcome: { kind: 'failed', step: 'still', error: 'template_unavailable' },
  });
  // Nothing was sent.
  expect(
    await database.withTenant(context, (client) =>
      client.query('select id from messaging.messages'),
    ),
  ).toEqual([]);
});
