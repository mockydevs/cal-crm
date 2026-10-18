// Attribution in workflows, on real Postgres. The touches are written by the CRM's own
// recordTouch from real page addresses read by its own readVisit, exactly as the form
// intake writes them (packages/modules/forms/src/public.ts), and the form.submitted event
// is emitted as the intake emits it. This module cannot import the forms module, so the
// HTTP side of the intake is not part of this test. Runs are matched and stepped by the
// engine's own commands.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import {
  leadSourceRecipe,
  leadSourceRecipeTags,
  validateAutomation,
  type AutomationDocumentInput,
  type AutomationSetup,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import {
  createTagCommand,
  readVisit,
  recordTouch,
  seedBusinessDefaults,
  type TaskOptions,
} from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { contactAttributionValues } from './attribution-values.js';
import { createRunStepCommand } from './runner.js';
import { runValues } from './run-values.js';
import { testRunCommand } from './test-runs.js';
import { explainContact } from './trigger-evaluations.js';
import { contactValues } from './values.js';

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

const PAGE = 'https://www.example.test/offer';
const GOOGLE_AD = `${PAGE}?utm_source=google&utm_medium=cpc&utm_campaign=Spring+sale&campaign_id=111&ad_group_id=222&ad_id=333&gclid=TESTCLICK-G`;
const FACEBOOK_AD = `${PAGE}?utm_source=facebook&utm_medium=paid_social&utm_campaign=Reels&campaign_id=444&fbclid=TESTCLICK-F`;

interface Scene {
  readonly tenant: Tenant;
  readonly pipeline: string;
  readonly stage: string;
  readonly tags: Readonly<Record<string, string>>;
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
  const [stage] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; pipeline_id: string }>(
      'select id, pipeline_id from crm.pipeline_stages order by position limit 1',
    ),
  );
  if (stage === undefined) throw new Error('The seed made no pipeline.');
  const tags: Record<string, string> = {};
  for (const name of leadSourceRecipeTags())
    tags[name] = (await runCommand(h.services, createTagCommand, { name }, all(tenant))).id;
  return {
    tenant,
    pipeline: toPublicId('pipeline', stage.pipeline_id),
    stage: toPublicId('stage', stage.id),
    tags,
  };
}

// One command stands in for the intake's own: the touch and the event in one transaction.
const submitCommand = defineCommand({
  name: 'test.form_submitted',
  permission: 'contacts.manage',
  input: z.strictObject({
    contactId: z.uuid(),
    pageUrl: z.string().optional(),
    referrer: z.string().optional(),
    formId: z.uuid(),
    touch: z.boolean(),
  }),
  async handle(trx, input, command) {
    const made = await trx
      .selectNoFrom((eb) => eb.fn<string>('uuidv7').as('id'))
      .executeTakeFirstOrThrow();
    if (input.touch)
      await recordTouch(trx, command.context.businessId ?? '', {
        contactId: input.contactId,
        medium: 'form',
        visit: readVisit({ pageUrl: input.pageUrl, referrer: input.referrer }),
        subject: { kind: 'form_submission', id: made.id },
      });
    return command.emit({
      type: 'form.submitted',
      subject: { kind: 'form_submission', id: made.id },
      payload: { formId: input.formId, submissionId: made.id, contactId: input.contactId },
      records: [input.contactId],
    });
  },
});

const FORM = '0192f3a0-1111-7222-8333-444455556666';

