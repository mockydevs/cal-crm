// Through the CRM's own route, against a migrated Postgres: the Custom Fields list,
// its filters, its counts and its paging.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  customFieldList,
  fieldDefinition,
  fieldFolder,
  type CustomFieldList,
  type FieldDefinition,
  type FieldFolder,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, ValidationError, type ActorKind } from '@repo/kernel';
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
const list = async (
  invocation: Invocation,
  query: Record<string, string> = {},
): Promise<CustomFieldList> =>
  customFieldList.parse(await call('listCustomFields', invocation, undefined, {}, query));
const keys = (page: CustomFieldList): string[] => page.items.map((field) => field.key);

const as = (invocation: Invocation, actorKind: ActorKind): Invocation => ({
  ...invocation,
  context: { ...invocation.context, actorKind },
});
async function field(
  invocation: Invocation,
  key: string,
  change: Record<string, unknown> = {},
): Promise<FieldDefinition> {
  const valueType = typeof change['valueType'] === 'string' ? change['valueType'] : 'text';
  const choice = valueType === 'single_choice' || valueType === 'multi_choice';
  return fieldDefinition.parse(
    await call('createField', invocation, {
      objectKey: 'contact',
      key,
      label: key.replaceAll('_', ' '),
      description: 'What it means.',
      valueType,
      options: choice ? [{ key: 'a', label: 'A', description: '', archived: false }] : [],
      currency: valueType === 'money' ? 'KES' : null,
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
      ...change,
    }),
  );
}
const folder = async (
  invocation: Invocation,
  name: string,
  objectKey = 'contact',
): Promise<FieldFolder> =>
  fieldFolder.parse(await call('createFieldFolder', invocation, { objectKey, name }));
/** When a field was created, as the test needs it: to the microsecond, in any order. */
const createdAt = (made: FieldDefinition, moment: string): Promise<unknown> =>
  database.as('crm_owner', (sql) =>
    sql.query('update crm.field_definitions set created_at = $2::timestamptz where id = $1', [
      parsePublicId('field', made.id),
      moment,
    ]),
  );

/** Harbor Lights' fields: three objects, four types, two folders, two sources, one archived. */
async function harborLights() {
  const invocation = await inBusiness();
  const fence = await folder(invocation, 'Fence quote');
  const fenceType = await field(invocation, 'select_your_fence_type', {
    label: 'Select your fence type',
    valueType: 'single_choice',
    folderId: fence.id,
    placeholder: 'Choose one',
  });
  const fenceLength = await field(invocation, 'fence_length', {
    label: 'Fence length (m)',
    valueType: 'number',
    folderId: fence.id,
  });
  const notes = await field(as(invocation, 'import'), 'site_notes', {
    label: 'Site notes',
    valueType: 'long_text',
  });
  const oldVenue = await field(invocation, 'old_venue', { label: 'Old venue', archived: true });
  const quoteTotal = await field(invocation, 'quote_total', {
    objectKey: 'deal',
    label: 'Quote total',
    valueType: 'money',
  });
  const city = await field(as(invocation, 'api_key'), 'city', {
    objectKey: 'company',
    label: 'City',
  });
  // Oldest to newest, a day apart.
  const made = [fenceType, fenceLength, notes, oldVenue, quoteTotal, city];
  for (const [index, each] of made.entries())
    await createdAt(each, `2026-10-0${String(index + 1)}T09:00:00Z`);
  return { invocation, fence, fenceType, fenceLength, notes, oldVenue, quoteTotal, city };
}

