// Through the CRM's own routes and commands, against a migrated Postgres:
// fields the system owns, the order of fields inside a folder, deleting a field for good,
// and the folder list searched, filtered and paged.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  customFieldList,
  fieldDefinition,
  fieldDeletion,
  fieldFolder,
  fieldFolderList,
  folderFieldOrder,
  recordFields,
  type FieldDefinition,
  type FieldDeletion,
  type FieldFolder,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { crmRoutes } from '../index.js';
import { createFieldDeletionRoutes, type FieldUses } from './deletion.js';

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
afterAll(async () => {
  await db.destroy();
  await database.close();
});

// What uses a field is the automation module's to read; here it is whatever a test says,
// and every question asked of it is kept.
const TEMPLATE = toPublicId('template', '0199c7e2-0000-7000-8000-00000000000a');
const AUTOMATION = toPublicId('automation', '0199c7e2-0000-7000-8000-00000000000b');
let uses: FieldUses = { templates: [], automations: [] };
const asked: (readonly string[])[] = [];
const deletionRoutes = createFieldDeletionRoutes({
  uses: (_trx, paths) => {
    asked.push(paths);
    return Promise.resolve(uses);
  },
});
const routes: readonly ApiRoute[] = [...crmRoutes, ...deletionRoutes];

async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  uses = { templates: [], automations: [] };
  asked.length = 0;
  return {
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
}
function call(
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, services);
}
const failure = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );
const listFolders = async (invocation: Invocation, query: Record<string, string> = {}) =>
  fieldFolderList.parse(await call('listFieldFolders', invocation, undefined, {}, query));
const systemFolder = async (
  invocation: Invocation,
  objectKey = 'contact',
): Promise<FieldFolder> => {
  const folder = (await listFolders(invocation, { objectKey })).items.find((each) => each.system);
  if (folder === undefined) throw new Error(`No system folder for ${objectKey}.`);
  return folder;
};
const newFolder = async (
  invocation: Invocation,
  name: string,
  objectKey = 'contact',
): Promise<FieldFolder> =>
  fieldFolder.parse(await call('createFieldFolder', invocation, { objectKey, name }));
const newField = async (
  invocation: Invocation,
  key: string,
  change: Record<string, unknown> = {},
): Promise<FieldDefinition> =>
  fieldDefinition.parse(
    await call('createField', invocation, {
      objectKey: 'contact',
      key,
      label: key,
      description: `What ${key} means.`,
      valueType: 'text',
      options: [],
      currency: null,
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
      ...change,
    }),
  );
const editing = (field: FieldDefinition, change: Record<string, unknown> = {}) => ({
  label: field.label,
  description: field.description,
  options: field.options,
  aiFillSources: field.aiFillSources,
  aiOverwrite: field.aiOverwrite,
  archived: field.archived,
  revision: field.revision,
  ...change,
});
const fieldsOf = async (invocation: Invocation): Promise<FieldDefinition[]> =>
  ((await call('getFields', invocation)) as { items: unknown[] }).items.map((each) =>
    fieldDefinition.parse(each),
  );
const fieldOf = async (invocation: Invocation, id: string): Promise<FieldDefinition> => {
  const field = (await fieldsOf(invocation)).find((each) => each.id === id);
  if (field === undefined) throw new Error(`No field ${id}.`);
  return field;
};
/** The keys of a folder's fields that are not archived, in the order the list gives them. */
const orderOf = async (invocation: Invocation, folderId: string): Promise<string[]> =>
  customFieldList
    .parse(
      await call('listCustomFields', invocation, undefined, {}, { folderId, sort: 'position' }),
    )
    .items.map((field) => field.key);
