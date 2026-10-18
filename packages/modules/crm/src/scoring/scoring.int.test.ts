// Engagement scoring against a migrated Postgres, as crm_app under row-level security:
// Settings → Manage Scoring through its routes (a draft, published to score), the job the
// database queues for an event the live rules listen to, the workflow step's change and a
// person's. Events are written through a command of this test, as the modules that record
// what contacts do write them: with the contact among the event's records.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  contactScore,
  fieldDefinition,
  scoreProfile,
  scoreRule,
  type Permission,
  type ScoreRule,
  type ScoreRuleInput,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { updateContactCommand } from '../contacts/contacts.js';
import { readRecordField } from '../fields/value-read.js';
import { setRecordFieldCommand } from '../fields/value-writes.js';
import { crmRoutes } from '../index.js';
import { scoringRoutes } from './routes.js';
import { modifyContactScoreCommand, scoreEvent, scoreEventCommand } from './scores.js';

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

interface Business {
  readonly id: string;
  readonly as: (permissions?: readonly Permission[]) => Invocation;
  readonly system: () => Invocation;
}

async function business(): Promise<Business> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return {
    id: created.id,
    as: (permissions) => ({
      context: {
        ...created.context,
        actorKind: 'user',
        actorId: user.id,
        userId: user.id,
        correlationId: randomUUID(),
      },
      permissions: permissions === undefined ? 'all' : new Set(permissions),
    }),
    system: () => ({
      context: { ...created.context, actorKind: 'system', correlationId: randomUUID() },
      permissions: 'all',
    }),
  };
}

const routes = [...crmRoutes, ...scoringRoutes];

/** Runs a route as the server runs it. */
const call = (
  b: Business,
  operationId: string,
  input: { params?: unknown; body?: unknown } = {},
  invocation = b.as(),
): Promise<unknown> => {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return Promise.resolve(
    route.run({ invocation, params: input.params ?? {}, query: {}, body: input.body }, services),
  );
};

const idOf = z.object({ id: z.string() });
const contact = async (b: Business, firstName = 'Jordan'): Promise<string> =>
  idOf.parse(await call(b, 'createContact', { body: { firstName } })).id;
const tag = async (b: Business, name: string): Promise<string> =>
  idOf.parse(await call(b, 'createTag', { body: { name } })).id;
const tagContact = (b: Business, contactId: string, tagId: string) =>
  call(b, 'assignRecordTag', { params: { id: contactId, tagId }, body: {} });

const rule = async (b: Business, body: ScoreRuleInput): Promise<ScoreRule> =>
  scoreRule.parse(await call(b, 'createScoreRule', { body }));
const profile = async (b: Business, invocation = b.as()) =>
  scoreProfile.parse(await call(b, 'getScoreProfile', {}, invocation));
const publish = async (b: Business) =>
  scoreProfile.parse(
    await call(b, 'publishScoreProfile', { body: { revision: (await profile(b)).revision } }),
  );
const scoreOf = async (b: Business, id: string) =>
  contactScore.parse(await call(b, 'getContactScore', { params: { id } }));

/** Writes an event as a module that records what a contact did writes it. */
const emitCommand = defineCommand({
  name: 'test.score_event',
  permission: 'contacts.manage',
  input: z.object({
    type: z.string(),
    records: z.array(z.string()),
    payload: z.record(z.string(), z.unknown()),
  }),
  handle: (_trx, input, command) =>
    command.emit({
      type: input.type,
      subject: { kind: 'contact', id: input.records[0] ?? randomUUID() },
      records: input.records,
      payload: input.payload,
    }),
});
const emit = (
  b: Business,
  type: string,
  contactIds: readonly string[],
  payload: Record<string, unknown> = {},
): Promise<string> =>
  runCommand(
    services,
    emitCommand,
    { type, records: contactIds.map((id) => parsePublicId('contact', id) ?? id), payload },
    b.as(),
  );

const field = async (b: Business, key: string): Promise<string> =>
  fieldDefinition.parse(
    await call(b, 'createField', {
      body: {
        objectKey: 'contact',
        key,
        label: key,
        description: 'What the contact told us.',
        valueType: 'text',
        options: [],
        currency: null,
        aiFillSources: [],
        aiOverwrite: 'ask',
        archived: false,
      },
    }),
  ).id;

