// The public side of forms against Postgres: the gate, what a website is shown, and a
// submission into a contact, through the handlers the server mounts.
import { randomUUID } from 'node:crypto';

import {
  contact as contactContract,
  DEFAULT_FORM_DEFINITION,
  FORM_LIMITS,
  form as formContract,
  formSubmissionList,
  publicForm,
  recordFields,
  type Form,
  type FormDefinitionInput,
} from '@repo/contracts';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { crmRoutes } from '@repo/module-crm';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';

import {
  formSuite,
  SECRET,
  settled,
  untilWaiting,
  WEBSITE,
  type FormFixture,
} from '../test/form-fixtures.js';
import { createPublicFormHandlers } from './index.js';
import { issueRenderToken } from './render-token.js';

const suite = formSuite();
const { fixture, admin, published, field, submit, stored, visitor } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

const OK = { outcome: 'ok', receipt: { status: 'received' } };
const NOTHING = { submissions: 0, contacts: 0, consents: 0, events: 0 };

/** A form that asks for everything a contact has, a custom field of each kind, and consent. */
async function enquiry(f: FormFixture) {
  const budget = await field(f, 'budget', 'number');
  const venue = await field(f, 'venue', 'single_choice', ['harbor', 'garden']);
  const day = await field(f, 'event_day', 'date');
  const planner = await field(f, 'has_planner', 'boolean');
  const notes = await field(f, 'notes', 'long_text');
  const definition = {
    title: 'Plan your event',
    fields: [
      {
        key: 'first_name',
        type: 'text',
        label: 'First name',
        target: { kind: 'contact', attribute: 'firstName' },
      },
      {
        key: 'last_name',
        type: 'text',
        label: 'Last name',
        target: { kind: 'contact', attribute: 'lastName' },
      },
      {
        key: 'email',
        type: 'email',
        label: 'Email',
        required: true,
        target: { kind: 'contact', attribute: 'email' },
      },
      {
        key: 'phone',
        type: 'phone',
        label: 'Phone',
        target: { kind: 'contact', attribute: 'phone' },
      },
      {
        key: 'budget',
        type: 'number',
        label: 'Budget',
        target: { kind: 'field', fieldId: budget.id },
      },
      {
        key: 'venue',
        type: 'single_choice',
        label: 'Venue',
        options: [
          { key: 'harbor', label: 'Harbor room' },
          { key: 'garden', label: 'Garden' },
        ],
        target: { kind: 'field', fieldId: venue.id },
      },
      { key: 'day', type: 'date', label: 'Event date', target: { kind: 'field', fieldId: day.id } },
      {
        key: 'planner',
        type: 'checkbox',
        label: 'I have a planner',
        target: { kind: 'field', fieldId: planner.id },
      },
      {
        key: 'notes',
        type: 'long_text',
        label: 'Anything else?',
        target: { kind: 'field', fieldId: notes.id },
      },
      { key: 'heard', type: 'text', label: 'How did you hear about us?' },
    ],
    consents: [
      { key: 'news', channel: 'email', wording: 'Email me news and offers.' },
      { key: 'texts', channel: 'sms', wording: 'Text me offers.' },
    ],
  } satisfies FormDefinitionInput;
  return { form: await published(f, definition), fields: { budget, venue, day, planner, notes } };
}

const crm = async (f: FormFixture, operationId: string, params: Record<string, string>) => {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run(
    { invocation: f.manager, params, query: {}, body: undefined },
    { db: suite.db, authorize: () => true },
  );
};
const contactsOf = (f: FormFixture) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ id: string; first_name: string | null; last_name: string | null }>(
      'select id, first_name, last_name from crm.contacts order by id',
    ),
  );
const submissionsOf = async (f: FormFixture, form: Pick<Form, 'id'>) =>
  formSubmissionList.parse(await admin(f, 'listFormSubmissions', { params: { id: form.id } }));

it('admits only a published form of an active business, for a website on its list, by its exact key', async () => {
  const f = await fixture();
  const live = await published(f, DEFAULT_FORM_DEFINITION, [WEBSITE, 'https://shop.example.com']);
  const { handlers } = suite;
  const admitted = await handlers.admit(live.publicKey, WEBSITE);
  expect(admitted).toEqual({
    agencyId: f.agency.id,
    businessId: f.business.id,
    formId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
    origin: WEBSITE,
  });
  expect((await handlers.admit(live.publicKey, 'https://shop.example.com'))?.origin).toBe(
    'https://shop.example.com',
  );
  // Anything that is not exactly a listed website, as a browser writes it, is refused.
  for (const origin of [
    undefined,
    null,
    '',
    'null',
    'https://www.example.com/',
    'https://WWW.example.com',
    'http://www.example.com',
    'https://www.example.com:8443',
    'https://example.com',
    'https://www.example.com.attacker.test',
    'https://attacker.test',
    [WEBSITE],
    `${WEBSITE},https://attacker.test`,
  ])
    expect(await handlers.admit(live.publicKey, origin)).toBeUndefined();
  for (const key of [
    '',
    'short',
    `${live.publicKey}x`,
    live.publicKey.slice(1),
    'k'.repeat(32),
    '%',
  ])
    expect(await handlers.admit(key, WEBSITE)).toBeUndefined();

  // Another business's form is another key; its websites are its own.
  const other = await fixture();
  const theirs = await published(other, DEFAULT_FORM_DEFINITION, ['https://theirs.example.com']);
  expect(await handlers.admit(theirs.publicKey, WEBSITE)).toBeUndefined();

  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [f.business.id]),
  );
  expect(await handlers.admit(live.publicKey, WEBSITE)).toBeUndefined();
  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='active' where id=$1", [f.business.id]),
  );
  for (const operationId of ['unpublishForm', 'archiveForm'] as const) {
    const current = formContract.parse(await admin(f, 'getForm', { params: { id: live.id } }));
    const republished =
      current.status === 'published'
        ? current
        : formContract.parse(
            await admin(f, 'publishForm', {
              params: { id: live.id },
              body: { revision: current.revision },
            }),
          );
    expect(await handlers.admit(live.publicKey, WEBSITE)).toBeDefined();
    await admin(f, operationId, {
      params: { id: live.id },
      body: { revision: republished.revision },
    });
    expect(await handlers.admit(live.publicKey, WEBSITE)).toBeUndefined();
  }
});