/** A field the product owns, as a seeder would make it: the API makes none. */
async function systemField(invocation: Invocation, key: string): Promise<FieldDefinition> {
  const row = await database.withTenant(invocation.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, created_by_kind, is_system, position)
       select app.business_id(), o.id, $1, $1, 'Built in.', 'text', 'system', true,
              coalesce((select max(f.position) + 1 from crm.field_definitions f
                        where f.object_type_id = o.id), 0)
       from crm.object_types o where o.kind = 'contact' returning id`,
      [key],
    ),
  );
  return fieldOf(invocation, toPublicId('field', row.id));
}
/** A value of the field on a new contact, written as a person's save stores one. */
async function valueOf(invocation: Invocation, field: FieldDefinition): Promise<string> {
  const contact = await database.fixtures.contact(invocation.context);
  await database.withTenant(invocation.context, (sql) =>
    sql.query(
      `insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
       values (app.business_id(), $1, $2, 'text', 'Cedar', 'user')`,
      [contact.id, parsePublicId('field', field.id)],
    ),
  );
  return contact.id;
}
const valuesOf = async (fieldId: string): Promise<number> => {
  const [row] = await database.as('crm_owner', (sql) =>
    sql.query<{ values: number }>(
      'select count(*)::int as values from crm.field_values where field_id = $1',
      [parsePublicId('field', fieldId)],
    ),
  );
  return row?.values ?? 0;
};
const deletionOf = async (invocation: Invocation, fieldId: string): Promise<FieldDeletion> =>
  fieldDeletion.parse(await call('getFieldDeletion', invocation, undefined, { fieldId }));
const remove = (invocation: Invocation, fieldId: string, confirmation: string) =>
  call('deleteField', invocation, { confirmation }, { fieldId });
const eventsOf = (invocation: Invocation) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ type: string; subject_kind: string; payload: Record<string, unknown> }>(
      `select type, subject_kind, payload from events.events
       where correlation_id = $1 order by id`,
      [invocation.context.correlationId],
    ),
  );
const auditsOf = (invocation: Invocation) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ command: string; outcome: string; error_code: string | null }>(
      `select command, outcome, error_code from audit.commands
       where correlation_id = $1 order by id`,
      [invocation.context.correlationId],
    ),
  );
const again = (invocation: Invocation): Invocation => ({
  ...invocation,
  context: { ...invocation.context, correlationId: randomUUID() },
});

/** Runs statements in a transaction that stays open until the function it gives back is called. */
async function hold(statement: string, values: readonly unknown[]): Promise<() => Promise<void>> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let taken = (): void => undefined;
  const locked = new Promise<void>((resolve) => {
    taken = resolve;
  });
  const holder = database.as('crm_owner', async (sql) => {
    await sql.query(statement, values);
    taken();
    await released;
  });
  await locked;
  return async () => {
    release();
    await holder;
  };
}
// Another role's wait events are hidden from crm_app, so the superuser watches. The limit
// is a deadline for PostgreSQL to report the wait, not a time anything is expected to take.
const lockWaits = (count: number): Promise<void> =>
  expect
    .poll(
      () =>
        database.as('postgres', async (sql) => {
          const [row] = await sql.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'`,
          );
          return row?.waiting ?? 0;
        }),
      { timeout: 60_000, interval: 50 },
    )
    .toBe(count);

describe('a system field', () => {
  it('says it is one, and no field the API makes is', async () => {
    const invocation = await inBusiness();
    const plain = await newField(invocation, 'fence_type');
    const builtIn = await systemField(invocation, 'built_in');
    expect(plain.system).toBe(false);
    expect(builtIn).toMatchObject({ system: true, source: 'system', key: 'built_in' });
    const listed = customFieldList.parse(await call('listCustomFields', invocation));
    expect(listed.items.map(({ key, system }) => [key, system])).toEqual([
      ['built_in', true],
      ['fence_type', false],
    ]);
    // Nothing a client sends makes one: the input has no such member.
    const forged = await failure(newField(invocation, 'forged', { system: true }));
    expect(forged).toBeInstanceOf(ValidationError);
  });

  it('can’t be edited or archived, by a fresh revision or a stale one', async () => {
    const invocation = await inBusiness();
    const builtIn = await systemField(invocation, 'built_in');
    for (const body of [
      editing(builtIn, { label: 'Renamed' }),
      editing(builtIn, { archived: true }),
      editing(builtIn, { placeholder: 'Type here' }),
      // Not even a save that changes nothing, or one from a revision it never had.
      editing(builtIn),
      editing(builtIn, { label: 'Renamed', revision: 'a'.repeat(64) }),
    ]) {
      const refusal = await failure(call('updateField', invocation, body, { fieldId: builtIn.id }));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal).toMatchObject({ issues: [{ code: 'system_field' }] });
    }
    expect(await fieldOf(invocation, builtIn.id)).toEqual(builtIn);
    expect((await eventsOf(invocation)).map((event) => event.type)).toEqual([]);
  });

  it('is moved to another folder and reordered like any field, and keeps its values', async () => {
    const invocation = await inBusiness();
    const builtIn = await systemField(invocation, 'built_in');
    const plain = await newField(invocation, 'fence_type');
    const folder = await newFolder(invocation, 'Quote');
    await valueOf(invocation, builtIn);

    await call(
      'moveFieldsToFolder',
      invocation,
      { fieldIds: [plain.id, builtIn.id] },
      {
        folderId: folder.id,
      },
    );
    expect(await orderOf(invocation, folder.id)).toEqual(['fence_type', 'built_in']);
    await call(
      'reorderFolderFields',
      invocation,
      { fieldIds: [builtIn.id, plain.id] },
      {
        folderId: folder.id,
      },
    );
    expect(await orderOf(invocation, folder.id)).toEqual(['built_in', 'fence_type']);
    const moved = await fieldOf(invocation, builtIn.id);
    expect(moved).toEqual({
      ...builtIn,
      folderId: folder.id,
      position: 0,
      revision: moved.revision,
    });
    expect(await valuesOf(builtIn.id)).toBe(1);

    // Deleting its folder moves it on, as it moves any field.
    await call('deleteFieldFolder', invocation, undefined, { folderId: folder.id });
    const system = await systemFolder(invocation);
    expect(await orderOf(invocation, system.id)).toEqual(['built_in', 'fence_type']);
    expect((await fieldOf(invocation, builtIn.id)).system).toBe(true);
  });

  it('can’t be deleted for good, whatever confirmation is sent', async () => {
    const invocation = await inBusiness();
    const builtIn = await systemField(invocation, 'built_in');
    await valueOf(invocation, builtIn);
    const deletion = await deletionOf(invocation, builtIn.id);
    expect(deletion).toMatchObject({ canDelete: false, values: 1 });
    for (const confirmation of [deletion.confirmation, 'b'.repeat(64)]) {
      const refusal = await failure(remove(invocation, builtIn.id, confirmation));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal).toMatchObject({ issues: [{ code: 'system_field' }] });
    }
    expect(await fieldOf(invocation, builtIn.id)).toEqual(builtIn);
    expect(await valuesOf(builtIn.id)).toBe(1);
  });
});

