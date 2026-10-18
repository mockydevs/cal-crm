// wait.event: a reply (any awaited event) wakes only the matching enrolment, only if it
// came after the wait began; otherwise the timeout takes timed_out. Real Postgres and real
// events through runCommand.
import { randomUUID } from 'node:crypto';

import { allowEveryone, defineCommand, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  contactValues,
  createRunStepCommand,
  matchEvent,
  publishAutomationVersion,
} from './index.js';

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

// Emits tag.assigned onto a record's timeline, as every command emits.
const emitTagAssigned = defineCommand({
  name: 'test.tag_assigned',
  permission: 'contacts.manage',
  input: z.strictObject({ recordId: z.uuid() }),
  async handle(_trx, input, command) {
    return command.emit({
      type: 'tag.assigned',
      subject: { kind: 'tag', id: randomUUID() },
      records: [input.recordId],
      payload: { recordId: input.recordId },
    });
  },
});

const document: AutomationDocumentInput = {
  name: 'Tagged or not',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'wait_tag',
  steps: {
    wait_tag: {
      type: 'wait.event',
      config: { event: 'tag.added', timeout: 'P3D' },
      next: { received: 'got_it', timed_out: 'gave_up' },
    },
    got_it: { type: 'wait', config: { duration: 'PT1M' } },
    gave_up: { type: 'wait', config: { duration: 'PT1M' } },
  },
};

async function business(): Promise<{ context: TenantContext; id: string }> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context = { ...created.context, correlationId: randomUUID() };
  await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: created.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
  });
  return { context, id: created.id };
}

async function enrol(context: TenantContext, firstName: string) {
  await runCommand(
    services,
    createContactCommand,
    { firstName, emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  return withTenant(db, context, async (trx) => {
    const event = await trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const result = await matchEvent(trx, context, event.id, contactValues);
    return { recordId: event.subject_id, enrolmentId: result.enrolled[0]?.enrolmentId ?? '' };
  });
}

const enrolment = (context: TenantContext, id: string) =>
  withTenant(db, context, (trx) =>
    trx
      .selectFrom('automation.enrolments')
      .select(['status', 'current_step', 'state', 'wake_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );
const sequenceOf = async (context: TenantContext, id: string) =>
  ((await enrolment(context, id)).state as { sequence: number }).sequence;
const step = async (context: TenantContext, id: string, now?: Date) =>
  runCommand(
    services,
    runStepCommand,
    {
      enrolmentId: id,
      sequence: await sequenceOf(context, id),
      ...(now === undefined ? {} : { now: now.toISOString() }),
    },
    { context, permissions: 'all' },
  );
const tag = async (context: TenantContext, recordId: string) => {
  const eventId = await runCommand(
    services,
    emitTagAssigned,
    { recordId },
    { context, permissions: 'all' },
  );
  return withTenant(db, context, (trx) => matchEvent(trx, context, eventId, contactValues));
};
const branches = (context: TenantContext, id: string) =>
  database.withTenant(context, (client) =>
    client.query<{ step_key: string; branch: string | null }>(
      'select step_key, branch from automation.step_runs where enrolment_id = $1 order by started_at, id',
      [id],
    ),
  );

it('wakes only the enrolment of the record the event is on, taking received', async () => {
  const { context } = await business();
  const ada = await enrol(context, 'Ada');
  const grace = await enrol(context, 'Grace');
  expect(await step(context, ada.enrolmentId)).toBe('ran');
  expect(await step(context, grace.enrolmentId)).toBe('ran');
  expect(await enrolment(context, ada.enrolmentId)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_tag',
  });

  expect((await tag(context, ada.recordId)).woken).toEqual([ada.enrolmentId]);
  expect(await step(context, ada.enrolmentId)).toBe('ran');
  expect(await enrolment(context, ada.enrolmentId)).toMatchObject({ current_step: 'got_it' });
  expect((await branches(context, ada.enrolmentId)).map((run) => run.branch)).toEqual([
    null,
    'received',
  ]);
  expect(await enrolment(context, grace.enrolmentId)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_tag',
  });
});

it('ignores an event from before the wait began, even if it is matched after, and times out', async () => {
  const { context } = await business();
  const ada = await enrol(context, 'Ada');
  // Tagged before the wait began, but its match job runs only after the wait armed.
  const earlier = await runCommand(
    services,
    emitTagAssigned,
    { recordId: ada.recordId },
    { context, permissions: 'all' },
  );
  await step(context, ada.enrolmentId);
  expect(
    (await withTenant(db, context, (trx) => matchEvent(trx, context, earlier, contactValues)))
      .woken,
  ).toEqual([]);
  const waiting = await enrolment(context, ada.enrolmentId);
  expect(await step(context, ada.enrolmentId)).toBe('skipped');
  expect(
    await step(context, ada.enrolmentId, new Date((waiting.wake_at?.getTime() ?? 0) + 1000)),
  ).toBe('ran');
  expect((await branches(context, ada.enrolmentId)).map((run) => run.branch)).toEqual([
    null,
    'timed_out',
  ]);
});

it("is never woken by another business's event", async () => {
  const first = await business();
  const second = await business();
  const ada = await enrol(first.context, 'Ada');
  await step(first.context, ada.enrolmentId);
  // The other business can't see the record, so its event lands on nothing of ours.
  await expect(tag(second.context, ada.recordId)).rejects.toThrow();
  expect(await enrolment(first.context, ada.enrolmentId)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_tag',
  });
});

it('lets exactly one of the event and the timeout win', async () => {
  const { context } = await business();
  const ada = await enrol(context, 'Ada');
  await step(context, ada.enrolmentId);
  const waiting = await enrolment(context, ada.enrolmentId);
  await tag(context, ada.recordId);
  const late = new Date((waiting.wake_at?.getTime() ?? 0) + 1000);
  // Both deliveries name the same visit, even if one finishes before the other starts.
  const input = {
    enrolmentId: ada.enrolmentId,
    sequence: await sequenceOf(context, ada.enrolmentId),
    now: late.toISOString(),
  };
  const results = await Promise.all([
    runCommand(services, runStepCommand, input, { context, permissions: 'all' }),
    runCommand(services, runStepCommand, input, { context, permissions: 'all' }),
  ]);
  expect(results.sort()).toEqual(['ran', 'skipped']);
  expect((await branches(context, ada.enrolmentId)).map((run) => run.branch)).toEqual([
    null,
    'received',
  ]);
});
