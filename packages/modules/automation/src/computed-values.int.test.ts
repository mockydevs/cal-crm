// Computed and copied values in contact.update, through real runs on real Postgres and the
// CRM's own commands: one field copied into another, merge text fitted to the field's kind,
// now, a date moved by days, arithmetic, "only when empty", and a refusal that writes nothing.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { readRecordField, setRecordFieldCommand } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

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

const SERVICES = [
  { key: 'video', label: 'Video', description: '', archived: false },
  { key: 'photo', label: 'Photography', description: '', archived: false },
];

const FIELDS: readonly (readonly [key: string, type: string, options?: unknown])[] = [
  ['utm_source', 'text'],
  ['lead_source_raw', 'text'],
  ['budget', 'number'],
  ['visits', 'number'],
  ['event_date', 'date'],
  ['renewal', 'date'],
  ['first_enquiry', 'datetime'],
  ['service', 'single_choice', SERVICES],
  ['interests', 'multi_choice', SERVICES],
  ['newsletter', 'boolean'],
];

/** A business in Nairobi with the custom contact fields above, by key and public id. */
async function business(): Promise<{ tenant: Tenant; fields: Record<string, string> }> {
  const tenant = await h.business();
  await h.database.as('postgres', (sql) =>
    sql.query("update tenancy.businesses set timezone = 'Africa/Nairobi' where id = $1", [
      tenant.businessId,
    ]),
  );
  const fields: Record<string, string> = {};
  for (const [key, type, options] of FIELDS) {
    const { id } = await h.database.withTenant(tenant, (sql) =>
      sql.one<{ id: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, options, created_by_kind)
         select app.business_id(), id, $1::text, $1::text, 'A field of the test.', $2::text, $3::jsonb, 'system'
         from crm.object_types where kind = 'contact'
         returning id`,
        [key, type, JSON.stringify(options ?? [])],
      ),
    );
    fields[key] = toPublicId('field', id);
  }
  return { tenant, fields };
}

type Writes = Extract<
  AutomationDocumentInput['steps'][string],
  { type: 'contact.update' }
>['config']['fields'];

const updates = (fields: Writes, more: AutomationDocumentInput['steps'] = {}) =>
  ({
    name: 'Work out values',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'set',
    steps: { set: { type: 'contact.update', config: { fields } }, ...more },
  }) satisfies AutomationDocumentInput;

async function setField(
  tenant: Tenant,
  contact: string,
  fieldId: string | undefined,
  value: string | boolean | string[],
): Promise<void> {
  if (fieldId === undefined) throw new Error('No such field.');
  const current = await withTenant(h.db, tenant, (trx) =>
    readRecordField(trx, all(tenant), contact, fieldId),
  );
  await runCommand(
    h.services,
    setRecordFieldCommand,
    { id: contact, fieldId, value, revision: current.revision },
    all(tenant),
  );
}

/** The contact's custom values by key, each as text. */
async function held(tenant: Tenant, contactId: string): Promise<Record<string, string>> {
  const rows = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ key: string; value: string }>(
      `select field.key,
              coalesce(value.value_text, value.value_number::text, value.value_date::text,
                       to_char(value.value_datetime at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       value.value_bool::text, array_to_string(value.value_options, ',')) as value
       from crm.field_values value
       join crm.field_definitions field on field.id = value.field_id
       where value.record_id = $1`,
      [contactId],
    ),
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

const NOW = new Date('2026-10-12T22:30:00Z');

/**
 * A new contact given some values, enrolled by its own event and run for one step at NOW:
 * what its fields hold afterwards, and what the step said.
 */
async function ran(
  scene: { tenant: Tenant; fields: Record<string, string> },
  before: Record<string, string | boolean | string[]> = {},
) {
  const { tenant, fields } = scene;
  const made = await h.contact(tenant, 'Ada');
  for (const [key, value] of Object.entries(before))
    await setField(tenant, made.contact, fields[key], value);
  await h.match(tenant, made.eventId);
  const [run] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      made.contactId,
    ]),
  );
  if (run === undefined) throw new Error('Nothing enrolled.');
  await h.step(tenant, run.id, NOW);
  const [step] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ status: string; explanation: string; error: { code: string } | null }>(
      `select status, explanation, error from automation.step_runs
       where enrolment_id = $1 and step_key = 'set'`,
      [run.id],
    ),
  );
  const [contact] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ first_name: string | null }>('select first_name from crm.contacts where id = $1', [
      made.contactId,
    ]),
  );
  return {
    ...made,
    enrolmentId: run.id,
    step,
    firstName: contact?.first_name,
    values: await held(tenant, made.contactId),
  };
}

it('copies one field into another, keeping its kind, and a later condition reads the copy', async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates(
      {},
      {
        set: {
          type: 'contact.update',
          config: {
            fields: {
              'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}',
              'contact.custom.visits': '{{contact.custom.budget}}',
              'contact.custom.interests': '{{contact.custom.service}}',
            },
          },
          next: 'from_facebook',
        },
        from_facebook: {
          type: 'condition',
          config: {
            if: {
              field: 'contact.custom.lead_source_raw',
              operator: 'includes',
              value: 'facebook',
            },
          },
        },
      },
    ),
  );
  const copied = await ran(scene, {
    utm_source: 'facebook_ads',
    budget: '2500.50',
    service: 'video',
  });
  expect(copied.step).toMatchObject({
    status: 'succeeded',
    explanation: 'The contact fields were updated.',
  });
  expect(copied.values).toMatchObject({
    lead_source_raw: 'facebook_ads',
    // A number copied is the number, not its text: 2500.50 is kept as 2500.5.
    visits: '2500.5',
    interests: 'video',
  });
  await h.step(scene.tenant, copied.enrolmentId, NOW);
  const [judged] = await h.database.withTenant(scene.tenant, (sql) =>
    sql.query<{ branch: string }>(
      `select branch from automation.step_runs where enrolment_id = $1 and step_key = 'from_facebook'`,
      [copied.enrolmentId],
    ),
  );
  expect(judged).toEqual({ branch: 'yes' });
});

it('leaves a field as it was when the field copied from is empty, and says so', async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates({ 'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}' }),
  );
  const kept = await ran(scene, { lead_source_raw: 'referral' });
  expect(kept.step).toMatchObject({
    status: 'succeeded',
    explanation:
      'No field was changed. contact.custom.utm_source has nothing in it, so contact.custom.lead_source_raw was left as it was.',
  });
  expect(kept.values).toEqual({ lead_source_raw: 'referral' });
});

it('fills merge text in and fits it to the kind of field it is written to', async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates({
      'contact.custom.lead_source_raw':
        '{{contact.firstName}} came from {{contact.custom.utm_source}}',
      'contact.custom.budget': ' {{contact.custom.visits}}000 ',
      'contact.custom.service': '{{contact.custom.utm_source}}',
      'contact.custom.newsletter': '{{contact.custom.lead_source_raw}}',
      'contact.lastName': 'of {{contact.custom.utm_source}}',
    }),
  );
  const fitted = await ran(scene, {
    utm_source: 'Photography',
    visits: '3',
    lead_source_raw: 'yes',
  });
  expect(fitted.step?.status).toBe('succeeded');
  expect(fitted.values).toMatchObject({
    lead_source_raw: 'Ada came from Photography',
    budget: '3000',
    // A choice written by its label is kept by its key.
    service: 'photo',
    newsletter: 'true',
  });
  const [contact] = await h.database.withTenant(scene.tenant, (sql) =>
    sql.query<{ last_name: string }>('select last_name from crm.contacts where id = $1', [
      fitted.contactId,
    ]),
  );
  expect(contact).toEqual({ last_name: 'of Photography' });
});

it('refuses a value that does not fit its field, and writes none of the step', async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates({
      'contact.firstName': 'Grace',
      'contact.custom.lead_source_raw': 'written first',
      'contact.custom.budget': 'about {{contact.custom.utm_source}}',
    }),
  );
  const refused = await ran(scene, { utm_source: 'a lot' });
  expect(refused.step).toMatchObject({
    status: 'failed',
    error: { code: 'invalid_value' },
    explanation:
      'The contact.update step was refused: /config/fields/contact.custom.budget: contact.custom.budget takes a number, and the value came out as "about a lot".',
  });
  expect(refused.firstName).toBe('Ada');
  expect(refused.values).toEqual({ utm_source: 'a lot' });
  expect(await h.events(scene.tenant, 'contact.updated')).toEqual([]);

  // A choice that is not one of the field's, and text with a field that has no value.
  const choosy = await business();
  await h.publish(
    choosy.tenant,
    updates({ 'contact.custom.service': '{{contact.custom.utm_source}}' }),
  );
  expect((await ran(choosy, { utm_source: 'Catering' })).step).toMatchObject({
    status: 'failed',
    error: { code: 'invalid_value' },
  });
  const gap = await business();
  await h.publish(
    gap.tenant,
    updates({ 'contact.custom.lead_source_raw': 'From {{contact.custom.utm_source}}' }),
  );
  expect((await ran(gap)).step).toMatchObject({
    status: 'failed',
    error: { code: 'missing_values' },
  });
});

it("stamps now as today's date in the automation's zone, or as the instant", async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates({
      'contact.custom.event_date': { op: 'now' },
      'contact.custom.first_enquiry': { op: 'now' },
    }),
  );
  const stamped = await ran(scene);
  expect(stamped.step?.status).toBe('succeeded');
  // 22:30 UTC on the 12th is already the 13th in Nairobi.
  expect(stamped.values).toEqual({
    event_date: '2026-10-13',
    first_enquiry: '2026-10-12T22:30:00Z',
  });
});

it('moves a date by days: from a field, from a fixed date and from now', async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates({
      'contact.custom.renewal': { op: 'date_add', field: 'contact.custom.event_date', days: 365 },
      'contact.custom.event_date': { op: 'date_add', value: '2028-02-28', days: 2 },
      'contact.custom.first_enquiry': { op: 'date_add', days: -1 },
    }),
  );
  const moved = await ran(scene, { event_date: '2026-12-01' });
  expect(moved.step?.status).toBe('succeeded');
  expect(moved.values).toEqual({
    renewal: '2027-12-01',
    // 2028 is a leap year: the 28th and two days is the 1st of March.
    event_date: '2028-03-01',
    first_enquiry: '2026-10-11T22:30:00Z',
  });

  const empty = await business();
  await h.publish(
    empty.tenant,
    updates({
      'contact.custom.renewal': { op: 'date_add', field: 'contact.custom.event_date', days: 30 },
    }),
  );
  expect((await ran(empty)).step).toMatchObject({
    status: 'failed',
    error: { code: 'missing_values' },
    explanation:
      'The contact.update step was refused: /config/fields/contact.custom.renewal: contact.custom.event_date has no date in it, so there is nothing to count from.',
  });
});

it('does arithmetic on numbers and number fields, and fails cleanly on zero and on nothing', async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates({
      'contact.custom.visits': {
        op: 'math',
        left: 'contact.custom.visits',
        operator: '+',
        right: 1,
      },
      'contact.custom.budget': {
        op: 'math',
        left: 'contact.custom.budget',
        operator: '*',
        right: 1.16,
      },
    }),
  );
  const counted = await ran(scene, { visits: '4', budget: '1000' });
  expect(counted.step?.status).toBe('succeeded');
  expect(counted.values).toEqual({ visits: '5', budget: '1160' });

  const zero = await business();
  await h.publish(
    zero.tenant,
    updates({
      'contact.firstName': 'Grace',
      'contact.custom.budget': {
        op: 'math',
        left: 'contact.custom.budget',
        operator: '/',
        right: 'contact.custom.visits',
      },
    }),
  );
  const divided = await ran(zero, { visits: '0', budget: '1000' });
  expect(divided.step).toMatchObject({
    status: 'failed',
    error: { code: 'division_by_zero' },
    explanation:
      'The contact.update step was refused: /config/fields/contact.custom.budget: contact.custom.visits is 0, and nothing can be divided by zero.',
  });
  expect(divided.firstName).toBe('Ada');
  expect(divided.values).toEqual({ visits: '0', budget: '1000' });
  // No number to divide by at all.
  expect((await ran(zero, { budget: '1000' })).step).toMatchObject({
    status: 'failed',
    error: { code: 'missing_values' },
  });
});

it('writes a field only when it is empty, and says what it left alone', async () => {
  const scene = await business();
  await h.publish(
    scene.tenant,
    updates({
      'contact.custom.first_enquiry': { set: { op: 'now' }, onlyIfEmpty: true },
      'contact.custom.lead_source_raw': {
        set: '{{contact.custom.utm_source}}',
        onlyIfEmpty: true,
      },
      'contact.custom.visits': { set: 1, onlyIfEmpty: false },
    }),
  );
  const fresh = await ran(scene, { utm_source: 'google' });
  expect(fresh.step).toMatchObject({
    status: 'succeeded',
    explanation: 'The contact fields were updated.',
  });
  expect(fresh.values).toEqual({
    utm_source: 'google',
    first_enquiry: '2026-10-12T22:30:00Z',
    lead_source_raw: 'google',
    visits: '1',
  });

  const known = await ran(scene, {
    utm_source: 'google',
    lead_source_raw: 'referral',
    first_enquiry: '2026-01-05T08:00:00Z',
    visits: '7',
  });
  expect(known.step).toMatchObject({
    status: 'succeeded',
    explanation:
      'The contact fields were updated. contact.custom.first_enquiry already has a value, so it was left as it was. contact.custom.lead_source_raw already has a value, so it was left as it was.',
  });
  expect(known.values).toEqual({
    utm_source: 'google',
    lead_source_raw: 'referral',
    first_enquiry: '2026-01-05T08:00:00Z',
    visits: '1',
  });
});
