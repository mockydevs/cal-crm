import { companySorts, createCompanyInput, updateCompanyInput } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { countryCodes } from './company-countries';
import {
  bodyOf,
  countryName,
  draftKeys,
  draftOf,
  listQueryOf,
  narrowed,
  sortOf,
  websiteHref,
  withFields,
  withSort,
  withText,
} from './company-rules';
import { companiesSearchOf, companySortKeys, firstDirection } from './company-search';

const fieldId = 'fld_01m4bd188ff82s0add91b7pz63';
const first = { limit: 20, after: undefined };

describe('the address of the Companies list', () => {
  it('offers exactly the orders the API takes, in its order', () => {
    expect(companySortKeys).toEqual(companySorts);
  });

  it('keeps only what the list can ask for', () => {
    expect(companiesSearchOf({})).toEqual({});
    expect(companiesSearchOf({ q: '  acme ', sort: 'email', direction: 'desc' })).toEqual({
      q: 'acme',
      sort: 'email',
      direction: 'desc',
    });
    expect(
      companiesSearchOf({ q: '   ', sort: 'owner', direction: 'desc', page: 3, after: 'com_1' }),
    ).toEqual({});
    expect(companiesSearchOf({ q: 'a'.repeat(250) }).q).toHaveLength(200);
  });

  it("leaves out a direction that is the column's own, or that has no column", () => {
    expect(companiesSearchOf({ sort: 'name', direction: 'asc' })).toEqual({ sort: 'name' });
    expect(companiesSearchOf({ sort: 'created', direction: 'desc' })).toEqual({ sort: 'created' });
    expect(companiesSearchOf({ sort: 'updated', direction: 'asc' })).toEqual({
      sort: 'updated',
      direction: 'asc',
    });
    expect(companiesSearchOf({ direction: 'desc' })).toEqual({});
    expect(companiesSearchOf({ sort: 'name', direction: 'down' })).toEqual({ sort: 'name' });
  });

  it("lets a custom field's order take the place of a column's, since the API refuses both", () => {
    expect(
      companiesSearchOf({ sort: 'name', direction: 'desc', sortField: fieldId, fieldOrder: 'asc' }),
    ).toEqual({ sortField: fieldId, fieldOrder: 'asc' });
  });
});

describe('the question the Companies list asks', () => {
  it('asks for a page of every company, newest first, with no order named', () => {
    expect(listQueryOf({}, first)).toEqual({ limit: 20 });
  });

  it('sends the search, the order with its direction, and the cursor', () => {
    expect(listQueryOf({ q: 'acme', sort: 'name' }, { limit: 50, after: 'com_9' })).toEqual({
      q: 'acme',
      sort: 'name',
      direction: 'asc',
      limit: 50,
      after: 'com_9',
    });
    expect(listQueryOf({ sort: 'created' }, first)).toEqual({
      sort: 'created',
      direction: 'desc',
      limit: 20,
    });
    expect(listQueryOf({ sort: 'city', direction: 'desc' }, first)).toEqual({
      sort: 'city',
      direction: 'desc',
      limit: 20,
    });
  });

  it('sends a custom field filter and order as they are, with no column order', () => {
    const search = companiesSearchOf({
      fieldId,
      fieldOperator: 'equals',
      fieldValue: 'Gold',
      sortField: fieldId,
      fieldOrder: 'desc',
    });
    expect(listQueryOf(search, first)).toEqual({ ...search, limit: 20 });
  });
});

describe('the sortable headings of the Companies table', () => {
  it('says Created At runs downwards while no order is chosen', () => {
    expect(sortOf({}, 'created')).toBe('descending');
    expect(sortOf({}, 'name')).toBe('none');
    expect(sortOf({ sortField: fieldId }, 'created')).toBe('none');
  });

  it('says which way the chosen column runs', () => {
    expect(sortOf({ sort: 'name' }, 'name')).toBe('ascending');
    expect(sortOf({ sort: 'name', direction: 'desc' }, 'name')).toBe('descending');
    expect(sortOf({ sort: 'updated' }, 'updated')).toBe('descending');
    expect(sortOf({ sort: 'name' }, 'created')).toBe('none');
  });

  it('goes from A, then from Z, then back to newest first', () => {
    const once = withSort({ q: 'acme' }, 'name');
    expect(once).toEqual({ q: 'acme', sort: 'name' });
    const twice = withSort(once, 'name');
    expect(twice).toEqual({ q: 'acme', sort: 'name', direction: 'desc' });
    expect(withSort(twice, 'name')).toEqual({ q: 'acme' });
  });

  it('turns the times oldest first on the second press', () => {
    expect(firstDirection('updated')).toBe('desc');
    const once = withSort({}, 'updated');
    expect(once).toEqual({ sort: 'updated' });
    expect(withSort(once, 'updated')).toEqual({ sort: 'updated', direction: 'asc' });
    // Created At already runs downwards with no order chosen, so its first press turns it.
    const turned = withSort({}, 'created');
    expect(turned).toEqual({ sort: 'created', direction: 'asc' });
    expect(withSort(turned, 'created')).toEqual({});
  });

  it('moves to another column from its first direction, and drops a custom field order', () => {
    expect(withSort({ sort: 'name', direction: 'desc' }, 'email')).toEqual({ sort: 'email' });
    expect(
      withSort(
        { fieldId, fieldOperator: 'is_set', sortField: fieldId, fieldOrder: 'desc' },
        'city',
      ),
    ).toEqual({ fieldId, fieldOperator: 'is_set', sort: 'city' });
  });
});

