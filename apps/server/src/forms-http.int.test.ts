// Forms through the production start, over real HTTP, on real Postgres with the real shared
// limiter: what an unsigned visitor's browser can reach from an allowed website, what it
// never can, and where a submission lands for the team.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { allowEveryone, type ApiRoute, type Invocation } from '@repo/commands';
import {
  botChallenge,
  contact as contactContract,
  contactConsent,
  contactList,
  form as formContract,
  FORM_LIMITS,
  formAnalytics,
  formPreview,
  formSubmissionList,
  publicForm,
  recordActivity,
  type Form,
  type FormDefinitionInput,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { createFormRoutes, toAltchaChallenge } from '@repo/module-forms';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { start, type Running } from './start.js';

const PUBLIC_URL = 'https://crm.example.test';
const WEBSITE = 'https://www.harborlights.example';

let database: TestDatabase;
let db: Database;
let app: Running;
let routes: readonly ApiRoute[];
let config: Config;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 4,
    shutdownTimeoutMs: 2000,
    dashboardDir: undefined,
    devTenantContext: undefined,
    publicUrl: PUBLIC_URL,
    publicIntake: { secret: 'forms-http-fixture-key-with-at-least-32-bytes' },
    authentication: undefined,
    mail: undefined,
    // Each visitor below is a client of its own to the limiter, named by this test as a
    // proxy in front of the server would name them.
    trustProxy: ['loopback'],
    files: undefined,
    vault: undefined,
  };
  app = await start(config, apiRoutes, []);
  routes = [
    ...apiRoutes(),
    // As the production start makes them: able to sign a link that previews a draft.
    ...createFormRoutes(PUBLIC_URL, { previewSecret: config.publicIntake?.secret }),
  ];
});
afterAll(async () => {
  await app.stop();
  await db.destroy();
  await database.close();
});

