// The contact list's orders, page size, a contact's neighbours and custom fields as
// columns, against a migrated Postgres as crm_app under row-level security.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  contactList,
  contactNeighbours,
  fieldDefinition,
  recordFields,
  type ContactList,
  type ContactNeighbours,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { team, type Team } from '../../test/contact-details.js';
import { seedContacts } from '../../test/contacts.js';
import { createCrmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let t: Team;
let invocation: Invocation;
const routes = createCrmRoutes();

function route(operationId: string) {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`Missing ${operationId}`);
  return found;
}

const create = async (as: Invocation, body: unknown): Promise<string> =>
  (
    (await route('createContact').run(
      { invocation: as, params: {}, query: {}, body },
      services,
    )) as {
      id: string;
    }
  ).id;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  t = await team(database);
  invocation = t.system();
  // 60 named contacts, three without a name and two who share one: every tie an order has.
  await seedContacts(database, t.businessId, 60);
  for (const email of ['x@example.com', 'y@example.com', 'z@example.com'])
    await create(invocation, { emails: [email] });
  await create(invocation, { firstName: 'Sam', lastName: 'Same', emails: ['sam1@example.com'] });
  await create(invocation, { firstName: 'Sam', lastName: 'Same', emails: ['sam2@example.com'] });
}, 180_000);

afterAll(async () => {
  await db.destroy();
  await database.close();
});

const list = async (query: Record<string, string> = {}, as: Invocation = invocation) =>
  contactList.parse(
    await route('listContacts').run(
      { invocation: as, params: {}, query, body: undefined },
      services,
    ),
  );

const neighbours = async (
  id: string,
  query: Record<string, string> = {},
  as: Invocation = invocation,
): Promise<ContactNeighbours> =>
  contactNeighbours.parse(
    await route('getContactNeighbours').run(
      { invocation: as, params: { id }, query, body: undefined },
      services,
    ),
  );

/** Every page, following next. */
async function everyPage(query: Record<string, string>): Promise<ContactList['items']> {
  const items: ContactList['items'] = [];
  let after: string | null = null;
  do {
    const page = await list(after === null ? query : { ...query, after });
    expect(page.items.length).toBeLessThanOrEqual(Number(query['limit'] ?? 50));
    items.push(...page.items);
    after = page.next;
  } while (after !== null);
  return items;
}

const TOTAL = 65;
const ORDERS = [
  { sort: 'newest' },
  { sort: 'newest', direction: 'asc' },
  { sort: 'name' },
  { sort: 'name', direction: 'desc' },
  { sort: 'updated' },
  { sort: 'updated', direction: 'asc' },
] as const;

