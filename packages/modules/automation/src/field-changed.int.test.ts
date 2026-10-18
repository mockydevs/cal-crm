// field.changed, heard as what the CRM really emits (found on the running app, 2026-10-12:
// the trigger listened for an event type nothing emits). A custom field's change is
// field.value_set or field.value_cleared, which name the field by id and carry no value; a
// change to one of the contact's own fields is contact.updated. Real Postgres, the CRM's own
// commands, and the engine's own match and step commands.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { readRecordField, setRecordFieldCommand, updateContactCommand } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';

const MIGRATION = fileURLToPath(
  new URL('../../../db/migrations/0076_field_changed_events.sql', import.meta.url),
);

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

/** A custom contact field of the business, as the CRM stores one, by its public id. */
async function field(tenant: Tenant, key: string, type: 'number' | 'text'): Promise<string> {
  const { id } = await h.database.withTenant(tenant, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, options, created_by_kind)
       select app.business_id(), id, $1::text, $1::text, 'A field of the test.', $2::text, '[]'::jsonb, 'system'
       from crm.object_types where kind = 'contact'
       returning id`,
      [key, type],
    ),
  );
  return toPublicId('field', id);
}

/** The newest event of a kind the business has recorded. */
async function newest(tenant: Tenant, like: string): Promise<string> {
  const [event] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `select id from events.events where type like $1 order by recorded_at desc, id desc limit 1`,
      [like],
    ),
  );
  if (event === undefined) throw new Error(`No ${like} event was recorded.`);
  return event.id;
}

/** Sets or clears the contact's value through the CRM's own command; gives the event's id. */
async function setField(
  tenant: Tenant,
  contact: string,
  fieldId: string,
  value: string | null,
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
  return newest(tenant, 'field.value_%');
}

/** Changes the contact through the CRM's own command; gives the contact.updated event's id. */
async function updateContact(
  tenant: Tenant,
  contact: string,
  changes: { source?: string; dateOfBirth?: string },
): Promise<string> {
  await runCommand(h.services, updateContactCommand, { id: contact, ...changes }, all(tenant));
  return newest(tenant, 'contact.updated');
}

const whenChanged = (config: {
  field: string;
  to?: string | number | boolean;
}): AutomationDocumentInput => ({
  name: 'When the field changes',
  triggers: [{ id: 'changed', type: 'field.changed', config }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
});

const nothing = { enrolled: 0, exited: 0, woken: 0, moved: 0 };

it('starts a run when the field the trigger names is set or cleared, and for no other field', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  const venue = await field(tenant, 'venue', 'text');
  await h.publish(tenant, whenChanged({ field: 'contact.custom.budget' }));

  const ada = await h.contact(tenant, 'Ada');
  expect(await h.match(tenant, await setField(tenant, ada.contact, venue, 'The Old Mill'))).toEqual(
    nothing,
  );
  const set = await setField(tenant, ada.contact, budget, '5000');
  // What the CRM stored: the field by id and no value, as events can't be erased.
  expect((await h.events(tenant, 'field.value_set')).at(-1)).toMatchObject({
    type: 'field.value_set',
    subject_id: ada.contactId,
    payload: { recordId: ada.contact, fieldId: budget },
  });
  expect(await h.match(tenant, set)).toEqual({ ...nothing, enrolled: 1 });
  // The job run again, as a retry runs it, starts nothing more.
  expect(await h.match(tenant, set)).toEqual(nothing);

  // Emptying the field is a change too.
  const grace = await h.contact(tenant, 'Grace');
  await setField(tenant, grace.contact, budget, '12');
  const cleared = await setField(tenant, grace.contact, budget, null);
  expect((await h.events(tenant, 'field.value_cleared')).at(-1)?.subject_id).toBe(grace.contactId);
  expect(await h.match(tenant, cleared)).toEqual({ ...nothing, enrolled: 1 });
});

it('with a value to change to, starts only for that value, as the event that wrote it left it', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  await h.publish(tenant, whenChanged({ field: 'contact.custom.budget', to: 5000 }));

  const ada = await h.contact(tenant, 'Ada');
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, '100'))).toEqual(
    nothing,
  );
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, '5000'))).toEqual({
    ...nothing,
    enrolled: 1,
  });

  // Set to the value and then to another before either event is matched: what the first
  // event set is no longer known, and the second set something else. Neither starts a run.
  const grace = await h.contact(tenant, 'Grace');
  const first = await setField(tenant, grace.contact, budget, '5000');
  const second = await setField(tenant, grace.contact, budget, '7000');
  expect(await h.match(tenant, first)).toEqual(nothing);
  expect(await h.match(tenant, second)).toEqual(nothing);
});

it('takes empty text as changed to nothing: only clearing the field starts a run', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  await h.publish(tenant, whenChanged({ field: 'contact.custom.budget', to: '' }));
  const ada = await h.contact(tenant, 'Ada');
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, '5'))).toEqual(nothing);
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, null))).toEqual({
    ...nothing,
    enrolled: 1,
  });
});

it('hears the field by a key a merged field left behind', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  await h.database.as('crm_owner', (sql) =>
    sql.query(
      `insert into crm.field_key_aliases (business_id, object_type_id, field_id, alias_key)
       select business_id, object_type_id, id, 'old_budget' from crm.field_definitions
       where business_id = $1 and key = 'budget'`,
      [tenant.businessId],
    ),
  );
  await h.publish(tenant, whenChanged({ field: 'contact.custom.old_budget' }));
  const ada = await h.contact(tenant, 'Ada');
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, '5000'))).toEqual({
    ...nothing,
    enrolled: 1,
  });
});

it('starts on a change to a field of the contact itself, and not on one no document names', async () => {
  const tenant = await h.business();
  await h.publish(tenant, whenChanged({ field: 'contact.source', to: 'Website' }));
  const ada = await h.contact(tenant, 'Ada');
  expect(
    await h.match(tenant, await updateContact(tenant, ada.contact, { source: 'Referral' })),
  ).toEqual(nothing);
  const website = await updateContact(tenant, ada.contact, { source: 'Website' });
  expect((await h.events(tenant, 'contact.updated')).at(-1)?.payload).toEqual({
    changed: ['source'],
  });
  expect(await h.match(tenant, website)).toEqual({ ...nothing, enrolled: 1 });

  // A date of birth is not a field a document can name: its change starts nothing.
  const grace = await h.contact(tenant, 'Grace');
  expect(
    await h.match(
      tenant,
      await updateContact(tenant, grace.contact, { dateOfBirth: '1990-04-23' }),
    ),
  ).toEqual(nothing);
});

it('ends a run through a stop condition on a field change', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  await h.publish(tenant, {
    name: 'Until a field changes',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    stopWhen: [{ event: 'field.changed' }],
    start: 'pause',
    steps: { pause: { type: 'wait', config: { duration: 'P7D' } } },
  });
  const ada = await h.enrol(tenant, 'Ada');
  const [run = ''] = ada.enrolments;
  await h.step(tenant, run);
  // A change no document can name is not a field change, and stops nothing.
  expect(
    await h.match(tenant, await updateContact(tenant, ada.contact, { dateOfBirth: '1990-04-23' })),
  ).toEqual(nothing);
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, '5000'))).toEqual({
    ...nothing,
    exited: 1,
  });
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:field.changed',
  });
});

it('wakes a run that waits for a field change', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  await h.publish(tenant, {
    name: 'Wait for a change',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'await_change',
    steps: {
      await_change: {
        type: 'wait.event',
        config: { event: 'field.changed', timeout: 'P3D' },
        next: { received: 'got_it', timed_out: 'gave_up' },
      },
      got_it: { type: 'wait', config: { duration: 'PT1M' } },
      gave_up: { type: 'wait', config: { duration: 'PT1M' } },
    },
  });
  const ada = await h.enrol(tenant, 'Ada');
  const [run = ''] = ada.enrolments;
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting' });
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, '5000'))).toEqual({
    ...nothing,
    woken: 1,
  });
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ current_step: 'got_it' });
});

it('moves a run to its goal when the field of the goal changes, and not for another field', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  const venue = await field(tenant, 'venue', 'text');
  await h.publish(tenant, {
    name: 'Until the budget is known',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'pause',
    steps: {
      pause: { type: 'wait', config: { duration: 'P7D' }, next: 'known' },
      known: {
        type: 'goal',
        config: {
          events: [{ type: 'field.changed', config: { field: 'contact.custom.budget' } }],
          otherwise: 'wait',
        },
        next: 'thanks',
      },
      thanks: { type: 'wait', config: { duration: 'PT1M' } },
    },
  });
  const ada = await h.enrol(tenant, 'Ada');
  const [run = ''] = ada.enrolments;
  await h.step(tenant, run);
  expect(await h.match(tenant, await setField(tenant, ada.contact, venue, 'The Old Mill'))).toEqual(
    nothing,
  );
  expect(await h.match(tenant, await setField(tenant, ada.contact, budget, '5000'))).toEqual({
    ...nothing,
    moved: 1,
  });
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'known' });
});

// Migration 0076 over a database that already has a published field.changed trigger and a
// live run with a stop on one, stored as they were before: one row for an event type
// nothing emits. The migration file itself is run, exactly as it ships.
it('turns listeners stored for the event nothing emitted into listeners for the real ones', async () => {
  const tenant = await h.business();
  const budget = await field(tenant, 'budget', 'number');
  const started = await h.publish(tenant, {
    ...whenChanged({ field: 'contact.custom.budget' }),
    stopWhen: [{ event: 'field.changed' }],
  });
  await h.publish(tenant, {
    name: 'Until a field changes',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    stopWhen: [{ event: 'field.changed' }],
    start: 'pause',
    steps: { pause: { type: 'wait', config: { duration: 'P7D' } } },
  });
  const ada = await h.enrol(tenant, 'Ada');
  const [run = ''] = ada.enrolments;
  await h.step(tenant, run);

  const listeners = () =>
    h.database.as('crm_owner', (sql) =>
      Promise.all([
        sql.query<{ event_type: string; conditions: unknown; created_at: Date }>(
          `select event_type, conditions, created_at from automation.trigger_subscriptions
           where automation_id = $1 order by event_type`,
          [started.automationId],
        ),
        sql.query<{ event_type: string; kind: string; conditions: unknown; created_at: Date }>(
          `select event_type, kind, conditions, created_at from automation.event_waits
           where enrolment_id = $1 order by event_type`,
          [run],
        ),
      ]),
    );
  const [subscribed, waiting] = await listeners();
  // Back to how each was stored before: a single row for 'field.changed'.
  await h.database.as('postgres', async (sql) => {
    for (const table of ['automation.trigger_subscriptions', 'automation.event_waits']) {
      await sql.query(
        `delete from ${table} where business_id = $1
           and event_type in ('field.value_cleared', 'contact.updated')`,
        [tenant.businessId],
      );
      await sql.query(
        `update ${table} set event_type = 'field.changed'
         where business_id = $1 and event_type = 'field.value_set'`,
        [tenant.businessId],
      );
    }
  });
  // As it was on the running app: the change is recorded and nothing hears it.
  const unheard = await h.contact(tenant, 'Grace');
  const unheardEvent = await setField(tenant, unheard.contact, budget, '1');
  expect(
    await h.database.as('crm_owner', (sql) =>
      sql.query(
        `select 1 from graphile_worker.jobs
         where key = 'automation-match:' || $1::text`,
        [unheardEvent],
      ),
    ),
  ).toEqual([]);

  await h.database.as('postgres', async (sql) => {
    await sql.query(await readFile(MIGRATION, 'utf8'));
  });
  // Each row became three, and kept what it says and when it was made.
  expect(await listeners()).toEqual([subscribed, waiting]);
  expect(subscribed.map((row) => row.event_type)).toEqual([
    'contact.updated',
    'field.value_cleared',
    'field.value_set',
  ]);
  expect(waiting.map((row) => [row.event_type, row.kind])).toEqual([
    ['contact.updated', 'stop'],
    ['field.value_cleared', 'stop'],
    ['field.value_set', 'stop'],
  ]);
  // Run again it changes nothing: no row is left for it to turn.
  await h.database.as('postgres', async (sql) => {
    await sql.query(await readFile(MIGRATION, 'utf8'));
  });
  expect(await listeners()).toEqual([subscribed, waiting]);

  // And they are heard: the change ends Ada's run, and starts the trigger's own.
  const changed = await setField(tenant, ada.contact, budget, '5000');
  expect(await h.match(tenant, changed)).toEqual({ ...nothing, exited: 1, enrolled: 1 });
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:field.changed',
  });
});