/** A submission of the form from a page address, for a contact; gives the event's id. */
const submit = (
  tenant: Tenant,
  contactId: string,
  pageUrl: string | undefined,
  more: { referrer?: string; touch?: boolean } = {},
): Promise<string> =>
  runCommand(
    h.services,
    submitCommand,
    {
      contactId,
      formId: FORM,
      touch: more.touch ?? true,
      ...(pageUrl === undefined ? {} : { pageUrl }),
      ...(more.referrer === undefined ? {} : { referrer: more.referrer }),
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
  throw new Error('The run did not come to rest.');
}

const tagsOf = (tenant: Tenant, contactId: string) =>
  h.database
    .withTenant(tenant, (sql) =>
      sql.query<{ name: string }>(
        `select tag.name from crm.record_tags assigned join crm.tags tag on tag.id = assigned.tag_id
         where assigned.record_id = $1 order by tag.name`,
        [contactId],
      ),
    )
    .then((rows) => rows.map((row) => row.name));

const dealsOf = (tenant: Tenant, contactId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ name: string; source: string | null }>(
      `select deal.name, deal.source from crm.deals deal
       join crm.record_links link on link.from_record_id = deal.id and link.to_record_id = $1
       order by deal.created_at, deal.id`,
      [contactId],
    ),
  );

const setupOf = (at: Scene): AutomationSetup => ({
  fields: { contact: [], deal: [] },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [{ id: at.pipeline, name: 'Sales', stages: [{ id: at.stage, name: 'New' }] }],
  lostReasons: [],
  tags: Object.entries(at.tags).map(([name, id]) => ({ id, name })),
  users: [],
  automations: [],
  values: [],
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
});

/** The recipe as the API would publish it: validated against the business, then published. */
async function publishRecipe(at: Scene): Promise<string> {
  const checked = validateAutomation(
    leadSourceRecipe({ pipeline: at.pipeline, stage: at.stage }),
    setupOf(at),
  );
  expect(checked.errors).toEqual([]);
  if (checked.document === undefined) throw new Error('The recipe did not validate.');
  return (await h.publish(at.tenant, checked.document)).id;
}

it('reads a contact with one touch, with two, and one whose touch says nothing', async () => {
  const at = await scene();
  const ada = await h.contact(at.tenant, 'Ada');
  const read = () =>
    withTenant(h.db, at.tenant, (trx) => contactAttributionValues(trx, ada.contactId));
  // The touch a contact is made with: how it came to be, and nothing of a visit.
  const made = await read();
  expect(made['contact.attribution.first.medium']).toBe(made['contact.attribution.latest.medium']);
  expect(made['contact.attribution.first.source']).toBeNull();
  expect(made['contact.attribution.first.utmSource']).toBeNull();
  expect(made['contact.attribution.first.hasGoogleClickId']).toBe(false);
  expect(typeof made['contact.attribution.first.touchedAt']).toBe('string');

  await submit(at.tenant, ada.contactId, GOOGLE_AD, { referrer: 'https://www.google.com/' });
  const once = await read();
  expect(once).toMatchObject({
    'contact.attribution.latest.source': 'Google Ads',
    'contact.attribution.latest.sourceKey': 'google_ads',
    'contact.attribution.latest.sessionSource': 'paid_search',
    'contact.attribution.latest.medium': 'form',
    'contact.attribution.latest.utmSource': 'google',
    'contact.attribution.latest.utmMedium': 'cpc',
    'contact.attribution.latest.utmCampaign': 'Spring sale',
    'contact.attribution.latest.campaignId': '111',
    'contact.attribution.latest.adGroupId': '222',
    'contact.attribution.latest.adId': '333',
    'contact.attribution.latest.referrerDomain': 'www.google.com',
    'contact.attribution.latest.landingPage': PAGE,
    'contact.attribution.latest.hasGoogleClickId': true,
    'contact.attribution.latest.hasMetaClickId': false,
  });
  // The first touch is still the one the contact was made with.
  expect(once['contact.attribution.first.source']).toBeNull();

  await submit(at.tenant, ada.contactId, FACEBOOK_AD);
  const twice = await read();
  expect(twice['contact.attribution.latest.source']).toBe('Facebook Ads');
  expect(twice['contact.attribution.latest.sessionSource']).toBe('paid_social');
  expect(twice['contact.attribution.latest.hasMetaClickId']).toBe(true);
  expect(twice['contact.attribution.latest.hasGoogleClickId']).toBe(false);
  expect(twice['contact.attribution.first.source']).toBeNull();
  // No value of a click id is anywhere in what a workflow reads.
  const everything = JSON.stringify(
    await withTenant(h.db, at.tenant, (trx) => contactValues(trx, ada.contactId)),
  );
  expect(everything).not.toContain('TESTCLICK');
});

