// The lead source through the actual Fastify composition, with a real migrated Postgres:
// "Check a link" is mounted where the contract says, refuses what it should with a problem
// document, and agrees with what a submission from the same address then leaves on the
// contact, on the submission and in a report, all read back through the same API.
import { randomUUID } from 'node:crypto';

import { allowEveryone } from '@repo/commands';
import {
  contactAttributions,
  form as formContract,
  formSubmissionList,
  leadSourcePreview,
  leadSourceRule,
  leadSourceRuleList,
  problem,
  PROBLEM_CONTENT_TYPE,
  reportResult,
  tag as tagContract,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { createFormRoutes, createPublicFormHandlers } from '@repo/module-forms';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { buildServer, type Server } from './server.js';

const PUBLIC_URL = 'https://crm.example.test';
const WEBSITE = 'https://www.harborlights.example';
const SECRET = 'lead-source-http-fixture-key-of-32-bytes';
const GOOGLE_AD = `${WEBSITE}/offer?utm_source=google&utm_medium=cpc&campaign_id=111&ad_group_id=222&ad_id=333&gclid=Cj0secret`;
const FACEBOOK_AD = `${WEBSITE}/offer?utm_source=facebook&utm_medium=paid_social&campaign_id=120211&fbclid=IwAR0secret`;

let database: TestDatabase;
let db: Database;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** The API as someone signed in to a business of their own calls it, and that business. */
async function signedIn() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const context: Required<DevTenantContext> = {
    agencyId: agency.id,
    businessId: business.id,
    userId: user.id,
  };
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 2,
    shutdownTimeoutMs: 1000,
    dashboardDir: undefined,
    devTenantContext: context,
    publicUrl: PUBLIC_URL,
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const server = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    // As the production start mounts them: the form routes beside the rest.
    routes: [...apiRoutes(), ...createFormRoutes(PUBLIC_URL)],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
  });
  servers.push(server);
  const call = async (method: Method, path: string, payload?: object) => {
    const response = await server.app.inject({
      method,
      url: `/api/v1${path}`,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body,
      json: response.body === '' ? undefined : response.json<unknown>(),
      type: String(response.headers['content-type']).split(';')[0] ?? '',
    };
  };
  return { call, business };
}

/** A form as the dashboard makes one: created, left as it starts, published for a website. */
async function publishedForm(call: Awaited<ReturnType<typeof signedIn>>['call']) {
  const created = await call('POST', '/forms', { name: 'Enquiry' });
  expect(created.status, created.body).toBe(201);
  const draft = formContract.parse(created.json);
  const saved = await call('PUT', `/forms/${draft.id}`, {
    name: draft.name,
    definition: draft.definition,
    allowedOrigins: [WEBSITE],
    revision: draft.revision,
  });
  expect(saved.status, saved.body).toBe(200);
  const live = await call('POST', `/forms/${draft.id}/publish`, {
    revision: formContract.parse(saved.json).revision,
  });
  expect(live.status, live.body).toBe(200);
  return formContract.parse(live.json);
}

