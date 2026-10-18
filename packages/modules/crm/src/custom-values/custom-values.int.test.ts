// Custom values through the CRM's own routes and commands, against a migrated Postgres: custom
// values, their keys, their folders, the list, and who may change them.
import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  CUSTOM_VALUE_LIMITS,
  customValue,
  customValueFolder,
  customValueFolderList,
  customValueList,
  type CustomValue,
  type CustomValueFolder,
  type CustomValueList,
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
import { deleteCustomValueCommand, updateCustomValueCommand } from './custom-values.js';
import { deleteCustomValueFolderCommand, renameCustomValueFolderCommand } from './folders.js';

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
const create = async (
  invocation: Invocation,
  input: Record<string, unknown>,
): Promise<CustomValue> => customValue.parse(await call('createCustomValue', invocation, input));
const save = async (
  invocation: Invocation,
  current: CustomValue,
  change: Record<string, unknown> = {},
): Promise<CustomValue> =>
  customValue.parse(
    await call(
      'updateCustomValue',
      invocation,
      {
        name: current.name,
        value: current.value,
        folderId: current.folderId,
        revision: current.revision,
        ...change,
      },
      { valueId: current.id },
    ),
  );
const list = async (
  invocation: Invocation,
  query: Record<string, string> = {},
): Promise<CustomValueList> =>
  customValueList.parse(await call('listCustomValues', invocation, undefined, {}, query));
const names = (page: CustomValueList): string[] => page.items.map((each) => each.name);
const newFolder = async (invocation: Invocation, name: string): Promise<CustomValueFolder> =>
  customValueFolder.parse(await call('createCustomValueFolder', invocation, { name }));
const foldersOf = async (invocation: Invocation): Promise<CustomValueFolder[]> =>
  customValueFolderList.parse(await call('listCustomValueFolders', invocation)).items;
const eventsOf = (invocation: Invocation) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ type: string; subject_kind: string; payload: Record<string, unknown> }>(
      'select type, subject_kind, payload from events.events where correlation_id = $1 order by id',
      [invocation.context.correlationId],
    ),
  );