describe('searching and filtering the Companies list', () => {
  it('keeps the order when the search changes, and drops an emptied search', () => {
    expect(withText({ sort: 'name' }, ' acme ')).toEqual({ sort: 'name', q: 'acme' });
    expect(withText({ sort: 'name', q: 'acme' }, '')).toEqual({ sort: 'name' });
  });

  it("takes the field controls' filter and order in place of the ones before", () => {
    expect(
      withFields(
        { q: 'acme', sort: 'name', fieldId, fieldOperator: 'is_set' },
        { sortField: fieldId, fieldOrder: 'asc' },
      ),
    ).toEqual({ q: 'acme', sortField: fieldId, fieldOrder: 'asc' });
    expect(withFields({ sort: 'name', fieldId, fieldOperator: 'is_set' }, {})).toEqual({
      sort: 'name',
    });
  });

  it('knows a narrowed list from a whole one', () => {
    expect(narrowed({})).toBe(false);
    expect(narrowed({ sort: 'name' })).toBe(false);
    expect(narrowed({ q: 'acme' })).toBe(true);
    expect(narrowed({ fieldId, fieldOperator: 'is_set' })).toBe(true);
  });
});

describe('a company draft', () => {
  const company = {
    id: 'com_01m4bd188ff82s0add91b7pz63',
    name: 'Acme Events',
    domain: 'acme.example',
    phone: '+254712345678',
    email: 'hello@acme.example',
    website: 'www.acme.example',
    address: '12 Harbour Road',
    city: 'Mombasa',
    state: 'Coast',
    postalCode: '80100',
    country: 'KE',
    description: 'Weddings by the sea.',
    createdBy: { kind: 'user' as const, name: 'Dana Brooks', you: true },
    trashedAt: null,
    createdAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:00.000Z',
    canManage: true,
  };

  it('opens empty for a new company and with every value of a saved one', () => {
    expect(Object.values(draftOf(undefined)).every((value) => value === '')).toBe(true);
    expect(draftOf(company)).toEqual({
      name: 'Acme Events',
      phone: '+254712345678',
      email: 'hello@acme.example',
      website: 'www.acme.example',
      address: '12 Harbour Road',
      city: 'Mombasa',
      state: 'Coast',
      postalCode: '80100',
      country: 'KE',
      description: 'Weddings by the sea.',
      domain: 'acme.example',
    });
    // A company read from a contact's links, or an older stand-in, has none of the new keys.
    expect(
      draftOf({
        id: company.id,
        name: 'Plain',
        domain: null,
        phone: null,
        trashedAt: null,
        createdAt: company.createdAt,
        updatedAt: company.updatedAt,
        canManage: true,
      }),
    ).toEqual({ ...draftOf(undefined), name: 'Plain' });
  });

  it('is a body both the create and the update schema accept, with empty boxes as null', () => {
    const body = bodyOf({ ...draftOf(undefined), name: 'Acme', city: '   ' });
    expect(body).toEqual({
      name: 'Acme',
      phone: null,
      email: null,
      website: null,
      address: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      description: null,
      domain: null,
    });
    expect(createCompanyInput.safeParse(body).success).toBe(true);
    expect(updateCompanyInput.safeParse(bodyOf(draftOf(company))).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual([...draftKeys].sort());
    expect(Object.keys(createCompanyInput.shape).sort()).toEqual([...draftKeys].sort());
  });
});

describe('a company in words and links', () => {
  it("names a country in the reader's language, or shows a code nobody names", () => {
    expect(countryName('KE', 'en')).toBe('Kenya');
    expect(countryName('KE', 'fr')).toBe('Kenya');
    expect(countryName('DE', 'fr')).toBe('Allemagne');
    expect(countryName('not a code', 'en')).toBe('not a code');
  });

  it('offers every assigned country code once, each with a name', () => {
    expect(countryCodes).toHaveLength(249);
    expect(new Set(countryCodes).size).toBe(249);
    expect(countryCodes.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(countryCodes.filter((code) => countryName(code, 'en') === code)).toEqual([]);
  });

  it('opens a website written without its scheme over https, and never another scheme', () => {
    expect(websiteHref('www.acme.example')).toBe('https://www.acme.example');
    expect(websiteHref('http://acme.example/about')).toBe('http://acme.example/about');
    expect(websiteHref('HTTPS://acme.example')).toBe('HTTPS://acme.example');
    expect(websiteHref('javascript:alert(1)')).toBe('https://javascript:alert(1)');
  });
});