describe('a radio field and a checkbox field', () => {
  const options = ['Wood', 'Vinyl', 'Chain link'].map((label) => ({
    key: `opt_${label.toLowerCase().replace(' ', '_')}`,
    label,
    description: '',
    archived: false,
  }));

  it('are a single choice and a multiple choice shown another way, chosen when the field is made', async () => {
    const invocation = await inBusiness();
    const radio = await newField(invocation, 'fence', {
      valueType: 'single_choice',
      options,
      display: 'radio',
    });
    const boxes = await newField(invocation, 'extras', {
      valueType: 'multi_choice',
      options,
      display: 'checkbox',
    });
    const dropdown = await newField(invocation, 'gate', { valueType: 'single_choice', options });
    const spelled = await newField(invocation, 'posts', {
      valueType: 'multi_choice',
      options,
      display: 'dropdown',
    });
    const text = await newField(invocation, 'notes');
    expect(
      [radio, boxes, dropdown, spelled, text].map(({ valueType, display }) => [valueType, display]),
    ).toEqual([
      ['single_choice', 'radio'],
      ['multi_choice', 'checkbox'],
      ['single_choice', 'dropdown'],
      ['multi_choice', 'dropdown'],
      ['text', null],
    ]);
    // The same answer wherever the field is read.
    expect(await fieldOf(invocation, radio.id)).toEqual(radio);
    for (const [key, change] of [
      ['wrong_one', { valueType: 'single_choice', options, display: 'checkbox' }],
      ['wrong_many', { valueType: 'multi_choice', options, display: 'radio' }],
      ['not_a_choice', { display: 'radio' }],
      ['not_a_choice', { display: 'dropdown' }],
      ['unknown', { valueType: 'single_choice', options, display: 'slider' }],
    ] as const) {
      const refusal = await failure(newField(invocation, key, change));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal).toMatchObject({ issues: [{ path: '/display' }] });
    }
    // Like the type, it is not something a save can change.
    const changed = await failure(
      call('updateField', invocation, editing(radio, { display: 'dropdown' }), {
        fieldId: radio.id,
      }),
    );
    expect(changed).toBeInstanceOf(ValidationError);
    const renamed = fieldDefinition.parse(
      await call('updateField', invocation, editing(radio, { label: 'Fence type' }), {
        fieldId: radio.id,
      }),
    );
    expect(renamed).toMatchObject({ label: 'Fence type', display: 'radio' });
  });

  it('are found by how they are shown, and by their type with every other choice field', async () => {
    const invocation = await inBusiness();
    await newField(invocation, 'fence', { valueType: 'single_choice', options, display: 'radio' });
    await newField(invocation, 'extras', {
      valueType: 'multi_choice',
      options,
      display: 'checkbox',
    });
    await newField(invocation, 'gate', { valueType: 'single_choice', options });
    await newField(invocation, 'posts', { valueType: 'multi_choice', options });
    await newField(invocation, 'notes');
    const keys = async (query: Record<string, string>): Promise<string[]> =>
      customFieldList
        .parse(
          await call(
            'listCustomFields',
            invocation,
            undefined,
            {},
            { sort: 'created_asc', ...query },
          ),
        )
        .items.map((field) => field.key);
    expect(await keys({ display: 'radio' })).toEqual(['fence']);
    expect(await keys({ display: 'checkbox' })).toEqual(['extras']);
    expect(await keys({ display: 'dropdown' })).toEqual(['gate', 'posts']);
    expect(await keys({ valueType: 'single_choice' })).toEqual(['fence', 'gate']);
    expect(await keys({ valueType: 'multi_choice', display: 'dropdown' })).toEqual(['posts']);
    expect(await keys({ valueType: 'single_choice', display: 'checkbox' })).toEqual([]);
    expect(await failure(keys({ display: 'slider' }))).toBeInstanceOf(ValidationError);
  });

  it('take and refuse values exactly as their type does', async () => {
    const invocation = await inBusiness();
    const radio = await newField(invocation, 'fence', {
      valueType: 'single_choice',
      options,
      display: 'radio',
    });
    const boxes = await newField(invocation, 'extras', {
      valueType: 'multi_choice',
      options,
      display: 'checkbox',
    });
    const contact = await database.fixtures.contact(invocation.context);
    const id = toPublicId('contact', contact.id);
    const read = async () =>
      recordFields.parse(await call('getRecordFields', invocation, undefined, { id })).items;
    const set = async (field: FieldDefinition, value: unknown) => {
      const current = (await read()).find((item) => item.definition.id === field.id);
      return call(
        'setRecordField',
        invocation,
        { value, revision: current?.revision ?? '' },
        { id, fieldId: field.id },
      );
    };
    await set(radio, 'opt_vinyl');
    await set(boxes, ['opt_wood', 'opt_chain_link']);
    // One choice for radio buttons, and only the field's own choices for either.
    for (const [field, value] of [
      [radio, ['opt_wood', 'opt_vinyl']],
      [radio, 'opt_brick'],
      [boxes, ['opt_wood', 'opt_brick']],
      [boxes, 'opt_wood'],
    ] as const)
      expect(await failure(set(field, value))).toBeInstanceOf(ValidationError);
    const saved = new Map((await read()).map((item) => [item.definition.key, item.value]));
    expect(saved.get('fence')).toBe('opt_vinyl');
    expect(saved.get('extras')).toEqual(['opt_wood', 'opt_chain_link']);
  });
});