it('shows an admitted website the published questions and a token, and never the draft or a mapping', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  // An edit that is not published yet must not reach a website.
  await admin(f, 'updateForm', {
    params: { id: form.id },
    body: {
      name: form.name,
      definition: { ...DEFAULT_FORM_DEFINITION, title: 'Unfinished draft' },
      allowedOrigins: form.allowedOrigins,
      revision: form.revision,
    },
  });
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(admission, visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  // The strict public contract: a view with anything more would not parse.
  expect(publicForm.parse(shown.form)).toEqual(shown.form);
  expect(shown.form.title).toBe('Plan your event');
  expect(shown.form.fields.map((each) => [each.key, each.type, each.required])).toEqual([
    ['first_name', 'text', false],
    ['last_name', 'text', false],
    ['email', 'email', true],
    ['phone', 'phone', false],
    ['budget', 'number', false],
    ['venue', 'single_choice', false],
    ['day', 'date', false],
    ['planner', 'checkbox', false],
    ['notes', 'long_text', false],
    ['heard', 'text', false],
  ]);
  expect(shown.form.consents).toEqual([
    { key: 'news', wording: 'Email me news and offers.', required: false },
    { key: 'texts', wording: 'Text me offers.', required: false },
  ]);
  expect(JSON.stringify(shown.form)).not.toMatch(/fld_|target|fieldId|attribute|channel/);
  // A request that was admitted and then lost its place is told nothing.
  for (const tampered of [
    { ...admission, origin: 'https://attacker.test' },
    { ...admission, formId: randomUUID() },
  ])
    expect(await suite.handlers.form(tampered, visitor())).toEqual({ outcome: 'unavailable' });
  const other = await fixture();
  expect(
    await suite.handlers.form(
      { ...admission, agencyId: other.agency.id, businessId: other.business.id },
      visitor(),
    ),
  ).toEqual({ outcome: 'unavailable' });
});

it('makes a contact from a submission: its details, its custom fields, its consent with proof, and one event', async () => {
  const f = await fixture();
  const { form, fields } = await enquiry(f);
  const sent = await submit(
    form,
    {
      first_name: ' Maya ',
      last_name: 'Thompson',
      email: 'Maya.Thompson@Example.test',
      phone: '+254 712 345678',
      budget: '250000.50',
      venue: 'garden',
      day: '2027-06-12',
      planner: true,
      notes: 'Outdoor ceremony.\n<script>alert(1)</script>',
      heard: 'A friend',
    },
    {
      consents: { news: true, texts: true },
      pageUrl: `${WEBSITE}/weddings/enquire?utm_source=newsletter&utm_campaign=spring&email=leak@example.test#form`,
      visitor: { ipAddress: '198.51.100.24', userAgent: 'Browser/2.0' },
    },
  );
  expect(sent.result).toEqual(OK);
  expect(await stored(f)).toEqual({ submissions: 1, contacts: 1, consents: 2, events: 1 });

  const [made] = await contactsOf(f);
  if (made === undefined) throw new Error('No contact was made.');
  const id = toPublicId('contact', made.id);
  expect(contactContract.parse(await crm(f, 'getContact', { id }))).toMatchObject({
    firstName: 'Maya',
    lastName: 'Thompson',
    emails: ['maya.thompson@example.test'],
    phones: [{ number: '+254712345678' }],
  });
  // Each mapped answer is the contact's field value, typed, and says a form set it.
  const values = recordFields.parse(await crm(f, 'getRecordFields', { id })).items;
  const valueOf = (fieldId: string) => values.find((value) => value.definition.id === fieldId);
  expect(valueOf(fields.budget.id)?.value).toBe('250000.50');
  expect(valueOf(fields.venue.id)?.value).toBe('garden');
  expect(valueOf(fields.day.id)?.value).toBe('2027-06-12');
  expect(valueOf(fields.planner.id)?.value).toBe(true);
  expect(valueOf(fields.notes.id)?.value).toBe('Outdoor ceremony.\n<script>alert(1)</script>');
  expect(values.filter((value) => value.value !== null).map((value) => value.source?.kind)).toEqual(
    ['form', 'form', 'form', 'form', 'form'],
  );

  const [submission] = (await submissionsOf(f, form)).items;
  if (submission === undefined) throw new Error('No submission is listed.');
  expect(submission).toMatchObject({
    contactId: id,
    contactOutcome: 'created',
    skippedFields: [],
    origin: WEBSITE,
    // The page without its query, which held someone's address; the labels read out of it.
    pageUrl: `${WEBSITE}/weddings/enquire`,
    utm: { source: 'newsletter', campaign: 'spring' },
    ipAddress: '198.51.100.24',
    consents: [
      { key: 'news', channel: 'email', wording: 'Email me news and offers.', outcome: 'granted' },
      { key: 'texts', channel: 'sms', wording: 'Text me offers.', outcome: 'granted' },
    ],
  });
  expect(submission.answers).toEqual([
    { key: 'first_name', label: 'First name', value: 'Maya' },
    { key: 'last_name', label: 'Last name', value: 'Thompson' },
    { key: 'email', label: 'Email', value: 'maya.thompson@example.test' },
    { key: 'phone', label: 'Phone', value: '+254 712 345678' },
    { key: 'budget', label: 'Budget', value: '250000.50' },
    { key: 'venue', label: 'Venue', value: 'garden' },
    { key: 'day', label: 'Event date', value: '2027-06-12' },
    { key: 'planner', label: 'I have a planner', value: true },
    {
      key: 'notes',
      label: 'Anything else?',
      value: 'Outdoor ceremony.\n<script>alert(1)</script>',
    },
    { key: 'heard', label: 'How did you hear about us?', value: 'A friend' },
  ]);

  // Consent proof: the form, the submission, the wording, the address the server saw.
  const ledger = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ channel: string; status: string; source: string; proof: Record<string, string> }>(
      'select channel, purpose, status, source, proof, recorded_by_kind from messaging.consents order by channel',
    ),
  );
  expect(ledger).toEqual([
    {
      channel: 'email',
      purpose: 'marketing',
      status: 'granted',
      source: 'form',
      recorded_by_kind: 'contact',
      proof: {
        wording: 'Email me news and offers.',
        formId: sent.admission.formId,
        submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        ipAddress: '198.51.100.24',
        pageUrl: `${WEBSITE}/weddings/enquire`,
        userAgent: 'Browser/2.0',
      },
    },
    {
      channel: 'sms',
      purpose: 'marketing',
      status: 'granted',
      source: 'form',
      recorded_by_kind: 'contact',
      proof: expect.objectContaining({
        wording: 'Text me offers.',
        formId: sent.admission.formId,
        ipAddress: '198.51.100.24',
      }) as Record<string, string>,
    },
  ]);

  // One event, by the form, on the contact's timeline, carrying ids and no answer.
  const events = await database.withTenant(f.business.context, (sql) =>
    sql.query<{
      id: string;
      actor_kind: string;
      actor_id: string;
      subject_kind: string;
      payload: Record<string, string>;
      on_timeline: string[];
    }>(
      `select e.id, e.actor_kind, e.actor_id, e.subject_kind, e.payload,
              array(select t.record_id::text from crm.timeline_entries t where t.event_id = e.id) as on_timeline
       from events.events e where e.type = 'form.submitted'`,
    ),
  );
  expect(events).toEqual([
    {
      id: expect.any(String) as string,
      actor_kind: 'form',
      actor_id: sent.admission.formId,
      subject_kind: 'form_submission',
      payload: {
        formId: sent.admission.formId,
        submissionId: ledger[0]?.proof['submissionId'],
        contactId: made.id,
      },
      on_timeline: [made.id],
    },
  ]);
  // Nothing a visitor typed, and no address, is in the audit log or in any event.
  const kept = await database.as('crm_owner', (sql) =>
    sql.query<{ text: string }>(
      `select input::text as text from audit.commands where command = 'forms.submit' and business_id = $1
       union all select payload::text from events.events where business_id = $1`,
      [f.business.id],
    ),
  );
  expect(kept.length).toBeGreaterThan(5);
  for (const row of kept)
    expect(row.text).not.toMatch(/maya|thompson|712|198\.51\.100|Outdoor|friend|250000/i);
  const [audited] = await database.as('crm_owner', (sql) =>
    sql.query<{ input: unknown; actor_kind: string; ip: string | null; outcome: string }>(
      "select input, actor_kind, ip::text as ip, outcome from audit.commands where command = 'forms.submit' and business_id = $1",
      [f.business.id],
    ),
  );
  expect(audited).toEqual({
    input: {
      formId: sent.admission.formId,
      origin: WEBSITE,
      clientSubmissionId: sent.input.clientSubmissionId,
    },
    actor_kind: 'form',
    ip: null,
    outcome: 'ok',
  });
});

