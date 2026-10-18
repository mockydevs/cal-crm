import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { fieldDefinition, fieldConfiguration, fieldValueTypes } from '@repo/contracts';
import { ConflictError, NotFoundError, ValidationError, parsePublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { crmRoutes } from '../index.js';
import { updateFieldCommand } from './fields.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
const editing = (field: ReturnType<typeof fieldDefinition.parse>) => ({
  label: field.label,
  description: field.description,
  options: field.options,
  aiFillSources: field.aiFillSources,
  aiOverwrite: field.aiOverwrite,
  archived: field.archived,
  revision: field.revision,
});
it('requires a description, validates all supported types and exposes read-only configuration', async () => {
  const invocation = await inBusiness();
  await expect(
    call('createField', invocation, { ...input, description: '  ' }),
  ).rejects.toBeInstanceOf(ValidationError);
  for (const valueType of fieldValueTypes) {
    const optioned = ['single_choice', 'multi_choice', 'text_list'].includes(valueType);
    await call('createField', invocation, {
      ...input,
      valueType,
      key: valueType,
      label: valueType,
      currency: valueType === 'money' ? 'KES' : null,
      options: optioned
        ? [{ key: 'lighting', label: 'Lighting', description: 'Lights', archived: false }]
        : [],
      ...(valueType === 'file' ? { files: { formats: ['pdf'], limit: 1 } } : {}),
      // The assistant fills neither a text box list nor a file upload field.
      ...(valueType === 'text_list' || valueType === 'file' ? { aiFillSources: [] } : {}),
    });
  }
  const data = fieldConfiguration.parse(
    await call('getFields', { ...invocation, permissions: new Set() }),
  );
  expect(data.items).toHaveLength(14);
  expect(data.canManage).toBe(false);
  expect(data.objects.map((object) => object.key)).toEqual(['company', 'contact', 'deal']);
  for (const change of [
    { valueType: 'money' },
    { options: [{ key: 'a', label: 'A', description: '', archived: false }] },
    { valueType: 'single_choice' },
    { currency: 'KES' },
    { aiFillSources: ['secrets'] },
  ]) {
    await expect(call('createField', invocation, { ...input, ...change })).rejects.toBeInstanceOf(
      ValidationError,
    );
  }
});
it('keeps labels unique per object, reserves archived keys and allows an archived label to be reused', async () => {
  const invocation = await inBusiness();
  const field = fieldDefinition.parse(await call('createField', invocation, input));
  await expect(
    call('createField', invocation, { ...input, key: 'other', label: ' GUEST COUNT ' }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('createField', invocation, { ...input, label: 'Other name' }),
  ).rejects.toBeInstanceOf(ValidationError);
  await call('createField', invocation, { ...input, objectKey: 'deal' });
  const archived = fieldDefinition.parse(
    await call(
      'updateField',
      invocation,
      { ...editing(field), archived: true },
      { fieldId: field.id },
    ),
  );
  await call('createField', invocation, { ...input, key: 'other' });
  await expect(
    call(
      'updateField',
      invocation,
      { ...editing(archived), archived: false },
      { fieldId: field.id },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('createField', invocation, { ...input, label: 'Replacement' }),
  ).rejects.toBeInstanceOf(ValidationError);
});
it('preserves choice keys across rename, reorder and archive and refuses removal or type-incompatible choices', async () => {
  const invocation = await inBusiness();
  const options = [
    { key: 'lighting', label: 'Lighting', description: 'Lights', archived: false },
    { key: 'sound', label: 'Sound', description: 'Audio', archived: false },
  ];
  const field = fieldDefinition.parse(
    await call('createField', invocation, { ...input, valueType: 'multi_choice', options }),
  );
  const updated = fieldDefinition.parse(
    await call(
      'updateField',
      invocation,
      {
        ...editing(field),
        options: [options[1], { ...options[0], label: 'Lights', archived: true }],
      },
      { fieldId: field.id },
    ),
  );
  expect(updated.options).toEqual([options[1], { ...options[0], label: 'Lights', archived: true }]);
  await expect(
    call(
      'updateField',
      invocation,
      { ...editing(updated), options: [options[1]] },
      { fieldId: field.id },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  const plain = fieldDefinition.parse(
    await call('createField', invocation, { ...input, key: 'plain', label: 'Plain' }),
  );
  await expect(
    call('updateField', invocation, { ...editing(plain), options }, { fieldId: plain.id }),
  ).rejects.toBeInstanceOf(ValidationError);
});
it('isolates fields and object keys between businesses and requires a selected business', async () => {
  const owner = await inBusiness();
  const other = await inBusiness();
  const field = fieldDefinition.parse(await call('createField', owner, input));
  expect(await call('getFields', other)).toMatchObject({ items: [] });
  await expect(
    call('updateField', other, editing(field), { fieldId: field.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('createField', owner, { ...input, objectKey: 'missing' }),
  ).rejects.toBeInstanceOf(ValidationError);
  const { businessId: _businessId, ...context } = owner.context;
  await expect(call('getFields', { ...owner, context })).rejects.toBeInstanceOf(ValidationError);
});
it('serializes duplicate creates and rejects one of two simultaneous edits', async () => {
  const invocation = await inBusiness();
  const attempts = await Promise.allSettled([
    call('createField', invocation, input),
    call('createField', invocation, { ...input, key: 'second' }),
  ]);
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  const field = fieldConfiguration.parse(await call('getFields', invocation)).items[0];
  if (field === undefined) throw new Error('Missing created field.');
  const edits = await Promise.allSettled(
    ['One', 'Two'].map((label) =>
      call('updateField', invocation, { ...editing(field), label }, { fieldId: field.id }),
    ),
  );
  expect(edits.filter((edit) => edit.status === 'fulfilled')).toHaveLength(1);
  const reason: unknown = edits.find((edit) => edit.status === 'rejected')?.reason;
  expect(reason).toBeInstanceOf(ConflictError);
});
it('reserves alias keys and keeps merged definitions closed to edits', async () => {
  const invocation = await inBusiness();
  const user = await database.fixtures.user();
  const field = fieldDefinition.parse(
    await call(
      'createField',
      { ...invocation, context: { ...invocation.context, actorKind: 'user', actorId: user.id } },
      { ...input, archived: true },
    ),
  );
  const target = fieldDefinition.parse(
    await call('createField', invocation, { ...input, key: 'target', label: 'Target' }),
  );
  await database.as('crm_owner', async (sql) => {
    await sql.query(
      `insert into crm.field_key_aliases (business_id, object_type_id, alias_key, field_id)
      select business_id, object_type_id, 'old_key', id from crm.field_definitions where id = $1`,
      [parsePublicId('field', target.id)],
    );
    await sql.query('update crm.field_definitions set merged_into_field_id = $1 where id = $2', [
      parsePublicId('field', target.id),
      parsePublicId('field', field.id),
    ]);
  });
  await expect(
    call('createField', invocation, { ...input, key: 'old_key', label: 'Old key' }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('updateField', invocation, editing(field), { fieldId: field.id }),
  ).rejects.toBeInstanceOf(ValidationError);
  const other = await inBusiness();
  await expect(
    runCommand(services, updateFieldCommand, { ...editing(target), fieldId: target.id }, other),
  ).rejects.toBeInstanceOf(NotFoundError);
  const single = fieldDefinition.parse(
    await call('createField', invocation, {
      ...input,
      key: 'single',
      label: 'Single',
      valueType: 'single_choice',
      options: [{ key: 'a', label: 'A', description: '', archived: false }],
    }),
  );
  await call(
    'updateField',
    invocation,
    { ...editing(single), description: 'Single choice updated.' },
    { fieldId: single.id },
  );
  expect(
    fieldConfiguration.parse(
      await call('getFields', { ...invocation, permissions: new Set(['fields.manage']) }),
    ).canManage,
  ).toBe(true);
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});
async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const invocation: Invocation = {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  return invocation;
}
async function call(
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
) {
  const route = crmRoutes.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run({ invocation, body, params, query: {} }, services);
}
const input = {
  objectKey: 'contact',
  key: 'guest_count',
  label: 'Guest count',
  description: 'The latest expected number of guests.',
  valueType: 'number',
  options: [],
  currency: null,
  aiFillSources: ['conversations'],
  aiOverwrite: 'ask',
  archived: false,
};
it('creates a described field with a stable key and reads its AI policy', async () => {
  const invocation = await inBusiness();
  const created = await call('createField', invocation, input);
  expect(created).toMatchObject(input);
  expect(fieldDefinition.parse(created).id).toMatch(/^fld_/);
  expect(await call('getFields', invocation)).toMatchObject({ items: [created], canManage: true });
});
it('renames a field while keeping its key, object and type immutable', async () => {
  const invocation = await inBusiness();
  const created = fieldDefinition.parse(await call('createField', invocation, input));
  const edit = {
    label: 'Attendees',
    description: created.description,
    options: [],
    aiFillSources: [],
    aiOverwrite: 'never',
    archived: false,
    revision: created.revision,
  };
  const updated = fieldDefinition.parse(
    await call('updateField', invocation, edit, { fieldId: created.id }),
  );
  expect(updated).toMatchObject({
    key: 'guest_count',
    objectKey: 'contact',
    valueType: 'number',
    label: 'Attendees',
    aiOverwrite: 'never',
  });
  await expect(
    call('updateField', invocation, edit, { fieldId: created.id }),
  ).rejects.toBeInstanceOf(ConflictError);
  for (const change of [{ key: 'changed' }, { valueType: 'text' }, { objectKey: 'deal' }]) {
    await expect(
      call(
        'updateField',
        invocation,
        { ...edit, revision: updated.revision, ...change },
        { fieldId: created.id },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  }
});
