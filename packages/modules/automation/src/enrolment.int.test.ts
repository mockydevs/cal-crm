// One event enrols each matching record once, and re-entry
// follows the automation's setting. Real Postgres, real CRM command and event.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Services,
  type Invocation,
} from '@repo/commands';
import { automationDocument, note, task, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import {
  createContactCommand,
  createCrmRoutes,
  taskRoutes,
  createTagCommand,
  assignRecordTagCommand,
  removeRecordTagCommand,
  type TaskOptions,
} from '@repo/module-crm';
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

const welcome = (patch: Partial<AutomationDocumentInput> = {}): AutomationDocumentInput => ({
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'tag_new',
  steps: { tag_new: { type: 'tag.add', config: { tag: 'New' } } },
  ...patch,
});

async function publish(context: TenantContext, document: AutomationDocumentInput): Promise<string> {
  return withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: context.businessId ?? '',
        name: 'Welcome',
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(
      trx,
      context,
      id,
      automationDocument.parse(document),
      'First version',
    );
    return id;
  });
}

/** Creates a contact through the CRM's own command, so its contact.created event is real. */
async function contactCreated(
  context: TenantContext,
  firstName: string,
): Promise<{ eventId: string; recordId: string }> {
  await runCommand(
    services,
    createContactCommand,
    { firstName, emails: [`${randomUUID()}@example.test`] },
    {
      context,
      permissions: 'all',
    },
  );
  return withTenant(db, context, async (trx) => {
    const row = await trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    return { eventId: row.id, recordId: row.subject_id };
  });
}

const match = (context: TenantContext, eventId: string) =>
  withTenant(db, context, (trx) => matchEvent(trx, context, eventId, contactValues));

const nativeTaskOptions: TaskOptions = {
  actorNames: {},
  assignees: {
    resolve: () => Promise.resolve(null),
    read: () => Promise.resolve({ items: [], nextCursor: null }),
    memberships: () => Promise.resolve(new Map()),
  },
};

async function nativeCommand(
  operationId: string,
  invocation: Invocation,
  params: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const route = [...createCrmRoutes(), ...taskRoutes(nativeTaskOptions)].find(
    (candidate) => candidate.endpoint.operationId === operationId,
  );
  if (route === undefined) throw new Error(`Missing CRM route ${operationId}.`);
  return route.run({ invocation, params, body, query: {} }, services);
}

it.each(['note.created', 'note.updated', 'task.created', 'task.completed'] as const)(
  'enrols the contact on %s emitted by the real CRM command, once',
  async (type) => {
    const context = await business();
    const automationId = await publish(
      context,
      welcome({ triggers: [{ id: 'native', type, config: {} }] }),
    );
    const { recordId, eventId: createdEvent } = await contactCreated(context, 'Native event');
    expect((await match(context, createdEvent)).enrolled).toEqual([]);
    const invocation = { context, permissions: 'all' } as const;
    const id = toPublicId('contact', recordId);
    if (type === 'note.created' || type === 'note.updated') {
      const saved = note.parse(
        await nativeCommand(
          'createNote',
          invocation,
          { id },
          {
            body: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Follow up' }] }],
            },
          },
        ),
      );
      if (type === 'note.updated')
        await nativeCommand(
          'updateNote',
          invocation,
          { id, noteId: saved.id },
          {
            revision: saved.revision,
            body: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Follow up tomorrow' }] },
              ],
            },
          },
        );
    } else {
      const saved = task.parse(
        await nativeCommand('createTask', invocation, {}, { recordId: id, title: 'Follow up' }),
      );
      if (type === 'task.completed')
        await nativeCommand(
          'completeTask',
          invocation,
          { id: saved.id },
          { revision: saved.revision, completed: true },
        );
    }
    const event = await withTenant(db, context, (trx) =>
      trx
        .selectFrom('events.events')
        .select('id')
        .where('type', '=', type)
        .executeTakeFirstOrThrow(),
    );
    expect((await match(context, event.id)).enrolled).toEqual([
      { automationId, recordId, enrolmentId: expect.any(String) as string },
    ]);
    expect((await match(context, event.id)).enrolled).toEqual([]);
  },
);

