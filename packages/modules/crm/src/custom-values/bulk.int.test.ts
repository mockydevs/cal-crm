// Bulk actions on custom values, and moving them between folders, through the CRM's own
// routes, against a migrated Postgres: one value read by id, several deleted at once, and
// the folder list searched, filtered and paged.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  CUSTOM_VALUE_LIMITS,
  customValue,
  customValueFolder,
  customValueFolderList,
  customValueList,
  type CustomValue,
  type CustomValueFolder,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { crmRoutes } from '../index.js';

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
const failure = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );
const create = async (invocation: Invocation, name: string, value = ''): Promise<CustomValue> =>
  customValue.parse(await call('createCustomValue', invocation, { name, value }));
const namesOf = async (invocation: Invocation): Promise<string[]> =>
  customValueList.parse(await call('listCustomValues', invocation)).items.map((each) => each.name);
const newFolder = async (invocation: Invocation, name: string): Promise<CustomValueFolder> =>
  customValueFolder.parse(await call('createCustomValueFolder', invocation, { name }));
const folders = async (invocation: Invocation, query: Record<string, string> = {}) =>
  customValueFolderList.parse(
    await call('listCustomValueFolders', invocation, undefined, {}, query),
  );
const again = (invocation: Invocation): Invocation => ({
  ...invocation,
  context: { ...invocation.context, correlationId: randomUUID() },
});

/** Runs a statement in a transaction that stays open until the function it gives back is called. */
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

describe('one custom value', () => {
  it('is read by its id as the list shows it, by anyone in the business', async () => {
    const invocation = await inBusiness();
    const folder = await newFolder(invocation, 'Hours');
    const made = customValue.parse(
      await call('createCustomValue', invocation, {
        name: 'Hours of operation',
        value: 'Mon to Fri, 9 to 5',
        folderId: folder.id,
      }),
    );
    const read = customValue.parse(
      await call('getCustomValue', invocation, undefined, { valueId: made.id }),
    );
    expect(read).toEqual(made);
    expect(read).toMatchObject({
      folderName: 'Hours',
      mergeKey: 'custom_values.hours_of_operation',
    });
    const reader: Invocation = { ...invocation, permissions: new Set() };
    expect(await call('getCustomValue', reader, undefined, { valueId: made.id })).toEqual(made);
  });

  it('is not found in another business, when deleted, or by an id that is no value’s', async () => {
    const owner = await inBusiness();
    const other = await inBusiness();
    const made = await create(owner, 'Hours');
    for (const [who, valueId] of [
      [other, made.id],
      [owner, toPublicId('custom_value', '0199c7e2-0000-7000-8000-00000000000e')],
    ] as const)
      expect(await failure(call('getCustomValue', who, undefined, { valueId }))).toBeInstanceOf(
        NotFoundError,
      );
    expect(
      await failure(call('getCustomValue', owner, undefined, { valueId: 'not-an-id' })),
    ).toBeInstanceOf(ValidationError);
    await call('deleteCustomValue', owner, undefined, { valueId: made.id });
    expect(
      await failure(call('getCustomValue', owner, undefined, { valueId: made.id })),
    ).toBeInstanceOf(NotFoundError);
  });
});

