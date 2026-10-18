// The owner's own case, end to end: "the same form on a funnel, used for ads on Facebook
// and Google: how do we tell the source apart?"
//
// What is real here: the production start in the role that runs everything (the API, the
// public form routes and the worker polling its queue), a migrated Postgres, real HTTP on a
// real port. ONE form is published through the API and nothing about it is chosen. The
// workflow is the recipe "Tag and route leads by source", built from the tags the API
// answers for its lead sources and published through the API. Four visitors then send the
// same form through the public route, each from a different address, and the worker runs
// the workflow for each. Everything is read back through the API, except which branch a
// run took, which is read from the run's own step log.
//
// What is stood in for: the browser (the embed's two requests are made by fetch, with the
// page address and the referrer the embed would send), the signed-in person (the
// development stand-in, who may do everything), and the business's pipeline (the same seed
// a new business gets, run here because the fixture makes a bare business).
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  automationCatalogResponse,
  automationDraftSaved,
  contact as contactContract,
  contactAttributions,
  dealList,
  form as formContract,
  FORM_LIMITS,
  formSubmissionList,
  leadSourceRecipe,
  leadSourceRecipeSources,
  leadSourceTags,
  publicForm,
  recordTagList,
  tagList,
  type LeadSourceKey,
  type SessionSource,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { seedBusinessDefaults } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { start, type Running } from './start.js';
import { workerTasks } from './worker-tasks.js';

const PUBLIC_URL = 'https://crm.example.test';
const WEBSITE = 'https://www.harborlights.example';
const PAGE = `${WEBSITE}/open-day`;

/** The four visitors: where each came from, and what each lead must then be. */
const VISITORS = [
  {
    name: 'Gina',
    email: 'gina@example.test',
    // A Google ad with auto-tagging and the labels of a tracking template.
    pageUrl: `${PAGE}?utm_source=google&utm_medium=cpc&utm_campaign=spring&campaign_id=111&ad_group_id=222&ad_id=333&gclid=Cj0-secret-google`,
    referrer: undefined,
    secret: 'Cj0-secret-google',
    source: 'Google Ads',
    rule: 'google_ads',
    session: 'paid_search',
    branch: 'google_ads',
    clickIds: ['gclid'],
  },
  {
    name: 'Felix',
    email: 'felix@example.test',
    // A Meta ad whose link was written by hand: the source, a paid medium and the ad's ids.
    pageUrl: `${PAGE}?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&campaign_id=120211&adset_id=120222&ad_id=120233`,
    referrer: undefined,
    secret: undefined,
    source: 'Facebook Ads',
    rule: 'facebook_ads',
    session: 'paid_social',
    branch: 'facebook_ads',
    clickIds: [],
  },
  {
    name: 'Fay',
    email: 'fay@example.test',
    // A click from Facebook that carries Meta's click id and nothing that says it was paid
    // for: Facebook, not Facebook Ads (the owner's decision 7).
    pageUrl: `${PAGE}?fbclid=IwAR0-secret-meta`,
    referrer: 'https://l.facebook.com/l.php?u=x',
    secret: 'IwAR0-secret-meta',
    source: 'Facebook',
    rule: 'facebook',
    session: 'social_media',
    branch: 'none',
    clickIds: ['fbclid'],
  },
  {
    name: 'Dina',
    email: 'dina@example.test',
    // The bare address, typed or from a bookmark.
    pageUrl: PAGE,
    referrer: undefined,
    secret: undefined,
    source: 'Direct',
    rule: 'direct',
    session: 'direct',
    branch: 'none',
    clickIds: [],
  },
] as const satisfies readonly {
  name: string;
  email: string;
  pageUrl: string;
  referrer: string | undefined;
  secret: string | undefined;
  source: string;
  rule: LeadSourceKey;
  session: SessionSource;
  branch: string;
  clickIds: readonly string[];
}[];

