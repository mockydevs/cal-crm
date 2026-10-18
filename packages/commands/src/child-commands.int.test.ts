import { randomUUID } from 'node:crypto';

import { connectDatabase, type Database } from '@repo/db';
import { ConflictError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  allowEveryone,
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  runProposedCommand,
  type CommandContext,
  type Invocation,
  type Services,
} from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;

const followUp = defineTask({
  name: 'test.child_follow_up',
  data: z.strictObject({ tagId: z.uuid() }),
  run: () => Promise.resolve(),
});

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

const child = defineCommand({
  name: 'test.child_tag',
  permission: 'tags.manage',
  input: z.strictObject({
    name: z.string().min(1),
    secret: z.string(),
    fail: z.boolean().default(false),
  }),
  audit: ({ name }) => ({ name }),
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
    await command.emit({ type: 'tag.created', subject: { kind: 'tag', id: tag.id } });
    if (input.fail) throw new ConflictError('Child refused after mutation.');
    return tag.id;
  },
});

function runChild(command: CommandContext, input: unknown) {
  if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
  return command.runChild(child, input);
}

const parent = defineCommand({
  name: 'test.parent_tags',
  permission: 'tags.manage',
  input: z.strictObject({
    mode: z.enum(['success', 'caught', 'parent_failure', 'siblings']),
  }),
  async handle(_trx, input, command) {
    const first = { name: 'First child', secret: 'sanitized-private-note' };
    if (input.mode === 'siblings') {
      return Promise.all([
        runChild(command, first),
        runChild(command, { ...first, name: 'Second child' }),
      ]);
    }
    if (input.mode === 'caught') {
      try {
        await runChild(command, { ...first, fail: true });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
      return [await runChild(command, { ...first, name: 'Surviving child' })];
    }
    const id = await runChild(command, first);
    if (input.mode === 'parent_failure') throw new ConflictError('Parent refused.');
    return [id];
  },
});

async function setUp(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: new Set(['tags.manage']),
  };
}

async function names(invocation: Invocation) {
  const rows = await database.as('crm_owner', (sql) =>
    sql.query<{ name: string }>('select name from crm.tags where business_id = $1 order by name', [
      invocation.context.businessId,
    ]),
  );
  return rows.map(({ name }) => name);
}

async function audits(invocation: Invocation) {
  const rows = await database.as('crm_owner', (sql) =>
    sql.query<{ command: string; outcome: string; input: unknown; event_ids: string[] }>(
      `select command, outcome, input, event_ids from audit.commands
       where correlation_id = $1 order by command, outcome`,
      [invocation.context.correlationId],
    ),
  );
  return rows;
}

