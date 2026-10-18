// Records of custom objects against a migrated Postgres, through the real routes: made with
// their primary field, named by it, listed, searched, trashed, restored and purged, with
// notes, tags, tasks and an audit trail like any record.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  DUPLICATE_RECORD_VALUE,
  customRecord,
  customRecordList,
  objectDefinition,
  recordField,
  searchResults,
  taskList,
  trashList,
  type CustomRecord,
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

import { detailOptions, team } from '../../test/contact-details.js';
import {
  activityRoutes,
  createObjectRoutes,
  crmRoutes,
  purgeObjectTask,
  taskRoutes,
} from '../index.js';
import { createCustomRecordRoutes } from './routes.js';

let database: TestDatabase;
let services: Services;
const people = detailOptions();
const routes: readonly ApiRoute[] = [
  ...createObjectRoutes({ uses: () => Promise.resolve([]) }),
  // The routes as the server builds them, with who is on the team; crmRoutes has none.
  ...createCustomRecordRoutes(people),
  ...taskRoutes({
    ...people,
    assignees: {
      ...people.assignees,
      read: () => Promise.resolve({ items: [], nextCursor: null }),
    },
  }),
  ...activityRoutes({ actorNames: people.actorNames }),
  ...crmRoutes,
];
const withoutPeople = createCustomRecordRoutes(undefined);

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

async function call(
  operationId: string,
  invocation: Invocation,
  params: unknown = {},
  body?: unknown,
  query: unknown = {},
  from: readonly ApiRoute[] = routes,
): Promise<unknown> {
  const route = from.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, services);
}
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not refused.');
};
const issueOf = async (promise: Promise<unknown>) => {
  const error = await refusal(promise);
  return error instanceof ValidationError ? error.issues[0] : error;
};

/** A field of Pet, as Settings → Custom Fields makes one. */
async function field(
  invocation: Invocation,
  body: { key: string; label: string; valueType: string; options?: object[] },
): Promise<string> {
  const made = (await call(
    'createField',
    invocation,
    {},
    {
      objectKey: 'pet',
      description: `The pet's ${body.label.toLowerCase()}.`,
      currency: null,
      options: [],
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
      ...body,
    },
  )) as { id: string };
  return made.id;
}

interface Scene {
  readonly invocation: Invocation;
  readonly pet: ObjectDefinition;
  /** Pet's text field "Breed", searchable, and its number field "Weight". */
  readonly breed: string;
  readonly weight: string;
  add(fields: Record<string, unknown>, invocation?: Invocation): Promise<CustomRecord>;
  list(query?: Record<string, unknown>): Promise<ReturnType<typeof customRecordList.parse>>;
  events(id: string): Promise<{ type: string; payload: unknown }[]>;
}

async function scene(invocation?: Invocation): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const acting: Invocation = invocation ?? {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  const pet = objectDefinition.parse(
    await call(
      'createObject',
      acting,
      {},
      {
        singularLabel: 'Pet',
        pluralLabel: 'Pets',
        primaryField: { label: 'Pet name', valueType: 'text', unique: true },
      },
    ),
  );
  const breed = await field(acting, { key: 'breed', label: 'Breed', valueType: 'text' });
  const weight = await field(acting, { key: 'weight', label: 'Weight', valueType: 'number' });
  await call(
    'updateObject',
    acting,
    { key: 'pet' },
    {
      revision: pet.revision,
      singularLabel: 'Pet',
      pluralLabel: 'Pets',
      description: '',
      icon: null,
      searchableFieldIds: [breed],
    },
  );
  return {
    invocation: acting,
    pet,
    breed,
    weight,
    add: async (fields, as = acting) =>
      customRecord.parse(await call('createCustomRecord', as, { key: 'pet' }, { fields })),
    list: async (query = {}) =>
      customRecordList.parse(
        await call('listCustomRecords', acting, { key: 'pet' }, undefined, query),
      ),
    events: (id) =>
      database.withTenant(acting.context, (sql) =>
        sql.query<{ type: string; payload: unknown }>(
          `select e.type, e.payload from events.events e
           join crm.timeline_entries t on t.event_id = e.id
           where t.record_id = $1 order by e.recorded_at, e.id`,
          [parsePublicId('custom', id)],
        ),
      ),
  };
}