describe('the list', () => {
  it('shows live fields of every object, newest first, each with its folder, key and origin', async () => {
    const { invocation, fence } = await harborLights();
    const page = await list(invocation);
    expect(keys(page)).toEqual([
      'city',
      'quote_total',
      'site_notes',
      'fence_length',
      'select_your_fence_type',
    ]);
    expect(page.total).toBe(5);
    expect(page.next).toBeNull();
    expect(page.canManage).toBe(true);
    expect(page.items.at(-1)).toMatchObject({
      objectKey: 'contact',
      label: 'Select your fence type',
      valueType: 'single_choice',
      folderId: fence.id,
      folderName: 'Fence quote',
      placeholder: 'Choose one',
      mergeKey: 'contact.select_your_fence_type',
      createdAt: '2026-10-01T09:00:00.000Z',
      source: 'user',
    });
    expect(
      page.items.map(({ key, mergeKey, folderName, source }) => [
        key,
        mergeKey,
        folderName,
        source,
      ]),
    ).toEqual([
      ['city', 'business.city', 'Additional Info', 'api_key'],
      ['quote_total', 'opportunity.quote_total', 'Additional Info', 'user'],
      ['site_notes', 'contact.site_notes', 'Additional Info', 'import'],
      ['fence_length', 'contact.fence_length', 'Fence quote', 'user'],
      ['select_your_fence_type', 'contact.select_your_fence_type', 'Fence quote', 'user'],
    ]);
  });

  it('counts each object’s live fields and its folders, whatever the filters', async () => {
    const { invocation } = await harborLights();
    const counts = [
      { key: 'company', label: 'Company', fields: 1, folders: 1 },
      { key: 'contact', label: 'Contact', fields: 3, folders: 2 },
      { key: 'deal', label: 'Deal', fields: 1, folders: 1 },
    ];
    expect((await list(invocation)).objects).toEqual(counts);
    const filtered = await list(invocation, { objectKey: 'deal', q: 'nothing matches this' });
    expect(filtered).toMatchObject({ items: [], total: 0, next: null, objects: counts });
  });

  it('tells someone who may not manage fields so, and still shows them', async () => {
    const { invocation } = await harborLights();
    const page = await list({ ...invocation, permissions: new Set() });
    expect(page.canManage).toBe(false);
    expect(page.total).toBe(5);
  });
});

describe('the filters', () => {
  it.each([
    [{ objectKey: 'contact' }, ['site_notes', 'fence_length', 'select_your_fence_type']],
    [{ objectKey: 'deal' }, ['quote_total']],
    [{ objectKey: 'company' }, ['city']],
    [{ objectKey: 'venue' }, []],
    [{ valueType: 'number' }, ['fence_length']],
    [{ valueType: 'text' }, ['city']],
    [{ valueType: 'boolean' }, []],
    [{ source: 'import' }, ['site_notes']],
    [{ source: 'api_key' }, ['city']],
    [{ source: 'user' }, ['quote_total', 'fence_length', 'select_your_fence_type']],
    [{ source: 'form' }, []],
    // From a moment on, and up to but not including one.
    [{ createdFrom: '2026-10-05T09:00:00Z' }, ['city', 'quote_total']],
    [{ createdBefore: '2026-10-02T09:00:00Z' }, ['select_your_fence_type']],
    [
      { createdFrom: '2026-10-02T09:00:00Z', createdBefore: '2026-10-05T09:00:00Z' },
      ['site_notes', 'fence_length'],
    ],
    // The same moment written with another offset.
    [{ createdFrom: '2026-10-05T12:00:00+03:00' }, ['city', 'quote_total']],
    // A search finds part of a name or of a key, in any case.
    [{ q: 'FENCE' }, ['fence_length', 'select_your_fence_type']],
    [{ q: 'quote_tot' }, ['quote_total']],
    [{ q: 'length (m' }, ['fence_length']],
    [{ q: 'zzz' }, []],
    // Together they narrow.
    [{ objectKey: 'contact', source: 'user', valueType: 'number' }, ['fence_length']],
    [{ objectKey: 'contact', q: 'fence', createdFrom: '2026-10-02T00:00:00Z' }, ['fence_length']],
  ] as const)('%j gives %j', async (query, expected) => {
    const { invocation } = await harborLights();
    const page = await list(invocation, query);
    expect(keys(page)).toEqual(expected);
    expect(page.total).toBe(expected.length);
  });

  it('take a folder, of whichever object', async () => {
    const { invocation, fence } = await harborLights();
    expect(keys(await list(invocation, { folderId: fence.id }))).toEqual([
      'fence_length',
      'select_your_fence_type',
    ]);
    const other = await inBusiness();
    const foreign = await folder(other, 'Theirs');
    expect(await list(invocation, { folderId: foreign.id })).toMatchObject({ items: [], total: 0 });
  });

  it('leave archived fields out unless asked for them, or for them alone', async () => {
    const { invocation } = await harborLights();
    expect(keys(await list(invocation, { objectKey: 'contact', archived: 'include' }))).toEqual([
      'old_venue',
      'site_notes',
      'fence_length',
      'select_your_fence_type',
    ]);
    const only = await list(invocation, { archived: 'only' });
    expect(keys(only)).toEqual(['old_venue']);
    expect(only.items[0]?.archived).toBe(true);
  });

  it('search for a percent sign or an underscore as itself', async () => {
    const invocation = await inBusiness();
    await field(invocation, 'discount', { label: '100% discount' });
    await field(invocation, 'plain', { label: '100 discount' });
    await field(invocation, 'ab', { label: 'a_b' });
    await field(invocation, 'axb', { label: 'axb' });
    expect(keys(await list(invocation, { q: '100%' }))).toEqual(['discount']);
    expect(keys(await list(invocation, { q: 'a_b' }))).toEqual(['ab']);
  });
});

