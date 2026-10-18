import { randomUUID } from 'node:crypto';

import { connectDatabase, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { testDatabase, type ReceivedJob, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  allowEveryone,
  defineCommand,
  defineTask,
  requireAgency,
  requireBusiness,
  requirePermission,
  runCommand,
  type Invocation,
  type Services,
} from './index.js';

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

// A command for these tests: adds a tag, and can note it on a contact's timeline.
const addTag = defineCommand({
  name: 'test.add_tag',
  permission: 'tags.manage',
  input: z.strictObject({
    name: z.string().min(1),
    contactId: z.uuid().optional(),
    password: z.string().optional(),
    failWith: z.enum(['error', 'not_found', 'conflict', 'validation', 'forbidden']).optional(),
  }),
  // Keeps the password out of the audit log.
  audit: ({ password: _password, ...rest }) => rest,
  async handle(trx, input, command) {
    const tag = await trx
      .insertInto('crm.tags')
      .values({
        business_id: requireBusiness(command.context),
        name: input.name,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await command.emit({
      type: 'tag.added',
      subject: { kind: 'tag', id: tag.id },
      payload: { name: input.name },
      ...(input.contactId === undefined ? {} : { records: [input.contactId] }),
    });
    switch (input.failWith) {
      case 'error':
        throw new Error('the handler failed');
      case 'not_found':
        throw new NotFoundError('contact', 'con_01h455vb4pex5vsknk084sn02q');
      case 'conflict':
        throw new ConflictError('Changed meanwhile.');
      case 'validation':
        throw new ValidationError([{ path: '/name', code: 'taken', message: 'Taken.' }]);
      case 'forbidden':
        throw new ForbiddenError('Not this one.');
      case undefined:
        return { id: tag.id };
    }
  },
});

// A command that needs no business, so agency staff and the system can run it.
const ping = defineCommand({
  name: 'test.ping',
  permission: 'agency.security',
  input: z.strictObject({ note: z.string() }),
  async handle(_trx, input, command) {
    await command.emit({
      type: 'agency.pinged',
      subject: { kind: 'agency', id: command.context.agencyId },
      payload: { note: input.note },
    });
    return 'pong';
  },
});

async function setUp() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const contact = await database.fixtures.contact(business.context, { firstName: 'Dana' });
  const invocation: Invocation = {
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: new Set(['tags.manage']),
    causationId: randomUUID(),
    ip: '203.0.113.7',
    userAgent: 'Integration test',
  };
  return { business, user, contact, invocation };
}

it('commits the assistant tool identity with the native mutation and records rollback failures separately', async () => {
  const { invocation } = await setUp();
  const key = `${randomUUID()}:tool-1`;
  const made = await runCommand(
    services,
    addTag,
    { name: 'Harness receipt' },
    { ...invocation, assistantToolCallId: key },
  );
  const recorded = await asOwner<{ outcome: string; assistant_tool_call_id: string }>(
    'select outcome, assistant_tool_call_id from audit.commands where assistant_tool_call_id = $1',
    [key],
  );
  expect(recorded).toEqual([{ outcome: 'ok', assistant_tool_call_id: key }]);
  expect(await asOwner('select id from crm.tags where id = $1', [made.id])).toEqual([
    { id: made.id },
  ]);
  const failedKey = `${randomUUID()}:tool-2`;
  await expect(
    runCommand(
      services,
      addTag,
      { name: 'Rolled back', failWith: 'conflict' },
      { ...invocation, assistantToolCallId: failedKey },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await asOwner('select id from crm.tags where name = $1', ['Rolled back'])).toEqual([]);
  expect(
    await asOwner<{ outcome: string }>(
      'select outcome from audit.commands where assistant_tool_call_id = $1',
      [failedKey],
    ),
  ).toEqual([{ outcome: 'failed' }]);
});

const asOwner = <Row extends object>(text: string, values: unknown[] = []) =>
  database.as('crm_owner', (sql) => sql.query<Row>(text, values));

const audits = (correlationId: string) =>
  asOwner<Record<string, unknown>>(
    `select command, outcome, error_code, input, event_ids, actor_kind, actor_id,
            host(ip) as ip, user_agent, business_id
     from audit.commands where correlation_id = $1`,
    [correlationId],
  );

const tagsNamed = (name: string) =>
  asOwner<{ id: string }>('select id from crm.tags where name = $1', [name]);

// A task for these tests. The worker isn't part of them, so a job's run does nothing.
const tagAdded = defineTask({
  name: 'test.tag_added',
  data: z.strictObject({ tagId: z.uuid() }),
  run: () => Promise.resolve(),
});

// A command that emits two events and returns their ids, with a job caused by one of them.
const noteTwice = defineCommand({
  name: 'test.note_twice',
  permission: 'tags.manage',
  input: z.strictObject({ jobCausedBy: z.enum(['default', 'first', 'elsewhere']).optional() }),
  async handle(_trx, input, command) {
    const subject = { kind: 'agency', id: command.context.agencyId };
    const first = await command.emit({ type: 'agency.noted', subject });
    const second = await command.emit({ type: 'agency.noted_again', subject });
    if (input.jobCausedBy !== undefined) {
      command.enqueue(
        tagAdded,
        { tagId: command.context.agencyId },
        input.jobCausedBy === 'first'
          ? { causedBy: first }
          : input.jobCausedBy === 'elsewhere'
            ? { causedBy: randomUUID() }
            : {},
      );
    }
    return [first, second];
  },
});

describe('runCommand', () => {
  it('runs the handler and returns its result', async () => {
    const { invocation } = await setUp();

    const result = await runCommand(services, addTag, { name: 'VIP' }, invocation);

    expect(await tagsNamed('VIP')).toEqual([{ id: result.id }]);
  });

  it('writes each event with its actor, causation and correlation', async () => {
    const { invocation, business, user } = await setUp();

    const { id } = await runCommand(services, addTag, { name: 'Wedding' }, invocation);

    const events = await asOwner('select * from events.events where subject_id = $1', [id]);
    expect(events).toMatchObject([
      {
        agency_id: business.agencyId,
        business_id: business.id,
        type: 'tag.added',
        version: 1,
        actor_kind: 'user',
        actor_id: user.id,
        causation_id: invocation.causationId,
        correlation_id: invocation.context.correlationId,
        subject_kind: 'tag',
        payload: { name: 'Wedding' },
      },
    ]);
  });

  it("gives each event's id as it's written, in the order emitted", async () => {
    const { invocation } = await setUp();

    const ids = await runCommand(services, noteTwice, {}, invocation);

    expect(
      await asOwner<{ id: string; type: string }>(
        'select id, type from events.events where correlation_id = $1 order by id',
        [invocation.context.correlationId],
      ),
    ).toEqual([
      { id: ids[0], type: 'agency.noted' },
      { id: ids[1], type: 'agency.noted_again' },
    ]);
    expect(await audits(invocation.context.correlationId)).toMatchObject([{ event_ids: ids }]);
  });

  it('names on each event the command that wrote it, which is its audit row', async () => {
    const { invocation } = await setUp();

    await runCommand(services, noteTwice, {}, invocation);
    await runCommand(services, noteTwice, {}, invocation);

    const commands = await asOwner<{ id: string; event_ids: string[] }>(
      'select id, event_ids from audit.commands where correlation_id = $1 order by id',
      [invocation.context.correlationId],
    );
    const events = await asOwner<{ id: string; command_id: string }>(
      'select id, command_id from events.events where correlation_id = $1 order by id',
      [invocation.context.correlationId],
    );
    expect(commands).toHaveLength(2);
    expect(events).toEqual(
      commands.flatMap((command) =>
        command.event_ids.map((id) => ({ id, command_id: command.id })),
      ),
    );
  });

  it('puts each event on the timeline of the records it concerns', async () => {
    const { invocation, contact } = await setUp();

    const { id } = await runCommand(
      services,
      addTag,
      { name: 'Hot lead', contactId: contact.id },
      invocation,
    );

    const timeline = await asOwner(
      `select t.record_id, t.event_type
       from crm.timeline_entries t
       join events.events e on e.id = t.event_id and e.recorded_at = t.event_recorded_at
       where e.subject_id = $1`,
      [id],
    );
    expect(timeline).toEqual([{ record_id: contact.id, event_type: 'tag.added' }]);
  });

  it('records the attempt in the audit log, with its events and without secrets', async () => {
    const { invocation, user, business } = await setUp();

    const { id } = await runCommand(
      services,
      addTag,
      { name: 'Corporate', password: 'hunter2' },
      invocation,
    );

    const [event] = await asOwner<{ id: string }>(
      'select id from events.events where subject_id = $1',
      [id],
    );
    expect(await audits(invocation.context.correlationId)).toEqual([
      {
        command: 'test.add_tag',
        outcome: 'ok',
        error_code: null,
        input: { name: 'Corporate' },
        event_ids: [event?.id],
        actor_kind: 'user',
        actor_id: user.id,
        ip: '203.0.113.7',
        user_agent: 'Integration test',
        business_id: business.id,
      },
    ]);
  });

  it('refuses input that does not fit, keeping only an audit row', async () => {
    const { invocation } = await setUp();

    await expect(runCommand(services, addTag, { name: '' }, invocation)).rejects.toThrow(
      ValidationError,
    );

    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { outcome: 'invalid', error_code: 'validation', input: {}, event_ids: [] },
    ]);
  });

  it('refuses an actor who may not run it, before the handler runs', async () => {
    const { invocation } = await setUp();
    const nobody: Services = { db, authorize: () => false };

    await expect(runCommand(nobody, addTag, { name: 'Denied' }, invocation)).rejects.toThrow(
      ForbiddenError,
    );

    expect(await tagsNamed('Denied')).toEqual([]);
    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { outcome: 'denied', error_code: 'forbidden', input: { name: 'Denied' } },
    ]);
  });

  it("refuses an actor whose role lacks the command's permission, naming it", async () => {
    const { invocation } = await setUp();
    const viewer: Invocation = { ...invocation, permissions: new Set() };

    const refused = runCommand(services, addTag, { name: 'Not mine' }, viewer);

    await expect(refused).rejects.toThrow(ForbiddenError);
    await expect(refused).rejects.toMatchObject({
      permission: 'tags.manage',
      message: "Your role doesn't allow this: it needs tags.manage.",
    });
    expect(await tagsNamed('Not mine')).toEqual([]);
    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { outcome: 'denied', error_code: 'forbidden', input: { name: 'Not mine' } },
    ]);
  });

  it("refuses a business's work at the agency as its handler would, whatever the role", async () => {
    const { invocation } = await setUp();
    const { businessId: _none, ...atTheAgency } = invocation.context;

    for (const permissions of [new Set<never>(), 'all'] as const) {
      const refused = runCommand(
        services,
        addTag,
        { name: 'At the agency' },
        { ...invocation, context: atTheAgency, permissions },
      );
      await expect(refused).rejects.toThrow(ValidationError);
      await expect(refused).rejects.toThrow('Choose a business first.');
    }
    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { outcome: 'invalid', error_code: 'validation', input: { name: 'At the agency' } },
      { outcome: 'invalid', error_code: 'validation', input: { name: 'At the agency' } },
    ]);
  });

  it("refuses the agency's own work inside a business as its handler would", async () => {
    const { invocation } = await setUp();

    const refused = runCommand(
      services,
      ping,
      { note: 'In a business' },
      {
        ...invocation,
        permissions: 'all',
      },
    );

    await expect(refused).rejects.toThrow(ForbiddenError);
    await expect(refused).rejects.toThrow(
      'Change this for the whole agency, outside any business.',
    );
    await expect(refused).rejects.not.toHaveProperty('permission', 'agency.security');
    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { outcome: 'denied', error_code: 'forbidden', input: { note: 'In a business' } },
    ]);
  });

  it('lets work allowed at the agency and in businesses run in either', async () => {
    const { invocation } = await setUp();
    const { businessId: _none, ...atTheAgency } = invocation.context;
    const upload = { name: 'test.upload', permission: 'files.upload' } as const;
    const grants = new Set(['files.upload'] as const);

    await expect(
      requirePermission(services, upload, { ...invocation, permissions: grants }),
    ).resolves.toBeUndefined();
    await expect(
      requirePermission(services, upload, {
        ...invocation,
        context: atTheAgency,
        permissions: grants,
      }),
    ).resolves.toBeUndefined();
  });

  it('lets the system run any command', async () => {
    const { invocation } = await setUp();
    const system: Invocation = { ...invocation, permissions: 'all' };

    await runCommand(services, addTag, { name: 'By the system' }, system);

    expect(await tagsNamed('By the system')).toHaveLength(1);
  });

  it('refuses unrelated grants before receiving work, and records an empty input by default', async () => {
    const { invocation } = await setUp();
    const unrelated: Invocation = { ...invocation, permissions: new Set(['files.upload']) };

    await expect(requirePermission(services, addTag, unrelated)).rejects.toMatchObject({
      permission: 'tags.manage',
    });
    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { command: 'test.add_tag', outcome: 'denied', input: {}, event_ids: [] },
    ]);
  });

  it('leaves no write or event behind when the handler fails, but records the failure', async () => {
    const { invocation } = await setUp();

    await expect(
      runCommand(services, addTag, { name: 'Doomed', failWith: 'error' }, invocation),
    ).rejects.toThrow('the handler failed');

    expect(await tagsNamed('Doomed')).toEqual([]);
    expect(
      await asOwner('select * from events.events where correlation_id = $1', [
        invocation.context.correlationId,
      ]),
    ).toEqual([]);
    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { outcome: 'failed', error_code: 'internal', input: { name: 'Doomed' }, event_ids: [] },
    ]);
  });

  it.each([
    ['not_found', 'failed', 'not_found'],
    ['conflict', 'failed', 'conflict'],
    ['validation', 'invalid', 'validation'],
    ['forbidden', 'denied', 'forbidden'],
  ] as const)(
    'records an error the handler raises (%s) with its outcome and kind',
    async (failWith, outcome, errorCode) => {
      const { invocation } = await setUp();

      await expect(
        runCommand(services, addTag, { name: `Fails ${failWith}`, failWith }, invocation),
      ).rejects.toThrow();

      expect(await audits(invocation.context.correlationId)).toMatchObject([
        { outcome, error_code: errorCode },
      ]);
    },
  );
});