let database: TestDatabase;
let db: Database;
let app: Running;
let tenant: { agencyId: string; businessId: string; userId: string };

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const agency = await database.fixtures.agency();
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  // A business as creating one makes it: the row, then what every new business starts
  // with, the Sales pipeline among it (the opportunities need somewhere to go).
  const suffix = randomUUID().slice(0, 8);
  const staff = { agencyId: agency.id, actorKind: 'system' as const, correlationId: randomUUID() };
  const business = await database.withTenant(staff, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $3) returning id',
      [agency.id, `Harbor Lights ${suffix}`, `harbor-lights-${suffix}`],
    ),
  );
  tenant = { agencyId: agency.id, businessId: business.id, userId: user.id };
  await withTenant(db, { ...staff, businessId: business.id }, (trx) =>
    seedBusinessDefaults(trx, business.id),
  );
  const config: Config = {
    nodeEnv: 'test',
    // Everything in one process, as a small install runs it: the worker polls its queue.
    role: 'all',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: database.url('crm_worker'),
    databasePoolSize: 6,
    shutdownTimeoutMs: 5000,
    dashboardDir: undefined,
    devTenantContext: tenant,
    publicUrl: PUBLIC_URL,
    publicIntake: { secret: 'lead-source-acceptance-key-of-32-bytes-or-more' },
    authentication: undefined,
    mail: undefined,
    // Each visitor is a client of its own to the limiter, named as a proxy would name it.
    trustProxy: ['loopback'],
    files: undefined,
    vault: undefined,
  };
  app = await start(config, apiRoutes, workerTasks);
});
afterAll(async () => {
  await (app as Running | undefined)?.stop();
  await db.destroy();
  await database.close();
});

/** The signed-in API over HTTP. */
async function api(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const response = await fetch(`${app.address}/api/v1${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
}

let visitors = 0;
/** The public form route as one visitor's browser calls it from the business's website. */
function browser(formKey: string) {
  const address = `198.51.100.${String((visitors += 1))}`;
  return (method: 'GET' | 'POST', path = '', body?: unknown): Promise<Response> =>
    fetch(`${app.address}/api/v1/public/forms/${formKey}${path}`, {
      method,
      headers: {
        'x-forwarded-for': address,
        'user-agent': 'TestBrowser/1.0',
        origin: WEBSITE,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

/** Asks until the answer is there, as someone watching the screen would wait for the worker. */
async function eventually<Value>(
  what: string,
  read: () => Promise<Value | undefined>,
): Promise<Value> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Still waiting after a minute: ${what}`);
    await sleep(250);
  }
}

