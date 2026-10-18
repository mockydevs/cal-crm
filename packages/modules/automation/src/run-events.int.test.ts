// A run that ends says so once (AUTOMATIONS.md section 5): automation.run.completed or
// automation.run.failed, on the record's timeline, in the same transaction as its last step.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';

// These automations create no tasks, so nothing here resolves an assignee.
const runStepCommand = createRunStepCommand({
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

/** Enrols a new contact in the automation, runs it to its end, and gives its run events. */
async function ended(steps: AutomationDocumentInput['steps'], start: string) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const document: AutomationDocumentInput = {
    name: 'Short',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start,
    steps,
  };
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  const ids = await withTenant(db, context, async (trx) => {
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
    const event = await trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow();
    const [first] = (await matchEvent(trx, context, event.id, contactValues)).enrolled;
    if (first === undefined) throw new Error('Nothing enrolled.');
    return { automation: id, enrolment: first.enrolmentId, contact: event.subject_id };
  });
  const run = (sequence: number) =>
    runCommand(
      services,
      runStepCommand,
      { enrolmentId: ids.enrolment, sequence },
      { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
    );
  const events = () =>
    database.withTenant(context, (sql) =>
      sql.query<{ type: string; subject_kind: string; subject_id: string; payload: unknown }>(
        `select type, subject_kind, subject_id, payload from events.events
         where type like 'automation.run.%' order by recorded_at, id`,
      ),
    );
  return { ids, run, events, context };
}

it('says a run completed, once, for its record', async () => {
  const s = await ended(
    {
      split: {
        type: 'condition',
        config: { if: { field: 'contact.firstName', operator: 'is_set' } },
      },
    },
    'split',
  );
  expect(await s.run(0)).toBe('ran');
  expect(await s.events()).toEqual([
    {
      type: 'automation.run.completed',
      subject_kind: 'automation_run',
      subject_id: s.ids.enrolment,
      payload: { automationId: toPublicId('automation', s.ids.automation) },
    },
  ]);
  // The same job again does nothing, and says nothing more.
  expect(await s.run(0)).toBe('skipped');
  expect(await s.events()).toHaveLength(1);
  const timeline = await database.withTenant(s.context, (sql) =>
    sql.query<{ count: number }>(
      `select count(*)::int as count from crm.timeline_entries t
       join events.events e on e.id = t.event_id
       where t.record_id = $1 and e.type = 'automation.run.completed'`,
      [s.ids.contact],
    ),
  );
  expect(timeline).toEqual([{ count: 1 }]);
});

it('says a run failed, with why', async () => {
  const s = await ended({ tell: { type: 'team.notify', config: { message: 'Hi' } } }, 'tell');
  await s.run(0);
  expect(await s.events()).toMatchObject([
    {
      type: 'automation.run.failed',
      subject_id: s.ids.enrolment,
      payload: { reason: 'not_implemented' },
    },
  ]);
});
