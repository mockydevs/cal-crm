// The deal list's search and built-in orders, against a migrated Postgres as crm_app under
// row-level security, through the routes the server registers.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { deal, dealList, dealListQuery, dealStageSummary, type Deal } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions } from '../../test/contact-details.js';
import { seedContacts } from '../../test/contacts.js';
import { dealScene, type DealScene } from '../../test/deal-people.js';
import { seedDeals } from '../../test/deals.js';
import { trashRoutes } from '../trash/routes.js';
import { createDealRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const routes = [...createDealRoutes(detailOptions()), ...trashRoutes];

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

async function call(
  operationId: string,
  invocation: Invocation,
  request: { id?: string; body?: unknown; query?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.id === undefined ? {} : { id: request.id },
      body: request.body,
      query: request.query ?? {},
    },
    services,
  );
}

interface World {
  readonly s: DealScene;
  readonly me: Invocation;
  make(name: string, more?: object): Promise<Deal>;
  /** Every deal the query keeps, read two at a time to its end, by name. */
  names(query?: object): Promise<string[]>;
}

async function world(): Promise<World> {
  const s = await dealScene(database);
  const me = (await s.member()).as();
  return {
    s,
    me,
    make: async (name, more = {}) =>
      deal.parse(
        await call('createDeal', me, {
          body: { name, pipelineId: s.pipelineId, stageId: s.stageId, currency: 'KES', ...more },
        }),
      ),
    names: async (query = {}) => {
      const names: string[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 50; pages += 1) {
        const page = dealList.parse(
          await call('getDeals', me, {
            query: { status: 'all', limit: 2, ...query, ...(after === undefined ? {} : { after }) },
          }),
        );
        names.push(...page.items.map((item) => item.name));
        if (page.next === null) return names;
        after = page.next;
      }
      throw new Error('The list never ended.');
    },
  };
}

describe('the deal list in order', () => {
  it('runs by creation, newest first unless asked, every deal once across pages', async () => {
    const w = await world();
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) await w.make(name);
    const newest = ['Five', 'Four', 'Three', 'Two', 'One'];
    expect(await w.names()).toEqual(newest);
    expect(await w.names({ sort: 'created' })).toEqual(newest);
    expect(await w.names({ sort: 'created', direction: 'asc' })).toEqual([...newest].reverse());
  });

  it('runs by name whatever the case, from A unless asked, ties in the order of their ids', async () => {
    const w = await world();
    for (const name of ['cedar', 'Birch', 'alder', 'Dogwood', 'birch']) await w.make(name);
    expect(await w.names({ sort: 'name' })).toEqual([
      'alder',
      'Birch',
      'birch',
      'cedar',
      'Dogwood',
    ]);
    expect(await w.names({ sort: 'name', direction: 'desc' })).toEqual([
      'Dogwood',
      'cedar',
      'birch',
      'Birch',
      'alder',
    ]);
  });

  it('runs by value, largest first unless asked, with the deals that have none last either way', async () => {
    const w = await world();
    await w.make('None A');
    await w.make('Small', { amount: '10.5000' });
    await w.make('Large', { amount: '1000' });
    await w.make('None B');
    await w.make('Middle', { amount: '10.5001' });
    await w.make('Also large', { amount: '1000' });
    await w.make('Nothing', { amount: '0' });
    expect(await w.names({ sort: 'value' })).toEqual([
      'Also large',
      'Large',
      'Middle',
      'Small',
      'Nothing',
      'None A',
      'None B',
    ]);
    expect(await w.names({ sort: 'value', direction: 'asc' })).toEqual([
      'Nothing',
      'Small',
      'Middle',
      'Large',
      'Also large',
      'None A',
      'None B',
    ]);
    // A page of three ends inside the deals without a value, and the next starts there.
    expect(await w.names({ sort: 'value', limit: 3 })).toHaveLength(7);
    expect(await w.names({ sort: 'value', limit: 5 })).toHaveLength(7);
  });

  it('runs by the last change, most recent first unless asked', async () => {
    const w = await world();
    const first = await w.make('First');
    await w.make('Second');
    await w.make('Third');
    await call('updateDeal', w.me, {
      id: first.id,
      body: {
        name: 'First, renamed',
        pipelineId: first.pipelineId,
        stageId: first.stageId,
        currency: first.currency,
        revision: first.revision,
      },
    });
    expect(await w.names({ sort: 'updated' })).toEqual(['First, renamed', 'Third', 'Second']);
    expect(await w.names({ sort: 'updated', direction: 'asc' })).toEqual([
      'Second',
      'Third',
      'First, renamed',
    ]);
  });

  it('keeps the filters in every order, and never lists the trash or another business', async () => {
    const w = await world();
    const other = await world();
    await other.make('Aardvark of another business', { amount: '5' });
    await w.make('Open one', { amount: '1' });
    await w.make('Won one', { amount: '2', status: 'won' });
    await w.make('Elsewhere', { amount: '3', stageId: w.s.secondStageId });
    const binned = await w.make('Binned', { amount: '4' });
    await call('trashDeal', w.me, { id: binned.id });
    for (const sort of ['created', 'updated', 'name', 'value']) {
      expect((await w.names({ sort })).sort()).toEqual(['Elsewhere', 'Open one', 'Won one']);
      expect(await w.names({ sort, status: 'open', stageId: w.s.stageId })).toEqual(['Open one']);
      expect(await w.names({ sort, pipelineId: other.s.pipelineId })).toEqual([]);
    }
  });

  it('refuses a place that is no deal of this business, and two orders at once', async () => {
    const w = await world();
    const other = await world();
    await w.make('Mine');
    const theirs = await other.make('Theirs');
    const missing = toPublicId('deal', parsePublicId('pipeline', w.s.pipelineId) ?? '');
    for (const after of [theirs.id, missing])
      for (const sort of ['updated', 'name', 'value'])
        await expect(call('getDeals', w.me, { query: { sort, after } })).rejects.toBeInstanceOf(
          ValidationError,
        );
    expect(
      dealListQuery.safeParse({ sort: 'name', sortField: 'fld_01h455vb4pex5vsknk084sn02q' })
        .success,
    ).toBe(false);
    expect(dealListQuery.safeParse({ sort: 'stage' }).success).toBe(false);
    expect(dealListQuery.safeParse({ direction: 'up' }).success).toBe(false);
  });
});

