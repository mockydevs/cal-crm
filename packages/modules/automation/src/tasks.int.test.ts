// The worker's two everyday tasks, run as the worker runs them: one starts automations from
// a stored event, the other runs an enrolment's step, and a job delivered twice does its
// work once. Real Postgres and the CRM's own contact event.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { publishAutomationVersion } from './enrolment.js';
import { matchEventTask } from './match-task.js';
import { createRunStepTask } from './runner.js';

// This automation creates no tasks, so nothing here resolves an assignee.
const runStepTask = createRunStepTask({
  tasks: {
    actorNames: {},
    assignees: {
      resolve: () => Promise.resolve(null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
  },
});

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

const document: AutomationDocumentInput = {
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
};

it('starts an automation from a stored event and runs its first step, once each', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
  });
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  const event = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow(),
  );
  const job = { invocation: { context, permissions: 'all' as const }, services };
  const enrolments = () =>
    database.withTenant(context, (sql) =>
      sql.query<{ id: string; record_id: string; status: string; wake_at: Date | null }>(
        'select id, record_id, status, wake_at from automation.enrolments',
      ),
    );

  await matchEventTask.run({ eventId: event.id }, job);
  await matchEventTask.run({ eventId: event.id }, job);
  const [enrolment, ...others] = await enrolments();
  expect(others).toEqual([]);
  expect(enrolment).toMatchObject({ record_id: event.subject_id, status: 'running' });
  if (enrolment === undefined) throw new Error('Nothing enrolled.');

  await runStepTask.run({ enrolmentId: enrolment.id, sequence: 0 }, job);
  await runStepTask.run({ enrolmentId: enrolment.id, sequence: 0 }, job);
  const [waiting] = await enrolments();
  expect(waiting).toMatchObject({ status: 'waiting' });
  expect(waiting?.wake_at?.getTime()).toBeGreaterThan(Date.now());
  const runs = await database.withTenant(context, (sql) =>
    sql.query<{ step_key: string; status: string }>(
      'select step_key, status from automation.step_runs',
    ),
  );
  expect(runs).toEqual([{ step_key: 'pause', status: 'waiting' }]);
});
