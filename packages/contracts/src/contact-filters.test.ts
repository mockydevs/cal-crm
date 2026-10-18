// The shapes of the contact list's filter, order, page size, columns and neighbours. What a
// business has (its fields, tags and team) is checked by the server.
import { toPublicId, ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  contactFilter,
  contactFilterCondition,
  contactFilterFields,
  contactFilterKinds,
  contactFilterOperands,
  contactFilterOperators,
  isContactFilterCustomField,
  MAX_CONTACT_FILTER_CONDITIONS,
  MAX_CONTACT_FILTER_GROUPS,
  MAX_CONTACT_FILTER_VALUES,
  parseContactFilter,
} from './contact-filters.js';
import {
  contactListFieldsOf,
  contactNeighbours,
  contactNeighboursQuery,
  contactSortDirection,
  contactSummary,
  countContactsQuery,
  listContactsQuery,
  MAX_CONTACT_LIST_FIELDS,
} from './contacts.js';
import { contactViewState } from './saved-views.js';

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
const field = toPublicId('field', UUID);
const tag = toPublicId('tag', UUID);
const contactId = toPublicId('contact', UUID);

const issuesOf = (schema: { safeParse: (input: unknown) => unknown }, input: unknown) => {
  const result = schema.safeParse(input) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string; params?: { code?: string } }[] };
  };
  return (result.error?.issues ?? []).map((issue) => ({
    path: issue.path.join('/'),
    code: issue.params?.code,
  }));
};

const one = (condition: unknown) => ({
  match: 'all',
  groups: [{ match: 'all', conditions: [condition] }],
});

describe('a condition', () => {
  it('names an operator for every way of comparing, each with what it needs', () => {
    expect(Object.keys(contactFilterOperands).sort()).toEqual([...contactFilterOperators].sort());
    for (const operators of Object.values(contactFilterKinds))
      for (const operator of operators) expect(contactFilterOperators).toContain(operator);
    for (const kind of Object.values(contactFilterFields))
      expect(Object.keys(contactFilterKinds)).toContain(kind);
  });

  it.for([
    { field: 'firstName', operator: 'is', value: 'Maya' },
    { field: 'email', operator: 'any_of', values: ['a@example.com', 'b@example.com'] },
    { field: 'name', operator: 'is_empty' },
    { field: 'created', operator: 'in_last', days: 30 },
    {
      field: 'created',
      operator: 'between',
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    },
    { field: 'dateOfBirth', operator: 'in_next', days: 7 },
    { field: 'tags', operator: 'all_of', values: [tag] },
    { field: 'owner', operator: 'any_of', values: ['me'] },
    { field: 'dnd', operator: 'enabled', value: 'sms' },
    { field: 'type', operator: 'none_of', values: ['lead'] },
    // A custom field takes any operator here: its type is the server's to know.
    { field, operator: 'gte', value: '10' },
    { field, operator: 'contains', value: 'x' },
  ])('takes %o', (condition) => {
    expect(contactFilterCondition.parse(condition)).toEqual(condition);
  });

  it.for([
    [{ field: 'shoeSize', operator: 'is', value: '9' }, 'field', 'unknown_field'],
    [{ field: 'fld_nothing', operator: 'is', value: '9' }, 'field', 'unknown_field'],
    [{ field: 'firstName', operator: 'gt', value: 'a' }, 'operator', 'invalid_operator'],
    [{ field: 'created', operator: 'is_empty' }, 'operator', 'invalid_operator'],
    [{ field: 'tags', operator: 'contains', value: 'x' }, 'operator', 'invalid_operator'],
    [{ field: 'dnd', operator: 'is', value: 'all' }, 'operator', 'invalid_operator'],
    [{ field: 'firstName', operator: 'is' }, 'value', 'required'],
    [{ field: 'tags', operator: 'any_of' }, 'values', 'required'],
    [{ field: 'created', operator: 'in_last' }, 'days', 'required'],
    [{ field: 'created', operator: 'between', from: '2026-01-01T00:00:00Z' }, 'to', 'required'],
    [{ field: 'created', operator: 'between', to: '2026-01-01T00:00:00Z' }, 'from', 'required'],
    [{ field: 'name', operator: 'is_empty', value: 'x' }, 'value', 'not_taken'],
    [{ field: 'name', operator: 'is', value: 'x', values: ['y'] }, 'values', 'not_taken'],
    [{ field: 'name', operator: 'is', value: 'x', days: 3 }, 'days', 'not_taken'],
    [{ field: 'name', operator: 'is', value: 'x', from: 'a' }, 'from', 'not_taken'],
    [{ field: 'dnd', operator: 'enabled', value: 'fax' }, 'value', 'invalid_channel'],
  ] as const)('refuses %o at %s', ([condition, path, code]) => {
    expect(issuesOf(contactFilterCondition, condition)).toContainEqual({ path, code });
  });

  it('bounds its values, its days and its fields', () => {
    const values = Array.from({ length: MAX_CONTACT_FILTER_VALUES + 1 }, (_, n) => String(n));
    expect(
      contactFilterCondition.safeParse({ field: 'name', operator: 'any_of', values }).success,
    ).toBe(false);
    expect(
      contactFilterCondition.safeParse({ field: 'name', operator: 'any_of', values: [] }).success,
    ).toBe(false);
    for (const days of [0, 3651, 1.5])
      expect(
        contactFilterCondition.safeParse({ field: 'created', operator: 'in_last', days }).success,
      ).toBe(false);
    expect(
      contactFilterCondition.safeParse({ field: 'name', operator: 'is', value: 'x', extra: 1 })
        .success,
    ).toBe(false);
    expect(isContactFilterCustomField(field)).toBe(true);
    expect(isContactFilterCustomField(tag)).toBe(false);
  });
});

