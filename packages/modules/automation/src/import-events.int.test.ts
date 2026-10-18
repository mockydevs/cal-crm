// What an import's events start. GoHighLevel documents that its Contact Created trigger
// does not fire for contacts imported in bulk, and that a tag added by a CSV import does
// fire its Contact Tag trigger. Here: a contact.created event written by an import starts
// no automation, and still ends or wakes the runs that were waiting for it; every other
// event an import writes matches as anyone's does.
import { randomUUID } from 'node:crypto';

import { allowEveryone, defineCommand, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { contactValues, matchEvent, publishAutomationVersion } from './index.js';

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

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}

/** The context an import's job writes with: the import is who acts. */
const asImport = (context: TenantContext): TenantContext => ({
  ...context,
  actorKind: 'import',
  actorId: randomUUID(),
});

async function publish(context: TenantContext, document: AutomationDocumentInput): Promise<string> {
  return withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: context.businessId ?? '',
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'First');
    return id;
  });
}

const welcome: AutomationDocumentInput = {
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
};

/** A contact made through the CRM's own command, as the context's actor, and its event. */
async function contactCreated(
  context: TenantContext,
): Promise<{ eventId: string; recordId: string; actorKind: string }> {
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Maya', emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  return withTenant(db, context, async (trx) => {
    const row = await trx
      .selectFrom('events.events')
      .select(['id', 'subject_id', 'actor_kind'])
      .where('type', '=', 'contact.created')
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    return { eventId: row.id, recordId: row.subject_id, actorKind: row.actor_kind };
  });
}

const emitTagAssigned = defineCommand({
  name: 'test.tag_assigned',
  permission: 'contacts.manage',
  input: z.strictObject({ tagId: z.uuid(), recordId: z.uuid() }),
  handle: (_trx, input, command) =>
    command.emit({
      type: 'tag.assigned',
      subject: { kind: 'tag', id: input.tagId },
      records: [input.recordId],
      payload: { tagId: input.tagId },
    }),
});

const match = (context: TenantContext, eventId: string) =>
  withTenant(db, context, (trx) => matchEvent(trx, context, eventId, contactValues));

const enrolments = (context: TenantContext) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ automation_id: string; record_id: string; status: string }>(
      'select automation_id, record_id, status from automation.enrolments where business_id = $1',
      [context.businessId],
    ),
  );

it('starts nothing for a contact an import created, and starts it for anyone else’s', async () => {
  const context = await business();
  const automationId = await publish(context, welcome);

  const imported = await contactCreated(asImport(context));
  expect(imported.actorKind).toBe('import');
  expect(await match(context, imported.eventId)).toEqual({ enrolled: [], exited: [], woken: [] });
  expect(await enrolments(context)).toEqual([]);

  // The same event from a person, an API key, a form or the system starts it as before.
  for (const actorKind of ['user', 'api_key', 'form', 'system'] as const) {
    const made = await contactCreated({ ...context, actorKind, actorId: randomUUID() });
    expect((await match(context, made.eventId)).enrolled).toEqual([
      { automationId, recordId: made.recordId, enrolmentId: expect.any(String) as string },
    ]);
  }
  expect(await enrolments(context)).toHaveLength(4);
});

it('starts a tag automation when an import adds the tag, as when anyone does', async () => {
  const context = await business();
  const vip = randomUUID();
  const automationId = await publish(context, {
    ...welcome,
    name: 'Tagged',
    triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: vip } }],
  });
  const importing = asImport(context);
  const { recordId, eventId } = await contactCreated(importing);
  expect((await match(context, eventId)).enrolled).toEqual([]);

  const tagged = await runCommand(
    services,
    emitTagAssigned,
    { tagId: vip, recordId },
    { context: importing, permissions: 'all' },
  );

  expect((await match(context, tagged)).enrolled).toEqual([
    { automationId, recordId, enrolmentId: expect.any(String) as string },
  ]);
});

it('still queues one match for an import’s contact while a Contact created automation is live', async () => {
  // The database queues a match for every event a live automation listens for (0036); the
  // match then starts nothing. Kept here so the cost of an import is known: one job for
  // each contact it creates while such an automation is live, and none otherwise.
  const context = await business();
  const importing = asImport(context);
  // What the tests above left in the queue is theirs.
  await database.runJobs(['automations.match_event']);
  await contactCreated(importing);
  expect(await database.runJobs(['automations.match_event'])).toEqual([]);

  await publish(context, welcome);
  const { eventId } = await contactCreated(importing);

  const queued = await database.runJobs(['automations.match_event']);
  expect(queued.map((job) => (job.payload as { data: { eventId: string } }).data.eventId)).toEqual([
    eventId,
  ]);
  expect(await enrolments(context)).toEqual([]);
});
