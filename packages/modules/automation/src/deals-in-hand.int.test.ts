// Opportunities in hand, through real runs on real Postgres and the CRM's own commands:
// deal.find and its filters, the deal a run has in hand and the steps that act on it,
// deal.update, and the deal.* values conditions and merge fields read.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput, Deal } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import {
  createDealCommand,
  readRecordField,
  seedBusinessDefaults,
  setRecordFieldCommand,
  updateDealCommand,
  type TaskOptions,
} from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { createRunStepCommand } from './runner.js';
import { runValues } from './run-values.js';
import { testRunCommand } from './test-runs.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

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
const runStep = createRunStepCommand({ tasks });

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});

type Steps = AutomationDocumentInput['steps'];

interface Scene {
  readonly tenant: Tenant;
  readonly pipeline: string;
  readonly stages: readonly string[];
  /** Ada, by stored id and by the id the API shows, and the event that made her. */
  readonly contactId: string;
  readonly contact: string;
  readonly eventId: string;
  /** A deal with Ada as its primary contact, made by a person. */
  deal(name: string, more?: { amount?: string; stage?: number; status?: 'won' }): Promise<Deal>;
  /** Publishes the steps for new contacts, enrols Ada, and runs until the run rests. */
  run(steps: Steps, start: string): Promise<string>;
}

async function scene(): Promise<Scene> {
  const agency = await h.database.fixtures.agency();
  const suffix = randomUUID().slice(0, 8);
  const staff = { agencyId: agency.id, actorKind: 'system' as const, correlationId: randomUUID() };
  const { id: businessId } = await h.database.withTenant(staff, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $3) returning id',
      [agency.id, `Business ${suffix}`, `business-${suffix}`],
    ),
  );
  const tenant: Tenant = { ...staff, businessId };
  // Object types, the deal_contact link type and the Sales pipeline, from the real seed.
  await withTenant(h.db, tenant, (trx) => seedBusinessDefaults(trx, businessId));
  const stageRows = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; pipeline_id: string }>(
      'select id, pipeline_id from crm.pipeline_stages order by position',
    ),
  );
  const pipeline = toPublicId('pipeline', stageRows[0]?.pipeline_id ?? '');
  const stages = stageRows.map((row) => toPublicId('stage', row.id));
  const made = await h.contact(tenant, 'Ada');
  return {
    tenant,
    pipeline,
    stages,
    ...made,
    deal: (name, more = {}) =>
      runCommand(
        h.services,
        createDealCommand,
        {
          name,
          pipelineId: pipeline,
          stageId: stages[more.stage ?? 0],
          amount: more.amount ?? null,
          currency: 'USD',
          status: more.status ?? 'open',
          outcomeReason: more.status === 'won' ? 'Signed' : null,
          primaryContactId: made.contact,
        },
        all(tenant),
      ),
    run: async (steps, start) => {
      await h.publish(tenant, {
        name: 'Deals',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start,
        steps,
      });
      await h.match(tenant, made.eventId);
      const [run] = await h.database.withTenant(tenant, (sql) =>
        sql.query<{ id: string }>(
          `select id from automation.enrolments where record_id = $1 order by id desc limit 1`,
          [made.contactId],
        ),
      );
      if (run === undefined) throw new Error('Nothing enrolled.');
      await rest(tenant, run.id);
      return run.id;
    },
  };
}

/** Runs the enrolment's steps, as the worker's jobs do, until it is no longer running. */
async function rest(tenant: Tenant, enrolmentId: string, now?: Date): Promise<void> {
  for (let visit = 0; visit < 20; visit++) {
    const run = await h.run(tenant, enrolmentId);
    if (run.status !== 'running' && !(now !== undefined && visit === 0)) return;
    await runCommand(
      h.services,
      runStep,
      {
        enrolmentId,
        sequence: run.sequence,
        ...(now === undefined ? {} : { now: now.toISOString() }),
      },
      all(tenant),
    );
  }
  throw new Error('The run never came to rest.');
}