describe('a filter', () => {
  const condition = { field: 'firstName', operator: 'is', value: 'Maya' };

  it('is groups of conditions, each all or any', () => {
    const filter = {
      match: 'any',
      groups: [
        { match: 'all', conditions: [condition, { field: 'tags', operator: 'is_empty' }] },
        { match: 'any', conditions: [condition] },
      ],
    };
    expect(contactFilter.parse(filter)).toEqual(filter);
    expect(contactFilter.safeParse({ match: 'all', groups: [] }).success).toBe(false);
    expect(
      contactFilter.safeParse({ match: 'all', groups: [{ match: 'all', conditions: [] }] }).success,
    ).toBe(false);
    expect(
      contactFilter.safeParse({
        match: 'some',
        groups: [{ match: 'all', conditions: [condition] }],
      }).success,
    ).toBe(false);
  });

  it('holds a bounded number of groups and conditions', () => {
    const group = (count: number) => ({
      match: 'all',
      conditions: Array.from({ length: count }, () => condition),
    });
    expect(
      contactFilter.safeParse({ match: 'all', groups: [group(MAX_CONTACT_FILTER_CONDITIONS)] })
        .success,
    ).toBe(true);
    expect(
      issuesOf(contactFilter, {
        match: 'all',
        groups: [group(MAX_CONTACT_FILTER_CONDITIONS), group(1)],
      }),
    ).toContainEqual({ path: 'groups', code: 'too_many_conditions' });
    expect(
      contactFilter.safeParse({
        match: 'all',
        groups: Array.from({ length: MAX_CONTACT_FILTER_GROUPS + 1 }, () => group(1)),
      }).success,
    ).toBe(false);
  });

  it('is read from the filter parameter, with pointers into it', () => {
    expect(parseContactFilter(undefined)).toBeUndefined();
    expect(parseContactFilter(JSON.stringify(one(condition)))).toEqual(one(condition));
    const failure = (text: string) => {
      try {
        parseContactFilter(text);
      } catch (error) {
        if (error instanceof ValidationError) return error.issues;
        throw error;
      }
      return [];
    };
    expect(failure('{')).toEqual([
      { path: '/filter', code: 'invalid_json', message: 'Send the filter as JSON text.' },
    ]);
    expect(failure(JSON.stringify(one({ field: 'firstName', operator: 'is' })))).toMatchObject([
      { path: '/filter/groups/0/conditions/0/value', code: 'required' },
    ]);
    expect(failure('[]')).toMatchObject([{ path: '/filter' }]);
  });
});

