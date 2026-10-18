// Why an automation did not start, on
// real Postgres with the CRM's own events and the engine's own match command: each reason
// the match records, what it records for an event that did start a run (nothing), the two
// reads over the record, and the sweep that removes what is past its days.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  assignRecordTagCommand,
  createContactCommand,
  createTagCommand,
  removeRecordTagCommand,
} from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import {
  explainContact,
  expireTriggerEvaluations,
  readTriggerEvaluations,
} from './trigger-evaluations.js';

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

/** The newest event of a type the business has recorded. */
async function newest(tenant: Tenant, type: string): Promise<string> {
  const [event] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      'select id from events.events where type = $1 order by recorded_at desc, id desc limit 1',
      [type],
    ),
  );
  if (event === undefined) throw new Error(`No ${type} event was recorded.`);
  return event.id;
}

const tag = (tenant: Tenant, name: string) =>
  runCommand(h.services, createTagCommand, { name }, all(tenant));

/** Tags the contact, through the CRM's own command; gives the tag.assigned event's id. */
async function assign(tenant: Tenant, contact: string, tagId: string): Promise<string> {
  await runCommand(h.services, assignRecordTagCommand, { id: contact, tagId }, all(tenant));
  return newest(tenant, 'tag.assigned');
}
const unassign = (tenant: Tenant, contact: string, tagId: string) =>
  runCommand(h.services, removeRecordTagCommand, { id: contact, tagId }, all(tenant));

const listed = (
  tenant: Tenant,
  id: string,
  page: Partial<Parameters<typeof readTriggerEvaluations>[2]> = {},
) => withTenant(h.db, tenant, (trx) => readTriggerEvaluations(trx, id, { limit: 50, ...page }));

const explained = (tenant: Tenant, id: string, contact: string) =>
  withTenant(h.db, tenant, (trx) => explainContact(trx, id, contact));

const pause = { type: 'wait', config: { duration: 'PT1M' } } as const;

const onTag = (
  tagId: string,
  more: Partial<AutomationDocumentInput> = {},
): AutomationDocumentInput => ({
  name: 'VIP welcome',
  triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: tagId } }],
  start: 'pause',
  steps: { pause },
  ...more,
});

it('keeps why a filter refused an event, and nothing for an event that started a run', async () => {
  const tenant = await h.business();
  const [vip, other] = [await tag(tenant, 'VIP'), await tag(tenant, 'Other')];
  const automation = await h.publish(tenant, onTag(vip.id));
  const ada = await h.contact(tenant, 'Ada');
  expect(await explained(tenant, automation.id, ada.contact)).toMatchObject({
    state: 'nothing_on_record',
    runs: 0,
    run: null,
    ended: null,
    evaluations: [],
    evaluationsKeptDays: 30,
    summary:
      'No run of "VIP welcome" is on record for Ada, and no event it listens for was matched for this record in the last 30 days.',
  });

  const refused = await assign(tenant, ada.contact, other.id);
  expect(await h.match(tenant, refused)).toMatchObject({ enrolled: 0 });
  // A match job that runs twice for an event keeps its finding once.
  await h.match(tenant, refused);
  const { items, nextCursor } = await listed(tenant, automation.id);
  expect(nextCursor).toBeNull();
  expect(items).toHaveLength(1);
  expect(
    items.map(({ id, evaluatedAt, ...rest }) => [typeof id, typeof evaluatedAt, rest]),
  ).toEqual([
    [
      'string',
      'string',
      {
        eventId: refused,
        eventType: 'tag.assigned',
        trigger: { id: 'tagged', type: 'tag.added' },
        recordId: ada.contact,
        reason: 'filter_mismatch',
        detail: { filter: 'tag', expected: vip.id, actual: other.id },
        explanation: `The trigger's tag filter wanted ${vip.id}, and the event had ${other.id}.`,
      },
    ],
  ]);
  expect(await explained(tenant, automation.id, ada.contact)).toMatchObject({
    state: 'not_started',
    runs: 0,
    run: null,
    evaluations: [{ reason: 'filter_mismatch' }],
    summary: `No run of "VIP welcome" is on record for Ada. The most recent event that could have started it (tag.assigned, ${items[0]?.evaluatedAt ?? ''}) did not: The trigger's tag filter wanted ${vip.id}, and the event had ${other.id}.`,
  });

  // The tag it listens for starts a run, and a start leaves no evaluation, however often
  // its event is matched.
  const started = await assign(tenant, ada.contact, vip.id);
  expect(await h.match(tenant, started)).toMatchObject({ enrolled: 1 });
  expect(await h.match(tenant, started)).toMatchObject({ enrolled: 0 });
  expect((await listed(tenant, automation.id)).items).toHaveLength(1);
});

