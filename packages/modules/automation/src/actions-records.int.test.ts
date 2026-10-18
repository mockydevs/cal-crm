// Record actions: contact.update for built-in fields, task.create, deal.create,
// deal.move and deal.close run the CRM's own commands inside the step, for a business
// seeded as business.create seeds it. Real Postgres, the real step command, real CRM.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  runCommand,
  type CommandContext,
  type Invocation,
  type Services,
} from '@repo/commands';
import { automationDocument, type AutomationDocumentInput, type Deal } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
import {
  createContactCommand,
  createDealCommand,
  seedBusinessDefaults,
  updateDealCommand,
  type TaskOptions,
} from '@repo/module-crm';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { runAction } from './actions.js';
import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';

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

type Steps = AutomationDocumentInput['steps'];
interface Outcome {
  status: string;
  exit_reason: string | null;
}
interface StepRun {
  step_key: string;
  status: string;
  output: Record<string, unknown>;
  explanation: string;
}
interface DealRow {
  id: string;
  name: string;
  pipeline_id: string;
  stage_id: string;
  status: string;
  amount: string | null;
  currency: string;
  lost_note: string | null;
  lost_reason_id: string | null;
  closed: boolean;
}

const superuser = <T>(work: (sql: Sql) => Promise<T>) => database.as('postgres', work);

it('sets global DND through the canonical command and keeps its reason out of events', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        restrict: {
          type: 'dnd.set',
          config: {
            channel: 'all',
            action: 'enable',
            reason: 'Requested by {{contact.firstName}}.',
          },
        },
      },
      'restrict',
    ),
  ).toEqual(completed);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select do_not_contact,dnd_channels from crm.contacts where id=$1', [s.contactId]),
    ),
  ).toEqual([{ do_not_contact: true, dnd_channels: [] }]);
  const audits = await database.withTenant(s.context, (sql) =>
    sql.query<{
      input: { reason: string };
      outcome: string;
    }>("select input,outcome from audit.commands where command='contact.set_dnd'"),
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ input: { reason: 'Requested by Ada.' }, outcome: 'ok' });
  const events = await database.withTenant(s.context, (sql) =>
    sql.query("select type,payload from events.events where type='contact.do_not_contact_set'"),
  );
  expect(events).toEqual([{ type: 'contact.do_not_contact_set', payload: {} }]);
});

it('clears email DND while retaining global and other channel restrictions', async () => {
  const s = await scene();
  await database.withTenant(s.context, (sql) =>
    sql.query(
      `update crm.contacts set do_not_contact=true,dnd_channels=array['call','email','sms']
     where id=$1`,
      [s.contactId],
    ),
  );
  expect(
    await s.run(
      {
        restrict: {
          type: 'dnd.set',
          config: { channel: 'email', action: 'disable', reason: 'Requested by the contact.' },
        },
      },
      'restrict',
    ),
  ).toEqual(completed);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select do_not_contact,dnd_channels from crm.contacts where id=$1', [s.contactId]),
    ),
  ).toEqual([{ do_not_contact: true, dnd_channels: ['call', 'sms'] }]);
});

it('clears global DND without granting consent or removing suppression', async () => {
  const s = await scene();
  await database.withTenant(s.context, async (sql) => {
    await sql.query('update crm.contacts set do_not_contact=true where id=$1', [s.contactId]);
    await sql.query(
      `insert into messaging.consents
      (business_id,contact_id,channel,purpose,status,source,recorded_by_kind)
      values (app.business_id(),$1,'email','marketing','withdrawn','user','system')`,
      [s.contactId],
    );
    await sql.query(`insert into messaging.suppressions
      (business_id,channel,address_normalized,reason)
      values (app.business_id(),'email','fixture@example.test','unsubscribe')`);
  });
  expect(
    await s.run(
      {
        restrict: {
          type: 'dnd.set',
          config: { channel: 'all', action: 'disable', reason: 'Requested by the contact.' },
        },
      },
      'restrict',
    ),
  ).toEqual(completed);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select do_not_contact from crm.contacts where id=$1', [s.contactId]),
    ),
  ).toEqual([{ do_not_contact: false }]);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select channel,purpose,status from messaging.consents where contact_id=$1', [
        s.contactId,
      ]),
    ),
  ).toEqual([{ channel: 'email', purpose: 'marketing', status: 'withdrawn' }]);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select channel,address_normalized,reason from messaging.suppressions'),
    ),
  ).toEqual([
    { channel: 'email', address_normalized: 'fixture@example.test', reason: 'unsubscribe' },
  ]);
});

it('enables SMS DND once without duplicating existing restrictions or events', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        first: {
          type: 'dnd.set',
          config: { channel: 'sms', action: 'enable', reason: 'Requested by the contact.' },
          next: 'again',
        },
        again: {
          type: 'dnd.set',
          config: { channel: 'sms', action: 'enable', reason: 'Requested by the contact.' },
        },
      },
      'first',
    ),
  ).toEqual(completed);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select do_not_contact,dnd_channels from crm.contacts where id=$1', [s.contactId]),
    ),
  ).toEqual([{ do_not_contact: false, dnd_channels: ['sms'] }]);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query("select payload from events.events where type='contact.dnd_changed'"),
    ),
  ).toEqual([{ payload: { channels: ['sms'], enabled: ['sms'], disabled: [] } }]);
});

it('stops calls and web chat, and turns inbound do not disturb on and off, leaving the rest', async () => {
  const s = await scene();
  const reason = 'Requested by the contact.';
  expect(
    await s.run(
      {
        calls: {
          type: 'dnd.set',
          config: { channel: 'call', action: 'enable', reason },
          next: 'chat',
        },
        chat: {
          type: 'dnd.set',
          config: { direction: 'outbound', channel: 'webchat', action: 'enable', reason },
          next: 'inbound',
        },
        inbound: {
          type: 'dnd.set',
          config: { direction: 'inbound', action: 'enable', reason },
        },
      },
      'calls',
    ),
  ).toEqual(completed);
  const settings = () =>
    database.withTenant(s.context, (sql) =>
      sql.query('select do_not_contact,dnd_channels,dnd_inbound from crm.contacts where id=$1', [
        s.contactId,
      ]),
    );
  expect(await settings()).toEqual([
    { do_not_contact: false, dnd_channels: ['call', 'webchat'], dnd_inbound: true },
  ]);
  expect(
    await s.run(
      {
        inbound: {
          type: 'dnd.set',
          config: { direction: 'inbound', action: 'disable', reason },
        },
      },
      'inbound',
    ),
  ).toEqual(completed);
  expect(await settings()).toEqual([
    { do_not_contact: false, dnd_channels: ['call', 'webchat'], dnd_inbound: false },
  ]);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query("select type from events.events where type like 'contact.%dnd%' order by id"),
    ),
  ).toEqual([
    { type: 'contact.dnd_changed' },
    { type: 'contact.dnd_changed' },
    { type: 'contact.inbound_dnd_set' },
    { type: 'contact.inbound_dnd_cleared' },
  ]);
});

