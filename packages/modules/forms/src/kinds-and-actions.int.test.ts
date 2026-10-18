// The newer kinds of question and what a submission does besides making the contact,
// against Postgres: several choices, a web address, a rating, a hidden question, a block
// of text and a terms box; the contact's date of birth; tags and the contact's source; and
// what a visitor is shown afterwards. Through the handlers the server mounts.
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_FORM_DEFINITION,
  form as formContract,
  formSubmissionList,
  publicForm,
  recordFields,
  tag as tagContract,
  type Form,
  type FormDefinitionInput,
} from '@repo/contracts';
import { toPublicId, ValidationError } from '@repo/kernel';
import { crmRoutes } from '@repo/module-crm';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';

import { formSuite, settled, WEBSITE, type FormFixture } from '../test/form-fixtures.js';

const suite = formSuite();
const { fixture, admin, published, field } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

const OK = { outcome: 'ok', receipt: { status: 'received' } };
const email = {
  key: 'email',
  type: 'email',
  label: 'Email',
  required: true,
  target: { kind: 'contact', attribute: 'email' },
} as const;

const crm = async (
  f: FormFixture,
  operationId: string,
  input: { readonly params?: Record<string, string>; readonly body?: unknown } = {},
) => {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run(
    {
      invocation: { ...f.manager, context: { ...f.manager.context, correlationId: randomUUID() } },
      params: input.params ?? {},
      query: {},
      body: input.body,
    },
    { db: suite.db, authorize: () => true },
  );
};
const tagNamed = async (f: FormFixture, name: string) =>
  tagContract.parse(await crm(f, 'createTag', { body: { name } }));
const submissionsOf = async (f: FormFixture, form: Pick<Form, 'id'>) =>
  formSubmissionList.parse(await admin(f, 'listFormSubmissions', { params: { id: form.id } }))
    .items;
const contactsOf = (f: FormFixture) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ id: string; source: string | null; born: string | null }>(
      'select id, source, date_of_birth::text as born from crm.contacts order by id',
    ),
  );
const tagsOf = (f: FormFixture, contactId: string) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ name: string; source_kind: string; source_id: string | null }>(
      `select t.name, a.source_kind, a.source_id::text as source_id
       from crm.record_tags a join crm.tags t on t.business_id = a.business_id and t.id = a.tag_id
       where a.record_id = $1 order by t.name`,
      [contactId],
    ),
  );
const eventsOf = (f: FormFixture, types: readonly string[]) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ type: string; actor_kind: string }>(
      'select type, actor_kind from events.events where type = any($1) order by recorded_at, id',
      [types],
    ),
  );
/** Sends answers of any kind: the fixture's own helper takes text and ticks only. */
async function send(
  form: Pick<Form, 'publicKey'>,
  values: Readonly<Record<string, string | boolean | readonly string[]>>,
) {
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('The form did not admit this website.');
  const shown = await suite.handlers.form(admission, suite.visitor());
  if (shown.outcome !== 'ok') throw new Error(`The form was not shown: ${shown.outcome}.`);
  suite.wait(3000);
  return suite.handlers.submit(
    admission,
    {
      clientSubmissionId: randomUUID(),
      renderToken: shown.form.renderToken,
      values: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          typeof value === 'object' ? [...value] : value,
        ]),
      ),
      consents: {},
      trap: '',
    },
    suite.visitor(),
  );
}