it('finds the same contact when the same person submits again, fills only what it lacks, and never duplicates them', async () => {
  const f = await fixture();
  const { form, fields } = await enquiry(f);
  const first = await submit(form, {
    first_name: 'Maya',
    last_name: 'Thompson',
    email: 'maya@example.test',
    budget: '1000',
    venue: 'harbor',
  });
  expect(first.result).toEqual(OK);
  // A new submission, typed a little differently: capitals, a phone number, a new budget,
  // and a date the contact did not have.
  const second = await submit(form, {
    first_name: 'Maya Jane',
    email: '  MAYA@example.TEST ',
    phone: '+254712345678',
    budget: '2500',
    day: '2027-06-12',
  });
  expect(second.result).toEqual(OK);
  expect(await stored(f)).toEqual({ submissions: 2, contacts: 1, consents: 0, events: 2 });
  const [only] = await contactsOf(f);
  if (only === undefined) throw new Error('The contact is gone.');
  const id = toPublicId('contact', only.id);
  // Nobody has verified who sent it: what the contact has stays, and no number is added.
  expect(contactContract.parse(await crm(f, 'getContact', { id }))).toMatchObject({
    firstName: 'Maya',
    lastName: 'Thompson',
    emails: ['maya@example.test'],
    phones: [],
  });
  const values = recordFields.parse(await crm(f, 'getRecordFields', { id })).items;
  expect(values.find((value) => value.definition.id === fields.budget.id)?.value).toBe('1000');
  // A field the contact lacked takes the answer.
  expect(values.find((value) => value.definition.id === fields.day.id)?.value).toBe('2027-06-12');
  // The venue question was left empty the second time: a form never clears what a contact has.
  expect(values.find((value) => value.definition.id === fields.venue.id)?.value).toBe('harbor');
  const listed = (await submissionsOf(f, form)).items;
  expect(listed.map((each) => each.contactOutcome)).toEqual(['updated', 'created']);
  // The visitor's own answers stay on the submission, and the team reads what was held back.
  expect(listed[0]?.answers.find((answer) => answer.key === 'budget')?.value).toBe('2500');
  const notes = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ body_text: string }>('select body_text from crm.notes where record_id = $1', [
      only.id,
    ]),
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]?.body_text).toContain('First name given: "Maya Jane" (the contact has "Maya").');
  expect(notes[0]?.body_text).toContain('The phone number +254712345678 was given.');
  expect(notes[0]?.body_text).toContain('Budget given: "2500" (the contact has "1000").');
  // A third time, by phone alone with another address: a new email is a new person.
  const third = await submit(form, { email: 'maya.work@example.test', phone: '+254 712 345 678' });
  expect(third.result).toEqual(OK);
  expect(await contactsOf(f)).toHaveLength(2);
  expect(contactContract.parse(await crm(f, 'getContact', { id })).emails).toEqual([
    'maya@example.test',
  ]);
});

it('stores a request sent twice once, and refuses the same id with different answers', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const sent = await submit(
    form,
    { email: 'maya@example.test', heard: 'Search' },
    { consents: { news: true } },
  );
  expect(sent.result).toEqual(OK);
  const once = { submissions: 1, contacts: 1, consents: 1, events: 1 };
  expect(await stored(f)).toEqual(once);
  // The same request again: a double click, or a retry after the answer was lost.
  expect(await suite.handlers.submit(sent.admission, sent.input, visitor())).toEqual(OK);
  // Again with its keys in another order, and long after the form's token went stale.
  suite.wait(48 * 3_600_000);
  expect(
    await suite.handlers.submit(
      sent.admission,
      { ...sent.input, values: { heard: 'Search', email: 'maya@example.test' } },
      visitor(),
    ),
  ).toEqual(OK);
  expect(await stored(f)).toEqual(once);
  // The same id cannot be reused for something else.
  for (const change of [
    { values: { email: 'other@example.test', heard: 'Search' } },
    { consents: { news: false } },
    { pageUrl: `${WEBSITE}/other` },
  ])
    expect(
      await suite.handlers.submit(sent.admission, { ...sent.input, ...change }, visitor()),
    ).toEqual({ outcome: 'changed' });
  expect(await stored(f)).toEqual(once);
});

it('stores one submission when the same request arrives twice at the same moment', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(admission, visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  suite.wait(5000);
  const input = {
    clientSubmissionId: randomUUID(),
    renderToken: shown.form.renderToken,
    values: { email: 'double@example.test', first_name: 'Dee' },
    consents: { news: true },
    trap: '',
  };
  const ready = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  // Someone holds the form's row, so both requests are queued behind it before either
  // has looked for the other.
  const holding = database.as('crm_owner', async (sql) => {
    await sql.query('select 1 from forms.forms where id = $1 for update', [admission.formId]);
    ready.resolve(undefined);
    await release.promise;
  });
  await ready.promise;
  // Through two server processes: one alone stores one submission of a form at a time,
  // so it is two of them that can reach the database with the same request at once.
  const attempts = [suite.handlers, suite.instance].map((process) =>
    settled(process.submit(admission, input, visitor())),
  );
  try {
    await untilWaiting(database, '%from "forms"."forms"%for no key update%', 2);
    expect(await stored(f)).toEqual(NOTHING);
  } finally {
    release.resolve(undefined);
  }
  await holding;
  const results = await Promise.all(attempts);
  // Both are told the same thing, and one submission, one contact and one consent exist.
  expect(results).toEqual([
    { ok: true, value: OK },
    { ok: true, value: OK },
  ]);
  expect(await stored(f)).toEqual({ submissions: 1, contacts: 1, consents: 1, events: 1 });
});