it('creates a merged plain-text note once and exposes its id to the next task', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        note: {
          type: 'note.create',
          config: { text: 'Hello {{contact.firstName}}\n<script>plain text</script>' },
          next: 'follow',
        },
        follow: { type: 'task.create', config: { title: 'Review {{steps.note.noteId}}' } },
      },
      'note',
    ),
  ).toEqual(completed);
  const run = await database.withTenant(s.context, (sql) =>
    sql.one<{ id: string }>('select id from automation.enrolments'),
  );
  expect(
    await runCommand(
      services,
      createRunStepCommand({ tasks: s.tasks }),
      {
        enrolmentId: run.id,
        sequence: 0,
      },
      { context: s.context, permissions: 'all' },
    ),
  ).toBe('skipped');
  const notes = await database.withTenant(s.context, (sql) =>
    sql.query<{ id: string; body: unknown; body_text: string }>(
      'select id,body,body_text from crm.notes where record_id=$1',
      [s.contactId],
    ),
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    body_text: 'Hello Ada\n<script>plain text</script>',
    body: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello Ada' },
            { type: 'hardBreak' },
            { type: 'text', text: '<script>plain text</script>' },
          ],
        },
      ],
    },
  });
  const saved = notes[0];
  if (saved === undefined) throw new Error('Native note missing.');
  expect(await s.events('note.')).toEqual(['note.created']);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query("select payload from events.events where type='note.created'"),
    ),
  ).toEqual([{ payload: { recordId: toPublicId('contact', s.contactId) } }]);
  expect(await tasks(s)).toMatchObject([{ title: `Review ${toPublicId('note', saved.id)}` }]);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query(`select input, outcome from audit.commands where command='note.create'`),
    ),
  ).toEqual([{ input: { id: toPublicId('contact', s.contactId) }, outcome: 'ok' }]);
});

it('writes a deal note with canonical line endings and blank lines', async () => {
  const s = await scene();
  const deal = await s.deal('Deal with a note');
  expect(
    await s.runForDeal(
      deal,
      {
        note: { type: 'note.create', config: { text: 'First\r\n\r\nLast\r' } },
      },
      'note',
    ),
  ).toEqual(completed);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select body,body_text,author_kind,author_id from crm.notes where record_id=$1', [
        parsePublicId('deal', deal.id),
      ]),
    ),
  ).toEqual([
    {
      body_text: 'First\n\nLast\n',
      author_kind: 'system',
      author_id: null,
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'First' },
              { type: 'hardBreak' },
              { type: 'hardBreak' },
              { type: 'text', text: 'Last' },
              { type: 'hardBreak' },
            ],
          },
        ],
      },
    },
  ]);
});

it('refuses a note with missing merge data and writes no note or later task', async () => {
  const s = await scene();
  await database.withTenant(s.context, (sql) =>
    sql.query('update crm.contacts set last_name=null where id=$1', [s.contactId]),
  );
  expect(
    await s.run(
      {
        note: { type: 'note.create', config: { text: '{{contact.lastName}}' }, next: 'follow' },
        follow: { type: 'task.create', config: { title: 'Should not run' } },
      },
      'note',
    ),
  ).toEqual(failed('missing_values'));
  expect(
    await database.withTenant(s.context, (sql) => sql.query('select id from crm.notes')),
  ).toEqual([]);
  expect(await tasks(s)).toEqual([]);
});

it('refuses a note whose rendered text exceeds the native size bound', async () => {
  const s = await scene();
  const token = '{{contact.email}}';
  expect(
    await s.run(
      {
        note: { type: 'note.create', config: { text: 'x'.repeat(100000 - token.length) + token } },
      },
      'note',
    ),
  ).toEqual(failed('too_big'));
  expect(
    await database.withTenant(s.context, (sql) => sql.query('select id from crm.notes')),
  ).toEqual([]);
  expect(await s.events('note.')).toEqual([]);
});

it('removes the contact owner through its command and leaves later tasks unassigned', async () => {
  const s = await scene();
  const owner = await database.fixtures.user();
  const membership = toPublicId('membership', owner.id);
  s.team.set(owner.id, membership);
  expect(
    await s.run(
      {
        assign: { type: 'owner.assign', config: { user: membership }, next: 'remove' },
        remove: { type: 'owner.remove', config: {}, next: 'follow' },
        follow: { type: 'task.create', config: { title: 'Find an owner' } },
      },
      'assign',
    ),
  ).toEqual(completed);
  expect(await contactRow(s)).toMatchObject({ owner_user_id: null });
  expect(await s.events('contact.owner_')).toEqual([
    'contact.owner_assigned',
    'contact.owner_unassigned',
  ]);
  expect(await tasks(s)).toMatchObject([{ title: 'Find an owner', assignee_user_id: null }]);
});

it('owner removal is a no-op without an owner and refuses deal enrollments', async () => {
  const s = await scene();
  expect(await s.run({ remove: { type: 'owner.remove', config: {} } }, 'remove')).toEqual(
    completed,
  );
  expect(await s.events('contact.owner_')).toEqual([]);
  const deal = await s.deal('Unchanged deal owner');
  expect(
    await s.runForDeal(deal, { remove: { type: 'owner.remove', config: {} } }, 'remove'),
  ).toEqual(failed('unsupported_record'));
});
const uuidOf = (kind: 'pipeline' | 'stage' | 'deal' | 'contact', id: string) =>
  parsePublicId(kind, id) ?? '';

interface Scene {
  readonly context: TenantContext;
  readonly businessId: string;
  /** Ada Lovelace, with one email address and the phone number +254712345678. */
  readonly contactId: string;
  readonly email: string;
  /** The seeded Sales pipeline and its stages, in order, as public ids. */
  readonly pipeline: string;
  readonly stages: readonly string[];
  /** The team: user id to membership id, as the server's task options would resolve them. */
  readonly team: Map<string, string>;
  readonly tasks: TaskOptions;
  /** Publishes the steps for new contacts, enrols Ada, and runs until the enrolment rests. */
  run(steps: Steps, start: string, now?: Date): Promise<Outcome>;
  /** Publishes the steps for moved deals, moves the deal on a stage, and runs its enrolment. */
  runForDeal(deal: Deal, steps: Steps, start: string): Promise<Outcome>;
  stepRuns(): Promise<StepRun[]>;
  deals(): Promise<DealRow[]>;
  events(prefix: string): Promise<string[]>;
  /** Another pipeline with one stage, as public ids. */
  pipelineWithStage(name: string): Promise<{ pipeline: string; stage: string }>;
  lostReason(label: string): Promise<string>;
  /** A deal made by a person in the first Sales stage, linked to nobody. */
  deal(name: string): Promise<Deal>;
}