/**
 * One save of a contact that changes its name and fields, as a form or an import saves one:
 * the contact's own command and the field command, in one command.
 */
const saveCommand = defineCommand({
  name: 'test.save_contact',
  permission: 'contacts.manage',
  input: z.object({ id: z.string(), firstName: z.string(), fields: z.array(z.string()) }),
  async handle(trx, input, command) {
    await updateContactCommand.handle(
      trx,
      updateContactCommand.input.parse({ id: input.id, firstName: input.firstName }),
      command,
    );
    for (const fieldId of input.fields) {
      const current = await readRecordField(trx, command, input.id, fieldId);
      await setRecordFieldCommand.handle(
        trx,
        setRecordFieldCommand.input.parse({
          id: input.id,
          fieldId,
          value: input.firstName,
          revision: current.revision,
        }),
        command,
      );
    }
  },
});

/** The ids of the business's events of these types, oldest first. */
const eventsOf = async (b: Business, types: readonly string[]): Promise<string[]> =>
  (
    await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>(
        `select id from events.events
         where business_id = $1 and type = any ($2::text[]) order by recorded_at, id`,
        [b.id, types],
      ),
    )
  ).map((row) => row.id);

/** What the worker does for the job the database queued. */
const run = (b: Business, eventId: string) =>
  runCommand(services, scoreEventCommand, { eventId }, b.system());

const queued = (eventId: string): Promise<unknown[]> =>
  database.as('crm_owner', (sql) =>
    sql.query(`select 1 from graphile_worker.jobs where key = 'score-event:' || $1::text`, [
      eventId,
    ]),
  );

const changedEvents = (b: Business): Promise<{ payload: Record<string, unknown> }[]> =>
  database.as('crm_owner', (sql) =>
    sql.query(
      `select payload from events.events
       where business_id = $1 and type = 'contact.score_changed' order by recorded_at, id`,
      [b.id],
    ),
  );