it('enrols on actual removal of its selected tag and ignores addition and another tag', async () => {
  const context = await business();
  const invocation = { context, permissions: 'all' } as const;
  const selected = await runCommand(services, createTagCommand, { name: 'Selected' }, invocation);
  const other = await runCommand(services, createTagCommand, { name: 'Other' }, invocation);
  const automationId = await publish(
    context,
    welcome({ triggers: [{ id: 'removed', type: 'tag.removed', config: { tag: selected.id } }] }),
  );
  const { recordId } = await contactCreated(context, 'Tag removal');
  const id = toPublicId('contact', recordId);
  for (const tagId of [selected.id, other.id])
    await runCommand(services, assignRecordTagCommand, { id, tagId }, invocation);
  const added = await withTenant(db, context, (trx) =>
    trx.selectFrom('events.events').select('id').where('type', '=', 'tag.assigned').execute(),
  );
  for (const event of added) expect((await match(context, event.id)).enrolled).toEqual([]);
  await runCommand(services, removeRecordTagCommand, { id, tagId: other.id }, invocation);
  const otherEvent = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'tag.removed')
      .executeTakeFirstOrThrow(),
  );
  expect((await match(context, otherEvent.id)).enrolled).toEqual([]);
  await runCommand(services, removeRecordTagCommand, { id, tagId: selected.id }, invocation);
  const selectedEvent = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'tag.removed')
      .where('id', '!=', otherEvent.id)
      .executeTakeFirstOrThrow(),
  );
  expect((await match(context, selectedEvent.id)).enrolled).toEqual([
    { automationId, recordId, enrolmentId: expect.any(String) as string },
  ]);
  expect((await match(context, selectedEvent.id)).enrolled).toEqual([]);
});

it('does not enrol any contact for a task with no linked record', async () => {
  const context = await business();
  await publish(context, welcome({ triggers: [{ id: 'task', type: 'task.created', config: {} }] }));
  await contactCreated(context, 'Unrelated contact');
  await nativeCommand('createTask', { context, permissions: 'all' }, {}, { title: 'Team task' });
  const event = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'task.created')
      .executeTakeFirstOrThrow(),
  );
  expect((await match(context, event.id)).enrolled).toEqual([]);
});

// A tag added to a record, as the CRM emits it; with no record, it is on nobody's timeline.
const emitTagAssigned = defineCommand({
  name: 'test.tag_assigned',
  permission: 'contacts.manage',
  input: z.strictObject({ tagId: z.uuid(), recordId: z.uuid().optional() }),
  async handle(_trx, input, command) {
    return command.emit({
      type: 'tag.assigned',
      subject: { kind: 'tag', id: input.tagId },
      records: input.recordId === undefined ? [] : [input.recordId],
      payload: { tagId: input.tagId },
    });
  },
});