async function scene(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const staff: TenantContext = {
    agencyId: agency.id,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  const suffix = randomUUID().slice(0, 8);
  const { id: businessId } = await database.withTenant(staff, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $3) returning id',
      [agency.id, `Business ${suffix}`, `business-${suffix}`],
    ),
  );
  await superuser((sql) =>
    sql.query("update tenancy.businesses set currency = 'KES' where id = $1", [businessId]),
  );
  const context: TenantContext = { ...staff, businessId };
  const invocation: Invocation = { context, permissions: 'all' };
  // Object types, the deal_contact link type and the Sales pipeline, from the real seed.
  await withTenant(db, context, (trx) => seedBusinessDefaults(trx, businessId));
  const stageRows = await database.withTenant(context, (sql) =>
    sql.query<{ id: string; pipeline_id: string }>(
      'select id, pipeline_id from crm.pipeline_stages order by position',
    ),
  );
  const pipeline = toPublicId('pipeline', stageRows[0]?.pipeline_id ?? '');
  const stages = stageRows.map((row) => toPublicId('stage', row.id));

  const email = `${randomUUID()}@example.test`;
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', lastName: 'Lovelace', emails: [email], phones: ['+254712345678'] },
    invocation,
  );
  const created = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow(),
  );

  const team = new Map<string, string>();
  const tasks: TaskOptions = {
    actorNames: {},
    assignees: {
      resolve: (_trx, _context, selection) => {
        const member = [...team].find(([, membership]) => membership === selection);
        if (selection !== null && member === undefined)
          throw new ValidationError([
            { path: '/assignee', code: 'unavailable_assignee', message: 'Not on the team.' },
          ]);
        return Promise.resolve(member?.[0] ?? null);
      },
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: (_trx, _context, userIds) =>
        Promise.resolve(
          new Map(
            userIds.flatMap((userId): [string, string][] => {
              const membership = team.get(userId);
              return membership === undefined ? [] : [[userId, membership]];
            }),
          ),
        ),
    },
  };
  const runStepCommand = createRunStepCommand({ tasks });

  const publish = (document: AutomationDocumentInput) =>
    withTenant(db, context, async (trx) => {
      const { id } = await trx
        .insertInto('automation.automations')
        .values({
          business_id: businessId,
          name: document.name,
          draft: JSON.stringify(document),
          created_by_kind: 'system',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
      return id;
    });
  const enrol = (automationId: string, eventId: string) =>
    withTenant(db, context, async (trx) => {
      const matched = await matchEvent(trx, context, eventId, contactValues);
      const mine = matched.enrolled.find((each) => each.automationId === automationId);
      if (mine === undefined) throw new Error('Nothing enrolled.');
      return mine.enrolmentId;
    });
  const finish = async (enrolmentId: string, start?: Date): Promise<Outcome> => {
    let now = start;
    for (let visit = 0; visit < 10; visit++) {
      const row = await withTenant(db, context, (trx) =>
        trx
          .selectFrom('automation.enrolments')
          .select(['status', 'exit_reason', 'state', 'wake_at'])
          .where('id', '=', enrolmentId)
          .executeTakeFirstOrThrow(),
      );
      // A loop goes round once an hour at most: a visit held for it runs when its hour is
      // up, as the worker would run it.
      const held = await database.withTenant(context, (sql) =>
        sql.query<{ held: string | null }>(
          `select input ->> 'held' as held from automation.step_runs
           where enrolment_id = $1 and status = 'waiting'`,
          [enrolmentId],
        ),
      );
      if (row.status === 'waiting' && held[0]?.held === 'loop_interval' && row.wake_at !== null)
        now = row.wake_at;
      else if (row.status !== 'running')
        return { status: row.status, exit_reason: row.exit_reason };
      await runCommand(
        services,
        runStepCommand,
        {
          enrolmentId,
          sequence: (row.state as { sequence: number }).sequence,
          ...(now === undefined ? {} : { now: now.toISOString() }),
        },
        invocation,
      );
    }
    throw new Error('The enrolment never came to rest.');
  };

  return {
    context,
    businessId,
    contactId: created.subject_id,
    email,
    pipeline,
    stages,
    team,
    tasks,
    run: async (steps, start, now) => {
      const automationId = await publish({
        name: 'New contact',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start,
        steps,
      });
      return finish(await enrol(automationId, created.id), now);
    },
    runForDeal: async (deal, steps, start) => {
      const automationId = await publish({
        name: 'Moved deal',
        triggers: [{ id: 'moved', type: 'deal.stage_changed', config: {} }],
        start,
        steps,
      });
      // A person moves the deal on a stage, which is the event that enrols it.
      await runCommand(
        services,
        updateDealCommand,
        {
          id: deal.id,
          revision: deal.revision,
          name: deal.name,
          pipelineId: deal.pipelineId,
          stageId: stages[1],
          amount: deal.amount,
          currency: deal.currency,
          expectedCloseDate: deal.expectedCloseDate,
          status: deal.status,
          outcomeReason: deal.outcomeReason,
        },
        invocation,
      );
      const moved = await withTenant(db, context, (trx) =>
        trx
          .selectFrom('events.events')
          .select('id')
          .where('type', '=', 'deal.stage_changed')
          .where('subject_id', '=', uuidOf('deal', deal.id))
          .executeTakeFirstOrThrow(),
      );
      return finish(await enrol(automationId, moved.id));
    },
    stepRuns: () =>
      database.withTenant(context, (sql) =>
        sql.query<StepRun>(
          'select step_key, status, output, explanation from automation.step_runs order by started_at, id',
        ),
      ),
    deals: () =>
      database.withTenant(context, (sql) =>
        sql.query<DealRow>(
          `select id, name, pipeline_id, stage_id, status, amount::text as amount, currency,
                  lost_note, lost_reason_id, closed_at is not null as closed
           from crm.deals order by id`,
        ),
      ),
    events: (prefix) =>
      database
        .withTenant(context, (sql) =>
          sql.query<{ type: string }>(
            'select type from events.events where type like $1 order by recorded_at, id',
            [`${prefix}%`],
          ),
        )
        .then((rows) => rows.map((row) => row.type)),
    pipelineWithStage: (name) =>
      superuser(async (sql) => {
        const made = await sql.one<{ id: string }>(
          'insert into crm.pipelines (business_id, name, position) values ($1, $2, 1) returning id',
          [businessId, name],
        );
        const stage = await sql.one<{ id: string }>(
          `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
           values ($1, $2, 'First', 0) returning id`,
          [businessId, made.id],
        );
        return { pipeline: toPublicId('pipeline', made.id), stage: toPublicId('stage', stage.id) };
      }),
    lostReason: (label) =>
      superuser(async (sql) =>
        toPublicId(
          'lost_reason',
          (
            await sql.one<{ id: string }>(
              'insert into crm.lost_reasons (business_id, label) values ($1, $2) returning id',
              [businessId, label],
            )
          ).id,
        ),
      ),
    deal: (name) =>
      runCommand(
        services,
        createDealCommand,
        { name, pipelineId: pipeline, stageId: stages[0], currency: 'KES' },
        invocation,
      ),
  };
}

const completed: Outcome = { status: 'completed', exit_reason: null };
const failed = (code: string): Outcome => ({ status: 'failed', exit_reason: code });

function at(list: readonly string[], index: number): string {
  const value = list[index];
  if (value === undefined) throw new Error(`Nothing at ${String(index)}.`);
  return value;
}

const contactRow = (s: Scene) =>
  database.withTenant(s.context, (sql) =>
    sql.one<{ first_name: string | null; last_name: string | null; owner_user_id: string | null }>(
      'select first_name, last_name, owner_user_id from crm.contacts where id = $1',
      [s.contactId],
    ),
  );
const identities = (s: Scene) =>
  database.withTenant(s.context, (sql) =>
    sql.query<{ kind: string; value_normalized: string; is_primary: boolean }>(
      `select kind, value_normalized, is_primary from crm.contact_identities
       where contact_id = $1 order by kind, is_primary desc, id`,
      [s.contactId],
    ),
  );
const tasks = (s: Scene) =>
  database.withTenant(s.context, (sql) =>
    sql.query<{
      id: string;
      record_id: string | null;
      title: string;
      body_text: string;
      due_at: Date | null;
      assignee_user_id: string | null;
      created_by_kind: string;
    }>(
      `select id, record_id, title, body_text, due_at, assignee_user_id, created_by_kind
       from crm.tasks order by created_at, id`,
    ),
  );
const links = (s: Scene) =>
  database.withTenant(s.context, (sql) =>
    sql.query<{ deal: string; contact: string; is_primary: boolean }>(
      `select link.from_record_id as deal, link.to_record_id as contact, link.is_primary
       from crm.record_links link
       join crm.link_types type on type.id = link.link_type_id
       where type.key = 'deal_contact'
       order by link.created_at, link.id`,
    ),
  );
const history = (s: Scene) =>
  database.withTenant(s.context, (sql) =>
    sql.query<{ stage_id: string; exited: boolean; entered_by_kind: string }>(
      `select stage_id, exited_at is not null as exited, entered_by_kind
       from crm.deal_stage_history order by entered_at, id`,
    ),
  );

// contact.update ---------------------------------------------------------------------------

it('sets built-in contact fields through the contact command, as one change', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        set: {
          type: 'contact.update',
          config: { fields: { 'contact.firstName': 'Grace', 'contact.lastName': null } },
        },
      },
      'set',
    ),
  ).toEqual(completed);
  expect(await contactRow(s)).toMatchObject({ first_name: 'Grace', last_name: null });
  // The CRM's own event, by the system, naming what changed and not the values.
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query<{ actor_kind: string; payload: unknown }>(
        "select actor_kind, payload from events.events where type = 'contact.updated'",
      ),
    ),
  ).toEqual([{ actor_kind: 'system', payload: { changed: ['firstName', 'lastName'] } }]);
  expect(await s.stepRuns()).toMatchObject([
    { step_key: 'set', status: 'succeeded', explanation: 'The contact fields were updated.' },
  ]);
});

