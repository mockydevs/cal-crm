// Through the CRM's own routes and commands, against a migrated Postgres:
// field folders, which folder a field is in, and the merge key every field answers with.
import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  FIELD_FOLDER_LIMITS,
  fieldDefinition,
  fieldFolder,
  fieldFolderList,
  type FieldDefinition,
  type FieldFolder,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { crmRoutes } from '../index.js';
import {
  deleteFieldFolderCommand,
  moveFieldsCommand,
  renameFieldFolderCommand,
} from './folders.js';

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

async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
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
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, services);
}
const foldersOf = async (invocation: Invocation, objectKey?: string): Promise<FieldFolder[]> =>
  fieldFolderList.parse(
    await call('listFieldFolders', invocation, undefined, {}, objectKey ? { objectKey } : {}),
  ).items;
const systemFolder = async (invocation: Invocation, objectKey: string): Promise<FieldFolder> => {
  const folder = (await foldersOf(invocation, objectKey)).find((each) => each.system);
  if (folder === undefined) throw new Error(`No system folder for ${objectKey}.`);
  return folder;
};
const newFolder = async (
  invocation: Invocation,
  name: string,
  objectKey = 'contact',
): Promise<FieldFolder> =>
  fieldFolder.parse(await call('createFieldFolder', invocation, { objectKey, name }));
const fieldInput = {
  objectKey: 'contact',
  key: 'guest_count',
  label: 'Guest count',
  description: 'The latest expected number of guests.',
  valueType: 'number',
  options: [],
  currency: null,
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
};
const newField = async (
  invocation: Invocation,
  change: Record<string, unknown> = {},
): Promise<FieldDefinition> =>
  fieldDefinition.parse(await call('createField', invocation, { ...fieldInput, ...change }));
const editing = (field: FieldDefinition) => ({
  label: field.label,
  description: field.description,
  options: field.options,
  aiFillSources: field.aiFillSources,
  aiOverwrite: field.aiOverwrite,
  archived: field.archived,
  revision: field.revision,
});
const fieldsOf = async (invocation: Invocation): Promise<FieldDefinition[]> =>
  ((await call('getFields', invocation)) as { items: unknown[] }).items.map((each) =>
    fieldDefinition.parse(each),
  );
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

/** Holds a row as another transaction would, until the function it gives back is called. */
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

describe('every object’s system folder', () => {
  it('exists from the start, holds a field made without a folder, and says it is a system folder', async () => {
    const invocation = await inBusiness();
    const folders = await foldersOf(invocation);
    expect(
      folders.map(({ objectKey, name, system, position, fieldCount }) => ({
        objectKey,
        name,
        system,
        position,
        fieldCount,
      })),
    ).toEqual(
      ['company', 'contact', 'deal'].map((objectKey) => ({
        objectKey,
        name: 'Additional Info',
        system: true,
        position: 0,
        fieldCount: 0,
      })),
    );
    const field = await newField(invocation);
    const system = await systemFolder(invocation, 'contact');
    expect(field.folderId).toBe(system.id);
    expect(system.fieldCount).toBe(1);
    expect((await systemFolder(invocation, 'deal')).fieldCount).toBe(0);
  });

  it('can’t be renamed or deleted, by a fresh revision or a stale one', async () => {
    const invocation = await inBusiness();
    const system = await systemFolder(invocation, 'contact');
    await expect(
      call(
        'renameFieldFolder',
        invocation,
        { name: 'Renamed', revision: system.revision },
        { folderId: system.id },
      ),
    ).rejects.toMatchObject({ issues: [{ path: '/name', code: 'system_folder' }] });
    await expect(
      call('deleteFieldFolder', invocation, undefined, { folderId: system.id }),
    ).rejects.toMatchObject({ issues: [{ path: '/folderId', code: 'system_folder' }] });
    expect(await systemFolder(invocation, 'contact')).toEqual(system);
    expect((await auditsOf(invocation)).map(({ command, outcome }) => [command, outcome])).toEqual([
      ['field_folder.rename', 'invalid'],
      ['field_folder.delete', 'invalid'],
    ]);
  });
});

