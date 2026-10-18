import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  MAX_CUSTOM_OBJECTS,
  fieldDefinition,
  fieldDeletion,
  objectDefinition,
  objectDetail,
  objectList,
  type ObjectDefinition,
} from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  parsePublicId,
  toPublicId,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createFieldDeletionRoutes,
  createObjectRoutes,
  crmRoutes,
  purgeObjectTask,
} from '../index.js';

let database: TestDatabase;
let services: Services;
/** What the automation module would say uses the object being deleted. */
let inUse: { id: string; name: string }[] = [];
const asked: string[] = [];
const routes = [
  ...createObjectRoutes({
    uses: (_trx, key) => {
      asked.push(key);
      return Promise.resolve(inUse);
    },
  }),
  ...createFieldDeletionRoutes({
    uses: () => Promise.resolve({ templates: [], automations: [] }),
  }),
  ...crmRoutes,
];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});

async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}
async function call(
  operationId: string,
  invocation: Invocation,
  params: unknown = {},
  body?: unknown,
  query: unknown = {},
): Promise<unknown> {
  const route = routes.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, services);
}
const pet = {
  singularLabel: 'Pet',
  pluralLabel: 'Pets',
  icon: 'paw-print',
  description: 'Animals we look after.',
  primaryField: { label: 'Pet name', valueType: 'text', unique: true },
};
const create = async (invocation: Invocation, body: object = pet): Promise<ObjectDefinition> =>
  objectDefinition.parse(await call('createObject', invocation, {}, body));
const detail = async (invocation: Invocation, key: string) =>
  objectDetail.parse(await call('getObject', invocation, { key }));
const issueOf = (error: unknown) => (error instanceof ValidationError ? error.issues[0] : error);
const sql = <Row extends object>(invocation: Invocation, text: string, values: unknown[] = []) =>
  database.withTenant(invocation.context, (s) => s.query<Row>(text, values));

/** A record of an object, written as the records commands will: registry, row, name. */
async function record(invocation: Invocation, object: ObjectDefinition, name: string) {
  const objectId = parsePublicId('object_type', object.id);
  const fieldId = parsePublicId('field', object.primaryField?.id ?? '');
  return database.withTenant(invocation.context, async (s) => {
    const made = await s.one<{ id: string }>(
      `insert into crm.records (business_id, kind, object_type_id)
       values (app.business_id(), 'custom', $1) returning id`,
      [objectId],
    );
    await s.query(
      `insert into crm.custom_records (business_id, id, title, created_by_kind)
       values (app.business_id(), $1, $2, 'system')`,
      [made.id, name],
    );
    await s.query(
      `insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
       values (app.business_id(), $1, $2, 'text', $3, 'system')`,
      [made.id, fieldId, name],
    );
    return made.id;
  });
}

