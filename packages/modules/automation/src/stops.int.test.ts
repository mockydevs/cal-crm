// Stop conditions (AUTOMATIONS.md stopWhen): an event ends only the matching enrolments,
// mid-wait too, with the reason recorded. Real Postgres and real events.
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

// Emits an event the way every command does, through runCommand, onto a record's timeline.
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

// A message arriving in the contact's conversation, as messaging emits it.
const emitMessageReceived = defineCommand({
  name: 'test.message_received',
  permission: 'contacts.manage',
  input: z.strictObject({ recordId: z.uuid() }),
  async handle(_trx, input, command) {
    return command.emit({
      type: 'message.received',
      subject: { kind: 'message', id: randomUUID() },
      records: [input.recordId],
      payload: { channel: 'email' },
    });
  },
});

const document = (patch: Partial<AutomationDocumentInput> = {}): AutomationDocumentInput => ({
  name: 'Until tagged',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  stopWhen: [{ event: 'tag.added' }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P7D' } } },
  ...patch,
});

async function setup(patch: Partial<AutomationDocumentInput> = {}) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: 'Until tagged',
        draft: JSON.stringify(document(patch)),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(
      trx,
      context,
      id,
      automationDocument.parse(document(patch)),
      'v1',
    );
  });
  const invocation = { context, permissions: 'all' as const };
  const enrol = async (firstName: string) => {
    await runCommand(
      services,
      createContactCommand,
      { firstName, emails: [`${randomUUID()}@example.test`] },
      invocation,
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
      const enrolmentId = result.enrolled[0]?.enrolmentId ?? '';
      return { recordId: event.subject_id, enrolmentId };
    }).then(async (enrolled) => {
      await runCommand(
        services,
        runStepCommand,
        { enrolmentId: enrolled.enrolmentId, sequence: 0 },
        invocation,
      );
      return enrolled;
    });
  };
  const tag = async (recordId: string) => {
    const eventId = await runCommand(services, emitTagAssigned, { recordId }, invocation);
    return withTenant(db, context, (trx) => matchEvent(trx, context, eventId, contactValues));
  };
  const message = async (recordId: string) => {
    const eventId = await runCommand(services, emitMessageReceived, { recordId }, invocation);
    return withTenant(db, context, (trx) => matchEvent(trx, context, eventId, contactValues));
  };
  const enrolment = (id: string) =>
    withTenant(db, context, (trx) =>
      trx
        .selectFrom('automation.enrolments')
        .select(['status', 'exit_reason', 'state'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  const waits = (id: string) =>
    database.withTenant(context, (client) =>
      client.query('select kind, event_type from automation.event_waits where enrolment_id = $1', [
        id,
      ]),
    );
  return { business, context, enrol, tag, message, enrolment, waits };
}

it('ends only the enrolment of the record the event is on, mid-wait, with the reason', async () => {
  const s = await setup();
  const ada = await s.enrol('Ada');
  const grace = await s.enrol('Grace');
  expect(await s.enrolment(ada.enrolmentId)).toMatchObject({ status: 'waiting' });
  expect(await s.waits(ada.enrolmentId)).toEqual([{ kind: 'stop', event_type: 'tag.assigned' }]);

  expect((await s.tag(ada.recordId)).exited).toEqual([ada.enrolmentId]);
  expect(await s.enrolment(ada.enrolmentId)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:tag.added',
  });
  expect(await s.waits(ada.enrolmentId)).toEqual([]);
  expect(await s.enrolment(grace.enrolmentId)).toMatchObject({
    status: 'waiting',
    exit_reason: null,
  });

  // The step job left from the wait finds nothing to run.
  const ended = await s.enrolment(ada.enrolmentId);
  const sequence = (ended.state as { sequence: number }).sequence;
  expect(
    await runCommand(
      services,
      runStepCommand,
      {
        enrolmentId: ada.enrolmentId,
        sequence,
        now: new Date(Date.now() + 8 * 86_400_000).toISOString(),
      },
      { context: s.context, permissions: 'all' },
    ),
  ).toBe('skipped');
});

it("doesn't stop when the stop's condition doesn't hold", async () => {
  const s = await setup({
    stopWhen: [
      { event: 'tag.added', if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
    ],
  });
  const grace = await s.enrol('Grace');
  expect((await s.tag(grace.recordId)).exited).toEqual([]);
  expect(await s.enrolment(grace.enrolmentId)).toMatchObject({ status: 'waiting' });
});

it('ends once when more than one of its stops listens for the event', async () => {
  const s = await setup({
    stopWhen: [
      { event: 'tag.added' },
      { event: 'tag.added', if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
    ],
  });
  const ada = await s.enrol('Ada');
  expect(await s.waits(ada.enrolmentId)).toEqual([
    { kind: 'stop', event_type: 'tag.assigned' },
    { kind: 'stop', event_type: 'tag.assigned' },
  ]);
  expect((await s.tag(ada.recordId)).exited).toEqual([ada.enrolmentId]);
  expect(await s.enrolment(ada.enrolmentId)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:tag.added',
  });
  expect(await s.waits(ada.enrolmentId)).toEqual([]);
  // Nothing is left to end: the same event again finds no live enrolment.
  expect((await s.tag(ada.recordId)).exited).toEqual([]);
});

it('ends on a message from the contact, and never on a stop that waits for the team', async () => {
  const team = await setup({ stopWhen: [{ event: 'message.received', from: 'team' }] });
  const ada = await team.enrol('Ada');
  expect(await team.waits(ada.enrolmentId)).toEqual([
    { kind: 'stop', event_type: 'message.received' },
  ]);
  // message.received is the contact writing in, so a stop for the team's messages stays.
  expect((await team.message(ada.recordId)).exited).toEqual([]);
  expect(await team.enrolment(ada.enrolmentId)).toMatchObject({
    status: 'waiting',
    exit_reason: null,
  });

  const anyone = await setup({ stopWhen: [{ event: 'message.received', from: 'contact' }] });
  const grace = await anyone.enrol('Grace');
  expect((await anyone.message(grace.recordId)).exited).toEqual([grace.enrolmentId]);
  expect(await anyone.enrolment(grace.enrolmentId)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:message.received',
  });
});

it('queues a match job for an event a waiting enrolment listens for', async () => {
  const s = await setup();
  const ada = await s.enrol('Ada');
  await database.runJobs(['automations.match_event']);
  const eventId = await runCommand(
    services,
    emitTagAssigned,
    { recordId: ada.recordId },
    { context: s.context, permissions: 'all' },
  );
  const jobs = (await database.runJobs(['automations.match_event'])).filter(
    ({ payload }) =>
      typeof payload === 'object' &&
      payload !== null &&
      'causationId' in payload &&
      payload.causationId === eventId,
  );
  expect(jobs).toHaveLength(1);
});
