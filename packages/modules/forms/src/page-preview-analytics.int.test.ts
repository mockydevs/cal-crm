// A form's own page, the preview of its draft, and its numbers, against Postgres: the
// CRM's own address as a website every published form answers, a link that shows a draft
// and stores nothing, and the views and time to complete counted by day.
import { randomUUID } from 'node:crypto';

import { allowEveryone } from '@repo/commands';
import {
  FORM_LIMITS,
  form as formContract,
  formAnalytics,
  formPreview,
  publicForm,
  type Form,
  type FormDefinitionInput,
} from '@repo/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';

import {
  formSuite,
  PUBLIC_URL,
  SECRET,
  settled,
  WEBSITE,
  type FormFixture,
} from '../test/form-fixtures.js';
import {
  createFormRoutes,
  createPublicFormHandlers,
  ownOrigin,
  type PublicFormHandlers,
} from './index.js';

const suite = formSuite();
const { fixture, admin, published } = suite;
let database: TestDatabase;
/** The handlers as the server mounts them: knowing the CRM's own address. */
let hosted: PublicFormHandlers;
let clock = Date.parse('2026-10-12T09:00:00.000Z');
beforeAll(() => {
  database = suite.database;
  hosted = createPublicFormHandlers({
    db: suite.db,
    secret: SECRET,
    publicUrl: `${PUBLIC_URL}/`,
    now: () => clock,
  });
});

const OWN = 'https://crm.example.test';
const OK = { outcome: 'ok', receipt: { status: 'received' } };
const NOTHING = { submissions: 0, contacts: 0, consents: 0, events: 0 };
const email = {
  key: 'email',
  type: 'email',
  label: 'Email',
  required: true,
  target: { kind: 'contact', attribute: 'email' },
} as const;
const asked = { fields: [email] } satisfies FormDefinitionInput;

/** An admin route as the server serves it: able to make preview links. */
const route = async (
  f: FormFixture,
  operationId: string,
  input: { readonly params?: unknown; readonly query?: unknown } = {},
  options: Parameters<typeof createFormRoutes>[1] = { previewSecret: SECRET, now: () => clock },
) => {
  const found = createFormRoutes(PUBLIC_URL, options).find(
    (candidate) => candidate.endpoint.operationId === operationId,
  );
  if (found === undefined) throw new Error(`Missing ${operationId} route.`);
  return found.run(
    {
      invocation: { ...f.manager, context: { ...f.manager.context, correlationId: randomUUID() } },
      params: input.params ?? {},
      query: input.query ?? {},
      body: undefined,
    },
    { db: suite.db, authorize: allowEveryone },
  );
};
const refusal = async (work: () => Promise<unknown>): Promise<unknown> => {
  const result = await settled(Promise.resolve().then(work));
  return result.ok ? undefined : result.error;
};
const tokenOf = (url: string): string => url.slice(`${PUBLIC_URL}/f/preview/`.length);
const statsOf = (f: FormFixture) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ views: number; timed_submissions: number; fill_seconds: number }>(
      'select views, timed_submissions, fill_seconds from forms.daily_stats order by form_id, day',
    ),
  );
const sendTo = async (
  handlers: PublicFormHandlers,
  form: Pick<Form, 'publicKey'>,
  origin: string,
  values: Readonly<Record<string, string | boolean>>,
  after = 3000,
  pageUrl?: string,
) => {
  const admission = await handlers.admit(form.publicKey, origin);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await handlers.form(admission, suite.visitor());
  if (shown.outcome !== 'ok') throw new Error(`Not shown: ${shown.outcome}.`);
  clock += after;
  return handlers.submit(
    admission,
    {
      clientSubmissionId: randomUUID(),
      renderToken: shown.form.renderToken,
      values,
      consents: {},
      trap: '',
      ...(pageUrl === undefined ? {} : { pageUrl }),
    },
    suite.visitor(),
  );
};