let clients = 0;
/** A visitor's browser: its own address, and the website it is on. */
function browserOn(
  origin: string | null,
  key: string,
  server: Running = app,
  // The same browser on another request: a form's token answers only the address it was shown to.
  address = `198.51.100.${String((clients += 1))}`,
) {
  const call = async (
    method: 'GET' | 'POST' | 'OPTIONS',
    path = '',
    options: { body?: unknown; headers?: Record<string, string>; raw?: string } = {},
  ): Promise<Response> =>
    fetch(`${server.address}/api/v1/public/forms/${key}${path}`, {
      method,
      headers: {
        'x-forwarded-for': address,
        'user-agent': 'TestBrowser/1.0',
        ...(origin === null ? {} : { origin }),
        ...(options.body === undefined && options.raw === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.raw !== undefined
        ? { body: options.raw }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
    });
  return { address, call };
}

/** Runs one of the signed-in API's routes as a member of the business, as the server would. */
async function asTeam(
  invocation: Invocation,
  operationId: string,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`No route for ${operationId}.`);
  return route.run(
    {
      invocation: {
        ...invocation,
        context: { ...invocation.context, correlationId: randomUUID() },
      },
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    { db, authorize: allowEveryone },
  );
}

const enquiry = {
  title: 'Plan your event',
  fields: [
    {
      key: 'first_name',
      type: 'text',
      label: 'First name',
      target: { kind: 'contact', attribute: 'firstName' },
    },
    {
      key: 'email',
      type: 'email',
      label: 'Email',
      required: true,
      target: { kind: 'contact', attribute: 'email' },
    },
    { key: 'notes', type: 'long_text', label: 'Anything else?' },
  ],
  consents: [{ key: 'news', channel: 'email', wording: 'Email me news and offers.' }],
} satisfies FormDefinitionInput;

/** A business with one person on its team and a form published for one website. */
async function business(website = WEBSITE, name = 'Wedding enquiry') {
  const agency = await database.fixtures.agency();
  const owner = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  const invocation: Invocation = {
    context: {
      ...owner.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const draft = formContract.parse(await asTeam(invocation, 'createForm', { body: { name } }));
  const saved = formContract.parse(
    await asTeam(invocation, 'updateForm', {
      params: { id: draft.id },
      body: { name, definition: enquiry, allowedOrigins: [website], revision: draft.revision },
    }),
  );
  const live: Form = formContract.parse(
    await asTeam(invocation, 'publishForm', {
      params: { id: saved.id },
      body: { revision: saved.revision },
    }),
  );
  return { agency, owner, invocation, form: live };
}

/** Loads the form as the embed does, and gives what a submission needs from it. */
async function loaded(browser: ReturnType<typeof browserOn>) {
  const response = await browser.call('GET');
  expect(response.status).toBe(200);
  const shown = publicForm.parse(await response.json());
  return (values: Record<string, string | boolean>, consents: Record<string, boolean> = {}) => ({
    clientSubmissionId: randomUUID(),
    renderToken: shown.renderToken,
    values,
    consents,
    trap: '',
    pageUrl: `${WEBSITE}/enquire?utm_source=newsletter`,
  });
}
/** Longer than a form must have been on the page before it is taken. */
const fillTime = () => sleep(FORM_LIMITS.minFillSeconds * 1000 + 150);

it('shows a published form to its website and lands a submission on a contact the team can read', async () => {
  const f = await business();
  const maya = browserOn(WEBSITE, f.form.publicKey);

  // What a browser asks first, before a JSON post: answered for anyone, from memory.
  const preflight = await maya.call('OPTIONS', '/submissions', {
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');

  const shown = await maya.call('GET');
  expect(shown.status).toBe(200);
  expect(shown.headers.get('access-control-allow-origin')).toBe(WEBSITE);
  expect(shown.headers.get('cache-control')).toBe('no-store');
  const view = publicForm.parse(await shown.json());
  expect(view.title).toBe('Plan your event');
  expect(view.fields.map((field) => field.key)).toEqual(['first_name', 'email', 'notes']);

  const submission = (await loaded(maya))(
    { first_name: 'Maya', email: 'Maya@Example.test', notes: '<b>Outdoor</b> ceremony' },
    { news: true },
  );
  // The moment it loads is too soon for a person: the embed is told how long to wait.
  const early = await maya.call('POST', '/submissions', { body: submission });
  expect(early.status).toBe(429);
  expect(early.headers.get('retry-after')).toBe('2');
  expect(early.headers.get('access-control-expose-headers')).toBe('Retry-After');
  await fillTime();
  const sent = await maya.call('POST', '/submissions', { body: submission });
  expect(sent.status).toBe(201);
  expect(await sent.json()).toEqual({ status: 'received' });
  expect(sent.headers.get('access-control-allow-origin')).toBe(WEBSITE);
  // Sent again (a double click, a lost answer): the same answer, and nothing new.
  const again = await maya.call('POST', '/submissions', { body: submission });
  expect(again.status).toBe(201);
  expect(await again.json()).toEqual({ status: 'received' });

  // The team: one contact, its timeline naming the form, its consent with the proof.
  const contacts = contactList.parse(await asTeam(f.invocation, 'listContacts'));
  expect(contacts.items).toHaveLength(1);
  const [made] = contacts.items;
  if (made === undefined) throw new Error('No contact was made.');
  expect(
    contactContract.parse(await asTeam(f.invocation, 'getContact', { params: { id: made.id } })),
  ).toMatchObject({ firstName: 'Maya', emails: ['maya@example.test'] });
  const activity = recordActivity.parse(
    await asTeam(f.invocation, 'listRecordActivity', { params: { id: made.id } }),
  );
  const submitted = activity.items.filter((entry) => entry.type === 'form.submitted');
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    actor: { kind: 'form', name: 'Wedding enquiry' },
    subject: { kind: 'form_submission', id: expect.stringMatching(/^fsub_/) as string },
  });
  // Nothing typed is in the timeline: it is in the submission and on the contact.
  expect(JSON.stringify(activity)).not.toMatch(/Outdoor|maya@example/i);
  const consent = contactConsent.parse(
    await asTeam(f.invocation, 'getContactConsent', { params: { id: made.id } }),
  );
  expect(
    consent.current.find((state) => state.channel === 'email' && state.purpose === 'marketing'),
  ).toMatchObject({ status: 'granted', source: 'form' });
  expect(consent.history[0]).toMatchObject({
    status: 'granted',
    source: 'form',
    recordedBy: { kind: 'contact' },
    proof: {
      wording: 'Email me news and offers.',
      // The address the proxy named, not one the visitor could choose.
      ipAddress: maya.address,
      pageUrl: `${WEBSITE}/enquire`,
      linked: 'form',
    },
  });
  const list = formSubmissionList.parse(
    await asTeam(f.invocation, 'listFormSubmissions', { params: { id: f.form.id } }),
  );
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({
    contactId: made.id,
    contactOutcome: 'created',
    origin: WEBSITE,
    pageUrl: `${WEBSITE}/enquire`,
    ipAddress: maya.address,
    utm: { source: 'newsletter' },
    consents: [{ key: 'news', outcome: 'granted' }],
  });
  // Markup is text, kept as typed.
  expect(list.items[0]?.answers.at(-1)).toEqual({
    key: 'notes',
    label: 'Anything else?',
    value: '<b>Outdoor</b> ceremony',
  });

  // The same person from another address, later: the same contact, a second submission.
  const later = browserOn(WEBSITE, f.form.publicKey);
  const second = (await loaded(later))({ first_name: 'Maya Jane', email: 'maya@example.test' });
  await fillTime();
  expect((await later.call('POST', '/submissions', { body: second })).status).toBe(201);
  const after = contactList.parse(await asTeam(f.invocation, 'listContacts'));
  expect(after.items.map((item) => item.id)).toEqual([made.id]);
  expect(
    formSubmissionList
      .parse(await asTeam(f.invocation, 'listFormSubmissions', { params: { id: f.form.id } }))
      .items.map((item) => item.contactOutcome),
  ).toEqual(['updated', 'created']);
});

it('refuses every other website, key and shape of request, and says the same to each', async () => {
  const f = await business();
  const other = await business('https://other.example.com', 'Their form');
  const refusedEverywhere = async (browser: ReturnType<typeof browserOn>) => {
    const answers = [
      await browser.call('GET'),
      await browser.call('POST', '/submissions', {
        body: {
          clientSubmissionId: randomUUID(),
          renderToken: `1790000000000.${'A'.repeat(43)}`,
          values: { email: 'x@example.test' },
          consents: {},
        },
      }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(403);
      // No CORS header: a page elsewhere cannot even read the refusal.
      expect(answer.headers.get('access-control-allow-origin')).toBeNull();
      expect(await answer.json()).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'This form cannot be used here.',
      });
    }
  };
  await refusedEverywhere(browserOn('https://attacker.example', f.form.publicKey));
  await refusedEverywhere(browserOn(null, f.form.publicKey));
  await refusedEverywhere(browserOn('null', f.form.publicKey));
  // One business's website cannot use another business's form, and the other way round.
  await refusedEverywhere(browserOn(WEBSITE, other.form.publicKey));
  await refusedEverywhere(browserOn('https://other.example.com', f.form.publicKey));
  await refusedEverywhere(browserOn(WEBSITE, 'z'.repeat(32)));

  // An unpublished form answers nobody, its own website included.
  await asTeam(f.invocation, 'unpublishForm', {
    params: { id: f.form.id },
    body: { revision: f.form.revision },
  });
  await refusedEverywhere(browserOn(WEBSITE, f.form.publicKey));
  for (const owner of [f, other])
    expect(contactList.parse(await asTeam(owner.invocation, 'listContacts')).items).toEqual([]);
});

it('says which answers do not fit, and reads nothing that is not a bounded JSON submission', async () => {
  const f = await business();
  const visitor = browserOn(WEBSITE, f.form.publicKey);
  const fill = await loaded(visitor);
  await fillTime();
  const invalid = await visitor.call('POST', '/submissions', {
    body: fill({ email: 'not-an-address', role: 'admin' }),
  });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toEqual({
    type: 'about:blank',
    title: 'Unprocessable Content',
    status: 422,
    detail: 'Check the answers and try again.',
    errors: [
      { path: '/values/role', code: 'unknown_question', message: 'This form does not ask that.' },
      {
        path: '/values/email',
        code: 'invalid_email',
        message: 'Enter an email address, such as maya@example.com.',
      },
    ],
  });
  // A hidden field that was filled in gets the answer a person gets, and nothing is stored.
  const trapped = await visitor.call('POST', '/submissions', {
    body: { ...fill({ email: 'bot@example.test' }), trap: 'https://spam.example' },
  });
  expect(trapped.status).toBe(201);
  expect(await trapped.json()).toEqual({ status: 'received' });

  const asText = await visitor.call('POST', '/submissions', {
    raw: JSON.stringify(fill({ email: 'maya@example.test' })),
    headers: { 'content-type': 'text/plain' },
  });
  expect(asText.status).toBe(415);
  const asForm = await visitor.call('POST', '/submissions', {
    raw: 'email=maya%40example.test',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(asForm.status).toBe(415);
  const broken = await visitor.call('POST', '/submissions', { raw: '{"clientSubmissionId":' });
  expect(broken.status).toBe(400);
  const huge = await visitor.call('POST', '/submissions', {
    raw: JSON.stringify({ ...fill({ email: 'maya@example.test' }), padding: 'x'.repeat(140_000) }),
  });
  expect(huge.status).toBe(413);
  // A body that names its own contact, business or address is not a submission.
  for (const extra of [
    { contactId: 'con_01h455vb4pex5vsknk084sn02q' },
    { businessId: 'biz_01h455vb4pex5vsknk084sn02q' },
    { ipAddress: '10.0.0.1' },
  ]) {
    const refused = await visitor.call('POST', '/submissions', {
      body: { ...fill({ email: 'maya@example.test' }), ...extra },
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).not.toHaveProperty('errors');
  }
  expect(contactList.parse(await asTeam(f.invocation, 'listContacts')).items).toEqual([]);
  expect(
    formSubmissionList.parse(
      await asTeam(f.invocation, 'listFormSubmissions', { params: { id: f.form.id } }),
    ).items,
  ).toEqual([]);
});

it('counts form requests with every other public request of an address, and says so readably', async () => {
  const f = await business();
  const visitor = browserOn(WEBSITE, f.form.publicKey);
  const fill = await loaded(visitor);
  // The shared limiter takes ten writes a minute from one address, whatever they are. Its
  // minute may turn over once while this runs, which lets at most ten more through: so of
  // twenty-two requests at least two are refused by it, and never one of the first ten.
  const refusals: ('form' | 'limiter')[] = [];
  let limited: Response | undefined;
  for (let attempt = 0; attempt < 22; attempt += 1) {
    const answer = await visitor.call('POST', '/submissions', {
      body: fill({ email: 'not-an-address' }),
    });
    // The form's own answers (too soon after it was shown, then the address) go to its
    // website only; the limiter's is the one any website may read.
    expect([422, 429]).toContain(answer.status);
    const byLimiter = answer.headers.get('access-control-allow-origin') === '*';
    refusals.push(byLimiter ? 'limiter' : 'form');
    if (byLimiter) limited = answer;
  }
  expect(refusals.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 'form'));
  expect(refusals.filter((by) => by === 'limiter').length).toBeGreaterThanOrEqual(2);
  expect(limited?.status).toBe(429);
  expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  expect(limited?.headers.get('access-control-expose-headers')).toBe('Retry-After');
  // Another address is not held back by this one.
  expect((await browserOn(WEBSITE, f.form.publicKey).call('GET')).status).toBe(200);
});

it('serves no form at all on an install without the public intake secret', async () => {
  const f = await business();
  const { publicIntake: _secret, ...without } = config;
  const closed = await start(without, apiRoutes, []);
  try {
    const visitor = browserOn(WEBSITE, f.form.publicKey, closed);
    // Nothing public is mounted: the path belongs to the signed-in API, which asks who
    // is calling before it says whether there is such a path.
    for (const answer of [
      await visitor.call('GET'),
      await visitor.call('POST', '/submissions', { body: {} }),
    ]) {
      expect(answer.status).toBe(401);
      expect(answer.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await fetch(`${closed.address}/forms/embed.js`)).status).toBe(404);
  } finally {
    await closed.stop();
  }
});

/** The header the embed sends from the CRM's own pages, where a browser sends no Origin with a GET. */
const OWN_PAGE = { 'x-crm-form': '1' };
const countsOf = (f: Awaited<ReturnType<typeof business>>) =>
  database.withTenant(f.owner.context, async (sql) => ({
    submissions: (
      await sql.one<{ n: number }>('select count(*)::integer as n from forms.submissions')
    ).n,
    contacts: (await sql.one<{ n: number }>('select count(*)::integer as n from crm.contacts')).n,
    views: (
      await sql.one<{ n: number }>(
        'select coalesce(sum(views), 0)::integer as n from forms.daily_stats',
      )
    ).n,
  }));

it('answers a form’s own page on the CRM’s address, which no website can pass itself off as', async () => {
  const f = await business();
  expect(f.form.hostedUrl).toBe(`${PUBLIC_URL}/f/${f.form.publicKey}`);
  // As a browser asks from the page the CRM serves: no Origin on the GET, and the header.
  const page = browserOn(null, f.form.publicKey);
  const shown = await page.call('GET', '', { headers: OWN_PAGE });
  expect(shown.status).toBe(200);
  expect(shown.headers.get('access-control-allow-origin')).toBe(PUBLIC_URL);
  const form = publicForm.parse(await shown.json());
  await fillTime();
  // With the POST a browser sends the Origin too: the page's own.
  const sent = await browserOn(PUBLIC_URL, f.form.publicKey, app, page.address).call(
    'POST',
    '/submissions',
    {
      headers: OWN_PAGE,
      body: {
        clientSubmissionId: randomUUID(),
        renderToken: form.renderToken,
        values: { email: 'maya@example.test' },
        consents: {},
        trap: '',
        pageUrl: f.form.hostedUrl,
      },
    },
  );
  expect(sent.status).toBe(201);
  const [submission] = formSubmissionList.parse(
    await asTeam(f.invocation, 'listFormSubmissions', { params: { id: f.form.id } }),
  ).items;
  expect(submission).toMatchObject({ origin: PUBLIC_URL, pageUrl: f.form.hostedUrl });

  // No Origin and no header is no website; the header beside another website's Origin
  // changes nothing; and a preflight never allows a website to send the header.
  expect((await browserOn(null, f.form.publicKey).call('GET')).status).toBe(403);
  const elsewhere = await browserOn('https://attacker.example', f.form.publicKey).call('GET', '', {
    headers: OWN_PAGE,
  });
  expect(elsewhere.status).toBe(403);
  expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
  const preflight = await browserOn('https://attacker.example', f.form.publicKey).call(
    'OPTIONS',
    '',
    {
      headers: {
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-crm-form',
      },
    },
  );
  expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
  // Where the embed was not built there is no script, and so no page to put it on.
  expect((await fetch(`${app.address}/f/${f.form.publicKey}`)).status).toBe(404);
});

it('shows the team a draft through a preview link, and stores nothing of what a preview sends', async () => {
  const f = await business();
  // The draft moves on from what is published: it now asks for a phone number too.
  const drafted = formContract.parse(
    await asTeam(f.invocation, 'updateForm', {
      params: { id: f.form.id },
      body: {
        name: f.form.name,
        definition: {
          ...enquiry,
          title: 'The next version',
          fields: [
            ...enquiry.fields,
            { key: 'phone', type: 'phone', label: 'Phone', required: true },
          ],
        },
        allowedOrigins: f.form.allowedOrigins,
        revision: f.form.revision,
      },
    }),
  );
  expect(drafted.hasUnpublishedChanges).toBe(true);
  const preview = formPreview.parse(
    await asTeam(f.invocation, 'getFormPreview', { params: { id: f.form.id } }),
  );
  expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now() + 29 * 60_000);
  const token = preview.url.slice(`${PUBLIC_URL}/f/preview/`.length);
  expect(token).toMatch(/^[A-Za-z0-9_-]{70}\.[A-Za-z0-9_-]{22}$/);
  const before = await countsOf(f);

  const page = browserOn(null, `preview/${token}`);
  const shown = await page.call('GET', '', { headers: OWN_PAGE });
  expect(shown.status).toBe(200);
  expect(shown.headers.get('cache-control')).toBe('no-store');
  const draft = publicForm.parse(await shown.json());
  expect(draft.title).toBe('The next version');
  expect(draft.fields.map((field) => field.key)).toEqual(['first_name', 'email', 'notes', 'phone']);

  // Sent at once: a rehearsal is checked against the draft and nothing waits or is stored.
  const rehearse = (values: Record<string, string>) =>
    browserOn(PUBLIC_URL, `preview/${token}`).call('POST', '/submissions', {
      headers: OWN_PAGE,
      body: {
        clientSubmissionId: randomUUID(),
        renderToken: draft.renderToken,
        values,
        consents: { news: true },
        trap: '',
      },
    });
  const short = await rehearse({ email: 'maya@example.test' });
  expect(short.status).toBe(422);
  expect(await short.json()).toMatchObject({
    errors: [{ path: '/values/phone', code: 'required', message: 'Answer this question.' }],
  });
  const whole = await rehearse({ email: 'maya@example.test', phone: '+254 712 345678' });
  expect(whole.status).toBe(201);
  expect(await whole.json()).toEqual({ status: 'received' });
  // No submission, no contact, and not a view.
  expect(await countsOf(f)).toEqual(before);

  // No website shows a draft, the published form's own included; a link that was changed
  // opens nothing; and neither tells the caller why.
  for (const refused of [
    await browserOn(WEBSITE, `preview/${token}`).call('GET'),
    await browserOn(WEBSITE, `preview/${token}`).call('GET', '', { headers: OWN_PAGE }),
    await browserOn(null, `preview/${token}`).call('GET'),
    await browserOn(null, `preview/${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`).call(
      'GET',
      '',
      { headers: OWN_PAGE },
    ),
    await browserOn(null, 'preview/short').call('GET', '', { headers: OWN_PAGE }),
  ]) {
    expect(refused.status).toBe(403);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    expect(await refused.json()).toMatchObject({ detail: 'This form cannot be used here.' });
  }
});

it('counts each showing of the published form for its numbers, by the business’s own day', async () => {
  const f = await business();
  const visitor = browserOn(WEBSITE, f.form.publicKey);
  const first = await loaded(visitor);
  await loaded(browserOn(WEBSITE, f.form.publicKey));
  await fillTime();
  const sent = await visitor.call('POST', '/submissions', {
    body: first({ email: 'maya@example.test' }),
  });
  expect(sent.status).toBe(201);
  const numbers = formAnalytics.parse(
    await asTeam(f.invocation, 'getFormAnalytics', { params: { id: f.form.id } }),
  );
  expect(numbers.totals).toMatchObject({ views: 2, responses: 1, completionRate: 0.5 });
  // From the form being shown to its being sent: at least the wait this test kept.
  expect(numbers.totals.averageSeconds).toBeGreaterThanOrEqual(FORM_LIMITS.minFillSeconds);
  expect(numbers.totals.averageSeconds).toBeLessThan(60);
  expect(numbers.days.at(-1)).toMatchObject({ date: numbers.to, views: 2, responses: 1 });
});

/** How long a submission may take from the moment nothing holds it back, on any machine. */
const ANSWER_CEILING_MS = 5000;

it('tells a visitor "received" only once the submission is stored, and waits for nothing that happens afterwards', async () => {
  // This server runs no worker (role app): whatever a submission leads to afterwards (a
  // workflow, a notification, an email) cannot run here at all. A request that waited for
  // any of it would never be answered.
  const f = await business();
  const visitor = browserOn(WEBSITE, f.form.publicKey);
  const submission = (await loaded(visitor))({ first_name: 'Noor', email: 'noor@example.test' });
  await fillTime();
  const stored = () =>
    database.as('crm_owner', (sql) =>
      sql.one<{ submissions: number; events: number; jobs: number; started: number }>(
        `select
           (select count(*)::integer from forms.submissions
             where client_submission_id = $1) as submissions,
           (select count(*)::integer from events.events e
             where e.type = 'form.submitted' and e.business_id = $2) as events,
           (select count(*)::integer from graphile_worker.jobs) as jobs,
           (select count(*)::integer from graphile_worker.jobs where attempts > 0) as started`,
        [submission.clientSubmissionId, f.owner.id],
      ),
    );
  const before = await stored();
  expect(before).toMatchObject({ submissions: 0, events: 0 });

  // Someone else holds the form's row: the submission cannot be stored yet.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = (): void => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = database.as('crm_owner', async (sql) => {
    await sql.query('select id from forms.forms where public_key = $1 for update', [
      f.form.publicKey,
    ]);
    locked();
    await held;
  });
  await isLocked;
  let answered = false;
  const sending = visitor.call('POST', '/submissions', { body: submission }).then((response) => {
    answered = true;
    return response;
  });
  await sleep(500);
  // Not stored, so not answered: nobody is told "received" for a row that is not there.
  expect(answered).toBe(false);
  expect(await stored()).toMatchObject({ submissions: 0, events: 0 });

  const freed = performance.now();
  release();
  await holder;
  const response = await sending;
  const took = performance.now() - freed;
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ status: 'received' });
  // The moment the answer is here, the submission and its event are committed: read by
  // another connection, with nothing waited for in between.
  const after = await stored();
  expect(after).toMatchObject({ submissions: 1, events: 1, started: 0 });
  // What follows is queued for the worker, and none of it has run: no worker is here.
  expect(after.jobs).toBeGreaterThan(before.jobs);
  expect(took).toBeLessThan(ANSWER_CEILING_MS);
});