describe('paging', () => {
  it('walks every match once, newest first or oldest first, with the total on each page', async () => {
    const { invocation } = await harborLights();
    const walk = async (query: Record<string, string>): Promise<string[][]> => {
      const pages: string[][] = [];
      let after: string | null | undefined;
      do {
        const page = await list(invocation, {
          ...query,
          limit: '2',
          ...(after ? { after } : {}),
        });
        expect(page.total).toBe(5);
        pages.push(keys(page));
        after = page.next;
      } while (after !== null);
      return pages;
    };
    expect(await walk({})).toEqual([
      ['city', 'quote_total'],
      ['site_notes', 'fence_length'],
      ['select_your_fence_type'],
    ]);
    expect(await walk({ sort: 'created_asc' })).toEqual([
      ['select_your_fence_type', 'fence_length'],
      ['site_notes', 'quote_total'],
      ['city'],
    ]);
    // A page that ends exactly on the last match says there is no next one.
    expect((await list(invocation, { limit: '5' })).next).toBeNull();
    expect((await list(invocation, { limit: '4' })).next).not.toBeNull();
  });

  it('keeps its place when fields are created between two pages', async () => {
    const { invocation } = await harborLights();
    const first = await list(invocation, { limit: '2' });
    expect(keys(first)).toEqual(['city', 'quote_total']);
    // Newer than everything: it belongs before the first page, so the second doesn't move.
    await field(invocation, 'added_later');
    const second = await list(invocation, { limit: '2', after: first.next ?? '' });
    expect(keys(second)).toEqual(['site_notes', 'fence_length']);
    expect(second.total).toBe(6);
  });

  it('tells apart fields created a microsecond apart, and in the same microsecond', async () => {
    const invocation = await inBusiness();
    const made = [];
    for (const key of ['a', 'b', 'c', 'd']) made.push(await field(invocation, key));
    const [a, b, c, d] = made;
    if (a === undefined || b === undefined || c === undefined || d === undefined)
      throw new Error('Four fields were made.');
    // c and d share a moment; b is one microsecond before them and a one before b.
    await createdAt(a, '2026-10-01T09:00:00.000001Z');
    await createdAt(b, '2026-10-01T09:00:00.000002Z');
    await createdAt(c, '2026-10-01T09:00:00.000003Z');
    await createdAt(d, '2026-10-01T09:00:00.000003Z');
    const seen: string[] = [];
    let after: string | null | undefined;
    do {
      const page = await list(invocation, { limit: '1', ...(after ? { after } : {}) });
      seen.push(...keys(page));
      after = page.next;
    } while (after !== null);
    // The tie is broken by id, and ids are given in the order fields were made.
    expect(seen).toEqual(['d', 'c', 'b', 'a']);
  });

  it('refuses to start after a field this business does not have', async () => {
    const { invocation, city } = await harborLights();
    const other = await inBusiness();
    const foreign = await field(other, 'theirs');
    await expect(list(invocation, { after: foreign.id })).rejects.toMatchObject({
      issues: [{ path: '/after', code: 'unknown_field' }],
    });
    // Its own, archived or filtered out, is a fine place to start from.
    expect(keys(await list(invocation, { objectKey: 'contact', after: city.id }))).toEqual([
      'site_notes',
      'fence_length',
      'select_your_fence_type',
    ]);
  });
});

describe('another business', () => {
  it('sees only its own fields and counts, and a business must be chosen', async () => {
    const { invocation } = await harborLights();
    const other = await inBusiness();
    await field(other, 'theirs');
    const page = await list(other);
    expect(keys(page)).toEqual(['theirs']);
    expect(page.total).toBe(1);
    expect(page.objects.map((object) => object.fields)).toEqual([0, 1, 0]);
    expect((await list(invocation)).total).toBe(5);
    const { businessId: _businessId, ...atAgency } = invocation.context;
    await expect(list({ ...invocation, context: atAgency })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
