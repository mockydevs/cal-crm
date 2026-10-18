import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
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

it.each([
  { title: 'Review', dueIn: undefined, values: {}, outcome: { kind: 'completed' } },
  {
    title: 'Review {{steps.note.noteId}}',
    dueIn: 'PT1H',
    values: {},
    outcome: { kind: 'completed' },
  },
  {
    title: 'Review {{contact.missing}}',
    dueIn: undefined,
    values: {},
    outcome: { kind: 'failed', step: 'task', error: 'missing_values' },
  },
  {
    title: '{{contact.title}}',
    dueIn: undefined,
    values: { 'contact.title': 'x'.repeat(301) },
    outcome: { kind: 'failed', step: 'task', error: 'too_big' },
  },
  {
    title: 'Review',
    dueIn: 'P9999999999999999999999D',
    values: {},
    outcome: { kind: 'failed', step: 'task', error: 'date_out_of_range' },
  },
])(
  'stores marked simulated outputs while refusing invalid follow-up tasks %#',
  async ({ title, dueIn, values, outcome }) => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const context = { ...business.context, correlationId: randomUUID() };
    const contact = await runCommand(
      services,
      createContactCommand,
      { firstName: 'Ada' },
      { context, permissions: 'all' },
    );
    const automationId = await withTenant(db, context, async (trx) => {
      const row = await trx
        .insertInto('automation.automations')
        .values({
          business_id: business.id,
          name: 'Simulated outputs',
          created_by_kind: 'user',
          draft: JSON.stringify({
            name: 'Simulated outputs',
            triggers: [{ id: 'created', type: 'contact.created', config: {} }],
            start: 'note',
            steps: {
              note: {
                type: 'note.create',
                config: { text: 'Call {{contact.firstName}}.' },
                next: 'task',
              },
              task: { type: 'task.create', config: { title, dueIn } },
            },
          }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return toPublicId('automation', row.id);
    });
    const counts = () =>
      database.withTenant(context, (client) =>
        client.query<{ notes: number; tasks: number; events: number }>(
          'select (select count(*)::int from crm.notes) as notes, (select count(*)::int from crm.tasks) as tasks, (select count(*)::int from events.events) as events',
        ),
      );
    const before = await counts();
    const run = await runCommand(
      services,
      testRunCommand,
      { id: automationId, contactId: contact.id, start: '2026-10-11T09:00:00Z', values },
      { context, permissions: 'all' },
    );
    expect(run.outcome).toEqual(outcome);
    expect(run.steps[0]).toMatchObject({
      step: 'note',
      simulated: true,
      output: { noteId: 'simulated:note:note:1' },
    });
    if (outcome.kind === 'completed')
      expect(run.steps[1]).toMatchObject({
        step: 'task',
        simulated: true,
        output: { taskId: 'simulated:task:task:2' },
      });
    else expect(run.steps).toHaveLength(1);
    expect(await withTenant(db, context, (trx) => readTestRun(trx, automationId, run.id))).toEqual(
      run,
    );
    expect(await counts()).toEqual(before);
  },
);