describe('a custom object', () => {
  it('is made with its primary field in its own system folder, and listed after the standard ones', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    expect(made).toMatchObject({
      key: 'pet',
      kind: 'custom',
      standard: false,
      internalName: 'custom_objects.pet',
      singularLabel: 'Pet',
      pluralLabel: 'Pets',
      icon: 'paw-print',
      description: 'Animals we look after.',
      primaryField: { key: 'pet_name', label: 'Pet name', valueType: 'text', unique: true },
      searchableFieldIds: [],
      records: 0,
      source: 'system',
    });
    const { fields } = await detail(invocation, 'pet');
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      id: made.primaryField?.id,
      objectKey: 'pet',
      key: 'pet_name',
      mergeKey: 'custom_objects.pet.pet_name',
      primary: true,
      unique: true,
      searchable: false,
    });
    const [folder] = await sql<{ is_system: boolean }>(
      invocation,
      `select d.is_system from crm.field_definitions f
       join crm.field_folders d on d.business_id = f.business_id and d.id = f.folder_id
       where f.id = $1`,
      [parsePublicId('field', made.primaryField?.id ?? '')],
    );
    expect(folder).toEqual({ is_system: true });

    const list = objectList.parse(await call('listObjects', invocation));
    expect(list.items.map((item) => [item.key, item.standard, item.records])).toEqual([
      ['contact', true, null],
      ['company', true, null],
      ['deal', true, null],
      ['pet', false, 0],
    ]);
    expect(list).toMatchObject({ limit: MAX_CUSTOM_OBJECTS, canManage: true });
    expect(list.items[0]).toMatchObject({
      primaryField: null,
      icon: null,
      internalName: 'contact',
    });
    const [event] = await sql<{ type: string; payload: unknown }>(
      invocation,
      `select type, payload from events.events where subject_id = $1`,
      [parsePublicId('object_type', made.id)],
    );
    expect(event).toEqual({
      type: 'object.created',
      payload: { key: 'pet', singularLabel: 'Pet', primaryField: 'pet_name' },
    });
  });

  it('takes its key from its name unless given one, and never a key already taken', async () => {
    const invocation = await inBusiness();
    await create(invocation);
    const second = await create(invocation, {
      ...pet,
      primaryField: { label: 'Name', key: 'name', valueType: 'number' },
    });
    expect(second).toMatchObject({
      key: 'pet_2',
      primaryField: { key: 'name', valueType: 'number', unique: false },
    });
    expect(
      issueOf(await create(invocation, { ...pet, key: 'pet' }).catch((error: unknown) => error)),
    ).toMatchObject({ path: '/key', message: 'This key already belongs to an object.' });
  });

  it(`is refused past ${String(MAX_CUSTOM_OBJECTS)} in a business, and a deleted one frees its place`, async () => {
    const invocation = await inBusiness();
    for (let n = 1; n <= MAX_CUSTOM_OBJECTS; n += 1)
      await create(invocation, { ...pet, singularLabel: `Pet ${String(n)}` });
    const refused = await create(invocation, { ...pet, singularLabel: 'One more' }).catch(
      (error: unknown) => error,
    );
    expect(issueOf(refused)).toMatchObject({
      code: 'object_limit',
      message: `A business can have up to ${String(MAX_CUSTOM_OBJECTS)} custom objects.`,
    });
    await call('deleteObject', invocation, { key: 'pet_1' }, { confirm: 'Pets' });
    expect((await create(invocation, { ...pet, singularLabel: 'One more' })).key).toBe('one_more');
  });

  it(`counts two objects made at once one after the other, so the ${String(MAX_CUSTOM_OBJECTS + 1)}th is refused`, async () => {
    const invocation = await inBusiness();
    for (let n = 1; n < MAX_CUSTOM_OBJECTS; n += 1)
      await create(invocation, { ...pet, singularLabel: `Pet ${String(n)}` });
    const outcomes = await Promise.allSettled([
      create(invocation, { ...pet, singularLabel: 'Boat' }),
      create(invocation, { ...pet, singularLabel: 'Horse' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const [refused] = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
    expect(issueOf(refused)).toMatchObject({ code: 'object_limit' });
    expect(
      await sql<{ count: string }>(
        invocation,
        "select count(*) from crm.object_types where kind = 'custom'",
      ),
    ).toEqual([{ count: String(MAX_CUSTOM_OBJECTS) }]);
  });

  it('changes its names, icon and searchable fields, never on a stale revision', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    const breed = fieldDefinition.parse(
      await call(
        'createField',
        invocation,
        {},
        {
          objectKey: 'pet',
          key: 'breed',
          label: 'Breed',
          description: 'What kind of animal.',
          valueType: 'text',
          currency: null,
          options: [],
          aiFillSources: [],
          aiOverwrite: 'ask',
          archived: false,
        },
      ),
    );
    const change = {
      revision: made.revision,
      singularLabel: 'Animal',
      pluralLabel: 'Animals',
      description: '',
      icon: 'heart',
      searchableFieldIds: [breed.id],
    };
    const changed = objectDefinition.parse(
      await call('updateObject', invocation, { key: 'pet' }, change),
    );
    expect(changed).toMatchObject({
      key: 'pet',
      singularLabel: 'Animal',
      icon: 'heart',
      searchableFieldIds: [breed.id],
    });
    expect(changed.revision).not.toBe(made.revision);
    expect((await detail(invocation, 'pet')).fields.find((f) => f.id === breed.id)).toMatchObject({
      searchable: true,
    });
    await expect(call('updateObject', invocation, { key: 'pet' }, change)).rejects.toThrow(
      ConflictError,
    );
    // Taken off again.
    const cleared = objectDefinition.parse(
      await call(
        'updateObject',
        invocation,
        { key: 'pet' },
        { ...change, revision: changed.revision, searchableFieldIds: [] },
      ),
    );
    expect(cleared.searchableFieldIds).toEqual([]);
  });

  it.each([
    ['its primary field', 'primary'],
    ['a field of another object', 'other'],
    ['a field that is not text', 'number'],
    ['a field that is not there', 'missing'],
  ])('refuses %s as searchable', async (_, which) => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    const field = (objectKey: string, valueType: string) =>
      call(
        'createField',
        invocation,
        {},
        {
          objectKey,
          key: `f_${randomUUID().slice(0, 8)}`,
          label: `Field ${randomUUID().slice(0, 8)}`,
          description: 'A field.',
          valueType,
          currency: null,
          options: [],
          aiFillSources: [],
          aiOverwrite: 'ask',
          archived: false,
        },
      ).then((saved) => fieldDefinition.parse(saved).id);
    const id = {
      primary: () => Promise.resolve(made.primaryField?.id ?? ''),
      other: () => field('contact', 'text'),
      number: () => field('pet', 'number'),
      missing: () => Promise.resolve(toPublicId('field', '01890a5d-ac96-774b-bcce-b302099a8057')),
    }[which];
    const refused = await call(
      'updateObject',
      invocation,
      { key: 'pet' },
      {
        revision: made.revision,
        singularLabel: 'Pet',
        pluralLabel: 'Pets',
        description: '',
        icon: null,
        searchableFieldIds: [await id?.()],
      },
    ).catch((error: unknown) => error);
    expect(issueOf(refused)).toMatchObject({ path: '/searchableFieldIds' });
  });

  it('is the only kind of object changed or deleted here: a standard one is kept as it is', async () => {
    const invocation = await inBusiness();
    const contact = (await detail(invocation, 'contact')) as ObjectDefinition;
    const changed = await call(
      'updateObject',
      invocation,
      { key: 'contact' },
      {
        revision: contact.revision,
        singularLabel: 'Person',
        pluralLabel: 'People',
        description: '',
        icon: null,
        searchableFieldIds: [],
      },
    ).catch((error: unknown) => error);
    expect(issueOf(changed)).toMatchObject({ code: 'standard_object' });
    const deleted = await call(
      'deleteObject',
      invocation,
      { key: 'contact' },
      { confirm: 'Contacts' },
    ).catch((error: unknown) => error);
    expect(issueOf(deleted)).toMatchObject({ code: 'standard_object' });
  });

  it('is not found in another business, nor once deleted', async () => {
    const invocation = await inBusiness();
    await create(invocation);
    const other = await inBusiness();
    await expect(detail(other, 'pet')).rejects.toThrow(NotFoundError);
    await expect(
      call('updateObject', other, { key: 'pet' }, { revision: 'a'.repeat(64) }),
    ).rejects.toThrow(NotFoundError);
    await expect(call('deleteObject', other, { key: 'pet' }, { confirm: 'Pets' })).rejects.toThrow(
      NotFoundError,
    );
    await call('deleteObject', invocation, { key: 'pet' }, { confirm: 'Pets' });
    await expect(detail(invocation, 'pet')).rejects.toThrow(NotFoundError);
    await expect(
      call('deleteObject', invocation, { key: 'pet' }, { confirm: 'Pets' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('keeps its primary field: it can’t be archived or deleted, and a unique field only stops being so', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    const fieldId = made.primaryField?.id ?? '';
    const [primary] = (await detail(invocation, 'pet')).fields;
    const save = (changes: object) =>
      call(
        'updateField',
        invocation,
        { fieldId },
        {
          label: 'Pet name',
          description: primary?.description,
          options: [],
          aiFillSources: [],
          aiOverwrite: 'ask',
          archived: false,
          revision: primary?.revision,
          ...changes,
        },
      );
    expect(issueOf(await save({ archived: true }).catch((error: unknown) => error))).toMatchObject({
      path: '/archived',
      message: 'The primary field names each record, so it can’t be archived.',
    });
    const deletion = fieldDeletion.parse(await call('getFieldDeletion', invocation, { fieldId }));
    expect(deletion.canDelete).toBe(false);
    expect(
      issueOf(
        await call(
          'deleteField',
          invocation,
          { fieldId },
          { confirmation: deletion.confirmation },
        ).catch((error: unknown) => error),
      ),
    ).toMatchObject({ code: 'primary_field' });
    const ordinary = fieldDefinition.parse(await save({ unique: false }));
    expect(ordinary).toMatchObject({ unique: false, primary: true });
  });

  it('has unique fields of its own, which are never deleted; a standard object has none', async () => {
    const invocation = await inBusiness();
    await create(invocation);
    const field = (objectKey: string) =>
      call(
        'createField',
        invocation,
        {},
        {
          objectKey,
          key: 'microchip',
          label: 'Microchip',
          description: 'The number on its chip.',
          valueType: 'text',
          currency: null,
          options: [],
          aiFillSources: [],
          aiOverwrite: 'ask',
          archived: false,
          unique: true,
        },
      );
    const microchip = fieldDefinition.parse(await field('pet'));
    expect(microchip).toMatchObject({ unique: true, primary: false, searchable: false });
    expect(issueOf(await field('contact').catch((error: unknown) => error))).toMatchObject({
      path: '/unique',
      message: "Only a custom object's fields can be unique.",
    });
    const deletion = fieldDeletion.parse(
      await call('getFieldDeletion', invocation, { fieldId: microchip.id }),
    );
    expect(deletion.canDelete).toBe(false);
    expect(
      issueOf(
        await call(
          'deleteField',
          invocation,
          { fieldId: microchip.id },
          { confirmation: deletion.confirmation },
        ).catch((error: unknown) => error),
      ),
    ).toMatchObject({ code: 'unique_field' });
  });

  it('is deleted only with its plural name typed, and never while a workflow uses it', async () => {
    const invocation = await inBusiness();
    await create(invocation);
    expect(
      issueOf(
        await call('deleteObject', invocation, { key: 'pet' }, { confirm: 'pets' }).catch(
          (error: unknown) => error,
        ),
      ),
    ).toMatchObject({ path: '/confirm', message: 'Type Pets to delete it.' });
    inUse = [{ id: 'aut_1', name: 'Vaccination reminder' }];
    try {
      const refused = await call('deleteObject', invocation, { key: 'pet' }, { confirm: 'Pets' })
        .then(() => undefined)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConflictError);
      expect((refused as Error).message).toBe(
        'Published workflows use this object: Vaccination reminder. Change them first.',
      );
    } finally {
      inUse = [];
    }
    expect(asked).toContain('pet');
  });

  it('is hidden at once when deleted, and its purge then removes its records, fields and associations', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    const objectId = parsePublicId('object_type', made.id) ?? '';
    const records = [
      await record(invocation, made, 'Rex'),
      await record(invocation, made, 'Tom'),
      await record(invocation, made, 'Kit'),
    ];
    const contact = await database.fixtures.contact(invocation.context);
    await sql(
      invocation,
      `with type as (
         insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
                                     label, reverse_label, created_by_kind)
         select app.business_id(), 'pet_owner', $1, id, 'Owner', 'Pet', 'user'
         from crm.object_types where kind = 'contact' returning id)
       insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id, source_kind)
       select app.business_id(), type.id, $2, $3, 'user' from type`,
      [objectId, records[0], contact.id],
    );
    expect((await detail(invocation, 'pet')).records).toBe(3);

    await call('deleteObject', invocation, { key: 'pet' }, { confirm: ' Pets ' });
    const listed = objectList.parse(await call('listObjects', invocation));
    expect(listed.items.map((item) => item.key)).not.toContain('pet');
    const [job] = await database.as('crm_owner', (s) =>
      s.query<{ payload: { data: { objectTypeId: string } } }>(
        `select j.payload from graphile_worker._private_jobs j
         join graphile_worker._private_tasks t on t.id = j.task_id
         where t.identifier = 'objects.purge' and j.payload->'data'->>'objectTypeId' = $1`,
        [objectId],
      ),
    );
    expect(job).toBeDefined();

    // Two records a run's first batch, the rest the next: the worker repeats until none.
    await purgeObjectTask.run({ objectTypeId: objectId, batch: 2 }, { invocation, services });
    const left = await sql<{ records: number; types: number; fields: number; links: number }>(
      invocation,
      `select (select count(*)::int from crm.records where object_type_id = $1) as records,
              (select count(*)::int from crm.object_types where id = $1) as types,
              (select count(*)::int from crm.field_definitions where object_type_id = $1) as fields,
              (select count(*)::int from crm.link_types where key = 'pet_owner') as links`,
      [objectId],
    );
    expect(left).toEqual([{ records: 0, types: 0, fields: 0, links: 0 }]);
    // The contact it was linked to stays.
    expect(
      await sql(invocation, 'select 1 from crm.contacts where id = $1', [contact.id]),
    ).toHaveLength(1);
    const events = await sql<{ type: string }>(
      invocation,
      `select type from events.events where subject_id = $1 order by occurred_at, id`,
      [objectId],
    );
    expect(events.map((event) => event.type)).toEqual([
      'object.created',
      'object.deleted',
      'object.purged',
    ]);
    // A job that runs again finds nothing to do.
    await purgeObjectTask.run({ objectTypeId: objectId, batch: 500 }, { invocation, services });
  });

  it('leaves an object nobody deleted to itself, whatever a stray job says', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    const objectId = parsePublicId('object_type', made.id) ?? '';
    await purgeObjectTask.run({ objectTypeId: objectId, batch: 500 }, { invocation, services });
    expect((await detail(invocation, 'pet')).id).toBe(made.id);
    // Nor a standard object.
    const contact = await detail(invocation, 'contact');
    await purgeObjectTask.run(
      { objectTypeId: parsePublicId('object_type', contact.id) ?? '', batch: 500 },
      { invocation, services },
    );
    expect((await detail(invocation, 'contact')).id).toBe(contact.id);
  });

  it('is managed by those whose role allows objects.manage, and read by everyone', async () => {
    const invocation = await inBusiness();
    const member: Invocation = { ...invocation, permissions: new Set(['contacts.manage']) };
    await expect(create(member)).rejects.toThrow(ForbiddenError);
    expect(objectList.parse(await call('listObjects', member)).canManage).toBe(false);
  });
});
