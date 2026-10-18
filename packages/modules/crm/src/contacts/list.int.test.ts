// The contact list. Search, filters and keyset pages against a migrated Postgres as crm_app
// under row-level security. The budget at 100,000 contacts is list.budget.test.ts.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { CONTACT_PAGE_SIZE, contactList, type ContactList } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { seedContacts } from '../../test/contacts.js';
import { contactRoutes } from './routes.js';

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

/** Someone with every permission, in a new business whose address is in `country`. */
async function inBusiness(country?: string): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  if (country !== undefined)
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.businesses set address = jsonb_build_object('country', $2::text) where id = $1`,
        [business.id, country],
      ),
    );
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}

function route(operationId: string) {
  const found = contactRoutes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`Missing ${operationId}`);
  return found;
}

const list = async (invocation: Invocation, query: Record<string, string> = {}) =>
  contactList.parse(
    await route('listContacts').run({ invocation, params: {}, query, body: undefined }, services),
  );

const create = (invocation: Invocation, body: unknown) =>
  route('createContact').run({ invocation, params: {}, query: {}, body }, services);

/** Every page, following next, as the names (or ids, for the unnamed) in order. */
async function everyPage(
  invocation: Invocation,
  query: Record<string, string> = {},
): Promise<ContactList['items']> {
  const items: ContactList['items'] = [];
  let after: string | null | undefined;
  do {
    const page = await list(invocation, {
      ...query,
      ...(after === undefined || after === null ? {} : { after }),
    });
    expect(page.items.length).toBeLessThanOrEqual(CONTACT_PAGE_SIZE);
    items.push(...page.items);
    after = page.next;
  } while (after !== null);
  return items;
}

const seed = (invocation: Invocation, count: number) =>
  seedContacts(database, invocation.context.businessId ?? '', count);

describe('pages of contacts', () => {
  it('come newest first, every contact once, without gaps, and leave out the trash', async () => {
    const invocation = await inBusiness();
    await seed(invocation, 2 * CONTACT_PAGE_SIZE + 7);
    const trashed = await create(invocation, { firstName: 'Trashed' });
    await route('trashContact').run(
      { invocation, params: { id: (trashed as { id: string }).id }, query: {}, body: undefined },
      services,
    );

    const items = await everyPage(invocation);

    expect(items.map((item) => item.name)).toEqual(
      Array.from(
        { length: 2 * CONTACT_PAGE_SIZE + 7 },
        (_, index) => `First${String(index + 1)} Last${String(index + 1)}`,
      ),
    );
    expect(items[1]).toEqual({
      id: expect.stringMatching(/^con_/) as string,
      name: 'First2 Last2',
      email: 'person2@example.com',
      phone: { number: '+254700000002', display: '+254 700 000002' },
      createdAt: expect.any(String) as string,
    });
  });

  it('come by name, ignoring case, with unnamed contacts last', async () => {
    const invocation = await inBusiness('KE');
    for (const body of [
      { firstName: 'bea' },
      { emails: ['nameless@example.com'] },
      { firstName: 'Abel' },
      { phones: ['0712 345678'] },
      { firstName: 'Cora', lastName: 'Ames' },
    ])
      await create(invocation, body);

    const items = await everyPage(invocation, { sort: 'name' });

    expect(items.map((item) => item.name)).toEqual(['Abel', 'bea', 'Cora Ames', null, null]);
    expect(items.slice(3).map((item) => item.email ?? item.phone?.display)).toEqual([
      'nameless@example.com',
      '0712 345678',
    ]);
  });

  it('page by name without gaps across names that repeat', async () => {
    const invocation = await inBusiness();
    for (let index = 0; index < CONTACT_PAGE_SIZE + 5; index += 1)
      await create(invocation, { firstName: index % 2 === 0 ? 'Same' : 'Other' });
    await create(invocation, { emails: ['a@example.com'] });

    const items = await everyPage(invocation, { sort: 'name' });

    expect(new Set(items.map((item) => item.id)).size).toBe(CONTACT_PAGE_SIZE + 6);
    expect(items.at(-1)?.name).toBeNull();
  });

  it("refuse to start after a contact that isn't the business's", async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const theirs = (await create(other, { firstName: 'Theirs' })) as { id: string };

    await expect(list(invocation, { after: theirs.id })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('searching contacts', () => {
  it('finds names by word or any part, email addresses and phone number digits', async () => {
    const invocation = await inBusiness('KE');
    const maya = (await create(invocation, {
      firstName: 'Maya',
      lastName: 'Thompson',
      emails: ['maya@studio.example'],
      phones: ['0712 345678'],
    })) as { id: string };
    await create(invocation, {
      firstName: 'Dana',
      lastName: 'Brooks',
      emails: ['dana@example.com'],
    });

    for (const q of [
      'maya',
      'thompson maya',
      'homps',
      'MAYA@STUDIO',
      '@studio',
      '712 345',
      '0712345',
      '+254 712',
    ])
      expect(
        (await list(invocation, { q })).items.map((item) => item.id),
        q,
      ).toEqual([maya.id]);
    expect((await list(invocation, { q: 'example.com' })).items.map((item) => item.name)).toEqual([
      'Dana Brooks',
    ]);
  });

  it("matches a search under three characters at the start of a name's words", async () => {
    const invocation = await inBusiness();
    await create(invocation, { firstName: 'Maya' });
    await create(invocation, { firstName: 'Thomas', emails: ['ma@example.com'] });

    expect((await list(invocation, { q: 'ma' })).items.map((item) => item.name)).toEqual(['Maya']);
    expect((await list(invocation, { q: 'th' })).items.map((item) => item.name)).toEqual([
      'Thomas',
    ]);
  });

  it('searches phone numbers only for a search that looks like one', async () => {
    const invocation = await inBusiness('KE');
    await create(invocation, { phones: ['0712 345678'] });

    expect((await list(invocation, { q: 'room345678' })).items).toEqual([]);
    expect((await list(invocation, { q: '(0712) 345-678' })).items).toHaveLength(1);
  });

  it('takes % and _ as themselves, and finds nothing of another business', async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    await create(invocation, { firstName: 'Maya' });
    await create(other, { firstName: 'Mayan' });

    expect((await list(invocation, { q: '%' })).items).toEqual([]);
    expect((await list(invocation, { q: 'm_ya' })).items).toEqual([]);
    expect((await list(invocation, { q: 'may' })).items.map((item) => item.name)).toEqual(['Maya']);
  });

  it('pages a broad search completely, in either order', async () => {
    const invocation = await inBusiness();
    await seed(invocation, 1100);

    for (const sort of ['newest', 'name']) {
      const items = await everyPage(invocation, { q: 'person', sort });
      expect(new Set(items.map((item) => item.id)).size, sort).toBe(1100);
      expect(items, sort).toHaveLength(1100);
    }
  });

  it('pages a search as it pages the list', async () => {
    const invocation = await inBusiness();
    await seed(invocation, CONTACT_PAGE_SIZE * 3);

    const items = await everyPage(invocation, { q: 'first1' });

    // First1, First10–First19, First100–First150.
    expect(items).toHaveLength(1 + 10 + 51);
  });
});

describe('filtering contacts', () => {
  it('keeps those added in a period', async () => {
    const invocation = await inBusiness();
    await seed(invocation, 10);
    const [newest] = (await list(invocation)).items;
    if (newest === undefined) throw new Error('No contacts');
    const added = Date.parse(newest.createdAt);

    const items = await everyPage(invocation, {
      createdFrom: new Date(added - 4500).toISOString(),
      createdBefore: new Date(added - 1500).toISOString(),
    });

    expect(items.map((item) => item.name)).toEqual([
      'First3 Last3',
      'First4 Last4',
      'First5 Last5',
    ]);
  });

  it('says whether the reader may add and change contacts', async () => {
    const invocation = await inBusiness();

    expect((await list(invocation)).canManage).toBe(true);
    expect((await list({ ...invocation, permissions: new Set() })).canManage).toBe(false);
  });
});