it('knows the CRM’s own origin only when its address is a secure one', () => {
  expect(ownOrigin(`${PUBLIC_URL}/`)).toBe(OWN);
  expect(ownOrigin('https://CRM.example.test:443/dashboard?x=1')).toBe(OWN);
  expect(ownOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  for (const address of [undefined, '', 'not an address', 'http://crm.example.test'])
    expect(ownOrigin(address)).toBeUndefined();
});

it('answers every published form from the CRM’s own address, with no website listed', async () => {
  const f = await fixture();
  // No website at all: the form's own page is where it is shown.
  const form = await published(f, asked, []);
  expect(form).toMatchObject({ status: 'published', allowedOrigins: [], problems: [] });
  expect(form.hostedUrl).toBe(`${PUBLIC_URL}/f/${form.publicKey}`);
  const admission = await hosted.admit(form.publicKey, OWN);
  expect(admission).toEqual({
    agencyId: f.agency.id,
    businessId: f.business.id,
    formId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
    origin: OWN,
  });
  // Nowhere else: a form lists the websites it is on, and this one lists none.
  for (const origin of [WEBSITE, `${OWN}/`, 'https://crm.example.test.attacker.test', undefined])
    expect(await hosted.admit(form.publicKey, origin)).toBeUndefined();
  // Handlers that were not told the CRM's address know no such website.
  expect(await suite.handlers.admit(form.publicKey, OWN)).toBeUndefined();

  expect(
    await sendTo(hosted, form, OWN, { email: 'maya@example.test' }, 3000, form.hostedUrl),
  ).toEqual(OK);
  const [stored] = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ origin: string; page_url: string | null; contact_outcome: string }>(
      'select origin, page_url, contact_outcome from forms.submissions',
    ),
  );
  expect(stored).toEqual({ origin: OWN, page_url: form.hostedUrl, contact_outcome: 'created' });

  // A form that lists a website answers both, and stops answering either when unpublished.
  const both = await published(f, asked, [WEBSITE]);
  expect((await hosted.admit(both.publicKey, WEBSITE))?.origin).toBe(WEBSITE);
  expect((await hosted.admit(both.publicKey, OWN))?.origin).toBe(OWN);
  await admin(f, 'unpublishForm', { params: { id: both.id }, body: { revision: both.revision } });
  for (const origin of [WEBSITE, OWN])
    expect(await hosted.admit(both.publicKey, origin)).toBeUndefined();
});

it('gives anyone in the business a link to the draft that works for half an hour', async () => {
  const f = await fixture();
  const draft = formContract.parse(await admin(f, 'createForm', { body: { name: 'Enquiry' } }));
  const preview = formPreview.parse(await route(f, 'getFormPreview', { params: { id: draft.id } }));
  expect(preview.url).toMatch(
    new RegExp(`^${PUBLIC_URL}/f/preview/[A-Za-z0-9_-]{70}\\.[A-Za-z0-9_-]{22}$`),
  );
  expect(FORM_LIMITS.previewMinutes).toBe(30);
  expect(Date.parse(preview.expiresAt)).toBe(clock + 30 * 60_000);
  // Someone who may only read the form may preview it: it shows what they can read anyway.
  const reader = { ...f.manager, permissions: new Set<never>() };
  expect(
    formPreview.safeParse(
      await createFormRoutes(PUBLIC_URL, { previewSecret: SECRET, now: () => clock })
        .find((each) => each.endpoint.operationId === 'getFormPreview')
        ?.run(
          { invocation: reader, params: { id: draft.id }, query: {}, body: undefined },
          { db: suite.db, authorize: allowEveryone },
        ),
    ).success,
  ).toBe(true);
  // Asking changes nothing about the form.
  expect(formContract.parse(await admin(f, 'getForm', { params: { id: draft.id } }))).toEqual(
    draft,
  );

  expect(
    await refusal(() =>
      route(f, 'getFormPreview', { params: { id: 'form_01m4pj3kgse20be8n77rqy0jwz' } }),
    ),
  ).toBeInstanceOf(NotFoundError);
  const other = await fixture();
  expect(
    await refusal(() => route(other, 'getFormPreview', { params: { id: draft.id } })),
  ).toBeInstanceOf(NotFoundError);
  // An install with no public intake secret serves no public form, so it has no preview.
  expect(
    await refusal(() => route(f, 'getFormPreview', { params: { id: draft.id } }, {})),
  ).toBeInstanceOf(ConflictError);
  const archived = formContract.parse(
    await admin(f, 'archiveForm', { params: { id: draft.id }, body: { revision: draft.revision } }),
  );
  expect(archived.status).toBe('archived');
  expect(
    await refusal(() => route(f, 'getFormPreview', { params: { id: draft.id } })),
  ).toBeInstanceOf(ConflictError);
});

