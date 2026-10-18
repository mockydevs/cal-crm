// The form builder's API against Postgres, through the module's own routes.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import {
  DEFAULT_FORM_DEFINITION,
  form as formContract,
  formDefinition,
  formList,
  type Form,
  type FormDefinitionInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';

import { formSuite, PUBLIC_URL, settled, untilWaiting, WEBSITE } from '../test/form-fixtures.js';
import { readForm } from './forms.js';
import { readFormKeys, readFormNames } from './index.js';

const suite = formSuite();
const { fixture, admin, published, field } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});
type Fixture = Awaited<ReturnType<typeof fixture>>;

const create = async (f: Fixture, name = 'Enquiry'): Promise<Form> =>
  formContract.parse(await admin(f, 'createForm', { body: { name } }));
const read = async (f: Fixture, id: string, invocation?: Invocation): Promise<Form> =>
  formContract.parse(await admin(f, 'getForm', { params: { id } }, invocation));
const save = async (
  f: Fixture,
  current: Form,
  change: { name?: string; definition?: FormDefinitionInput; allowedOrigins?: readonly string[] },
): Promise<Form> =>
  formContract.parse(
    await admin(f, 'updateForm', {
      params: { id: current.id },
      body: {
        name: change.name ?? current.name,
        definition: change.definition ?? current.definition,
        allowedOrigins: change.allowedOrigins ?? current.allowedOrigins,
        revision: current.revision,
      },
    }),
  );
const act = async (
  f: Fixture,
  operationId: 'publishForm' | 'unpublishForm' | 'archiveForm' | 'restoreForm',
  current: Pick<Form, 'id' | 'revision'>,
  invocation?: Invocation,
): Promise<Form> =>
  formContract.parse(
    await admin(
      f,
      operationId,
      { params: { id: current.id }, body: { revision: current.revision } },
      invocation,
    ),
  );
/** A refusal as a rejection, whether the route threw before or after it returned a promise. */
const attempt = <T>(work: () => Promise<T>): Promise<T> => Promise.resolve().then(work);
/** The refusal itself, when it is of the kind expected. */
async function refusalOf<Refusal extends Error>(
  work: () => Promise<unknown>,
  kind: abstract new (...parameters: never[]) => Refusal,
): Promise<Refusal> {
  const result = await settled(attempt(work));
  if (result.ok) throw new Error('Nothing was refused.');
  if (!(result.error instanceof kind)) throw result.error;
  return result.error;
}
const events = (f: Fixture) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ type: string; actor_kind: string }>(
      "select type, actor_kind from events.events where type like 'form.%' order by recorded_at, id",
    ),
  );