describe('a command run by the system for the agency', () => {
  it('leaves the business, actor, causation, IP and user agent empty', async () => {
    const agency = await database.fixtures.agency();
    const correlationId = randomUUID();

    const answer = await runCommand(
      services,
      ping,
      { note: 'hello' },
      { context: { agencyId: agency.id, actorKind: 'system', correlationId }, permissions: 'all' },
    );

    expect(answer).toBe('pong');
    expect(
      await asOwner(
        'select business_id, actor_id, causation_id from events.events where correlation_id = $1',
        [correlationId],
      ),
    ).toEqual([{ business_id: null, actor_id: null, causation_id: null }]);
    expect(await audits(correlationId)).toMatchObject([
      {
        outcome: 'ok',
        input: { note: 'hello' },
        actor_id: null,
        ip: null,
        user_agent: null,
        business_id: null,
      },
    ]);
  });
});

describe('requireBusiness', () => {
  it('refuses a command that needs a business when none is selected', async () => {
    const { invocation } = await setUp();
    const { businessId: _none, ...agencyStaff } = invocation.context;

    await expect(
      runCommand(
        services,
        addTag,
        { name: 'Nowhere' },
        { context: agencyStaff, permissions: 'all' },
      ),
    ).rejects.toThrow('Choose a business first.');
  });
});