it('shows a preview the draft, on the CRM’s own address only, and stores nothing of what is sent', async () => {
  const f = await fixture();
  // Published asking for an email address; the draft since asks for a name too, required.
  const live = await published(f, asked, [WEBSITE]);
  const drafted = formContract.parse(
    await admin(f, 'updateForm', {
      params: { id: live.id },
      body: {
        name: live.name,
        definition: {
          title: 'The next version',
          fields: [
            email,
            {
              key: 'first_name',
              type: 'text',
              label: 'First name',
              required: true,
              target: { kind: 'contact', attribute: 'firstName' },
            },
          ],
          contactActions: { source: { kind: 'form_name' } },
        },
        allowedOrigins: live.allowedOrigins,
        revision: live.revision,
      },
    }),
  );
  expect(drafted.hasUnpublishedChanges).toBe(true);
  const { url } = formPreview.parse(await route(f, 'getFormPreview', { params: { id: live.id } }));
  const token = tokenOf(url);

  const admission = await hosted.admitPreview(token, OWN);
  expect(admission).toEqual({
    agencyId: f.agency.id,
    businessId: f.business.id,
    formId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
    origin: OWN,
    preview: true,
  });
  if (admission === undefined) throw new Error('Not admitted.');
  // No website shows a draft, however well the form lists it; and neither does a link
  // that was changed, one of another server, or handlers that know no address of their own.
  for (const origin of [WEBSITE, undefined, 'null', `${OWN}/`])
    expect(await hosted.admitPreview(token, origin)).toBeUndefined();
  for (const changed of [`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, 'short', ''])
    expect(await hosted.admitPreview(changed, OWN)).toBeUndefined();
  const stranger = createPublicFormHandlers({
    db: suite.db,
    secret: 'another-install-secret-of-at-least-32-bytes',
    publicUrl: PUBLIC_URL,
    now: () => clock,
  });
  expect(await stranger.admitPreview(token, OWN)).toBeUndefined();
  expect(await suite.handlers.admitPreview(token, OWN)).toBeUndefined();

  const before = await statsOf(f);
  const shown = await hosted.form(admission, suite.visitor());
  if (shown.outcome !== 'ok') throw new Error(`Not shown: ${shown.outcome}.`);
  const view = publicForm.parse(shown.form);
  expect(view.title).toBe('The next version');
  expect(view.fields.map((field) => field.key)).toEqual(['email', 'first_name']);
  // What websites are served is still what was published.
  const website = await hosted.admit(live.publicKey, WEBSITE);
  if (website === undefined) throw new Error('Not admitted.');
  const served = await hosted.form(website, suite.visitor());
  expect(served.outcome === 'ok' ? served.form.fields.map((field) => field.key) : []).toEqual([
    'email',
  ]);

  // Sending a preview checks the answers against the draft, at once, and writes nothing.
  const rehearse = (values: Readonly<Record<string, string>>) =>
    hosted.submit(
      admission,
      {
        clientSubmissionId: randomUUID(),
        renderToken: shown.form.renderToken,
        values,
        consents: {},
        trap: '',
      },
      suite.visitor(),
    );
  expect(await rehearse({ email: 'maya@example.test' })).toMatchObject({
    outcome: 'invalid',
    issues: [{ path: '/values/first_name', code: 'required' }],
  });
  expect(await rehearse({ email: 'maya@example.test', first_name: 'Maya' })).toEqual(OK);
  // The same again is the same answer: there is no stored submission for it to repeat.
  expect(await rehearse({ email: 'maya@example.test', first_name: 'Maya' })).toEqual(OK);
  expect(await suite.stored(f)).toEqual(NOTHING);
  const left = await database.withTenant(f.business.context, async (sql) => ({
    tags: (await sql.one<{ n: number }>('select count(*)::integer as n from crm.record_tags')).n,
    events: (
      await sql.one<{ n: number }>(
        "select count(*)::integer as n from events.events where type like 'contact.%' or type = 'form.submitted'",
      )
    ).n,
  }));
  expect(left).toEqual({ tags: 0, events: 0 });
  // A preview is not a view: only the website's own load was counted.
  expect(await statsOf(f)).toEqual([
    { views: (before[0]?.views ?? 0) + 1, timed_submissions: 0, fill_seconds: 0 },
  ]);

  // The link runs out by itself, and stops with the form.
  clock += 30 * 60_000;
  expect(await hosted.admitPreview(token, OWN)).toBeUndefined();
  const fresh = tokenOf(
    formPreview.parse(await route(f, 'getFormPreview', { params: { id: live.id } })).url,
  );
  expect(await hosted.admitPreview(fresh, OWN)).toBeDefined();
  await admin(f, 'archiveForm', { params: { id: live.id }, body: { revision: drafted.revision } });
  expect(await hosted.admitPreview(fresh, OWN)).toBeUndefined();
  expect(await hosted.form(admission, suite.visitor())).toEqual({ outcome: 'unavailable' });
  expect(await rehearse({ email: 'maya@example.test', first_name: 'Maya' })).toEqual({
    outcome: 'unavailable',
  });
});

it('previews a form that was never published', async () => {
  const f = await fixture();
  const draft = formContract.parse(await admin(f, 'createForm', { body: { name: 'Enquiry' } }));
  const token = tokenOf(
    formPreview.parse(await route(f, 'getFormPreview', { params: { id: draft.id } })).url,
  );
  // Its key opens nothing: it is not published.
  expect(await hosted.admit(draft.publicKey, OWN)).toBeUndefined();
  const admission = await hosted.admitPreview(token, OWN);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await hosted.form(admission, suite.visitor());
  expect(shown.outcome === 'ok' ? shown.form.fields.map((field) => field.key) : []).toEqual([
    'first_name',
    'email',
  ]);
  expect(await statsOf(f)).toEqual([]);
});

it('counts a view each time the published form is shown, and times each submission from then', async () => {
  const f = await fixture();
  const form = await published(f, asked, [WEBSITE]);
  const quiet = await published(f, asked, [WEBSITE]);
  // Shown three times and sent twice, one in three seconds and one in nine.
  expect(await sendTo(hosted, form, WEBSITE, { email: 'maya@example.test' }, 3000)).toEqual(OK);
  expect(await sendTo(hosted, form, OWN, { email: 'omar@example.test' }, 9000)).toEqual(OK);
  const looked = await hosted.admit(form.publicKey, WEBSITE);
  if (looked === undefined) throw new Error('Not admitted.');
  await hosted.form(looked, suite.visitor());
  // What is refused is not timed: sent too soon, and with answers that do not fit.
  expect(await sendTo(hosted, form, WEBSITE, { email: 'dana@example.test' }, 500)).toMatchObject({
    outcome: 'limited',
  });
  expect(await sendTo(hosted, form, WEBSITE, { email: 'not an address' }, 3000)).toMatchObject({
    outcome: 'invalid',
  });
  expect(await statsOf(f)).toEqual([{ views: 5, timed_submissions: 2, fill_seconds: 12 }]);

  const numbers = formAnalytics.parse(
    await route(f, 'getFormAnalytics', { params: { id: form.id } }),
  );
  expect(numbers.totals).toEqual({
    views: 5,
    responses: 2,
    completionRate: 0.4,
    averageSeconds: 6,
  });
  // Thirty days ending today in the business's time zone, the last of them today's.
  expect(numbers.days).toHaveLength(30);
  expect(numbers.days.at(-1)).toEqual({
    date: numbers.to,
    views: 5,
    responses: 2,
    completionRate: 0.4,
    averageSeconds: 6,
  });
  for (const day of numbers.days.slice(0, -1))
    expect(day).toMatchObject({
      views: 0,
      responses: 0,
      completionRate: null,
      averageSeconds: null,
    });
  const zone = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ time_zone: string; today: string }>(
      `select b.timezone as time_zone, to_char((now() at time zone b.timezone)::date, 'YYYY-MM-DD') as today
       from tenancy.businesses b where b.id = app.business_id()`,
    ),
  );
  expect(numbers).toMatchObject({ to: zone.today, timeZone: zone.time_zone });

  // One day asked for by name; another form's numbers are its own.
  const today = formAnalytics.parse(
    await route(f, 'getFormAnalytics', {
      params: { id: form.id },
      query: { from: zone.today, to: zone.today },
    }),
  );
  expect(today.days).toEqual([numbers.days.at(-1)]);
  expect(
    formAnalytics.parse(await route(f, 'getFormAnalytics', { params: { id: quiet.id } })).totals,
  ).toEqual({ views: 0, responses: 0, completionRate: null, averageSeconds: null });

  // Shown once and sent once: everyone who saw it sent it.
  const later = await published(
    f,
    { fields: [{ key: 'note', type: 'text', label: 'Note' }, email] },
    [WEBSITE],
  );
  expect(await sendTo(hosted, later, WEBSITE, { email: 'maya@example.test' }, 4000)).toEqual(OK);
  expect(
    formAnalytics.parse(await route(f, 'getFormAnalytics', { params: { id: later.id } })).totals,
  ).toEqual({ views: 1, responses: 1, completionRate: 1, averageSeconds: 4 });
});

it('reads numbers for a form of the business only, over a range it can read at once', async () => {
  const f = await fixture();
  const form = await published(f, asked, [WEBSITE]);
  const other = await fixture();
  expect(
    await refusal(() => route(other, 'getFormAnalytics', { params: { id: form.id } })),
  ).toBeInstanceOf(NotFoundError);
  expect(
    await refusal(() =>
      route(f, 'getFormAnalytics', { params: { id: 'form_01m4pj3kgse20be8n77rqy0jwz' } }),
    ),
  ).toBeInstanceOf(NotFoundError);
  for (const query of [
    { from: '2026-10-12', to: '2026-10-11' },
    { from: '2020-01-01', to: '2026-10-12' },
    // A first day long before today, with the last left to be today.
    { from: '2020-01-01' },
    // A first day after today.
    { from: '2999-01-01' },
    { from: 'yesterday' },
  ])
    expect(
      await refusal(() => route(f, 'getFormAnalytics', { params: { id: form.id }, query })),
      JSON.stringify(query),
    ).toBeInstanceOf(ValidationError);
  const year = formAnalytics.parse(
    await route(f, 'getFormAnalytics', {
      params: { id: form.id },
      query: { from: '2025-10-12', to: '2026-10-12' },
    }),
  );
  expect(year.days).toHaveLength(366);
  expect(year.totals).toEqual({
    views: 0,
    responses: 0,
    completionRate: null,
    averageSeconds: null,
  });
});