it('creates a draft that asks for a name and an email address, with a key and the line to paste', async () => {
  const f = await fixture();
  const made = await create(f, '  Wedding enquiry ');
  expect(made).toMatchObject({
    name: 'Wedding enquiry',
    status: 'draft',
    allowedOrigins: [],
    definition: DEFAULT_FORM_DEFINITION,
    publishedDefinition: null,
    publishedAt: null,
    hasUnpublishedChanges: false,
    submissionCount: 0,
    canManage: true,
    // Nothing stands between a new form and its own page: it needs no website listed.
    problems: [],
  });
  expect(made.publicKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(made.embedSnippet).toBe(
    `<script async src="${PUBLIC_URL}/forms/embed.js" data-form-key="${made.publicKey}"></script>`,
  );
  // The link to share where there is no website: the form's own page, served by the CRM.
  expect(made.hostedUrl).toBe(`${PUBLIC_URL}/f/${made.publicKey}`);
  // A contact a new form reaches that has no source gets the form's name as its source.
  expect(made.definition.contactActions).toEqual({
    tagIds: [],
    source: { kind: 'arrived' },
    tagBySource: true,
  });
  // Every form has a key of its own.
  expect((await create(f)).publicKey).not.toBe(made.publicKey);
  expect(await events(f)).toEqual([
    { type: 'form.created', actor_kind: 'user' },
    { type: 'form.created', actor_kind: 'user' },
  ]);
  for (const name of ['', '   ', 'x'.repeat(121)])
    await expect(attempt(() => admin(f, 'createForm', { body: { name } }))).rejects.toBeInstanceOf(
      ValidationError,
    );
});

it('saves the draft and its websites, each website once in its one stored form', async () => {
  const f = await fixture();
  const made = await create(f);
  const definition = {
    ...DEFAULT_FORM_DEFINITION,
    title: 'Ask us <b>anything</b>',
    fields: [
      ...DEFAULT_FORM_DEFINITION.fields,
      { key: 'notes', type: 'long_text', label: 'Notes' },
    ],
  } satisfies FormDefinitionInput;
  const saved = await save(f, made, {
    name: 'Contact us',
    definition,
    allowedOrigins: [
      'https://WWW.Example.com/',
      'https://www.example.com',
      'http://localhost:5173',
    ],
  });
  expect(saved).toMatchObject({
    name: 'Contact us',
    status: 'draft',
    allowedOrigins: ['https://www.example.com', 'http://localhost:5173'],
    definition: formDefinition.parse(definition),
    problems: [],
  });
  expect(saved.revision).not.toBe(made.revision);
  expect(await read(f, made.id)).toEqual(saved);
  // Plain HTTP outside a developer's own machine has no stored form, and says where.
  const refused = await refusalOf(
    () => save(f, saved, { allowedOrigins: ['https://ok.example.com', 'http://www.example.com'] }),
    ValidationError,
  );
  expect(refused.issues).toEqual([
    {
      path: '/allowedOrigins/1',
      code: 'invalid_origin',
      message: 'Enter a secure website address, such as https://www.example.com.',
    },
  ]);
  expect(await read(f, made.id)).toEqual(saved);
});

it('refuses a save made from a revision someone else has since changed, and changes nothing', async () => {
  const f = await fixture();
  const made = await create(f);
  const mine = await save(f, made, { name: 'Mine' });
  await expect(attempt(() => save(f, made, { name: 'Theirs' }))).rejects.toBeInstanceOf(
    ConflictError,
  );
  for (const operationId of ['publishForm', 'unpublishForm', 'archiveForm', 'restoreForm'] as const)
    await expect(attempt(() => act(f, operationId, made))).rejects.toBeInstanceOf(ConflictError);
  expect(await read(f, made.id)).toEqual(mine);
});

it('lets exactly one of two saves of the same revision through', async () => {
  const f = await fixture();
  const made = await create(f);
  const ready = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  // Someone holds the form's row, so both saves queue behind it at the same revision.
  const holding = database.as('crm_owner', async (sql) => {
    await sql.query('select 1 from forms.forms where public_key = $1 for update', [made.publicKey]);
    ready.resolve(undefined);
    await release.promise;
  });
  await ready.promise;
  const saves = ['First', 'Second'].map((name) => settled(attempt(() => save(f, made, { name }))));
  try {
    await untilWaiting(database, '%from "forms"."forms"%for update%', 2);
  } finally {
    release.resolve(undefined);
  }
  await holding;
  const results = await Promise.all(saves);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const lost = results.flatMap((result) => (result.ok ? [] : [result.error]));
  expect(lost).toHaveLength(1);
  expect(lost[0]).toBeInstanceOf(ConflictError);
  const won = results.find((result) => result.ok);
  expect((await read(f, made.id)).name).toBe(won?.ok === true ? won.value.name : '');
});

it('publishes only a draft with nothing wrong, and then serves exactly what was published', async () => {
  const f = await fixture();
  const made = await create(f);
  expect(made.status).toBe('draft');

  const listed = await save(f, made, { allowedOrigins: [WEBSITE] });
  const live = await act(f, 'publishForm', listed);
  expect(live).toMatchObject({
    status: 'published',
    definition: DEFAULT_FORM_DEFINITION,
    publishedDefinition: DEFAULT_FORM_DEFINITION,
    hasUnpublishedChanges: false,
    problems: [],
  });
  expect(live.publishedAt).not.toBeNull();

  // An edit after that is a draft again: websites go on getting what was published.
  const edited = await save(f, live, {
    definition: { ...DEFAULT_FORM_DEFINITION, title: 'New title', fields: [] },
  });
  expect(edited).toMatchObject({
    status: 'published',
    hasUnpublishedChanges: true,
    publishedDefinition: DEFAULT_FORM_DEFINITION,
    publishedAt: live.publishedAt,
  });
  expect(edited.definition.title).toBe('New title');
  // The draft now has nothing to ask, so it cannot replace what is live.
  await expect(attempt(() => act(f, 'publishForm', edited))).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect((await read(f, made.id)).publishedDefinition).toEqual(DEFAULT_FORM_DEFINITION);

  const fixed = await save(f, edited, {
    definition: { ...DEFAULT_FORM_DEFINITION, title: 'New title' },
  });
  const again = await act(f, 'publishForm', fixed);
  expect(again.publishedDefinition?.title).toBe('New title');
  expect(again.hasUnpublishedChanges).toBe(false);
  // Each publication is a version of its own.
  expect(Date.parse(again.publishedAt ?? '')).toBeGreaterThan(Date.parse(live.publishedAt ?? ''));
  expect((await events(f)).map((event) => event.type)).toEqual([
    'form.created',
    'form.updated',
    'form.published',
    'form.updated',
    'form.updated',
    'form.published',
  ]);
});

it('moves a form between draft, published and archived, and nowhere it should not go', async () => {
  const f = await fixture();
  const live = await published(f);
  await expect(attempt(() => act(f, 'restoreForm', live))).rejects.toBeInstanceOf(ConflictError);
  const draft = await act(f, 'unpublishForm', live);
  expect(draft).toMatchObject({
    status: 'draft',
    publishedDefinition: null,
    publishedAt: null,
    definition: DEFAULT_FORM_DEFINITION,
  });
  await expect(attempt(() => act(f, 'unpublishForm', draft))).rejects.toBeInstanceOf(ConflictError);
  const republished = await act(f, 'publishForm', draft);
  const archived = await act(f, 'archiveForm', republished);
  expect(archived).toMatchObject({ status: 'archived', publishedDefinition: null });
  // An archived form is put back before anything else is done with it.
  await expect(attempt(() => act(f, 'archiveForm', archived))).rejects.toBeInstanceOf(
    ConflictError,
  );
  await expect(attempt(() => act(f, 'publishForm', archived))).rejects.toBeInstanceOf(
    ConflictError,
  );
  await expect(attempt(() => save(f, archived, { name: 'Changed' }))).rejects.toBeInstanceOf(
    ConflictError,
  );
  const restored = await act(f, 'restoreForm', archived);
  expect(restored).toMatchObject({ status: 'draft', name: 'Enquiry' });
  // A draft can be archived without ever having been published.
  expect((await act(f, 'archiveForm', restored)).status).toBe('archived');
  expect((await events(f)).map((event) => event.type).slice(3)).toEqual([
    'form.unpublished',
    'form.published',
    'form.archived',
    'form.restored',
    'form.archived',
  ]);
});

it("checks a question's contact field against the business's fields as they are now", async () => {
  const f = await fixture();
  const budget = await field(f, 'budget', 'number');
  const venue = await field(f, 'venue', 'single_choice', ['harbor', 'garden']);
  const definition = {
    ...DEFAULT_FORM_DEFINITION,
    fields: [
      ...DEFAULT_FORM_DEFINITION.fields,
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
          { key: 'cellar', label: 'Cellar' },
        ],
        target: { kind: 'field', fieldId: venue.id },
      },
    ],
  } satisfies FormDefinitionInput;
  const made = await save(f, await create(f), { definition, allowedOrigins: [WEBSITE] });
  expect(made.problems.map((problem) => `${problem.path} ${problem.code}`)).toEqual([
    '/fields/3/options/1/key unknown_choice',
  ]);
  const fixedChoice = await save(f, made, {
    definition: {
      ...definition,
      fields: definition.fields.map((each) =>
        each.key === 'venue'
          ? { ...each, options: [{ key: 'harbor', label: 'Harbor room' }] }
          : each,
      ),
    },
  });
  expect(fixedChoice.problems).toEqual([]);
  const live = await act(f, 'publishForm', fixedChoice);

  // The field is archived afterwards: the published form goes on, the next publish stops.
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.field_definitions set archived_at = now() where key = $1', ['budget']),
  );
  const after = await read(f, live.id);
  expect(after.status).toBe('published');
  expect(after.problems.map((problem) => `${problem.path} ${problem.code}`)).toEqual([
    '/fields/2/target archived_field',
  ]);
  const edited = await save(f, after, { name: 'Enquiry 2' });
  await expect(attempt(() => act(f, 'publishForm', edited))).rejects.toBeInstanceOf(
    ValidationError,
  );
  // Another business's field is no field of this one.
  const other = await fixture();
  const theirs = await field(other, 'budget', 'number');
  const borrowed = await save(f, edited, {
    definition: {
      ...DEFAULT_FORM_DEFINITION,
      fields: [
        ...DEFAULT_FORM_DEFINITION.fields,
        {
          key: 'budget',
          type: 'number',
          label: 'Budget',
          target: { kind: 'field', fieldId: theirs.id },
        },
      ],
    },
  });
  expect(borrowed.problems.map((problem) => `${problem.path} ${problem.code}`)).toEqual([
    '/fields/2/target unknown_field',
  ]);
});