describe('deleting several custom values', () => {
  it('deletes every one named and no other, with an event for each and no text in the audit log', async () => {
    const invocation = await inBusiness();
    const a = await create(invocation, 'Address', '12 Harbour Road');
    const b = await create(invocation, 'Booking link', 'https://book.example.test');
    await create(invocation, 'Kept', 'Still here');
    const acting = again(invocation);

    expect(await call('deleteCustomValues', acting, { valueIds: [b.id, a.id] })).toEqual({
      deleted: 2,
    });

    expect(await namesOf(invocation)).toEqual(['Kept']);
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; subject_id: string; payload: Record<string, unknown> }>(
        `select type, subject_id, payload from events.events
         where correlation_id = $1 order by id`,
        [acting.context.correlationId],
      ),
    );
    // In id order, the order they are held in.
    expect(events).toEqual([
      {
        type: 'custom_value.deleted',
        subject_id: parsePublicId('custom_value', a.id),
        payload: { key: 'address', name: 'Address' },
      },
      {
        type: 'custom_value.deleted',
        subject_id: parsePublicId('custom_value', b.id),
        payload: { key: 'booking_link', name: 'Booking link' },
      },
    ]);
    const audits = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string; input: Record<string, unknown> }>(
        'select command, outcome, input from audit.commands where correlation_id = $1',
        [acting.context.correlationId],
      ),
    );
    expect(audits).toEqual([
      { command: 'custom_value.delete_many', outcome: 'ok', input: { valueIds: [b.id, a.id] } },
    ]);
    expect(JSON.stringify(audits)).not.toContain('Harbour');
  });

  it('deletes all of them or none: another business’s value, or one already gone, stops it', async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const a = await create(invocation, 'Address');
    const b = await create(invocation, 'Booking link');
    const theirs = await create(other, 'Theirs');
    const gone = await create(invocation, 'Gone');
    await call('deleteCustomValue', invocation, undefined, { valueId: gone.id });
    for (const valueIds of [[a.id, theirs.id], [a.id, b.id, gone.id], [theirs.id]]) {
      const refusal = await failure(call('deleteCustomValues', invocation, { valueIds }));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal).toMatchObject({ issues: [{ path: '/valueIds', code: 'invalid_value' }] });
    }
    for (const valueIds of [
      [],
      [a.id, a.id],
      Array.from({ length: CUSTOM_VALUE_LIMITS.move + 1 }, () => a.id),
      ['not-an-id'],
    ])
      expect(await failure(call('deleteCustomValues', invocation, { valueIds }))).toBeInstanceOf(
        ValidationError,
      );
    expect(await namesOf(invocation)).toEqual(['Address', 'Booking link']);
    expect(await namesOf(other)).toEqual(['Theirs']);
  });

  it('needs templates.manage', async () => {
    const invocation = await inBusiness();
    const a = await create(invocation, 'Address');
    const reader: Invocation = { ...invocation, permissions: new Set(['fields.manage']) };
    const refusal = await failure(call('deleteCustomValues', reader, { valueIds: [a.id] }));
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect(refusal).toMatchObject({ permission: 'templates.manage' });
    expect(await namesOf(invocation)).toEqual(['Address']);
  });

  it('deletes a value once when two requests name it at the same moment', async () => {
    const invocation = await inBusiness();
    const a = await create(invocation, 'Address');
    const b = await create(invocation, 'Booking link');
    const c = await create(invocation, 'Closing time');
    // Both wait behind a transaction that holds the value they share.
    const release = await hold('select 1 from crm.custom_values where id = $1 for update', [
      parsePublicId('custom_value', a.id),
    ]);
    const work = Promise.allSettled([
      call('deleteCustomValues', again(invocation), { valueIds: [a.id, b.id] }),
      call('deleteCustomValues', again(invocation), { valueIds: [a.id, c.id] }),
    ]);
    try {
      await lockWaits(2);
    } finally {
      await release();
    }
    const outcomes = await work;
    const won = outcomes.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : []));
    const lost = outcomes.flatMap((each): unknown[] =>
      each.status === 'rejected' ? [each.reason] : [],
    );
    expect(won).toEqual([{ deleted: 2 }]);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(ValidationError);
    // The request that lost deleted nothing: the value only it named is still there.
    const left = await namesOf(invocation);
    expect(left).toHaveLength(1);
    expect(['Booking link', 'Closing time']).toContain(left[0]);
  });
});

