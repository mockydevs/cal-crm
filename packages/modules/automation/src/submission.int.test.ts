// What a form sent, in workflows, on real Postgres (AUTOMATIONS.md section 3): a run a
// form submission started reads that submission's answers (trigger.answers.<key>) and its
// page (trigger.pageUrl) in its trigger's condition, in an If / else and in text. The form
// and its submissions are stored as the forms module stores them, and the form.submitted
// event is emitted as the intake emits it; this module cannot import the forms module, so
// the intake itself is not part of this test (apps/server: lead-source-acceptance covers
// the road from the public route to a run).
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import { validateAutomation, type AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import type { TaskOptions } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { createRunStepCommand } from './runner.js';
import { runValues } from './run-values.js';
import { readAutomationSetup } from './setup.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const tasks: TaskOptions = {
  actorNames: {},
  assignees: {
    resolve: () => Promise.resolve(null),
    read: () => Promise.resolve({ items: [], nextCursor: null }),
    memberships: () => Promise.resolve(new Map<string, string>()),
  },
};
const runStep = createRunStepCommand({ tasks });

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});

const PAGE = 'https://www.example.test/open-day';

/** What the form asks, as its published definition holds it. */
const DEFINITION = {
  fields: [
    { key: 'email', type: 'email', label: 'Email' },
    { key: 'guests', type: 'number', label: 'How many guests?' },
    {
      key: 'plan',
      type: 'single_choice',
      label: 'Which plan?',
      options: [
        { key: 'gold', label: 'Gold' },
        { key: 'silver', label: 'Silver' },
      ],
    },
    { key: 'campaign', type: 'hidden', label: 'Campaign', parameter: 'utm_campaign' },
    { key: 'newsletter', type: 'checkbox', label: 'Send me news' },
    { key: 'intro', type: 'content', label: 'Intro', text: 'Welcome.' },
  ],
};