it('lists forms in creation order in pages, archived ones apart, with their submission counts', async () => {
  const f = await fixture();
  const first = await published(f);
  const second = await create(f, 'Second');
  const third = await act(f, 'archiveForm', await create(f, 'Third'));
  const list = async (query: Record<string, string> = {}) =>
    formList.parse(await admin(f, 'listForms', { query }));
  const page = await list({ limit: '1' });
  expect(page.items.map((item) => item.name)).toEqual(['Enquiry']);
  expect(page.nextCursor).toBe(first.id);
  expect(page.canManage).toBe(true);
  const rest = await list({ limit: '1', after: first.id });
  expect(rest.items.map((item) => item.name)).toEqual(['Second']);
  expect(rest.nextCursor).toBeNull();
  expect((await list({ archived: 'true' })).items.map((item) => item.id)).toEqual([third.id]);
  expect((await list()).items).toEqual([
    {
      id: first.id,
      name: 'Enquiry',
      status: 'published',
      hasUnpublishedChanges: false,
      submissionCount: 0,
      lastSubmissionAt: null,
      updatedAt: first.updatedAt,
    },
    {
      id: second.id,
      name: 'Second',
      status: 'draft',
      hasUnpublishedChanges: false,
      submissionCount: 0,
      lastSubmissionAt: null,
      updatedAt: second.updatedAt,
    },
  ]);
  await suite.submit(first, { email: 'maya@example.test' });
  await suite.submit(first, { email: 'omar@example.test' });
  const counted = (await list()).items[0];
  expect(counted?.submissionCount).toBe(2);
  expect(counted?.lastSubmissionAt).not.toBeNull();
  expect((await read(f, first.id)).submissionCount).toBe(2);
  // An edit to a published form shows in the list as changes not yet live.
  await save(f, await read(f, first.id), {
    definition: { ...DEFAULT_FORM_DEFINITION, title: 'Changed' },
  });
  expect((await list()).items[0]?.hasUnpublishedChanges).toBe(true);
});