it('tells four leads of one form apart: Source, tag, touch, opportunity and branch', async () => {
  // ONE form, as it starts: nothing chosen, published for the website.
  const created = await api('POST', '/forms', { name: 'Open day' });
  expect(created.status, created.text).toBe(201);
  const draft = formContract.parse(created.json);
  const saved = await api('PUT', `/forms/${draft.id}`, {
    name: draft.name,
    definition: draft.definition,
    allowedOrigins: [WEBSITE],
    revision: draft.revision,
  });
  expect(saved.status, saved.text).toBe(200);
  const live = await api('POST', `/forms/${draft.id}/publish`, {
    revision: formContract.parse(saved.json).revision,
  });
  expect(live.status, live.text).toBe(200);
  const form = formContract.parse(live.json);
  expect(form.definition.contactActions).toEqual({
    tagIds: [],
    source: { kind: 'arrived' },
    tagBySource: true,
  });

  // The workflow, as "Start from a recipe" builds it: the tags of its lead sources are
  // asked for by key, so they are the tags the form adds, and the draft names them by id.
  const asked = await api('POST', '/lead-sources/tags', { sources: leadSourceRecipeSources() });
  expect(asked.status, asked.text).toBe(200);
  const recipeTags = leadSourceTags.parse(asked.json).items;
  expect(recipeTags.map((item) => [item.source, item.tag.name])).toEqual([
    ['google_ads', 'Source: Google Ads'],
    ['facebook_ads', 'Source: Facebook Ads'],
    ['instagram_ads', 'Source: Instagram Ads'],
    ['organic_search', 'Source: Organic Search'],
  ]);
  const tagIdOf = Object.fromEntries(recipeTags.map((item) => [item.source, item.tag.id]));
  const catalog = await api('GET', '/automations/catalog');
  expect(catalog.status, catalog.text).toBe(200);
  const [pipeline] = automationCatalogResponse.parse(catalog.json).setup.pipelines;
  const [stage] = pipeline?.stages ?? [];
  if (pipeline === undefined || stage === undefined) throw new Error('No pipeline to use.');
  const drafted = await api('POST', '/automations', {
    document: leadSourceRecipe({ pipeline: pipeline.id, stage: stage.id, tags: tagIdOf }),
  });
  expect(drafted.status, drafted.text).toBe(201);
  const { automation, validation } = automationDraftSaved.parse(drafted.json);
  expect(validation.errors).toEqual([]);
  const published = await api('POST', `/automations/${automation.id}/publish`, {
    baseDraftVersion: automation.draftVersion,
  });
  expect(published.status, published.text).toBe(200);
  expect(published.json).toMatchObject({ status: 'active', liveVersion: 1 });

  // Four visitors send the same form through the public route.
  for (const visitor of VISITORS) {
    const call = browser(form.publicKey);
    const shown = await call('GET');
    expect(shown.status, visitor.name).toBe(200);
    const view = publicForm.parse(await shown.json());
    // A person takes a moment to fill a form in; one sent at once is refused.
    await sleep(FORM_LIMITS.minFillSeconds * 1000 + 150);
    const sent = await call('POST', '/submissions', {
      clientSubmissionId: randomUUID(),
      renderToken: view.renderToken,
      values: { first_name: visitor.name, email: visitor.email },
      consents: {},
      trap: '',
      pageUrl: visitor.pageUrl,
      ...(visitor.referrer === undefined ? {} : { referrer: visitor.referrer }),
    });
    expect(sent.status, `${visitor.name}: ${await sent.clone().text()}`).toBe(201);
    expect(await sent.json()).toEqual({ status: 'received' });
  }

  // The submissions, newest first, each naming its lead source and its contact.
  const listed = await api('GET', `/forms/${form.id}/submissions`);
  expect(listed.status, listed.text).toBe(200);
  const submissions = formSubmissionList.parse(listed.json).items;
  expect(submissions.map((item) => [item.leadSource, item.leadSourceRule])).toEqual(
    [...VISITORS].reverse().map((visitor) => [visitor.source, visitor.rule]),
  );
  // And the list of one lead source is that lead alone.
  const onlyGoogle = await api('GET', `/forms/${form.id}/submissions?leadSourceRule=google_ads`);
  expect(formSubmissionList.parse(onlyGoogle.json).items.map((item) => item.leadSource)).toEqual([
    'Google Ads',
  ]);
  const contactOf = new Map(
    VISITORS.map((visitor, index) => [
      visitor.name,
      submissions[VISITORS.length - 1 - index]?.contactId ?? '',
    ]),
  );

  // The worker runs the workflow for each lead: every one ends with an opportunity.
  const deals = await eventually('an opportunity for each of the four leads', async () => {
    const page = await api('GET', '/deals?include=contact');
    if (page.status !== 200) throw new Error(page.text);
    const { items } = dealList.parse(page.json);
    return items.length >= VISITORS.length ? items : undefined;
  });
  expect(deals).toHaveLength(VISITORS.length);

  // Which branch each run took, from its own step log.
  const steps = await database.withTenant(
    { ...tenant, actorKind: 'system', correlationId: randomUUID() },
    (sql) =>
      sql.query<{ record_id: string; step_key: string; branch: string | null; status: string }>(
        `select run.record_id, step.step_key, step.branch, step.status
         from automation.step_runs step
         join automation.enrolments run on run.id = step.enrolment_id
         order by step.started_at, step.id`,
      ),
  );

  const table: Record<string, unknown> = {};
  for (const visitor of VISITORS) {
    const contactId = contactOf.get(visitor.name) ?? '';
    expect(contactId, visitor.name).toMatch(/^con_/);

    const contact = await api('GET', `/contacts/${contactId}`);
    expect(contact.status, contact.text).toBe(200);

    const tagged = await api('GET', `/records/${contactId}/tags`);
    expect(tagged.status, tagged.text).toBe(200);
    const tags = recordTagList.parse(tagged.json).items;

    const read = await api('GET', `/contacts/${contactId}/attribution`);
    expect(read.status, read.text).toBe(200);
    const attribution = contactAttributions.parse(read.json);
    // The dashboard is told which click ids are held, never one of them.
    expect(attribution.first?.clickIds, visitor.name).toEqual(visitor.clickIds);
    for (const key of ['gclid', 'fbclid', 'msclkid', 'ctwaClid', 'ttclid', 'liFatId', 'gbraid'])
      expect(read.text, `${visitor.name} ${key}`).not.toContain(`"${key}":`);
    if (visitor.secret !== undefined)
      for (const answer of [read.text, contact.text, tagged.text, listed.text])
        expect(answer, visitor.name).not.toContain(visitor.secret);

    const deal = deals.find((each) => each.primaryContact?.id === contactId);
    const mine = steps.filter((step) => step.record_id === parsePublicId('contact', contactId));
    table[visitor.name] = {
      contactSource: contactContract.parse(contact.json).source,
      tags: tags.map((item) => [item.tag.name, item.source.kind]),
      // The tag the workflow's branch adds is the very tag the form added: one tag, by id.
      sameTagAsTheRecipe:
        visitor.branch === 'none'
          ? null
          : tags.map((item) => item.tag.id).includes(tagIdOf[visitor.branch] ?? ''),
      touchSource: attribution.first?.source,
      touchRule: attribution.first?.sourceRule,
      sessionSource: attribution.first?.sessionSource,
      opportunitySource: deal?.source,
      branch: mine.find((step) => step.step_key === 'by_source')?.branch,
      steps: mine.map((step) => `${step.step_key}:${step.status}`),
    };
    expect(attribution.latest, visitor.name).toEqual(attribution.first);
  }

  expect(table).toEqual({
    Gina: {
      contactSource: 'Google Ads',
      tags: [['Source: Google Ads', 'form']],
      sameTagAsTheRecipe: true,
      touchSource: 'Google Ads',
      touchRule: 'google_ads',
      sessionSource: 'paid_search',
      opportunitySource: 'Google Ads',
      branch: 'google_ads',
      steps: ['by_source:succeeded', 'tag_google_ads:succeeded', 'create_opportunity:succeeded'],
    },
    Felix: {
      contactSource: 'Facebook Ads',
      tags: [['Source: Facebook Ads', 'form']],
      sameTagAsTheRecipe: true,
      touchSource: 'Facebook Ads',
      touchRule: 'facebook_ads',
      sessionSource: 'paid_social',
      opportunitySource: 'Facebook Ads',
      branch: 'facebook_ads',
      steps: ['by_source:succeeded', 'tag_facebook_ads:succeeded', 'create_opportunity:succeeded'],
    },
    // Meta's click id alone proves no payment: Facebook, by the social channel, on the
    // branch for everything else, which adds no tag of its own.
    Fay: {
      contactSource: 'Facebook',
      tags: [['Source: Facebook', 'form']],
      sameTagAsTheRecipe: null,
      touchSource: 'Facebook',
      touchRule: 'facebook',
      sessionSource: 'social_media',
      opportunitySource: 'Facebook',
      branch: 'none',
      steps: ['by_source:succeeded', 'create_opportunity:succeeded'],
    },
    // The bare address: Direct on the contact, the touch and the opportunity alike, and no
    // tag that says an ad.
    Dina: {
      contactSource: 'Direct',
      tags: [['Source: Direct', 'form']],
      sameTagAsTheRecipe: null,
      touchSource: 'Direct',
      touchRule: 'direct',
      sessionSource: 'direct',
      opportunitySource: 'Direct',
      branch: 'none',
      steps: ['by_source:succeeded', 'create_opportunity:succeeded'],
    },
  });

  // One tag for each source, whoever made it: the four the recipe asked for and the two
  // the form made for the leads on no branch. No "Source: Other", no second "Google Ads".
  const all = await api('GET', '/tags');
  expect(all.status, all.text).toBe(200);
  expect(
    tagList
      .parse(all.json)
      .items.map((tag) => tag.name)
      .sort(),
  ).toEqual([
    'Source: Direct',
    'Source: Facebook',
    'Source: Facebook Ads',
    'Source: Google Ads',
    'Source: Instagram Ads',
    'Source: Organic Search',
  ]);
});