/** A form with one question of every newer kind, each filling a custom field where it can. */
async function wide(f: FormFixture, more: Partial<FormDefinitionInput> = {}) {
  const interests = await field(f, 'interests', 'multi_choice', ['venue', 'food', 'music']);
  const website = await field(f, 'website', 'url');
  const stars = await field(f, 'stars', 'number');
  const campaign = await field(f, 'campaign', 'text');
  const definition = {
    title: 'Tell us more',
    fields: [
      email,
      { key: 'intro', type: 'content', label: 'Intro', text: 'About your event', style: 'heading' },
      {
        key: 'born',
        type: 'date',
        label: 'Date of birth',
        target: { kind: 'contact', attribute: 'dateOfBirth' },
      },
      {
        key: 'interests',
        type: 'multi_choice',
        label: 'Interests',
        display: 'checkboxes',
        options: [
          { key: 'venue', label: 'Venue' },
          { key: 'food', label: 'Food' },
          { key: 'music', label: 'Music' },
        ],
        target: { kind: 'field', fieldId: interests.id },
      },
      {
        key: 'site',
        type: 'url',
        label: 'Website',
        placeholder: 'https://',
        target: { kind: 'field', fieldId: website.id },
      },
      {
        key: 'stars',
        type: 'rating',
        label: 'How was it?',
        target: { kind: 'field', fieldId: stars.id },
      },
      {
        key: 'campaign',
        type: 'hidden',
        label: 'Campaign',
        parameter: 'utm_campaign',
        defaultValue: 'none given',
        target: { kind: 'field', fieldId: campaign.id },
      },
      { key: 'ref', type: 'hidden', label: 'Referrer', parameter: 'ref' },
      {
        key: 'rules',
        type: 'terms',
        label: 'Terms box',
        required: true,
        text: 'I accept the terms and conditions.',
        linkUrl: 'https://www.example.com/terms',
        linkLabel: 'Read them',
      },
    ],
    ...more,
  } satisfies FormDefinitionInput;
  return {
    form: await published(f, definition),
    fields: { interests, website, stars, campaign },
  };
}

it('shows a website each newer kind as it needs to be built, and nothing of what it does', async () => {
  const f = await fixture();
  const { form } = await wide(f, {
    afterSubmit: { kind: 'redirect', url: 'https://www.example.com/thanks' },
    notify: { mode: 'nobody' },
  });
  const admission = await suite.handlers.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Not admitted.');
  const shown = await suite.handlers.form(admission, suite.visitor());
  if (shown.outcome !== 'ok') throw new Error('Not shown.');
  const view = publicForm.parse(shown.form);
  expect(view.redirectUrl).toBe('https://www.example.com/thanks');
  expect(
    Object.fromEntries(
      view.fields.map(({ key, helpText, required, options, ...rest }) => [key, rest]),
    ),
  ).toEqual({
    email: { type: 'email', label: 'Email' },
    intro: { type: 'content', label: '', text: 'About your event', style: 'heading' },
    born: { type: 'date', label: 'Date of birth' },
    interests: { type: 'multi_choice', label: 'Interests', display: 'checkboxes' },
    site: { type: 'url', label: 'Website', placeholder: 'https://' },
    stars: { type: 'rating', label: 'How was it?' },
    campaign: { type: 'hidden', label: 'Campaign', parameter: 'utm_campaign' },
    ref: { type: 'hidden', label: 'Referrer', parameter: 'ref' },
    rules: {
      type: 'terms',
      label: '',
      text: 'I accept the terms and conditions.',
      linkUrl: 'https://www.example.com/terms',
      linkLabel: 'Read them',
    },
  });
  const text = JSON.stringify(view);
  for (const kept of [
    'none given',
    'defaultValue',
    'target',
    'fld_',
    'notify',
    'Terms box',
    'Intro',
  ])
    expect(text).not.toContain(kept);
});

it('stores each newer kind of answer, fills the contact and its custom fields, and keeps the terms as they were shown', async () => {
  const f = await fixture();
  const { form } = await wide(f);
  expect(
    await send(form, {
      email: 'maya@example.test',
      born: '1990-04-23',
      interests: ['music', 'venue'],
      site: 'www.example.com/weddings',
      stars: '4',
      campaign: 'Spring open day',
      rules: true,
    }),
  ).toEqual(OK);
  const [contact] = await contactsOf(f);
  if (contact === undefined) throw new Error('No contact was made.');
  expect(contact.born).toBe('1990-04-23');
  const [submission] = await submissionsOf(f, form);
  expect(submission).toMatchObject({
    contactId: toPublicId('contact', contact.id),
    contactOutcome: 'created',
    skippedFields: [],
    // A block of text has no answer, and a terms box is kept apart from the answers.
    answers: [
      { key: 'email', label: 'Email', value: 'maya@example.test' },
      { key: 'born', label: 'Date of birth', value: '1990-04-23' },
      // In the order the form lists them, whatever order they were sent in.
      { key: 'interests', label: 'Interests', value: ['venue', 'music'] },
      { key: 'site', label: 'Website', value: 'https://www.example.com/weddings' },
      { key: 'stars', label: 'How was it?', value: '4' },
      { key: 'campaign', label: 'Campaign', value: 'Spring open day' },
      { key: 'ref', label: 'Referrer', value: null },
    ],
    terms: [
      {
        key: 'rules',
        wording: 'I accept the terms and conditions.',
        linkUrl: 'https://www.example.com/terms',
        accepted: true,
      },
    ],
    // A terms box is not consent to messages: nothing is in the consent ledger for it.
    consents: [],
  });
  expect((await suite.stored(f)).consents).toBe(0);
  const values = recordFields.parse(
    await crm(f, 'getRecordFields', { params: { id: toPublicId('contact', contact.id) } }),
  ).items;
  // Each said to have been set by a form, as every value a form fills is.
  expect(values.filter((value) => value.value !== null).map((value) => value.source?.kind)).toEqual(
    ['form', 'form', 'form', 'form'],
  );
  expect(
    Object.fromEntries(
      values
        .filter((value) => value.value !== null)
        .map((value) => [value.definition.key, value.value]),
    ),
  ).toEqual({
    interests: ['venue', 'music'],
    website: 'https://www.example.com/weddings',
    stars: '4',
    campaign: 'Spring open day',
  });
});