it('sends two leads of one form down their own branches, each with its tag and source', async () => {
  const at = await scene();
  await publishRecipe(at);
  const fromGoogle = await h.contact(at.tenant, 'Grace');
  const fromFacebook = await h.contact(at.tenant, 'Linus');
  const direct = await h.contact(at.tenant, 'Edsger');
  for (const [lead, page] of [
    [fromGoogle, GOOGLE_AD],
    [fromFacebook, FACEBOOK_AD],
    [direct, PAGE],
  ] as const) {
    const eventId = await submit(at.tenant, lead.contactId, page);
    expect((await h.match(at.tenant, eventId)).enrolled).toBe(1);
    for (const run of await runsOf(at.tenant, lead.contactId)) await rest(at.tenant, run);
  }
  expect(await tagsOf(at.tenant, fromGoogle.contactId)).toEqual(['Source: Google Ads']);
  expect(await tagsOf(at.tenant, fromFacebook.contactId)).toEqual(['Source: Facebook Ads']);
  // Everything else gets no tag from the workflow: a direct lead is tagged "Source: Direct"
  // by its form, and never "Source: Other".
  expect(await tagsOf(at.tenant, direct.contactId)).toEqual([]);
  expect((await dealsOf(at.tenant, fromGoogle.contactId)).map((deal) => deal.source)).toEqual([
    'Google Ads',
  ]);
  expect((await dealsOf(at.tenant, fromFacebook.contactId)).map((deal) => deal.source)).toEqual([
    'Facebook Ads',
  ]);
  expect((await dealsOf(at.tenant, direct.contactId)).map((deal) => deal.source)).toEqual([
    'Direct',
  ]);
  const steps = await h.database.withTenant(at.tenant, (sql) =>
    sql.query<{ record_id: string; step_key: string; branch: string | null }>(
      `select run.record_id, step.step_key, step.branch from automation.step_runs step
       join automation.enrolments run on run.id = step.enrolment_id
       where step.step_key = 'by_source' or step.step_key like 'tag_%'
       order by step.started_at, step.id`,
    ),
  );
  expect(
    [fromGoogle, fromFacebook, direct].map((lead) =>
      steps
        .filter((row) => row.record_id === lead.contactId)
        .map((row) =>
          row.step_key === 'by_source' ? `branch ${String(row.branch)}` : row.step_key,
        ),
    ),
  ).toEqual([
    ['branch google_ads', 'tag_google_ads'],
    ['branch facebook_ads', 'tag_facebook_ads'],
    ['branch none'],
  ]);
});