it('lets one submission of a form into the database at a time, keeps a short line, and tells the rest to try again', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  // A second business's form, served by the same process.
  const g = await fixture();
  const other = await enquiry(g);
  const narrow = createPublicFormHandlers({
    db: suite.db,
    secret: SECRET,
    now: suite.now,
    gate: { maxWaiting: 1 },
  });
  const admitted = async (key: string) => {
    const admission = await narrow.admit(key, WEBSITE);
    if (admission === undefined) throw new Error('Not admitted.');
    // A token is good for one submission: one showing of the form for each sent.
    const tokens: string[] = [];
    for (let count = 0; count < 5; count += 1) {
      const shown = await narrow.form(admission, visitor());
      if (shown.outcome !== 'ok') throw new Error('Not shown.');
      tokens.push(shown.form.renderToken);
    }
    return { admission, tokens };
  };
  const flooded = await admitted(form.publicKey);
  const quiet = await admitted(other.form.publicKey);
  suite.wait(5000);
  const send = (to: typeof flooded, email: string) =>
    narrow.submit(
      to.admission,
      {
        clientSubmissionId: randomUUID(),
        renderToken: to.tokens.shift() ?? '',
        values: { email, first_name: 'Vee' },
        consents: {},
        trap: '',
      },
      visitor(),
    );
  const ready = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  // Someone holds the flooded form's row: nothing of it can be stored for now.
  const holding = database.as('crm_owner', async (sql) => {
    await sql.query('select 1 from forms.forms where id = $1 for update', [
      flooded.admission.formId,
    ]);
    ready.resolve(undefined);
    await release.promise;
  });
  await ready.promise;
  const first = settled(send(flooded, 'one@example.test'));
  await untilWaiting(database, '%from "forms"."forms"%for no key update%');
  const second = settled(send(flooded, 'two@example.test'));
  try {
    // The line is one long: the third and the fourth are told to wait and send again, at
    // once, and nothing is opened for them.
    for (const email of ['three@example.test', 'four@example.test'])
      expect(await send(flooded, email)).toEqual({ outcome: 'limited', retryAfterSeconds: 2 });
    // The second waits in the process, holding no connection: one statement waits, not two.
    await expect(
      untilWaiting(database, '%from "forms"."forms"%for no key update%', 2, 400),
    ).rejects.toThrow();
    // Another business's form is stored meanwhile, as if nothing were happening.
    expect(await send(quiet, 'calm@example.test')).toEqual(OK);
  } finally {
    release.resolve(undefined);
  }
  await holding;
  expect(await Promise.all([first, second])).toEqual([
    { ok: true, value: OK },
    { ok: true, value: OK },
  ]);
  // The two that were let in, and the other business's one: none twice, none lost.
  expect(await stored(f)).toMatchObject({ submissions: 2, contacts: 2, events: 2 });
  expect(await stored(g)).toMatchObject({ submissions: 1, contacts: 1, events: 1 });
  // The line is free again.
  expect(await send(flooded, 'five@example.test')).toEqual(OK);
});

it('answers a program that filled the hidden field as it answers a person, and stores nothing', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const before = suite.dropped.length;
  const sent = await submit(form, { email: 'bot@example.test' }, { trap: 'https://spam.example' });
  expect(sent.result).toEqual(OK);
  expect(suite.dropped.slice(before)).toEqual(['trap']);
  expect(await stored(f)).toEqual(NOTHING);
  // Not even an attempt is recorded for it: nothing was looked up.
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query(
        "select 1 from audit.commands where command = 'forms.submit' and business_id = $1",
        [f.business.id],
      ),
    ),
  ).toEqual([]);
});

it('refuses a form sent sooner than a person fills one in, or with a token that is not its own', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const values = { email: 'maya@example.test' };
  expect((await submit(form, values, { after: 0 })).result).toEqual({
    outcome: 'limited',
    retryAfterSeconds: 2,
  });
  const early = await submit(form, values, { after: 1200 });
  expect(early.result).toEqual({ outcome: 'limited', retryAfterSeconds: 1 });
  expect(await stored(f)).toEqual(NOTHING);
  // The same form, sent again once the time has passed, is accepted.
  suite.wait(900);
  expect(await suite.handlers.submit(early.admission, early.input, visitor())).toEqual(OK);

  const stale = { outcome: 'stale' };
  expect(
    (await submit(form, values, { after: FORM_LIMITS.renderHours * 3_600_000 + 1 })).result,
  ).toEqual(stale);
  expect(
    (await submit(form, values, { renderToken: `1790000000000.${'A'.repeat(43)}` })).result,
  ).toEqual(stale);
  // A token another form of the same business issued proves nothing about this one.
  const other = await published(f);
  const borrowed = await suite.handlers.admit(other.publicKey, WEBSITE);
  if (borrowed === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(borrowed, visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  expect((await submit(form, values, { renderToken: shown.form.renderToken })).result).toEqual(
    stale,
  );
  // One a caller made for itself, with a key of its own, proves nothing either.
  const forged = issueRenderToken(
    'a-key-the-server-does-not-have-0123456789',
    {
      formId: early.admission.formId,
      publishedAt: new Date(form.publishedAt ?? 0),
      visitor: visitor().ipAddress,
    },
    Date.now() - 10_000,
  );
  expect((await submit(form, values, { renderToken: forged })).result).toEqual(stale);
  expect(await stored(f)).toEqual({ submissions: 1, contacts: 1, consents: 0, events: 1 });
});

it('asks for the form to be shown again when it was published again after it was loaded', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(admission, visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  // The team changes a question and publishes while the visitor is typing.
  const saved = formContract.parse(
    await admin(f, 'updateForm', {
      params: { id: form.id },
      body: {
        name: form.name,
        definition: { ...form.definition, title: 'Plan your event with us' },
        allowedOrigins: form.allowedOrigins,
        revision: form.revision,
      },
    }),
  );
  await admin(f, 'publishForm', { params: { id: form.id }, body: { revision: saved.revision } });
  suite.wait(5000);
  const input = {
    clientSubmissionId: randomUUID(),
    renderToken: shown.form.renderToken,
    values: { email: 'maya@example.test' },
    consents: {},
    trap: '',
  };
  expect(await suite.handlers.submit(admission, input, visitor())).toEqual({ outcome: 'stale' });
  expect(await stored(f)).toEqual(NOTHING);
  // Loaded again, the same answers under the same id go through.
  const again = await suite.handlers.form(admission, visitor());
  if (again.outcome !== 'ok') throw new Error('Not shown again.');
  expect(again.form.title).toBe('Plan your event with us');
  suite.wait(5000);
  expect(
    await suite.handlers.submit(
      admission,
      { ...input, renderToken: again.form.renderToken },
      visitor(),
    ),
  ).toEqual(OK);
});

it('refuses answers that do not fit the questions, says which, and stores nothing', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const refused = await submit(form, {
    email: 'not-an-address',
    budget: 'lots',
    venue: 'cellar',
    is_admin: 'true',
  });
  expect(refused.result).toEqual({
    outcome: 'invalid',
    issues: [
      {
        path: '/values/is_admin',
        code: 'unknown_question',
        message: 'This form does not ask that.',
      },
      {
        path: '/values/email',
        code: 'invalid_email',
        message: 'Enter an email address, such as maya@example.com.',
      },
      { path: '/values/budget', code: 'invalid_number', message: 'Enter a number.' },
      { path: '/values/venue', code: 'invalid_choice', message: 'Choose one of the choices.' },
    ],
  });
  expect((await submit(form, {})).result).toMatchObject({
    outcome: 'invalid',
    issues: [{ path: '/values/email', code: 'required' }],
  });
  // A phone number the form's own check lets through and the CRM's does not: the message
  // is put by the phone question, and what the CRM wrote before refusing is undone.
  const phone = await submit(form, {
    first_name: 'Maya',
    email: 'maya@example.test',
    phone: '000 000 000',
  });
  expect(phone.result).toEqual({
    outcome: 'invalid',
    issues: [
      {
        path: '/values/phone',
        code: 'invalid_phone',
        message: 'Enter a phone number, with its country code.',
      },
    ],
  });
  expect(await stored(f)).toEqual(NOTHING);
  // Put right, the same submission is accepted under the id it already had.
  expect(
    await suite.handlers.submit(
      phone.admission,
      { ...phone.input, values: { ...phone.input.values, phone: '+254712345678' } },
      visitor(),
    ),
  ).toEqual(OK);
});