const stepsOf = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      branch: string | null;
      output: Record<string, unknown>;
      explanation: string;
      error: { code: string } | null;
    }>(
      `select step_key, status, branch, output, explanation, error from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

const dealsOf = (tenant: Tenant) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      name: string;
      status: string;
      amount: string | null;
      stage_id: string;
      source: string | null;
      due: string | null;
      owner_user_id: string | null;
    }>(
      `select name, status, amount::text as amount, stage_id, source,
              expected_close_date::text as due, owner_user_id
       from crm.deals order by created_at, id`,
    ),
  );

const stageOf = (stage: string | undefined) => parsePublicId('stage', stage ?? '');

/** A custom field of deals, by its public id. */
async function dealField(tenant: Tenant, key: string): Promise<string> {
  const { id } = await h.database.withTenant(tenant, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, options, created_by_kind)
       select app.business_id(), id, $1::text, $1::text, 'A field of the test.', 'single_choice',
              '[{"key":"video","label":"Video","description":"","archived":false},
                {"key":"photo","label":"Photography","description":"","archived":false}]'::jsonb, 'system'
       from crm.object_types where kind = 'deal'
       returning id`,
      [key],
    ),
  );
  return toPublicId('field', id);
}

async function setDealField(tenant: Tenant, deal: string, fieldId: string, value: string) {
  const current = await withTenant(h.db, tenant, (trx) =>
    readRecordField(trx, all(tenant), deal, fieldId),
  );
  await runCommand(
    h.services,
    setRecordFieldCommand,
    { id: deal, fieldId, value, revision: current.revision },
    all(tenant),
  );
}

/** A chain of deal.find steps, each going on to the next whatever it finds. */
function searches(configs: Record<string, Record<string, unknown>>): Steps {
  const keys = Object.keys(configs);
  return Object.fromEntries(
    keys.map((key, index) => {
      const next = keys[index + 1];
      return [
        key,
        {
          type: 'deal.find',
          config: configs[key],
          ...(next === undefined ? {} : { next: { found: next, not_found: next } }),
        },
      ];
    }),
  ) as Steps;
}

it('finds the newest or the oldest of the contact deals that pass every filter', async () => {
  const s = await scene();
  const service = await dealField(s.tenant, 'service');
  const other = await h.contact(s.tenant, 'Omar');
  const fence = await s.deal('Garden fence', { amount: '100' });
  const roof = await s.deal('Roof repair', { amount: '5000', stage: 1 });
  const paint = await s.deal('Paint the fence', { amount: '700', status: 'won' });
  await setDealField(s.tenant, roof.id, service, 'video');
  // Another contact's deal, and one of Ada's in the trash: neither is ever found.
  await runCommand(
    h.services,
    createDealCommand,
    {
      name: 'Roof for Omar',
      pipelineId: s.pipeline,
      stageId: s.stages[0],
      currency: 'USD',
      primaryContactId: other.contact,
    },
    all(s.tenant),
  );
  const binned = await s.deal('Roof in the trash', { amount: '9000' });
  await h.database.as('postgres', (sql) =>
    sql.query('update crm.deals set deleted_at = now() where id = $1', [
      parsePublicId('deal', binned.id),
    ]),
  );
  const elsewhere = await h.database.as('postgres', (sql) =>
    sql.one<{ id: string }>(
      'insert into crm.pipelines (business_id, name, position) values ($1, $2, 1) returning id',
      [s.tenant.businessId, 'Renewals'],
    ),
  );
  const run = await s.run(
    searches({
      newest: {},
      oldest: { which: 'oldest' },
      newest_open: { status: 'open' },
      won: { status: 'won', which: 'oldest' },
      any: { status: 'any', which: 'oldest' },
      named: { nameContains: 'FENCE', which: 'oldest' },
      named_open: { nameContains: 'fence', status: 'open', which: 'newest' },
      staged: { stage: s.stages[1] },
      piped: { pipeline: s.pipeline, which: 'oldest' },
      other_pipeline: { pipeline: toPublicId('pipeline', elsewhere.id) },
      over: { value: { operator: 'greater_than', value: 700 } },
      under: { value: { operator: 'less_than', value: 700 } },
      exactly: { value: { operator: 'equals', value: 700 } },
      custom: { customField: { field: 'deal.custom.service', equals: 'video' } },
      custom_other: { customField: { field: 'deal.custom.service', equals: 'photo' } },
      together: {
        status: 'open',
        nameContains: 'roof',
        value: { operator: 'less_than', value: 10 },
      },
    }),
    'newest',
  );
  const rows = await stepsOf(s.tenant, run);
  const found = Object.fromEntries(
    rows.map((row) => [row.step_key, [row.branch, row.output['dealId'] ?? null]]),
  );
  expect(found).toEqual({
    newest: ['found', paint.id],
    oldest: ['found', fence.id],
    newest_open: ['found', roof.id],
    won: ['found', paint.id],
    any: ['found', fence.id],
    named: ['found', fence.id],
    named_open: ['found', fence.id],
    staged: ['found', roof.id],
    piped: ['found', fence.id],
    other_pipeline: ['not_found', null],
    over: ['found', roof.id],
    under: ['found', fence.id],
    exactly: ['found', paint.id],
    custom: ['found', roof.id],
    custom_other: ['not_found', null],
    together: ['not_found', null],
  });
  expect(rows[2]?.explanation).toBe(
    'Found "Roof repair", the newest of the contact\'s deals that pass (status open). The run has it in hand: its later deal steps act on it.',
  );
  expect(rows.at(-1)?.explanation).toBe(
    'None of the contact\'s deals passed (status open, a name containing "roof", a value less than 10), so the not_found branch was taken.',
  );
  // The last deal found stays in hand through the searches that found nothing after it.
  const values = await withTenant(h.db, s.tenant, (trx) => runValues(trx, s.contactId, run));
  expect(values).toMatchObject({
    'deal.name': 'Roof repair',
    'deal.status': 'open',
    'deal.pipeline': 'Sales',
    'deal.value': 5000,
    'deal.amount': 5000,
    'deal.currency': 'USD',
    'deal.custom.service': ['video'],
    'steps.custom.dealId': roof.id,
  });
  expect(typeof values['deal.stage']).toBe('string');
});