it('keeps the values a condition compared when it did not hold', async () => {
  const tenant = await h.business();
  const automation = await h.publish(tenant, {
    name: 'Named leads',
    triggers: [
      {
        id: 'created',
        type: 'contact.created',
        config: {},
        if: {
          all: [
            { field: 'contact.lastName', operator: 'is_set' },
            { field: 'contact.firstName', operator: 'equals', value: 'Grace' },
          ],
        },
      },
    ],
    start: 'pause',
    steps: { pause },
  });
  const ada = await h.contact(tenant, 'Ada');
  await h.match(tenant, ada.eventId);
  expect((await listed(tenant, automation.id)).items).toMatchObject([
    {
      eventType: 'contact.created',
      trigger: { id: 'created', type: 'contact.created' },
      recordId: ada.contact,
      reason: 'condition_false',
      detail: { values: { 'contact.lastName': null, 'contact.firstName': 'Ada' } },
      explanation:
        "The trigger's condition did not hold for the record: contact.lastName was nothing; contact.firstName was Ada.",
    },
  ]);
});

it('says the record was in the workflow already, or had been through it', async () => {
  const tenant = await h.business();
  const vip = await tag(tenant, 'VIP');
  const automation = await h.publish(tenant, onTag(vip.id));
  const ada = await h.contact(tenant, 'Ada');
  await h.match(tenant, await assign(tenant, ada.contact, vip.id));
  const [run] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      ada.contactId,
    ]),
  );
  if (run === undefined) throw new Error('Nothing enrolled.');
  await h.step(tenant, run.id);
  const waiting = await explained(tenant, automation.id, ada.contact);
  expect(waiting).toMatchObject({
    state: 'has_run',
    runs: 1,
    run: { status: 'waiting', currentAction: { step: 'pause', type: 'wait' } },
    ended: null,
    evaluations: [],
  });
  expect(waiting.summary).toMatch(
    /^Ada has a run of "VIP welcome" that is waiting at the step "pause"\. It started .+ and waits until .+\.$/,
  );

  // The tag comes off and on again while the run waits.
  await unassign(tenant, ada.contact, vip.id);
  await h.match(tenant, await assign(tenant, ada.contact, vip.id));
  expect((await listed(tenant, automation.id)).items).toMatchObject([
    {
      reason: 'already_enrolled',
      detail: {},
      explanation: 'The record was already in this workflow, and is in it once at a time.',
    },
  ]);

  // The run ends; the workflow takes a record once.
  await h.step(tenant, run.id, new Date(Date.now() + 120_000));
  expect((await h.run(tenant, run.id)).status).toBe('completed');
  await unassign(tenant, ada.contact, vip.id);
  await h.match(tenant, await assign(tenant, ada.contact, vip.id));
  const after = await explained(tenant, automation.id, ada.contact);
  expect(after.evaluations.map((each) => each.reason)).toEqual([
    'reentry_not_allowed',
    'already_enrolled',
  ]);
  expect(after).toMatchObject({
    state: 'has_run',
    runs: 1,
    run: { status: 'completed', currentAction: null },
    ended: 'It completed: it reached the end of its path.',
  });
  expect(after.summary).toMatch(
    /^Ada's latest run of "VIP welcome" started .+ and ended .+\. It completed: it reached the end of its path\. Since that run began, the most recent event that did not start another \(tag\.assigned, .+\): The record has been through this workflow before, and it takes a record once \(re-entry is off\)\.$/,
  );
});

it('says a paused workflow was paused, and an imported contact was imported', async () => {
  const tenant = await h.business();
  const vip = await tag(tenant, 'VIP');
  const automation = await h.publish(tenant, onTag(vip.id));
  await h.database.as('postgres', (sql) =>
    sql.query(`update automation.automations set status = 'paused' where id = $1`, [
      automation.automationId,
    ]),
  );
  const ada = await h.contact(tenant, 'Ada');
  expect(await h.match(tenant, await assign(tenant, ada.contact, vip.id))).toMatchObject({
    enrolled: 0,
  });
  const paused = await explained(tenant, automation.id, ada.contact);
  expect(paused).toMatchObject({
    automationStatus: 'paused',
    state: 'not_started',
    evaluations: [
      { reason: 'paused', explanation: 'The workflow was paused, so it started for nobody.' },
    ],
  });
  expect(paused.summary).toContain(
    'did not: The workflow was paused, so it started for nobody. The workflow is paused now: a paused workflow starts for nobody.',
  );

  // A contact a file brought in starts nothing by having been created.
  const importing = await h.business();
  const welcome = await h.publish(importing, {
    name: 'Welcome',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'pause',
    steps: { pause },
  });
  const created = await runCommand(
    h.services,
    createContactCommand,
    { firstName: 'Imported', emails: [`${randomUUID()}@example.test`] },
    {
      context: {
        ...importing,
        actorKind: 'import',
        actorId: randomUUID(),
        correlationId: randomUUID(),
      },
      permissions: 'all',
    },
  );
  expect(await h.match(importing, await newest(importing, 'contact.created'))).toMatchObject({
    enrolled: 0,
  });
  expect((await listed(importing, welcome.id, { contactId: created.id })).items).toMatchObject([
    {
      reason: 'stopped_by_rule',
      detail: { rule: 'imported_contact' },
      explanation:
        'The contact was made by an import, and an imported contact starts no workflow by having been created.',
    },
  ]);
});