describe('canonical child commands', () => {
  it('settles issued sibling calls before rolling back a parent that rejects early', async () => {
    const invocation = await setUp();
    const seen: string[] = [];
    const slow = defineCommand({
      ...child,
      name: 'test.slow_child_tag',
      async handle(trx, input, command) {
        seen.push('started');
        await sql`select pg_sleep(0.03)`.execute(trx);
        const result = await child.handle(trx, input, command);
        seen.push('finished');
        return result;
      },
    });
    const racing = defineCommand({
      ...parent,
      async handle(_trx, _input, command) {
        if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
        return Promise.all([
          runChild(command, {
            name: 'Failed sibling',
            secret: 'sanitized-private-note',
            fail: true,
          }),
          command.runChild(slow, { name: 'Slow sibling', secret: 'sanitized-private-note' }),
        ]);
      },
    });
    await expect(runCommand(services, racing, { mode: 'siblings' }, invocation)).rejects.toThrow(
      'Child refused after mutation.',
    );
    expect(seen).toEqual(['started', 'finished']);
    expect(await names(invocation)).toEqual([]);
  });

  it('records a caught denial after releasing the parent business lock', async () => {
    const invocation = await setUp();
    const connection = new URL(database.url('crm_app'));
    connection.searchParams.set('options', '-c lock_timeout=500ms');
    const limitedDb = connectDatabase({
      connectionString: connection.toString(),
      onConnectionError: () => undefined,
    });
    const restrictedChild = defineCommand({ ...child, permission: 'contacts.manage' });
    const lockedParent = defineCommand({
      ...parent,
      async handle(trx, _input, command) {
        await trx
          .selectFrom('tenancy.businesses')
          .select('id')
          .where('id', '=', requireBusiness(command.context))
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
        try {
          await command.runChild(restrictedChild, {
            name: 'Denied child',
            secret: 'sanitized-private-note',
          });
          throw new Error('Expected a permission denial.');
        } catch (error) {
          expect(error).toMatchObject({ name: 'ForbiddenError' });
        }
        return [];
      },
    });
    try {
      expect(
        await runCommand(
          { ...services, db: limitedDb },
          lockedParent,
          { mode: 'success' },
          invocation,
        ),
      ).toEqual([]);
      expect(
        (await audits(invocation)).map(({ command, outcome }) => ({ command, outcome })),
      ).toEqual([
        { command: child.name, outcome: 'denied' },
        { command: parent.name, outcome: 'ok' },
      ]);
    } finally {
      await limitedDb.destroy();
    }
  });

  it('recovers the transaction after a real child SQL constraint failure', async () => {
    const invocation = await setUp();
    const recovering = defineCommand({
      ...parent,
      async handle(_trx, _input, command) {
        const first = { name: 'Existing child', secret: 'sanitized-private-note' };
        await runChild(command, first);
        try {
          await runChild(command, first);
          throw new Error('Expected the database unique constraint.');
        } catch (error) {
          if (!(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23505'
          )) {
            throw error;
          }
        }
        return [await runChild(command, { ...first, name: 'After SQL failure' })];
      },
    });
    await runCommand(services, recovering, { mode: 'success' }, invocation);
    expect(await names(invocation)).toEqual(['After SQL failure', 'Existing child']);
    const rows = await audits(invocation);
    expect(
      rows.filter(({ command, outcome }) => command === child.name && outcome === 'ok'),
    ).toHaveLength(2);
    expect(
      rows.filter(({ command, outcome }) => command === child.name && outcome === 'failed'),
    ).toEqual([expect.objectContaining({ input: { name: 'Existing child' }, event_ids: [] })]);
  });

  it('holds an assistant child to its own autonomy boundary', async () => {
    const invocation = await setUp();
    const permittedParent = defineCommand({
      ...parent,
      ownAssistantRule: 'This test parent holds its own assistant rule.',
    });
    const assistant: Invocation = {
      ...invocation,
      agent: 'inbox',
      context: { ...invocation.context, actorKind: 'ai_agent', actorId: randomUUID() },
    };
    await expect(
      runCommand(services, permittedParent, { mode: 'success' }, assistant),
    ).rejects.toMatchObject({ reason: 'not_delegable' });
    expect(await names(assistant)).toEqual([]);
    expect((await audits(assistant))[0]).toMatchObject({ command: child.name, outcome: 'denied' });
  });

  it('preserves the proposal identity in child audits and events', async () => {
    const invocation = await setUp();
    const proposal = { id: randomUUID(), agent: 'inbox' as const };
    await runProposedCommand(services, parent, { mode: 'success' }, invocation, {
      proposal,
      begin: () => Promise.resolve('run'),
      finish: () => Promise.resolve(),
    });
    const records = await database.as('crm_owner', (sql) =>
      sql.query<{ proposal_id: string }>(
        `select proposal_id from audit.commands where correlation_id = $1
         union all select proposal_id from events.events where correlation_id = $1`,
        [invocation.context.correlationId],
      ),
    );
    expect(records).toEqual([
      { proposal_id: proposal.id },
      { proposal_id: proposal.id },
      { proposal_id: proposal.id },
    ]);
  });

  it('carries a nested child event into the outer follow-up job without duplicating audits', async () => {
    const invocation = await setUp();
    const middle = defineCommand({
      ...parent,
      name: 'test.middle_tags',
      async handle(_trx, _input, command) {
        return runChild(command, { name: 'Nested child', secret: 'sanitized-private-note' });
      },
    });
    const outer = defineCommand({
      ...parent,
      async handle(_trx, input, command) {
        if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
        const tagId = await command.runChild(middle, input);
        command.enqueue(followUp, { tagId });
        return tagId;
      },
    });
    const tagId = await runCommand(services, outer, { mode: 'success' }, invocation);
    expect(await names(invocation)).toEqual(['Nested child']);
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>('select id from events.events where correlation_id = $1', [
        invocation.context.correlationId,
      ]),
    );
    expect(events).toHaveLength(1);
    const jobs = await database.runJobs([followUp.name]);
    expect(jobs).toEqual([
      {
        task: 'test.child_follow_up',
        payload: {
          agencyId: invocation.context.agencyId,
          businessId: invocation.context.businessId,
          correlationId: invocation.context.correlationId,
          causationId: events[0]?.id,
          data: { tagId },
        },
      },
    ]);
    const rows = await audits(invocation);
    expect(rows.map(({ command, event_ids }) => ({ command, count: event_ids.length }))).toEqual([
      { command: 'test.child_tag', count: 1 },
      { command: 'test.middle_tags', count: 0 },
      { command: 'test.parent_tags', count: 0 },
    ]);
  });

  it('checks the child permission even when the parent is permitted', async () => {
    const invocation = await setUp();
    const restrictedChild = defineCommand({ ...child, permission: 'contacts.manage' });
    const permittedParent = defineCommand({
      ...parent,
      async handle(_trx, _input, command) {
        if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
        return [
          await command.runChild(restrictedChild, {
            name: 'Forbidden child',
            secret: 'sanitized-private-note',
          }),
        ];
      },
    });
    await expect(
      runCommand(services, permittedParent, { mode: 'success' }, invocation),
    ).rejects.toThrow('contacts.manage');
    expect(await names(invocation)).toEqual([]);
    const rows = await audits(invocation);
    expect(rows.map(({ command, outcome }) => ({ command, outcome }))).toEqual([
      { command: 'test.child_tag', outcome: 'denied' },
      { command: 'test.parent_tags', outcome: 'denied' },
    ]);
    expect(rows[0]?.input).toEqual({ name: 'Forbidden child' });
  });

  it('checks the authorization service for the child separately', async () => {
    const invocation = await setUp();
    const guarded: Services = {
      ...services,
      authorize: (_invocation, name) => name !== child.name,
    };
    await expect(runCommand(guarded, parent, { mode: 'success' }, invocation)).rejects.toThrow(
      "You don't have permission to do this.",
    );
    expect(await names(invocation)).toEqual([]);
    expect((await audits(invocation))[0]).toMatchObject({
      command: 'test.child_tag',
      outcome: 'denied',
      input: { name: 'First child' },
    });
  });

  it('omits invalid child input from its failure audit', async () => {
    const invocation = await setUp();
    const invalidParent = defineCommand({
      ...parent,
      async handle(_trx, _input, command) {
        return [await runChild(command, { name: '', secret: 'sanitized-private-note' })];
      },
    });
    await expect(
      runCommand(services, invalidParent, { mode: 'success' }, invocation),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(await names(invocation)).toEqual([]);
    expect((await audits(invocation))[0]).toMatchObject({
      command: 'test.child_tag',
      outcome: 'invalid',
      input: {},
      event_ids: [],
    });
  });

  it('names the events of every child by the command that ran them', async () => {
    const invocation = await setUp();
    await runCommand(services, parent, { mode: 'siblings' }, invocation);
    const [commands, events] = await database.as('crm_owner', async (sql) => [
      await sql.query<{ id: string; command: string; event_ids: string[] }>(
        `select id, command, event_ids from audit.commands
         where correlation_id = $1 order by command`,
        [invocation.context.correlationId],
      ),
      await sql.query<{ command_id: string }>(
        'select command_id from events.events where correlation_id = $1',
        [invocation.context.correlationId],
      ),
    ]);
    const run = commands.find((each) => each.command === 'test.parent_tags');
    const children = commands.filter((each) => each.command === 'test.child_tag');
    expect(children.flatMap((each) => each.event_ids)).toHaveLength(2);
    expect(events).toEqual([{ command_id: run?.id }, { command_id: run?.id }]);
  });

  it('keeps the id a rolled-back child made for the events that stay', async () => {
    const invocation = await setUp();
    await runCommand(services, parent, { mode: 'caught' }, invocation);
    const [run] = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string; event_ids: string[] }>(
        `select id, event_ids from audit.commands
         where correlation_id = $1 and command = $2`,
        [invocation.context.correlationId, parent.name],
      ),
    );
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ command_id: string }>(
        'select command_id from events.events where correlation_id = $1',
        [invocation.context.correlationId],
      ),
    );
    expect(events).toEqual([{ command_id: run?.id }]);
  });

  it('gives the parent an id of its own when a child failed while asking for one', async () => {
    const invocation = await setUp();
    // The child's first emit runs in a transaction its own failed query has aborted, so the
    // id is never made; the child's savepoint is rolled back and the parent goes on.
    const broken = defineCommand({
      ...child,
      name: 'test.broken_child_tag',
      async handle(trx, _input, command) {
        await sql`select 1 / 0`.execute(trx).catch(() => undefined);
        await command.emit({ type: 'tag.created', subject: { kind: 'tag', id: randomUUID() } });
        return '';
      },
    });
    const goingOn = defineCommand({
      ...parent,
      async handle(_trx, _input, command) {
        if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
        await command.runChild(broken, { name: 'Never', secret: '' }).catch(() => undefined);
        return [await runChild(command, { name: 'After the failure', secret: '' })];
      },
    });
    await runCommand(services, goingOn, { mode: 'success' }, invocation);
    const [run] = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>(
        `select id from audit.commands where correlation_id = $1 and command = $2`,
        [invocation.context.correlationId, parent.name],
      ),
    );
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ command_id: string }>(
        'select command_id from events.events where correlation_id = $1',
        [invocation.context.correlationId],
      ),
    );
    expect(events).toEqual([{ command_id: run?.id }]);
  });

  it('keeps the child audit projection and excludes child events from the parent audit', async () => {
    const invocation = await setUp();
    expect(await runCommand(services, parent, { mode: 'success' }, invocation)).toHaveLength(1);
    expect(await names(invocation)).toEqual(['First child']);
    const rows = await audits(invocation);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      command: 'test.child_tag',
      outcome: 'ok',
      input: { name: 'First child' },
    });
    expect(rows[0]?.event_ids).toHaveLength(1);
    expect(rows[1]).toMatchObject({ command: 'test.parent_tags', outcome: 'ok', event_ids: [] });
    expect(JSON.stringify(rows)).not.toContain('sanitized-private-note');
  });

  it('rolls back a caught child failure before the parent continues', async () => {
    const invocation = await setUp();
    await runCommand(services, parent, { mode: 'caught' }, invocation);
    expect(await names(invocation)).toEqual(['Surviving child']);
    const rows = await audits(invocation);
    expect(rows.map(({ command, outcome }) => ({ command, outcome }))).toEqual([
      { command: 'test.child_tag', outcome: 'failed' },
      { command: 'test.child_tag', outcome: 'ok' },
      { command: 'test.parent_tags', outcome: 'ok' },
    ]);
    expect(rows[0]?.event_ids).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain('sanitized-private-note');
  });

  it('rolls back successful child data, events and success audits when the parent fails', async () => {
    const invocation = await setUp();
    await expect(
      runCommand(services, parent, { mode: 'parent_failure' }, invocation),
    ).rejects.toThrow('Parent refused.');
    expect(await names(invocation)).toEqual([]);
    expect(await audits(invocation)).toEqual([
      expect.objectContaining({ command: 'test.parent_tags', outcome: 'failed', event_ids: [] }),
    ]);
    const rows = await database.as('crm_owner', (sql) =>
      sql.query('select id from events.events where correlation_id = $1', [
        invocation.context.correlationId,
      ]),
    );
    expect(rows).toEqual([]);
  });

  it('serializes sibling calls without mixing their audits', async () => {
    const invocation = await setUp();
    const ids = await runCommand(services, parent, { mode: 'siblings' }, invocation);
    expect(new Set(ids).size).toBe(2);
    expect(await names(invocation)).toEqual(['First child', 'Second child']);
    const rows = await audits(invocation);
    expect(rows.filter(({ command }) => command === 'test.child_tag')).toHaveLength(2);
    expect(
      rows
        .filter(({ command }) => command === 'test.child_tag')
        .map(({ event_ids }) => event_ids.length),
    ).toEqual([1, 1]);
  });
});