it('uses a hidden question’s fixed answer when the page gave none that fits, and never refuses for one', async () => {
  const f = await fixture();
  const { form } = await wide(f);
  // Too long for a short answer, and not one line: neither stops the form.
  expect(
    await send(form, {
      email: 'omar@example.test',
      campaign: 'x'.repeat(501),
      ref: 'two\nlines',
      rules: true,
    }),
  ).toEqual(OK);
  const [submission] = await submissionsOf(f, form);
  const answered = Object.fromEntries(
    (submission?.answers ?? []).map((answer) => [answer.key, answer.value]),
  );
  expect(answered).toMatchObject({ campaign: 'none given', ref: null });
});

it('refuses what does not fit a newer kind, by its question, and stores nothing', async () => {
  const f = await fixture();
  const { form } = await wide(f);
  const refused = await send(form, {
    email: 'maya@example.test',
    born: '2990-01-01',
    interests: ['venue', 'cellar'],
    site: 'not a website',
    stars: '6',
    intro: 'an answer to a block of text',
  });
  expect(refused).toMatchObject({
    outcome: 'invalid',
    issues: [
      { path: '/values/intro', code: 'unknown_question' },
      { path: '/values/interests', code: 'invalid_choice' },
      { path: '/values/site', code: 'invalid_url' },
      { path: '/values/stars', code: 'invalid_rating' },
      { path: '/values/rules', code: 'required' },
    ],
  });
  expect(await suite.stored(f)).toEqual({ submissions: 0, contacts: 0, consents: 0, events: 0 });
  // A date of birth in the future is the CRM's to refuse; it is said by its question.
  const future = await send(form, { email: 'maya@example.test', born: '2990-01-01', rules: true });
  expect(future).toEqual({
    outcome: 'invalid',
    issues: [
      {
        path: '/values/born',
        code: 'invalid_date',
        message: 'Enter a date that is not in the future.',
      },
    ],
  });
  expect(await suite.stored(f)).toEqual({ submissions: 0, contacts: 0, consents: 0, events: 0 });
});

it('adds the form’s tags to the contact as the form, once, and skips one that was deleted since', async () => {
  const f = await fixture();
  const lead = await tagNamed(f, 'Web lead');
  const wedding = await tagNamed(f, 'Wedding');
  const gone = await tagNamed(f, 'Gone');
  const form = await published(f, {
    fields: [email],
    contactActions: { tagIds: [lead.id, wedding.id, gone.id], source: { kind: 'none' } },
  });
  await database.withTenant(f.business.context, (sql) =>
    sql.query('delete from crm.tags where name = $1', ['Gone']),
  );
  expect(await send(form, { email: 'maya@example.test' })).toEqual(OK);
  const [contact] = await contactsOf(f);
  if (contact === undefined) throw new Error('No contact was made.');
  expect(await tagsOf(f, contact.id)).toEqual([
    { name: 'Web lead', source_kind: 'form', source_id: expect.any(String) as string },
    { name: 'Wedding', source_kind: 'form', source_id: expect.any(String) as string },
  ]);
  // Through the CRM's own command: each tag is an event of its own, which automations see.
  expect(await eventsOf(f, ['tag.assigned'])).toEqual([
    { type: 'tag.assigned', actor_kind: 'form' },
    { type: 'tag.assigned', actor_kind: 'form' },
  ]);
  // Sent again: the contact carries them already, and nothing is added or said twice.
  expect(await send(form, { email: 'maya@example.test' })).toEqual(OK);
  expect(await tagsOf(f, contact.id)).toHaveLength(2);
  expect(await eventsOf(f, ['tag.assigned'])).toHaveLength(2);
  expect((await suite.stored(f)).submissions).toBe(2);
  // The builder says the form now names a tag that is not there, and will not publish it again.
  const now = formContract.parse(await admin(f, 'getForm', { params: { id: form.id } }));
  expect(now.problems).toEqual([
    {
      path: '/contactActions/tagIds/2',
      code: 'unknown_tag',
      message: 'This tag no longer exists. Remove it or choose another.',
    },
  ]);
  const again = await settled(
    Promise.resolve().then(() =>
      admin(f, 'publishForm', { params: { id: form.id }, body: { revision: now.revision } }),
    ),
  );
  expect(again.ok ? undefined : again.error).toBeInstanceOf(ValidationError);
});