describe('a record of a custom object', () => {
  it('is made with its primary field, named by it, and kept as a record of its object', async () => {
    const s = await scene();
    const buddy = await s.add({ pet_name: 'Buddy' });
    expect(buddy).toMatchObject({
      objectKey: 'pet',
      name: 'Buddy',
      owner: null,
      trashedAt: null,
      canManage: true,
    });
    expect(buddy.id).toMatch(/^rec_/);
    const [row] = await database.withTenant(s.invocation.context, (sql) =>
      sql.query<{ kind: string; object_type_id: string; title: string }>(
        `select r.kind, c.object_type_id, c.title from crm.records r
         join crm.custom_records c on c.id = r.id where r.id = $1`,
        [parsePublicId('custom', buddy.id)],
      ),
    );
    expect(row).toEqual({
      kind: 'custom',
      object_type_id: parsePublicId('object_type', s.pet.id),
      title: 'Buddy',
    });
    expect((await s.events(buddy.id)).map((event) => event.type)).toEqual([
      'record.created',
      'field.value_set',
    ]);
    expect(await call('getCustomRecord', s.invocation, { key: 'pet', id: buddy.id })).toEqual(
      buddy,
    );
  });

  it('takes other values by field key, a choice by its label, when the role may set values', async () => {
    const s = await scene();
    const choice = (key: string, label: string) => ({
      key,
      label,
      description: '',
      archived: false,
    });
    const status = await field(s.invocation, {
      key: 'status',
      label: 'Status',
      valueType: 'single_choice',
      options: [choice('adopted', 'Adopted'), choice('waiting', 'Waiting')],
    });
    const notes = await field(s.invocation, {
      key: 'notes',
      label: 'Notes',
      valueType: 'text_list',
      options: [choice('diet', 'Diet')],
    });
    const made = await s.add({
      pet_name: 'Rex',
      breed: 'Collie',
      weight: '12.50',
      status: 'Waiting',
      notes: { diet: 'No chicken' },
    });
    const value = async (fieldId: string) =>
      recordField.parse(
        await call('getRecordFields', s.invocation, { id: made.id }).then((fields) =>
          (fields as { items: { definition: { id: string } }[] }).items.find(
            (item) => item.definition.id === fieldId,
          ),
        ),
      ).value;
    expect(await value(s.breed)).toBe('Collie');
    expect(await value(s.weight)).toBe('12.50');
    expect(await value(status)).toBe('waiting');
    expect(await value(notes)).toEqual({ diet: 'No chicken' });
    // Only the primary field needs nothing more than records.manage.
    const member: Invocation = { ...s.invocation, permissions: new Set(['records.manage']) };
    await expect(s.add({ pet_name: 'Spot' }, member)).resolves.toMatchObject({ name: 'Spot' });
    expect(await refusal(s.add({ pet_name: 'Dot', breed: 'Pug' }, member))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it.each([
    ['without its primary field', { breed: 'Pug' }, '/fields/pet_name', 'required'],
    ['with a blank primary field', { pet_name: '   ' }, '/fields/pet_name', 'required'],
    [
      'with a name over 200 characters',
      { pet_name: 'x'.repeat(201) },
      '/fields/pet_name',
      'too_long',
    ],
    [
      'with a field of no such key',
      { pet_name: 'Rex', colour: 'red' },
      '/fields/colour',
      'unknown_field',
    ],
    [
      'with a value its field refuses',
      { pet_name: 'Rex', weight: 'heavy' },
      '/fields/weight',
      undefined,
    ],
  ])('is refused %s, by the field it names', async (_, fields, path, code) => {
    const s = await scene();
    const issue = await issueOf(s.add(fields));
    expect(issue).toMatchObject({ path, ...(code === undefined ? {} : { code }) });
    expect((await s.list()).total).toBe(0);
  });

  it('keeps a number primary field as its name, without trailing zeros', async () => {
    const s = await scene();
    await call(
      'createObject',
      s.invocation,
      {},
      {
        singularLabel: 'Locker',
        pluralLabel: 'Lockers',
        primaryField: { label: 'Number', valueType: 'number' },
      },
    );
    const locker = customRecord.parse(
      await call(
        'createCustomRecord',
        s.invocation,
        { key: 'locker' },
        { fields: { number: '7.50' } },
      ),
    );
    expect(locker.name).toBe('7.5');
    expect(
      await issueOf(
        call(
          'createCustomRecord',
          s.invocation,
          { key: 'locker' },
          { fields: { number: '1'.repeat(201) } },
        ),
      ),
    ).toMatchObject({ path: '/fields/number' });
  });

  it('refuses a unique value another record has, in the trash too, and frees it once purged', async () => {
    const s = await scene();
    const first = await s.add({ pet_name: 'Buddy' });
    const clash = {
      path: '/fields/pet_name',
      code: 'duplicate_value',
      message: DUPLICATE_RECORD_VALUE,
    };
    expect(await issueOf(s.add({ pet_name: ' buddy ' }))).toMatchObject(clash);
    await call('trashCustomRecord', s.invocation, { key: 'pet', id: first.id });
    // A record in the trash keeps its value, so restoring it can never clash.
    expect(await issueOf(s.add({ pet_name: 'Buddy' }))).toMatchObject(clash);
    await call('purgeRecord', s.invocation, { id: first.id });
    await expect(s.add({ pet_name: 'Buddy' })).resolves.toMatchObject({ name: 'Buddy' });
  });

  it("follows its primary field's value, which can't be cleared, made too long or taken", async () => {
    const s = await scene();
    const buddy = await s.add({ pet_name: 'Buddy' });
    await s.add({ pet_name: 'Rex' });
    const primary = s.pet.primaryField?.id ?? '';
    const set = async (value: string | null) => {
      const current = recordField.parse(
        (
          (await call('getRecordFields', s.invocation, { id: buddy.id })) as {
            items: { definition: { id: string } }[];
          }
        ).items.find((item) => item.definition.id === primary),
      );
      return call(
        'setRecordField',
        s.invocation,
        { id: buddy.id, fieldId: primary },
        { value, revision: current.revision },
      );
    };
    await set('Buddy II');
    expect((await s.list({ sort: 'name' })).items.map((item) => item.name)).toEqual([
      'Buddy II',
      'Rex',
    ]);
    expect(await issueOf(set(null))).toMatchObject({ path: '/value', code: 'required' });
    expect(await issueOf(set('y'.repeat(201)))).toMatchObject({ path: '/value', code: 'too_long' });
    expect(await issueOf(set('REX'))).toMatchObject({
      path: '/value',
      message: DUPLICATE_RECORD_VALUE,
    });
  });

  it('is found under its own object only, in its own business', async () => {
    const s = await scene();
    const buddy = await s.add({ pet_name: 'Buddy' });
    await call(
      'createObject',
      s.invocation,
      {},
      {
        singularLabel: 'Car',
        pluralLabel: 'Cars',
        primaryField: { label: 'Plate', valueType: 'text' },
      },
    );
    for (const [key, invocation] of [
      ['car', s.invocation],
      ['contact', s.invocation],
      ['pet', (await scene()).invocation],
    ] as const)
      expect(
        await refusal(call('getCustomRecord', invocation, { key, id: buddy.id })),
      ).toBeInstanceOf(NotFoundError);
    expect(
      await refusal(call('createCustomRecord', s.invocation, { key: 'contact' }, { fields: {} })),
    ).toBeInstanceOf(NotFoundError);
  });

  it('changes owner to someone on the team, under the revision it was read with', async () => {
    const crew = await team(database);
    const dana = await crew.member('Dana Brooks');
    const s = await scene(dana.as());
    const buddy = await s.add({ pet_name: 'Buddy' });
    const owned = customRecord.parse(
      await call(
        'updateCustomRecord',
        s.invocation,
        { key: 'pet', id: buddy.id },
        { owner: 'me', revision: buddy.ownerRevision },
      ),
    );
    expect(owned.owner).toEqual({
      membershipId: dana.membershipId,
      name: 'Dana Brooks',
      you: true,
    });
    expect((await s.events(buddy.id)).map((event) => event.type)).toContain('record.updated');
    expect(
      await refusal(
        call(
          'updateCustomRecord',
          s.invocation,
          { key: 'pet', id: buddy.id },
          { owner: null, revision: buddy.ownerRevision },
        ),
      ),
    ).toBeInstanceOf(ConflictError);
    const unowned = customRecord.parse(
      await call(
        'updateCustomRecord',
        s.invocation,
        { key: 'pet', id: buddy.id },
        { owner: null, revision: owned.ownerRevision },
      ),
    );
    expect(unowned.owner).toBeNull();
    // Unchanged, it writes nothing.
    await call(
      'updateCustomRecord',
      s.invocation,
      { key: 'pet', id: buddy.id },
      { owner: null, revision: unowned.ownerRevision },
    );
    const stranger = toPublicId('membership', '01890a5d-ac96-774b-bcce-b30209900001');
    expect(
      await issueOf(
        call(
          'updateCustomRecord',
          s.invocation,
          { key: 'pet', id: buddy.id },
          { owner: stranger, revision: unowned.ownerRevision },
        ),
      ),
    ).toMatchObject({ path: '/owner', code: 'unavailable_member' });
    // A record made with an owner, and one whose routes can't tell who is on the team.
    const rex = customRecord.parse(
      await call(
        'createCustomRecord',
        s.invocation,
        { key: 'pet' },
        { fields: { pet_name: 'Rex' }, owner: 'me' },
      ),
    );
    expect(rex.owner?.name).toBe('Dana Brooks');
    expect(
      customRecord.parse(
        await call(
          'getCustomRecord',
          s.invocation,
          { key: 'pet', id: rex.id },
          undefined,
          {},
          withoutPeople,
        ),
      ).owner,
    ).toEqual({ membershipId: null, name: null, you: true });
    expect(
      await issueOf(
        call(
          'createCustomRecord',
          s.invocation,
          { key: 'pet' },
          { fields: { pet_name: 'Max' }, owner: 'me' },
          {},
          withoutPeople,
        ),
      ),
    ).toMatchObject({ path: '/owner' });
  });

  it('goes to the trash and back, with its notes, tags and tasks, and is named in them', async () => {
    const s = await scene();
    const buddy = await s.add({ pet_name: 'Buddy' });
    await call(
      'createNote',
      s.invocation,
      { id: buddy.id },
      {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vet on Friday' }] }],
        },
      },
    );
    const tag = (await call('createTag', s.invocation, {}, { name: 'Friendly' })) as { id: string };
    await call('assignRecordTag', s.invocation, { id: buddy.id, tagId: tag.id }, {});
    await call('createTask', s.invocation, {}, { recordId: buddy.id, title: 'Book the vet' });
    const tasks = () =>
      call('listTasks', s.invocation, {}, undefined, {}).then((page) => taskList.parse(page));
    expect((await tasks()).items.map((task) => task.record)).toEqual([
      { id: buddy.id, name: 'Buddy', trashed: false },
    ]);
    expect(await call('getRecordTags', s.invocation, { id: buddy.id })).toMatchObject({
      items: [{ tag: { name: 'Friendly' } }],
    });

    const trashed = customRecord.parse(
      await call('trashCustomRecord', s.invocation, { key: 'pet', id: buddy.id }),
    );
    expect(trashed.trashedAt).not.toBeNull();
    expect((await s.list()).items).toEqual([]);
    // A task of a record in the trash leaves the list, as a contact's does.
    expect((await tasks()).items).toEqual([]);
    expect(
      trashList.parse(await call('listTrash', s.invocation, {}, undefined, { kind: 'custom' }))
        .items,
    ).toMatchObject([
      { id: buddy.id, kind: 'custom', name: 'Buddy', object: { key: 'pet', label: 'Pet' } },
    ]);
    expect(
      await refusal(
        call(
          'updateCustomRecord',
          s.invocation,
          { key: 'pet', id: buddy.id },
          { owner: null, revision: buddy.ownerRevision },
        ),
      ),
    ).toBeInstanceOf(ConflictError);
    // Trashing it again changes nothing.
    await call('trashCustomRecord', s.invocation, { key: 'pet', id: buddy.id });

    const restored = customRecord.parse(
      await call('restoreCustomRecord', s.invocation, { key: 'pet', id: buddy.id }),
    );
    expect(restored.trashedAt).toBeNull();
    expect((await s.list()).items.map((item) => item.id)).toEqual([buddy.id]);
    expect((await s.events(buddy.id)).map((event) => event.type)).toEqual(
      expect.arrayContaining(['record.trashed', 'record.restored']),
    );
    const audit = (await call('listAudit', s.invocation, {}, undefined, { subject: buddy.id })) as {
      items: { command: string; record: unknown }[];
    };
    expect(audit.items.find((entry) => entry.command === 'record.create')?.record).toEqual({
      kind: 'custom',
      id: buddy.id,
      name: 'Buddy',
      exists: true,
    });
  });

  it('is found by the command bar by its name and by a searchable field', async () => {
    const s = await scene();
    const buddy = await s.add({ pet_name: 'Buddy', breed: 'Border collie' });
    await s.add({ pet_name: 'Rex', breed: '100% terrier' });
    const search = async (q: string) =>
      searchResults
        .parse(await call('searchRecords', s.invocation, {}, undefined, { q }))
        .items.filter((item) => item.kind === 'custom');
    expect(await search('bud')).toEqual([
      {
        id: buddy.id,
        kind: 'custom',
        name: 'Buddy',
        object: { key: 'pet', label: 'Pet' },
        detail: null,
      },
    ]);
    expect((await search('collie')).map((item) => item.name)).toEqual(['Buddy']);
    // % and _ are themselves, not wildcards.
    expect((await search('0% t')).map((item) => item.name)).toEqual(['Rex']);
    expect(await search('1_0')).toEqual([]);
  });
});

describe("a custom object's list", () => {
  it('pages in the order asked for, newest change first unless told, with how many match', async () => {
    const s = await scene();
    const names = ['Cleo', 'Ari', 'Bo'];
    const made: CustomRecord[] = [];
    for (const name of names) made.push(await s.add({ pet_name: name }));
    const all = await s.list();
    expect(all.items.map((item) => item.name)).toEqual(['Bo', 'Ari', 'Cleo']);
    expect(all).toMatchObject({ total: 3, next: null, canManage: true });
    const walk = async (query: Record<string, unknown>) => {
      const seen: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await s.list({
          ...query,
          limit: 1,
          ...(after === undefined ? {} : { after }),
        });
        seen.push(...page.items.map((item) => item.name));
        if (page.next === null) return seen;
        after = page.next;
      }
    };
    expect(await walk({ sort: 'name' })).toEqual(['Ari', 'Bo', 'Cleo']);
    expect(await walk({ sort: 'name', direction: 'desc' })).toEqual(['Cleo', 'Bo', 'Ari']);
    expect(await walk({ sort: 'created', direction: 'asc' })).toEqual(['Cleo', 'Ari', 'Bo']);
    expect(await walk({})).toEqual(['Bo', 'Ari', 'Cleo']);
    expect(
      await issueOf(
        s.list({ after: toPublicId('custom', '01890a5d-ac96-774b-bcce-b30209900001') }),
      ),
    ).toMatchObject({ path: '/after', code: 'unknown_record' });
  });

  it('is searched by name and searchable fields, and filtered and sorted by a field of its own', async () => {
    const s = await scene();
    await s.add({ pet_name: 'Buddy', breed: 'Collie', weight: '20' });
    await s.add({ pet_name: 'Rex', breed: 'Pug', weight: '8' });
    await s.add({ pet_name: 'Max_1', weight: '30' });
    const names = async (query: Record<string, unknown>) =>
      (await s.list(query)).items.map((item) => item.name);
    expect(await names({ q: 'BUD' })).toEqual(['Buddy']);
    expect(await names({ q: 'pug' })).toEqual(['Rex']);
    expect(await names({ q: 'x_' })).toEqual(['Max_1']);
    expect(await names({ q: 'a_1' })).toEqual([]);
    expect(
      await names({
        fieldId: s.weight,
        fieldOperator: 'gt',
        fieldValue: '10',
        sortField: s.weight,
      }),
    ).toEqual(['Buddy', 'Max_1']);
    // A field sort pages too.
    const first = await s.list({ sortField: s.weight, fieldOrder: 'desc', limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(['Max_1', 'Buddy']);
    expect(
      (
        await s.list({ sortField: s.weight, fieldOrder: 'desc', after: first.next ?? '' })
      ).items.map((item) => item.name),
    ).toEqual(['Rex']);
    // Another object's field is no field of this list.
    await call(
      'createObject',
      s.invocation,
      {},
      {
        singularLabel: 'Car',
        pluralLabel: 'Cars',
        primaryField: { label: 'Plate', valueType: 'text' },
      },
    );
    const plate = (
      (await call('getObject', s.invocation, { key: 'car' })) as { primaryField: { id: string } }
    ).primaryField.id;
    expect(await issueOf(s.list({ sortField: plate }))).toMatchObject({
      path: '/sortField',
      code: 'unknown_field',
    });
  });

  it('goes with its object: a deleted object has no records to read, and its purge removes them', async () => {
    const s = await scene();
    const buddy = await s.add({ pet_name: 'Buddy' });
    await call('deleteObject', s.invocation, { key: 'pet' }, { confirm: 'Pets' });
    expect(await refusal(s.list())).toBeInstanceOf(NotFoundError);
    expect(await refusal(call('getRecordFields', s.invocation, { id: buddy.id }))).toBeInstanceOf(
      NotFoundError,
    );
    await purgeObjectTask.run(
      { objectTypeId: parsePublicId('object_type', s.pet.id) ?? '', batch: 500 },
      { invocation: s.invocation, services },
    );
    const left = await database.withTenant(s.invocation.context, (sql) =>
      sql.query('select 1 from crm.records where id = $1', [parsePublicId('custom', buddy.id)]),
    );
    expect(left).toEqual([]);
  });

  it('is read by everyone, and changed only by those whose role allows records.manage', async () => {
    const s = await scene();
    const buddy = await s.add({ pet_name: 'Buddy' });
    const viewer: Invocation = { ...s.invocation, permissions: new Set() };
    const page = customRecordList.parse(await call('listCustomRecords', viewer, { key: 'pet' }));
    expect(page).toMatchObject({ canManage: false, items: [{ canManage: false }] });
    const one = { key: 'pet', id: buddy.id };
    for (const [operationId, params, body] of [
      ['createCustomRecord', { key: 'pet' }, { fields: { pet_name: 'Rex' } }],
      ['updateCustomRecord', one, { owner: null, revision: buddy.ownerRevision }],
      ['trashCustomRecord', one, undefined],
      ['restoreCustomRecord', one, undefined],
    ] as const)
      expect(await refusal(call(operationId, viewer, params, body))).toBeInstanceOf(ForbiddenError);
  });
});