it('acts on the deal found where the contact has several open ones', async () => {
  const s = await scene();
  await s.deal('Garden fence', { amount: '100' });
  await s.deal('Roof repair', { amount: '5000' });
  await s.deal('Paint the fence', { amount: '700' });
  // With none in hand the step cannot tell which is meant, as it never could.
  const blind = await s.run(
    { move: { type: 'deal.move', config: { stage: s.stages[1] ?? '' } } },
    'move',
  );
  expect(await stepsOf(s.tenant, blind)).toMatchObject([
    { step_key: 'move', status: 'failed', error: { code: 'several_open_deals' } },
  ]);

  const t = await scene();
  await t.deal('Garden fence', { amount: '100' });
  await t.deal('Roof repair', { amount: '5000' });
  await t.deal('Paint the fence', { amount: '700' });
  const run = await t.run(
    {
      find: {
        type: 'deal.find',
        config: { nameContains: 'roof' },
        next: { found: 'move' },
      },
      move: { type: 'deal.move', config: { stage: t.stages[1] ?? '' }, next: 'again' },
      again: { type: 'deal.move', config: { stage: t.stages[1] ?? '' }, next: 'close' },
      close: { type: 'deal.close', config: { outcome: 'won' } },
    },
    'find',
  );
  expect((await h.run(t.tenant, run)).status).toBe('completed');
  expect((await stepsOf(t.tenant, run)).map((row) => row.explanation).slice(1)).toEqual([
    'The deal in hand ("Roof repair") was moved to the stage.',
    'The deal in hand ("Roof repair") was already in that stage.',
    'The deal in hand ("Roof repair") was closed as won.',
  ]);
  expect(await dealsOf(t.tenant)).toMatchObject([
    { name: 'Garden fence', status: 'open', stage_id: stageOf(t.stages[0]) },
    { name: 'Roof repair', status: 'won', stage_id: stageOf(t.stages[1]) },
    { name: 'Paint the fence', status: 'open', stage_id: stageOf(t.stages[0]) },
  ]);
});

it('takes the deal a step creates in hand, and the later of a find and a create wins', async () => {
  const s = await scene();
  await s.deal('Garden fence');
  const run = await s.run(
    {
      find: { type: 'deal.find', config: {}, next: { found: 'open' } },
      open: {
        type: 'deal.create',
        config: { pipeline: s.pipeline, stage: s.stages[0] ?? '', name: 'Renewal' },
        next: 'missing',
      },
      // Nothing is found: what the run had in hand stays in hand.
      missing: {
        type: 'deal.find',
        config: { nameContains: 'no such deal' },
        next: { not_found: 'close' },
      },
      close: { type: 'deal.close', config: { outcome: 'won' } },
    },
    'find',
  );
  expect((await h.run(s.tenant, run)).status).toBe('completed');
  expect(await dealsOf(s.tenant)).toMatchObject([
    { name: 'Garden fence', status: 'open' },
    { name: 'Renewal', status: 'won' },
  ]);
  expect((await stepsOf(s.tenant, run)).at(-1)?.explanation).toBe(
    'The deal in hand ("Renewal") was closed as won.',
  );
});