it('gives a contact that has no source the form’s name or a fixed text, and leaves one that has a source alone', async () => {
  const f = await fixture();
  // The form's own name, which a form may still choose. (What a new form starts with, how
  // they arrived, is lead-source.int.test.ts.)
  const named = await published(f, {
    ...DEFAULT_FORM_DEFINITION,
    contactActions: { source: { kind: 'form_name' } },
  });
  expect(await send(named, { email: 'maya@example.test' })).toEqual(OK);
  const fixed = await published(f, {
    fields: [email],
    contactActions: { source: { kind: 'text', text: 'Trade fair 2026' } },
  });
  expect(await send(fixed, { email: 'omar@example.test' })).toEqual(OK);
  // Maya has a source already: another form does not change where she came from.
  expect(await send(fixed, { email: 'maya@example.test' })).toEqual(OK);
  // A contact made some other way, with no source, gets one from the first form to reach it.
  await database.fixtures.contact(f.business.context, { email: 'dana@example.test' });
  expect(await send(fixed, { email: 'dana@example.test' })).toEqual(OK);
  expect(await send(named, { email: 'dana@example.test' })).toEqual(OK);
  const sources = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ email: string; source: string | null }>(
      `select i.value_normalized as email, c.source
       from crm.contacts c join crm.contact_identities i
         on i.business_id = c.business_id and i.contact_id = c.id and i.kind = 'email'
       order by 1`,
    ),
  );
  expect(sources).toEqual([
    { email: 'dana@example.test', source: 'Trade fair 2026' },
    { email: 'maya@example.test', source: 'Enquiry' },
    { email: 'omar@example.test', source: 'Trade fair 2026' },
  ]);
});

it('writes no source and adds no tag for a form that says nothing about either', async () => {
  const f = await fixture();
  // As every form was before forms could say: stored without the setting, and read as it is.
  const quiet = await published(f, { fields: [email] });
  expect(quiet.definition).not.toHaveProperty('contactActions');
  expect(quiet.definition).not.toHaveProperty('afterSubmit');
  expect(quiet.definition).not.toHaveProperty('notify');
  expect(quiet.hasUnpublishedChanges).toBe(false);
  expect(await send(quiet, { email: 'maya@example.test' })).toEqual(OK);
  const none = await published(f, {
    fields: [email],
    contactActions: { source: { kind: 'none' } },
  });
  expect(await send(none, { email: 'maya@example.test' })).toEqual(OK);
  const [contact] = await contactsOf(f);
  expect(contact?.source).toBeNull();
  expect(await tagsOf(f, contact?.id ?? '')).toEqual([]);
});