describe('a folder the business makes', () => {
  it('is created last in its object, with its name trimmed, and is audited and announced', async () => {
    const invocation = await inBusiness();
    const first = await newFolder(invocation, '  Event details ');
    const second = await newFolder(invocation, 'Venue');
    expect(first).toMatchObject({
      objectKey: 'contact',
      name: 'Event details',
      system: false,
      position: 1,
      fieldCount: 0,
    });
    expect(second.position).toBe(2);
    expect((await foldersOf(invocation, 'contact')).map((each) => each.name)).toEqual([
      'Additional Info',
      'Event details',
      'Venue',
    ]);
    // Another object's folders are numbered on their own.
    expect((await newFolder(invocation, 'Event details', 'deal')).position).toBe(1);
    expect(await eventsOf(invocation)).toEqual(
      [
        ['contact', 'Event details'],
        ['contact', 'Venue'],
        ['deal', 'Event details'],
      ].map(([objectKey, name]) => ({
        type: 'field_folder.created',
        subject_kind: 'field_folder',
        payload: { objectKey, name },
      })),
    );
    expect((await auditsOf(invocation)).map(({ command, outcome }) => [command, outcome])).toEqual([
      ['field_folder.create', 'ok'],
      ['field_folder.create', 'ok'],
      ['field_folder.create', 'ok'],
    ]);
  });

  it('needs a name no other folder of the object has, whatever its case or outer spaces', async () => {
    const invocation = await inBusiness();
    await newFolder(invocation, 'Event details');
    for (const name of ['event details', ' EVENT DETAILS ', 'additional info'])
      await expect(
        call('createFieldFolder', invocation, { objectKey: 'contact', name }),
      ).rejects.toMatchObject({ issues: [{ path: '/name', code: 'taken' }] });
    await expect(
      call('createFieldFolder', invocation, { objectKey: 'venue', name: 'Rooms' }),
    ).rejects.toMatchObject({ issues: [{ path: '/objectKey', code: 'invalid_object' }] });
    const other = await newFolder(invocation, 'Venue');
    await expect(
      call(
        'renameFieldFolder',
        invocation,
        { name: 'event DETAILS', revision: other.revision },
        { folderId: other.id },
      ),
    ).rejects.toMatchObject({ issues: [{ path: '/name', code: 'taken' }] });
  });

  it('stops at 100 folders for an object, the system folder included', async () => {
    const invocation = await inBusiness();
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        `insert into crm.field_folders (business_id, object_type_id, name, position, created_by_kind)
         select app.business_id(), o.id, 'Folder ' || n, n, 'user'
         from crm.object_types o, generate_series(1, $1::int) as n
         where o.kind = 'contact'`,
        [FIELD_FOLDER_LIMITS.perObject - 2],
      ),
    );
    expect((await newFolder(invocation, 'The hundredth')).position).toBe(
      FIELD_FOLDER_LIMITS.perObject - 1,
    );
    await expect(
      call('createFieldFolder', invocation, { objectKey: 'contact', name: 'One too many' }),
    ).rejects.toMatchObject({ issues: [{ path: '/name', code: 'limit_reached' }] });
    // Another object still has room.
    await newFolder(invocation, 'One too many', 'deal');
  });

  it('is renamed under its revision, and a stale rename changes nothing', async () => {
    const invocation = await inBusiness();
    const created = await newFolder(invocation, 'Event details');
    const renamed = fieldFolder.parse(
      await call(
        'renameFieldFolder',
        invocation,
        { name: ' The event ', revision: created.revision },
        { folderId: created.id },
      ),
    );
    expect(renamed).toEqual({ ...created, name: 'The event', revision: renamed.revision });
    expect(renamed.revision).not.toBe(created.revision);
    await expect(
      call(
        'renameFieldFolder',
        invocation,
        { name: 'Overwritten', revision: created.revision },
        { folderId: created.id },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await foldersOf(invocation, 'contact')).map((each) => each.name)).toEqual([
      'Additional Info',
      'The event',
    ]);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'field_folder.renamed',
      subject_kind: 'field_folder',
      payload: { objectKey: 'contact', name: 'The event', previousName: 'Event details' },
    });
  });

  it('gives two folders made at the same moment for one object a place each', async () => {
    const invocation = await inBusiness();
    const object = await database.withTenant(invocation.context, (sql) =>
      sql.one<{ id: string }>("select id from crm.object_types where kind = 'contact'"),
    );
    const again = (): Invocation => ({
      ...invocation,
      context: { ...invocation.context, correlationId: randomUUID() },
    });
    // Both wait behind a transaction that holds the object, so neither has yet read how
    // many folders there are or which place is last.
    const release = await hold('select 1 from crm.object_types where id = $1 for update', [
      object.id,
    ]);
    const making = Promise.allSettled([newFolder(again(), 'First'), newFolder(again(), 'Second')]);
    try {
      await lockWaits(2);
    } finally {
      await release();
    }
    const places = (await making).map((each) =>
      each.status === 'fulfilled' ? each.value.position : each.status,
    );
    expect(places.sort()).toEqual([1, 2]);
  });

  it('lets exactly one of two renames made from the same revision through', async () => {
    const invocation = await inBusiness();
    const created = await newFolder(invocation, 'Event details');
    const rename = (name: string) =>
      call(
        'renameFieldFolder',
        { ...invocation, context: { ...invocation.context, correlationId: randomUUID() } },
        { name, revision: created.revision },
        { folderId: created.id },
      );
    // Both wait behind a transaction that holds the folder, so both are under way, each
    // from the old revision, before either can save.
    const release = await hold('select 1 from crm.field_folders where id = $1 for update', [
      parsePublicId('field_folder', created.id),
    ]);
    const saves = Promise.allSettled([rename('First'), rename('Second')]);
    try {
      await lockWaits(2);
    } finally {
      await release();
    }
    const outcomes = await saves;
    const won = outcomes.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : []));
    const lost = outcomes.flatMap((each): unknown[] =>
      each.status === 'rejected' ? [each.reason] : [],
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(ConflictError);
    const [, saved] = await foldersOf(invocation, 'contact');
    expect(saved?.name).toBe(fieldFolder.parse(won[0]).name);
  });
});