it('makes a new email and phone the primary ones, and keeps the ones the contact had', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        set: {
          type: 'contact.update',
          config: {
            fields: {
              'contact.email': ' Grace@Example.test ',
              'contact.phone': '+254 700 000001',
            },
          },
        },
      },
      'set',
    ),
  ).toEqual(completed);
  expect(await identities(s)).toEqual([
    { kind: 'email', value_normalized: 'grace@example.test', is_primary: true },
    { kind: 'email', value_normalized: s.email, is_primary: false },
    { kind: 'phone', value_normalized: '+254700000001', is_primary: true },
    { kind: 'phone', value_normalized: '+254712345678', is_primary: false },
  ]);
});

it('leaves a phone the contact already has, however the step writes it', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        set: { type: 'contact.update', config: { fields: { 'contact.phone': '+254 712 345678' } } },
      },
      'set',
    ),
  ).toEqual(completed);
  expect(await identities(s)).toEqual([
    { kind: 'email', value_normalized: s.email, is_primary: true },
    { kind: 'phone', value_normalized: '+254712345678', is_primary: true },
  ]);
  // Nothing changed, so the CRM said nothing.
  expect(await s.events('contact.updated')).toEqual([]);
});

it('sets built-in and custom fields in one step, and undoes all of it when one is refused', async () => {
  const s = await scene();
  await database.withTenant(s.context, (sql) =>
    sql.query(
      `insert into crm.field_definitions (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, 'guests', 'Guests', 'How many guests are coming.', 'number', 'system'
       from crm.object_types where kind = 'contact'`,
    ),
  );
  expect(
    await s.run(
      {
        set: {
          type: 'contact.update',
          config: { fields: { 'contact.firstName': 'Grace', 'contact.custom.guests': 120 } },
        },
      },
      'set',
    ),
  ).toEqual(completed);
  expect(await contactRow(s)).toMatchObject({ first_name: 'Grace' });
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query<{ value_number: string }>('select value_number::text from crm.field_values'),
    ),
  ).toEqual([{ value_number: '120' }]);

  // Another contact holds the address, so the CRM refuses it: the name change goes too.
  const refused = await scene();
  const taken = `${randomUUID()}@example.test`;
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Omar', emails: [taken] },
    { context: refused.context, permissions: 'all' },
  );
  expect(
    await refused.run(
      {
        set: {
          type: 'contact.update',
          config: { fields: { 'contact.firstName': 'Grace', 'contact.email': taken } },
        },
      },
      'set',
    ),
  ).toEqual(failed('taken'));
  expect(await contactRow(refused)).toMatchObject({ first_name: 'Ada' });
  expect(await identities(refused)).toEqual([
    { kind: 'email', value_normalized: refused.email, is_primary: true },
    { kind: 'phone', value_normalized: '+254712345678', is_primary: true },
  ]);
  expect(await refused.events('contact.updated')).toEqual([]);
  expect(await refused.stepRuns()).toMatchObject([{ step_key: 'set', status: 'failed' }]);
});

it('refuses to empty an email address rather than choose which to drop', async () => {
  const s = await scene();
  expect(
    await s.run(
      { set: { type: 'contact.update', config: { fields: { 'contact.email': null } } } },
      'set',
    ),
  ).toEqual(failed('unsupported_value'));
  expect(await identities(s)).toHaveLength(2);
});