/** A published form of the business, stored as the forms module stores one. */
async function form(tenant: Tenant, name: string): Promise<string> {
  const [row] = await h.database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into forms.forms
         (business_id, name, definition, status, public_key, published_definition, published_at)
       values ($1, $2, $3::jsonb, 'published', $4, $3::jsonb, now()) returning id`,
      [tenant.businessId, name, JSON.stringify(DEFINITION), `pk_${randomUUID()}`],
    ),
  );
  if (row === undefined) throw new Error('No form.');
  return row.id;
}

// The submission's row and its event in one transaction, as the intake writes them.
const submitCommand = defineCommand({
  name: 'test.form_submitted_with_answers',
  permission: 'contacts.manage',
  input: z.strictObject({
    contactId: z.uuid(),
    formId: z.uuid(),
    pageUrl: z.string().nullable(),
    answers: z.array(
      z.strictObject({
        key: z.string(),
        label: z.string(),
        value: z.union([z.string(), z.boolean(), z.array(z.string())]).nullable(),
      }),
    ),
  }),
  async handle(trx, input, command) {
    const made = await trx
      .insertInto('forms.submissions')
      .values({
        business_id: command.context.businessId ?? '',
        form_id: input.formId,
        contact_id: input.contactId,
        data: JSON.stringify({ answers: input.answers, skipped: [], terms: [] }),
        client_submission_id: randomUUID(),
        request_digest: 'a'.repeat(64),
        origin: 'https://www.example.test',
        page_url: input.pageUrl,
        contact_outcome: 'updated',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return command.emit({
      type: 'form.submitted',
      subject: { kind: 'form_submission', id: made.id },
      payload: { formId: input.formId, submissionId: made.id, contactId: input.contactId },
      records: [input.contactId],
    });
  },
});

type Answer = string | boolean | string[] | null;

const submit = (
  tenant: Tenant,
  contactId: string,
  formId: string,
  answers: Readonly<Record<string, Answer>>,
  pageUrl: string | null = PAGE,
): Promise<string> =>
  runCommand(
    h.services,
    submitCommand,
    {
      contactId,
      formId,
      pageUrl,
      answers: Object.entries(answers).map(([key, value]) => ({ key, label: key, value })),
    },
    all(tenant),
  );

async function runsOf(tenant: Tenant, contactId: string): Promise<string[]> {
  const rows = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      'select id from automation.enrolments where record_id = $1 order by id',
      [contactId],
    ),
  );
  return rows.map((row) => row.id);
}

async function rest(tenant: Tenant, enrolmentId: string): Promise<void> {
  for (let visit = 0; visit < 20; visit++) {
    const run = await h.run(tenant, enrolmentId);
    if (run.status !== 'running') return;
    await runCommand(h.services, runStep, { enrolmentId, sequence: run.sequence }, all(tenant));
  }
  throw new Error('The run did not come to rest.');
}

const notesOf = (tenant: Tenant, contactId: string) =>
  h.database
    .withTenant(tenant, (sql) =>
      sql.query<{ body_text: string }>(
        'select body_text from crm.notes where record_id = $1 order by created_at, id',
        [contactId],
      ),
    )
    .then((rows) => rows.map((row) => row.body_text));

const setupOf = (tenant: Tenant) =>
  withTenant(h.db, tenant, (trx) =>
    readAutomationSetup(trx, tenant, () => Promise.resolve([]), {
      webhookDelivery: false,
      smsDelivery: false,
      teamNotifications: false,
    }),
  );

const routed = (formPublicId: string): AutomationDocumentInput => ({
  name: 'Gold enquiries',
  triggers: [
    {
      id: 'sent',
      type: 'form.submitted',
      config: { form: formPublicId },
      // Only the leads who chose the gold plan start it.
      if: { field: 'trigger.answers.plan', operator: 'equals', value: 'gold' },
    },
  ],
  start: 'by_size',
  steps: {
    by_size: {
      type: 'condition',
      config: {
        branches: [
          {
            name: 'big',
            if: {
              all: [
                { field: 'trigger.answers.guests', operator: 'greater_than', value: 50 },
                { field: 'trigger.pageUrl', operator: 'includes', value: '/open-day' },
              ],
            },
          },
        ],
      },
      next: { big: 'note_big', none: 'note_small' },
    },
    note_big: {
      type: 'note.create',
      config: {
        text: 'Big: {{trigger.answers.guests}} guests, campaign {{trigger.answers.campaign}}, from {{trigger.pageUrl}}',
      },
    },
    note_small: {
      type: 'note.create',
      config: {
        text: 'Small: {{trigger.answers.guests}} guests, news {{trigger.answers.newsletter}}',
      },
    },
  },
  settings: { reEnrollment: 'after_finished' },
});

it('lists what each published form asks, by the kind a workflow reads it as', async () => {
  const tenant = await h.business();
  const formId = await form(tenant, 'Open day');
  const setup = await setupOf(tenant);
  expect(setup.forms).toEqual([
    {
      id: toPublicId('form', formId),
      name: 'Open day',
      questions: [
        { key: 'email', label: 'Email', type: 'email', options: [] },
        { key: 'guests', label: 'How many guests?', type: 'number', options: [] },
        {
          key: 'plan',
          label: 'Which plan?',
          type: 'single_choice',
          options: [
            { key: 'gold', label: 'Gold' },
            { key: 'silver', label: 'Silver' },
          ],
        },
        // A hidden question's answer is text; a block of text asks nothing.
        { key: 'campaign', label: 'Campaign', type: 'text', options: [] },
        { key: 'newsletter', label: 'Send me news', type: 'boolean', options: [] },
      ],
      // A draft is listed too, and says so (setup.int.test.ts).
      status: 'published',
    },
  ]);
  // The document is checked against them: a question the form does not ask is refused.
  expect(validateAutomation(routed(toPublicId('form', formId)), setup).errors).toEqual([]);
  const wrong = routed(toPublicId('form', formId));
  const checked = validateAutomation(
    {
      ...wrong,
      triggers: [
        {
          id: 'sent',
          type: 'form.submitted',
          config: { form: 'Open day' },
          if: { field: 'trigger.answers.plans', operator: 'equals', value: 'gold' },
        },
      ],
    },
    setup,
  );
  expect(checked.errors.map((issue) => [issue.code, issue.suggestion])).toEqual([
    ['unknown_field', 'Did you mean trigger.answers.plan?'],
  ]);
});

it('starts, branches and writes by what the form sent, and keeps it for the life of the run', async () => {
  const tenant = await h.business();
  const formId = await form(tenant, 'Open day');
  const setup = await setupOf(tenant);
  const checked = validateAutomation(routed(toPublicId('form', formId)), setup);
  expect(checked.errors).toEqual([]);
  if (checked.document === undefined) throw new Error('The document did not validate.');
  await h.publish(tenant, checked.document);

  const grace = await h.contact(tenant, 'Grace');
  const linus = await h.contact(tenant, 'Linus');
  const edsger = await h.contact(tenant, 'Edsger');

  // Gold, a big party, from a campaign link: the hidden question read utm_campaign.
  const first = await h.match(
    tenant,
    await submit(tenant, grace.contactId, formId, {
      email: 'grace@example.test',
      guests: '120',
      plan: 'gold',
      campaign: 'spring',
      newsletter: true,
    }),
  );
  expect(first.enrolled).toBe(1);
  // Silver: the trigger's own condition on the answer keeps it out.
  const second = await h.match(
    tenant,
    await submit(tenant, linus.contactId, formId, { guests: '300', plan: 'silver' }),
  );
  expect(second.enrolled).toBe(0);
  // Gold and small, with an answer left empty and a tick not given.
  const third = await h.match(
    tenant,
    await submit(tenant, edsger.contactId, formId, {
      guests: '12',
      plan: 'gold',
      campaign: null,
      newsletter: false,
    }),
  );
  expect(third.enrolled).toBe(1);

  const [graceRun] = await runsOf(tenant, grace.contactId);
  if (graceRun === undefined) throw new Error('Nothing enrolled.');
  // What the run reads, before it has taken a step.
  const values = await withTenant(h.db, tenant, (trx) => runValues(trx, grace.contactId, graceRun));
  expect(values).toMatchObject({
    'trigger.pageUrl': PAGE,
    'trigger.answers.email': 'grace@example.test',
    // A number question's answer is kept as typed and compared as a number.
    'trigger.answers.guests': 120,
    'trigger.answers.plan': 'gold',
    'trigger.answers.campaign': 'spring',
    'trigger.answers.newsletter': true,
  });
  // Grace sends the form again before her run has moved: another submission, another run
  // would read its own; this run still reads the first.
  await submit(tenant, grace.contactId, formId, { guests: '2', plan: 'silver' }, `${PAGE}/again`);
  for (const contact of [grace, linus, edsger])
    for (const run of await runsOf(tenant, contact.contactId)) await rest(tenant, run);

  expect(await notesOf(tenant, grace.contactId)).toEqual([
    `Big: 120 guests, campaign spring, from ${PAGE}`,
  ]);
  expect(await notesOf(tenant, linus.contactId)).toEqual([]);
  expect(await notesOf(tenant, edsger.contactId)).toEqual(['Small: 12 guests, news false']);
});

it('reads every answer as empty in a run that no form submission started', async () => {
  const tenant = await h.business();
  const checked = validateAutomation(
    {
      name: 'New contacts',
      triggers: [{ id: 'made', type: 'contact.created', config: {} }],
      start: 'by_plan',
      steps: {
        by_plan: {
          type: 'condition',
          config: {
            if: {
              any: [
                { field: 'trigger.answers.plan', operator: 'is_set' },
                { field: 'trigger.pageUrl', operator: 'is_set' },
              ],
            },
          },
          next: { yes: 'noted', no: 'none' },
        },
        noted: { type: 'note.create', config: { text: 'Had a submission' } },
        none: { type: 'note.create', config: { text: 'No submission' } },
      },
    },
    await setupOf(tenant),
  );
  // Said while building it, and no error: the document is allowed.
  expect(checked.errors).toEqual([]);
  expect(checked.warnings.map((issue) => issue.code)).toEqual(['no_submission']);
  if (checked.document === undefined) throw new Error('The document did not validate.');
  await h.publish(tenant, checked.document);
  const ada = await h.enrol(tenant, 'Ada');
  for (const run of ada.enrolments) await rest(tenant, run);
  expect(await notesOf(tenant, ada.contactId)).toEqual(['No submission']);
});