it('will not publish a form that names someone who is not on the team', async () => {
  const f = await fixture();
  const user = await database.fixtures.user();
  const membership = await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin, permissions)
       values ($1, 'business', 'member', 'member', true, '{}')
       on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
      [f.agency.id],
    );
    return sql.one<{ id: string }>(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4) returning id`,
      [user.id, f.agency.id, f.business.id, role.id],
    );
  });
  const onTeam = toPublicId('membership', membership.id);
  // A well-formed id (a UUIDv7 inside) that names no membership of this team.
  const stranger = toPublicId('membership', randomUUID().replace(/^(.{14})./, '$17'));
  const draft = formContract.parse(await admin(f, 'createForm', { body: { name: 'Enquiry' } }));
  const save = async (current: Form, memberIds: readonly string[]) =>
    formContract.parse(
      await admin(f, 'updateForm', {
        params: { id: current.id },
        body: {
          name: current.name,
          definition: { fields: [email], notify: { mode: 'members', memberIds } },
          allowedOrigins: [],
          revision: current.revision,
        },
      }),
    );
  const wrong = await save(draft, [onTeam, stranger]);
  expect(wrong.problems).toEqual([
    {
      path: '/notify/memberIds/1',
      code: 'unknown_member',
      message: 'This person is no longer on the team. Remove them or choose someone else.',
    },
  ]);
  const right = await save(wrong, [onTeam]);
  expect(right.problems).toEqual([]);
  const live = formContract.parse(
    await admin(f, 'publishForm', { params: { id: right.id }, body: { revision: right.revision } }),
  );
  expect(live.publishedDefinition?.notify).toEqual({ mode: 'members', memberIds: [onTeam] });
});

it('fills a choice field from a hidden question, by a choice’s key or label, and skips text that names none', async () => {
  const f = await fixture();
  const service = await field(f, 'service_interest', 'single_choice', [
    'dj',
    'photo_video',
    'dj_photo_video',
  ]);
  const extras = await field(f, 'extras', 'multi_choice', ['lighting', 'photo_booth']);
  const form = await published(f, {
    title: 'Still in need?',
    fields: [
      email,
      {
        key: 'service_interest',
        type: 'hidden',
        label: 'Service interest',
        parameter: 'service',
        // A label, in other capitals: the field keeps the key.
        defaultValue: 'DJ_PHOTO_VIDEO',
        target: { kind: 'field', fieldId: service.id },
      },
      {
        key: 'extras',
        type: 'hidden',
        label: 'Extras',
        parameter: 'extras',
        target: { kind: 'field', fieldId: extras.id },
      },
    ],
  });
  const valuesOf = async (address: string) => {
    const [contact] = await database.withTenant(f.business.context, (sql) =>
      sql.query<{ id: string }>(
        `select contact_id as id from crm.contact_identities where value_normalized = $1`,
        [address],
      ),
    );
    if (contact === undefined) throw new Error(`No contact for ${address}.`);
    const items = recordFields.parse(
      await crm(f, 'getRecordFields', { params: { id: toPublicId('contact', contact.id) } }),
    ).items;
    return Object.fromEntries(items.map((item) => [item.definition.key, item.value]));
  };
  // The page said nothing: the fixed answer is used, written before any workflow reads it.
  expect(await send(form, { email: 'ada@example.test' })).toEqual(OK);
  expect(await valuesOf('ada@example.test')).toMatchObject({
    service_interest: 'dj_photo_video',
    extras: null,
  });
  // The page's own: a key, and several choices by label.
  expect(
    await send(form, {
      email: 'grace@example.test',
      service_interest: 'photo_video',
      extras: 'Lighting, photo_booth',
    }),
  ).toEqual(OK);
  expect(await valuesOf('grace@example.test')).toMatchObject({
    service_interest: 'photo_video',
    extras: ['lighting', 'photo_booth'],
  });
  // Text that names no choice is not written; it stays with the submission, as said.
  expect(await send(form, { email: 'omar@example.test', service_interest: 'Harp' })).toEqual(OK);
  expect(await valuesOf('omar@example.test')).toMatchObject({ service_interest: null });
  const submissions = await submissionsOf(f, form);
  expect(submissions.find((each) => each.skippedFields.length > 0)).toMatchObject({
    skippedFields: ['service_interest'],
    answers: expect.arrayContaining([
      expect.objectContaining({ key: 'service_interest', value: 'Harp' }),
    ]) as unknown,
  });
});

it('refuses to publish a hidden question whose fixed answer is not one of the field’s choices', async () => {
  const f = await fixture();
  const service = await field(f, 'service_interest', 'single_choice', ['dj', 'photo_video']);
  await expect(
    published(f, {
      title: 'Still in need?',
      fields: [
        email,
        {
          key: 'service_interest',
          type: 'hidden',
          label: 'Service interest',
          defaultValue: 'Photo booth',
          target: { kind: 'field', fieldId: service.id },
        },
      ],
    }),
  ).rejects.toMatchObject({
    issues: [
      {
        path: '/fields/1/defaultValue',
        code: 'unknown_choice',
        message: 'This fixed answer is not one of the contact field’s choices: dj, photo_video.',
      },
    ],
  });
});