describe('searching the deal list', () => {
  const summaryCount = async (w: World, q: string) =>
    dealStageSummary.parse(
      await call('getDealStageSummary', w.me, {
        query: { pipelineId: w.s.pipelineId, status: 'all', q },
      }),
    ).count;

  it('pages a broad deal-name search without repeating rows and counts every matching deal', async () => {
    const w = await world();
    const seeded = await seedDeals(database, w.s.businessId, 1001);
    for (const q of ['de', 'deal', 'eal']) {
      const query = { pipelineId: seeded.pipelineId, q, status: 'all', limit: 2, sort: 'name' };
      const first = dealList.parse(await call('getDeals', w.me, { query }));
      expect(first.items.map((item) => item.name)).toEqual(['Deal 1', 'Deal 10']);
      expect(first.next).not.toBeNull();
      const next = dealList.parse(
        await call('getDeals', w.me, { query: { ...query, after: first.next } }),
      );
      expect(next.items.map((item) => item.name)).toEqual(['Deal 100', 'Deal 1000']);
      expect(
        dealStageSummary.parse(
          await call('getDealStageSummary', w.me, {
            query: { pipelineId: seeded.pipelineId, q, status: 'all' },
          }),
        ).count,
      ).toBe(1001);
    }
  });

  it('finds the linked deal when thousands of contacts match by word, substring, email or phone', async () => {
    const w = await world();
    await seedContacts(database, w.s.businessId, 2002);
    const [phone] = await database.withTenant(w.s.context, (sql) =>
      sql.query<{ contact_id: string }>(
        `select contact_id from crm.contact_identities
         where kind = 'phone' order by contact_id limit 1`,
      ),
    );
    if (phone === undefined) throw new Error('The seeded contacts have no phone number.');
    await w.make('Linked roof', { primaryContactId: toPublicId('contact', phone.contact_id) });
    await w.make('Unrelated');
    for (const q of ['fi', 'first', 'person', '2547']) {
      expect(await w.names({ q })).toEqual(['Linked roof']);
      expect(await summaryCount(w, q)).toBe(1);
    }
  });

  it('finds every deal when one matching contact is linked to more than a thousand opportunities', async () => {
    const w = await world();
    const contact = await w.s.contact('Quill');
    const seeded = await seedDeals(database, w.s.businessId, 1001);
    await database.withTenant(w.s.context, (sql) =>
      sql.query(
        `insert into crm.record_links
           (business_id, link_type_id, from_record_id, to_record_id, is_primary, source_kind)
         select d.business_id, t.id, d.id, $2, true, 'import'
         from crm.deals d join crm.link_types t on t.business_id = d.business_id and t.key = 'deal_contact'
         where d.business_id = $1`,
        [w.s.businessId, parsePublicId('contact', contact)],
      ),
    );
    for (const q of ['qu', 'quill', 'uill']) {
      const page = dealList.parse(
        await call('getDeals', w.me, {
          query: { pipelineId: seeded.pipelineId, q, status: 'all', limit: 2, sort: 'name' },
        }),
      );
      expect(page.items.map((item) => item.name)).toEqual(['Deal 1', 'Deal 10']);
      expect(
        dealStageSummary.parse(
          await call('getDealStageSummary', w.me, {
            query: { pipelineId: seeded.pipelineId, q, status: 'all' },
          }),
        ).count,
      ).toBe(1001);
    }
  });

  it('finds a deal by the start of the words of its name, or by any part of three characters', async () => {
    const w = await world();
    await w.make('Garden fence, north side');
    await w.make('Kitchen refit');
    await w.make('Fencing for the paddock');
    expect((await w.names({ q: 'fenc' })).sort()).toEqual([
      'Fencing for the paddock',
      'Garden fence, north side',
    ]);
    expect(await w.names({ q: 'north gard' })).toEqual(['Garden fence, north side']);
    expect(await w.names({ q: 'tche' })).toEqual(['Kitchen refit']);
    // Two characters match the start of a word only.
    expect(await w.names({ q: 'ki' })).toEqual(['Kitchen refit']);
    expect(await w.names({ q: 'it' })).toEqual([]);
    expect(await w.names({ q: '%' })).toEqual([]);
    expect(await summaryCount(w, 'fenc')).toBe(2);
    expect(await summaryCount(w, 'nothing like it')).toBe(0);
  });

  it('finds a deal by a contact it is with: name, email address or phone digits', async () => {
    const w = await world();
    const maya = await w.s.contact('Maya', 'maya.thompson@example.test');
    const omar = await w.s.contact('Omar');
    await database.withTenant(w.s.context, (sql) =>
      sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
         values ($1, $2, 'phone', '+254 712 345678', '+254712345678', true)`,
        [w.s.businessId, parsePublicId('contact', omar)],
      ),
    );
    await w.make('Roof', { primaryContactId: maya });
    await w.make('Gutter', { primaryContactId: omar, additionalContactIds: [maya] });
    await w.make('Maya blue paint');
    await w.make('Unrelated');
    expect((await w.names({ q: 'maya' })).sort()).toEqual(['Gutter', 'Maya blue paint', 'Roof']);
    expect((await w.names({ q: 'thompson@exa' })).sort()).toEqual(['Gutter', 'Roof']);
    expect(await w.names({ q: '0712 345' })).toEqual(['Gutter']);
    expect(await summaryCount(w, 'maya')).toBe(3);
    // In any order, with the other filters.
    expect(await w.names({ q: 'maya', sort: 'name' })).toEqual([
      'Gutter',
      'Maya blue paint',
      'Roof',
    ]);
  });

  it("never finds the trash, or anything through another business's deal or contact", async () => {
    const w = await world();
    const other = await world();
    const theirs = await other.s.contact('Zephyrine');
    await other.make('Zephyr works', { primaryContactId: theirs });
    const binned = await w.make('Zephyr cleanup');
    await call('trashDeal', w.me, { id: binned.id });
    expect(await w.names({ q: 'zephyr' })).toEqual([]);
    expect(await summaryCount(w, 'zephyr')).toBe(0);
    expect(await other.names({ q: 'zephyr' })).toEqual(['Zephyr works']);
  });
});