it('stores a submission once however often and however close together it is sent', async () => {
  const f = await business();
  const visitor = browserOn(WEBSITE, f.form.publicKey);
  const submission = (await loaded(visitor))({ first_name: 'Ife', email: 'ife@example.test' });
  await fillTime();
  // A double click and a retry after a lost answer, from the same browser, at once, and
  // two more retries after those. (Three at once: this server's limiter asks the database
  // about three requests at a time, with its pool of four, and refuses a fourth outright.)
  const send = () => visitor.call('POST', '/submissions', { body: submission });
  const answers = [...(await Promise.all([send(), send(), send()])), await send(), await send()];
  for (const answer of answers) {
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ status: 'received' });
  }
  const counts = await database.as('crm_owner', (sql) =>
    sql.one<{ submissions: number; contacts: number; events: number }>(
      `select
         (select count(*)::integer from forms.submissions where business_id = $1) as submissions,
         (select count(*)::integer from crm.contacts where business_id = $1) as contacts,
         (select count(*)::integer from events.events
           where business_id = $1 and type = 'form.submitted') as events`,
      [f.owner.id],
    ),
  );
  // One submission, one contact, one event: a workflow that starts on the form starts once.
  expect(counts).toEqual({ submissions: 1, contacts: 1, events: 1 });
  // The same id with other answers is not the same submission, and is not stored over it.
  const changed = await visitor.call('POST', '/submissions', {
    body: { ...submission, values: { first_name: 'Other', email: 'other@example.test' } },
  });
  expect(changed.status).toBe(409);
});

