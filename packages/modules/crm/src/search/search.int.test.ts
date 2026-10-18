// The command bar's search, against a migrated Postgres as crm_app under row-level
// security. Acceptance: results respect permissions, so a search finds only the records of
// the business the request works in, and none in the trash.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { searchResults, type SearchResults } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { contactRoutes } from '../contacts/routes.js';
import { searchRoutes } from './routes.js';

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
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    // Reading isn't gated: someone with no permission at all searches the same.
    permissions: new Set(),
  };
}

const writer = (invocation: Invocation): Invocation => ({ ...invocation, permissions: 'all' });

const routes = [...contactRoutes, ...searchRoutes];
async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );
}

const search = async (invocation: Invocation, q: string): Promise<SearchResults> =>
  searchResults.parse(await call('searchRecords', invocation, { query: { q } }));

const found = async (invocation: Invocation, q: string) =>
  (await search(invocation, q)).items.map((item) => [item.kind, item.name, item.detail]);

async function newContact(
  invocation: Invocation,
  body: { firstName?: string; lastName?: string; emails?: string[]; phones?: string[] },
): Promise<string> {
  const created = (await call('createContact', writer(invocation), { body })) as { id: string };
  return created.id;
}

const businessOf = (invocation: Invocation) => invocation.context.businessId ?? '';

/** Companies and deals, written as the owner, as their own modules would write them. */
async function companiesAndDeals(
  invocation: Invocation,
  records: { companies?: [string, string | null][]; deals?: string[] },
): Promise<Record<string, string>> {
  return database.as('crm_owner', async (sql) => {
    const business = businessOf(invocation);
    const ids: Record<string, string> = {};
    for (const [name, domain] of records.companies ?? []) {
      const { id } = await sql.one<{ id: string }>(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           select $1, 'company', id from crm.object_types where business_id = $1 and kind = 'company'
           returning id)
         insert into crm.companies (business_id, id, name, domain, created_by_kind)
         select $1, id, $2, $3, 'user' from record returning id`,
        [business, name, domain],
      );
      ids[name] = toPublicId('company', id);
    }
    if ((records.deals ?? []).length === 0) return ids;
    const pipeline = await sql.one<{ id: string }>(
      `insert into crm.pipelines (business_id, name) values ($1, 'Weddings') returning id`,
      [business],
    );
    const stage = await sql.one<{ id: string }>(
      `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
       values ($1, $2, 'New lead', 0) returning id`,
      [business, pipeline.id],
    );
    for (const name of records.deals ?? []) {
      const { id } = await sql.one<{ id: string }>(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           select $1, 'deal', id from crm.object_types where business_id = $1 and kind = 'deal'
           returning id)
         insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, created_by_kind)
         select $1, id, $2, $3, $4, 'USD', 'user' from record returning id`,
        [business, name, pipeline.id, stage.id],
      );
      ids[name] = toPublicId('deal', id);
    }
    return ids;
  });
}

describe('searching records', () => {
  it('finds contacts, companies and deals by a word or any part of their names', async () => {
    const invocation = await inBusiness();
    await newContact(invocation, {
      firstName: 'Maya',
      lastName: 'Lee',
      emails: ['maya@example.com'],
    });
    await newContact(invocation, { firstName: 'Priya', emails: ['priya@example.com'] });
    await companiesAndDeals(invocation, {
      companies: [
        ['Lee Family', 'leefamily.example'],
        ['Harbor Lights', null],
      ],
      deals: ['Lee wedding', 'Harbor gala'],
    });

    expect(await found(invocation, 'lee')).toEqual([
      ['contact', 'Maya Lee', 'maya@example.com'],
      ['company', 'Lee Family', 'leefamily.example'],
      ['deal', 'Lee wedding', 'Weddings · New lead'],
    ]);
    // Any part of a name, from three characters.
    expect(await found(invocation, 'arbo')).toEqual([
      ['company', 'Harbor Lights', null],
      ['deal', 'Harbor gala', 'Weddings · New lead'],
    ]);
    // Shorter, the start of a word.
    expect(await found(invocation, 'ha')).toEqual([
      ['company', 'Harbor Lights', null],
      ['deal', 'Harbor gala', 'Weddings · New lead'],
    ]);
    expect(await found(invocation, 'ar')).toEqual([]);
  });

  it('finds contacts by email address and phone number, and companies by domain', async () => {
    const invocation = await inBusiness();
    await newContact(invocation, { emails: ['jordan@example.com'], phones: ['+254712345678'] });
    await companiesAndDeals(invocation, { companies: [['Lee Family', 'leefamily.example']] });

    // A contact without a name goes by its address.
    expect(await found(invocation, 'jordan@')).toEqual([['contact', 'jordan@example.com', null]]);
    expect(await found(invocation, '712 345')).toEqual([['contact', 'jordan@example.com', null]]);
    expect(await found(invocation, 'leefamily')).toEqual([
      ['company', 'Lee Family', 'leefamily.example'],
    ]);
    // Without a name or an email address, by its phone number; with only a name, nothing else.
    await newContact(invocation, { phones: ['+254733000111'] });
    await newContact(invocation, { firstName: 'Wanjiru' });
    expect(await found(invocation, '733 000')).toEqual([
      ['contact', expect.stringMatching(/^\+254/), null],
    ]);
    expect(await found(invocation, 'wanjiru')).toEqual([['contact', 'Wanjiru', null]]);
  });

  it('puts names that start with the search first, and gives at most five of each kind', async () => {
    const invocation = await inBusiness();
    await companiesAndDeals(invocation, {
      companies: [
        ['Ace Events', null],
        ['Grace Florals', null],
        ['Place Settings', null],
        ['Space Hire', null],
        ['Trace Lighting', null],
        ['Vace Catering', null],
      ],
    });

    expect((await found(invocation, 'ace')).map(([, name]) => name)).toEqual([
      'Ace Events',
      'Grace Florals',
      'Place Settings',
      'Space Hire',
      'Trace Lighting',
    ]);
    expect((await found(invocation, 'trac')).map(([, name]) => name)).toEqual(['Trace Lighting']);
  });

  it("never finds another business's records, nor any in the trash", async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const ours = await newContact(invocation, { firstName: 'Lee', emails: ['lee@ours.example'] });
    const trashed = await newContact(invocation, {
      firstName: 'Lee',
      lastName: 'Trashed',
      emails: ['lee@trashed.example'],
    });
    await call('trashContact', writer(invocation), { params: { id: trashed } });
    const { 'Lee Gone': gone = '' } = await companiesAndDeals(invocation, {
      companies: [['Lee Gone', null]],
    });
    await database.as('crm_owner', (sql) =>
      sql.query(`update crm.companies set deleted_at = now() where id = $1`, [
        parsePublicId('company', gone),
      ]),
    );
    await newContact(other, { firstName: 'Lee', emails: ['lee@theirs.example'] });
    await companiesAndDeals(other, { companies: [['Lee Theirs', null]], deals: ['Lee theirs'] });

    const items = (await search(invocation, 'lee')).items;
    expect(items.map((item) => item.id)).toEqual([ours]);
  });

  it('refuses an empty search, and one too long', async () => {
    const invocation = await inBusiness();
    await expect(search(invocation, '  ')).rejects.toBeInstanceOf(ValidationError);
    await expect(search(invocation, 'x'.repeat(201))).rejects.toBeInstanceOf(ValidationError);
    expect((await search(invocation, '%_\\')).items).toEqual([]);
    // Too short to be part of a name, and no word in it.
    expect((await search(invocation, '--')).items).toEqual([]);
  });
});