const auditsOf = (invocation: Invocation) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ command: string; outcome: string; input: Record<string, unknown> }>(
      'select command, outcome, input from audit.commands where correlation_id = $1 order by id',
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

describe('creating a custom value', () => {
  it('needs only a name: the key comes from it, the text is empty and it is in no folder', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation, { name: '  Hours of operation ' });
    expect(made).toMatchObject({
      key: 'hours_of_operation',
      mergeKey: 'custom_values.hours_of_operation',
      name: 'Hours of operation',
      value: '',
      folderId: null,
      folderName: null,
    });
    expect(made.createdAt).toBe(made.updatedAt);
    expect(await list(invocation)).toEqual({
      items: [made],
      total: 1,
      next: null,
      canManage: true,
    });
  });

  it('takes text exactly as written and a folder, and is audited without the text', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Links');
    const text = '  https://harborlights.example/reel\nNew every month.  ';
    const made = await create(invocation, {
      name: 'Sample reel URL',
      value: text,
      folderId: folder.id,
    });
    expect(made).toMatchObject({
      key: 'sample_reel_url',
      value: text,
      folderId: folder.id,
      folderName: 'Links',
    });
    const saved = await save(invocation, made, { value: 'https://harborlights.example/new' });
    expect(saved.value).toBe('https://harborlights.example/new');
    expect(await eventsOf(invocation)).toEqual([
      {
        type: 'custom_value_folder.created',
        subject_kind: 'custom_value_folder',
        payload: { name: 'Links' },
      },
      {
        type: 'custom_value.created',
        subject_kind: 'custom_value',
        payload: { key: 'sample_reel_url', name: 'Sample reel URL' },
      },
      {
        type: 'custom_value.updated',
        subject_kind: 'custom_value',
        payload: { key: 'sample_reel_url', name: 'Sample reel URL', valueChanged: true },
      },
    ]);
    const audits = await auditsOf(invocation);
    expect(audits.map(({ command, outcome }) => [command, outcome])).toEqual([
      ['custom_value_folder.create', 'ok'],
      ['custom_value.create', 'ok'],
      ['custom_value.update', 'ok'],
    ]);
    // Which value it was and how long its text is, never the text.
    expect(audits[1]?.input).toEqual({
      name: 'Sample reel URL',
      folderId: folder.id,
      valueLength: text.length,
    });
    expect(JSON.stringify(audits)).not.toContain('harborlights.example');
  });

  it('gives a key made from a taken name the next free number, and keeps a chosen key as it is', async () => {
    const invocation = await inBusiness();
    const first = await create(invocation, { name: 'Hours' });
    await save(invocation, first, { name: 'Opening hours' });
    // The name is free again; the key is not, and never will be.
    expect((await create(invocation, { name: 'Hours' })).key).toBe('hours_2');
    const second = await list(invocation, { q: 'hours_2' });
    await save(invocation, second.items[0] ?? first, { name: 'Weekend hours' });
    expect((await create(invocation, { name: 'Hours' })).key).toBe('hours_3');
    expect((await create(invocation, { name: '24h line' })).key).toBe('value_24h_line');
    expect((await create(invocation, { name: 'Reel', key: 'sample_reel_url' })).key).toBe(
      'sample_reel_url',
    );
    await expect(
      create(invocation, { name: 'Another reel', key: 'sample_reel_url' }),
    ).rejects.toMatchObject({ issues: [{ path: '/key', code: 'taken' }] });
    // A long name still leaves room for the number.
    const long = 'a'.repeat(80);
    expect((await create(invocation, { name: long })).key).toBe('a'.repeat(63));
    await database.withTenant(invocation.context, (sql) =>
      sql.query("update crm.custom_values set name = 'Renamed long' where key = $1", [
        'a'.repeat(63),
      ]),
    );
    expect((await create(invocation, { name: long })).key).toBe(`${'a'.repeat(61)}_2`);
  });

  it('gives two values made at the same moment, from names that make the same key, a key each', async () => {
    const invocation = await inBusiness();
    const again = (): Invocation => ({
      ...invocation,
      context: { ...invocation.context, correlationId: randomUUID() },
    });
    // Both wait behind a transaction that holds the business's turn to add a value, so
    // neither has yet read which keys are taken.
    const release = await hold('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `crm.custom_values:${invocation.context.businessId ?? ''}`,
    ]);
    const making = Promise.allSettled([
      create(again(), { name: 'Hours!' }),
      create(again(), { name: 'Hours?' }),
    ]);
    try {
      await lockWaits(2);
    } finally {
      await release();
    }
    const keys = (await making).map((each) =>
      each.status === 'fulfilled' ? each.value.key : each.status,
    );
    expect(keys.sort()).toEqual(['hours', 'hours_2']);
  });

  it('refuses a name another value has, whatever its case or outer spaces, and a folder that isn’t there', async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    await create(invocation, { name: 'Hours' });
    for (const name of ['hours', '  HOURS '])
      await expect(create(invocation, { name })).rejects.toMatchObject({
        issues: [{ path: '/name', code: 'taken' }],
      });
    const foreign = await newFolder(other, 'Theirs');
    await expect(
      create(invocation, { name: 'Planted', folderId: foreign.id }),
    ).rejects.toMatchObject({ issues: [{ path: '/folderId', code: 'invalid_folder' }] });
    // Another business may use the same name and gets the same key.
    expect((await create(other, { name: 'Hours' })).key).toBe('hours');
    expect(names(await list(invocation))).toEqual(['Hours']);
  });

  it('stops at 500 values for a business', async () => {
    const invocation = await inBusiness();
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        `insert into crm.custom_values (business_id, key, name, created_by_kind)
         select app.business_id(), 'value_' || n, 'Value ' || n, 'user'
         from generate_series(1, $1::int) as n`,
        [CUSTOM_VALUE_LIMITS.values - 1],
      ),
    );
    await create(invocation, { name: 'The last one' });
    await expect(create(invocation, { name: 'One too many' })).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'limit_reached' }],
    });
    expect((await list(invocation, { limit: '1' })).total).toBe(CUSTOM_VALUE_LIMITS.values);
  });
});