it('checks a link, and a lead from that link then is what the check said', async () => {
  const { call } = await signedIn();
  const form = await publishedForm(call);
  // A new form reads how they arrived and adds the tag of it, with nothing chosen.
  expect(form.definition.contactActions).toEqual({
    tagIds: [],
    source: { kind: 'arrived' },
    tagBySource: true,
  });

  const checked = await call('POST', '/lead-sources/preview', { url: GOOGLE_AD, formId: form.id });
  expect(checked.status, checked.body).toBe(200);
  const preview = leadSourcePreview.parse(checked.json);
  expect(preview).toMatchObject({
    sessionSource: 'paid_search',
    source: 'Google Ads',
    sourceRule: 'google_ads',
    clickIds: ['gclid'],
    form: {
      id: form.id,
      contactSource: 'Google Ads',
      tags: [{ name: 'Source: Google Ads', kind: 'source', exists: false }],
    },
    warnings: [],
  });
  // The value of a click id is not repeated back.
  expect(checked.body).not.toContain('Cj0secret');
  // Checking stored nothing: no tag was made by looking.
  const tagsBefore = await call('GET', '/tags');
  expect(tagsBefore.body).not.toContain('Source: Google Ads');

  // Two visitors send the same form, one from each ad.
  let clock = Date.now();
  const handlers = createPublicFormHandlers({ db, secret: SECRET, now: () => clock });
  for (const [email, pageUrl] of [
    ['gina@example.test', GOOGLE_AD],
    ['felix@example.test', FACEBOOK_AD],
  ] as const) {
    const admission = await handlers.admit(form.publicKey, WEBSITE);
    if (admission === undefined) throw new Error('The form was not admitted.');
    const shown = await handlers.form(admission, { ipAddress: '203.0.113.9' });
    if (shown.outcome !== 'ok') throw new Error('The form was not shown.');
    clock += 3000;
    const result = await handlers.submit(
      admission,
      {
        clientSubmissionId: randomUUID(),
        renderToken: shown.form.renderToken,
        values: { email },
        consents: {},
        trap: '',
        pageUrl,
      },
      { requestId: randomUUID(), ipAddress: '203.0.113.9' },
    );
    expect(result).toEqual({ outcome: 'ok', receipt: { status: 'received' } });
  }

  // The submissions, newest first, each with its lead source and its contact.
  const listed = await call('GET', `/forms/${form.id}/submissions`);
  expect(listed.status, listed.body).toBe(200);
  const { items } = formSubmissionList.parse(listed.json);
  expect(items.map((item) => [item.leadSource, item.leadSourceRule])).toEqual([
    ['Facebook Ads', 'facebook_ads'],
    ['Google Ads', 'google_ads'],
  ]);
  const [facebook, google] = items.map((item) => item.contactId ?? '');

  // Each contact's page: a different Source, a different tag, a different attribution.
  for (const [contactId, source, rule, session, clickId, secret] of [
    [google, 'Google Ads', 'google_ads', 'paid_search', 'gclid', 'Cj0secret'],
    [facebook, 'Facebook Ads', 'facebook_ads', 'paid_social', 'fbclid', 'IwAR0secret'],
  ] as const) {
    const contact = await call('GET', `/contacts/${contactId ?? ''}`);
    expect(contact.status, contact.body).toBe(200);
    expect(contact.json).toMatchObject({ source });
    const tags = await call('GET', `/records/${contactId ?? ''}/tags`);
    expect(tags.status, tags.body).toBe(200);
    expect(
      (tags.json as { items: { tag: unknown }[] }).items.map(
        (item) => tagContract.parse(item.tag).name,
      ),
    ).toEqual([`Source: ${source}`]);
    const read = await call('GET', `/contacts/${contactId ?? ''}/attribution`);
    expect(read.status, read.body).toBe(200);
    const attribution = contactAttributions.parse(read.json);
    expect(attribution.first).toMatchObject({
      medium: 'form',
      source,
      sourceRule: rule,
      sessionSource: session,
      clickIds: [clickId],
      pageUrl: `${WEBSITE}/offer`,
    });
    expect(attribution.first?.campaignId).toBe(rule === 'google_ads' ? '111' : '120211');
    expect(attribution.latest).toEqual(attribution.first);
    // The preview of the same address never held the id; the stored touch does.
    expect(JSON.stringify(preview)).not.toContain(secret);
  }

  // The same check now finds the tag the first lead made.
  const again = leadSourcePreview.parse(
    (await call('POST', '/lead-sources/preview', { url: GOOGLE_AD, formId: form.id })).json,
  );
  expect(again.form?.tags).toEqual([{ name: 'Source: Google Ads', kind: 'source', exists: true }]);

  // And a report groups the two leads by it.
  const counted = await call('POST', '/reports/query', {
    source: 'contacts',
    measures: ['count'],
    groupBy: ['leadSource'],
    range: { preset: 'today' },
  });
  expect(counted.status, counted.body).toBe(200);
  expect(
    Object.fromEntries(
      reportResult.parse(counted.json).rows.map((row) => [row.group[0]?.label, row.values]),
    ),
  ).toEqual({ 'Facebook Ads': [1], 'Google Ads': [1] });
});

it('refuses what is not a web address or not a form of the business, as a problem document', async () => {
  const { call } = await signedIn();
  for (const payload of [
    {},
    { url: 'www.example.com/offer' },
    { url: 'javascript:alert(1)' },
    { url: GOOGLE_AD, referrer: 'facebook' },
    { url: GOOGLE_AD, formId: 'not-a-form' },
    { url: GOOGLE_AD, extra: true },
  ]) {
    const refused = await call('POST', '/lead-sources/preview', payload);
    expect(refused.status, JSON.stringify(payload)).toBe(422);
    expect(refused.type).toBe(PROBLEM_CONTENT_TYPE);
    expect(problem.safeParse(refused.json).success).toBe(true);
  }
  // Another business's form is not found, in the same words as one that never was.
  const other = await signedIn();
  const theirs = await publishedForm(other.call);
  const missing = await call('POST', '/lead-sources/preview', {
    url: GOOGLE_AD,
    formId: theirs.id,
  });
  expect(missing.status, missing.body).toBe(404);
  expect(missing.type).toBe(PROBLEM_CONTENT_TYPE);
  // With no form, an address alone is answered.
  const alone = await call('POST', '/lead-sources/preview', { url: `${WEBSITE}/offer` });
  expect(alone.status, alone.body).toBe(200);
  expect(leadSourcePreview.parse(alone.json)).toMatchObject({
    source: 'Direct',
    sourceRule: 'direct',
    form: null,
    warnings: [{ code: 'no_tracking' }],
  });
});