describe('the order of a folder’s fields', () => {
  it('puts a new field, and a field that arrives, last', async () => {
    const invocation = await inBusiness();
    const system = await systemFolder(invocation);
    const folder = await newFolder(invocation, 'Quote');
    const a = await newField(invocation, 'a');
    const b = await newField(invocation, 'b');
    const c = await newField(invocation, 'c', { folderId: folder.id });
    const gone = await newField(invocation, 'gone', { folderId: folder.id, archived: true });
    expect([a.position, b.position, c.position, gone.position]).toEqual([0, 1, 0, 1]);
    expect(await orderOf(invocation, system.id)).toEqual(['a', 'b']);

    // By a move of several, in the order they were named, after the archived one too.
    await call(
      'moveFieldsToFolder',
      invocation,
      { fieldIds: [b.id, a.id] },
      { folderId: folder.id },
    );
    expect(await orderOf(invocation, folder.id)).toEqual(['c', 'b', 'a']);
    expect((await fieldOf(invocation, b.id)).position).toBe(2);
    // By a save of its form that names another folder.
    const saved = fieldDefinition.parse(
      await call(
        'updateField',
        invocation,
        editing(await fieldOf(invocation, c.id), { folderId: system.id }),
        { fieldId: c.id },
      ),
    );
    expect(saved).toMatchObject({ folderId: system.id, position: 0 });
    const d = await newField(invocation, 'd');
    expect(await orderOf(invocation, system.id)).toEqual(['c', 'd']);
    // A save that names the folder it is already in leaves it where it is.
    const kept = fieldDefinition.parse(
      await call('updateField', invocation, editing(saved, { folderId: system.id }), {
        fieldId: c.id,
      }),
    );
    expect(kept.position).toBe(0);
    expect(d.position).toBe(1);
  });

  it('is whatever list of all of them is sent, and is no edit of any field', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Quote');
    const fields = [];
    for (const key of ['a', 'b', 'c'])
      fields.push(await newField(invocation, key, { folderId: folder.id }));
    const [a, b, c] = fields;
    const archived = await newField(invocation, 'old', { folderId: folder.id, archived: true });
    const elsewhere = await newField(invocation, 'elsewhere');
    const fieldIds = [c?.id ?? '', a?.id ?? '', b?.id ?? ''];

    const order = folderFieldOrder.parse(
      await call('reorderFolderFields', invocation, { fieldIds }, { folderId: folder.id }),
    );
    expect(order).toEqual({ folder: { ...folder, fieldCount: 3 }, fieldIds });
    expect(await orderOf(invocation, folder.id)).toEqual(['c', 'a', 'b']);
    // Their forms, open through the reorder, still save: the revision is of what a save changes.
    for (const field of fields)
      expect((await fieldOf(invocation, field.id)).revision).toBe(field.revision);
    expect((await fieldOf(invocation, archived.id)).position).toBe(archived.position);
    expect((await fieldOf(invocation, elsewhere.id)).position).toBe(elsewhere.position);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'field.reordered',
      subject_kind: 'field_folder',
      payload: { objectKey: 'contact', folderName: 'Quote', fieldIds },
    });
    expect((await auditsOf(invocation)).at(-1)).toEqual({
      command: 'field.reorder',
      outcome: 'ok',
      error_code: null,
    });
  });

  it('is refused when the list is not exactly the folder’s live fields, and then nothing moves', async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const folder = await newFolder(invocation, 'Quote');
    const a = await newField(invocation, 'a', { folderId: folder.id });
    const b = await newField(invocation, 'b', { folderId: folder.id });
    const archived = await newField(invocation, 'old', { folderId: folder.id, archived: true });
    const elsewhere = await newField(invocation, 'elsewhere');
    const theirs = await newField(other, 'theirs');
    for (const fieldIds of [
      [b.id],
      [b.id, a.id, elsewhere.id],
      [b.id, a.id, archived.id],
      [b.id, a.id, theirs.id],
      [b.id, theirs.id],
    ]) {
      const refusal = await failure(
        call('reorderFolderFields', invocation, { fieldIds }, { folderId: folder.id }),
      );
      expect(refusal).toBeInstanceOf(ConflictError);
    }
    const repeated = await failure(
      call('reorderFolderFields', invocation, { fieldIds: [b.id, b.id] }, { folderId: folder.id }),
    );
    expect(repeated).toBeInstanceOf(ValidationError);
    expect(await orderOf(invocation, folder.id)).toEqual(['a', 'b']);
    // Another business's folder is not there at all.
    const reached = await failure(
      call('reorderFolderFields', other, { fieldIds: [a.id, b.id] }, { folderId: folder.id }),
    );
    expect(reached).toBeInstanceOf(NotFoundError);
    expect(await orderOf(invocation, folder.id)).toEqual(['a', 'b']);
  });

  it('needs fields.manage', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Quote');
    const a = await newField(invocation, 'a', { folderId: folder.id });
    const b = await newField(invocation, 'b', { folderId: folder.id });
    const reader: Invocation = { ...invocation, permissions: new Set(['trash.purge']) };
    const refusal = await failure(
      call('reorderFolderFields', reader, { fieldIds: [b.id, a.id] }, { folderId: folder.id }),
    );
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect(refusal).toMatchObject({ permission: 'fields.manage' });
    expect(await orderOf(invocation, folder.id)).toEqual(['a', 'b']);
  });

  it('is never written over a field that arrived meanwhile: the order and the move take turns', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Quote');
    const a = await newField(invocation, 'a', { folderId: folder.id });
    const b = await newField(invocation, 'b', { folderId: folder.id });
    const arriving = await newField(invocation, 'arriving');
    // Both wait behind a transaction that holds the folder, so both are under way before
    // either can read which fields the folder has.
    const release = await hold('select 1 from crm.field_folders where id = $1 for update', [
      parsePublicId('field_folder', folder.id),
    ]);
    const work = Promise.allSettled([
      call(
        'reorderFolderFields',
        again(invocation),
        { fieldIds: [b.id, a.id] },
        { folderId: folder.id },
      ),
      call(
        'moveFieldsToFolder',
        again(invocation),
        { fieldIds: [arriving.id] },
        { folderId: folder.id },
      ),
    ]);
    try {
      await lockWaits(2);
    } finally {
      await release();
    }
    const [ordered, moved] = await work;
    expect(moved.status).toBe('fulfilled');
    // Whichever went first, the field that arrived is last and the order is one a person
    // asked for of the fields that were there: applied whole, or refused whole.
    expect(await orderOf(invocation, folder.id)).toEqual(
      ordered.status === 'fulfilled' ? ['b', 'a', 'arriving'] : ['a', 'b', 'arriving'],
    );
    if (ordered.status === 'rejected') expect(ordered.reason).toBeInstanceOf(ConflictError);
  });

  it('is the order the whole list and a record’s fields come in, object by object and folder by folder', async () => {
    const invocation = await inBusiness();
    const system = await systemFolder(invocation);
    const quote = await newFolder(invocation, 'Quote');
    const a = await newField(invocation, 'a');
    const b = await newField(invocation, 'b');
    const c = await newField(invocation, 'c', { folderId: quote.id });
    const d = await newField(invocation, 'd', { folderId: quote.id });
    await newField(invocation, 'deal_total', { objectKey: 'deal' });
    await call(
      'reorderFolderFields',
      invocation,
      { fieldIds: [b.id, a.id] },
      { folderId: system.id },
    );
    await call(
      'reorderFolderFields',
      invocation,
      { fieldIds: [d.id, c.id] },
      { folderId: quote.id },
    );
    // The account's folder first, then the system folder.
    await call('reorderFieldFolders', invocation, {
      objectKey: 'contact',
      folderIds: [quote.id, system.id],
    });

    const keys: string[] = [];
    let after: string | undefined;
    do {
      const page = customFieldList.parse(
        await call(
          'listCustomFields',
          invocation,
          undefined,
          {},
          {
            sort: 'position',
            limit: '2',
            ...(after === undefined ? {} : { after }),
          },
        ),
      );
      expect(page.total).toBe(5);
      keys.push(...page.items.map((field) => field.key));
      after = page.next ?? undefined;
    } while (after !== undefined);
    expect(keys).toEqual(['d', 'c', 'b', 'a', 'deal_total']);
    expect((await fieldsOf(invocation)).map((field) => field.key)).toEqual(keys);

    const contact = await database.fixtures.contact(invocation.context);
    const onRecord = recordFields.parse(
      await call('getRecordFields', invocation, undefined, {
        id: toPublicId('contact', contact.id),
      }),
    );
    expect(onRecord.items.map((item) => item.definition.key)).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('deleting a field for good', () => {
  it('names what would be lost: its values, its merge key, and what uses it', async () => {
    const invocation = await inBusiness();
    const field = await newField(invocation, 'fence_type', { label: 'Fence type' });
    await valueOf(invocation, field);
    await valueOf(invocation, field);
    uses = {
      templates: [{ id: TEMPLATE, name: 'Quote' }],
      automations: [{ id: AUTOMATION, name: 'Follow up' }],
    };
    const deletion = await deletionOf(invocation, field.id);
    expect(deletion).toEqual({
      field: {
        id: field.id,
        objectKey: 'contact',
        key: 'fence_type',
        label: 'Fence type',
        mergeKey: 'contact.fence_type',
      },
      values: 2,
      templates: uses.templates,
      automations: uses.automations,
      canDelete: true,
      confirmation: deletion.confirmation,
    });
    expect(asked).toEqual([['contact.custom.fence_type', 'contact.fence_type']]);
    // Reading it changes nothing and is open to whoever can read fields, who is told no.
    const reader: Invocation = { ...invocation, permissions: new Set() };
    expect(await deletionOf(reader, field.id)).toEqual({ ...deletion, canDelete: false });
    expect(
      (await deletionOf({ ...invocation, permissions: new Set(['fields.manage']) }, field.id))
        .canDelete,
    ).toBe(false);
    expect(await valuesOf(field.id)).toBe(2);
  });

  it('asks about every way the field can be written, by the kind of object it is on', async () => {
    const invocation = await inBusiness();
    // A contact field named like a built-in one is reached only by its longer path.
    const email = await newField(invocation, 'email', { label: 'Second email' });
    const deal = await newField(invocation, 'quote_total', { objectKey: 'deal' });
    const company = await newField(invocation, 'city', { objectKey: 'company' });
    // A key a merged field left to this one is another way of writing it.
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        `insert into crm.field_key_aliases (business_id, object_type_id, alias_key, field_id)
         select business_id, object_type_id, 'old_total', id from crm.field_definitions where id = $1`,
        [parsePublicId('field', deal.id)],
      ),
    );
    for (const field of [email, deal, company]) await deletionOf(invocation, field.id);
    expect(asked).toEqual([
      ['contact.custom.email'],
      [
        'deal.custom.quote_total',
        'opportunity.quote_total',
        'deal.custom.old_total',
        'opportunity.old_total',
      ],
      ['company.custom.city', 'business.city'],
    ]);
    expect((await deletionOf(invocation, email.id)).field.mergeKey).toBe('contact.custom.email');
  });

  it('deletes the field and every value of it, and says so in the audit log and an event', async () => {
    const invocation = await inBusiness();
    const field = await newField(invocation, 'fence_type', { label: 'Fence type' });
    const kept = await newField(invocation, 'gate_width');
    const contactId = await valueOf(invocation, field);
    await valueOf(invocation, kept);
    const deletion = await deletionOf(invocation, field.id);

    expect(await remove(invocation, field.id, deletion.confirmation)).toBe(undefined);

    expect((await fieldsOf(invocation)).map((each) => each.key)).toEqual(['gate_width']);
    expect(
      customFieldList
        .parse(await call('listCustomFields', invocation, undefined, {}, { archived: 'include' }))
        .items.map((each) => each.key),
    ).toEqual(['gate_width']);
    expect(await valuesOf(field.id)).toBe(0);
    expect(await valuesOf(kept.id)).toBe(1);
    const onRecord = recordFields.parse(
      await call('getRecordFields', invocation, undefined, {
        id: toPublicId('contact', contactId),
      }),
    );
    expect(onRecord.items.map((item) => item.definition.key)).toEqual(['gate_width']);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'field.deleted',
      subject_kind: 'field',
      payload: {
        key: 'fence_type',
        objectKey: 'contact',
        label: 'Fence type',
        values: 1,
        templates: 0,
        automations: 0,
      },
    });
    expect((await auditsOf(invocation)).at(-1)).toEqual({
      command: 'field.delete',
      outcome: 'ok',
      error_code: null,
    });
    // It is gone: reading its deletion, or deleting it again, finds nothing.
    expect(await failure(deletionOf(invocation, field.id))).toBeInstanceOf(NotFoundError);
    expect(await failure(remove(invocation, field.id, deletion.confirmation))).toBeInstanceOf(
      NotFoundError,
    );
    // Its key is free again.
    expect((await newField(invocation, 'fence_type')).id).not.toBe(field.id);
  });

  it('deletes nothing on a confirmation that no longer describes the field', async () => {
    const invocation = await inBusiness();
    const field = await newField(invocation, 'fence_type');
    await valueOf(invocation, field);
    const read = await deletionOf(invocation, field.id);
    const refusedNow = async (confirmation: string): Promise<void> => {
      const refusal = await failure(remove(again(invocation), field.id, confirmation));
      expect(refusal).toBeInstanceOf(ConflictError);
      expect((await fieldsOf(invocation)).map((each) => each.id)).toEqual([field.id]);
    };

    // Never given.
    await refusedNow('c'.repeat(64));
    // A value was written since.
    await valueOf(invocation, field);
    await refusedNow(read.confirmation);
    const withTwo = await deletionOf(invocation, field.id);
    expect(withTwo.values).toBe(2);
    // The field was edited since.
    await call('updateField', invocation, editing(field, { label: 'Fence' }), {
      fieldId: field.id,
    });
    await refusedNow(withTwo.confirmation);
    const renamed = await deletionOf(invocation, field.id);
    // A template started using it since.
    uses = { templates: [{ id: TEMPLATE, name: 'Quote' }], automations: [] };
    await refusedNow(renamed.confirmation);
    const used = await deletionOf(invocation, field.id);
    // The same template under another name loses nothing more: the confirmation stands.
    uses = { templates: [{ id: TEMPLATE, name: 'Renamed' }], automations: [] };
    expect((await deletionOf(invocation, field.id)).confirmation).toBe(used.confirmation);
    expect(await valuesOf(field.id)).toBe(2);
    expect((await auditsOf(invocation)).at(-1)?.command).toBe('field.update');

    await remove(invocation, field.id, used.confirmation);
    expect(await fieldsOf(invocation)).toEqual([]);
    expect(await valuesOf(field.id)).toBe(0);
  });

  it('needs fields.manage and trash.purge, each named when it is the one missing', async () => {
    const invocation = await inBusiness();
    const field = await newField(invocation, 'fence_type');
    const { confirmation } = await deletionOf(invocation, field.id);
    for (const [permissions, missing] of [
      [new Set(['trash.purge'] as const), 'fields.manage'],
      [new Set(['fields.manage'] as const), 'trash.purge'],
      [new Set<never>(), 'fields.manage'],
    ] as const) {
      const refusal = await failure(remove({ ...invocation, permissions }, field.id, confirmation));
      expect(refusal).toBeInstanceOf(ForbiddenError);
      expect(refusal).toMatchObject({ permission: missing });
    }
    expect((await fieldsOf(invocation)).map((each) => each.id)).toEqual([field.id]);
    await remove(
      { ...invocation, permissions: new Set(['fields.manage', 'trash.purge'] as const) },
      field.id,
      confirmation,
    );
    expect(await fieldsOf(invocation)).toEqual([]);
  });

  it('keeps a field other fields were merged into', async () => {
    const invocation = await inBusiness();
    const survivor = await newField(invocation, 'fence_type');
    const merged = await newField(invocation, 'old_fence', { archived: true });
    await database.withTenant(invocation.context, (sql) =>
      sql.query('update crm.field_definitions set merged_into_field_id = $2 where id = $1', [
        parsePublicId('field', merged.id),
        parsePublicId('field', survivor.id),
      ]),
    );
    const deletion = await deletionOf(invocation, survivor.id);
    expect(deletion.canDelete).toBe(false);
    const refusal = await failure(remove(invocation, survivor.id, deletion.confirmation));
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal).toMatchObject({ issues: [{ code: 'merged_fields' }] });
    expect((await fieldsOf(invocation)).map((each) => each.id)).toContain(survivor.id);
  });

  it('never reaches another business’s field, through the routes or the command alone', async () => {
    const owner = await inBusiness();
    const field = await newField(owner, 'fence_type');
    await valueOf(owner, field);
    const { confirmation } = await deletionOf(owner, field.id);
    const other = await inBusiness();
    expect(await failure(deletionOf(other, field.id))).toBeInstanceOf(NotFoundError);
    // Whatever body comes with it: the lookup is before the body is read.
    expect(await failure(remove(other, field.id, confirmation))).toBeInstanceOf(NotFoundError);
    expect(
      await failure(call('deleteField', other, { nonsense: true }, { fieldId: field.id })),
    ).toBeInstanceOf(NotFoundError);
    expect(await valuesOf(field.id)).toBe(1);
    expect((await deletionOf(owner, field.id)).confirmation).toBe(confirmation);
  });

  it('deletes once when asked twice at the same moment', async () => {
    const invocation = await inBusiness();
    const field = await newField(invocation, 'fence_type');
    await valueOf(invocation, field);
    const { confirmation } = await deletionOf(invocation, field.id);
    const release = await hold('select 1 from crm.field_definitions where id = $1 for update', [
      parsePublicId('field', field.id),
    ]);
    const work = Promise.allSettled([
      remove(again(invocation), field.id, confirmation),
      remove(again(invocation), field.id, confirmation),
    ]);
    try {
      await lockWaits(2);
    } finally {
      await release();
    }
    const outcomes = await work;
    const lost = outcomes.flatMap((each): unknown[] =>
      each.status === 'rejected' ? [each.reason] : [],
    );
    expect(outcomes.filter((each) => each.status === 'fulfilled')).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(NotFoundError);
    expect(await fieldsOf(invocation)).toEqual([]);
    const deleted = await database.as('crm_owner', (sql) =>
      sql.query<{ events: number }>(
        `select count(*)::int as events from events.events
         where type = 'field.deleted' and subject_id = $1`,
        [parsePublicId('field', field.id)],
      ),
    );
    expect(deleted).toEqual([{ events: 1 }]);
  });

  it('waits for a value being written, and then refuses: that value was never confirmed', async () => {
    const invocation = await inBusiness();
    const field = await newField(invocation, 'fence_type');
    const { confirmation } = await deletionOf(invocation, field.id);
    const contact = await database.fixtures.contact(invocation.context);
    // A save of a value that has not committed yet: it holds the field against deletion.
    const release = await hold(
      `insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
       values ($1, $2, $3, 'text', 'Cedar', 'user')`,
      [invocation.context.businessId, contact.id, parsePublicId('field', field.id)],
    );
    const deleting = failure(remove(again(invocation), field.id, confirmation));
    try {
      await lockWaits(1);
    } finally {
      await release();
    }
    expect(await deleting).toBeInstanceOf(ConflictError);
    expect(await valuesOf(field.id)).toBe(1);
    expect((await deletionOf(invocation, field.id)).values).toBe(1);
  });
});