it("keeps a waiting run's arrival when the contact's latest attribution moves", async () => {
  const at = await scene();
  const source = 'trigger.attribution.source';
  const steps: AutomationDocumentInput['steps'] = {
    hold: { type: 'wait', config: { duration: 'P1D' }, next: 'by_source' },
    by_source: {
      type: 'condition',
      config: {
        branches: [
          { name: 'google', if: { field: source, operator: 'equals', value: 'Google Ads' } },
          { name: 'facebook', if: { field: source, operator: 'equals', value: 'Facebook Ads' } },
        ],
      },
      next: { google: 'open', facebook: 'other_way', none: 'other_way' },
    },
    other_way: { type: 'tag.add', config: { tag: at.tags['Source: Organic Search'] ?? '' } },
    open: {
      type: 'deal.create',
      typeVersion: 2,
      config: {
        pipeline: at.pipeline,
        stage: at.stage,
        name: '{{trigger.attribution.source}} lead',
      },
    },
  };
  await h.publish(at.tenant, {
    name: 'Waits, then routes',
    triggers: [{ id: 'sent', type: 'form.submitted', config: {} }],
    start: 'hold',
    steps,
  });
  const ada = await h.contact(at.tenant, 'Ada');
  await h.match(at.tenant, await submit(at.tenant, ada.contactId, GOOGLE_AD));
  const [run] = await runsOf(at.tenant, ada.contactId);
  if (run === undefined) throw new Error('Nothing enrolled.');
  await rest(at.tenant, run);
  expect((await h.run(at.tenant, run)).status).toBe('waiting');

  // She comes back from a Facebook ad while the run waits: a new touch, and the latest.
  const second = await submit(at.tenant, ada.contactId, FACEBOOK_AD);
  expect((await h.match(at.tenant, second)).enrolled).toBe(0);
  const values = await withTenant(h.db, at.tenant, (trx) => runValues(trx, ada.contactId, run));
  expect(values['contact.attribution.latest.source']).toBe('Facebook Ads');
  expect(values[source]).toBe('Google Ads');
  expect(values['trigger.attribution.utmCampaign']).toBe('Spring sale');
  expect(values['trigger.attribution.hasGoogleClickId']).toBe(true);
  expect(typeof values['trigger.submissionId']).toBe('string');

  await rest(at.tenant, run, new Date(Date.now() + 2 * 86_400_000));
  expect((await h.run(at.tenant, run)).status).toBe('completed');
  expect(await dealsOf(at.tenant, ada.contactId)).toEqual([
    { name: 'Google Ads lead', source: 'Google Ads' },
  ]);
  // It took the Google branch, though the contact's latest touch says Facebook by now.
  const taken = await h.database.withTenant(at.tenant, (sql) =>
    sql.query<{ step_key: string }>(
      'select step_key from automation.step_runs where enrolment_id = $1 order by started_at, id',
      [run],
    ),
  );
  expect(taken.map((step) => step.step_key)).toEqual(['hold', 'by_source', 'open']);
  expect(await tagsOf(at.tenant, ada.contactId)).toEqual([]);
});

it('enrols only the leads a trigger lists, and says why another did not start', async () => {
  const at = await scene();
  const published = await h.publish(at.tenant, {
    name: 'Google leads only',
    triggers: [
      {
        id: 'sent',
        type: 'form.submitted',
        config: { sources: ['Google Ads'], sessionSources: ['paid_search'] },
      },
    ],
    start: 'open',
    steps: {
      open: {
        type: 'deal.create',
        typeVersion: 2,
        config: { pipeline: at.pipeline, stage: at.stage },
      },
    },
  });
  const grace = await h.contact(at.tenant, 'Grace');
  const linus = await h.contact(at.tenant, 'Linus');
  const edsger = await h.contact(at.tenant, 'Edsger');
  expect(
    (await h.match(at.tenant, await submit(at.tenant, grace.contactId, GOOGLE_AD))).enrolled,
  ).toBe(1);
  expect(
    (await h.match(at.tenant, await submit(at.tenant, linus.contactId, FACEBOOK_AD))).enrolled,
  ).toBe(0);
  // An event that recorded no touch at all passes no filter by arrival.
  expect(
    (
      await h.match(
        at.tenant,
        await submit(at.tenant, edsger.contactId, undefined, { touch: false }),
      )
    ).enrolled,
  ).toBe(0);
  for (const run of await runsOf(at.tenant, grace.contactId)) await rest(at.tenant, run);
  expect((await dealsOf(at.tenant, grace.contactId)).map((deal) => deal.source)).toEqual([
    'Google Ads',
  ]);
  expect(await dealsOf(at.tenant, linus.contactId)).toEqual([]);

  const why = await withTenant(h.db, at.tenant, (trx) =>
    explainContact(trx, published.id, linus.contact),
  );
  expect(why.state).toBe('not_started');
  expect(why.evaluations[0]).toMatchObject({
    reason: 'filter_mismatch',
    detail: { filter: 'sources', expected: ['Google Ads'], actual: 'Facebook Ads' },
    explanation:
      "The trigger starts only for a lead source of Google Ads, and this lead's source was Facebook Ads.",
  });
  expect(why.summary).toContain("this lead's source was Facebook Ads");
  const none = await withTenant(h.db, at.tenant, (trx) =>
    explainContact(trx, published.id, edsger.contact),
  );
  expect(none.evaluations[0]?.explanation).toBe(
    'The trigger starts only for a lead source of Google Ads, and nothing was recorded of how this lead arrived.',
  );
});

