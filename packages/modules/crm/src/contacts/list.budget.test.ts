// The budget for the contact list: at 100,000 contacts, a page of the list in under 200 ms at
// p95, as crm_app under row-level security. A timing, so it runs alone with `pnpm --filter
// @repo/module-crm test:budget`, at checkpoints and on demand (budgets are checked at
// checkpoints), not among the parallel integration suites, whose shared CPU makes
// wall-clock times meaningless. Each p95 is reported as an annotation.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  contactCount,
  contactList,
  contactNeighbours,
  fieldDefinition,
  type ContactFilterCondition,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { seedContactExtras, seedContactFilterData, seedContacts } from '../../test/contacts.js';
import { fieldRoutes } from '../fields/routes.js';
import { contactRoutes } from './routes.js';

/** A condition as a test writes it: sent as JSON, so checked by the server, not the compiler. */
interface Condition {
  readonly field: string;
  readonly operator: ContactFilterCondition['operator'];
  readonly value?: string;
  readonly values?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly days?: number;
}
interface Filter {
  readonly match: 'all' | 'any';
  readonly groups: readonly {
    readonly match: 'all' | 'any';
    readonly conditions: readonly Condition[];
  }[];
}

const COUNT = 100_000;
const RUNS = 25;
const BUDGET_MS = 200;