// task.create ------------------------------------------------------------------------------

it('fills a later task from the completed prior task output in the same enrolment', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        first: { type: 'task.create', config: { title: 'Call Ada' }, next: 'follow' },
        follow: {
          type: 'task.create',
          config: { title: 'Follow up', notes: 'Previous task: {{steps.first.taskId}}' },
        },
      },
      'first',
    ),
  ).toEqual({ status: 'completed', exit_reason: null });
  const stored = await tasks(s);
  expect(stored).toHaveLength(2);
  expect(stored.map((task) => task.title)).toEqual(['Call Ada', 'Follow up']);
  expect(stored[1]?.body_text).toBe(`Previous task: ${toPublicId('task', stored[0]?.id ?? '')}`);
});

it.each([false, true])(
  'refuses a skipped output without borrowing from an older enrolment: prior run %s',
  async (priorRun) => {
    const s = await scene();
    if (priorRun)
      expect(
        await s.run({ first: { type: 'task.create', config: { title: 'Earlier run' } } }, 'first'),
      ).toEqual(completed);
    expect(
      await s.run(
        {
          decide: {
            type: 'condition',
            config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Grace' } },
            next: { yes: 'first', no: 'follow' },
          },
          first: { type: 'task.create', config: { title: 'Skipped task' }, next: 'follow' },
          follow: {
            type: 'task.create',
            config: { title: 'Must not be created', notes: '{{steps.first.taskId}}' },
          },
        },
        'decide',
      ),
    ).toEqual(failed('missing_values'));
    expect((await tasks(s)).map((task) => task.title)).toEqual(priorRun ? ['Earlier run'] : []);
  },
);

it('uses the latest completed task output after revisiting a step', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        first: {
          type: 'task.create',
          config: { title: 'Call {{contact.firstName}}' },
          next: 'decide',
        },
        decide: {
          type: 'condition',
          config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
          next: { yes: 'rename', no: 'follow' },
        },
        rename: {
          type: 'contact.update',
          config: { fields: { 'contact.firstName': 'Grace' } },
          next: 'first',
        },
        follow: {
          type: 'task.create',
          config: { title: 'Follow up', notes: 'Latest task: {{steps.first.taskId}}' },
        },
      },
      'first',
    ),
  ).toEqual(completed);
  const stored = await tasks(s);
  expect(stored.map((task) => task.title)).toEqual(['Call Ada', 'Call Grace', 'Follow up']);
  expect(stored[2]?.body_text).toBe(`Latest task: ${toPublicId('task', stored[1]?.id ?? '')}`);
});

it('creates a task on the contact, with its text filled in and its due time from the step', async () => {
  const s = await scene();
  const now = new Date('2026-10-09T08:00:00.000Z');
  expect(
    await s.run(
      {
        todo: {
          type: 'task.create',
          config: {
            title: 'Call {{contact.firstName}}',
            notes: 'Their email is {{contact.email}}.',
            dueIn: 'P2D',
          },
        },
      },
      'todo',
      now,
    ),
  ).toEqual(completed);
  const [task, ...rest] = await tasks(s);
  expect(rest).toEqual([]);
  expect(task).toMatchObject({
    record_id: s.contactId,
    title: 'Call Ada',
    body_text: `Their email is ${s.email}.`,
    due_at: new Date('2026-10-11T08:00:00.000Z'),
    // Nobody owns the contact, so the task is for anyone to pick up.
    assignee_user_id: null,
    created_by_kind: 'system',
  });
  expect(await s.stepRuns()).toMatchObject([
    {
      step_key: 'todo',
      status: 'succeeded',
      output: { taskId: toPublicId('task', task?.id ?? '') },
      explanation: 'The task was created.',
    },
  ]);
  expect(await s.events('task.')).toEqual(['task.created']);
});

it('assigns an owner through the CRM command before creating the next task', async () => {
  const s = await scene();
  const owner = await database.fixtures.user();
  const membership = toPublicId('membership', owner.id);
  s.team.set(owner.id, membership);
  expect(
    await s.run(
      {
        assign: { type: 'owner.assign', config: { user: membership }, next: 'todo' },
        todo: { type: 'task.create', config: { title: 'Call the new lead' } },
      },
      'assign',
    ),
  ).toEqual(completed);
  expect(await contactRow(s)).toMatchObject({ owner_user_id: owner.id });
  expect(await s.events('contact.owner_')).toEqual(['contact.owner_assigned']);
  expect(await tasks(s)).toMatchObject([
    { title: 'Call the new lead', assignee_user_id: owner.id },
  ]);
  expect(await s.stepRuns()).toMatchObject([
    {
      step_key: 'assign',
      status: 'succeeded',
      output: {},
      explanation: "The contact's owner was assigned.",
    },
    { step_key: 'todo', status: 'succeeded' },
  ]);
});

it('refuses an owner from outside the team without changing the contact or starting the next task', async () => {
  const s = await scene();
  const outsider = await database.fixtures.user();
  expect(
    await s.run(
      {
        assign: {
          type: 'owner.assign',
          config: { user: toPublicId('membership', outsider.id) },
          next: 'todo',
        },
        todo: { type: 'task.create', config: { title: 'Must not run' } },
      },
      'assign',
    ),
  ).toEqual(failed('unavailable_member'));
  expect(await contactRow(s)).toMatchObject({ owner_user_id: null });
  expect(await s.events('contact.owner_')).toEqual([]);
  expect(await tasks(s)).toEqual([]);
});

it('refuses contact owner assignment on a deal enrollment', async () => {
  const s = await scene();
  const owner = await database.fixtures.user();
  const membership = toPublicId('membership', owner.id);
  s.team.set(owner.id, membership);
  const deal = await s.deal('A deal is not a contact');
  expect(
    await s.runForDeal(
      deal,
      { assign: { type: 'owner.assign', config: { user: membership } } },
      'assign',
    ),
  ).toEqual(failed('unsupported_record'));
  expect(await contactRow(s)).toMatchObject({ owner_user_id: null });
  expect(await s.events('contact.owner_')).toEqual([]);
});

it("assigns the task to the contact's owner while they are on the team, and to nobody after", async () => {
  const s = await scene();
  const owner = await database.fixtures.user();
  const left = await database.fixtures.user();
  s.team.set(owner.id, toPublicId('membership', owner.id));
  const own = (userId: string) =>
    superuser((sql) =>
      sql.query('update crm.contacts set owner_user_id = $1 where id = $2', [userId, s.contactId]),
    );
  const todo: Steps = { todo: { type: 'task.create', config: { title: 'Send the quote' } } };
  await own(owner.id);
  expect(await s.run(todo, 'todo')).toEqual(completed);
  // Someone who left the team still owns the contact, but can't be given a task.
  await own(left.id);
  expect(await s.run(todo, 'todo')).toEqual(completed);
  expect(await tasks(s)).toMatchObject([
    { title: 'Send the quote', body_text: '', due_at: null, assignee_user_id: owner.id },
    { title: 'Send the quote', assignee_user_id: null },
  ]);
});