describe('the folder list', () => {
  it('answers every folder with how many there are when no limit is asked for', async () => {
    const invocation = await inBusiness();
    const quote = await newFolder(invocation, 'Quote');
    const listed = await listFolders(invocation);
    expect(listed.items.map((folder) => [folder.objectKey, folder.name])).toEqual([
      ['company', 'Additional Info'],
      ['contact', 'Additional Info'],
      ['contact', 'Quote'],
      ['deal', 'Additional Info'],
    ]);
    expect(listed).toMatchObject({ total: 4, next: null, canManage: true });
    expect(await listFolders(invocation, { objectKey: 'contact' })).toEqual({
      items: [await systemFolder(invocation), quote],
      total: 2,
      next: null,
      canManage: true,
    });
  });

  it('is searched by any part of a name, with % and _ as themselves, and filtered by when a folder was made', async () => {
    const invocation = await inBusiness();
    for (const name of ['Fence quote', 'Quote 100%', 'Gate_width', 'Gate width', 'Other']) {
      await newFolder(invocation, name);
    }
    const names = async (query: Record<string, string>): Promise<string[]> =>
      (await listFolders(invocation, { objectKey: 'contact', ...query })).items.map(
        (folder) => folder.name,
      );
    expect(await names({ q: 'quote' })).toEqual(['Fence quote', 'Quote 100%']);
    expect(await names({ q: ' QUOTE ' })).toEqual(['Fence quote', 'Quote 100%']);
    expect(await names({ q: '100%' })).toEqual(['Quote 100%']);
    expect(await names({ q: '%' })).toEqual(['Quote 100%']);
    expect(await names({ q: 'gate_' })).toEqual(['Gate_width']);
    expect(await names({ q: 'nothing like it' })).toEqual([]);
    // A search across objects finds each object's own.
    expect((await listFolders(invocation, { q: 'additional' })).total).toBe(3);

    // Known moments, so the comparison is exact to the microsecond.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.field_folders set created_at = case name
           when 'Fence quote' then '2026-03-01T00:00:00.000001Z'::timestamptz
           when 'Quote 100%' then '2026-03-02T00:00:00Z'
           else '2026-01-01T00:00:00Z' end
         where business_id = $1`,
        [invocation.context.businessId],
      ),
    );
    expect(await names({ createdFrom: '2026-03-01T00:00:00.000001Z' })).toEqual([
      'Fence quote',
      'Quote 100%',
    ]);
    expect(await names({ createdFrom: '2026-03-01T00:00:00.000002Z' })).toEqual(['Quote 100%']);
    expect(
      await names({ createdBefore: '2026-03-02T00:00:00Z', createdFrom: '2026-02-01T00:00:00Z' }),
    ).toEqual(['Fence quote']);
    expect(await names({ q: 'quote', createdBefore: '2026-03-01T00:00:00.000001Z' })).toEqual([]);
  });

  it('is paged in its own order, each folder once, whatever is made meanwhile', async () => {
    const invocation = await inBusiness();
    for (const name of ['B', 'A', 'C']) await newFolder(invocation, name);
    await newFolder(invocation, 'Deal one', 'deal');
    const walk = async (during?: () => Promise<unknown>): Promise<string[]> => {
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await listFolders(invocation, {
          limit: '2',
          ...(after === undefined ? {} : { after }),
        });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((folder) => `${folder.objectKey}/${folder.name}`));
        after = page.next ?? undefined;
        if (seen.length === 2) await during?.();
      } while (after !== undefined);
      return seen;
    };
    const all = [
      'company/Additional Info',
      'contact/Additional Info',
      'contact/B',
      'contact/A',
      'contact/C',
      'deal/Additional Info',
      'deal/Deal one',
    ];
    expect(await walk()).toEqual(all);
    expect((await listFolders(invocation, { limit: '2' })).total).toBe(7);
    // A folder made after the first page, in an object already passed and in one to come:
    // nothing is shown twice, and the one still ahead is reached.
    expect(
      await walk(async () => {
        await newFolder(invocation, 'Company late', 'company');
        await newFolder(invocation, 'Contact late');
      }),
    ).toEqual([...all.slice(0, 5), 'contact/Contact late', ...all.slice(5)]);
    // A page of everything that is left says there is no more.
    expect((await listFolders(invocation, { objectKey: 'deal', limit: '2' })).next).toBeNull();
    expect((await listFolders(invocation, { objectKey: 'deal', limit: '1' })).next).not.toBeNull();
  });

  it('refuses to start after a folder this business does not have', async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const theirs = await newFolder(other, 'Theirs');
    for (const after of [
      theirs.id,
      toPublicId('field_folder', '0199c7e2-0000-7000-8000-00000000000c'),
    ]) {
      const refusal = await failure(listFolders(invocation, { limit: '2', after }));
      expect(refusal).toBeInstanceOf(ValidationError);
    }
    expect(await failure(listFolders(invocation, { limit: '0' }))).toBeInstanceOf(ValidationError);
    expect(await failure(listFolders(invocation, { limit: '101' }))).toBeInstanceOf(
      ValidationError,
    );
  });
});
