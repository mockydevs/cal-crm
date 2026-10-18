import { expect, it } from 'vitest';
import {
  company,
  companyList,
  companySortDirection,
  companySorts,
  createCompanyInput,
  isWebAddress,
  listCompaniesQuery,
  MAX_COMPANY_PAGE_SIZE,
  updateCompanyInput,
} from './companies.js';

it('normalizes a plain company domain and rejects URLs, invalid host labels and unknown input', () => {
  expect(createCompanyInput.parse({ name: ' Acme Events ', domain: ' ACME.EXAMPLE ' })).toEqual({
    name: 'Acme Events',
    domain: 'acme.example',
    phone: null,
  });
  for (const domain of [
    'https://acme.example',
    'acme.example/path',
    '-acme.example',
    'acme-.example',
    'acme..example',
    'localhost',
    '127.0.0.1',
  ])
    expect(createCompanyInput.safeParse({ name: 'Acme', domain }).success).toBe(false);
  expect(createCompanyInput.safeParse({ name: '  ' }).success).toBe(false);
  expect(createCompanyInput.safeParse({ name: 'Acme', sourceKind: 'user' }).success).toBe(false);
  expect(updateCompanyInput.parse({ domain: null })).toEqual({ domain: null });
});

// The fields of the Companies table and the orders of its list.
const bare = { name: 'Acme', domain: null, phone: null };

it('leaves a company without the new fields exactly as it was', () => {
  expect(createCompanyInput.parse({ name: 'Acme' })).toEqual(bare);
  expect(updateCompanyInput.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
  expect(updateCompanyInput.parse({})).toEqual({});
  const before = {
    id: 'com_01h455vb4pex5vsknk084sn02q',
    name: 'Acme',
    domain: null,
    phone: null,
    trashedAt: null,
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T09:00:00.000Z',
    canManage: true,
  };
  expect(company.parse(before)).toEqual(before);
  const list = { items: [before], next: null, canManage: true };
  expect(companyList.parse(list)).toEqual(list);
  expect(listCompaniesQuery.parse({})).toEqual({});
  expect(listCompaniesQuery.parse({ q: ' acme ', after: before.id })).toEqual({
    q: 'acme',
    after: before.id,
  });
});

it('reads the email, website, address and description of a company as people write them', () => {
  const written = {
    name: 'Acme',
    email: ' Hello@Acme.Example ',
    website: ' www.acme.example/about ',
    address: ' 12 Riverside Drive ',
    city: ' Nairobi ',
    state: ' Nairobi County ',
    postalCode: ' 00100 ',
    country: ' ke ',
    description: ' Plans weddings.\nAnd conferences. ',
  };
  const read = {
    email: 'hello@acme.example',
    website: 'www.acme.example/about',
    address: '12 Riverside Drive',
    city: 'Nairobi',
    state: 'Nairobi County',
    postalCode: '00100',
    country: 'KE',
    description: 'Plans weddings.\nAnd conferences.',
  };
  expect(createCompanyInput.parse(written)).toEqual({ ...bare, ...read });
  const { name: _name, ...changes } = written;
  expect(updateCompanyInput.parse(changes)).toEqual(read);
  // Null and blank both mean none; the server stores either as null.
  const keys = Object.keys(read);
  const nulls = Object.fromEntries(keys.map((key) => [key, null]));
  const blanks = Object.fromEntries(keys.map((key) => [key, '  ']));
  expect(updateCompanyInput.parse(nulls)).toEqual(nulls);
  expect(updateCompanyInput.parse(blanks)).toEqual(
    Object.fromEntries(keys.map((key) => [key, ''])),
  );
  // Each at its longest.
  expect(
    createCompanyInput.safeParse({
      name: 'Acme',
      email: `${'a'.repeat(64)}@${'b'.repeat(63)}.example`,
      website: `acme.example/${'p'.repeat(1987)}`,
      address: 'a'.repeat(200),
      city: 'c'.repeat(200),
      state: 's'.repeat(200),
      postalCode: '9'.repeat(32),
      description: 'd'.repeat(5000),
    }).success,
  ).toBe(true);
});

it('refuses a company field that is not what it says, or is too long', () => {
  for (const [key, value] of [
    ['email', 'hello'],
    ['email', 'hello@'],
    ['email', 'hello@acme'],
    ['email', `${'a'.repeat(312)}@acme.example`],
    ['website', 'acme'],
    ['website', 'javascript:alert(1)'],
    ['website', 'ftp://acme.example'],
    ['website', 'mailto:hello@acme.example'],
    ['website', 'https://someone:secret@acme.example'],
    ['website', 'www.acme example.com'],
    ['website', `acme.example/${'p'.repeat(1988)}`],
    ['address', 'a'.repeat(201)],
    ['city', 'c'.repeat(201)],
    ['state', 's'.repeat(201)],
    ['postalCode', '9'.repeat(33)],
    ['country', 'KEN'],
    ['country', 'K'],
    ['country', 'Kenya'],
    ['country', 'K1'],
    ['description', 'd'.repeat(5001)],
    ['email', 7],
    ['createdBy', { kind: 'user', name: 'Dana Brooks', you: true }],
  ] as const) {
    expect(createCompanyInput.safeParse({ name: 'Acme', [key]: value }).success, key).toBe(false);
    expect(updateCompanyInput.safeParse({ [key]: value }).success, key).toBe(false);
  }
});

it('takes a web address with or without its scheme, and nothing a browser would not open', () => {
  for (const address of [
    'acme.example',
    'www.acme.example',
    'WWW.Acme.Example/About?ref=1#team',
    'http://acme.example',
    'HTTPS://acme.example:8443/a',
    'shop.acme.co.ke',
  ])
    expect(isWebAddress(address), address).toBe(true);
  for (const address of [
    '',
    'acme',
    'localhost',
    'acme .example',
    'javascript:alert(1)',
    'data:text/html,hello',
    'ftp://acme.example',
    'mailto:hello@acme.example',
    'someone@acme.example',
    'https://someone:secret@acme.example',
    'https://',
    'acme..example',
    '.example',
  ])
    expect(isWebAddress(address), address).toBe(false);
});

it('reads a page size and an order for the company list, and refuses two orders at once', () => {
  expect(listCompaniesQuery.parse({ limit: '25', sort: 'name', direction: 'desc' })).toEqual({
    limit: 25,
    sort: 'name',
    direction: 'desc',
  });
  for (const sort of companySorts) expect(listCompaniesQuery.parse({ sort })).toEqual({ sort });
  expect(listCompaniesQuery.parse({ limit: 1 }).limit).toBe(1);
  expect(listCompaniesQuery.parse({ limit: String(MAX_COMPANY_PAGE_SIZE) }).limit).toBe(100);
  const field = 'fld_01h455vb4pex5vsknk084sn02q';
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { limit: '2.5' },
    { limit: 'many' },
    { sort: 'domain' },
    { sort: 'name', direction: 'up' },
    { direction: 'asc' },
    { sort: 'name', sortField: field },
    { direction: 'asc', sortField: field },
    { q: 'a'.repeat(201) },
    { page: '2' },
  ])
    expect(listCompaniesQuery.safeParse(query).success, JSON.stringify(query)).toBe(false);
  expect(
    listCompaniesQuery
      .safeParse({ direction: 'asc', sortField: field })
      .error?.issues.map((issue) => issue.message),
  ).toEqual(['A field has its own direction: use fieldOrder.']);
  expect(
    listCompaniesQuery.safeParse({ direction: 'asc' }).error?.issues.map((issue) => issue.message),
  ).toEqual(['A direction belongs to a sort: choose one.']);
  // A custom field's order and filter are as they were.
  expect(listCompaniesQuery.parse({ sortField: field, fieldOrder: 'desc', limit: '10' })).toEqual({
    sortField: field,
    fieldOrder: 'desc',
    limit: 10,
  });
});