it('says an event about no record had nobody to start for, and a loop was refused', async () => {
  const tenant = await h.business();
  const vip = await tag(tenant, 'VIP');
  const automation = await h.publish(tenant, onTag(vip.id));
  // An event of the type the trigger listens for, on nobody's timeline.
  const orphan = defineCommand({
    name: 'test.orphan_tag',
    permission: 'automations.manage',
    input: z.strictObject({}),
    async handle(_trx, _input, command) {
      await command.emit({
        type: 'tag.assigned',
        subject: { kind: 'tag', id: randomUUID() },
        records: [],
        payload: { tagId: vip.id },
      });
    },
  });
  await runCommand(h.services, orphan, {}, all(tenant));
  await h.match(tenant, await newest(tenant, 'tag.assigned'));
  expect((await listed(tenant, automation.id)).items).toMatchObject([
    {
      recordId: null,
      reason: 'contact_missing',
      explanation: 'The event was about no record, so there was nobody to start for.',
    },
  ]);

  // Two workflows whose runs' endings start one another: the second ending is refused.
  const looping = await h.business();
  const note = (text: string) => ({ type: 'note.create', config: { text } }) as const;
  const first = await h.publish(looping, {
    name: 'First',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'say',
    steps: { say: note('First') },
  });
  const second = await h.publish(looping, {
    name: 'Second',
    triggers: [
      { id: 'after_first', type: 'automation.run_ended', config: { automations: [first.id] } },
    ],
    start: 'say',
    steps: { say: note('Second') },
  });
  // Published straight to the engine: the validator would refuse this loop before it ran.
  await h.publish(
    looping,
    {
      name: 'First',
      settings: { reEnrollment: 'after_finished' },
      triggers: [
        { id: 'created', type: 'contact.created', config: {} },
        { id: 'after_second', type: 'automation.run_ended', config: { automations: [second.id] } },
      ],
      start: 'say',
      steps: { say: note('First') },
    },
    first.automationId,
  );
  const ada = await h.enrol(looping, 'Ada');
  await h.step(looping, ada.enrolments[0] ?? '');
  await h.match(looping, await newest(looping, 'automation.run.completed'));
  const [child] = await h.database.withTenant(looping, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where automation_id = $1', [
      second.automationId,
    ]),
  );
  await h.step(looping, child?.id ?? '');
  expect(await h.match(looping, await newest(looping, 'automation.run.completed'))).toMatchObject({
    enrolled: 0,
  });
  expect((await listed(looping, first.id)).items).toMatchObject([
    {
      eventType: 'automation.run.completed',
      trigger: { id: 'after_second', type: 'automation.run_ended' },
      recordId: ada.contact,
      reason: 'refused_loop',
    },
    // Its own run's ending, before that: an ending of another workflow than the one named.
    {
      trigger: { id: 'after_second' },
      reason: 'filter_mismatch',
      detail: { filter: 'automations', expected: [second.id], actual: first.id },
    },
  ]);
});

it('keeps a finding for each trigger that refused, and none once another trigger started the record', async () => {
  const tenant = await h.business();
  const [vip, gold, other] = [
    await tag(tenant, 'VIP'),
    await tag(tenant, 'Gold'),
    await tag(tenant, 'Other'),
  ];
  const automation = await h.publish(tenant, {
    name: 'Either tag',
    triggers: [
      { id: 'vip', type: 'tag.added', config: { tag: vip.id } },
      { id: 'gold', type: 'tag.added', config: { tag: gold.id } },
    ],
    start: 'pause',
    steps: { pause },
  });
  const ada = await h.contact(tenant, 'Ada');
  // Neither trigger wants this tag: each says so.
  await h.match(tenant, await assign(tenant, ada.contact, other.id));
  expect(
    (await listed(tenant, automation.id)).items
      .map((each) => [each.trigger?.id, each.reason])
      .sort(),
  ).toEqual([
    ['gold', 'filter_mismatch'],
    ['vip', 'filter_mismatch'],
  ]);
  // One of them wants this one: the record starts, and the other has nothing to explain.
  expect(await h.match(tenant, await assign(tenant, ada.contact, gold.id))).toMatchObject({
    enrolled: 1,
  });
  expect((await listed(tenant, automation.id)).items).toHaveLength(2);
});