it("judges a trigger's condition on the arrival, and names what it compared", async () => {
  const at = await scene();
  const published = await h.publish(at.tenant, {
    name: 'Spring campaign',
    triggers: [
      {
        id: 'sent',
        type: 'form.submitted',
        config: {},
        if: {
          all: [
            { field: 'trigger.attribution.utmCampaign', operator: 'starts_with', value: 'spring' },
            { field: 'trigger.attribution.hasGoogleClickId', operator: 'equals', value: true },
          ],
        },
      },
    ],
    stopWhen: [
      {
        event: 'form.submitted',
        if: { field: 'trigger.attribution.source', operator: 'equals', value: 'Google Ads' },
      },
    ],
    start: 'hold',
    steps: { hold: { type: 'wait', config: { duration: 'P1D' } } },
    settings: { reEnrollment: 'after_finished' },
  });
  const grace = await h.contact(at.tenant, 'Grace');
  const linus = await h.contact(at.tenant, 'Linus');
  expect(
    (await h.match(at.tenant, await submit(at.tenant, grace.contactId, GOOGLE_AD))).enrolled,
  ).toBe(1);
  expect(
    (await h.match(at.tenant, await submit(at.tenant, linus.contactId, FACEBOOK_AD))).enrolled,
  ).toBe(0);
  const why = await withTenant(h.db, at.tenant, (trx) =>
    explainContact(trx, published.id, linus.contact),
  );
  expect(why.evaluations[0]).toMatchObject({
    reason: 'condition_false',
    detail: {
      values: {
        'trigger.attribution.utmCampaign': 'Reels',
        'trigger.attribution.hasGoogleClickId': false,
      },
    },
  });
  expect(why.evaluations[0]?.explanation).toBe(
    "The trigger's condition did not hold for the record: trigger.attribution.utmCampaign was Reels; trigger.attribution.hasGoogleClickId was false.",
  );
  // The stop reads the arrival of the run it would end: Grace's run arrived from Google,
  // so her next submission ends it, wherever that one came from.
  const again = await h.match(at.tenant, await submit(at.tenant, grace.contactId, FACEBOOK_AD));
  expect(again.exited).toBe(1);
});

it('reads the latest touch as the arrival in a test run of a real contact', async () => {
  const at = await scene();
  const ada = await h.contact(at.tenant, 'Ada');
  await submit(at.tenant, ada.contactId, GOOGLE_AD);
  const checked = validateAutomation(
    leadSourceRecipe({ pipeline: at.pipeline, stage: at.stage }),
    setupOf(at),
  );
  const automation = await withTenant(h.db, at.tenant, (trx) =>
    trx
      .insertInto('automation.automations')
      .values({
        business_id: at.tenant.businessId,
        name: 'Recipe',
        draft: JSON.stringify(checked.document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  const id = toPublicId('automation', automation.id);
  const real = await runCommand(
    h.services,
    testRunCommand,
    { id, contactId: ada.contact, values: {}, events: [] },
    all(at.tenant),
  );
  expect(real.steps.map((step) => step.step)).toEqual([
    'by_source',
    'tag_google_ads',
    'create_opportunity',
  ]);
  expect(real.steps.at(-1)?.explanation).toContain('with the source "Google Ads"');
  // A sample contact arrived from nowhere: everything else, and no source to give.
  const sample = await runCommand(
    h.services,
    testRunCommand,
    { id, values: { 'contact.name': 'Sample' }, events: [] },
    all(at.tenant),
  );
  expect(sample.steps.map((step) => step.step)).toEqual(['by_source', 'create_opportunity']);
  expect(sample.steps.at(-1)?.explanation).toMatch(/^Would create deal; nothing/);
});
