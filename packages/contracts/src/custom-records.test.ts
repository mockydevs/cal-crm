import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  MAX_CUSTOM_RECORD_FIELDS,
  createCustomRecordInput,
  customRecordEndpoints,
  customRecordSortDirection,
  listCustomRecordsQuery,
  updateCustomRecordInput,
} from './custom-records.js';

const fieldId = toPublicId('field', '01890a5d-ac96-774b-bcce-b30209900001');
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } | undefined }) =>
  result.error?.issues.map((issue) => issue.path.join('/'));

describe('a record of a custom object', () => {
  it('is made from values by field key, with nobody as its owner unless one is named', () => {
    expect(createCustomRecordInput.parse({ fields: { pet_name: 'Buddy' } })).toEqual({
      fields: { pet_name: 'Buddy' },
      owner: null,
    });
    expect(
      createCustomRecordInput.parse({
        fields: { pet_name: 'Buddy', tags: ['a'], vaccinated: true, notes: { first: 'x' } },
        owner: 'me',
      }),
    ).toMatchObject({ owner: 'me' });
  });

  it.each([
    ['a field key out of format', { fields: { 'Pet name': 'Buddy' } }, 'fields/Pet name'],
    ['a value of no field type', { fields: { pet_name: 3 } }, 'fields/pet_name'],
    ['an owner who is no member', { fields: {}, owner: 'someone' }, 'owner'],
    ['anything else', { fields: {}, title: 'Buddy' }, ''],
  ])('refuses %s', (_, input, path) => {
    expect(paths(createCustomRecordInput.safeParse(input))).toContain(path);
  });

  it(`sets at most ${String(MAX_CUSTOM_RECORD_FIELDS)} fields at once`, () => {
    const fields = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, at) => [`f${String(at)}`, 'x']));
    expect(createCustomRecordInput.safeParse({ fields: fields(100) }).success).toBe(true);
    expect(createCustomRecordInput.safeParse({ fields: fields(101) }).success).toBe(false);
  });

  it('changes owner under the revision it was read with', () => {
    expect(
      updateCustomRecordInput.safeParse({ owner: null, revision: 'a'.repeat(64) }).success,
    ).toBe(true);
    expect(paths(updateCustomRecordInput.safeParse({ owner: null }))).toEqual(['revision']);
  });

  it('is listed by a column or by a field, never both, newest first unless told', () => {
    expect(listCustomRecordsQuery.parse({ limit: '20', sort: 'name' })).toEqual({
      limit: 20,
      sort: 'name',
    });
    expect(customRecordSortDirection('name')).toBe('asc');
    expect(customRecordSortDirection('updated')).toBe('desc');
    expect(customRecordSortDirection('created', 'asc')).toBe('asc');
    expect(paths(listCustomRecordsQuery.safeParse({ sort: 'name', sortField: fieldId }))).toContain(
      'sortField',
    );
    expect(paths(listCustomRecordsQuery.safeParse({ direction: 'asc' }))).toEqual(['direction']);
    expect(paths(listCustomRecordsQuery.safeParse({ fieldOperator: 'is_set' }))).toEqual([
      'fieldId',
    ]);
    expect(paths(listCustomRecordsQuery.safeParse({ limit: '101' }))).toEqual(['limit']);
  });

  it('is served under its object, as GoHighLevel’s records API is, under Records', () => {
    expect(
      customRecordEndpoints.map(
        (endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.group}`,
      ),
    ).toEqual([
      'get /objects/{key}/records Records',
      'post /objects/{key}/records Records',
      'get /objects/{key}/records/{id} Records',
      'patch /objects/{key}/records/{id} Records',
      'delete /objects/{key}/records/{id} Records',
      'post /objects/{key}/records/{id}/restore Records',
    ]);
  });
});
