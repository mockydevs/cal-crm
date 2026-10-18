// The Companies list and the fields its table shows:
// a company's email, website, address and description, who made it, a total and a page
// size, the wider search, and the order of every column with its cursor. What a request
// without any of these gets is in companies.int.test.ts.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation } from '@repo/commands';
import {
  company,
  companyList,
  companySorts,
  recordActivity,
  type Company,
  type CompanySort,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { activityRoutes, createCrmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
// What the server's reader of people's names answers, for the people a test names.
const people = new Map<string, string>();
let routes: readonly ApiRoute[];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  routes = [
    ...createCrmRoutes({
      user: (_trx, ids) =>
        Promise.resolve(
          new Map(
            ids.flatMap((id) => {
              const name = people.get(id);
              return name === undefined ? [] : [[id, name] as const];
            }),
          ),
        ),
    }),
    ...activityRoutes({ actorNames: {} }),
  ];
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

/** A business, and its system acting in it. */
async function fixture(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}
/** A person acting in the same business, named unless `name` is left out. */
async function person(business: Invocation, name?: string): Promise<Invocation> {
  const user = await database.fixtures.user(name === undefined ? {} : { name });
  if (name !== undefined) people.set(user.id, name);
  return {
    context: { ...business.context, actorKind: 'user', actorId: user.id, userId: user.id },
    permissions: 'all',
  };
}

async function call(
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, { db, authorize: allowEveryone });
}
const create = async (invocation: Invocation, body: Record<string, unknown>) =>
  company.parse(await call('createCompany', invocation, body));
const update = async (invocation: Invocation, id: string, body: Record<string, unknown>) =>
  company.parse(await call('updateCompany', invocation, body, { id }));
const read = async (invocation: Invocation, id: string) =>
  company.parse(await call('getCompany', invocation, undefined, { id }));
const list = async (invocation: Invocation, query: Record<string, string> = {}) =>
  companyList.parse(await call('listCompanies', invocation, undefined, {}, query));
const names = async (invocation: Invocation, query: Record<string, string> = {}) =>
  (await list(invocation, query)).items.map((item) => item.name);

/** Every page of a list, read to its end by its cursors: the names, and the totals seen. */
async function pages(invocation: Invocation, query: Record<string, string>) {
  const found: string[][] = [];
  const totals = new Set<number | undefined>();
  let after: string | null = null;
  do {
    const page = await list(invocation, after === null ? query : { ...query, after });
    found.push(page.items.map((item) => item.name));
    totals.add(page.total);
    after = page.next;
    if (found.length > 50) throw new Error('The list does not end.');
  } while (after !== null);
  return { found, totals: [...totals] };
}

const everything = {
  name: 'Acme Events',
  domain: 'acme.example',
  phone: '+254712345678',
  email: ' Hello@Acme.Example ',
  website: ' www.acme.example/about ',
  address: ' 12 Riverside Drive ',
  city: 'Nairobi',
  state: 'Nairobi County',
  postalCode: '00100',
  country: 'ke',
  description: ' Plans weddings.\nAnd conferences. ',
};
const shown = {
  name: 'Acme Events',
  domain: 'acme.example',
  phone: '+254712345678',
  email: 'hello@acme.example',
  website: 'www.acme.example/about',
  address: '12 Riverside Drive',
  city: 'Nairobi',
  state: 'Nairobi County',
  postalCode: '00100',
  country: 'KE',
  description: 'Plans weddings.\nAnd conferences.',
};
const none = {
  email: null,
  website: null,
  address: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  description: null,
};

it('keeps every field of a company, each empty until given, and reads them back', async () => {
  const invocation = await fixture();
  const bare = await create(invocation, { name: 'Bare' });
  expect(bare).toMatchObject({ name: 'Bare', domain: null, phone: null, ...none });
  const blank = await create(invocation, {
    name: 'Blank',
    email: '',
    website: '  ',
    address: '',
    city: ' ',
    state: '',
    postalCode: '',
    country: '',
    description: '\n',
  });
  expect(blank).toMatchObject(none);

  const made = await create(invocation, everything);
  expect(made).toMatchObject(shown);
  expect(await read(invocation, made.id)).toEqual(made);
  expect((await list(invocation)).items[0]).toEqual(made);
});

it('changes each field by itself, removes it with null or a blank, and says what changed', async () => {
  const invocation = await fixture();
  const made = await create(invocation, everything);
  // Nothing named, and the same values again: nothing changes, and no event says so.
  expect(await update(invocation, made.id, {})).toEqual(made);
  expect(await update(invocation, made.id, { ...everything })).toEqual(made);

  const changed = await update(invocation, made.id, {
    email: 'Sales@Acme.Example',
    city: 'Mombasa',
  });
  expect(changed).toMatchObject({ ...shown, email: 'sales@acme.example', city: 'Mombasa' });
  const cleared = await update(invocation, made.id, {
    email: null,
    website: '',
    address: null,
    city: ' ',
    state: null,
    postalCode: '',
    country: null,
    description: '',
  });
  expect(cleared).toMatchObject({ name: 'Acme Events', domain: 'acme.example', ...none });
  expect(await update(invocation, made.id, { website: 'https://acme.example' })).toMatchObject({
    ...none,
    website: 'https://acme.example',
  });

  const history = recordActivity.parse(
    await call('listRecordActivity', invocation, undefined, { id: made.id }),
  );
  expect(history.items.map((item) => [item.type, item.payload['changed']])).toEqual([
    ['company.updated', ['website']],
    [
      'company.updated',
      ['email', 'website', 'address', 'city', 'state', 'postalCode', 'country', 'description'],
    ],
    ['company.updated', ['email', 'city']],
    ['company.created', undefined],
  ]);
});

it('says who made a company: their name, whether it is the reader, and nothing for the nameless', async () => {
  const system = await fixture();
  const dana = await person(system, 'Dana Brooks');
  const jordan = await person(system, 'Jordan Lee');
  const stranger = await person(system);

  const hers = await create(dana, { name: 'Hers' });
  expect(hers.createdBy).toEqual({ kind: 'user', name: 'Dana Brooks', you: true });
  expect((await read(jordan, hers.id)).createdBy).toEqual({
    kind: 'user',
    name: 'Dana Brooks',
    you: false,
  });
  expect((await update(jordan, hers.id, { city: 'Nakuru' })).createdBy).toEqual({
    kind: 'user',
    name: 'Dana Brooks',
    you: false,
  });
  const trashed = company.parse(await call('trashCompany', dana, undefined, { id: hers.id }));
  expect(trashed.createdBy).toEqual({ kind: 'user', name: 'Dana Brooks', you: true });
  await call('restoreCompany', dana, undefined, { id: hers.id });

  const unnamed = await create(stranger, { name: 'Unnamed' });
  expect(unnamed.createdBy).toEqual({ kind: 'user', name: null, you: true });
  const systems = await create(system, { name: 'Systems' });
  expect(systems.createdBy).toEqual({ kind: 'system', name: null, you: false });

  const listed = await list(jordan);
  expect(listed.items.map((item) => [item.name, item.createdBy])).toEqual([
    ['Systems', { kind: 'system', name: null, you: false }],
    ['Unnamed', { kind: 'user', name: null, you: false }],
    ['Hers', { kind: 'user', name: 'Dana Brooks', you: false }],
  ]);

  // By the name shown, without regard to case; the nameless last, both ways.
  people.set(jordan.context.userId ?? '', 'alex Kim');
  await create(jordan, { name: 'His' });
  expect(await names(dana, { sort: 'createdBy' })).toEqual(['His', 'Hers', 'Unnamed', 'Systems']);
  expect(await names(dana, { sort: 'createdBy', direction: 'desc' })).toEqual([
    'Hers',
    'His',
    'Systems',
    'Unnamed',
  ]);
  for (const limit of ['1', '2', '3']) {
    expect((await pages(dana, { sort: 'createdBy', limit })).found.flat()).toEqual([
      'His',
      'Hers',
      'Unnamed',
      'Systems',
    ]);
    expect(
      (await pages(dana, { sort: 'createdBy', direction: 'desc', limit })).found.flat(),
    ).toEqual(['Hers', 'His', 'Systems', 'Unnamed']);
  }
});

it('counts the companies that match and pages them at the size asked for', async () => {
  const invocation = await fixture();
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five'])
    await create(invocation, { name, ...(name === 'Four' ? {} : { city: 'Kisumu' }) });
  const whole = await list(invocation);
  expect(whole.total).toBe(5);
  expect(whole.items).toHaveLength(5);
  expect(whole.next).toBeNull();

  const first = await list(invocation, { limit: '2' });
  expect(first.items.map((item) => item.name)).toEqual(['Five', 'Four']);
  expect(first.total).toBe(5);
  expect(first.next).toBe(first.items[1]?.id);
  for (const limit of ['1', '2', '3', '5']) {
    const { found, totals } = await pages(invocation, { limit });
    expect(found.flat()).toEqual(['Five', 'Four', 'Three', 'Two', 'One']);
    expect(totals).toEqual([5]);
  }
  // A search narrows the total; a company in the trash is in neither.
  expect((await list(invocation, { q: 't', limit: '1' })).total).toBe(2);
  await call('trashCompany', invocation, undefined, { id: whole.items[0]?.id ?? '' });
  expect((await list(invocation)).total).toBe(4);
  expect((await list(invocation, { sort: 'name' })).total).toBe(4);
  // Another business's companies are not counted.
  expect((await list(await fixture())).total).toBe(0);
});

it('finds companies by any part of their name, email, phone, website or domain', async () => {
  const invocation = await fixture();
  await create(invocation, { name: 'Acme', email: 'hello@acme-mail.example' });
  await create(invocation, { name: 'Borealis', phone: '+254 712 345 678' });
  await create(invocation, { name: 'Cobalt', website: 'www.cobalt-site.example/50%_off' });
  await create(invocation, { name: 'Dune', domain: 'dune-domain.example' });
  await create(invocation, { name: 'Ember', city: 'acme-mail' });

  expect(await names(invocation, { q: 'ACME-MAIL' })).toEqual(['Acme']);
  expect(await names(invocation, { q: 'cobalt-SITE' })).toEqual(['Cobalt']);
  expect(await names(invocation, { q: 'dune-domain' })).toEqual(['Dune']);
  expect(await names(invocation, { q: 'boreal' })).toEqual(['Borealis']);
  // A number as stored, and as it is dialled at home.
  expect(await names(invocation, { q: '+254712' })).toEqual(['Borealis']);
  expect(await names(invocation, { q: '0712 345' })).toEqual(['Borealis']);
  expect(await names(invocation, { q: '(0712) 345-678' })).toEqual(['Borealis']);
  expect(await names(invocation, { q: '0799' })).toEqual([]);
  // % and _ as written.
  expect(await names(invocation, { q: '50%_off' })).toEqual(['Cobalt']);
  expect(await names(invocation, { q: '50%xoff' })).toEqual([]);
  expect(await names(invocation, { q: '5_%' })).toEqual([]);
  // With an order, and counted.
  const found = await list(invocation, { q: 'e', sort: 'name', direction: 'desc' });
  expect(found.items.map((item) => item.name)).toEqual([
    'Ember',
    'Dune',
    'Cobalt',
    'Borealis',
    'Acme',
  ]);
  expect(found.total).toBe(5);
});

// Six companies whose every column orders them differently, with values that differ only
// in case (ties) and companies without a value in each column.
const TABLE: readonly Record<string, string | null>[] = [
  {
    name: 'delta',
    phone: '+254712000003',
    email: 'c@mail.example',
    website: 'www.b.example',
    address: 'east road',
    state: null,
    city: 'Athi',
    description: 'two',
    postalCode: '00300',
    country: 'UG',
  },
  {
    name: 'Alpha',
    phone: null,
    email: 'a@mail.example',
    website: 'WWW.B.example',
    address: null,
    state: 'coast',
    city: 'athi',
    description: null,
    postalCode: '00100',
    country: 'KE',
  },
  {
    name: 'charlie',
    phone: '+254712000001',
    email: null,
    website: null,
    address: 'East Road',
    state: 'Coast',
    city: null,
    description: 'One',
    postalCode: null,
    country: 'KE',
  },
  {
    name: 'Bravo',
    phone: '+254712000002',
    email: 'b@mail.example',
    website: 'www.a.example',
    address: 'north road',
    state: 'rift',
    city: 'Busia',
    description: 'one',
    postalCode: '00200',
    country: null,
  },
  {
    name: 'echo',
    phone: null,
    email: null,
    website: null,
    address: null,
    state: null,
    city: null,
    description: null,
    postalCode: null,
    country: null,
  },
  {
    name: 'Foxtrot',
    phone: '+254712000004',
    email: 'B@mail.example',
    website: 'www.c.example',
    address: 'a road',
    state: 'Rift',
    city: 'busia',
    description: 'three',
    postalCode: '00200',
    country: 'TZ',
  },
];

/** The table's names in an order: by a column without regard to case, the empty last. */
function expected(
  rows: readonly { readonly name: string; readonly key: string | null }[],
  direction: 'asc' | 'desc',
): string[] {
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ ...row, index }))
    .sort((left, right) => {
      if (left.key === null || right.key === null) {
        if (left.key === right.key) return sign * (left.index - right.index);
        return left.key === null ? 1 : -1;
      }
      if (left.key < right.key) return -sign;
      if (left.key > right.key) return sign;
      // A tie is in the order of the ids, which is the order the companies were made in.
      return sign * (left.index - right.index);
    })
    .map((row) => row.name);
}