it('updates the deal in hand through the CRM, and only what the step names', async () => {
  const s = await scene();
  const service = await dealField(s.tenant, 'service');
  const owner = await h.database.fixtures.user();
  const membership = toPublicId('membership', owner.id);
  team.set(owner.id, membership);
  await s.deal('Garden fence', { amount: '100' });
  const roof = await s.deal('Roof repair', { amount: '5000', stage: 1 });
  await setDealField(s.tenant, roof.id, service, 'photo');
  const before = (await h.events(s.tenant, 'deal.updated')).length;
  const run = await s.run(
    {
      find: { type: 'deal.find', config: { nameContains: 'roof' }, next: { found: 'update' } },
      update: {
        type: 'deal.update',
        config: {
          name: 'Roof repair for {{contact.firstName}}',
          amount: 6250.5,
          owner: membership,
          expectedCloseDate: '2026-12-24',
          source: 'Workflow: {{deal.pipeline}}',
          fields: { 'deal.custom.service': 'video' },
        },
        next: 'same',
      },
      // The same again changes nothing, and says so without another deal.updated.
      same: {
        type: 'deal.update',
        config: { name: 'Roof repair for Ada', amount: 6250.5, source: 'Workflow: Sales' },
      },
    },
    'find',
  );
  const rows = await stepsOf(s.tenant, run);
  expect(rows.map((row) => [row.step_key, row.status, row.explanation])).toEqual([
    ['find', 'succeeded', expect.stringContaining('Found "Roof repair"')],
    ['update', 'succeeded', 'The deal in hand ("Roof repair") was updated.'],
    [
      'same',
      'succeeded',
      'The deal in hand ("Roof repair for Ada") was left as it was: nothing the step names differs.',
    ],
  ]);
  expect(rows[1]?.output).toEqual({ dealId: roof.id });
  expect(await dealsOf(s.tenant)).toEqual([
    {
      name: 'Garden fence',
      status: 'open',
      amount: '100.0000',
      stage_id: stageOf(s.stages[0]),
      source: null,
      due: null,
      owner_user_id: null,
    },
    {
      name: 'Roof repair for Ada',
      status: 'open',
      amount: '6250.5000',
      // The stage is not the step's to change, and stays.
      stage_id: stageOf(s.stages[1]),
      source: 'Workflow: Sales',
      due: '2026-12-24',
      owner_user_id: owner.id,
    },
  ]);
  expect((await h.events(s.tenant, 'deal.updated')).length - before).toBe(1);
  expect(await h.events(s.tenant, 'deal.owner_assigned')).toHaveLength(1);
  const values = await withTenant(h.db, s.tenant, (trx) => runValues(trx, s.contactId, run));
  expect(values['deal.custom.service']).toEqual(['video']);
  expect(values['deal.expectedCloseDate']).toBe('2026-12-24');
  expect(values['deal.source']).toBe('Workflow: Sales');
});