it('lists by record and by time, a page at a time, inside the business only', async () => {
  const tenant = await h.business();
  const [vip, other] = [await tag(tenant, 'VIP'), await tag(tenant, 'Other')];
  const automation = await h.publish(tenant, onTag(vip.id));
  const [ada, omar] = [await h.contact(tenant, 'Ada'), await h.contact(tenant, 'Omar')];
  for (const contact of [ada, omar, ada]) {
    await h.match(tenant, await assign(tenant, contact.contact, other.id));
    await unassign(tenant, contact.contact, other.id);
  }
  const everything = (await listed(tenant, automation.id)).items;
  expect(everything.map((each) => each.recordId)).toEqual([ada.contact, omar.contact, ada.contact]);
  expect(
    (await listed(tenant, automation.id, { contactId: omar.contact })).items.map((each) => each.id),
  ).toEqual([everything[1]?.id]);
  // Newest first, two at a time, continued after the last of a page.
  const page = await listed(tenant, automation.id, { limit: 2 });
  expect(page.items.map((each) => each.id)).toEqual([everything[0]?.id, everything[1]?.id]);
  expect(page.nextCursor).toBe(everything[1]?.id);
  const rest = await listed(tenant, automation.id, { limit: 2, after: page.nextCursor ?? '' });
  expect(rest).toMatchObject({ items: [{ id: everything[2]?.id }], nextCursor: null });
  // From and to bound when the evaluation was made.
  const middle = everything[1]?.evaluatedAt ?? '';
  expect(
    (await listed(tenant, automation.id, { from: middle })).items.map((each) => each.id),
  ).toEqual([everything[0]?.id, everything[1]?.id]);
  expect(
    (await listed(tenant, automation.id, { to: middle })).items.map((each) => each.id),
  ).toEqual([everything[2]?.id]);
  await expect(listed(tenant, automation.id, { after: randomUUID() })).rejects.toMatchObject({
    name: 'ValidationError',
    issues: [{ code: 'invalid_cursor' }],
  });

  // Another business sees neither the automation nor what was kept about it.
  const elsewhere = await h.business();
  await expect(listed(elsewhere, automation.id)).rejects.toMatchObject({ name: 'NotFoundError' });
  await expect(explained(elsewhere, automation.id, ada.contact)).rejects.toMatchObject({
    name: 'NotFoundError',
  });
  const theirs = await h.publish(elsewhere, onTag((await tag(elsewhere, 'VIP')).id));
  await expect(explained(elsewhere, theirs.id, ada.contact)).rejects.toMatchObject({
    name: 'NotFoundError',
  });
  expect((await listed(elsewhere, theirs.id, { contactId: ada.contact })).items).toEqual([]);
  expect(
    await h.database.withTenant(elsewhere, (sql) =>
      sql.query('select 1 from automation.trigger_evaluations'),
    ),
  ).toEqual([]);
});

it('says why a failed run failed, and removes what is past its thirty days', async () => {
  const tenant = await h.business();
  const automation = await h.publish(tenant, {
    name: 'Rename',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'rename',
    steps: {
      rename: { type: 'contact.update', config: { fields: { 'contact.email': 'not an address' } } },
    },
  });
  const ada = await h.enrol(tenant, 'Ada');
  await h.step(tenant, ada.enrolments[0] ?? '');
  const failed = await explained(tenant, automation.id, ada.contact);
  expect(failed).toMatchObject({ state: 'has_run', run: { status: 'failed' } });
  expect(failed.ended).toMatch(/^It failed at the step "rename" \(.+\)\.$/);

  // Two evaluations of long ago and one of today: the sweep takes the two.
  const other = await h.publish(tenant, {
    name: 'Never',
    triggers: [
      {
        id: 'created',
        type: 'contact.created',
        config: {},
        if: { field: 'contact.lastName', operator: 'is_set' },
      },
    ],
    start: 'pause',
    steps: { pause },
  });
  const omar = await h.contact(tenant, 'Omar');
  await h.match(tenant, omar.eventId);
  await h.database.as('postgres', (sql) =>
    sql.query(
      `insert into automation.trigger_evaluations
         (business_id, automation_id, trigger_id, record_id, event_id, event_type, reason, evaluated_at)
       select business_id, automation_id, trigger_id, record_id, uuidv7(), event_type, reason,
              now() - make_interval(days => days)
       from automation.trigger_evaluations, (values (31), (400)) as old(days)
       where automation_id = $1`,
      [other.automationId],
    ),
  );
  expect((await listed(tenant, other.id)).items).toHaveLength(3);
  expect(await expireTriggerEvaluations(h.services, 1)).toBe(2);
  expect((await listed(tenant, other.id)).items).toMatchObject([{ recordId: omar.contact }]);
  expect(await expireTriggerEvaluations(h.services)).toBe(0);
});