it('orders by every column both ways, the empty last, and pages each order to its end', async () => {
  const invocation = await fixture();
  const made: Company[] = [];
  for (const row of TABLE) made.push(await create(invocation, row));
  // Changed out of the order they were made in, so the last change is an order of its own.
  for (const index of [3, 0, 5, 1])
    await update(invocation, made[index]?.id ?? '', { domain: `row-${String(index)}.example` });
  await update(invocation, made[4]?.id ?? '', { name: 'Echo' });
  await update(invocation, made[2]?.id ?? '', { name: 'Charlie' });
  const table = TABLE.map((row, index) =>
    index === 4 ? { ...row, name: 'Echo' } : index === 2 ? { ...row, name: 'Charlie' } : row,
  );
  // The two times as the database holds them, to the microsecond.
  const times = await database.withTenant(invocation.context, (sql) =>
    sql.query<{ id: string; created: string; updated: string }>(
      `select id, to_char(created_at at time zone 'utc', 'YYYYMMDDHH24MISSUS') as created,
              to_char(updated_at at time zone 'utc', 'YYYYMMDDHH24MISSUS') as updated
         from crm.companies`,
    ),
  );
  const timeOf = (index: number, which: 'created' | 'updated'): string => {
    const uuid = parsePublicId('company', made[index]?.id ?? '');
    const row = times.find((each) => each.id === uuid);
    if (row === undefined) throw new Error('A company has no row.');
    return row[which];
  };
  const keyOf = (sort: CompanySort, index: number): string | null => {
    if (sort === 'created' || sort === 'updated') return timeOf(index, sort);
    if (sort === 'createdBy') return null;
    return table[index]?.[sort]?.toLowerCase() ?? null;
  };

  for (const sort of companySorts) {
    const rows = table.map((row, index) => ({ name: row['name'] ?? '', key: keyOf(sort, index) }));
    for (const direction of ['asc', 'desc'] as const) {
      const order = expected(rows, direction);
      expect(await names(invocation, { sort, direction }), `${sort} ${direction}`).toEqual(order);
      for (const limit of ['1', '2', '3']) {
        const { found, totals } = await pages(invocation, { sort, direction, limit });
        expect(found.flat(), `${sort} ${direction} by ${limit}`).toEqual(order);
        expect(totals).toEqual([6]);
      }
    }
  }
  // Without a direction: the two times newest first, the rest from A.
  expect(await names(invocation, { sort: 'name' })).toEqual([
    'Alpha',
    'Bravo',
    'Charlie',
    'delta',
    'Echo',
    'Foxtrot',
  ]);
  expect(await names(invocation, { sort: 'created' })).toEqual(
    table.map((row) => row['name']).toReversed(),
  );
  expect(await names(invocation, { sort: 'updated' })).toEqual(
    expected(
      table.map((row, index) => ({ name: row['name'] ?? '', key: timeOf(index, 'updated') })),
      'desc',
    ),
  );
});

