// What the Companies list keeps in its address, and the plain checks that read it. Apart
// from the other rules (company-rules.ts) because the route reads its address before the
// list's code arrives: only this much is in the first load, and no contract schema of a
// company is read here.
import type { CompanySort, FieldListOptions } from '@repo/contracts';
import { fieldListSearch } from './field-list-search';

/** The orders `listCompanies` takes, one for each column, in the table's order. */
export const companySortKeys = [
  'name',
  'phone',
  'email',
  'website',
  'address',
  'state',
  'city',
  'description',
  'postalCode',
  'country',
  'created',
  'updated',
  'createdBy',
] as const satisfies readonly CompanySort[];

/** Which way a column runs when first pressed: the two times newest first, the rest from A. */
export const firstDirection = (sort: CompanySort): 'asc' | 'desc' =>
  sort === 'created' || sort === 'updated' ? 'desc' : 'asc';

/** What the address keeps: only what differs from every company, newest first. */
export type CompaniesSearch = FieldListOptions & {
  /** Part of a name, email address, phone number, website or domain. */
  readonly q?: string;
  readonly sort?: CompanySort;
  /** Kept only when it is not the way the column first sorts. */
  readonly direction?: 'asc' | 'desc';
};

const isSort = (value: unknown): value is CompanySort =>
  typeof value === 'string' && (companySortKeys as readonly string[]).includes(value);

/**
 * One order applies to a list (the server refuses two): a custom field's order, chosen in
 * the field controls, comes before a column's.
 */
export function companiesSearchOf(search: Record<string, unknown>): CompaniesSearch {
  const fields = fieldListSearch(search);
  const { q, sort, direction } = search;
  const text = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  const sorted = fields.sortField === undefined && isSort(sort) ? sort : undefined;
  return {
    ...fields,
    ...(text === '' ? {} : { q: text }),
    ...(sorted === undefined ? {} : { sort: sorted }),
    ...(sorted !== undefined &&
    (direction === 'asc' || direction === 'desc') &&
    direction !== firstDirection(sorted)
      ? { direction }
      : {}),
  };
}