describe('the list’s parameters', () => {
  it('take a filter, a direction, a page size and fields, all optional', () => {
    expect(listContactsQuery.parse({})).toEqual({ sort: 'newest' });
    const filter = JSON.stringify(one({ field: 'name', operator: 'is_empty' }));
    expect(
      listContactsQuery.parse({
        filter,
        sort: 'updated',
        direction: 'asc',
        limit: '20',
        fields: field,
      }),
    ).toEqual({ filter, sort: 'updated', direction: 'asc', limit: 20, fields: field });
    expect(countContactsQuery.parse({ filter })).toEqual({ filter });
    for (const limit of ['0', '101', '1.5', 'x'])
      expect(listContactsQuery.safeParse({ limit }).success).toBe(false);
    expect(listContactsQuery.safeParse({ direction: 'up' }).success).toBe(false);
    expect(listContactsQuery.safeParse({ filter: 'x'.repeat(8001) }).success).toBe(false);
    expect(issuesOf(listContactsQuery, { direction: 'asc', sortField: field })).toContainEqual({
      path: 'direction',
      code: 'direction_with_field',
    });
  });

  it('name fields by id, each once, and not too many', () => {
    expect(contactListFieldsOf(undefined)).toEqual([]);
    expect(contactListFieldsOf('')).toEqual([]);
    expect(contactListFieldsOf(`${field},${field}`)).toEqual([field]);
    expect(issuesOf(listContactsQuery, { fields: 'city' })).toContainEqual({
      path: 'fields',
      code: 'invalid_fields',
    });
    const many = Array.from({ length: MAX_CONTACT_LIST_FIELDS + 1 }, (_, n) =>
      toPublicId('field', `01890a5d-ac96-774b-bcce-b302099a80${String(n + 10)}`),
    );
    expect(issuesOf(listContactsQuery, { fields: many.join(',') })).toContainEqual({
      path: 'fields',
      code: 'too_many_fields',
    });
    expect(listContactsQuery.safeParse({ fields: many.slice(1).join(',') }).success).toBe(true);
  });

  it('run names from A and everything else newest first unless told', () => {
    expect(contactSortDirection('name')).toBe('asc');
    expect(contactSortDirection('newest')).toBe('desc');
    expect(contactSortDirection('updated')).toBe('desc');
    expect(contactSortDirection('name', 'desc')).toBe('desc');
    expect(contactSortDirection('newest', 'asc')).toBe('asc');
  });

  it('answer a row with field values only when asked, and a row as it was otherwise', () => {
    const row = {
      id: contactId,
      name: 'Maya',
      email: null,
      phone: null,
      createdAt: '2026-10-07T09:30:00.000Z',
    };
    expect(contactSummary.parse(row)).toEqual(row);
    const fields = { [field]: 'Nairobi', other: null, flag: true, list: ['a'] };
    expect(contactSummary.parse({ ...row, fields })).toEqual({ ...row, fields });
    expect(contactSummary.safeParse({ ...row, fields: { [field]: 5 } }).success).toBe(false);
  });
});

describe("a contact's neighbours", () => {
  it('are asked of a list by its search, filters and order, never by a page', () => {
    expect(contactNeighboursQuery.parse({})).toEqual({ sort: 'newest' });
    expect(contactNeighboursQuery.parse({ q: 'maya', sort: 'name', direction: 'desc' })).toEqual({
      q: 'maya',
      sort: 'name',
      direction: 'desc',
    });
    for (const extra of [{ after: contactId }, { limit: '5' }, { sortField: field }])
      expect(contactNeighboursQuery.safeParse(extra).success).toBe(false);
    expect(contactNeighboursQuery.safeParse({ fieldId: field }).success).toBe(false);
  });

  it('are two contacts or none, and a place from 1', () => {
    const answer = {
      inList: true,
      previous: null,
      next: { id: contactId, name: null },
      position: 1,
    };
    expect(contactNeighbours.parse(answer)).toEqual(answer);
    expect(contactNeighbours.safeParse({ ...answer, position: 0 }).success).toBe(false);
    expect(
      contactNeighbours.parse({ inList: false, previous: null, next: null, position: null }).inList,
    ).toBe(false);
  });
});

describe('a saved contact view', () => {
  it('keeps the filter and the direction with the rest of its state', () => {
    const filter = one({ field: 'tags', operator: 'any_of', values: [tag] });
    expect(contactViewState.parse({ filter, direction: 'desc', sort: 'name' })).toEqual({
      filter,
      direction: 'desc',
      sort: 'name',
    });
    // A state without them is what it always was.
    expect(contactViewState.parse({ q: 'maya' })).toEqual({ q: 'maya' });
    expect(contactViewState.safeParse({ filter: { match: 'all', groups: [] } }).success).toBe(
      false,
    );
    expect(
      contactViewState.safeParse({ direction: 'asc', sortField: field, fieldOrder: 'asc' }).success,
    ).toBe(false);
  });
});