let database: TestDatabase;
let db: Database;
let services: Services;
let invocation: Invocation;
let deep: string;
let rareTag: string;
let commonTag: string;
const fields = { text: '', number: '' };

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set address = '{"country": "KE"}' where id = $1`, [
      business.id,
    ]),
  );
  invocation = {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  await seedContacts(database, business.id, COUNT);
  // What the list's extras read: a timeline, tags and a company for each.
  await seedContactExtras(database, business.id);
  const middle = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `select id from crm.contacts where business_id = $1 and first_name = 'First50000'`,
      [business.id],
    ),
  );
  deep = toPublicId('contact', middle.id);

  // What the Filters panel asks about: an owner, a type, a rare tag and two custom fields,
  // so that some conditions match a handful of contacts and others most.
  const createField = fieldRoutes.find((route) => route.endpoint.operationId === 'createField');
  if (createField === undefined) throw new Error('Missing createField');
  for (const name of ['text', 'number'] as const)
    fields[name] = fieldDefinition.parse(
      await createField.run(
        {
          invocation,
          params: {},
          query: {},
          body: {
            objectKey: 'contact',
            key: `budget_${name}`,
            label: `Budget ${name}`,
            description: 'Seeded for the budget.',
            valueType: name,
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
  const owner = await database.fixtures.user();
  await seedContactFilterData(
    database,
    business.id,
    {
      text: parsePublicId('field', fields.text) ?? '',
      number: parsePublicId('field', fields.number) ?? '',
    },
    owner.id,
  );
  const tags = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string; name: string }>(
      `select id, name from crm.tags where business_id = $1 and name in ('Rare tag', 'Seeded tag 1')`,
      [business.id],
    ),
  );
  const tagNamed = (name: string) =>
    toPublicId('tag', tags.find((tag) => tag.name === name)?.id ?? '');
  rareTag = tagNamed('Rare tag');
  commonTag = tagNamed('Seeded tag 1');
}, 600_000);

afterAll(async () => {
  await db.destroy();
  await database.close();
});

const listRoute = contactRoutes.find((route) => route.endpoint.operationId === 'listContacts');
const countRoute = contactRoutes.find((route) => route.endpoint.operationId === 'countContacts');
const neighboursRoute = contactRoutes.find(
  (route) => route.endpoint.operationId === 'getContactNeighbours',
);

async function neighbours(id: string, query: Record<string, string>) {
  if (neighboursRoute === undefined) throw new Error('Missing getContactNeighbours');
  return contactNeighbours.parse(
    await neighboursRoute.run({ invocation, params: { id }, query, body: undefined }, services),
  );
}

async function list(query: Record<string, string>) {
  if (listRoute === undefined) throw new Error('Missing listContacts');
  return contactList.parse(
    await listRoute.run({ invocation, params: {}, query, body: undefined }, services),
  );
}

async function count(query: Record<string, string>) {
  if (countRoute === undefined) throw new Error('Missing countContacts');
  return contactCount.parse(
    await countRoute.run({ invocation, params: {}, query, body: undefined }, services),
  );
}

/** The 95th percentile of a request's time, in milliseconds, after warming up. */
async function p95<Answer>(request: () => Promise<Answer>): Promise<[number, Answer]> {
  for (let run = 0; run < 3; run += 1) await request();
  const times: number[] = [];
  let answer = await request();
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    answer = await request();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return [times[Math.ceil(RUNS * 0.95) - 1] ?? Number.POSITIVE_INFINITY, answer];
}

describe(`at ${COUNT.toLocaleString('en')} contacts`, () => {
  it.for([
    ['the newest page', {}],
    ['a page deep in the newest', { after: 'deep' }],
    ['the first page by name', { sort: 'name' }],
    ['a page deep by name', { sort: 'name', after: 'deep' }],
    ['a name search', { q: 'first4999' }],
    ['a search of name words', { q: 'last77 first77' }],
    ['an email search', { q: 'person31415@' }],
    ['a phone search', { q: '0700 031 41' }],
    ['a search that matches half', { q: '2547' }],
    ['a two-letter search', { q: 'zq' }],
    ['a search that matches nothing', { q: 'nobody-here' }],
  ] as const)(`pages %s within ${String(BUDGET_MS)} ms at p95`, async ([, query], { annotate }) => {
    const [time] = await p95(() => list('after' in query ? { ...query, after: deep } : query));
    await annotate(`p95 ${time.toFixed(1)} ms`);
    expect(time).toBeLessThan(BUDGET_MS);
  });

  // The list as the Contacts screen asks for it: every row with its last activity, its tags
  // and its company. Each row must really have them, or the time would be that of reading
  // nothing.
  const everything = 'lastActivity,tags,company';
  it.for([
    ['the newest page', {}],
    ['a page deep in the newest', { after: 'deep' }],
    ['the first page by name', { sort: 'name' }],
    ['a name search', { q: 'first4999' }],
    ['a search that matches half', { q: '2547' }],
  ] as const)(
    `pages %s with last activity, tags and company within ${String(BUDGET_MS)} ms at p95`,
    async ([, query], { annotate }) => {
      const [time, page] = await p95(() =>
        list({ ...('after' in query ? { ...query, after: deep } : query), include: everything }),
      );
      await annotate(`p95 ${time.toFixed(1)} ms`);
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expect(item.lastActivity).toMatchObject({ channel: 'email' });
        expect(item.tags?.length).toBeGreaterThan(0);
        expect(item.company).not.toBeNull();
      }
      expect(time).toBeLessThan(BUDGET_MS);
    },
  );

  it.for([
    ['every contact', {}, { count: COUNT, exact: true }],
    ['a name search', { q: 'first4999' }, { count: 11, exact: true }],
    ['a search of name words', { q: 'last77 first77' }, { count: 1111, exact: true }],
    ['an email search', { q: 'person31415@' }, { count: 1, exact: true }],
    ['a search that matches half', { q: '2547' }, { count: 10_000, exact: false }],
    ['a search that matches nothing', { q: 'nobody-here' }, { count: 0, exact: true }],
    [
      'those added before now',
      { createdBefore: '2999-01-01T00:00:00Z' },
      { count: 10_000, exact: false },
    ],
  ] as const)(
    `counts %s within ${String(BUDGET_MS)} ms at p95`,
    async ([, query, expected], { annotate }) => {
      const [time, answer] = await p95(() => count(query));
      await annotate(`p95 ${time.toFixed(1)} ms`);
      expect(answer).toEqual(expected);
      expect(time).toBeLessThan(BUDGET_MS);
    },
  );

  // The Filters panel. Each case is the page and the count of the same filter: both must
  // stay in the budget, whether the filter keeps a handful of contacts (found from an
  // index, then read by id) or most of them (tested in the list's order).
  type Group = readonly ['all' | 'any', ...Condition[]];
  const groups = (match: 'all' | 'any', ...lists: Group[]): Filter => ({
    match,
    groups: lists.map(([inner, ...conditions]) => ({ match: inner, conditions })),
  });
  const all = (...conditions: Condition[]) => groups('all', ['all', ...conditions]);
  const common = () => all({ field: 'tags', operator: 'any_of', values: [commonTag] });
  /** A filter, and how many contacts it keeps when the seed settles that. */
  const filters: readonly (readonly [string, () => Filter, number | undefined])[] = [
    [
      'a tag 20 contacts have',
      () => all({ field: 'tags', operator: 'any_of', values: [rareTag] }),
      20,
    ],
    ['a common tag', common, 30_000],
    [
      'none of a common tag',
      () => all({ field: 'tags', operator: 'none_of', values: [commonTag] }),
      70_000,
    ],
    ['no tag at all, which nobody matches', () => all({ field: 'tags', operator: 'is_empty' }), 0],
    ['an owner', () => all({ field: 'owner', operator: 'is_not_empty' }), 2000],
    ['no owner', () => all({ field: 'owner', operator: 'is_empty' }), 98_000],
    [
      'added in the last day',
      () => all({ field: 'created', operator: 'in_last', days: 1 }),
      undefined,
    ],
    [
      'added more than a day ago',
      () => all({ field: 'created', operator: 'not_in_last', days: 1 }),
      undefined,
    ],
    ['a type', () => all({ field: 'type', operator: 'any_of', values: ['lead'] }), 33_333],
    [
      'a date of birth in one year',
      () =>
        all({ field: 'dateOfBirth', operator: 'between', from: '1980-01-01', to: '1980-12-31' }),
      undefined,
    ],
    [
      'one value of a text field',
      () => all({ field: fields.text, operator: 'is', value: 'city 7' }),
      100,
    ],
    ['a text field left empty', () => all({ field: fields.text, operator: 'is_empty' }), 90_000],
    [
      'a number field above most',
      () => all({ field: fields.number, operator: 'gt', value: '990' }),
      900,
    ],
    [
      'a number field above half',
      () => all({ field: fields.number, operator: 'gte', value: '500' }),
      50_000,
    ],
    [
      'part of a first name',
      () => all({ field: 'firstName', operator: 'contains', value: 'first4999' }),
      11,
    ],
    [
      'part of an email address',
      () => all({ field: 'email', operator: 'contains', value: 'person31415@' }),
      1,
    ],
    [
      'a company by name',
      () => all({ field: 'company', operator: 'is', value: 'Seeded company 7' }),
      100,
    ],
    [
      'three common conditions together',
      () =>
        all(
          { field: 'tags', operator: 'any_of', values: [commonTag] },
          { field: 'type', operator: 'any_of', values: ['lead'] },
          { field: fields.number, operator: 'gte', value: '500' },
        ),
      undefined,
    ],
    [
      'either of two rare conditions',
      () =>
        groups(
          'any',
          ['all', { field: 'tags', operator: 'any_of', values: [rareTag] }],
          ['all', { field: fields.text, operator: 'is', value: 'City 7' }],
        ),
      120,
    ],
    [
      'either of two rare conditions, and a type',
      () =>
        groups(
          'all',
          [
            'any',
            { field: 'tags', operator: 'any_of', values: [rareTag] },
            { field: fields.text, operator: 'is', value: 'City 7' },
          ],
          ['all', { field: 'type', operator: 'none_of', values: ['lead'] }],
        ),
      undefined,
    ],
  ];
  it.for(filters)(
    `pages and counts a filter on %s within ${String(BUDGET_MS)} ms at p95`,
    async ([, filter, kept], { annotate }) => {
      const query = { filter: JSON.stringify(filter()) };
      const [pageTime, page] = await p95(() => list(query));
      const [countTime, counted] = await p95(() => count(query));
      await annotate(
        `page p95 ${pageTime.toFixed(1)} ms, count p95 ${countTime.toFixed(1)} ms, ${String(counted.count)} kept`,
      );
      if (kept !== undefined)
        expect(counted).toEqual({ count: Math.min(kept, 10_000), exact: kept <= 10_000 });
      expect(page.items).toHaveLength(Math.min(counted.count, 50));
      expect(pageTime).toBeLessThan(BUDGET_MS);
      expect(countTime).toBeLessThan(BUDGET_MS);
    },
  );

  // The orders and page sizes of the list, and a row's custom fields.
  it.for([
    ['the oldest page', { direction: 'asc' }],
    ['a page deep from the oldest', { direction: 'asc', after: 'deep' }],
    ['the last names first', { sort: 'name', direction: 'desc' }],
    ['a page deep from the last name', { sort: 'name', direction: 'desc', after: 'deep' }],
    ['the latest changes', { sort: 'updated' }],
    ['a page deep in the latest changes', { sort: 'updated', after: 'deep' }],
    ['the earliest changes', { sort: 'updated', direction: 'asc' }],
    ['a hundred contacts', { limit: '100' }],
    ['a hundred by name with a common filter', { limit: '100', sort: 'name', filter: 'common' }],
    [
      'a hundred with two custom fields and every extra',
      { limit: '100', fields: 'both', include: everything },
    ],
  ] as const)(`pages %s within ${String(BUDGET_MS)} ms at p95`, async ([, given], { annotate }) => {
    const query: Record<string, string> = { ...given };
    if (query['after'] !== undefined) query['after'] = deep;
    if (query['fields'] !== undefined) query['fields'] = `${fields.text},${fields.number}`;
    if (query['filter'] !== undefined) query['filter'] = JSON.stringify(common());
    const [time, page] = await p95(() => list(query));
    await annotate(`p95 ${time.toFixed(1)} ms`);
    expect(page.items).toHaveLength(Number(query['limit'] ?? 50));
    if (query['fields'] !== undefined)
      for (const item of page.items) expect(item.fields?.[fields.number]).not.toBeNull();
    expect(time).toBeLessThan(BUDGET_MS);
  });

  it.for([
    ['newest first', {}, 50_000],
    ['oldest first', { direction: 'asc' }, 50_001],
    ['by name', { sort: 'name' }, undefined],
    ['by last name first', { sort: 'name', direction: 'desc' }, undefined],
    ['by last change', { sort: 'updated' }, undefined],
    // Some 15,000 contacts with the tag come before it: past where a filter is counted.
    ['with a common filter', { filter: 'common' }, null],
    ['with a search', { q: 'first5000' }, 2],
  ] as const)(
    `finds a contact's neighbours %s within ${String(BUDGET_MS)} ms at p95`,
    async ([, given, position], { annotate }) => {
      const query: Record<string, string> = { ...given };
      if (query['filter'] !== undefined) query['filter'] = JSON.stringify(common());
      const [time, answer] = await p95(() => neighbours(deep, query));
      await annotate(`p95 ${time.toFixed(1)} ms, position ${String(answer.position)}`);
      expect(answer.inList).toBe(true);
      expect(answer.previous).not.toBeNull();
      expect(answer.next).not.toBeNull();
      if (position !== undefined) expect(answer.position).toBe(position);
      expect(time).toBeLessThan(BUDGET_MS);
    },
  );
});