it('fails the step, and makes no task, when its text or its due time cannot be worked out', async () => {
  const missing = await scene();
  expect(
    await missing.run(
      {
        todo: { type: 'task.create', config: { title: 'About {{contact.custom.event_date}}' } },
      },
      'todo',
    ),
  ).toEqual(failed('missing_values'));
  expect(await tasks(missing)).toEqual([]);

  const beyond = await scene();
  expect(
    await beyond.run(
      { todo: { type: 'task.create', config: { title: 'Call', dueIn: 'P300000Y' } } },
      'todo',
    ),
  ).toEqual(failed('date_out_of_range'));
  expect(await tasks(beyond)).toEqual([]);
  expect(await beyond.events('task.')).toEqual([]);
});

// deal.create ------------------------------------------------------------------------------

it("creates a deal in the stage, in the business's currency, linked to the contact as primary", async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        open: {
          type: 'deal.create',
          config: {
            pipeline: s.pipeline,
            stage: at(s.stages, 1),
            name: 'Wedding for {{contact.firstName}}',
            amount: 1500.5,
          },
        },
      },
      'open',
    ),
  ).toEqual(completed);
  const [deal, ...rest] = await s.deals();
  expect(rest).toEqual([]);
  expect(deal).toMatchObject({
    name: 'Wedding for Ada',
    pipeline_id: uuidOf('pipeline', s.pipeline),
    stage_id: uuidOf('stage', at(s.stages, 1)),
    status: 'open',
    amount: '1500.5000',
    currency: 'KES',
    closed: false,
  });
  expect(await links(s)).toEqual([{ deal: deal?.id, contact: s.contactId, is_primary: true }]);
  expect(await history(s)).toEqual([
    { stage_id: uuidOf('stage', at(s.stages, 1)), exited: false, entered_by_kind: 'system' },
  ]);
  expect(await s.stepRuns()).toMatchObject([
    {
      step_key: 'open',
      status: 'succeeded',
      output: { dealId: toPublicId('deal', deal?.id ?? '') },
      explanation: 'The deal was created and linked to the contact.',
    },
  ]);
  expect(await s.events('deal.')).toEqual(['deal.created', 'deal.contact_linked']);
});

it('names the deal after the contact when the step gives no name, and leaves the amount empty', async () => {
  const s = await scene();
  expect(
    await s.run(
      { open: { type: 'deal.create', config: { pipeline: s.pipeline, stage: at(s.stages, 0) } } },
      'open',
    ),
  ).toEqual(completed);
  expect(await s.deals()).toMatchObject([{ name: 'Ada Lovelace', amount: null }]);
});

it("refuses another business's pipeline, a stage of another pipeline, names, and an amount it can't keep", async () => {
  const other = await scene();
  const mine = await scene();
  const open = (stage: string, pipeline = mine.pipeline, amount?: number): Steps => ({
    open: {
      type: 'deal.create',
      config: { pipeline, stage, ...(amount === undefined ? {} : { amount }) },
    },
  });
  expect(await mine.run(open(at(other.stages, 0), other.pipeline), 'open')).toEqual(
    failed('unavailable'),
  );
  const renewals = await mine.pipelineWithStage('Renewals');
  expect(await mine.run(open(renewals.stage), 'open')).toEqual(failed('unavailable'));
  // A name the validator never resolved is not an id the CRM takes.
  expect(await mine.run(open('New lead', 'Sales'), 'open')).toEqual(failed('invalid_format'));
  // More decimal places than the CRM keeps: refused, not rounded.
  expect(await mine.run(open(at(mine.stages, 0), mine.pipeline, 1.23456), 'open')).toEqual(
    failed('custom'),
  );
  expect(await mine.deals()).toEqual([]);
  expect(await other.deals()).toEqual([]);
  expect(await mine.events('deal.')).toEqual([]);
});

it('keeps no deal when its link to the contact is refused', async () => {
  const s = await scene();
  await superuser((sql) =>
    sql.query('update crm.link_types set archived_at = now() where business_id = $1', [
      s.businessId,
    ]),
  );
  expect(
    await s.run(
      { open: { type: 'deal.create', config: { pipeline: s.pipeline, stage: at(s.stages, 0) } } },
      'open',
    ),
  ).toEqual(failed('conflict'));
  expect(await s.deals()).toEqual([]);
  expect(await links(s)).toEqual([]);
  expect(await history(s)).toEqual([]);
  expect(await s.events('deal.')).toEqual([]);
  expect(await s.stepRuns()).toMatchObject([{ step_key: 'open', status: 'failed', output: {} }]);
});

/** The contact's custom number field `budget`, holding the value given, or nothing. */
const budget = (s: Scene, value: number | null) =>
  database.withTenant(s.context, async (sql) => {
    const { id } = await sql.one<{ id: string }>(
      `insert into crm.field_definitions (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, 'budget', 'Budget', 'What they plan to spend.', 'number', 'system'
       from crm.object_types where kind = 'contact' returning id`,
    );
    if (value !== null)
      await sql.query(
        `insert into crm.field_values (business_id, record_id, field_id, value_type, value_number, source_kind)
         values (app.business_id(), $1, $2, 'number', $3, 'system')`,
        [s.contactId, id, value],
      );
  });

const openFromBudget = (s: Scene): Steps => ({
  open: {
    type: 'deal.create',
    config: { pipeline: s.pipeline, stage: at(s.stages, 0), amountFrom: 'contact.custom.budget' },
  },
});

it('takes the amount from the number field the step names, as the contact holds it then', async () => {
  const s = await scene();
  await budget(s, 2500.5);
  expect(await s.run(openFromBudget(s), 'open')).toEqual(completed);
  expect(await s.deals()).toMatchObject([
    { name: 'Ada Lovelace', amount: '2500.5000', currency: 'KES' },
  ]);
  expect(await s.stepRuns()).toMatchObject([
    {
      step_key: 'open',
      status: 'succeeded',
      explanation: 'The deal was created and linked to the contact.',
    },
  ]);
});

it('creates the deal without an amount, and says so, when the field has nothing in it', async () => {
  const s = await scene();
  await budget(s, null);
  expect(await s.run(openFromBudget(s), 'open')).toEqual(completed);
  expect(await s.deals()).toMatchObject([{ name: 'Ada Lovelace', amount: null }]);
  expect(await links(s)).toHaveLength(1);
  expect(await s.stepRuns()).toMatchObject([
    {
      step_key: 'open',
      status: 'succeeded',
      explanation:
        'The deal was created and linked to the contact. contact.custom.budget has nothing in it, so the deal has no amount.',
    },
  ]);
});