const tagged = (context: TenantContext, tagId: string, recordId?: string) =>
  runCommand(
    services,
    emitTagAssigned,
    { tagId, ...(recordId === undefined ? {} : { recordId }) },
    // Each tagging is a request of its own, as a person's is.
    { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
  );

it('enrols each matching record once, however often the event is matched', async () => {
  const context = await business();
  const automationId = await publish(context, welcome());
  const { eventId, recordId } = await contactCreated(context, 'Ada');
  expect((await match(context, eventId)).enrolled).toEqual([
    { automationId, recordId, enrolmentId: expect.any(String) as string },
  ]);
  expect((await match(context, eventId)).enrolled).toEqual([]);
  const rows = await database.withTenant(context, (sql) =>
    sql.query<{ status: string; current_step: string; trigger_event_id: string }>(
      'select status, current_step, trigger_event_id from automation.enrolments',
    ),
  );
  expect(rows).toEqual([{ status: 'running', current_step: 'tag_new', trigger_event_id: eventId }]);
});

// The same event matched again (a match job run twice) starts nothing more, whatever the
// re-entry setting: the run it started already read it.
it.each([
  ['never', 0],
  ['after_finished', 0],
] as const)(
  'starts nothing more from the same event once its run finished, when re-entry is %s: %s more',
  async (reEnrollment, again) => {
    const context = await business();
    await publish(context, welcome({ settings: { reEnrollment } }));
    const { eventId } = await contactCreated(context, 'Grace');
    expect((await match(context, eventId)).enrolled).toHaveLength(1);
    await database.withTenant(context, (sql) =>
      sql.query("update automation.enrolments set status = 'completed', finished_at = now()"),
    );
    expect((await match(context, eventId)).enrolled).toHaveLength(again);
  },
);

it("enrols only records that pass the trigger's condition", async () => {
  const context = await business();
  await publish(
    context,
    welcome({
      triggers: [
        {
          id: 'created',
          type: 'contact.created',
          config: {},
          if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' },
        },
      ],
    }),
  );
  const grace = await contactCreated(context, 'Grace');
  const ada = await contactCreated(context, 'Ada');
  expect((await match(context, grace.eventId)).enrolled).toEqual([]);
  expect((await match(context, ada.eventId)).enrolled).toHaveLength(1);
});

it("doesn't enrol into a paused automation, or another business's", async () => {
  const context = await business();
  const other = await business();
  const automationId = await publish(context, welcome());
  await publish(other, welcome());
  await withTenant(db, context, (trx) =>
    trx
      .updateTable('automation.automations')
      .set({ status: 'paused' })
      .where('id', '=', automationId)
      .execute(),
  );
  const { eventId } = await contactCreated(context, 'Ada');
  expect((await match(context, eventId)).enrolled).toEqual([]);
  // The other business can't even see this business's event.
  expect((await match(other, eventId)).enrolled).toEqual([]);
});

it('queues one match job for an event an active automation listens for, and none otherwise', async () => {
  const quiet = await business();
  await contactCreated(quiet, 'Nobody');
  const listening = await business();
  await publish(listening, welcome());
  const { eventId } = await contactCreated(listening, 'Ada');
  const jobs = (await database.runJobs(['automations.match_event'])).filter(
    ({ payload }) =>
      typeof payload === 'object' &&
      payload !== null &&
      'businessId' in payload &&
      (payload.businessId === quiet.businessId || payload.businessId === listening.businessId),
  );
  expect(jobs).toEqual([
    {
      task: 'automations.match_event',
      payload: expect.objectContaining({
        businessId: listening.businessId,
        causationId: eventId,
        data: { eventId },
      }) as unknown,
    },
  ]);
});

it("starts only on an event that passes the trigger's own filter", async () => {
  const context = await business();
  const [vip, other] = [
    '0192f3a0-1111-7222-8333-444455556666',
    '0192f3a0-1111-7222-8333-444455557777',
  ];
  const automationId = await publish(
    context,
    welcome({ triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: vip } }] }),
  );
  const { recordId } = await contactCreated(context, 'Ada');
  expect((await match(context, await tagged(context, other, recordId))).enrolled).toEqual([]);
  expect((await match(context, await tagged(context, vip, recordId))).enrolled).toEqual([
    { automationId, recordId, enrolmentId: expect.any(String) as string },
  ]);
});

it('starts an automation once when two of its triggers hear the same event', async () => {
  const context = await business();
  await publish(
    context,
    welcome({
      triggers: [
        { id: 'created', type: 'contact.created', config: {} },
        { id: 'created_too', type: 'contact.created', config: {} },
      ],
    }),
  );
  const subscriptions = await database.withTenant(context, (sql) =>
    sql.query<{ event_type: string }>('select event_type from automation.trigger_subscriptions'),
  );
  expect(subscriptions).toEqual([
    { event_type: 'contact.created' },
    { event_type: 'contact.created' },
  ]);
  const { eventId } = await contactCreated(context, 'Ada');
  expect((await match(context, eventId)).enrolled).toHaveLength(1);
  const rows = await database.withTenant(context, (sql) =>
    sql.query<{ status: string }>('select status from automation.enrolments'),
  );
  expect(rows).toEqual([{ status: 'running' }]);
});

it("starts a record that passes any one of an automation's triggers on the event", async () => {
  const context = await business();
  await publish(
    context,
    welcome({
      triggers: [
        {
          id: 'ada',
          type: 'contact.created',
          config: {},
          if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' },
        },
        {
          id: 'grace',
          type: 'contact.created',
          config: {},
          if: { field: 'contact.firstName', operator: 'equals', value: 'Grace' },
        },
      ],
    }),
  );
  // Whichever trigger is read first, one of these two passes only the other.
  const ada = await contactCreated(context, 'Ada');
  const grace = await contactCreated(context, 'Grace');
  const linus = await contactCreated(context, 'Linus');
  expect((await match(context, ada.eventId)).enrolled).toHaveLength(1);
  expect((await match(context, grace.eventId)).enrolled).toHaveLength(1);
  expect((await match(context, linus.eventId)).enrolled).toEqual([]);
});