it('stops accepting a form the moment it is unpublished, archived, taken off a website, or its business is suspended', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const values = { email: 'maya@example.test' };
  const load = async () => {
    const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
    if (admission === undefined) throw new Error('Not admitted.');
    const shown = await suite.handlers.form(admission, visitor());
    if (shown.outcome !== 'ok') throw new Error('Not shown.');
    suite.wait(5000);
    return {
      admission,
      input: {
        clientSubmissionId: randomUUID(),
        renderToken: shown.form.renderToken,
        values,
        consents: {},
        trap: '',
      },
    };
  };
  const current = async () =>
    formContract.parse(await admin(f, 'getForm', { params: { id: form.id } }));
  const unavailable = { outcome: 'unavailable' };

  // Each time: the form is loaded while it is live, something changes, then it is sent.
  let loaded = await load();
  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [f.business.id]),
  );
  expect(await suite.handlers.submit(loaded.admission, loaded.input, visitor())).toEqual(
    unavailable,
  );
  expect(await suite.handlers.form(loaded.admission, visitor())).toEqual(unavailable);
  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='active' where id=$1", [f.business.id]),
  );

  loaded = await load();
  const live = await current();
  const narrowed = formContract.parse(
    await admin(f, 'updateForm', {
      params: { id: form.id },
      body: {
        name: live.name,
        definition: live.definition,
        allowedOrigins: ['https://elsewhere.example.com'],
        revision: live.revision,
      },
    }),
  );
  expect(await suite.handlers.submit(loaded.admission, loaded.input, visitor())).toEqual(
    unavailable,
  );
  await admin(f, 'updateForm', {
    params: { id: form.id },
    body: {
      name: narrowed.name,
      definition: narrowed.definition,
      allowedOrigins: [WEBSITE],
      revision: narrowed.revision,
    },
  });

  for (const operationId of ['unpublishForm', 'archiveForm'] as const) {
    loaded = await load();
    await admin(f, operationId, {
      params: { id: form.id },
      body: { revision: (await current()).revision },
    });
    expect(await suite.handlers.submit(loaded.admission, loaded.input, visitor())).toEqual(
      unavailable,
    );
    expect(await suite.handlers.form(loaded.admission, visitor())).toEqual(unavailable);
    if (operationId === 'unpublishForm')
      await admin(f, 'publishForm', {
        params: { id: form.id },
        body: { revision: (await current()).revision },
      });
  }
  expect(await stored(f)).toEqual(NOTHING);
});

it('makes a submission wait for an unpublish in flight, and then stores nothing', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(admission, visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  suite.wait(5000);
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  // The form is unpublished in a transaction that has not committed yet.
  const unpublishing = database.withTenant(f.business.context, async (sql) => {
    await sql.query(
      "update forms.forms set status='draft', published_definition=null, published_at=null where id=$1",
      [admission.formId],
    );
    ready.resolve(undefined);
    await proceed.promise;
  });
  await ready.promise;
  const attempt = settled(
    suite.handlers.submit(
      admission,
      {
        clientSubmissionId: randomUUID(),
        renderToken: shown.form.renderToken,
        values: { email: 'late@example.test' },
        consents: { news: true },
        trap: '',
      },
      visitor(),
    ),
  );
  try {
    // Until it commits the form still reads as published; the submission waits on its row.
    await untilWaiting(database, '%from "forms"."forms"%for no key update%');
  } finally {
    proceed.resolve(undefined);
  }
  await unpublishing;
  expect(await attempt).toEqual({ ok: true, value: { outcome: 'unavailable' } });
  expect(await stored(f)).toEqual(NOTHING);
});

