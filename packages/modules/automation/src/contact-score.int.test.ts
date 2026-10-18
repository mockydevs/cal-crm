// The Contact Engagement Score trigger and the Modify Contact Engagement Score action,
// through real runs on real Postgres:
// 1) A published rule scores a real event once (a redelivered event doesn't score twice);
// 2) The score.modify action changes the score once per visit;
// 3) The contact.score_changed trigger starts a run when the score passes and writes a
//    mismatch note when it doesn't.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import { toPublicId } from '@repo/kernel';
import { withTenant } from '@repo/db';
import {
  assignRecordTagCommand,
  createScoreRuleCommand,
  createTagCommand,
  modifyContactScoreCommand,
  publishScoreProfileCommand,
  readContactScore,
  scoreEventTask,
  setContactScoreCommand,
  type TaskOptions,
} from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { createRunStepCommand } from './runner.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const as = (tenant: Tenant, actorKind: 'user' | 'system' = 'user') => ({
  context: { ...tenant, actorKind, correlationId: randomUUID() },
  permissions: 'all' as const,
});

const tasks: TaskOptions = {
  actorNames: {},
  assignees: {
    resolve: () => Promise.resolve(null),
    read: () => Promise.resolve({ items: [], nextCursor: null }),
    memberships: () => Promise.resolve(new Map()),
  },
};

const runStep = createRunStepCommand({ tasks });

async function stepOnce(tenant: Tenant, enrolmentId: string): Promise<void> {
  const { sequence } = await h.run(tenant, enrolmentId);
  await runCommand(h.services, runStep, { enrolmentId, sequence }, as(tenant, 'system'));
}

/** The scoring jobs waiting in the queue for the business's events. */
const scoringJobs = async (tenant: Tenant): Promise<string[]> =>
  (
    await h.database.as('crm_owner', (sql) =>
      sql.query<{ key: string }>(
        `select j.key from graphile_worker.jobs j
         join events.events e on j.key = 'score-event:' || e.id::text
         where j.task_identifier = 'scoring.from_event' and e.business_id = $1
         order by j.key`,
        [tenant.businessId],
      ),
    )
  ).map((row) => row.key);

const scoreOf = (tenant: Tenant, contactId: string) =>
  withTenant(h.db, as(tenant).context, (trx) =>
    readContactScore(trx, as(tenant), toPublicId('contact', contactId)),
  );

it('queues a job for an event a published rule listens to, and scores it once however often it runs', async () => {
  const tenant = await h.business();
  const contact = await h.contact(tenant, 'Lena');
  const id = toPublicId('contact', contact.contactId);
  const hot = await runCommand(h.services, createTagCommand, { name: 'Hot' }, as(tenant));
  const cold = await runCommand(h.services, createTagCommand, { name: 'Cold' }, as(tenant));
  await runCommand(
    h.services,
    createScoreRuleCommand,
    {
      when: { action: 'contact_tag', change: 'added', tagId: hot.id },
      calculation: 'add',
      points: 25,
    },
    as(tenant),
  );

  // Before the draft is published, nothing listens: adding the tag queues no scoring.
  await runCommand(h.services, assignRecordTagCommand, { id, tagId: cold.id }, as(tenant));
  expect(await scoringJobs(tenant)).toEqual([]);

  await runCommand(h.services, publishScoreProfileCommand, { revision: 1 }, as(tenant));
  await runCommand(h.services, assignRecordTagCommand, { id, tagId: hot.id }, as(tenant));
  const [assigned] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `select e.id from events.events e
       where e.type = 'tag.assigned' order by e.recorded_at desc, e.id desc limit 1`,
    ),
  );
  if (assigned === undefined) throw new Error('The tag was not assigned.');
  // The event's own transaction queued one job for it, keyed by the event.
  expect(await scoringJobs(tenant)).toEqual([`score-event:${assigned.id}`]);

  // The job as the worker runs it, delivered twice.
  const job = {
    invocation: { ...as(tenant, 'system'), causationId: assigned.id },
    services: h.services,
  };
  await scoreEventTask.run({ eventId: assigned.id }, job);
  await scoreEventTask.run({ eventId: assigned.id }, job);

  const scored = await scoreOf(tenant, contact.contactId);
  expect(scored.score).toBe(25);
  expect(scored.changes).toEqual([expect.objectContaining({ change: 25, source: 'rule' })]);
  expect(await h.events(tenant, 'contact.score_changed')).toEqual([
    {
      type: 'contact.score_changed',
      subject_id: contact.contactId,
      payload: { score: 25, previous: null, change: 25, source: 'rule' },
    },
  ]);
});

it('changes the score once per visit when running score.modify', async () => {
  const tenant = await h.business();
  await h.publish(tenant, {
    name: 'Modify Score Step',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'add_score',
    steps: {
      add_score: {
        type: 'score.modify',
        config: { calculation: 'add', points: 15 },
        next: 'wait',
      },
      wait: { type: 'wait', config: { duration: 'P1D' } },
    },
  });

  const enrolled = await h.enrol(tenant, 'Maya');
  const [enrolmentId] = enrolled.enrolments;
  if (enrolmentId === undefined) throw new Error('Nothing enrolled.');

  const runBefore = await h.run(tenant, enrolmentId);
  expect(runBefore.current_step).toBe('add_score');

  await stepOnce(tenant, enrolmentId);
  const scoreAfterStep = await scoreOf(tenant, enrolled.contactId);
  expect(scoreAfterStep.score).toBe(15);
  expect(scoreAfterStep.changes).toEqual([
    expect.objectContaining({ change: 15, source: 'workflow' }),
  ]);

  const redeliver = await runCommand(
    h.services,
    modifyContactScoreCommand,
    {
      id: toPublicId('contact', enrolled.contactId),
      calculation: 'add',
      points: 15,
      key: `${enrolmentId}:add_score:${String(runBefore.sequence)}`,
    },
    as(tenant),
  );
  expect(redeliver.changed).toBe(false);
  expect(redeliver.score).toBe(15);

  const scoreAfterRedelivery = await scoreOf(tenant, enrolled.contactId);
  expect(scoreAfterRedelivery.score).toBe(15);
  expect(scoreAfterRedelivery.changes).toHaveLength(1);
});