it('pages the created and updated orders at microsecond precision', async () => {
  const invocation = await fixture();
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) await create(invocation, { name });
  // Five companies made within five microseconds, in the opposite order to their ids.
  await database.as('crm_owner', (sql) =>
    sql.query(
      `update crm.companies c set created_at = '2031-05-01T12:00:00Z'::timestamptz
              - n.place * interval '1 microsecond'
         from (select id, row_number() over (order by id) as place from crm.companies
                where business_id = $1) n
        where c.id = n.id and c.business_id = $1`,
      [invocation.context.businessId],
    ),
  );
  const oldestFirst = ['Five', 'Four', 'Three', 'Two', 'One'];
  for (const limit of ['1', '2']) {
    expect(
      (await pages(invocation, { sort: 'created', direction: 'asc', limit })).found.flat(),
    ).toEqual(oldestFirst);
    expect((await pages(invocation, { sort: 'created', limit })).found.flat()).toEqual(
      oldestFirst.toReversed(),
    );
  }
});

it('refuses a cursor from another business under every order, and reads on from a company since trashed', async () => {
  const invocation = await fixture();
  for (const name of ['One', 'Two', 'Three']) await create(invocation, { name });
  const foreign = await create(await fixture(), { name: 'Private' });
  for (const sort of companySorts)
    await expect(list(invocation, { sort, after: foreign.id }), sort).rejects.toBeInstanceOf(
      ValidationError,
    );
  await expect(list(invocation, { after: foreign.id })).rejects.toBeInstanceOf(ValidationError);
  await expect(
    list(invocation, { sort: 'name', after: 'com_01h455vb4pex5vsknk084sn02q' }),
  ).rejects.toBeInstanceOf(ValidationError);

  // The company a page ended on is still a place to read on from after it went to trash.
  const first = await list(invocation, { sort: 'name', limit: '1' });
  expect(first.items.map((item) => item.name)).toEqual(['One']);
  await call('trashCompany', invocation, undefined, { id: first.next ?? '' });
  expect(await names(invocation, { sort: 'name', after: first.next ?? '' })).toEqual([
    'Three',
    'Two',
  ]);
});