describe('changing a custom value', () => {
  it('saves a new name, text and folder under its revision, and never a new key', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Links');
    const made = await create(invocation, { name: 'Hours', value: '9 to 5' });
    const saved = await save(invocation, made, {
      name: ' Opening hours ',
      value: 'Mon to Fri, 9 to 5',
      folderId: folder.id,
    });
    expect(saved).toEqual({
      ...made,
      name: 'Opening hours',
      value: 'Mon to Fri, 9 to 5',
      folderId: folder.id,
      folderName: 'Links',
      updatedAt: saved.updatedAt,
      revision: saved.revision,
    });
    expect([saved.key, saved.mergeKey]).toEqual(['hours', 'custom_values.hours']);
    expect(saved.revision).not.toBe(made.revision);
    // A save names no key at all.
    await expect(save(invocation, saved, { key: 'opening_hours' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // A rename alone says the text did not change.
    await save(invocation, saved, { name: 'Hours' });
    expect((await eventsOf(invocation)).at(-1)?.payload).toEqual({
      key: 'hours',
      name: 'Hours',
      valueChanged: false,
    });
  });

  it('refuses a stale save and changes nothing', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation, { name: 'Hours', value: '9 to 5' });
    const saved = await save(invocation, made, { value: '8 to 6' });
    await expect(save(invocation, made, { value: 'Never' })).rejects.toBeInstanceOf(ConflictError);
    expect((await list(invocation)).items).toEqual([saved]);
    const other = await create(invocation, { name: 'Phone' });
    await expect(save(invocation, other, { name: 'hours' })).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'taken' }],
    });
  });

  it('lets exactly one of two saves made from the same revision through', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation, { name: 'Hours', value: '9 to 5' });
    const saving = (value: string) =>
      save(
        { ...invocation, context: { ...invocation.context, correlationId: randomUUID() } },
        made,
        { value },
      );
    // Both wait behind a transaction that holds the value, so both are under way, each
    // from the old revision, before either can save.
    const release = await hold('select 1 from crm.custom_values where id = $1 for update', [
      parsePublicId('custom_value', made.id),
    ]);
    const saves = Promise.allSettled([saving('First'), saving('Second')]);
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
    expect((await list(invocation)).items).toEqual(won);
  });

  it('deletes a value for good', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation, { name: 'Hours' });
    const kept = await create(invocation, { name: 'Phone' });
    expect(await call('deleteCustomValue', invocation, undefined, { valueId: made.id })).toBe(
      undefined,
    );
    expect((await list(invocation)).items).toEqual([kept]);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'custom_value.deleted',
      subject_kind: 'custom_value',
      payload: { key: 'hours', name: 'Hours' },
    });
    await expect(
      call('deleteCustomValue', invocation, undefined, { valueId: made.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(save(invocation, made)).rejects.toBeInstanceOf(NotFoundError);
    // The key is free for a new value, which is a new value.
    const again = await create(invocation, { name: 'Hours' });
    expect(again.key).toBe('hours');
    expect(again.id).not.toBe(made.id);
  });
});

