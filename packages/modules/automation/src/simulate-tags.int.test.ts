import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { testRunCommand } from './test-runs.js';

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

it.each([false, true])(
  'simulates tag state with tenant-scoped metadata (outside=%s)',
  async (outside) => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const tagBusiness = outside ? await database.fixtures.business(agency.id) : business;
    const tagId = await withTenant(db, tagBusiness.context, async (trx) => {
      const tag = await trx
        .insertInto('crm.tags')
        .values({ business_id: tagBusiness.id, name: 'VIP', created_by_kind: 'user' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return toPublicId('tag', tag.id);
    });
    const context = { ...business.context, correlationId: randomUUID() };
    const contact = await runCommand(
      services,
      createContactCommand,
      { firstName: 'Ada' },
      { context, permissions: 'all' },
    );
    const automationId = await withTenant(db, context, async (trx) => {
      const automation = await trx
        .insertInto('automation.automations')
        .values({
          business_id: business.id,
          name: 'Tag route',
          created_by_kind: 'user',
          draft: JSON.stringify({
            name: 'Tag route',
            triggers: [{ id: 'created', type: 'contact.created', config: {} }],
            start: 'tag',
            steps: {
              tag: { type: 'tag.add', config: { tag: tagId }, next: 'check' },
              check: {
                type: 'condition',
                config: { if: { field: 'contact.tags', operator: 'includes', value: 'VIP' } },
                next: { yes: 'matched', no: 'stale' },
              },
              matched: { type: 'wait', config: { duration: 'PT1S' } },
              stale: { type: 'wait', config: { duration: 'PT1S' } },
            },
          }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return toPublicId('automation', automation.id);
    });
    const counts = () =>
      database.withTenant(context, (client) =>
        client.query<{ tags: number; events: number }>(
          'select (select count(*)::int from crm.record_tags) as tags, (select count(*)::int from events.events) as events',
        ),
      );
    const before = await counts();
    const run = await runCommand(
      services,
      testRunCommand,
      { id: automationId, contactId: contact.id, start: '2026-10-11T09:00:00Z' },
      { context, permissions: 'all' },
    );
    expect(run.outcome).toEqual(
      outside ? { kind: 'failed', step: 'tag', error: 'unknown_reference' } : { kind: 'completed' },
    );
    expect(run.steps.map((step) => step.step)).toEqual(outside ? [] : ['tag', 'check', 'matched']);
    expect(await counts()).toEqual(before);
    const stored = await database.withTenant(context, (client) =>
      client.query<{ first_name: string }>('select first_name from crm.contacts'),
    );
    expect(stored).toEqual([{ first_name: 'Ada' }]);
  },
);