it('runs the two times newest first and every other order from A unless told otherwise', () => {
  for (const sort of companySorts) {
    expect(companySortDirection(sort)).toBe(
      sort === 'created' || sort === 'updated' ? 'desc' : 'asc',
    );
    expect(companySortDirection(sort, 'asc')).toBe('asc');
    expect(companySortDirection(sort, 'desc')).toBe('desc');
  }
});

it('carries the new fields, who made the company and a total', () => {
  const full = {
    id: 'com_01h455vb4pex5vsknk084sn02q',
    name: 'Acme',
    domain: 'acme.example',
    phone: '+254712345678',
    email: 'hello@acme.example',
    website: 'www.acme.example',
    address: '12 Riverside Drive',
    city: 'Nairobi',
    state: 'Nairobi County',
    postalCode: '00100',
    country: 'KE',
    description: 'Plans weddings.',
    createdBy: { kind: 'user', name: 'Dana Brooks', you: true },
    trashedAt: null,
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T09:00:00.000Z',
    canManage: true,
  };
  expect(company.parse(full)).toEqual(full);
  const list = { items: [full], next: full.id, total: 51, canManage: true };
  expect(companyList.parse(list)).toEqual(list);
  expect(companyList.safeParse({ ...list, total: -1 }).success).toBe(false);
  expect(companyList.safeParse({ ...list, total: 1.5 }).success).toBe(false);
  expect(company.safeParse({ ...full, createdBy: { kind: 'robot', name: null } }).success).toBe(
    false,
  );
});