it('has nobody to start for an event on no record, and nothing to do outside a business', async () => {
  const context = await business();
  const vip = '0192f3a0-1111-7222-8333-444455556666';
  await publish(
    context,
    welcome({ triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: vip } }] }),
  );
  const eventId = await tagged(context, vip);
  expect(await match(context, eventId)).toEqual({ enrolled: [], exited: [], woken: [] });

  // Agency staff outside any business see the event, but automations belong to a business.
  const agencyWide: TenantContext = {
    agencyId: context.agencyId,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  expect(
    await withTenant(db, agencyWide, (trx) => matchEvent(trx, agencyWide, eventId, contactValues)),
  ).toEqual({ enrolled: [], exited: [] });
  expect(
    await database.withTenant(context, (sql) => sql.query('select id from automation.enrolments')),
  ).toEqual([]);
});

it('publishes only inside a business, and listens for no event when a webhook starts it', async () => {
  const context = await business();
  const byWebhook = welcome({
    triggers: [{ id: 'called', type: 'webhook.received', config: {} }],
  });
  const automationId = await publish(context, byWebhook);
  const stored = await database.withTenant(context, (sql) =>
    sql.query<{ status: string; subscriptions: number; versions: number }>(
      `select status,
              (select count(*)::int from automation.trigger_subscriptions) as subscriptions,
              (select count(*)::int from automation.versions) as versions
       from automation.automations`,
    ),
  );
  expect(stored).toEqual([{ status: 'active', subscriptions: 0, versions: 1 }]);

  const agencyWide: TenantContext = {
    agencyId: context.agencyId,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  await expect(
    withTenant(db, context, (trx) =>
      publishAutomationVersion(
        trx,
        agencyWide,
        automationId,
        automationDocument.parse(byWebhook),
        'Second version',
      ),
    ),
  ).rejects.toThrow('Publishing needs a business.');
  expect(
    await database.withTenant(context, (sql) =>
      sql.query<{ version: number }>('select version from automation.versions'),
    ),
  ).toEqual([{ version: 1 }]);
});

it('enrols a record again only once its last run has ended, when re-entry is after_finished', async () => {
  const context = await business();
  const vip = '0192f3a0-1111-7222-8333-444455556666';
  await publish(
    context,
    welcome({
      triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: vip } }],
      settings: { reEnrollment: 'after_finished' },
    }),
  );
  const { recordId } = await contactCreated(context, 'Ada');
  // Three separate events on the same record: each tagging is its own event.
  expect((await match(context, await tagged(context, vip, recordId))).enrolled).toHaveLength(1);
  // Still in it: a second start is refused while the first run is live.
  expect((await match(context, await tagged(context, vip, recordId))).enrolled).toEqual([]);
  const live = () =>
    database.withTenant(context, (sql) =>
      sql.query<{ status: string }>('select status from automation.enrolments order by id'),
    );
  expect(await live()).toEqual([{ status: 'running' }]);
  await database.withTenant(context, (sql) =>
    sql.query("update automation.enrolments set status = 'completed', finished_at = now()"),
  );
  expect((await match(context, await tagged(context, vip, recordId))).enrolled).toHaveLength(1);
  expect(await live()).toEqual([{ status: 'completed' }, { status: 'running' }]);
});

it('enrols every record one event is on, each once', async () => {
  const context = await business();
  const vip = '0192f3a0-1111-7222-8333-444455556666';
  const automationId = await publish(
    context,
    welcome({ triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: vip } }] }),
  );
  const ada = await contactCreated(context, 'Ada');
  const grace = await contactCreated(context, 'Grace');
  const linus = await contactCreated(context, 'Linus');
  // One event on two timelines, as a change that concerns two records is recorded.
  const eventId = await runCommand(
    services,
    defineCommand({
      name: 'test.tag_assigned_to_many',
      permission: 'contacts.manage',
      input: z.strictObject({ records: z.array(z.uuid()) }),
      handle: (_trx, input, command) =>
        command.emit({
          type: 'tag.assigned',
          subject: { kind: 'tag', id: vip },
          records: input.records,
          payload: { tagId: vip },
        }),
    }),
    { records: [ada.recordId, grace.recordId] },
    { context, permissions: 'all' },
  );
  const first = await match(context, eventId);
  expect(first.enrolled.map((each) => [each.automationId, each.recordId]).sort()).toEqual(
    [
      [automationId, ada.recordId],
      [automationId, grace.recordId],
    ].sort(),
  );
  expect((await match(context, eventId)).enrolled).toEqual([]);
  const enrolled = await database.withTenant(context, (sql) =>
    sql.query<{ record_id: string }>('select record_id from automation.enrolments'),
  );
  expect(enrolled.map((row) => row.record_id).sort()).toEqual(
    [ada.recordId, grace.recordId].sort(),
  );
  expect(enrolled.map((row) => row.record_id)).not.toContain(linus.recordId);
});