it('sets a close date from now, takes a value from a field, and reopens a closed deal', async () => {
  const s = await scene();
  await h.database.as('postgres', (sql) =>
    sql.query("update tenancy.businesses set timezone = 'Africa/Nairobi' where id = $1", [
      s.tenant.businessId,
    ]),
  );
  await h.database.withTenant(s.tenant, (sql) =>
    sql.query(
      `insert into crm.field_definitions (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, 'budget', 'Budget', 'What they can spend.', 'number', 'system'
       from crm.object_types where kind = 'contact'`,
    ),
  );
  await s.deal('Signed deal', { amount: '900', status: 'won' });
  await h.publish(s.tenant, {
    name: 'Reopen',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'find',
    steps: {
      find: { type: 'deal.find', config: { status: 'won' }, next: { found: 'reopen' } },
      reopen: {
        type: 'deal.update',
        config: {
          status: 'open',
          expectedCloseDate: { in: 'P30D' },
          // The contact has no budget: the value stays, and the step says so.
          amountFrom: 'contact.custom.budget',
        },
        next: 'again',
      },
      again: { type: 'deal.update', config: { status: 'open', amount: null } },
    },
  });
  await h.match(s.tenant, s.eventId);
  const [run] = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      s.contactId,
    ]),
  );
  if (run === undefined) throw new Error('Nothing enrolled.');
  // 22:30 UTC on 12 October is the 13th in Nairobi: thirty days on is 12 November there.
  for (let visit = 0; visit < 3; visit++)
    await rest(s.tenant, run.id, new Date('2026-10-12T22:30:00Z'));
  expect((await stepsOf(s.tenant, run.id)).map((row) => row.explanation).slice(1)).toEqual([
    'The deal in hand ("Signed deal") was updated. contact.custom.budget has nothing in it, so the deal\'s value was left as it was.',
    'The deal in hand ("Signed deal") was updated. The deal was already open.',
  ]);
  expect(await dealsOf(s.tenant)).toMatchObject([
    { name: 'Signed deal', status: 'open', amount: null, due: '2026-11-12' },
  ]);
  expect(await h.events(s.tenant, 'deal.reopened')).toHaveLength(1);
});

it('lets conditions and merge fields read the deal in hand, and nothing without one', async () => {
  const s = await scene();
  await s.deal('Roof repair', { amount: '5000', stage: 1 });
  const run = await s.run(
    {
      none_yet: {
        type: 'condition',
        config: { if: { field: 'deal.name', operator: 'is_empty' } },
        next: { yes: 'find' },
      },
      find: { type: 'deal.find', config: {}, next: { found: 'large' } },
      large: {
        type: 'condition',
        config: {
          if: {
            all: [
              { field: 'deal.value', operator: 'greater_than', value: 1000 },
              { field: 'deal.status', operator: 'equals', value: 'open' },
              { field: 'deal.pipeline', operator: 'equals', value: 'Sales' },
            ],
          },
        },
        next: { yes: 'note' },
      },
      note: {
        type: 'note.create',
        config: {
          text: '{{deal.name}} is {{deal.status}} in {{deal.pipeline}}, worth {{deal.value}}.',
        },
      },
    },
    'none_yet',
  );
  expect((await h.run(s.tenant, run)).status).toBe('completed');
  expect((await stepsOf(s.tenant, run)).map((row) => [row.step_key, row.branch])).toEqual([
    ['none_yet', 'yes'],
    ['find', 'found'],
    ['large', 'yes'],
    ['note', null],
  ]);
  const [note] = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ body: string }>('select body_text as body from crm.notes'),
  );
  expect(note?.body).toBe('Roof repair is open in Sales, worth 5000.');
});

it('fails a step whose deal in hand went to the trash, rather than act on another', async () => {
  const s = await scene();
  await s.deal('Garden fence');
  const roof = await s.deal('Roof repair');
  const run = await s.run(
    {
      find: { type: 'deal.find', config: { nameContains: 'roof' }, next: { found: 'pause' } },
      pause: { type: 'wait', config: { duration: 'PT1M' }, next: 'close' },
      close: { type: 'deal.close', config: { outcome: 'won' } },
    },
    'find',
  );
  expect((await h.run(s.tenant, run)).status).toBe('waiting');
  await h.database.as('postgres', (sql) =>
    sql.query('update crm.deals set deleted_at = now() where id = $1', [
      parsePublicId('deal', roof.id),
    ]),
  );
  await rest(s.tenant, run, new Date(Date.now() + 120_000));
  expect((await stepsOf(s.tenant, run)).at(-1)).toMatchObject({
    step_key: 'close',
    status: 'failed',
    error: { code: 'deal_unavailable' },
    explanation:
      'The deal.close step was refused: The deal this run has in hand ("Roof repair") is in the trash.',
  });
  expect(await dealsOf(s.tenant)).toMatchObject([
    { name: 'Garden fence', status: 'open' },
    { name: 'Roof repair', status: 'open' },
  ]);
});