it('lets anyone in the business read forms, and only someone with forms.manage change them', async () => {
  const f = await fixture();
  const live = await published(f);
  const reader: Invocation = { ...f.manager, permissions: new Set(['contacts.manage']) };
  expect(await read(f, live.id, reader)).toEqual({ ...live, canManage: false });
  expect(formList.parse(await admin(f, 'listForms', {}, reader))).toMatchObject({
    canManage: false,
    items: [{ id: live.id }],
  });
  const body = {
    name: 'Taken over',
    definition: DEFAULT_FORM_DEFINITION,
    allowedOrigins: ['https://attacker.example'],
    revision: live.revision,
  };
  for (const work of [
    () => admin(f, 'createForm', { body: { name: 'Mine' } }, reader),
    () => admin(f, 'updateForm', { params: { id: live.id }, body }, reader),
    () => act(f, 'publishForm', live, reader),
    () => act(f, 'unpublishForm', live, reader),
    () => act(f, 'archiveForm', live, reader),
    () => act(f, 'restoreForm', live, reader),
  ])
    expect((await refusalOf(work, ForbiddenError)).permission).toBe('forms.manage');
  expect(await read(f, live.id)).toEqual(live);
});

it("keeps one business's forms out of another's reach, in the same agency and in another", async () => {
  const f = await fixture();
  const live = await published(f);
  const sibling = await database.fixtures.business(f.agency.id);
  const strangers = await fixture();
  const neighbours: Fixture = {
    ...f,
    business: sibling,
    manager: { ...f.manager, context: { ...f.manager.context, businessId: sibling.id } },
  };
  for (const other of [neighbours, strangers]) {
    expect(formList.parse(await admin(other, 'listForms')).items).toEqual([]);
    for (const work of [
      () => admin(other, 'getForm', { params: { id: live.id } }),
      () => admin(other, 'listFormSubmissions', { params: { id: live.id } }),
      () => act(other, 'unpublishForm', live),
      () => act(other, 'archiveForm', live),
      () =>
        admin(other, 'updateForm', {
          params: { id: live.id },
          body: {
            name: 'Theirs',
            definition: DEFAULT_FORM_DEFINITION,
            allowedOrigins: [],
            revision: live.revision,
          },
        }),
    ])
      await expect(attempt(work)).rejects.toBeInstanceOf(NotFoundError);
  }
  expect(await read(f, live.id)).toEqual(live);
  // An id that is no form's id finds nothing either.
  for (const id of ['form_01h455vb4pex5vsknk084sn02q', 'con_01h455vb4pex5vsknk084sn02q'])
    await expect(
      attempt(() =>
        withTenant(suite.db, f.manager.context, (trx) => readForm(trx, f.manager, id, PUBLIC_URL)),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
});

it('needs a business to work in, and refuses a change in one that is not active', async () => {
  const f = await fixture();
  const live = await published(f);
  const { businessId: _business, ...agencyOnly } = f.manager.context;
  await expect(
    attempt(() => admin(f, 'listForms', {}, { ...f.manager, context: agencyOnly })),
  ).rejects.toBeInstanceOf(ValidationError);
  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [f.business.id]),
  );
  for (const work of [
    () => admin(f, 'createForm', { body: { name: 'Late' } }),
    () => act(f, 'unpublishForm', live),
  ])
    await expect(attempt(work)).rejects.toBeInstanceOf(ConflictError);
  expect((await read(f, live.id)).status).toBe('published');
});