it('creates the deal without an amount, and says so, when the field holds what no deal can', async () => {
  const s = await scene();
  await budget(s, -40);
  expect(await s.run(openFromBudget(s), 'open')).toEqual(completed);
  expect(await s.deals()).toMatchObject([{ amount: null }]);
  expect(await s.stepRuns()).toMatchObject([
    {
      step_key: 'open',
      status: 'succeeded',
      explanation:
        'The deal was created and linked to the contact. contact.custom.budget holds "-40", which is not an amount a deal can have, so the deal has no amount.',
    },
  ]);
});

// deal.move --------------------------------------------------------------------------------

const opened = (
  s: Scene,
  next: string,
  config: { name?: string; pipeline?: string; stage?: string } = {},
): Steps[string] => ({
  type: 'deal.create',
  config: { pipeline: s.pipeline, stage: at(s.stages, 0), ...config },
  next,
});

/** A deal a person made with the scene's contact as its primary contact. */
const linkedDeal = (
  s: Scene,
  name: string,
  where: { pipeline: string; stage: string } = { pipeline: s.pipeline, stage: at(s.stages, 0) },
) =>
  runCommand(
    services,
    createDealCommand,
    {
      name,
      pipelineId: where.pipeline,
      stageId: where.stage,
      currency: 'KES',
      primaryContactId: toPublicId('contact', s.contactId),
    },
    { context: s.context, permissions: 'all' },
  );

it("moves the contact's one open deal to the stage, with its history and events", async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        open: opened(s, 'move'),
        move: { type: 'deal.move', config: { stage: at(s.stages, 2) } },
      },
      'open',
    ),
  ).toEqual(completed);
  expect(await s.deals()).toMatchObject([
    { stage_id: uuidOf('stage', at(s.stages, 2)), status: 'open' },
  ]);
  expect(await history(s)).toEqual([
    { stage_id: uuidOf('stage', at(s.stages, 0)), exited: true, entered_by_kind: 'system' },
    { stage_id: uuidOf('stage', at(s.stages, 2)), exited: false, entered_by_kind: 'system' },
  ]);
  expect(await s.events('deal.')).toEqual([
    'deal.created',
    'deal.contact_linked',
    'deal.updated',
    'deal.stage_changed',
  ]);
  // The deal the run's own step created is the one it has in hand.
  expect((await s.stepRuns()).map((run) => run.explanation)).toEqual([
    'The deal was created and linked to the contact.',
    'The deal in hand ("Ada Lovelace") was moved to the stage.',
  ]);
});

it('goes on without touching a deal that is already in the stage', async () => {
  const s = await scene();
  expect(
    await s.run(
      {
        open: opened(s, 'move'),
        move: { type: 'deal.move', config: { stage: at(s.stages, 0), pipeline: s.pipeline } },
      },
      'open',
    ),
  ).toEqual(completed);
  expect(await s.events('deal.')).toEqual(['deal.created', 'deal.contact_linked']);
  expect((await s.stepRuns()).at(-1)).toMatchObject({
    status: 'succeeded',
    explanation: 'The deal in hand ("Ada Lovelace") was already in that stage.',
  });
});

it('fails with no open deal of the contact, and never takes a deal that is not linked to it', async () => {
  const s = await scene();
  await s.deal('Somebody else');
  expect(
    await s.run({ move: { type: 'deal.move', config: { stage: at(s.stages, 2) } } }, 'move'),
  ).toEqual(failed('no_open_deal'));
  expect(await s.deals()).toMatchObject([
    { name: 'Somebody else', stage_id: uuidOf('stage', at(s.stages, 0)) },
  ]);
  expect(await s.events('deal.stage_changed')).toEqual([]);
});

it('fails rather than guess between two open deals in the pipeline', async () => {
  const s = await scene();
  // Two deals the contact already has, and no step that takes one in hand.
  await linkedDeal(s, 'Wedding');
  await linkedDeal(s, 'Reception');
  expect(
    await s.run({ move: { type: 'deal.move', config: { stage: at(s.stages, 2) } } }, 'move'),
  ).toEqual(failed('several_open_deals'));
  const first = uuidOf('stage', at(s.stages, 0));
  expect(await s.deals()).toMatchObject([
    { name: 'Wedding', stage_id: first },
    { name: 'Reception', stage_id: first },
  ]);
  expect(await s.events('deal.stage_changed')).toEqual([]);
  expect((await s.stepRuns()).at(-1)).toMatchObject({ step_key: 'move', status: 'failed' });
});

it("moves the open deal in the stage's pipeline when another pipeline has one too, and then can't tell which to close", async () => {
  const s = await scene();
  const renewals = await s.pipelineWithStage('Renewals');
  // Two deals the contact already has, and no step that takes one in hand.
  await linkedDeal(s, 'Wedding');
  await linkedDeal(s, 'Renewal', renewals);
  expect(
    await s.run(
      {
        move: { type: 'deal.move', config: { stage: at(s.stages, 2) }, next: 'close' },
        // deal.close names no pipeline, so both open deals are candidates.
        close: { type: 'deal.close', config: { outcome: 'won' } },
      },
      'move',
    ),
  ).toEqual(failed('several_open_deals'));
  // The move before it stays: each step is its own transaction.
  expect(await s.deals()).toMatchObject([
    { name: 'Wedding', stage_id: uuidOf('stage', at(s.stages, 2)), status: 'open' },
    { name: 'Renewal', stage_id: uuidOf('stage', renewals.stage), status: 'open' },
  ]);
});

it("refuses another business's stage, and a stage that is not an id", async () => {
  const other = await scene();
  const mine = await scene();
  expect(
    await mine.run(
      {
        open: opened(mine, 'move'),
        move: { type: 'deal.move', config: { stage: at(other.stages, 2) } },
      },
      'open',
    ),
  ).toEqual(failed('unavailable'));
  expect(
    await mine.run({ move: { type: 'deal.move', config: { stage: 'Negotiating' } } }, 'move'),
  ).toEqual(failed('unavailable'));
  // A pipeline the contact has no deal in, whatever stage is named with it.
  const renewals = await mine.pipelineWithStage('Renewals');
  expect(
    await mine.run(
      {
        move: {
          type: 'deal.move',
          config: { stage: at(mine.stages, 2), pipeline: renewals.pipeline },
        },
      },
      'move',
    ),
  ).toEqual(failed('no_open_deal'));
  expect(await mine.deals()).toMatchObject([{ stage_id: uuidOf('stage', at(mine.stages, 0)) }]);
});