describe('folders', () => {
  it('are made with a unique name, renamed under a revision, and count their values', async () => {
    const invocation = await inBusiness();
    const links = await newFolder(invocation, '  Links ');
    expect(links).toMatchObject({ name: 'Links', valueCount: 0 });
    for (const name of ['links', ' LINKS '])
      await expect(call('createCustomValueFolder', invocation, { name })).rejects.toMatchObject({
        issues: [{ path: '/name', code: 'taken' }],
      });
    const opening = await newFolder(invocation, 'Opening');
    await create(invocation, { name: 'Reel', folderId: links.id });
    await create(invocation, { name: 'Site', folderId: links.id });
    await create(invocation, { name: 'Loose' });
    const renamed = customValueFolder.parse(
      await call(
        'renameCustomValueFolder',
        invocation,
        { name: 'Web links', revision: links.revision },
        { folderId: links.id },
      ),
    );
    expect(renamed).toEqual({
      ...links,
      name: 'Web links',
      valueCount: 2,
      revision: renamed.revision,
    });
    await expect(
      call(
        'renameCustomValueFolder',
        invocation,
        { name: 'Overwritten', revision: links.revision },
        { folderId: links.id },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      call(
        'renameCustomValueFolder',
        invocation,
        { name: 'opening', revision: renamed.revision },
        { folderId: links.id },
      ),
    ).rejects.toMatchObject({ issues: [{ path: '/name', code: 'taken' }] });
    // By name, each with its count.
    expect(await foldersOf(invocation)).toEqual([opening, renamed]);
    expect((await list(invocation, { folder: links.id })).items[0]?.folderName).toBe('Web links');
  });

  it('let exactly one of two renames made from the same revision through', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Links');
    const rename = (name: string) =>
      call(
        'renameCustomValueFolder',
        { ...invocation, context: { ...invocation.context, correlationId: randomUUID() } },
        { name, revision: folder.revision },
        { folderId: folder.id },
      );
    const release = await hold('select 1 from crm.custom_value_folders where id = $1 for update', [
      parsePublicId('custom_value_folder', folder.id),
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
    expect((await foldersOf(invocation))[0]?.name).toBe(customValueFolder.parse(won[0]).name);
  });

  it('leave their values, in no folder, when deleted', async () => {
    const invocation = await inBusiness();
    const links = await newFolder(invocation, 'Links');
    const kept = await newFolder(invocation, 'Opening');
    const reel = await create(invocation, { name: 'Reel', value: 'https://x', folderId: links.id });
    const hours = await create(invocation, { name: 'Hours', folderId: kept.id });
    expect(
      await call('deleteCustomValueFolder', invocation, undefined, { folderId: links.id }),
    ).toBe(undefined);
    expect(await foldersOf(invocation)).toEqual([{ ...kept, valueCount: 1 }]);
    const left = (await list(invocation)).items;
    expect(left.map(({ name, value, folderId, key }) => [name, value, folderId, key])).toEqual([
      ['Hours', '', kept.id, 'hours'],
      ['Reel', 'https://x', null, 'reel'],
    ]);
    expect(left[0]).toEqual(hours);
    // Out of the folder is a change to the value: an edit made before it is stale.
    await expect(save(invocation, reel, { value: 'late' })).rejects.toBeInstanceOf(ConflictError);
    // And a fresh save can't put it back in a folder that is gone.
    const fresh = left[1] ?? reel;
    await expect(save(invocation, fresh, { folderId: links.id })).rejects.toMatchObject({
      issues: [{ path: '/folderId', code: 'invalid_folder' }],
    });
    expect((await list(invocation)).items).toEqual(left);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'custom_value_folder.deleted',
      subject_kind: 'custom_value_folder',
      payload: { name: 'Links', valuesLeftWithoutFolder: 1 },
    });
    await expect(
      call('deleteCustomValueFolder', invocation, undefined, { folderId: links.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('stop at 100 folders for a business', async () => {
    const invocation = await inBusiness();
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        `insert into crm.custom_value_folders (business_id, name, created_by_kind)
         select app.business_id(), 'Folder ' || n, 'user' from generate_series(1, $1::int) as n`,
        [CUSTOM_VALUE_LIMITS.folders - 1],
      ),
    );
    await newFolder(invocation, 'The last one');
    await expect(
      call('createCustomValueFolder', invocation, { name: 'One too many' }),
    ).rejects.toMatchObject({ issues: [{ path: '/name', code: 'limit_reached' }] });
  });
});

describe('moving values', () => {
  it('puts several in a folder, or takes them out of any, and answers in the order asked', async () => {
    const invocation = await inBusiness();
    const links = await newFolder(invocation, 'Links');
    const reel = await create(invocation, { name: 'Reel' });
    const site = await create(invocation, { name: 'Site' });
    const hours = await create(invocation, { name: 'Hours', folderId: links.id });
    const moved = (await call('moveCustomValues', invocation, {
      valueIds: [site.id, reel.id, hours.id],
      folderId: links.id,
    })) as { items: unknown[] };
    expect(moved.items.map((each) => customValue.parse(each))).toMatchObject([
      { id: site.id, folderId: links.id, folderName: 'Links', key: 'site' },
      { id: reel.id, folderId: links.id, folderName: 'Links', key: 'reel' },
      // Already there: answered as it is, and not part of what is announced.
      hours,
    ]);
    expect((await eventsOf(invocation)).at(-1)).toEqual({
      type: 'custom_value.moved',
      subject_kind: 'business',
      payload: { folderId: links.id, valueIds: [reel.id, site.id] },
    });
    expect((await foldersOf(invocation))[0]?.valueCount).toBe(3);
    const out = (await call('moveCustomValues', invocation, {
      valueIds: [reel.id],
      folderId: null,
    })) as { items: unknown[] };
    expect(customValue.parse(out.items[0])).toMatchObject({ folderId: null, folderName: null });
    expect(names(await list(invocation, { folder: 'none' }))).toEqual(['Reel']);
    expect(names(await list(invocation, { folder: links.id }))).toEqual(['Hours', 'Site']);
  });

  it('moves all of them or none: a value or a folder of another business stops the move', async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const links = await newFolder(invocation, 'Links');
    const reel = await create(invocation, { name: 'Reel' });
    const foreign = await create(other, { name: 'Theirs' });
    const foreignFolder = await newFolder(other, 'Their folder');
    await expect(
      call('moveCustomValues', invocation, {
        valueIds: [reel.id, foreign.id],
        folderId: links.id,
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/valueIds', code: 'invalid_value' }] });
    await expect(
      call('moveCustomValues', invocation, { valueIds: [reel.id], folderId: foreignFolder.id }),
    ).rejects.toMatchObject({ issues: [{ path: '/folderId', code: 'invalid_folder' }] });
    expect((await list(invocation)).items).toEqual([reel]);
    expect((await list(other)).items).toEqual([foreign]);
  });
});

describe('the list', () => {
  async function harborLights() {
    const invocation = await inBusiness();
    const links = await newFolder(invocation, 'Links');
    await create(invocation, {
      name: 'sample reel URL',
      value: 'https://harborlights.example/reel',
      folderId: links.id,
    });
    await create(invocation, { name: 'Hours of operation', value: 'Mon to Fri, 9 to 5' });
    await create(invocation, {
      name: 'Booking page',
      value: 'https://harborlights.example/book',
      folderId: links.id,
    });
    await create(invocation, { name: 'address', value: '12 Harbor Road' });
    await create(invocation, { name: '100% guarantee', value: 'Money back' });
    // "100" with no percent sign after it: a search for "100%" must not find this.
    await create(invocation, { name: 'Room capacity', value: '100 guests' });
    return { invocation, links };
  }

  it('is in name order whatever the case, with how many there are', async () => {
    const { invocation } = await harborLights();
    const page = await list(invocation);
    expect(names(page)).toEqual([
      '100% guarantee',
      'address',
      'Booking page',
      'Hours of operation',
      'Room capacity',
      'sample reel URL',
    ]);
    expect(page.total).toBe(6);
    expect(page.next).toBeNull();
  });

  it.each([
    // By part of a name, of a key or of the text, in any case.
    [{ q: 'HOURS' }, ['Hours of operation']],
    [{ q: 'sample_reel' }, ['sample reel URL']],
    [{ q: 'harborlights.example' }, ['Booking page', 'sample reel URL']],
    [{ q: 'mon to fri' }, ['Hours of operation']],
    [{ q: '100%' }, ['100% guarantee']],
    [{ q: 'value_100' }, ['100% guarantee']],
    [{ q: 'nothing' }, []],
    [{ q: '100' }, ['100% guarantee', 'Room capacity']],
    [{ folder: 'none' }, ['100% guarantee', 'address', 'Hours of operation', 'Room capacity']],
    [
      { folder: 'none', q: 'a' },
      ['100% guarantee', 'address', 'Hours of operation', 'Room capacity'],
    ],
    [{ folder: 'none', q: 'road' }, ['address']],
  ] as const)('%j finds %j', async (query, expected) => {
    const { invocation } = await harborLights();
    const page = await list(invocation, query);
    expect(names(page)).toEqual(expected);
    expect(page.total).toBe(expected.length);
  });

  it('is filtered by a folder', async () => {
    const { invocation, links } = await harborLights();
    const page = await list(invocation, { folder: links.id });
    expect(names(page)).toEqual(['Booking page', 'sample reel URL']);
    expect(page.items.every((each) => each.folderName === 'Links')).toBe(true);
  });

  it('pages by name, and goes on from where it was even if that value is gone', async () => {
    const { invocation } = await harborLights();
    const first = await list(invocation, { limit: '2' });
    expect(names(first)).toEqual(['100% guarantee', 'address']);
    expect(first.total).toBe(6);
    const last = first.items.at(-1);
    if (last === undefined || first.next === null) throw new Error('A second page follows.');
    // The value the page ended on is deleted, and one is added before it and one after.
    await call('deleteCustomValue', invocation, undefined, { valueId: last.id });
    await create(invocation, { name: 'Aardvark' });
    await create(invocation, { name: 'Calendar link' });
    const second = await list(invocation, { limit: '2', after: first.next });
    expect(names(second)).toEqual(['Booking page', 'Calendar link']);
    const third = await list(invocation, { limit: '2', after: second.next ?? '' });
    expect(names(third)).toEqual(['Hours of operation', 'Room capacity']);
    const fourth = await list(invocation, { limit: '2', after: third.next ?? '' });
    expect(names(fourth)).toEqual(['sample reel URL']);
    expect(fourth.next).toBeNull();
  });

  it.each([
    'x',
    'bm90IGpzb24',
    Buffer.from('["a"]').toString('base64url'),
    Buffer.from('["a","not-a-uuid"]').toString('base64url'),
    Buffer.from('{"a":1}').toString('base64url'),
  ])('refuses to go on from %j, which no page gave', async (after) => {
    const { invocation } = await harborLights();
    await expect(list(invocation, { after })).rejects.toMatchObject({
      issues: [{ path: '/after', code: 'invalid_cursor' }],
    });
  });
});

describe('who may change custom values', () => {
  it('is whoever has templates.manage: without it every command is refused and nothing changes', async () => {
    const owner = await inBusiness();
    const folder = await newFolder(owner, 'Links');
    const value = await create(owner, { name: 'Hours', value: '9 to 5' });
    // What configures fields does not configure what messages say.
    const reader: Invocation = { ...owner, permissions: new Set(['fields.manage']) };
    for (const attempt of [
      () => call('createCustomValue', reader, { name: 'Mine' }),
      () => save(reader, value, { value: 'Never' }),
      () => call('moveCustomValues', reader, { valueIds: [value.id], folderId: folder.id }),
      () => call('deleteCustomValue', reader, undefined, { valueId: value.id }),
      () => call('createCustomValueFolder', reader, { name: 'Mine' }),
      () =>
        call(
          'renameCustomValueFolder',
          reader,
          { name: 'Mine', revision: folder.revision },
          { folderId: folder.id },
        ),
      () => call('deleteCustomValueFolder', reader, undefined, { folderId: folder.id }),
    ]) {
      const refusal: unknown = await attempt().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ForbiddenError);
      expect(refusal).toMatchObject({ permission: 'templates.manage' });
    }
    // Reading is open to everyone in the business, who are told they may not manage.
    expect(await list(reader)).toEqual({ items: [value], total: 1, next: null, canManage: false });
    expect(customValueFolderList.parse(await call('listCustomValueFolders', reader))).toEqual({
      items: [folder],
      canManage: false,
      total: 1,
      next: null,
    });
    const manager: Invocation = { ...owner, permissions: new Set(['templates.manage']) };
    expect((await list(manager)).canManage).toBe(true);
    expect((await save(manager, value, { value: '8 to 6' })).value).toBe('8 to 6');
  });
});

describe('another business', () => {
  it('sees none of these values or folders and can’t change, move or delete them', async () => {
    const owner = await inBusiness();
    const other = await inBusiness();
    const folder = await newFolder(owner, 'Links');
    const value = await create(owner, { name: 'Hours', value: '9 to 5', folderId: folder.id });
    expect(await list(other)).toMatchObject({ items: [], total: 0 });
    expect(await foldersOf(other)).toEqual([]);
    for (const attempt of [
      () => save(other, value, { value: 'Taken' }),
      () => call('deleteCustomValue', other, undefined, { valueId: value.id }),
      () =>
        call(
          'renameCustomValueFolder',
          other,
          { name: 'Taken', revision: folder.revision },
          { folderId: folder.id },
        ),
      () => call('deleteCustomValueFolder', other, undefined, { folderId: folder.id }),
      // Not found comes before anything about the body: what is not theirs is not
      // described, not even by what a save of it would need.
      () => call('updateCustomValue', other, {}, { valueId: value.id }),
      () => call('renameCustomValueFolder', other, { name: '' }, { folderId: folder.id }),
    ])
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      call('moveCustomValues', other, { valueIds: [value.id], folderId: null }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await list(owner)).items).toEqual([value]);
    expect(await foldersOf(owner)).toEqual([{ ...folder, valueCount: 1 }]);
    const { businessId: _businessId, ...atAgency } = owner.context;
    for (const operation of ['listCustomValues', 'listCustomValueFolders'])
      await expect(call(operation, { ...owner, context: atAgency })).rejects.toBeInstanceOf(
        ValidationError,
      );
  });

  it('is not found by the commands themselves, with no route in front of them', async () => {
    const owner = await inBusiness();
    const other = await inBusiness();
    const folder = await newFolder(owner, 'Links');
    const value = await create(owner, { name: 'Hours', value: '9 to 5', folderId: folder.id });
    for (const attempt of [
      () =>
        runCommand(
          services,
          updateCustomValueCommand,
          {
            valueId: value.id,
            name: 'Taken',
            value: 'Taken',
            folderId: null,
            revision: value.revision,
          },
          other,
        ),
      () => runCommand(services, deleteCustomValueCommand, { valueId: value.id }, other),
      () =>
        runCommand(
          services,
          renameCustomValueFolderCommand,
          { folderId: folder.id, name: 'Taken', revision: folder.revision },
          other,
        ),
      () => runCommand(services, deleteCustomValueFolderCommand, { folderId: folder.id }, other),
    ])
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    expect((await list(owner)).items).toEqual([value]);
    expect(await foldersOf(owner)).toEqual([{ ...folder, valueCount: 1 }]);
    // Each attempt is on record as one that failed, and none holds the text that was sent.
    const audits = await auditsOf(other);
    expect(audits.map(({ command, outcome }) => [command, outcome])).toEqual([
      ['custom_value.update', 'failed'],
      ['custom_value.delete', 'failed'],
      ['custom_value_folder.rename', 'failed'],
      ['custom_value_folder.delete', 'failed'],
    ]);
    expect(audits[0]?.input).toMatchObject({ valueId: value.id, valueLength: 5 });
    expect(audits[0]?.input).not.toHaveProperty('value');
  });
});