it('shows a form from before the builder as an empty draft that must be built before it is published', async () => {
  const f = await fixture();
  const key = `pk_legacy_${randomUUID().replaceAll('-', '').slice(0, 22)}`;
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into forms.forms (business_id, name, definition, public_key, allowed_origins)
       values (app.business_id(), 'Old form', '{"questions": ["email"]}', $1, '{https://www.example.com}')`,
      [key],
    ),
  );
  const [listed] = formList.parse(await admin(f, 'listForms')).items;
  if (listed === undefined) throw new Error('The old form is not listed.');
  const old = await read(f, listed.id);
  expect(old).toMatchObject({
    name: 'Old form',
    publicKey: key,
    definition: { fields: [], consents: [] },
    problems: [{ path: '/fields', code: 'unreadable_definition' }],
  });
  await expect(attempt(() => act(f, 'publishForm', old))).rejects.toBeInstanceOf(ValidationError);
  // Built and saved, it is a form like any other.
  const built = await save(f, old, { definition: DEFAULT_FORM_DEFINITION });
  expect(built.problems).toEqual([]);
  expect((await act(f, 'publishForm', built)).status).toBe('published');
});

it('names forms for whoever shows who acted, and only forms of the business asked in', async () => {
  const f = await fixture();
  const other = await fixture();
  const mine = await create(f, 'Wedding enquiry');
  const theirs = await create(other, 'Their form');
  const ids = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string; name: string }>(
      'select id, name from forms.forms where public_key = any($1)',
      [[mine.publicKey, theirs.publicKey]],
    ),
  );
  const names = await withTenant(suite.db, f.manager.context, (trx) =>
    readFormNames(trx, [...ids.map((row) => row.id), ...ids.map((row) => row.id)]),
  );
  expect([...names.values()]).toEqual(['Wedding enquiry']);
  expect(await withTenant(suite.db, f.manager.context, (trx) => readFormNames(trx, []))).toEqual(
    new Map(),
  );
  // The key a site's page shows a form by, and whether the form is published.
  const keys = await withTenant(suite.db, f.manager.context, (trx) =>
    readFormKeys(
      trx,
      ids.map((row) => row.id),
    ),
  );
  expect([...keys.values()]).toEqual([{ publicKey: mine.publicKey, published: false }]);
  expect(await withTenant(suite.db, f.manager.context, (trx) => readFormKeys(trx, []))).toEqual(
    new Map(),
  );
});