describe('requireAgency', () => {
  it('gives the agency outside any business, and refuses inside one', async () => {
    const { invocation } = await setUp();
    const { businessId: _none, ...agencyStaff } = invocation.context;

    expect(requireAgency(agencyStaff)).toBe(agencyStaff.agencyId);
    expect(() => requireAgency(invocation.context)).toThrow(ForbiddenError);
  });
});

// A command that adds a tag and a job about it, and can fail after adding the job.
const addTagLater = defineCommand({
  name: 'test.add_tag_later',
  permission: 'tags.manage',
  input: z.strictObject({
    name: z.string(),
    then: z.enum(['fail', 'enqueue_bad_data']).optional(),
  }),
  async handle(trx, input, command) {
    const tag = await trx
      .insertInto('crm.tags')
      .values({
        business_id: requireBusiness(command.context),
        name: input.name,
        created_by_kind: command.context.actorKind,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    command.enqueue(tagAdded, { tagId: input.then === 'enqueue_bad_data' ? 'not-an-id' : tag.id });
    if (input.then === 'fail') {
      throw new Error('the handler failed');
    }
    return { id: tag.id };
  },
});

/** Of the jobs the worker received, those an invocation's commands added. */
const addedBy = (jobs: readonly ReceivedJob[], invocation: Invocation) =>
  jobs.filter(
    ({ payload }) =>
      typeof payload === 'object' &&
      payload !== null &&
      'correlationId' in payload &&
      payload.correlationId === invocation.context.correlationId,
  );

/** The jobs an invocation's commands added, as the worker receives them. */
async function jobsOf(invocation: Invocation) {
  return addedBy(await database.runJobs([tagAdded.name]), invocation);
}

describe('jobs a command adds', () => {
  it('are written with its change, carrying its context, for the worker to run', async () => {
    const { invocation, business } = await setUp();

    const { id } = await runCommand(services, addTagLater, { name: 'Later' }, invocation);

    expect(await jobsOf(invocation)).toEqual([
      {
        task: 'test.tag_added',
        payload: {
          agencyId: business.agencyId,
          businessId: business.id,
          correlationId: invocation.context.correlationId,
          // It emitted no event, so the job's cause is the command's.
          causationId: invocation.causationId,
          data: { tagId: id },
        },
      },
    ]);
  });

  it('carry the event behind them: the last one emitted, or the one named', async () => {
    const first = await setUp();
    const named = await setUp();

    const emitted = await runCommand(
      services,
      noteTwice,
      { jobCausedBy: 'default' },
      first.invocation,
    );
    const chosen = await runCommand(
      services,
      noteTwice,
      { jobCausedBy: 'first' },
      named.invocation,
    );

    const jobs = await database.runJobs([tagAdded.name]);
    expect(addedBy(jobs, first.invocation)).toMatchObject([
      { payload: { causationId: emitted[1] } },
    ]);
    expect(addedBy(jobs, named.invocation)).toMatchObject([
      { payload: { causationId: chosen[0] } },
    ]);
  });

  it("can't name as their cause an event the command didn't emit, as a bug", async () => {
    const { invocation } = await setUp();

    await expect(
      runCommand(services, noteTwice, { jobCausedBy: 'elsewhere' }, invocation),
    ).rejects.toThrow("A job's cause must be an event the command emitted");
    expect(await jobsOf(invocation)).toEqual([]);
  });

  it('carry no cause when nothing caused them', async () => {
    const { invocation } = await setUp();
    const { causationId: _none, ...uncaused } = invocation;

    await runCommand(services, addTagLater, { name: 'Uncaused' }, uncaused);

    expect(await jobsOf(uncaused)).toMatchObject([{ payload: { causationId: null } }]);
  });

  it('are not written when the command fails', async () => {
    const { invocation } = await setUp();

    await expect(
      runCommand(services, addTagLater, { name: 'Never', then: 'fail' }, invocation),
    ).rejects.toThrow('the handler failed');

    expect(await jobsOf(invocation)).toEqual([]);
  });

  it("must fit their task's data; a job that doesn't fails the command, as a bug", async () => {
    const { invocation } = await setUp();

    await expect(
      runCommand(services, addTagLater, { name: 'Misfit', then: 'enqueue_bad_data' }, invocation),
    ).rejects.toThrow(z.ZodError);

    expect(await tagsNamed('Misfit')).toEqual([]);
    expect(await jobsOf(invocation)).toEqual([]);
    expect(await audits(invocation.context.correlationId)).toMatchObject([
      { command: 'test.add_tag_later', outcome: 'failed', error_code: 'internal' },
    ]);
  });
});