it('makes an unpublish wait for a submission in flight, which is stored', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(admission, visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  suite.wait(5000);
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  // Someone else is adding a contact with the same address and has not committed. The
  // submission holds the form's row by the time it reaches the address, and waits there.
  const adding = settled(
    database.withTenant(f.business.context, async (sql) => {
      const contact = await sql.one<{ id: string }>(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           select app.business_id(), 'contact', id from crm.object_types where kind = 'contact'
           returning id)
         insert into crm.contacts (business_id, id, first_name, created_by_kind)
         select app.business_id(), id, 'Held', 'system' from record returning id`,
      );
      await sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
         values (app.business_id(), $1, 'email', 'held@example.test', 'held@example.test', true)`,
        [contact.id],
      );
      ready.resolve(undefined);
      await proceed.promise;
      throw new Error('The other writer gives up.');
    }),
  );
  await ready.promise;
  const submitting = settled(
    suite.handlers.submit(
      admission,
      {
        clientSubmissionId: randomUUID(),
        renderToken: shown.form.renderToken,
        values: { email: 'held@example.test' },
        consents: {},
        trap: '',
      },
      visitor(),
    ),
  );
  await untilWaiting(database, '%insert into "crm"."contact_identities"%');
  const live = formContract.parse(await admin(f, 'getForm', { params: { id: form.id } }));
  const unpublishing = settled(
    Promise.resolve().then(() =>
      admin(f, 'unpublishForm', { params: { id: form.id }, body: { revision: live.revision } }),
    ),
  );
  try {
    await untilWaiting(database, '%from "forms"."forms"%for update%');
  } finally {
    proceed.resolve(undefined);
  }
  const [added, submitted, unpublished] = await Promise.all([adding, submitting, unpublishing]);
  expect(added.ok).toBe(false);
  // The form was published when the submission took it, so it is stored; the unpublish
  // came after it.
  expect(submitted).toEqual({ ok: true, value: OK });
  if (!unpublished.ok) throw unpublished.error;
  expect(formContract.parse(unpublished.value).status).toBe('draft');
  expect(await stored(f)).toEqual({ submissions: 1, contacts: 1, consents: 0, events: 1 });
});