// deal.close -------------------------------------------------------------------------------

it("closes the contact's open deal as won", async () => {
  const s = await scene();
  expect(
    await s.run(
      { open: opened(s, 'close'), close: { type: 'deal.close', config: { outcome: 'won' } } },
      'open',
    ),
  ).toEqual(completed);
  expect(await s.deals()).toMatchObject([
    { status: 'won', closed: true, lost_note: null, stage_id: uuidOf('stage', at(s.stages, 0)) },
  ]);
  expect(await s.events('deal.')).toEqual([
    'deal.created',
    'deal.contact_linked',
    'deal.updated',
    'deal.won',
  ]);
  expect((await s.stepRuns()).at(-1)).toMatchObject({
    explanation: 'The deal in hand ("Ada Lovelace") was closed as won.',
  });
});

it('closes it as lost with the lost reason by its label, as the CRM keeps reasons', async () => {
  const s = await scene();
  const lostReason = await s.lostReason('Too expensive');
  expect(
    await s.run(
      {
        open: opened(s, 'close'),
        close: { type: 'deal.close', config: { outcome: 'lost', lostReason } },
      },
      'open',
    ),
  ).toEqual(completed);
  expect(await s.deals()).toMatchObject([
    { status: 'lost', closed: true, lost_note: 'Too expensive', lost_reason_id: null },
  ]);
  expect(await s.events('deal.lost')).toEqual(['deal.lost']);
});

it("leaves the deal open when the lost reason is another business's, archived, or not an id", async () => {
  const other = await scene();
  const theirs = await other.lostReason('Too expensive');
  const s = await scene();
  const mine = await s.lostReason('Went elsewhere');
  await superuser((sql) =>
    sql.query('update crm.lost_reasons set archived_at = now() where business_id = $1', [
      s.businessId,
    ]),
  );
  const close = (lostReason: string): Steps => ({
    close: { type: 'deal.close', config: { outcome: 'lost', lostReason } },
  });
  expect(await s.run({ open: opened(s, 'close'), ...close(theirs) }, 'open')).toEqual(
    failed('lost_reason_unavailable'),
  );
  expect(await s.run(close(mine), 'close')).toEqual(failed('lost_reason_unavailable'));
  expect(await s.run(close('Too expensive'), 'close')).toEqual(failed('lost_reason_unavailable'));
  expect(await s.deals()).toMatchObject([{ status: 'open', closed: false, lost_note: null }]);
});

// An enrolled deal ---------------------------------------------------------------------------

it('moves and closes the enrolled deal itself, and puts its task on the deal', async () => {
  const s = await scene();
  const deal = await s.deal('Reception');
  expect(
    await s.runForDeal(
      deal,
      {
        move: { type: 'deal.move', config: { stage: at(s.stages, 3) }, next: 'todo' },
        todo: { type: 'task.create', config: { title: 'Send the contract' }, next: 'close' },
        close: { type: 'deal.close', config: { outcome: 'won' } },
      },
      'move',
    ),
  ).toEqual(completed);
  expect(await s.deals()).toMatchObject([
    { name: 'Reception', stage_id: uuidOf('stage', at(s.stages, 3)), status: 'won' },
  ]);
  expect(await tasks(s)).toMatchObject([
    { record_id: uuidOf('deal', deal.id), title: 'Send the contract' },
  ]);
});

it('fails on an enrolled deal that is already closed, and never creates a deal for a deal', async () => {
  const s = await scene();
  const deal = await s.deal('Reception');
  expect(
    await s.runForDeal(
      deal,
      {
        close: { type: 'deal.close', config: { outcome: 'won' }, next: 'again' },
        again: { type: 'deal.move', config: { stage: at(s.stages, 0) } },
      },
      'close',
    ),
  ).toEqual(failed('deal_not_open'));
  expect(await s.deals()).toMatchObject([
    { status: 'won', stage_id: uuidOf('stage', at(s.stages, 1)) },
  ]);

  const other = await s.deal('Dinner');
  expect(
    await s.runForDeal(
      other,
      { open: { type: 'deal.create', config: { pipeline: s.pipeline, stage: at(s.stages, 0) } } },
      'open',
    ),
  ).toEqual(failed('unsupported_record'));
  expect(await s.deals()).toHaveLength(2);
});

// What is refused before anything runs ---------------------------------------------------------

it('fails safely for a record the action has nothing to do with', async () => {
  const s = await scene();
  const { steps } = automationDocument.parse({
    name: 'Every record action',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'set',
    steps: {
      set: { type: 'contact.update', config: { fields: { 'contact.firstName': 'Grace' } } },
      open: { type: 'deal.create', config: { pipeline: s.pipeline, stage: at(s.stages, 0) } },
      move: { type: 'deal.move', config: { stage: at(s.stages, 1) } },
      close: { type: 'deal.close', config: { outcome: 'won' } },
      todo: { type: 'task.create', config: { title: 'Call' } },
    },
  });
  const command: CommandContext = {
    context: s.context,
    permissions: 'all',
    emit: () => Promise.resolve(randomUUID()),
    enqueue: () => undefined,
  };
  const plan = (key: string, kind: string) => {
    const step = steps[key];
    if (step === undefined) throw new Error(`No step ${key}.`);
    return withTenant(db, s.context, (trx) =>
      runAction(
        trx,
        command,
        step,
        { id: s.contactId, kind },
        {
          enrolmentId: randomUUID(),
          automationId: randomUUID(),
          stepKey: key,
          sequence: 0,
          now: new Date(),
          timeZone: 'UTC',
        },
        { tasks: s.tasks },
      ),
    );
  };
  for (const key of ['set', 'open', 'move', 'close'])
    expect(await plan(key, 'company')).toMatchObject({ kind: 'fail', error: 'unsupported_record' });
  // A kind of record the CRM has no tasks for.
  expect(await plan('todo', 'booking')).toMatchObject({
    kind: 'fail',
    error: 'unsupported_record',
  });
  expect(await contactRow(s)).toMatchObject({ first_name: 'Ada' });
  expect(await s.deals()).toEqual([]);
  expect(await tasks(s)).toEqual([]);
});

it.each<[string, Steps]>([
  ['team.notify', { later: { type: 'team.notify', config: { message: 'A new lead came in.' } } }],
  ['ai.ask', { later: { type: 'ai.ask', config: { prompt: 'What did they ask for?' } } }],
])('still fails %s safely as not available, changing nothing', async (_type, steps) => {
  const s = await scene();
  expect(await s.run(steps, 'later')).toEqual(failed('not_implemented'));
  expect(await contactRow(s)).toMatchObject({ owner_user_id: null });
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select id from automation.enrolments'),
    ),
  ).toHaveLength(1);
});
