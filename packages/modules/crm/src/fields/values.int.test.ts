import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation } from '@repo/commands';
import { fieldDefinition, recordField, recordFields, type FieldDefinition } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { crmRoutes, createCrmRoutes, readRecordField } from '../index.js';

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
async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const invocation: Invocation = {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const record = await database.fixtures.contact(invocation.context);
  return { invocation, recordId: record.id, id: toPublicId('contact', record.id) };
}
async function call(
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, { db, authorize: allowEveryone });
}
async function create(
  invocation: Invocation,
  key: string,
  valueType: FieldDefinition['valueType'] = 'text',
  objectKey = 'contact',
  archivedChoice = true,
) {
  return fieldDefinition.parse(
    await call('createField', invocation, {
      key,
      label: key,
      objectKey,
      valueType,
      description: 'A described contact field.',
      currency: valueType === 'money' ? 'KES' : null,
      options: valueType.endsWith('choice')
        ? [
            {
              key: 'garden',
              label: 'Garden',
              description: 'Outdoor venue.',
              archived: archivedChoice,
            },
          ]
        : [],
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
    }),
  );
}
const cases = [
  ['text', 'value_text', 'Outdoor event', 'Outdoor event'],
  ['long_text', 'value_text', 'Line one\nLine two', 'Line one\nLine two'],
  ['email', 'value_text', 'maya@example.test', 'maya@example.test'],
  ['phone', 'value_text', '+254712345678', '+254712345678'],
  ['url', 'value_text', 'https://example.test/event', 'https://example.test/event'],
  ['number', 'value_number', '9007199254740993.25', '9007199254740993.25'],
  ['money', 'value_number', '1234567890.50', '1234567890.50'],
  ['date', 'value_date', '2026-10-31', '2026-10-31'],
  ['datetime', 'value_datetime', '2026-10-31T23:30:00+03:00', '2026-10-31T20:30:00.000Z'],
  ['boolean', 'value_bool', false, false],
  ['single_choice', 'value_options', ['garden'], 'garden'],
  ['multi_choice', 'value_options', ['garden'], ['garden']],
] as const;
it('reads canonical field revisions for internal commands while preserving tenant isolation', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'automation_value', 'number');
  const read = (actor: Invocation = invocation) =>
    withTenant(db, actor.context, (trx) => readRecordField(trx, actor, id, definition.id));
  const initial = await read();
  expect(
    recordFields.parse(await call('getRecordFields', invocation, undefined, { id })).items,
  ).toEqual([initial]);
  const saved = recordField.parse(
    await call(
      'setRecordField',
      invocation,
      { value: '9007199254740993.25', revision: initial.revision },
      { id, fieldId: definition.id },
    ),
  );
  expect(await read()).toEqual(saved);
  expect(saved.revision).not.toBe(initial.revision);
  const foreign = await fixture();
  await expect(read(foreign.invocation)).rejects.toBeInstanceOf(NotFoundError);
});
it('saves an exact field value with the trusted person and a source event', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'capacity', 'number');
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const saved = await call(
    'setRecordField',
    invocation,
    {
      value: '9007199254740993.25',
      revision: before.items[0]?.revision,
    },
    { id, fieldId: definition.id },
  );
  expect(saved).toMatchObject({
    definition,
    value: '9007199254740993.25',
    source: { kind: 'user', you: true, eventId: expect.stringMatching(/^evt_/) as unknown },
    confidence: null,
    confirmedAt: null,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
  });
  const after = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  expect(after.items).toEqual([saved]);
});
it.each(cases)(
  'writes a typed %s value and reads the same semantic value',
  async (type, _column, stored, expected) => {
    const { invocation, id } = await fixture();
    const definition = await create(invocation, 'detail', type, 'contact', false);
    const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
    const saved = await call(
      'setRecordField',
      invocation,
      {
        value: type === 'single_choice' ? expected : stored,
        revision: before.items[0]?.revision,
      },
      { id, fieldId: definition.id },
    );
    expect(saved).toMatchObject({
      definition,
      value: expected,
      source: { kind: 'user', you: true },
    });
    expect(
      recordFields.parse(await call('getRecordFields', invocation, undefined, { id })).items,
    ).toEqual([saved]);
  },
);
it('clears a value without leaving source metadata and preserves provenance on unchanged retries', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'capacity', 'number');
  const read = async () =>
    recordFields.parse(await call('getRecordFields', invocation, undefined, { id })).items[0];
  const before = await read();
  await call(
    'setRecordField',
    invocation,
    { value: '17.5', revision: before?.revision },
    { id, fieldId: definition.id },
  );
  const saved = await read();
  expect(
    await call(
      'setRecordField',
      invocation,
      { value: '17.50', revision: saved?.revision },
      { id, fieldId: definition.id },
    ),
  ).toEqual(saved);
  const cleared = await call(
    'setRecordField',
    invocation,
    { value: null, revision: saved?.revision },
    { id, fieldId: definition.id },
  );
  expect(cleared).toMatchObject({
    value: null,
    source: null,
    updatedAt: null,
    confidence: null,
    confirmedAt: null,
  });
  expect(await read()).toEqual(cleared);
});
it.each([
  ['text', 'x'.repeat(1001)],
  ['long_text', 'x'.repeat(100001)],
  ['number', '1e5'],
  ['money', 'NaN'],
  ['date', '2026-02-30'],
  ['datetime', '2026-10-08T12:00:00'],
  ['boolean', 'false'],
  ['email', 'invalid'],
  ['phone', '+invalid'],
  ['url', 'javascript:alert(1)'],
  ['single_choice', 'missing'],
  ['multi_choice', ['garden', 'garden']],
] as const)('returns a field-level error for an invalid %s value', async (type, value) => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail', type);
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  await expect(
    call(
      'setRecordField',
      invocation,
      { value, revision: before.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toMatchObject({
    name: 'ValidationError',
    issues: [expect.objectContaining({ path: '/value' })],
  });
});
it('serializes concurrent field edits and rejects stale drafts without replacing the winner', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail');
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const results = await Promise.allSettled(
    ['First', 'Second'].map((value) =>
      call(
        'setRecordField',
        invocation,
        { value, revision: before.items[0]?.revision },
        { id, fieldId: definition.id },
      ),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({ reason: expect.any(ConflictError) as unknown }),
  ]);
  const saved = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  expect(['First', 'Second']).toContain(saved.items[0]?.value);
});
it('denies viewers and hides foreign records, wrong-object fields and unknown fields before body validation', async () => {
  const own = await fixture();
  const foreign = await fixture();
  const definition = await create(own.invocation, 'detail');
  const other = await create(own.invocation, 'deal_detail', 'text', 'deal');
  const before = recordFields.parse(
    await call('getRecordFields', own.invocation, undefined, { id: own.id }),
  );
  await expect(
    call(
      'setRecordField',
      { ...own.invocation, permissions: new Set() },
      { value: 'Denied', revision: before.items[0]?.revision },
      { id: own.id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  for (const params of [
    { id: foreign.id, fieldId: definition.id },
    { id: own.id, fieldId: other.id },
    { id: own.id, fieldId: toPublicId('field', '01890a5d-ac96-774b-bcce-b302099a8057') },
  ])
    await expect(call('setRecordField', own.invocation, undefined, params)).rejects.toBeInstanceOf(
      NotFoundError,
    );
});
it('refuses AI fill from a source the field has not enabled', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail');
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const ai: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorKind: 'ai_agent', actorId: randomUUID() },
  };
  await expect(
    call(
      'setRecordField',
      ai,
      { value: 'Extracted', revision: before.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});
it('requires approval before AI overwrites a human value unless the field explicitly allows it', async () => {
  const { invocation, id } = await fixture();
  const initial = await create(invocation, 'detail');
  const configure = (definition: FieldDefinition, aiOverwrite: 'ask' | 'allow') =>
    call(
      'updateField',
      invocation,
      {
        label: definition.label,
        description: definition.description,
        options: definition.options,
        aiFillSources: ['conversations'],
        aiOverwrite,
        archived: false,
        revision: definition.revision,
      },
      { fieldId: definition.id },
    );
  const definition = fieldDefinition.parse(await configure(initial, 'ask'));
  const read = async () =>
    recordFields.parse(await call('getRecordFields', invocation, undefined, { id })).items[0];
  await call(
    'setRecordField',
    invocation,
    { value: 'Human decision', revision: (await read())?.revision },
    { id, fieldId: definition.id },
  );
  const ai: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorKind: 'ai_agent', actorId: randomUUID() },
  };
  const write = () =>
    read().then((current) =>
      call(
        'setRecordField',
        ai,
        {
          value: 'AI extraction',
          aiSource: 'conversations',
          confidence: 0.8,
          revision: current?.revision,
        },
        { id, fieldId: definition.id },
      ),
    );
  await expect(write()).rejects.toBeInstanceOf(ConflictError);
  expect((await read())?.value).toBe('Human decision');
  await configure(definition, 'allow');
  await write();
  const saved = await read();
  expect(saved).toMatchObject({
    value: 'AI extraction',
    source: { kind: 'ai_agent', you: false },
    confirmedAt: null,
  });
  expect(saved?.confidence).toBeCloseTo(0.8);
});
it('confirms an AI value as the signed-in person while preserving its source event and confidence', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail');
  await call(
    'updateField',
    invocation,
    {
      label: definition.label,
      description: definition.description,
      options: [],
      aiFillSources: ['conversations'],
      aiOverwrite: 'ask',
      archived: false,
      revision: definition.revision,
    },
    { fieldId: definition.id },
  );
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const ai: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorKind: 'ai_agent', actorId: randomUUID() },
  };
  const saved = recordField.parse(
    await call(
      'setRecordField',
      ai,
      {
        value: 'Garden ceremony',
        revision: before.items[0]?.revision,
        aiSource: 'conversations',
        confidence: 0.9,
      },
      { id, fieldId: definition.id },
    ),
  );
  const confirmed = recordField.parse(
    await call(
      'confirmRecordField',
      invocation,
      { revision: saved.revision },
      { id, fieldId: definition.id },
    ),
  );
  expect(confirmed).toMatchObject({
    value: saved.value,
    source: saved.source,
    confidence: saved.confidence,
    confirmedAt: expect.stringMatching(/^\d{4}-/) as unknown,
  });
  expect(confirmed.revision).not.toBe(saved.revision);
  expect(
    recordFields.parse(await call('getRecordFields', invocation, undefined, { id })).items,
  ).toEqual([confirmed]);
  await expect(
    call(
      'confirmRecordField',
      ai,
      { revision: confirmed.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call(
      'confirmRecordField',
      { ...invocation, context: { ...invocation.context, actorKind: 'api_key' } },
      { revision: confirmed.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    call(
      'confirmRecordField',
      invocation,
      { revision: saved.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await call(
      'confirmRecordField',
      invocation,
      { revision: confirmed.revision },
      { id, fieldId: definition.id },
    ),
  ).toEqual(confirmed);
  await expect(
    call(
      'setRecordField',
      ai,
      { value: 'Changed extraction', revision: confirmed.revision, aiSource: 'conversations' },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  const human = recordField.parse(
    await call(
      'setRecordField',
      invocation,
      { value: 'Confirmed with customer', revision: confirmed.revision },
      { id, fieldId: definition.id },
    ),
  );
  expect(human).toMatchObject({
    value: 'Confirmed with customer',
    source: { kind: 'user', you: true },
    confidence: null,
    confirmedAt: null,
  });
  await expect(
    call(
      'confirmRecordField',
      invocation,
      { revision: human.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
});
it('filters and sorts contacts by exact numeric field values with unset values last', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'capacity', 'number');
  const second = await database.fixtures.contact(invocation.context);
  const secondId = toPublicId('contact', second.id);
  const unset = await database.fixtures.contact(invocation.context);
  for (const [recordId, value] of [
    [id, '9007199254740993.25'],
    [secondId, '9007199254740992.50'],
  ] as const) {
    const before = recordFields.parse(
      await call('getRecordFields', invocation, undefined, { id: recordId }),
    );
    await call(
      'setRecordField',
      invocation,
      { value, revision: before.items[0]?.revision },
      { id: recordId, fieldId: definition.id },
    );
  }
  const { contactList } = await import('@repo/contracts');
  const sorted = contactList.parse(
    await call(
      'listContacts',
      invocation,
      undefined,
      {},
      { sortField: definition.id, fieldOrder: 'asc' },
    ),
  );
  expect(sorted.items.map((item) => item.id)).toEqual([
    secondId,
    id,
    toPublicId('contact', unset.id),
  ]);
  const filtered = contactList.parse(
    await call(
      'listContacts',
      invocation,
      undefined,
      {},
      {
        fieldId: definition.id,
        fieldOperator: 'gt',
        fieldValue: '9007199254740993',
        sortField: definition.id,
        fieldOrder: 'desc',
      },
    ),
  );
  expect(filtered.items.map((item) => item.id)).toEqual([id]);
});
it('filters and sorts companies by their own fields without mixing contact values', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'capacity', 'number', 'company');
  const { company, companyList } = await import('@repo/contracts');
  const first = company.parse(await call('createCompany', invocation, { name: 'First' }));
  const second = company.parse(await call('createCompany', invocation, { name: 'Second' }));
  for (const [recordId, value] of [
    [first.id, '2'],
    [second.id, '10'],
  ] as const) {
    const before = recordFields.parse(
      await call('getRecordFields', invocation, undefined, { id: recordId }),
    );
    await call(
      'setRecordField',
      invocation,
      { value, revision: before.items[0]?.revision },
      { id: recordId, fieldId: definition.id },
    );
  }
  const sorted = companyList.parse(
    await call(
      'listCompanies',
      invocation,
      undefined,
      {},
      { sortField: definition.id, fieldOrder: 'asc' },
    ),
  );
  expect(sorted.items.map((item) => item.id)).toEqual([first.id, second.id]);
  const filtered = companyList.parse(
    await call(
      'listCompanies',
      invocation,
      undefined,
      {},
      { fieldId: definition.id, fieldOperator: 'gt', fieldValue: '3' },
    ),
  );
  expect(filtered.items.map((item) => item.id)).toEqual([second.id]);
  await expect(
    call(
      'setRecordField',
      invocation,
      { value: '50', revision: 'a'.repeat(64) },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
});
it.each(cases)(
  'filters %s values and distinguishes unset from false or empty text',
  async (type, _column, _stored, value) => {
    const { invocation, id } = await fixture();
    const definition = await create(invocation, 'detail', type, 'contact', false);
    const other = await database.fixtures.contact(invocation.context);
    const otherId = toPublicId('contact', other.id);
    const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
    await call(
      'setRecordField',
      invocation,
      { value, revision: before.items[0]?.revision },
      { id, fieldId: definition.id },
    );
    const { contactList } = await import('@repo/contracts');
    const queryValue = Array.isArray(value) ? 'garden' : String(value);
    const matched = contactList.parse(
      await call(
        'listContacts',
        invocation,
        undefined,
        {},
        { fieldId: definition.id, fieldOperator: 'equals', fieldValue: queryValue },
      ),
    );
    expect(matched.items.map((item) => item.id)).toEqual([id]);
    const unset = contactList.parse(
      await call(
        'listContacts',
        invocation,
        undefined,
        {},
        { fieldId: definition.id, fieldOperator: 'is_unset' },
      ),
    );
    expect(unset.items.map((item) => item.id)).toEqual([otherId]);
    const set = contactList.parse(
      await call(
        'listContacts',
        invocation,
        undefined,
        {},
        { fieldId: definition.id, fieldOperator: 'is_set', sortField: definition.id },
      ),
    );
    expect(set.items.map((item) => item.id)).toEqual([id]);
  },
);
it('treats text filter metacharacters literally and rejects unsupported comparisons or foreign fields', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail');
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  await call(
    'setRecordField',
    invocation,
    { value: '50%_\\off', revision: before.items[0]?.revision },
    { id, fieldId: definition.id },
  );
  const { contactList } = await import('@repo/contracts');
  const query = { fieldId: definition.id, fieldOperator: 'contains', fieldValue: '%_\\' };
  expect(
    contactList
      .parse(await call('listContacts', invocation, undefined, {}, query))
      .items.map((item) => item.id),
  ).toEqual([id]);
  for (const operator of ['gt', 'gte', 'lt', 'lte'])
    await expect(
      call('listContacts', invocation, undefined, {}, { ...query, fieldOperator: operator }),
    ).rejects.toBeInstanceOf(ValidationError);
  const foreign = await fixture();
  const foreignField = await create(foreign.invocation, 'foreign');
  for (const key of ['fieldId', 'sortField'])
    await expect(
      call(
        'listContacts',
        invocation,
        undefined,
        {},
        { [key]: foreignField.id, ...(key === 'fieldId' ? { fieldOperator: 'is_set' } : {}) },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
});
it('applies inclusive and exclusive numeric boundaries and reports invalid typed queries per field', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'capacity', 'number');
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  await call(
    'setRecordField',
    invocation,
    { value: '10.5', revision: before.items[0]?.revision },
    { id, fieldId: definition.id },
  );
  const { contactList } = await import('@repo/contracts');
  for (const [fieldOperator, fieldValue, expected] of [
    ['gt', '10', [id]],
    ['gte', '10.5', [id]],
    ['lt', '11', [id]],
    ['lte', '10.5', [id]],
    ['gt', '10.5', []],
    ['lt', '10.5', []],
  ] as const) {
    const page = contactList.parse(
      await call(
        'listContacts',
        invocation,
        undefined,
        {},
        { fieldId: definition.id, fieldOperator, fieldValue },
      ),
    );
    expect(page.items.map((item) => item.id)).toEqual(expected);
  }
  await expect(
    call(
      'listContacts',
      invocation,
      undefined,
      {},
      { fieldId: definition.id, fieldOperator: 'equals', fieldValue: 'not numeric' },
    ),
  ).rejects.toMatchObject({
    name: 'ValidationError',
    issues: [expect.objectContaining({ path: '/fieldValue' })],
  });
  await expect(
    call(
      'listContacts',
      invocation,
      undefined,
      {},
      { fieldId: definition.id, fieldOperator: 'contains', fieldValue: '10' },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  const { company } = await import('@repo/contracts');
  const wrongKind = company.parse(await call('createCompany', invocation, { name: 'Anchor' }));
  await expect(
    call(
      'getDeals',
      invocation,
      undefined,
      {},
      {
        sortField: (await create(invocation, 'deal_capacity', 'number', 'deal')).id,
        after: wrongKind.id,
      },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});
it('blocks AI replacement under never and rejects forged extraction metadata from people', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail');
  await call(
    'updateField',
    invocation,
    {
      label: definition.label,
      description: definition.description,
      options: [],
      aiFillSources: ['forms'],
      aiOverwrite: 'never',
      archived: false,
      revision: definition.revision,
    },
    { fieldId: definition.id },
  );
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const ai: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorKind: 'ai_agent', actorId: randomUUID() },
  };
  const extracted = recordField.parse(
    await call(
      'setRecordField',
      ai,
      { value: 'Extracted', aiSource: 'forms', revision: before.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  );
  expect(extracted.confidence).toBeNull();
  await expect(
    call(
      'setRecordField',
      ai,
      { value: 'Replacement', aiSource: 'forms', revision: extracted.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  for (const metadata of [{ confidence: 0.8 }, { aiSource: 'forms' }])
    await expect(
      call(
        'setRecordField',
        invocation,
        { value: 'Forged', revision: extracted.revision, ...metadata },
        { id, fieldId: definition.id },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  const changed = recordField.parse(
    await call(
      'setRecordField',
      invocation,
      { value: 'Human choice', revision: extracted.revision },
      { id, fieldId: definition.id },
    ),
  );
  expect(changed.source?.kind).toBe('user');
  const empty = await create(invocation, 'empty');
  const unset = recordFields
    .parse(await call('getRecordFields', invocation, undefined, { id }))
    .items.find((item) => item.definition.id === empty.id);
  await expect(
    call(
      'confirmRecordField',
      invocation,
      { revision: unset?.revision },
      { id, fieldId: empty.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await call(
      'setRecordField',
      invocation,
      { value: null, revision: unset?.revision },
      { id, fieldId: empty.id },
    ),
  ).toEqual(unset);
});
it('names the source through the injected owning-module lookup without changing the value revision', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail');
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const saved = recordField.parse(
    await call(
      'setRecordField',
      invocation,
      { value: 'Remembered', revision: before.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  );
  const route = createCrmRoutes({
    user: () => Promise.resolve(new Map([[invocation.context.userId ?? '', 'Dana Brooks']])),
  }).find((route) => route.endpoint.operationId === 'getRecordFields');
  if (route === undefined) throw new Error('Missing named field route.');
  const named = recordFields.parse(
    await route.run(
      { invocation, params: { id }, query: {}, body: undefined },
      { db, authorize: allowEveryone },
    ),
  );
  expect(named.items[0]?.source).toMatchObject({ name: 'Dana Brooks', you: true });
  expect(named.items[0]?.revision).toBe(saved.revision);
});
it('pages contact field ties across fifty rows and then unset values without repeats', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'capacity', 'number');
  const ids = [id];
  for (let index = 1; index < 60; index++)
    ids.push(toPublicId('contact', (await database.fixtures.contact(invocation.context)).id));
  const valued = ids.slice(0, 52);
  await database.withTenant(invocation.context, (sql) =>
    sql.query(
      `insert into crm.field_values(business_id,record_id,field_id,value_type,value_number,source_kind) select $1,id,$2,'number',10,'import' from unnest($3::uuid[]) id`,
      [
        invocation.context.businessId,
        parsePublicId('field', definition.id),
        valued.map((id) => parsePublicId('contact', id)),
      ],
    ),
  );
  const { contactList } = await import('@repo/contracts');
  const first = contactList.parse(
    await call('listContacts', invocation, undefined, {}, { sortField: definition.id }),
  );
  expect(first.items).toHaveLength(50);
  if (first.next === null) throw new Error('Missing second page.');
  const second = contactList.parse(
    await call(
      'listContacts',
      invocation,
      undefined,
      {},
      { sortField: definition.id, after: first.next },
    ),
  );
  expect(second.items).toHaveLength(10);
  expect(second.next).toBeNull();
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual([
    ...valued.toSorted(),
    ...ids.slice(52).toSorted(),
  ]);
});
it('allows an enabled AI source to refresh its unconfirmed value under ask', async () => {
  const { invocation, id } = await fixture();
  const definition = await create(invocation, 'detail');
  await call(
    'updateField',
    invocation,
    {
      label: definition.label,
      description: definition.description,
      options: [],
      aiFillSources: ['call_notes'],
      aiOverwrite: 'ask',
      archived: false,
      revision: definition.revision,
    },
    { fieldId: definition.id },
  );
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const ai: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorKind: 'ai_agent', actorId: randomUUID() },
  };
  const first = recordField.parse(
    await call(
      'setRecordField',
      ai,
      { value: 'First extraction', aiSource: 'call_notes', revision: before.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  );
  const second = recordField.parse(
    await call(
      'setRecordField',
      ai,
      { value: 'Updated extraction', aiSource: 'call_notes', revision: first.revision },
      { id, fieldId: definition.id },
    ),
  );
  expect(second.value).toBe('Updated extraction');
  expect(second.source?.eventId).not.toBe(first.source?.eventId);
  expect(recordFields.parse(await call('getRecordFields', ai, undefined, { id })).canConfirm).toBe(
    false,
  );
});
it('rejects stale configuration, archived-field and trashed-record writes without discarding the saved value', async () => {
  const { invocation, id, recordId } = await fixture();
  const definition = await create(invocation, 'detail');
  const before = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  const saved = recordField.parse(
    await call(
      'setRecordField',
      invocation,
      { value: 'Original', revision: before.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  );
  await call(
    'updateField',
    invocation,
    {
      label: definition.label,
      description: 'Changed meaning.',
      options: [],
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: true,
      revision: definition.revision,
    },
    { fieldId: definition.id },
  );
  await expect(
    call(
      'setRecordField',
      invocation,
      { value: 'Stale', revision: saved.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  const archived = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  await expect(
    call(
      'setRecordField',
      invocation,
      { value: 'Archived', revision: archived.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call(
      'confirmRecordField',
      invocation,
      { revision: archived.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await database.withTenant(invocation.context, (sql) =>
    sql.query('update crm.contacts set deleted_at=now() where id=$1', [recordId]),
  );
  const trashed = recordFields.parse(await call('getRecordFields', invocation, undefined, { id }));
  expect(trashed.canManage).toBe(false);
  expect(trashed.canConfirm).toBe(false);
  expect(trashed.items[0]?.value).toBe('Original');
  await expect(
    call(
      'setRecordField',
      invocation,
      { value: null, revision: trashed.items[0]?.revision },
      { id, fieldId: definition.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
});
it('filters and keyset-pages deals by a field in descending order with unset last', async () => {
  const { invocation } = await fixture();
  const definition = await create(invocation, 'capacity', 'number', 'deal');
  const pipeline = await database.withTenant(invocation.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into crm.pipelines(business_id,name,position) values($1,'Bookings',0) returning id",
      [invocation.context.businessId],
    ),
  );
  const stage = await database.withTenant(invocation.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into crm.pipeline_stages(business_id,pipeline_id,name,position) values($1,$2,'Enquiry',0) returning id",
      [invocation.context.businessId, pipeline.id],
    ),
  );
  const { deal, dealList } = await import('@repo/contracts');
  const records = [];
  for (const [index, value] of ['3', '20', null].entries()) {
    const current = deal.parse(
      await call('createDeal', invocation, {
        name: `Booking ${String(index)}`,
        pipelineId: toPublicId('pipeline', pipeline.id),
        stageId: toPublicId('stage', stage.id),
        currency: 'KES',
      }),
    );
    records.push(current.id);
    if (value === null) continue;
    const before = recordFields.parse(
      await call('getRecordFields', invocation, undefined, { id: current.id }),
    );
    await call(
      'setRecordField',
      invocation,
      { value, revision: before.items[0]?.revision },
      { id: current.id, fieldId: definition.id },
    );
  }
  const query = { sortField: definition.id, fieldOrder: 'desc', limit: '1' };
  const first = dealList.parse(await call('getDeals', invocation, undefined, {}, query));
  expect(first.items.map((item) => item.id)).toEqual([records[1]]);
  const second = dealList.parse(
    await call('getDeals', invocation, undefined, {}, { ...query, after: first.next ?? '' }),
  );
  expect(second.items.map((item) => item.id)).toEqual([records[0]]);
  const last = dealList.parse(
    await call('getDeals', invocation, undefined, {}, { ...query, after: second.next ?? '' }),
  );
  expect(last.items.map((item) => item.id)).toEqual([records[2]]);
  expect(last.next).toBeNull();
  const filtered = dealList.parse(
    await call(
      'getDeals',
      invocation,
      undefined,
      {},
      { fieldId: definition.id, fieldOperator: 'gt', fieldValue: '10' },
    ),
  );
  expect(filtered.items.map((item) => item.id)).toEqual([records[1]]);
});
it.each(cases)(
  'reads %s without losing precision, false, local dates or archived choice keys',
  async (type, column, stored, expected) => {
    const { invocation, recordId, id } = await fixture();
    const field = await create(invocation, 'event_detail', type);
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        `insert into crm.field_values (business_id, record_id, field_id, value_type, ${column}, source_kind, source_id, confidence, updated_at)
     values ($1,$2,$3,$4,$5,'user',$6,0.9,$7)`,
        [
          invocation.context.businessId,
          recordId,
          parsePublicId('field', field.id),
          type,
          stored,
          invocation.context.userId,
          '2026-10-08T10:00:00Z',
        ],
      ),
    );
    const response = recordFields.parse(
      await call('getRecordFields', { ...invocation, permissions: new Set() }, undefined, { id }),
    );
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      definition: field,
      value: expected,
      source: { kind: 'user', eventId: null, you: true },
      updatedAt: '2026-10-08T10:00:00.000Z',
      confirmedAt: null,
    });
    expect(response.items[0]?.confidence).toBeCloseTo(0.9);
  },
);

it('shows unset live fields and archived saved values, scoped to the record object, also in trash', async () => {
  const { invocation, recordId, id } = await fixture();
  const live = await create(invocation, 'live');
  const archived = await create(invocation, 'archived');
  const emptyArchived = await create(invocation, 'empty_archived');
  const merged = await create(invocation, 'merged');
  await create(invocation, 'deal_only', 'text', 'deal');
  const eventId = '01890a5d-ac96-774b-bcce-b302099a8057';
  await database.withTenant(invocation.context, async (sql) => {
    await sql.query(
      'update crm.field_definitions set archived_at=now(),merged_into_field_id=$1 where id=$2',
      [parsePublicId('field', live.id), parsePublicId('field', merged.id)],
    );
    await sql.query(
      "insert into crm.field_values(business_id,record_id,field_id,value_type,value_text,source_kind) values ($1,$2,$3,'text','Old merged value','import')",
      [invocation.context.businessId, recordId, parsePublicId('field', merged.id)],
    );
    await sql.query('update crm.field_definitions set archived_at=now() where id=any($1::uuid[])', [
      [parsePublicId('field', archived.id), parsePublicId('field', emptyArchived.id)],
    ]);
    await sql.query(
      `insert into crm.field_values (business_id,record_id,field_id,value_type,value_text,source_kind,source_event_id,confirmed_by_id,confirmed_at)
      values ($1,$2,$3,'text','Remembered value','ai_agent',$4,$5,'2026-10-08T10:00:00Z')`,
      [
        invocation.context.businessId,
        recordId,
        parsePublicId('field', archived.id),
        eventId,
        invocation.context.userId,
      ],
    );
    await sql.query('update crm.contacts set deleted_at=now() where id=$1', [recordId]);
  });
  const { items } = recordFields.parse(
    await call('getRecordFields', invocation, undefined, { id }),
  );
  expect(items.map((item) => item.definition.key)).toEqual(['live', 'archived']);
  expect(items[0]).toMatchObject({ definition: live, value: null, source: null, updatedAt: null });
  expect(items[1]).toMatchObject({
    definition: { archived: true },
    value: 'Remembered value',
    source: { kind: 'ai_agent', eventId: toPublicId('event', eventId), you: false },
    confirmedAt: '2026-10-08T10:00:00.000Z',
  });
});

it('hides foreign and missing records and rejects malformed ids', async () => {
  const own = await fixture();
  const foreign = await fixture();
  await expect(
    call('getRecordFields', own.invocation, undefined, { id: foreign.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('getRecordFields', own.invocation, undefined, {
      id: toPublicId('contact', '01890a5d-ac96-774b-bcce-b302099a8057'),
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('getRecordFields', own.invocation, undefined, { id: 'con_wrong' }),
  ).rejects.toBeInstanceOf(ValidationError);
});