it('never loses a lead to a contact in the trash or to details of two contacts, and tells the team only', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const trashed = await database.fixtures.contact(f.business.context, {
    firstName: 'Old',
    email: 'trashed@example.test',
  });
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [trashed.id]),
  );
  const one = await database.fixtures.contact(f.business.context, { email: 'one@example.test' });
  const two = await database.fixtures.contact(f.business.context, { firstName: 'Two' });
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
       values (app.business_id(), $1, 'phone', '+254712345678', '+254712345678', true)`,
      [two.id],
    ),
  );
  // An address in the trash; and an address of one contact with the phone of another.
  const inTrash = await submit(form, {
    first_name: 'New name',
    email: 'trashed@example.test',
    budget: '9',
  });
  const ambiguous = await submit(form, { email: 'one@example.test', phone: '+254712345678' });
  // The answer is the one everybody gets.
  expect(inTrash.result).toEqual(OK);
  expect(ambiguous.result).toEqual(OK);
  expect(await stored(f)).toMatchObject({ submissions: 2, contacts: 3, events: 2 });
  // The contact in the trash is back, with its own name; the blank field took the answer.
  expect((await contactsOf(f)).map((contact) => contact.first_name)).toEqual([
    'Old',
    'Test',
    'Two',
  ]);
  const listed = (await submissionsOf(f, form)).items;
  expect(listed.map((each) => [each.contactId, each.contactOutcome])).toEqual([
    [toPublicId('contact', one.id), 'updated'],
    [toPublicId('contact', trashed.id), 'updated'],
  ]);
  const notes = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ record_id: string; body_text: string }>(
      'select record_id, body_text from crm.notes order by created_at, id',
    ),
  );
  expect(notes).toEqual([
    {
      record_id: trashed.id,
      body_text: expect.stringContaining(
        'This contact was in the trash. It was restored because these details matched it.',
      ) as string,
    },
    {
      record_id: one.id,
      body_text: expect.stringContaining(
        'The phone number +254712345678 belongs to another contact, Two.',
      ) as string,
    },
  ]);
  expect(notes[0]?.body_text).toContain('First name given: "New name" (the contact has "Old").');
  const restored = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ deleted_at: Date | null }>('select deleted_at from crm.contacts where id = $1', [
      trashed.id,
    ]),
  );
  expect(restored).toEqual([{ deleted_at: null }]);

  // A submission that reached no contact (details that kept changing under the intake) can
  // be discarded by the team, and only that kind.
  for (const each of listed)
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update forms.submissions set contact_id = null, contact_outcome = 'unresolved' where id = $1`,
        [parsePublicId('form_submission', each.id) ?? each.id],
      ),
    );

  // The team can discard an unattached submission, and only that kind.
  const attached = await submit(form, { email: 'kept@example.test' });
  expect(attached.result).toEqual(OK);
  const [newest, ...unattached] = (await submissionsOf(f, form)).items;
  if (newest === undefined) throw new Error('Nothing is listed.');
  await expect(
    Promise.resolve().then(() =>
      admin(f, 'discardFormSubmission', { params: { id: form.id, submissionId: newest.id } }),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  const reader = { ...f.manager, permissions: new Set(['contacts.manage'] as const) };
  for (const each of unattached) {
    await expect(
      Promise.resolve().then(() =>
        admin(
          f,
          'discardFormSubmission',
          { params: { id: form.id, submissionId: each.id } },
          reader,
        ),
      ),
    ).rejects.toMatchObject({ permission: 'forms.manage' });
    expect(
      await admin(f, 'discardFormSubmission', { params: { id: form.id, submissionId: each.id } }),
    ).toBeUndefined();
    await expect(
      Promise.resolve().then(() =>
        admin(f, 'discardFormSubmission', { params: { id: form.id, submissionId: each.id } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  }
  expect((await submissionsOf(f, form)).items.map((each) => each.id)).toEqual([newest.id]);
  // A submission is found under its own form only.
  const other = await published(f);
  await expect(
    Promise.resolve().then(() =>
      admin(f, 'discardFormSubmission', { params: { id: other.id, submissionId: newest.id } }),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('records consent only for a ticked box with an address, and never undoes a withdrawal', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const outcomes = async () =>
    (await submissionsOf(f, form)).items[0]?.consents.map((box) => [box.key, box.outcome]);
  // Texts ticked without a phone number: there is nothing to consent for.
  await submit(form, { email: 'maya@example.test' }, { consents: { news: false, texts: true } });
  expect(await outcomes()).toEqual([
    ['news', 'not_ticked'],
    ['texts', 'no_address'],
  ]);
  expect((await stored(f)).consents).toBe(0);
  await submit(form, { email: 'maya@example.test' }, { consents: { news: true } });
  expect(await outcomes()).toEqual([
    ['news', 'granted'],
    ['texts', 'not_ticked'],
  ]);
  // Maya unsubscribes. Anyone can type her address into the form again.
  const [maya] = await contactsOf(f);
  if (maya === undefined) throw new Error('No contact.');
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into messaging.consents(business_id,contact_id,channel,purpose,status,source,proof,recorded_by_kind,recorded_by_id)
       values(app.business_id(),$1,'email','marketing','withdrawn','unsubscribe_link','{}','contact',$1)`,
      [maya.id],
    ),
  );
  const again = await submit(
    form,
    { email: 'maya@example.test', phone: '+254712345678' },
    { consents: { news: true, texts: true } },
  );
  expect(again.result).toEqual(OK);
  // The phone number is not added to a contact the form found, so there is no address of
  // Maya's for the text box to consent for.
  expect(await outcomes()).toEqual([
    ['news', 'withdrawn_kept'],
    ['texts', 'no_address'],
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ channel: string; status: string }>(
        'select channel, status from messaging.consents order by recorded_at, id',
      ),
    ),
  ).toEqual([
    { channel: 'email', status: 'granted' },
    { channel: 'email', status: 'withdrawn' },
  ]);
  // A form whose box must be ticked refuses a submission without it.
  const strict = await published(f, {
    ...DEFAULT_FORM_DEFINITION,
    consents: [{ key: 'news', channel: 'email', wording: 'Email me news.', required: true }],
  });
  expect((await submit(strict, { email: 'omar@example.test' })).result).toMatchObject({
    outcome: 'invalid',
    issues: [{ path: '/consents/news', code: 'required' }],
  });
});

it('keeps a lead when a contact field was archived or removed after the form was published', async () => {
  const f = await fixture();
  const { form, fields } = await enquiry(f);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.field_definitions set archived_at = now() where key = $1', ['budget']),
  );
  await database.withTenant(f.business.context, (sql) =>
    // The garden is no longer offered: an archived choice cannot be newly chosen.
    sql.query(
      `update crm.field_definitions
       set options = (select jsonb_agg(case when choice->>'key' = 'garden'
                                            then choice || '{"archived": true}' else choice end)
                      from jsonb_array_elements(options) choice)
       where key = $1`,
      ['venue'],
    ),
  );
  const sent = await submit(form, {
    email: 'maya@example.test',
    budget: '500',
    venue: 'garden',
    day: '2027-06-12',
  });
  expect(sent.result).toEqual(OK);
  const [submission] = (await submissionsOf(f, form)).items;
  // The answers are with the submission; the two that could not be written say so.
  expect(submission?.skippedFields).toEqual(['budget', 'venue']);
  expect(
    submission?.answers.filter((answer) => answer.value !== null && answer.value !== false),
  ).toEqual([
    { key: 'email', label: 'Email', value: 'maya@example.test' },
    { key: 'budget', label: 'Budget', value: '500' },
    { key: 'venue', label: 'Venue', value: 'garden' },
    { key: 'day', label: 'Event date', value: '2027-06-12' },
  ]);
  const [made] = await contactsOf(f);
  if (made === undefined) throw new Error('No contact.');
  const values = recordFields.parse(
    await crm(f, 'getRecordFields', { id: toPublicId('contact', made.id) }),
  ).items;
  // The date was written, and the box, which is an answer whether ticked or not.
  expect(
    values
      .filter((value) => value.value !== null)
      .map((value) => [value.definition.id, value.value]),
  ).toEqual([
    [fields.day.id, '2027-06-12'],
    [fields.planner.id, false],
  ]);
});

it('stops one source at its own hourly and daily limits, and nobody else', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const fill = (count: number, age: string, ip: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into forms.submissions (business_id, form_id, data, ip, submitted_at)
         select app.business_id(), id, '{}', $3::inet, clock_timestamp() - $2::interval
         from forms.forms, generate_series(1, $1)`,
        [count, age, ip],
      ),
    );
  const from = (ipAddress: string) => ({ visitor: { ipAddress } });
  await fill(FORM_LIMITS.sourcePerHour - 1, '10 minutes', '198.51.100.7');
  expect((await submit(form, { email: 'last@example.test' }, from('198.51.100.7'))).result).toEqual(
    OK,
  );
  // The oldest of the hour from that address is ten minutes old: fifty minutes to wait.
  expect((await submit(form, { email: 'over@example.test' }, from('198.51.100.7'))).result).toEqual(
    {
      outcome: 'limited',
      retryAfterSeconds: expect.closeTo(3000, -1) as number,
    },
  );
  // Every other address, and the next address along, carries on.
  expect((await submit(form, { email: 'next@example.test' }, from('198.51.100.8'))).result).toEqual(
    OK,
  );
  // An IPv6 visitor is the whole /64: a new address in it is the same source.
  await fill(FORM_LIMITS.sourcePerDay, '2 hours', '2001:db8:1:2::9');
  const daily = (await submit(form, { email: 'six@example.test' }, from('2001:db8:1:2:aa::1')))
    .result;
  expect(daily).toMatchObject({ outcome: 'limited' });
  expect(daily.outcome === 'limited' ? daily.retryAfterSeconds : 0).toBeGreaterThan(3600 * 21);
  expect(
    (await submit(form, { email: 'v6@example.test' }, from('2001:db8:1:3::1'))).result,
  ).toEqual(OK);
  expect((await stored(f)).contacts).toBe(3);
});

it('refuses for everyone only past a ceiling far above a busy hour', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into forms.submissions (business_id, form_id, data, ip, submitted_at)
       select app.business_id(), id, '{}', '192.0.2.1', clock_timestamp() - interval '5 minutes'
       from forms.forms, generate_series(1, $1)`,
      [FORM_LIMITS.ceilingPerHour],
    ),
  );
  const refused = (await submit(form, { email: 'flood@example.test' }, { after: 10_000 })).result;
  expect(refused).toEqual({
    outcome: 'limited',
    retryAfterSeconds: expect.closeTo(3300, -1) as number,
  });
});

it('spends a token on the submission it was sent with, and binds it to the visitor it was shown to', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const first = await submit(form, { email: 'once@example.test' });
  expect(first.result).toEqual(OK);
  // The same request again is the same submission, answered as before.
  expect(await suite.handlers.submit(first.admission, first.input, visitor())).toEqual(OK);
  // The same token under a new id is a second lead from one showing: shown again instead.
  expect(
    await suite.handlers.submit(
      first.admission,
      { ...first.input, clientSubmissionId: randomUUID(), values: { email: 'twice@example.test' } },
      visitor(),
    ),
  ).toEqual({ outcome: 'stale' });
  // A token fetched from one address and sent from another proves nothing.
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(admission, visitor({ ipAddress: '198.51.100.20' }));
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  suite.wait(5000);
  const input = {
    clientSubmissionId: randomUUID(),
    renderToken: shown.form.renderToken,
    values: { email: 'elsewhere@example.test' },
    consents: {},
    trap: '',
  };
  expect(
    await suite.handlers.submit(admission, input, visitor({ ipAddress: '198.51.100.21' })),
  ).toEqual({ outcome: 'stale' });
  expect(
    await suite.handlers.submit(admission, input, visitor({ ipAddress: '198.51.100.20' })),
  ).toEqual(OK);
  // Two showings at the same moment to the same address are two tokens, one lead each.
  const one = await suite.handlers.form(admission, visitor());
  const two = await suite.handlers.form(admission, visitor());
  if (one.outcome !== 'ok' || two.outcome !== 'ok') throw new Error('Not shown.');
  expect(one.form.renderToken).not.toBe(two.form.renderToken);
  expect((await stored(f)).submissions).toBe(2);
});

it('keeps taking real visitors while a flood from many addresses hits one form (C1, measured)', async () => {
  // Before this change, measured on the dev server: 220 submissions from about 220
  // addresses with ONE token used up the form's hour, and every real visitor after them was
  // refused for 55 minutes (429, Retry-After 3315).
  const f = await fixture();
  const { form } = await enquiry(f);
  const limits = { busyPerHour: 20, busySourcePerHour: 1, busyMinFillSeconds: 8 };
  const handlers = createPublicFormHandlers({
    db: suite.db,
    secret: SECRET,
    now: suite.now,
    limits,
  });
  const admission = await handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const show = async (ipAddress: string) => {
    const shown = await handlers.form(admission, visitor({ ipAddress }));
    if (shown.outcome !== 'ok') throw new Error('Not shown.');
    return shown.form.renderToken;
  };
  const send = (ipAddress: string, renderToken: string, email: string) =>
    handlers.submit(
      admission,
      { clientSubmissionId: randomUUID(), renderToken, values: { email }, consents: {}, trap: '' },
      visitor({ ipAddress }),
    );
  const tally = (results: readonly { outcome: string }[]) =>
    results.reduce<Record<string, number>>((counts, { outcome }) => {
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      return counts;
    }, {});

  // The attack of the finding: one token, sent from 40 addresses. It was shown to one
  // address, so the 39 others are refused as stale and use nothing of the form's hour.
  const one = await show('198.51.100.1');
  suite.wait(3000);
  const reused = [];
  for (let n = 1; n <= 40; n += 1)
    reused.push(await send(`198.51.100.${String(n)}`, one, `bot${String(n)}@example.test`));
  expect(tally(reused)).toEqual({ ok: 1, stale: 39 });

  // The stronger attack: each of 40 addresses fetches two tokens of its own and sends both.
  const bots = Array.from({ length: 40 }, (_, n) => `203.0.113.${String(100 + n)}`);
  const tokens: string[][] = [];
  for (const bot of bots) tokens.push([await show(bot), await show(bot)]);
  // Eighty showings at one moment of the test's clock are signed a millisecond apart.
  suite.wait(limits.busyMinFillSeconds * 1000 + 1000);
  const flood = [];
  for (const [n, bot] of bots.entries())
    for (const token of tokens[n] ?? [])
      flood.push(await send(bot, token, `flood${String(n)}@example.test`));
  // Up to the busy mark a source may send several; past it, one per source an hour.
  const results = tally(flood);
  expect(results['ok']).toBeLessThanOrEqual(40 + limits.busyPerHour);
  expect(results['limited']).toBeGreaterThanOrEqual(40 - limits.busyPerHour);

  // A real visitor afterwards is still taken, after a little longer on the page.
  const real = await show('192.0.2.77');
  suite.wait(3000);
  expect(await send('192.0.2.77', real, 'real@example.test')).toEqual({
    outcome: 'limited',
    retryAfterSeconds: 5,
  });
  suite.wait(5000);
  expect(await send('192.0.2.77', real, 'real@example.test')).toEqual(OK);
  // And so is every other real visitor: none is refused for the hour.
  const after = [];
  for (let n = 0; n < 10; n += 1) {
    const ip = `192.0.2.${String(100 + n)}`;
    const token = await show(ip);
    suite.wait(limits.busyMinFillSeconds * 1000);
    after.push(await send(ip, token, `person${String(n)}@example.test`));
  }
  expect(tally(after)).toEqual({ ok: 10 });
});

it('lists submissions newest first in pages, and shows a row from before the builder as it is', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into forms.submissions (business_id, form_id, data, consent, utm)
       select app.business_id(), id, '{"name": "Jordan", "guests": 40, "vip": true, "extra": null}',
              '{"news": true}', '{"source": 7}'
       from forms.forms`,
    ),
  );
  for (const email of ['a@example.test', 'b@example.test', 'c@example.test'])
    expect((await submit(form, { email })).result).toEqual(OK);
  const page = async (query: Record<string, string>) =>
    formSubmissionList.parse(
      await admin(f, 'listFormSubmissions', { params: { id: form.id }, query }),
    );
  const first = await page({ limit: '2' });
  expect(
    first.items.map((each) => each.answers.find((answer) => answer.key === 'email')?.value),
  ).toEqual(['c@example.test', 'b@example.test']);
  expect(first.canManage).toBe(true);
  const second = await page({ limit: '2', after: first.nextCursor ?? '' });
  expect(second.nextCursor).toBeNull();
  expect(second.items).toHaveLength(2);
  const legacy = second.items[1];
  expect(legacy).toMatchObject({
    contactId: null,
    contactOutcome: null,
    consents: [],
    skippedFields: [],
    origin: null,
    pageUrl: null,
    ipAddress: null,
    utm: {},
  });
  expect(legacy?.answers).toEqual(
    expect.arrayContaining([
      { key: 'name', label: 'name', value: 'Jordan' },
      { key: 'guests', label: 'guests', value: '40' },
      { key: 'vip', label: 'vip', value: true },
      { key: 'extra', label: 'extra', value: null },
    ]),
  );
  // Someone without forms.manage reads them too, and is told they cannot discard.
  const reader = { ...f.manager, permissions: new Set(['contacts.manage'] as const) };
  expect(
    formSubmissionList.parse(
      await admin(f, 'listFormSubmissions', { params: { id: form.id } }, reader),
    ).canManage,
  ).toBe(false);
});

it('takes a clock of its own when none is given, and the same secret on every instance', async () => {
  const f = await fixture();
  const { form } = await enquiry(f);
  const instance = () => createPublicFormHandlers({ db: suite.db, secret: SECRET });
  const first = instance();
  const admission = await first.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await first.form(admission, visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  const input = {
    clientSubmissionId: randomUUID(),
    renderToken: shown.form.renderToken,
    values: { email: 'now@example.test' },
    consents: {},
    trap: '',
  };
  // On the real clock the form was shown this instant: too soon, on any instance.
  expect(await instance().submit(admission, input, visitor())).toMatchObject({
    outcome: 'limited',
    retryAfterSeconds: 2,
  });
  // A hidden field filled in is dropped without a listener to tell.
  expect(
    await instance().submit(admission, { ...input, trap: 'x' }, visitor({ userAgent: undefined })),
  ).toEqual(OK);
  // An instance with another secret did not issue this token.
  const stranger = createPublicFormHandlers({
    db: suite.db,
    secret: 'another-instance-secret-of-32-bytes-or-more',
    now: () => Date.now() + 10_000,
  });
  expect(await stranger.submit(admission, input, visitor())).toEqual({ outcome: 'stale' });
  expect(await stored(f)).toEqual(NOTHING);
});