it('keeps the business’s own rules over HTTP, and names a lead by them: the contact, the submission, the check and a report agree', async () => {
  const { call } = await signedIn();
  const form = await publishedForm(call);
  const SPRING = `${FACEBOOK_AD}&utm_campaign=Spring-2026`;
  const tag = tagContract.parse((await call('POST', '/tags', { name: 'Promo lead' })).json);

  // Nothing yet: the list says so, and who may change it.
  const empty = await call('GET', '/lead-sources/rules');
  expect(empty.status, empty.body).toBe(200);
  expect(leadSourceRuleList.parse(empty.json)).toMatchObject({
    items: [],
    limit: 50,
    canManage: true,
  });

  const created = await call('POST', '/lead-sources/rules', {
    name: 'Spring campaign',
    conditions: [
      { fact: 'lead_source', op: 'is', value: 'facebook_ads' },
      { fact: 'utm_campaign', op: 'contains', value: 'spring' },
    ],
    source: 'Spring promo',
    tagIds: [tag.id],
  });
  expect(created.status, created.body).toBe(201);
  const rule = leadSourceRule.parse(created.json);
  expect(rule).toMatchObject({ position: 1, enabled: true, revision: 1, problems: [] });
  const second = leadSourceRule.parse(
    (
      await call('POST', '/lead-sources/rules', {
        name: 'Everything paid',
        conditions: [
          { fact: 'session_source', op: 'is_one_of', values: ['paid_search', 'paid_social'] },
        ],
        source: 'Paid',
      })
    ).json,
  );
  expect(second.position).toBe(2);
  const read = await call('GET', `/lead-sources/rules/${rule.id}`);
  expect(read.status, read.body).toBe(200);
  expect(leadSourceRule.parse(read.json)).toEqual(rule);

  // The check says which rule names the lead, and what the built-in rules would have said.
  const checked = leadSourcePreview.parse(
    (await call('POST', '/lead-sources/preview', { url: SPRING, formId: form.id })).json,
  );
  expect(checked).toMatchObject({
    source: 'Spring promo',
    sourceRule: 'facebook_ads',
    decidedBy: { kind: 'rule', ruleId: rule.id, name: 'Spring campaign' },
    builtIn: { source: 'Facebook Ads', sourceRule: 'facebook_ads' },
    rules: [
      { id: rule.id, decidesSource: true, tags: [{ id: tag.id, name: 'Promo lead' }] },
      { id: second.id, decidesSource: false, source: 'Paid' },
    ],
    form: { contactSource: 'Spring promo' },
  });

  // Two leads: one of the campaign, one from Google that only the second rule matches.
  let clock = Date.now();
  const handlers = createPublicFormHandlers({ db, secret: SECRET, now: () => clock });
  for (const [email, pageUrl] of [
    ['spring@example.test', SPRING],
    ['gina@example.test', GOOGLE_AD],
  ] as const) {
    const admission = await handlers.admit(form.publicKey, WEBSITE);
    if (admission === undefined) throw new Error('The form was not admitted.');
    const shown = await handlers.form(admission, { ipAddress: '203.0.113.9' });
    if (shown.outcome !== 'ok') throw new Error('The form was not shown.');
    clock += 3000;
    expect(
      await handlers.submit(
        admission,
        {
          clientSubmissionId: randomUUID(),
          renderToken: shown.form.renderToken,
          values: { email },
          consents: {},
          trap: '',
          pageUrl,
        },
        { requestId: randomUUID(), ipAddress: '203.0.113.9' },
      ),
    ).toEqual({ outcome: 'ok', receipt: { status: 'received' } });
  }
  const { items } = formSubmissionList.parse(
    (await call('GET', `/forms/${form.id}/submissions`)).json,
  );
  expect(items.map((item) => [item.leadSource, item.leadSourceRule])).toEqual([
    ['Paid', second.id],
    ['Spring promo', rule.id],
  ]);
  const springContact = items[1]?.contactId ?? '';
  expect((await call('GET', `/contacts/${springContact}`)).json).toMatchObject({
    source: 'Spring promo',
  });
  const attribution = contactAttributions.parse(
    (await call('GET', `/contacts/${springContact}/attribution`)).json,
  );
  expect(attribution.first).toMatchObject({
    source: 'Spring promo',
    sourceRule: rule.id,
    sessionSource: 'paid_social',
  });
  const tags = await call('GET', `/records/${springContact}/tags`);
  expect(
    (tags.json as { items: { tag: unknown }[] }).items.map(
      (item) => tagContract.parse(item.tag).name,
    ),
  ).toEqual(['Promo lead']);
  const counted = await call('POST', '/reports/query', {
    source: 'contacts',
    measures: ['count'],
    groupBy: ['leadSource'],
    range: { preset: 'today' },
  });
  expect(
    Object.fromEntries(
      reportResult.parse(counted.json).rows.map((row) => [row.group[0]?.label, row.values]),
    ),
  ).toEqual({ Paid: [1], 'Spring promo': [1] });

  // A save names the revision it read; a stale one is a conflict, as a problem document.
  const whole = {
    name: 'Spring campaign',
    enabled: false,
    conditions: rule.conditions,
    source: 'Spring promo',
    tagIds: [],
    fieldWrites: [],
  };
  const saved = await call('PUT', `/lead-sources/rules/${rule.id}`, { ...whole, revision: 1 });
  expect(saved.status, saved.body).toBe(200);
  expect(leadSourceRule.parse(saved.json)).toMatchObject({ enabled: false, revision: 2 });
  const stale = await call('PUT', `/lead-sources/rules/${rule.id}`, { ...whole, revision: 1 });
  expect(stale.status, stale.body).toBe(409);
  expect(stale.type).toBe(PROBLEM_CONTENT_TYPE);
  // Switched off, the rule names nothing: the next rule does.
  expect(
    leadSourcePreview.parse((await call('POST', '/lead-sources/preview', { url: SPRING })).json),
  ).toMatchObject({ source: 'Paid', decidedBy: { kind: 'rule', ruleId: second.id } });

  // The order, by the revision of the list as read.
  const list = leadSourceRuleList.parse((await call('GET', '/lead-sources/rules')).json);
  const moved = await call('POST', '/lead-sources/rules/order', {
    ruleIds: [second.id, rule.id],
    revision: list.revision,
  });
  expect(moved.status, moved.body).toBe(200);
  expect(leadSourceRuleList.parse(moved.json).items.map((each) => each.id)).toEqual([
    second.id,
    rule.id,
  ]);
  // The list is as it was read only once: the same revision again is stale.
  const reread = leadSourceRuleList.parse((await call('GET', '/lead-sources/rules')).json);
  expect(reread.revision).not.toBe(list.revision);
  const again = await call('POST', '/lead-sources/rules/order', {
    ruleIds: [rule.id, second.id],
    revision: list.revision,
  });
  expect(again.status, again.body).toBe(409);

  // What is malformed is refused as a problem document.
  for (const payload of [
    { name: 'No action', conditions: rule.conditions },
    { name: 'No condition', conditions: [], source: 'S' },
    {
      name: 'Wrong operator',
      conditions: [{ fact: 'click_id_google', op: 'contains', value: 'x' }],
      source: 'S',
    },
    {
      name: 'Unknown tag',
      conditions: rule.conditions,
      tagIds: ['tag_01h455vb4pex5vsknk084sn02q'],
    },
  ]) {
    const refused = await call('POST', '/lead-sources/rules', payload);
    expect(refused.status, `${payload.name}: ${refused.body}`).toBe(422);
    expect(refused.type).toBe(PROBLEM_CONTENT_TYPE);
    expect(problem.safeParse(refused.json).success).toBe(true);
  }

  // Deleted, it is gone, and the other moves up.
  const deleted = await call('DELETE', `/lead-sources/rules/${second.id}`);
  expect(deleted.status, deleted.body).toBe(204);
  expect(
    leadSourceRuleList
      .parse((await call('GET', '/lead-sources/rules')).json)
      .items.map((each) => [each.id, each.position]),
  ).toEqual([[rule.id, 1]]);
  expect((await call('DELETE', `/lead-sources/rules/${second.id}`)).status).toBe(404);

  // Another business reads none of it, and finds none of it.
  const other = await signedIn();
  expect(
    leadSourceRuleList.parse((await other.call('GET', '/lead-sources/rules')).json).items,
  ).toEqual([]);
  for (const [method, payload] of [
    ['GET', undefined],
    ['PUT', { ...whole, revision: 2 }],
    ['DELETE', undefined],
  ] as const) {
    const missing = await other.call(method, `/lead-sources/rules/${rule.id}`, payload);
    expect(missing.status, `${method} ${missing.body}`).toBe(404);
    expect(missing.type).toBe(PROBLEM_CONTENT_TYPE);
  }
});