it('acts on the deal a run is for, reads its values, and looks for no other', async () => {
  const s = await scene();
  const deal = await s.deal('Garden fence', { amount: '100' });
  await s.deal('Roof repair', { amount: '5000' });
  await h.publish(s.tenant, {
    name: 'Moved deal',
    triggers: [
      {
        id: 'moved',
        type: 'deal.stage_changed',
        config: {},
        // The trigger's own condition reads the deal that moved.
        if: { field: 'deal.name', operator: 'includes', value: 'fence' },
      },
    ],
    start: 'small',
    steps: {
      small: {
        type: 'condition',
        config: { if: { field: 'deal.value', operator: 'less_than', value: 1000 } },
        next: { yes: 'rename' },
      },
      rename: {
        type: 'deal.update',
        config: { name: '{{deal.name}} (small)', source: 'Moved' },
        next: 'find',
      },
      find: { type: 'deal.find', config: {} },
    },
  });
  await runCommand(
    h.services,
    updateDealCommand,
    {
      id: deal.id,
      revision: deal.revision,
      name: deal.name,
      pipelineId: deal.pipelineId,
      stageId: s.stages[1],
      amount: deal.amount,
      currency: deal.currency,
      expectedCloseDate: deal.expectedCloseDate,
      status: deal.status,
      outcomeReason: deal.outcomeReason,
    },
    all(s.tenant),
  );
  const [moved] = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ id: string }>(
      `select id from events.events where type = 'deal.stage_changed' order by recorded_at desc limit 1`,
    ),
  );
  await h.match(s.tenant, moved?.id ?? '');
  const [run] = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      parsePublicId('deal', deal.id),
    ]),
  );
  if (run === undefined) throw new Error('The deal was not enrolled.');
  await rest(s.tenant, run.id);
  expect(
    (await stepsOf(s.tenant, run.id)).map((row) => [row.step_key, row.status, row.branch]),
  ).toEqual([
    ['small', 'succeeded', 'yes'],
    ['rename', 'succeeded', null],
    ['find', 'failed', null],
  ]);
  expect((await stepsOf(s.tenant, run.id)).at(-1)?.error).toEqual({ code: 'unsupported_record' });
  expect(await dealsOf(s.tenant)).toMatchObject([
    { name: 'Garden fence (small)', source: 'Moved' },
    { name: 'Roof repair', source: null },
  ]);
});

it('finds nothing for a reference that names nothing, and compares a custom field by its kind', async () => {
  const s = await scene();
  await h.database.withTenant(s.tenant, (sql) =>
    sql.query(
      `insert into crm.field_definitions (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), type.id, made.key, made.key, 'A field of the test.', made.value_type, 'system'
       from crm.object_types type, (values ('guests', 'number'), ('deposit_paid', 'boolean')) as made(key, value_type)
       where type.kind = 'deal'`,
    ),
  );
  const fieldIds = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ id: string; key: string }>(
      `select id, key from crm.field_definitions where key in ('guests', 'deposit_paid')`,
    ),
  );
  const fence = await s.deal('Garden fence');
  const roof = await s.deal('Roof repair');
  for (const field of fieldIds) {
    const fieldId = toPublicId('field', field.id);
    const [deal, value] =
      field.key === 'guests' ? ([fence, '120'] as const) : ([roof, true] as const);
    const current = await withTenant(h.db, s.tenant, (trx) =>
      readRecordField(trx, all(s.tenant), deal.id, fieldId),
    );
    await runCommand(
      h.services,
      setRecordFieldCommand,
      { id: deal.id, fieldId, value, revision: current.revision },
      all(s.tenant),
    );
  }
  const run = await s.run(
    searches({
      // A name where an id belongs is what an unvalidated document could hold.
      by_name: { pipeline: 'Sales' },
      no_stage: { stage: 'New' },
      not_custom: { customField: { field: 'deal.name', equals: 'Garden fence' } },
      guests: { customField: { field: 'deal.custom.guests', equals: 120 } },
      paid: { customField: { field: 'deal.custom.deposit_paid', equals: true } },
      unpaid: { customField: { field: 'deal.custom.deposit_paid', equals: false } },
    }),
    'by_name',
  );
  expect(
    Object.fromEntries(
      (await stepsOf(s.tenant, run)).map((row) => [row.step_key, row.output['dealId'] ?? null]),
    ),
  ).toEqual({
    by_name: null,
    no_stage: null,
    not_custom: null,
    guests: fence.id,
    paid: roof.id,
    unpaid: null,
  });
});