describe('the order of the list', () => {
  it('runs either way by when a contact was added', async () => {
    const newest = await everyPage({ limit: '100' });
    const oldest = await everyPage({ limit: '100', direction: 'asc' });
    expect(newest).toHaveLength(TOTAL);
    expect(oldest.map((item) => item.id)).toEqual(newest.map((item) => item.id).reverse());
    expect(newest.map((item) => item.createdAt)).toEqual(
      [...newest.map((item) => item.createdAt)].sort().reverse(),
    );
    // Said outright, the default is what it always was.
    expect(await everyPage({ limit: '100', sort: 'newest', direction: 'desc' })).toEqual(newest);
  });

  it('runs either way by name, with the unnamed last both times', async () => {
    const fromA = await everyPage({ limit: '100', sort: 'name' });
    const fromZ = await everyPage({ limit: '100', sort: 'name', direction: 'desc' });
    const named = (items: ContactList['items']) => items.filter((item) => item.name !== null);
    expect(fromA.slice(-3).map((item) => item.name)).toEqual([null, null, null]);
    expect(fromZ.slice(-3).map((item) => item.name)).toEqual([null, null, null]);
    expect(named(fromZ).map((item) => item.id)).toEqual(
      named(fromA)
        .map((item) => item.id)
        .reverse(),
    );
    expect(named(fromA)).toHaveLength(TOTAL - 3);
    expect(named(fromA).at(-1)?.name).toBe('Sam Same');
    expect(named(fromZ)[0]?.name).toBe('Sam Same');
    // The unnamed keep one order, by id, whichever way the names run.
    expect(fromZ.slice(-3)).toEqual(fromA.slice(-3));
  });

  it('runs by the last change, either way', async () => {
    const [first] = (await list({ sort: 'name' })).items;
    if (first === undefined) throw new Error('No contact.');
    await route('updateContact').run(
      { invocation, params: { id: first.id }, query: {}, body: { lastName: 'Changed' } },
      services,
    );
    const latest = await everyPage({ limit: '100', sort: 'updated' });
    const earliest = await everyPage({ limit: '100', sort: 'updated', direction: 'asc' });
    expect(latest[0]?.id).toBe(first.id);
    expect(earliest.at(-1)?.id).toBe(first.id);
    expect(earliest.map((item) => item.id)).toEqual(latest.map((item) => item.id).reverse());
  });

  it.for(ORDERS)(
    'pages %o to its end at any page size, without a gap or a repeat',
    async (order) => {
      const whole = await everyPage({ ...order, limit: '100' });
      expect(new Set(whole.map((item) => item.id)).size).toBe(TOTAL);
      for (const limit of ['1', '7', '20', '64', '65']) {
        if (limit === '1' && order.sort !== 'name') continue;
        expect((await everyPage({ ...order, limit })).map((item) => item.id)).toEqual(
          whole.map((item) => item.id),
        );
      }
    },
  );

  it('holds 50 contacts a page unless told, and from 1 to 100', async () => {
    expect((await list()).items).toHaveLength(50);
    expect((await list({ limit: '20' })).items).toHaveLength(20);
    expect((await list({ limit: '100' })).next).toBeNull();
    for (const limit of ['0', '101', 'many', '2.5'])
      await expect(list({ limit })).rejects.toBeInstanceOf(ValidationError);
    // A direction belongs to a built-in order: a field has its own.
    await expect(list({ direction: 'sideways' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("a contact's neighbours", () => {
  it.for(ORDERS)('are the contacts before and after it in %o, with its place', async (order) => {
    const whole = await everyPage({ ...order, limit: '100' });
    for (const index of [0, 1, 31, 59, 60, 61, 62, 63, 64]) {
      const item = whole[index];
      if (item === undefined) throw new Error('No contact there.');
      expect(await neighbours(item.id, order), `at ${String(index)}`).toEqual({
        inList: true,
        previous: index === 0 ? null : { id: whole[index - 1]?.id, name: whole[index - 1]?.name },
        next:
          index === TOTAL - 1 ? null : { id: whole[index + 1]?.id, name: whole[index + 1]?.name },
        position: index + 1,
      });
    }
  });

  it('are those of the searched and filtered list, not of the whole', async () => {
    const filter = JSON.stringify({
      match: 'all',
      groups: [
        { match: 'all', conditions: [{ field: 'lastName', operator: 'contains', value: 'last2' }] },
      ],
    });
    // Last2 and Last20 to Last29: eleven contacts.
    const whole = await everyPage({ filter, sort: 'name', limit: '100' });
    expect(whole).toHaveLength(11);
    const [first, second, third] = whole;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error('Too few.');
    expect(await neighbours(second.id, { filter, sort: 'name' })).toEqual({
      inList: true,
      previous: { id: first.id, name: first.name },
      next: { id: third.id, name: third.name },
      position: 2,
    });
    const searched = await everyPage({ q: 'sam', limit: '100' });
    expect(searched).toHaveLength(2);
    expect(await neighbours(searched[1]?.id ?? '', { q: 'sam' })).toMatchObject({
      previous: { id: searched[0]?.id },
      next: null,
      position: 2,
    });
  });

  it('are nothing for a contact the list does not hold', async () => {
    const nowhere = { inList: false, previous: null, next: null, position: null };
    const [any] = (await list()).items;
    if (any === undefined) throw new Error('No contact.');
    // A filter that no longer keeps it.
    expect(await neighbours(any.id, { q: 'nobody-here' })).toEqual(nowhere);
    // In the trash.
    const gone = await create(invocation, { firstName: 'Gone', lastName: 'Away' });
    await route('trashContact').run(
      { invocation, params: { id: gone }, query: {}, body: undefined },
      services,
    );
    expect(await neighbours(gone)).toEqual(nowhere);
  });

  it('are not found for a contact of another business, or one that never was', async () => {
    const [any] = (await list()).items;
    if (any === undefined) throw new Error('No contact.');
    const other = await team(database);
    const theirs = await create(other.system(), { firstName: 'Their', lastName: 'Contact' });
    await expect(neighbours(theirs)).rejects.toBeInstanceOf(NotFoundError);
    await expect(neighbours(any.id, {}, other.system())).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      neighbours(toPublicId('contact', '01890a5d-ac96-774b-bcce-b302099a8057')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('custom fields as columns', () => {
  async function field(key: string, valueType: string, options: string[] = []): Promise<string> {
    return fieldDefinition.parse(
      await route('createField').run(
        {
          invocation,
          params: {},
          query: {},
          body: {
            objectKey: 'contact',
            key,
            label: key,
            description: 'What it means.',
            valueType,
            options: options.map((option) => ({
              key: option,
              label: option,
              description: '',
              archived: false,
            })),
            currency: valueType === 'money' ? 'KES' : null,
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
          },
        },
        services,
      ),
    ).id;
  }
  async function value(contact: string, fieldId: string, to: unknown): Promise<void> {
    const before = recordFields.parse(
      await route('getRecordFields').run(
        { invocation, params: { id: contact }, query: {}, body: undefined },
        services,
      ),
    );
    const revision = before.items.find((item) => item.definition.id === fieldId)?.revision;
    await route('setRecordField').run(
      { invocation, params: { id: contact, fieldId }, query: {}, body: { value: to, revision } },
      services,
    );
  }

  it('puts the values of the fields asked for on each row, and nothing else', async () => {
    const ids = {
      city: await field('city', 'text'),
      budget: await field('budget', 'money'),
      renewal: await field('renewal', 'date'),
      seen: await field('seen', 'datetime'),
      signed: await field('signed', 'boolean'),
      plan: await field('plan', 'single_choice', ['gold', 'silver']),
      likes: await field('likes', 'multi_choice', ['tea', 'coffee']),
      secret: await field('secret', 'text'),
    };
    const page = await list({ q: 'sam', sort: 'updated', direction: 'asc' });
    const [one, two] = page.items.map((item) => item.id);
    if (one === undefined || two === undefined) throw new Error('Too few.');
    await value(one, ids.city, 'Nairobi');
    await value(one, ids.budget, '1250.50');
    await value(one, ids.renewal, '2026-12-01');
    await value(one, ids.seen, '2026-10-01T08:00:00.000Z');
    await value(one, ids.signed, true);
    await value(one, ids.plan, 'gold');
    await value(one, ids.likes, ['tea', 'coffee']);
    await value(one, ids.secret, 'Not asked for');

    const asked = [ids.city, ids.budget, ids.renewal, ids.seen, ids.signed, ids.plan, ids.likes];
    const rows = (await list({ q: 'sam', fields: asked.join(',') })).items;
    const row = (id: string) => rows.find((item) => item.id === id)?.fields;
    expect(row(one)).toEqual({
      [ids.city]: 'Nairobi',
      [ids.budget]: '1250.50',
      [ids.renewal]: '2026-12-01',
      [ids.seen]: '2026-10-01T08:00:00.000Z',
      [ids.signed]: true,
      [ids.plan]: 'gold',
      [ids.likes]: ['tea', 'coffee'],
    });
    // A contact without a value has null for each field asked for.
    expect(row(two)).toEqual(Object.fromEntries(asked.map((id) => [id, null])));
    // One field asked for is one field answered.
    expect(row(one)).not.toHaveProperty(ids.secret);
    const single = (await list({ q: 'sam', fields: ids.city })).items;
    expect(single.find((item) => item.id === one)?.fields).toEqual({ [ids.city]: 'Nairobi' });
    // Without the parameter a row is exactly what it was.
    for (const item of (await list({ q: 'sam' })).items) expect(item).not.toHaveProperty('fields');
  });

  it('refuses a field that is not a contact field of this business, and too many', async () => {
    const other = await team(database);
    const theirs = fieldDefinition.parse(
      await route('createField').run(
        {
          invocation: other.system(),
          params: {},
          query: {},
          body: {
            objectKey: 'contact',
            key: 'theirs',
            label: 'Theirs',
            description: 'What it means.',
            valueType: 'text',
            options: [],
            currency: null,
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
          },
        },
        services,
      ),
    ).id;
    await expect(list({ fields: theirs })).rejects.toMatchObject({
      issues: [{ path: '/fields', code: 'unknown_field' }],
    });
    await expect(list({ fields: 'city' })).rejects.toMatchObject({
      issues: [{ path: '/fields', code: 'invalid_fields' }],
    });
    const many = Array.from({ length: 21 }, (_, index) =>
      theirs.replace(/.$/, 'abcdefghjkmnpqrstvwxyz'[index] ?? 'a'),
    );
    await expect(list({ fields: many.join(',') })).rejects.toBeInstanceOf(ValidationError);
  });
});