it('takes a protected form only with a real ALTCHA proof solved for its showing', async () => {
  const f = await business();
  const saved = formContract.parse(
    await asTeam(f.invocation, 'getForm', { params: { id: f.form.id } }),
  );
  const updated = formContract.parse(
    await asTeam(f.invocation, 'updateForm', {
      params: { id: saved.id },
      body: {
        name: saved.name,
        definition: { ...enquiry, botProtection: 'altcha' },
        allowedOrigins: [WEBSITE],
        revision: saved.revision,
      },
    }),
  );
  await asTeam(f.invocation, 'publishForm', {
    params: { id: updated.id },
    body: { revision: updated.revision },
  });
  const maya = browserOn(WEBSITE, f.form.publicKey);
  const shown = publicForm.parse(await (await maya.call('GET')).json());
  expect(shown.botProtection).toBe('altcha');
  const asked = await maya.call('POST', '/challenge', { body: { renderToken: shown.renderToken } });
  expect(asked.status).toBe(200);
  expect(asked.headers.get('access-control-allow-origin')).toBe(WEBSITE);
  const view = botChallenge.parse(await asked.json());
  const solution = await solveChallenge({
    challenge: toAltchaChallenge(view.challenge),
    deriveKey,
  });
  if (solution === null) throw new Error('Expected a solution.');
  await fillTime();
  const body = {
    clientSubmissionId: randomUUID(),
    renderToken: shown.renderToken,
    values: { email: 'maya@example.test' },
    consents: {},
    trap: '',
  };
  expect((await maya.call('POST', '/submissions', { body })).status).toBe(409);
  const proof = { kind: 'altcha', challenge: view.challenge, solution };
  expect(
    (
      await maya.call('POST', '/submissions', {
        body: { ...body, clientSubmissionId: randomUUID(), botProof: proof },
      })
    ).status,
  ).toBe(201);
  // Spent with its showing: refused the second time.
  expect(
    (
      await maya.call('POST', '/submissions', {
        body: { ...body, clientSubmissionId: randomUUID(), botProof: proof },
      })
    ).status,
  ).toBe(409);
  // Another visitor cannot get a challenge with Maya's token.
  const other = browserOn(WEBSITE, f.form.publicKey);
  expect(
    (await other.call('POST', '/challenge', { body: { renderToken: shown.renderToken } })).status,
  ).toBe(409);
});
