// A change that comes while the record's run is going (reentry-mark.ts). Two and three
// quick changes of a choice field end with the helper text matching the last one, with no
// goal step; a workflow that takes a record once keeps today's behaviour; a change of the
// same request marks nothing; the job that starts the record again is safe to run twice.
// Real Postgres, the CRM's own commands, and the engine's own match, step and start-again
// commands.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ForbiddenError, parsePublicId, toPublicId } from '@repo/kernel';
import { createContactCommand, readRecordField, setRecordFieldCommand } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { queueReentry } from './reentry-mark.js';
import { startAgainCommand, startAgainTask } from './reentry.js';
import { startHarness, type Harness, type Tenant } from '../test/workflows.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});

const CHOICES = [
  { key: 'dj', label: 'DJ', description: '', archived: false },
  { key: 'photo_video', label: 'Photo/Video', description: '', archived: false },
  { key: 'dj_photo_video', label: 'DJ-Photo-Video', description: '', archived: false },
];
const WORDS: Record<string, string> = {
  dj: 'DJ',
  photo_video: 'photo and video',
  dj_photo_video: 'DJ, photo, and video',
};

/** Service Interest (a choice) and its plain-text helper, by public id. */
async function fields(tenant: Tenant): Promise<{ service: string; helper: string }> {
  const made: Record<string, string> = {};
  for (const [key, type, options] of [
    ['service_interest', 'single_choice', CHOICES],
    ['clean_service_interest', 'text', []],
  ] as const) {
    const { id } = await h.database.withTenant(tenant, (sql) =>
      sql.one<{ id: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, options, created_by_kind)
         select app.business_id(), id, $1::text, $1::text, 'A field of the test.', $2::text, $3::jsonb, 'system'
         from crm.object_types where kind = 'contact'
         returning id`,
        [key, type, JSON.stringify(options)],
      ),
    );
    made[key] = toPublicId('field', id);
  }
  return { service: made['service_interest'] ?? '', helper: made['clean_service_interest'] ?? '' };
}

const SOURCE = 'contact.custom.service_interest';
const HELPER = 'contact.custom.clean_service_interest';
const is = (key: string) => ({ field: SOURCE, operator: 'equals' as const, value: key });

/** A real-world mapping, with no goal step. */
const mapping = (reEnrollment: 'after_finished' | 'never'): AutomationDocumentInput => ({
  name: 'Clean service interest',
  triggers: [{ id: 'changed', type: 'field.changed', config: { field: SOURCE } }],
  start: 'which',
  steps: {
    which: {
      type: 'condition',
      config: {
        branches: [
          { name: 'dj', label: 'DJ', if: is('dj') },
          { name: 'photo_video', label: 'Photo/Video', if: is('photo_video') },
          { name: 'dj_photo_video', label: 'DJ-Photo-Video', if: is('dj_photo_video') },
        ],
      },
      next: { dj: 'set_dj', photo_video: 'set_pv', dj_photo_video: 'set_all', none: 'clear' },
    },
    set_dj: { type: 'contact.update', config: { fields: { [HELPER]: WORDS['dj'] ?? '' } } },
    set_pv: {
      type: 'contact.update',
      config: { fields: { [HELPER]: WORDS['photo_video'] ?? '' } },
    },
    set_all: {
      type: 'contact.update',
      config: { fields: { [HELPER]: WORDS['dj_photo_video'] ?? '' } },
    },
    clear: { type: 'contact.update', config: { fields: { [HELPER]: null } } },
  },
  settings: { reEnrollment, timezone: 'business' },
});

/** Sets the contact's value through the CRM's own command, as its own request; the event. */
async function setField(
  tenant: Tenant,
  contact: string,
  fieldId: string,
  value: string,
): Promise<string> {
  const current = await withTenant(h.db, tenant, (trx) =>
    readRecordField(trx, all(tenant), contact, fieldId),
  );
  await runCommand(
    h.services,
    setRecordFieldCommand,
    { id: contact, fieldId, value, revision: current.revision },
    all(tenant),
  );
  const [event] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `select id from events.events where type = 'field.value_set'
       order by recorded_at desc, id desc limit 1`,
    ),
  );
  if (event === undefined) throw new Error('No field.value_set event was recorded.');
  return event.id;
}

async function value(tenant: Tenant, contact: string, fieldId: string): Promise<unknown> {
  const read = await withTenant(h.db, tenant, (trx) =>
    readRecordField(trx, all(tenant), contact, fieldId),
  );
  return read.value;
}

/** The record's runs of the business, oldest first. */
async function runs(tenant: Tenant, contactId: string) {
  return h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; status: string; state: Record<string, unknown> }>(
      `select id, status, state from automation.enrolments where record_id = $1 order by id`,
      [contactId],
    ),
  );
}

/** Steps a run to its end, as the worker's step jobs do. */
async function finish(tenant: Tenant, enrolmentId: string): Promise<void> {
  for (let guard = 0; guard < 10; guard += 1) {
    if ((await h.step(tenant, enrolmentId)) === 'skipped') return;
  }
  throw new Error('The run did not end in ten steps.');
}

/** The start-again jobs queued for a run, as the worker would take them. */
async function startAgainJobs(enrolmentId: string): Promise<number> {
  const [row] = await h.database.as('crm_owner', (sql) =>
    sql.query<{ count: number }>(
      `select count(*)::int as count
       from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id = j.id
       where j.task_identifier = 'automations.start_again'
         and p.payload -> 'data' ->> 'enrolmentId' = $1`,
      [enrolmentId],
    ),
  );
  return row?.count ?? 0;
}

const startAgain = (tenant: Tenant, enrolmentId: string, correlationId: string) =>
  runCommand(h.services, startAgainCommand, { enrolmentId, correlationId }, all(tenant));

const evaluations = (tenant: Tenant, contactId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ reason: string; detail: Record<string, unknown> }>(
      `select reason, detail from automation.trigger_evaluations
       where record_id = $1 order by evaluated_at, id`,
      [contactId],
    ),
  );

it.each([
  ['two', ['dj', 'photo_video']],
  ['three', ['dj', 'photo_video', 'dj_photo_video']],
])(
  'with %s quick changes, the helper ends matching the last value, with no goal step',
  async (_count, values) => {
    const tenant = await h.business();
    const { service, helper } = await fields(tenant);
    await h.publish(tenant, mapping('after_finished'));
    const ada = await h.contact(tenant, 'Ada');
    const [first, ...later] = values;
    if (first === undefined) throw new Error('No value.');

    // The first change starts a run, which reads the value and takes its branch.
    expect(
      (await h.match(tenant, await setField(tenant, ada.contact, service, first))).enrolled,
    ).toBe(1);
    const [run] = await runs(tenant, ada.contactId);
    if (run === undefined) throw new Error('No run.');
    expect(await h.step(tenant, run.id)).toBe('ran');

    // The later changes come while it is going: none starts a run, and none is lost.
    for (const each of later)
      expect(
        (await h.match(tenant, await setField(tenant, ada.contact, service, each))).enrolled,
      ).toBe(0);
    const [marked] = await runs(tenant, ada.contactId);
    expect(marked?.state['reentry']).toMatchObject({ events: later.length, triggerId: 'changed' });
    expect(await evaluations(tenant, ada.contactId)).toEqual(
      later.map(() => ({ reason: 'already_enrolled', detail: { queued: true } })),
    );

    // The run ends on the value it read, and the job to start the record again is written.
    await finish(tenant, run.id);
    expect(await value(tenant, ada.contact, helper)).toBe(WORDS[first]);
    expect(await startAgainJobs(run.id)).toBe(1);

    // The job starts one run, which reads the newest value.
    const mark = (marked?.state['reentry'] ?? {}) as { correlationId: string };
    expect(await startAgain(tenant, run.id, mark.correlationId)).toMatchObject({
      outcome: 'started',
    });
    // Run twice, as a retried job is, it starts nothing more.
    expect(await startAgain(tenant, run.id, mark.correlationId)).toEqual({
      outcome: 'nothing_marked',
    });
    const after = await runs(tenant, ada.contactId);
    expect(after.map((each) => each.status)).toEqual(['completed', 'running']);
    const again = after[1];
    if (again === undefined) throw new Error('No second run.');
    expect(again.state['reentered']).toEqual({ after: run.id, events: later.length });
    await finish(tenant, again.id);
    expect(await value(tenant, ada.contact, helper)).toBe(WORDS[values.at(-1) ?? '']);
    // Nothing came during the second run, so nothing follows it.
    expect(await startAgainJobs(again.id)).toBe(0);
  },
);

it('keeps today’s behaviour for a workflow that takes a record once', async () => {
  const tenant = await h.business();
  const { service, helper } = await fields(tenant);
  await h.publish(tenant, mapping('never'));
  const ada = await h.contact(tenant, 'Ada');
  await h.match(tenant, await setField(tenant, ada.contact, service, 'dj'));
  const [run] = await runs(tenant, ada.contactId);
  if (run === undefined) throw new Error('No run.');
  await h.step(tenant, run.id);
  await h.match(tenant, await setField(tenant, ada.contact, service, 'photo_video'));
  expect((await runs(tenant, ada.contactId))[0]?.state['reentry']).toBeUndefined();
  expect(await evaluations(tenant, ada.contactId)).toEqual([
    { reason: 'already_enrolled', detail: {} },
  ]);
  await finish(tenant, run.id);
  expect(await value(tenant, ada.contact, helper)).toBe('DJ');
  expect(await startAgainJobs(run.id)).toBe(0);
});

it('starts nothing again when the workflow was paused before the run ended, and says why', async () => {
  const tenant = await h.business();
  const { service } = await fields(tenant);
  const published = await h.publish(tenant, mapping('after_finished'));
  const ada = await h.contact(tenant, 'Ada');
  await h.match(tenant, await setField(tenant, ada.contact, service, 'dj'));
  const [run] = await runs(tenant, ada.contactId);
  if (run === undefined) throw new Error('No run.');
  await h.match(tenant, await setField(tenant, ada.contact, service, 'photo_video'));
  await finish(tenant, run.id);
  await h.database.withTenant(tenant, (sql) =>
    sql.query(`update automation.automations set status = 'paused' where id = $1`, [
      published.automationId,
    ]),
  );
  const mark = ((await runs(tenant, ada.contactId))[0]?.state['reentry'] ?? {}) as {
    correlationId: string;
  };
  expect(await startAgain(tenant, run.id, mark.correlationId)).toEqual({ outcome: 'paused' });
  expect((await runs(tenant, ada.contactId)).length).toBe(1);
  expect((await evaluations(tenant, ada.contactId)).at(-1)).toEqual({
    reason: 'paused',
    detail: { after: toPublicId('automation_enrolment', run.id) },
  });
});

/** A record marked to start again once its run ends, the run ended, and the mark. */
async function markedAndEnded(tenant: Tenant, service: string) {
  const ada = await h.contact(tenant, 'Ada');
  await h.match(tenant, await setField(tenant, ada.contact, service, 'dj'));
  const [run] = await runs(tenant, ada.contactId);
  if (run === undefined) throw new Error('No run.');
  await h.match(tenant, await setField(tenant, ada.contact, service, 'photo_video'));
  await finish(tenant, run.id);
  const [ended] = await runs(tenant, ada.contactId);
  const mark = (ended?.state['reentry'] ?? {}) as { correlationId: string };
  return { ada, run, mark };
}

it('starts nothing again for a workflow deleted, or published again without that trigger', async () => {
  const tenant = await h.business();
  const { service } = await fields(tenant);
  const published = await h.publish(tenant, mapping('after_finished'));
  const first = await markedAndEnded(tenant, service);
  // Published again with another trigger: the event's trigger no longer starts anything.
  const changed = mapping('after_finished');
  await h.publish(
    tenant,
    {
      ...changed,
      triggers: [{ id: 'changed_again', type: 'field.changed', config: { field: SOURCE } }],
    },
    published.automationId,
  );
  // As the worker runs it: as the system, under the marked event's correlation.
  await startAgainTask.run(
    { enrolmentId: first.run.id, correlationId: first.mark.correlationId },
    {
      invocation: {
        context: { ...tenant, actorKind: 'system', correlationId: randomUUID() },
        permissions: 'all',
      },
      services: h.services,
    },
  );
  expect((await runs(tenant, first.ada.contactId)).map((each) => each.status)).toEqual([
    'completed',
  ]);
  expect((await runs(tenant, first.ada.contactId))[0]?.state['reentry']).toMatchObject({
    outcome: 'trigger_removed',
  });

  // Deleted before the run ended.
  const other = await h.business();
  const otherFields = await fields(other);
  const gone = await h.publish(other, mapping('after_finished'));
  const second = await markedAndEnded(other, otherFields.service);
  await h.database.withTenant(other, (sql) =>
    sql.query(
      `update automation.automations set status = 'archived', archived_at = now() where id = $1`,
      [gone.automationId],
    ),
  );
  expect(await startAgain(other, second.run.id, second.mark.correlationId)).toEqual({
    outcome: 'deleted',
  });
});

it('is the engine’s alone, and does nothing for a run still going or one never marked', async () => {
  const tenant = await h.business();
  const { service } = await fields(tenant);
  const published = await h.publish(tenant, mapping('after_finished'));
  const ada = await h.contact(tenant, 'Ada');
  await h.match(tenant, await setField(tenant, ada.contact, service, 'dj'));
  const [run] = await runs(tenant, ada.contactId);
  if (run === undefined) throw new Error('No run.');
  const correlationId = randomUUID();
  expect(await startAgain(tenant, run.id, correlationId)).toEqual({ outcome: 'still_running' });
  expect(await startAgain(tenant, randomUUID(), correlationId)).toEqual({
    outcome: 'nothing_marked',
  });
  await expect(
    runCommand(
      h.services,
      startAgainCommand,
      { enrolmentId: run.id, correlationId },
      { context: { ...tenant, actorKind: 'user', correlationId }, permissions: 'all' },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  // With no run going, there is nothing to mark: the match starts the record itself.
  await finish(tenant, run.id);
  expect(
    await withTenant(h.db, tenant, (trx) =>
      queueReentry(trx, {
        automationId: published.automationId,
        recordId: ada.contactId,
        event: { id: randomUUID(), type: 'field.value_set', recordedAt: new Date(), correlationId },
        triggerId: 'changed',
        state: {},
      }),
    ),
  ).toEqual({ outcome: 'ended' });
});

it('marks nothing for a change of the same request as the run, which it already reads', async () => {
  const tenant = await h.business();
  const { helper } = await fields(tenant);
  await h.publish(tenant, {
    ...mapping('after_finished'),
    triggers: [
      { id: 'created', type: 'contact.created', config: {} },
      { id: 'changed', type: 'field.changed', config: { field: SOURCE } },
    ],
  });
  // A contact created with its Service Interest: one request, two events.
  const created = await runCommand(
    h.services,
    createContactCommand,
    { firstName: 'Ada', fields: { service_interest: 'DJ' } },
    all(tenant),
  );
  const events = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; type: string }>(
      `select id, type from events.events order by recorded_at, id`,
    ),
  );
  const contactId = parsePublicId('contact', created.id) ?? '';
  for (const event of events) await h.match(tenant, event.id);
  const [run, ...more] = await runs(tenant, contactId);
  expect(more).toEqual([]);
  expect(run?.state['reentry']).toBeUndefined();
  await finish(tenant, run?.id ?? '');
  expect(await value(tenant, created.id, helper)).toBe('DJ');
  expect(await startAgainJobs(run?.id ?? '')).toBe(0);
  expect(await evaluations(tenant, contactId)).toEqual([
    { reason: 'already_enrolled', detail: {} },
  ]);
});
