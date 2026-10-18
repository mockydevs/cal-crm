import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation } from '@repo/commands';
import { fieldDefinition, recordField, recordFields, type FieldDefinition } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { crmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture(valueType: FieldDefinition['valueType']) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const invocation: Invocation = {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  const contact = await database.fixtures.contact(invocation.context);
  const id = toPublicId('contact', contact.id);
  const call = async (operationId: string, body: unknown, params: Record<string, string> = {}) => {
    const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`Missing ${operationId} route.`);
    return route.run({ invocation, body, params, query: {} }, { db, authorize: allowEveryone });
  };
  const definition = fieldDefinition.parse(
    await call('createField', {
      objectKey: 'contact',
      key: 'references',
      label: 'References',
      description: 'References supplied by the contact.',
      valueType,
      currency: null,
      options:
        valueType === 'file'
          ? []
          : [
              { key: 'first', label: 'First', description: '', archived: false },
              { key: 'second', label: 'Second', description: '', archived: false },
            ],
      ...(valueType === 'file' ? { files: { formats: ['pdf'], limit: 1 } } : {}),
      aiFillSources: [],
      aiOverwrite: 'never',
      archived: false,
    }),
  );
  const params = { id, fieldId: definition.id };
  const read = async () => {
    const { items } = recordFields.parse(await call('getRecordFields', undefined, { id }));
    const field = items.find((item) => item.definition.id === definition.id);
    if (field === undefined) throw new Error('The created field is missing from its record.');
    return field;
  };
  const set = async (value: unknown) =>
    recordField.parse(
      await call('setRecordField', { value, revision: (await read()).revision }, params),
    );
  const archiveSecond = () =>
    call(
      'updateField',
      {
        label: definition.label,
        description: definition.description,
        options: definition.options.map((option) => ({
          ...option,
          archived: option.key === 'second',
        })),
        aiFillSources: definition.aiFillSources,
        aiOverwrite: definition.aiOverwrite,
        archived: false,
        revision: definition.revision,
      },
      { fieldId: definition.id },
    );
  return { read, set, archiveSecond };
}

it('keeps filled text boxes, omits empty boxes and clears the value when every box is empty', async () => {
  const field = await fixture('text_list');
  expect((await field.set({ first: 'Ada', second: '   ' })).value).toEqual({ first: 'Ada' });
  expect((await field.read()).value).toEqual({ first: 'Ada' });
  expect((await field.set({ first: ' \t ' })).value).toBeNull();
  expect((await field.read()).value).toBeNull();
});

it('allows an archived text box to keep its existing text but refuses a new value after clearing', async () => {
  const field = await fixture('text_list');
  await field.set({ first: 'Ada', second: 'Grace' });
  await field.archiveSecond();
  expect((await field.set({ second: 'Updated reference' })).value).toEqual({
    second: 'Updated reference',
  });
  await field.set(null);
  await expect(field.set({ second: 'New reference' })).rejects.toMatchObject({
    issues: [{ path: '/value/second', code: 'invalid_box' }],
  });
  expect((await field.read()).value).toBeNull();
});

it.each([
  { label: 'unknown box', value: { unknown: 'Not a box' } },
  { label: 'overlong text', value: { first: 'x'.repeat(1001) } },
  { label: 'array', value: ['first'] },
  { label: 'plain text', value: 'plain text' },
])(
  'refuses an invalid text box list without replacing its saved value ($label)',
  async ({ value }) => {
    const field = await fixture('text_list');
    const saved = await field.set({ first: 'Ada' });
    await expect(field.set(value)).rejects.toThrow(ValidationError);
    expect(await field.read()).toEqual(saved);
  },
);

it.each(['single_choice', 'multi_choice'] as const)(
  'retains an archived %s selection but refuses selecting it again after clearing',
  async (valueType) => {
    const field = await fixture(valueType);
    const value = valueType === 'single_choice' ? 'second' : ['second'];
    await field.set(value);
    await field.archiveSecond();
    expect((await field.set(value)).value).toEqual(value);
    await field.set(null);
    await expect(field.set(value)).rejects.toMatchObject({
      issues: [{ path: '/value', code: 'invalid_choice' }],
    });
    expect((await field.read()).value).toBeNull();
  },
);

it('refuses replacing or clearing file values through the generic field setter', async () => {
  const field = await fixture('file');
  for (const value of [[], null]) {
    await expect(field.set(value)).rejects.toMatchObject({
      issues: [{ path: '/value', code: 'files_by_upload' }],
    });
  }
});