describe('the order of an object’s folders', () => {
  it('is whatever list of all of them is sent, and nothing else about them changes', async () => {
    const invocation = await inBusiness();
    const system = await systemFolder(invocation, 'contact');
    const a = await newFolder(invocation, 'A');
    const b = await newFolder(invocation, 'B');
    const dealFolder = await newFolder(invocation, 'Deal details', 'deal');
    const reordered = fieldFolderList.parse(
      await call('reorderFieldFolders', invocation, {
        objectKey: 'contact',
        folderIds: [b.id, system.id, a.id],
      }),
    );
    expect(reordered.items).toEqual([
      { ...b, position: 0 },
      { ...system, position: 1 },
      { ...a, position: 2 },
    ]);
    expect(await foldersOf(invocation, 'contact')).toEqual(reordered.items);
    expect(await foldersOf(invocation, 'deal')).toEqual([
      await systemFolder(invocation, 'deal'),
      dealFolder,
    ]);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'field_folder.reordered',
      subject_kind: 'object_type',
      payload: { objectKey: 'contact', folderIds: [b.id, system.id, a.id] },
    });
  });

  it('is refused when the list is not exactly the object’s folders, and then nothing moves', async () => {
    const invocation = await inBusiness();
    const elsewhere = await inBusiness();
    const system = await systemFolder(invocation, 'contact');
    const a = await newFolder(invocation, 'A');
    const b = await newFolder(invocation, 'B');
    const dealFolder = await newFolder(invocation, 'Deal details', 'deal');
    const foreign = await newFolder(elsewhere, 'Theirs');
    const before = await foldersOf(invocation);
    for (const folderIds of [
      // One was added since the list was read; one is another object's; one another business's.
      [b.id, system.id],
      [b.id, system.id, dealFolder.id],
      [b.id, system.id, foreign.id],
      [b.id, system.id, a.id, dealFolder.id],
    ])
      await expect(
        call('reorderFieldFolders', invocation, { objectKey: 'contact', folderIds }),
      ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      call('reorderFieldFolders', invocation, { objectKey: 'venue', folderIds: [a.id] }),
    ).rejects.toMatchObject({ issues: [{ path: '/objectKey', code: 'invalid_object' }] });
    expect(await foldersOf(invocation)).toEqual(before);
    expect(await foldersOf(elsewhere, 'contact')).toContainEqual(foreign);
  });
});