describe('Manage Scoring', () => {
  it('keeps a draft that scores nobody until it is published', async () => {
    const b = await business();
    const jordan = await contact(b);
    const empty = await profile(b);
    expect(empty).toMatchObject({
      name: 'Engagement Score',
      rules: [],
      revision: 0,
      publishedAt: null,
      unpublishedChanges: false,
      liveRules: 0,
      canManage: true,
    });

    await rule(b, { when: { action: 'contact_replied' }, calculation: 'add', points: 3 });
    expect(await profile(b)).toMatchObject({ revision: 1, unpublishedChanges: true, liveRules: 0 });
    const before = await emit(b, 'message.received', [jordan], { channel: 'sms' });
    expect(await queued(before)).toEqual([]);

    const live = await publish(b);
    expect(live).toMatchObject({ unpublishedChanges: false, liveRules: 1 });
    expect(live.publishedAt).not.toBeNull();
    const after = await emit(b, 'message.received', [jordan], { channel: 'sms' });
    expect(await queued(after)).toHaveLength(1);
    // An event no live rule listens to queues nothing.
    expect(await queued(await emit(b, 'note.created', [jordan]))).toEqual([]);
    expect(await run(b, after)).toEqual({ contacts: 1 });
    expect((await scoreOf(b, jordan)).score).toBe(3);

    // A change to the draft scores nothing until it is published again.
    await rule(b, { when: { action: 'payment_received' }, calculation: 'add', points: 10 });
    const unpaid = await emit(b, 'payment.recorded', [jordan]);
    expect(await queued(unpaid)).toEqual([]);
    expect(await run(b, unpaid)).toEqual({ contacts: 0 });
    expect(await profile(b)).toMatchObject({ unpublishedChanges: true, liveRules: 1 });
  });

  it('refuses a publish of a draft that changed since it was read', async () => {
    const b = await business();
    const read = await profile(b);
    await rule(b, { when: { action: 'appointment_booked' }, calculation: 'add', points: 1 });
    await expect(
      call(b, 'publishScoreProfile', { body: { revision: read.revision } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('changes a rule only at the revision it was read at, and deletes it', async () => {
    const b = await business();
    const made = await rule(b, {
      when: { action: 'email_event', event: 'bounced' },
      calculation: 'subtract',
      points: 5,
    });
    const body = {
      when: { action: 'email_event', event: 'complained' },
      calculation: 'subtract',
      points: 20,
      revision: made.revision,
    };
    const saved = scoreRule.parse(
      await call(b, 'updateScoreRule', { params: { ruleId: made.id }, body }),
    );
    expect(saved).toMatchObject({ when: { event: 'complained' }, points: 20, revision: 2 });
    await expect(
      call(b, 'updateScoreRule', { params: { ruleId: made.id }, body }),
    ).rejects.toBeInstanceOf(ConflictError);
    await call(b, 'deleteScoreRule', { params: { ruleId: made.id } });
    expect((await profile(b)).rules).toEqual([]);
    await expect(
      call(b, 'deleteScoreRule', { params: { ruleId: made.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names only tags and forms of the business, and says when one was deleted', async () => {
    const b = await business();
    const other = await business();
    const theirs = await tag(other, 'Theirs');
    await expect(
      rule(b, {
        when: { action: 'contact_tag', change: 'added', tagId: theirs },
        calculation: 'add',
        points: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      rule(b, {
        when: {
          action: 'form_submitted',
          formId: toPublicId('form', '01890a5d-ac96-774b-bcce-b302099a8057'),
        },
        calculation: 'add',
        points: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const hot = await tag(b, 'Hot lead');
    await rule(b, {
      when: { action: 'contact_replied' },
      hasTagId: hot,
      calculation: 'add',
      points: 1,
    });
    await database.as('crm_owner', (sql) =>
      sql.query('delete from crm.tags where id = $1', [parsePublicId('tag', hot)]),
    );
    const [kept] = (await profile(b)).rules;
    expect(kept?.problems).toEqual([expect.objectContaining({ code: 'tag_missing', id: hot })]);
  });

  it('holds at most 100 rules', async () => {
    const b = await business();
    await database.as('crm_owner', async (sql) => {
      await sql.query('insert into crm.score_profiles (business_id) values ($1)', [b.id]);
      await sql.query(
        `insert into crm.score_rules (business_id, action, calculation, points, created_by_kind)
         select $1, 'appointment_booked', 'add', 1, 'system' from generate_series(1, 100)`,
        [b.id],
      );
    });
    await expect(
      rule(b, { when: { action: 'appointment_booked' }, calculation: 'add', points: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('lets only someone who configures fields change the rules', async () => {
    const b = await business();
    const member = b.as(['fields.values', 'contacts.manage']);
    expect((await profile(b, member)).canManage).toBe(false);
    await expect(
      call(
        b,
        'createScoreRule',
        { body: { when: { action: 'appointment_booked' }, calculation: 'add', points: 1 } },
        member,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      call(b, 'publishScoreProfile', { body: { revision: 0 } }, member),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('renames the profile and keeps its description', async () => {
    const b = await business();
    const renamed = scoreProfile.parse(
      await call(b, 'updateScoreProfile', {
        body: { name: 'Lead heat', description: 'How warm a lead is.' },
      }),
    );
    expect(renamed).toMatchObject({ name: 'Lead heat', description: 'How warm a lead is.' });
  });
});

describe('scoring what contacts do', () => {
  it('scores any form and a named form separately, and reports when the named form is archived', async () => {
    const b = await business();
    const jordan = await contact(b);
    const [form] = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>(
        `insert into forms.forms (business_id, name, definition, public_key)
         values ($1, 'Scoring enquiry', '{}'::jsonb, $2) returning id`,
        [b.id, `scoring_${randomUUID()}`],
      ),
    );
    if (form === undefined) throw new Error('No scoring form.');
    const formId = toPublicId('form', form.id);
    await rule(b, { when: { action: 'form_submitted' }, calculation: 'add', points: 1 });
    const specific = await rule(b, {
      when: { action: 'form_submitted', formId },
      calculation: 'add',
      points: 5,
    });
    expect(specific.when).toEqual({ action: 'form_submitted', formId });
    expect((await profile(b)).rules.map((each) => each.when)).toEqual([
      { action: 'form_submitted', formId: null },
      { action: 'form_submitted', formId },
    ]);
    await publish(b);

    const submission = await emit(b, 'form.submitted', [jordan], { formId });
    expect(await queued(submission)).toHaveLength(1);
    await run(b, submission);
    expect((await scoreOf(b, jordan)).score).toBe(6);
    await run(b, submission);
    expect((await scoreOf(b, jordan)).score).toBe(6);
    await run(b, await emit(b, 'form.submitted', [jordan], { formId: form.id }));
    expect((await scoreOf(b, jordan)).score).toBe(12);
    await run(b, await emit(b, 'form.submitted', [jordan], { formId: randomUUID() }));
    await run(b, await emit(b, 'form.submitted', [jordan]));
    expect((await scoreOf(b, jordan)).score).toBe(14);

    await database.as('crm_owner', (sql) =>
      sql.query("update forms.forms set status='archived' where business_id=$1 and id=$2", [
        b.id,
        form.id,
      ]),
    );
    const kept = (await profile(b)).rules.find((each) => each.id === specific.id);
    expect(kept?.problems).toEqual([expect.objectContaining({ code: 'form_missing', id: formId })]);
  });

  it('scores an appointment status change but leaves reschedules and unchanged or other statuses alone', async () => {
    const b = await business();
    const jordan = await contact(b);
    const made = await rule(b, {
      when: { action: 'appointment_status', status: 'confirmed' },
      calculation: 'add',
      points: 4,
    });
    expect(made.when).toEqual({ action: 'appointment_status', status: 'confirmed' });
    await publish(b);
    for (const payload of [
      { status: 'confirmed', previousStatus: 'booked', rescheduled: true },
      { status: 'confirmed', previousStatus: 'confirmed' },
      { status: 'cancelled', previousStatus: 'booked' },
    ]) {
      await run(b, await emit(b, 'appointment.status_changed', [jordan], payload));
      expect((await scoreOf(b, jordan)).score).toBeNull();
    }
    const changed = await emit(b, 'appointment.status_changed', [jordan], {
      status: 'confirmed',
      previousStatus: 'booked',
    });
    expect(await queued(changed)).toHaveLength(1);
    await run(b, changed);
    await run(b, changed);
    expect((await scoreOf(b, jordan)).score).toBe(4);
    expect((await scoreOf(b, jordan)).changes).toHaveLength(1);
  });

  it('scores each live rule an event passes, once, however often the job runs', async () => {
    const b = await business();
    const jordan = await contact(b, 'Jordan');
    const vip = await tag(b, 'VIP');
    await rule(b, {
      when: { action: 'contact_tag', change: 'added', tagId: vip },
      calculation: 'add',
      points: 5,
    });
    await rule(b, {
      when: { action: 'contact_tag', change: 'added', tagId: vip },
      calculation: 'add',
      points: 2,
    });
    await rule(b, {
      when: { action: 'contact_tag', change: 'removed', tagId: vip },
      calculation: 'subtract',
      points: 4,
    });
    await publish(b);

    // Through the CRM's own command, as a person adds the tag.
    await tagContact(b, jordan, vip);
    const [assigned] = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>(
        `select id from events.events where business_id = $1 and type = 'tag.assigned'`,
        [b.id],
      ),
    );
    if (assigned === undefined) throw new Error('No tag.assigned event.');
    expect(await queued(assigned.id)).toHaveLength(1);
    expect(await run(b, assigned.id)).toEqual({ contacts: 1 });
    expect(await run(b, assigned.id)).toEqual({ contacts: 0 });
    const scored = await scoreOf(b, jordan);
    expect(scored.score).toBe(7);
    expect(scored.changes.map((each) => [each.change, each.source])).toEqual(
      expect.arrayContaining([
        [5, 'rule'],
        [2, 'rule'],
      ]),
    );
    expect((await changedEvents(b)).map((each) => each.payload)).toEqual([
      { score: 7, previous: null, change: 7, source: 'rule' },
    ]);

    await call(b, 'removeRecordTag', { params: { id: jordan, tagId: vip } });
    const [removed] = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>(
        `select id from events.events where business_id = $1 and type = 'tag.removed'`,
        [b.id],
      ),
    );
    if (removed === undefined) throw new Error('No tag.removed event.');
    await run(b, removed.id);
    expect((await scoreOf(b, jordan)).score).toBe(3);
  });

  it('scores only the qualifier the rule names, and only contacts with its tag', async () => {
    const b = await business();
    const ana = await contact(b, 'Ana');
    const ben = await contact(b, 'Ben');
    const hot = await tag(b, 'Hot lead');
    await tagContact(b, ana, hot);
    await rule(b, {
      when: { action: 'contact_replied', channel: 'email' },
      hasTagId: hot,
      calculation: 'add',
      points: 1,
    });
    await rule(b, {
      when: { action: 'email_event', event: 'unsubscribed' },
      calculation: 'subtract',
      points: 10,
    });
    await publish(b);

    await run(b, await emit(b, 'message.received', [ana, ben], { channel: 'email' }));
    await run(b, await emit(b, 'message.received', [ana], { channel: 'sms' }));
    expect((await scoreOf(b, ana)).score).toBe(1);
    expect((await scoreOf(b, ben)).score).toBeNull();

    await run(b, await emit(b, 'consent.withdrawn', [ben], { channel: 'sms' }));
    expect((await scoreOf(b, ben)).score).toBeNull();
    await run(b, await emit(b, 'consent.withdrawn', [ben], { channel: 'email' }));
    expect((await scoreOf(b, ben)).score).toBe(-10);
  });

  it('adds two events scored at once for one contact, the second waiting for the first', async () => {
    const b = await business();
    const jordan = await contact(b);
    await rule(b, { when: { action: 'payment_received' }, calculation: 'add', points: 5 });
    await publish(b);
    const first = await emit(b, 'payment.recorded', [jordan]);
    const second = await emit(b, 'payment.recorded', [jordan]);
    // The first job scores and then holds its transaction open until the second is waiting.
    let scored!: () => void;
    const reached = new Promise<void>((resolve) => (scored = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = defineCommand({
      name: 'test.score_slowly',
      permission: 'fields.values',
      input: z.object({ eventId: z.string() }),
      async handle(trx, input, command) {
        const moved = await scoreEvent(trx, command, input.eventId);
        scored();
        await gate;
        return moved;
      },
    });
    const one = runCommand(services, slow, { eventId: first }, b.system());
    await reached;
    const two = run(b, second);
    // The second waits on the first's transaction: the score's row is the first's until it ends.
    const waiting = async (): Promise<boolean> =>
      (
        await database.as('crm_owner', (sql) =>
          sql.query(`select 1 from pg_locks where not granted and locktype = 'transactionid'`),
        )
      ).length > 0;
    try {
      for (let tries = 0; !(await waiting()); tries += 1) {
        if (tries > 100) throw new Error('The second job never waited for the first.');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
    }
    expect(await Promise.all([one, two])).toEqual([1, { contacts: 1 }]);
    expect((await scoreOf(b, jordan)).score).toBe(10);
    expect((await changedEvents(b)).map((each) => each.payload)).toEqual([
      { score: 5, previous: null, change: 5, source: 'rule' },
      { score: 10, previous: 5, change: 5, source: 'rule' },
    ]);
  });

  it('scores Contact changed once for a save, whatever it changed, and again for the next', async () => {
    const b = await business();
    const jordan = await contact(b, 'Jordan');
    const fields = [await field(b, 'budget'), await field(b, 'city'), await field(b, 'role')];
    await rule(b, { when: { action: 'contact_changed' }, calculation: 'add', points: 2 });
    await publish(b);
    const changes = ['contact.updated', 'field.value_set', 'field.value_cleared'];

    await runCommand(services, saveCommand, { id: jordan, firstName: 'Jo', fields }, b.as());
    const first = await eventsOf(b, changes);
    // The name and the three fields: four events, each with its own job.
    expect(first).toHaveLength(4);
    for (const eventId of first) expect(await queued(eventId)).toHaveLength(1);
    const moved = [];
    for (const eventId of first) moved.push(await run(b, eventId));
    expect(moved).toEqual([{ contacts: 1 }, { contacts: 0 }, { contacts: 0 }, { contacts: 0 }]);
    expect((await scoreOf(b, jordan)).score).toBe(2);

    await runCommand(services, saveCommand, { id: jordan, firstName: 'Joe', fields }, b.as());
    const second = (await eventsOf(b, changes)).filter((id) => !first.includes(id));
    expect(second).toHaveLength(4);
    for (const eventId of second) await run(b, eventId);
    // The first save's events, delivered again, score nothing more.
    for (const eventId of first) await run(b, eventId);
    expect((await scoreOf(b, jordan)).score).toBe(4);
  });

  it('leaves out what was stored before the rules were published', async () => {
    const b = await business();
    const jordan = await contact(b);
    await rule(b, { when: { action: 'payment_received' }, calculation: 'add', points: 5 });
    const before = await emit(b, 'payment.recorded', [jordan]);
    await publish(b);
    // Its job runs after the publish, as one waiting in the queue would.
    expect(await run(b, before)).toEqual({ contacts: 0 });
    expect((await scoreOf(b, jordan)).score).toBeNull();
    expect(await run(b, await emit(b, 'payment.recorded', [jordan]))).toEqual({ contacts: 1 });
    expect((await scoreOf(b, jordan)).score).toBe(5);
  });

  it('leaves out a contact in the trash and keeps scores within their bounds', async () => {
    const b = await business();
    const gone = await contact(b, 'Gone');
    const high = await contact(b, 'High');
    await rule(b, { when: { action: 'payment_received' }, calculation: 'add', points: 1000 });
    await publish(b);
    await call(b, 'setContactScore', { params: { id: high }, body: { score: 1_000_000 } });
    await call(b, 'trashContact', { params: { id: gone } });
    const paid = await emit(b, 'payment.recorded', [gone, high]);
    // The score was at its most already: it does not move, and nothing is told.
    expect(await run(b, paid)).toEqual({ contacts: 1 });
    expect((await scoreOf(b, high)).score).toBe(1_000_000);
    expect((await scoreOf(b, gone)).score).toBeNull();
    expect(await changedEvents(b)).toHaveLength(1);
  });
});

describe("a contact's score", () => {
  it('is set by a person, told of when it moves, and refused for another business', async () => {
    const b = await business();
    const other = await business();
    const jordan = await contact(b);
    expect(await scoreOf(b, jordan)).toMatchObject({ score: null, changes: [], canEdit: true });

    const set = contactScore.parse(
      await call(b, 'setContactScore', { params: { id: jordan }, body: { score: 42 } }),
    );
    expect(set.score).toBe(42);
    expect(set.changes).toEqual([
      expect.objectContaining({ change: 42, source: 'person', ruleId: null }),
    ]);
    await call(b, 'setContactScore', { params: { id: jordan }, body: { score: 42 } });
    expect(await changedEvents(b)).toHaveLength(1);

    await expect(call(other, 'getContactScore', { params: { id: jordan } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      call(other, 'setContactScore', { params: { id: jordan }, body: { score: 1 } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const viewer = b.as([]);
    expect(
      contactScore.parse(await call(b, 'getContactScore', { params: { id: jordan } }, viewer))
        .canEdit,
    ).toBe(false);
    await expect(
      call(b, 'setContactScore', { params: { id: jordan }, body: { score: 1 } }, viewer),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('is refused for a contact in the trash', async () => {
    const b = await business();
    const gone = await contact(b);
    await call(b, 'trashContact', { params: { id: gone } });
    await expect(
      call(b, 'setContactScore', { params: { id: gone }, body: { score: 5 } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("changes once for a workflow step's visit, however often it runs", async () => {
    const b = await business();
    const jordan = await contact(b);
    const step = (calculation: 'add' | 'subtract', key: string) =>
      runCommand(
        services,
        modifyContactScoreCommand,
        { id: jordan, calculation, points: 15, key },
        b.system(),
      );
    expect(await step('add', 'run-1:score:1')).toEqual({ score: 15, changed: true });
    expect(await step('add', 'run-1:score:1')).toEqual({ score: 15, changed: false });
    expect(await step('subtract', 'run-1:score:2')).toEqual({ score: 0, changed: true });
    expect((await changedEvents(b)).map((each) => each.payload)).toEqual([
      { score: 15, previous: null, change: 15, source: 'workflow' },
      { score: 0, previous: 15, change: -15, source: 'workflow' },
    ]);
  });
});