describe('the list of custom value folders', () => {
  it('answers every folder with how many there are when no limit is asked for', async () => {
    const invocation = await inBusiness();
    const b = await newFolder(invocation, 'beta');
    const a = await newFolder(invocation, 'Alpha');
    expect(await folders(invocation)).toEqual({
      items: [a, b],
      canManage: true,
      total: 2,
      next: null,
    });
  });

  it('is searched by any part of a name, with % and _ as themselves, and filtered by when a folder was made', async () => {
    const invocation = await inBusiness();
    for (const name of ['Opening hours', 'Hours 100%', 'After_hours', 'After hours', 'Links'])
      await newFolder(invocation, name);
    const names = async (query: Record<string, string>): Promise<string[]> =>
      (await folders(invocation, query)).items.map((folder) => folder.name);
    expect(await names({ q: 'HOURS' })).toEqual([
      'After hours',
      'After_hours',
      'Hours 100%',
      'Opening hours',
    ]);
    expect(await names({ q: '100%' })).toEqual(['Hours 100%']);
    expect(await names({ q: '%' })).toEqual(['Hours 100%']);
    expect(await names({ q: 'after_' })).toEqual(['After_hours']);
    expect(await names({ q: 'nothing like it' })).toEqual([]);

    await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.custom_value_folders set created_at = case name
           when 'Links' then '2026-03-01T00:00:00.000001Z'::timestamptz
           when 'Opening hours' then '2026-03-02T00:00:00Z'
           else '2026-01-01T00:00:00Z' end
         where business_id = $1`,
        [invocation.context.businessId],
      ),
    );
    expect(await names({ createdFrom: '2026-03-01T00:00:00.000001Z' })).toEqual([
      'Links',
      'Opening hours',
    ]);
    expect(await names({ createdFrom: '2026-03-01T00:00:00.000002Z' })).toEqual(['Opening hours']);
    expect(
      await names({ createdFrom: '2026-02-01T00:00:00Z', createdBefore: '2026-03-02T00:00:00Z' }),
    ).toEqual(['Links']);
    const counted = await folders(invocation, {
      q: 'hours',
      createdBefore: '2026-02-01T00:00:00Z',
    });
    expect(counted.total).toBe(3);
  });

  it('is paged by name, each folder once, whatever is made, renamed or deleted meanwhile', async () => {
    const invocation = await inBusiness();
    const made = new Map<string, CustomValueFolder>();
    for (const name of ['delta', 'Alpha', 'charlie', 'Bravo', 'echo'])
      made.set(name, await newFolder(invocation, name));
    const walk = async (during?: () => Promise<unknown>): Promise<string[]> => {
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await folders(invocation, {
          limit: '2',
          ...(after === undefined ? {} : { after }),
        });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((folder) => folder.name));
        after = page.next ?? undefined;
        if (seen.length === 2) await during?.();
      } while (after !== undefined);
      return seen;
    };
    expect(await walk()).toEqual(['Alpha', 'Bravo', 'charlie', 'delta', 'echo']);
    expect((await folders(invocation, { limit: '2' })).total).toBe(5);
    // After the first page: one made before the place reached and one after it, and the
    // folder the page ended on deleted. The walk goes on from where it was.
    expect(
      await walk(async () => {
        await newFolder(invocation, 'Aardvark');
        await newFolder(invocation, 'dingo');
        await call('deleteCustomValueFolder', invocation, undefined, {
          folderId: made.get('Bravo')?.id ?? '',
        });
      }),
    ).toEqual(['Alpha', 'Bravo', 'charlie', 'delta', 'dingo', 'echo']);
  });

  it('refuses a place no page gave, and a limit outside 1 to 100', async () => {
    const invocation = await inBusiness();
    await newFolder(invocation, 'Alpha');
    for (const query of [
      { limit: '2', after: 'WyJhIiwibm90LWEtdXVpZCJd' },
      { limit: '2', after: 'not a cursor' },
      { limit: '0' },
      { limit: String(CUSTOM_VALUE_LIMITS.page + 1) },
      { createdFrom: '2026-03-01' },
    ])
      expect(await failure(folders(invocation, query))).toBeInstanceOf(ValidationError);
  });
});