describe('deleting a folder', () => {
  it('moves its fields, archived ones too, to the system folder with every value kept', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Event details');
    const live = await newField(invocation, { folderId: folder.id });
    const archived = await newField(invocation, {
      key: 'old_venue',
      label: 'Old venue',
      valueType: 'text',
      folderId: folder.id,
      archived: true,
    });
    const elsewhere = await newField(invocation, { key: 'budget', label: 'Budget' });
    const contact = await database.fixtures.contact(invocation.context);
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        `insert into crm.field_values (business_id, record_id, field_id, value_type, value_number, source_kind)
         values (app.business_id(), $1, $2, 'number', 120, 'user')`,
        [contact.id, parsePublicId('field', live.id)],
      ),
    );
    expect(live.folderId).toBe(folder.id);
    expect((await foldersOf(invocation, 'contact'))[1]?.fieldCount).toBe(1);

    expect(await call('deleteFieldFolder', invocation, undefined, { folderId: folder.id })).toBe(
      undefined,
    );

    const system = await systemFolder(invocation, 'contact');
    expect(await foldersOf(invocation, 'contact')).toEqual([{ ...system, fieldCount: 2 }]);
    const fields = await fieldsOf(invocation);
    expect(fields.map(({ key, folderId, archived: gone }) => [key, folderId, gone]).sort()).toEqual(
      [
        ['budget', system.id, false],
        ['guest_count', system.id, false],
        ['old_venue', system.id, true],
      ],
    );
    expect(fields.find((field) => field.id === elsewhere.id)).toEqual(elsewhere);
    expect(fields.find((field) => field.id === archived.id)?.key).toBe('old_venue');
    const kept = await database.withTenant(invocation.context, (sql) =>
      sql.query<{ value_number: string }>(
        'select value_number from crm.field_values where field_id = $1',
        [parsePublicId('field', live.id)],
      ),
    );
    expect(kept).toEqual([{ value_number: '120' }]);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'field_folder.deleted',
      subject_kind: 'field_folder',
      payload: {
        objectKey: 'contact',
        name: 'Event details',
        movedFields: 2,
        movedTo: system.id,
      },
    });
    await expect(
      call('deleteFieldFolder', invocation, undefined, { folderId: folder.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('moving fields', () => {
  it('puts one or several fields in a folder of their object, and counts follow', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Event details');
    const first = await newField(invocation);
    const second = await newField(invocation, { key: 'budget', label: 'Budget' });
    const stays = await newField(invocation, { key: 'venue', label: 'Venue', valueType: 'text' });
    const moved = fieldFolder.parse(
      await call(
        'moveFieldsToFolder',
        invocation,
        { fieldIds: [second.id, first.id] },
        { folderId: folder.id },
      ),
    );
    expect(moved).toEqual({ ...folder, fieldCount: 2 });
    const system = await systemFolder(invocation, 'contact');
    expect(system.fieldCount).toBe(1);
    const fields = await fieldsOf(invocation);
    expect(fields.map(({ key, folderId }) => [key, folderId]).sort()).toEqual([
      ['budget', folder.id],
      ['guest_count', folder.id],
      ['venue', system.id],
    ]);
    expect(fields.find((field) => field.id === stays.id)).toEqual(stays);
    // Its merge key is still what it was: where a field sits never changes its key.
    expect(fields.find((field) => field.id === first.id)).toMatchObject({
      key: 'guest_count',
      mergeKey: 'contact.guest_count',
    });
    expect((await eventsOf(invocation)).at(-1)).toMatchObject({
      type: 'field.moved',
      payload: { objectKey: 'contact', folderName: 'Event details' },
    });
    // Moving them where they already are is not a change: nothing is announced.
    const events = (await eventsOf(invocation)).length;
    await call('moveFieldsToFolder', invocation, { fieldIds: [first.id] }, { folderId: folder.id });
    expect(await eventsOf(invocation)).toHaveLength(events);
    // And back to the system folder, which takes fields like any other.
    await call('moveFieldsToFolder', invocation, { fieldIds: [first.id] }, { folderId: system.id });
    expect((await systemFolder(invocation, 'contact')).fieldCount).toBe(2);
  });

  it('moves all of them or none: a field of another object or business stops the move', async () => {
    const invocation = await inBusiness();
    const elsewhere = await inBusiness();
    const folder = await newFolder(invocation, 'Event details');
    const own = await newField(invocation);
    const dealField = await newField(invocation, { objectKey: 'deal' });
    const foreign = await newField(elsewhere);
    for (const fieldIds of [
      [own.id, dealField.id],
      [own.id, foreign.id],
    ])
      await expect(
        call('moveFieldsToFolder', invocation, { fieldIds }, { folderId: folder.id }),
      ).rejects.toMatchObject({ issues: [{ path: '/fieldIds', code: 'invalid_field' }] });
    const system = await systemFolder(invocation, 'contact');
    expect((await fieldsOf(invocation)).map((field) => field.folderId)).toEqual([
      system.id,
      (await systemFolder(invocation, 'deal')).id,
    ]);
    expect((await fieldsOf(elsewhere))[0]).toEqual(foreign);
  });
});

describe('a field’s folder and placeholder when it is created or saved', () => {
  it('are taken when given, kept when left out, and refused when the folder is not the object’s', async () => {
    const invocation = await inBusiness();
    const elsewhere = await inBusiness();
    const folder = await newFolder(invocation, 'Event details');
    const dealFolder = await newFolder(invocation, 'Deal details', 'deal');
    const foreign = await newFolder(elsewhere, 'Theirs');
    const field = await newField(invocation, { folderId: folder.id, placeholder: ' How many? ' });
    expect(field).toMatchObject({ folderId: folder.id, placeholder: 'How many?' });
    for (const folderId of [dealFolder.id, foreign.id]) {
      await expect(
        call('createField', invocation, { ...fieldInput, key: 'other', label: 'Other', folderId }),
      ).rejects.toMatchObject({ issues: [{ path: '/folderId', code: 'invalid_folder' }] });
      await expect(
        call('updateField', invocation, { ...editing(field), folderId }, { fieldId: field.id }),
      ).rejects.toMatchObject({ issues: [{ path: '/folderId', code: 'invalid_folder' }] });
    }
    // A save that names neither leaves both as they are.
    const relabelled = fieldDefinition.parse(
      await call(
        'updateField',
        invocation,
        { ...editing(field), label: 'Guests' },
        { fieldId: field.id },
      ),
    );
    expect(relabelled).toMatchObject({ folderId: folder.id, placeholder: 'How many?' });
    const system = await systemFolder(invocation, 'contact');
    const moved = fieldDefinition.parse(
      await call(
        'updateField',
        invocation,
        { ...editing(relabelled), folderId: system.id, placeholder: '' },
        { fieldId: field.id },
      ),
    );
    expect(moved).toMatchObject({ folderId: system.id, placeholder: '' });
    expect((await fieldsOf(invocation)).map((each) => each.key)).toEqual(['guest_count']);
  });

  it('treats a move made while the field’s form was open as a stale save', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Event details');
    const field = await newField(invocation);
    await call('moveFieldsToFolder', invocation, { fieldIds: [field.id] }, { folderId: folder.id });
    await expect(
      call(
        'updateField',
        invocation,
        { ...editing(field), label: 'Guests' },
        { fieldId: field.id },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const [saved] = await fieldsOf(invocation);
    expect(saved).toMatchObject({ label: 'Guest count', folderId: folder.id });
    expect(saved?.revision).not.toBe(field.revision);
  });
});

describe('a field’s merge key', () => {
  it('is contact.<key>, opportunity.<key> or business.<key>, with who made it and when', async () => {
    const invocation = await inBusiness();
    const contact = await newField(invocation, { key: 'select_your_fence_type' });
    const deal = await newField(invocation, { objectKey: 'deal', key: 'quote_total' });
    const company = await newField(invocation, { objectKey: 'company', key: 'city' });
    expect([contact.mergeKey, deal.mergeKey, company.mergeKey]).toEqual([
      'contact.select_your_fence_type',
      'opportunity.quote_total',
      'business.city',
    ]);
    expect(contact.source).toBe('user');
    const created = await database.withTenant(invocation.context, (sql) =>
      sql.one<{ created_at: Date }>('select created_at from crm.field_definitions where id = $1', [
        parsePublicId('field', contact.id),
      ]),
    );
    expect(contact.createdAt).toBe(created.created_at.toISOString());
    // The same answer wherever the field is read: object by object, in each folder's order.
    expect(await fieldsOf(invocation)).toEqual([company, contact, deal]);
  });

  it('is contact.custom.<key> where a built-in contact field has the name, and custom_objects.<object>.<key> for a custom object', async () => {
    const invocation = await inBusiness();
    const email = await newField(invocation, {
      key: 'email',
      label: 'Second email',
      valueType: 'text',
    });
    expect(email.mergeKey).toBe('contact.custom.email');
    // On a deal or a company the same key is not shadowed by anything.
    expect((await newField(invocation, { objectKey: 'deal', key: 'email' })).mergeKey).toBe(
      'opportunity.email',
    );
    // A custom object, made with its primary field as every one is.
    await database.withTenant(invocation.context, async (sql) => {
      const made = await sql.one<{ id: string; primary_field_id: string }>(
        `insert into crm.object_types
           (business_id, id, kind, key, singular_label, plural_label, primary_field_id)
         values (app.business_id(), uuidv7(), 'custom', 'venue', 'Venue', 'Venues', uuidv7())
         returning id, primary_field_id`,
      );
      await sql.query(
        `insert into crm.field_definitions
           (business_id, id, object_type_id, key, label, value_type, created_by_kind)
         values (app.business_id(), $1, $2, 'name', 'Venue name', 'text', 'user')`,
        [made.primary_field_id, made.id],
      );
    });
    const capacity = await newField(invocation, { objectKey: 'venue', key: 'capacity' });
    expect(capacity.mergeKey).toBe('custom_objects.venue.capacity');
  });

  it('never changes: not when the field is renamed, moved, or archived and restored', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Event details');
    const field = await newField(invocation);
    const renamed = fieldDefinition.parse(
      await call(
        'updateField',
        invocation,
        { ...editing(field), label: 'Number of attendees', folderId: folder.id, archived: true },
        { fieldId: field.id },
      ),
    );
    const restored = fieldDefinition.parse(
      await call(
        'updateField',
        invocation,
        { ...editing(renamed), archived: false },
        { fieldId: field.id },
      ),
    );
    for (const each of [renamed, restored])
      expect([each.key, each.mergeKey, each.createdAt]).toEqual([
        'guest_count',
        'contact.guest_count',
        field.createdAt,
      ]);
    // No save can name a key, and the key a field has stays taken on its object.
    await expect(
      call(
        'updateField',
        invocation,
        { ...editing(restored), key: 'attendees' },
        { fieldId: field.id },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      call('createField', invocation, { ...fieldInput, label: 'Another' }),
    ).rejects.toMatchObject({ issues: [{ path: '/key' }] });
    // The same key on another object is another field, with another merge key.
    expect((await newField(invocation, { objectKey: 'deal' })).mergeKey).toBe(
      'opportunity.guest_count',
    );
  });
});

describe('who may change folders', () => {
  it('is whoever has fields.manage: without it every command is refused and nothing changes', async () => {
    const owner = await inBusiness();
    const folder = await newFolder(owner, 'Event details');
    const field = await newField(owner);
    const reader: Invocation = { ...owner, permissions: new Set() };
    const before = await foldersOf(owner);
    for (const attempt of [
      () => call('createFieldFolder', reader, { objectKey: 'contact', name: 'Mine' }),
      () =>
        call(
          'renameFieldFolder',
          reader,
          { name: 'Mine', revision: folder.revision },
          { folderId: folder.id },
        ),
      () =>
        call('reorderFieldFolders', reader, {
          objectKey: 'contact',
          folderIds: before.filter((each) => each.objectKey === 'contact').map((each) => each.id),
        }),
      () => call('moveFieldsToFolder', reader, { fieldIds: [field.id] }, { folderId: folder.id }),
      () => call('deleteFieldFolder', reader, undefined, { folderId: folder.id }),
    ]) {
      const refusal: unknown = await attempt().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ForbiddenError);
      expect(refusal).toMatchObject({ permission: 'fields.manage' });
    }
    // Reading is open to everyone in the business, who are told they may not manage.
    expect(fieldFolderList.parse(await call('listFieldFolders', reader))).toEqual({
      items: before,
      canManage: false,
      total: before.length,
      next: null,
    });
    expect(fieldFolderList.parse(await call('listFieldFolders', owner)).canManage).toBe(true);
  });
});

describe('another business', () => {
  it('sees none of these folders and can’t rename, delete, fill or reorder them', async () => {
    const owner = await inBusiness();
    const other = await inBusiness();
    const folder = await newFolder(owner, 'Event details');
    const field = await newField(owner);
    const theirs = await newField(other);
    expect((await foldersOf(other)).map((each) => each.id)).not.toContain(folder.id);
    for (const attempt of [
      () =>
        call(
          'renameFieldFolder',
          other,
          { name: 'Taken', revision: folder.revision },
          { folderId: folder.id },
        ),
      () => call('deleteFieldFolder', other, undefined, { folderId: folder.id }),
      () => call('moveFieldsToFolder', other, { fieldIds: [theirs.id] }, { folderId: folder.id }),
      // Not found comes before anything about the body: a folder that is not theirs is not
      // described, not even by what a rename or a move of it would need.
      () => call('renameFieldFolder', other, {}, { folderId: folder.id }),
      () => call('moveFieldsToFolder', other, { fieldIds: 'all' }, { folderId: folder.id }),
    ])
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    // Their own folder never takes this business's field.
    const otherFolder = await newFolder(other, 'Theirs');
    await expect(
      call('moveFieldsToFolder', other, { fieldIds: [field.id] }, { folderId: otherFolder.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await foldersOf(owner, 'contact')).toEqual([
      await systemFolder(owner, 'contact'),
      folder,
    ]);
    const { businessId: _businessId, ...atAgency } = owner.context;
    await expect(call('listFieldFolders', { ...owner, context: atAgency })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('is not found by the commands themselves, with no route in front of them', async () => {
    const owner = await inBusiness();
    const other = await inBusiness();
    const folder = await newFolder(owner, 'Event details');
    const theirs = await newField(other);
    for (const attempt of [
      () =>
        runCommand(
          services,
          renameFieldFolderCommand,
          { folderId: folder.id, name: 'Taken', revision: folder.revision },
          other,
        ),
      () => runCommand(services, deleteFieldFolderCommand, { folderId: folder.id }, other),
      () =>
        runCommand(
          services,
          moveFieldsCommand,
          { folderId: folder.id, fieldIds: [theirs.id] },
          other,
        ),
    ])
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    expect(await foldersOf(owner, 'contact')).toEqual([
      await systemFolder(owner, 'contact'),
      folder,
    ]);
    // Each attempt is on record as one that failed.
    expect((await auditsOf(other)).slice(-3)).toEqual(
      ['field_folder.rename', 'field_folder.delete', 'field.move'].map((command) => ({
        command,
        outcome: 'failed',
        error_code: 'not_found',
      })),
    );
  });
});