it.each([
  { operator: 'equals', fails: 49, passes: 50 },
  { operator: 'not_equals', fails: 50, passes: 51 },
  { operator: 'gt', fails: 50, passes: 51 },
  { operator: 'gte', fails: 30, passes: 50 },
  { operator: 'lt', fails: 50, passes: 49 },
  { operator: 'lte', fails: 51, passes: 50 },
] as const)(
  'starts a run only when score passes $operator and records the mismatch otherwise',
  async ({ operator, fails, passes }) => {
    const tenant = await h.business();
    const published = await h.publish(tenant, {
      name: 'Score Threshold',
      triggers: [
        {
          id: 'score_threshold',
          type: 'contact.score_changed',
          config: { operator, score: 50 },
        },
      ],
      start: 'note',
      steps: { note: { type: 'note.create', config: { text: 'Score reached threshold.' } } },
    });

    const contact = await h.contact(tenant, 'Jordan');

    await runCommand(
      h.services,
      setContactScoreCommand,
      { id: toPublicId('contact', contact.contactId), score: fails },
      as(tenant),
    );

    const events = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ id: string; type: string }>(
        `select id, type from events.events where business_id = $1 and type = 'contact.score_changed' order by id desc`,
        [tenant.businessId],
      ),
    );
    expect(events).toHaveLength(1);
    const [failEvent] = events;
    if (failEvent === undefined) throw new Error('Missing event.');

    const matchFail = await h.match(tenant, failEvent.id);
    expect(matchFail.enrolled).toBe(0);

    const evaluations = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ reason: string; detail: Record<string, unknown> }>(
        `select reason, detail from automation.trigger_evaluations
       where business_id = $1 and automation_id = $2
       order by id desc`,
        [tenant.businessId, published.automationId],
      ),
    );
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.reason).toBe('filter_mismatch');
    expect(evaluations[0]?.detail).toMatchObject({
      filter: 'score',
      expected: `${operator} 50`,
      actual: fails,
    });

    await runCommand(
      h.services,
      setContactScoreCommand,
      { id: toPublicId('contact', contact.contactId), score: passes },
      as(tenant),
    );

    const [passEvent] = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ id: string; type: string }>(
        `select id, type from events.events where business_id = $1 and type = 'contact.score_changed' order by id desc limit 1`,
        [tenant.businessId],
      ),
    );
    if (passEvent === undefined) throw new Error('Missing event.');

    const matchPass = await h.match(tenant, passEvent.id);
    expect(matchPass.enrolled).toBe(1);

    const enrolledRuns = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ id: string }>(
        `select id from automation.enrolments where business_id = $1 and automation_id = $2`,
        [tenant.businessId, published.automationId],
      ),
    );
    expect(enrolledRuns).toHaveLength(1);
  },
);

it('scores Contact changed once for a step that changes a name and two fields', async () => {
  const tenant = await h.business();
  await h.database.withTenant(tenant, (sql) =>
    sql.query(
      `insert into crm.field_definitions (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), t.id, given.key, given.key, 'What the contact told us.', 'text', 'system'
       from crm.object_types t cross join (values ('city'), ('role')) as given (key)
       where t.kind = 'contact'`,
    ),
  );
  await runCommand(
    h.services,
    createScoreRuleCommand,
    { when: { action: 'contact_changed' }, calculation: 'add', points: 3 },
    as(tenant),
  );
  await runCommand(h.services, publishScoreProfileCommand, { revision: 1 }, as(tenant));
  await h.publish(tenant, {
    name: 'Fill In',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'set',
    steps: {
      set: {
        type: 'contact.update',
        config: {
          fields: {
            'contact.firstName': 'Grace',
            'contact.custom.city': 'Austin',
            'contact.custom.role': 'Owner',
          },
        },
        next: 'wait',
      },
      wait: { type: 'wait', config: { duration: 'P1D' } },
    },
  });
  const enrolled = await h.enrol(tenant, 'Maya');
  const [enrolmentId] = enrolled.enrolments;
  if (enrolmentId === undefined) throw new Error('Nothing enrolled.');
  await stepOnce(tenant, enrolmentId);

  const changed = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `select id from events.events
       where type in ('contact.updated', 'field.value_set') order by recorded_at, id`,
    ),
  );
  expect(changed).toHaveLength(3);
  for (const { id } of changed)
    await scoreEventTask.run(
      { eventId: id },
      { invocation: { ...as(tenant, 'system'), causationId: id }, services: h.services },
    );
  const scored = await scoreOf(tenant, enrolled.contactId);
  expect(scored.score).toBe(3);
  expect(scored.changes).toEqual([expect.objectContaining({ change: 3, source: 'rule' })]);
});