it('refuses to move or close a deal in hand that is closed, and a field a deal does not have', async () => {
  const s = await scene();
  await s.deal('Signed deal', { status: 'won' });
  const closed = await s.run(
    {
      find: { type: 'deal.find', config: {}, next: { found: 'move' } },
      move: { type: 'deal.move', config: { stage: s.stages[1] ?? '' } },
    },
    'find',
  );
  expect((await stepsOf(s.tenant, closed)).at(-1)).toMatchObject({
    step_key: 'move',
    status: 'failed',
    error: { code: 'deal_not_open' },
  });

  const t = await scene();
  await t.deal('Garden fence', { amount: '100' });
  const run = await t.run(
    {
      find: { type: 'deal.find', config: {}, next: { found: 'clear' } },
      clear: {
        type: 'deal.update',
        config: { amount: null, expectedCloseDate: null, source: null, owner: null },
        next: 'unknown',
      },
      unknown: {
        type: 'deal.update',
        config: { name: 'Renamed first', fields: { 'deal.custom.no_such_field': 'x' } },
        onFailure: { goTo: 'far' },
      },
      far: { type: 'deal.update', config: { expectedCloseDate: { in: 'P400000Y' } } },
    },
    'find',
  );
  expect(
    (await stepsOf(t.tenant, run)).map((row) => [
      row.step_key,
      row.status,
      row.error?.code ?? null,
    ]),
  ).toEqual([
    ['find', 'succeeded', null],
    ['clear', 'succeeded', null],
    ['unknown', 'failed', 'unknown_field'],
    ['far', 'failed', 'invalid_date'],
  ]);
  // The step that was refused wrote none of what it named: the name is as it was.
  expect(await dealsOf(t.tenant)).toMatchObject([
    { name: 'Garden fence', amount: null, due: null, source: null, owner_user_id: null },
  ]);
});

it('tells a test run which deal each search would find now, and whose turn it would be', async () => {
  const s = await scene();
  await s.deal('Garden fence', { amount: '100' });
  const roof = await s.deal('Roof repair', { amount: '5000' });
  const published = await h.publish(s.tenant, {
    name: 'Tested',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'find',
    steps: {
      find: {
        type: 'deal.find',
        config: { nameContains: 'roof' },
        next: { found: 'big', not_found: 'none' },
      },
      big: {
        type: 'condition',
        config: { if: { field: 'deal.value', operator: 'greater_than', value: 1000 } },
        next: { yes: 'move' },
      },
      move: { type: 'deal.move', config: { stage: s.stages[1] ?? '' }, next: 'assign' },
      assign: { type: 'owner.assign', config: { users: ['mem_a', 'mem_b'] }, next: 'none' },
      none: { type: 'deal.find', config: { nameContains: 'no such deal' } },
    },
  });
  await h.database.withTenant(s.tenant, (sql) =>
    sql.query(
      `insert into automation.assignment_cursors (business_id, automation_id, step_key, next_position)
       values (app.business_id(), $1, 'assign', 1)`,
      [published.automationId],
    ),
  );
  const tested = await runCommand(
    h.services,
    testRunCommand,
    { id: published.id, contactId: s.contact },
    all(s.tenant),
  );
  expect(tested.status).toBe('passed');
  expect(tested.steps.map((step) => [step.step, step.branch ?? null])).toEqual([
    ['find', 'found'],
    ['big', 'yes'],
    ['move', null],
    ['assign', null],
    ['none', 'not_found'],
  ]);
  expect(tested.steps[0]).toMatchObject({ output: { dealId: roof.id } });
  expect(tested.steps[2]?.explanation).toBe(
    'Would move "Roof repair", the deal the run has in hand, to the stage. Nothing is changed in a test run.',
  );
  expect(tested.steps[3]).toMatchObject({ output: { membershipId: 'mem_b' } });
  // Nothing was moved, and no turn was used.
  expect(await dealsOf(s.tenant)).toMatchObject([
    { name: 'Garden fence', stage_id: stageOf(s.stages[0]) },
    { name: 'Roof repair', stage_id: stageOf(s.stages[0]) },
  ]);
  expect(
    await h.database.withTenant(s.tenant, (sql) =>
      sql.query('select next_position from automation.assignment_cursors'),
    ),
  ).toEqual([{ next_position: 1 }]);
  // A sample with no contact has no deals to look through.
  const sample = await runCommand(h.services, testRunCommand, { id: published.id }, all(s.tenant));
  expect(sample.steps.map((step) => [step.step, step.branch ?? null])).toEqual([
    ['find', 'not_found'],
    ['none', 'not_found'],
  ]);
});
