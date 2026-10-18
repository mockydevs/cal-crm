// What the Companies screens work out before they draw: the question the list asks the
// server, how a column is sorted and what a press on its heading asks for, a draft as the
// API takes it, and a company's country, website and creator as words and links.
import type { Company, CompanySort, FieldListOptions } from '@repo/contracts';
import { companiesSearchOf, firstDirection, type CompaniesSearch } from './company-search';
import { withoutFieldSearch } from './field-list-search';

/** The question the list asks the server: `listCompanies` searches and orders on these. */
export type CompanyListQuery = FieldListOptions & {
  readonly q?: string;
  readonly sort?: CompanySort;
  readonly direction?: 'asc' | 'desc';
  readonly limit: number;
  readonly after?: string;
};

/** A cursor is only good in the order it was given in, so the order goes with every page. */
export function listQueryOf(
  search: CompaniesSearch,
  page: { readonly limit: number; readonly after: string | undefined },
): CompanyListQuery {
  const { q, sort, direction, ...fields } = search;
  return {
    ...fields,
    ...(q === undefined ? {} : { q }),
    ...(sort === undefined ? {} : { sort, direction: direction ?? firstDirection(sort) }),
    limit: page.limit,
    ...(page.after === undefined ? {} : { after: page.after }),
  };
}

type Sorted = 'ascending' | 'descending' | 'none';

/**
 * How a column is sorted now, in the words `aria-sort` takes. With no order chosen the
 * server lists the newest company first, which is Created At downwards.
 */
export function sortOf(search: CompaniesSearch, column: CompanySort): Sorted {
  if (search.sortField !== undefined) return 'none';
  if (search.sort === undefined) return column === 'created' ? 'descending' : 'none';
  if (search.sort !== column) return 'none';
  return (search.direction ?? firstDirection(column)) === 'desc' ? 'descending' : 'ascending';
}

/**
 * A press on a column's heading: the way the column first sorts, then the other way, then
 * newest first again. A column's order takes the place of a custom field's.
 */
export function withSort(search: CompaniesSearch, column: CompanySort): CompaniesSearch {
  const {
    sortField: _field,
    fieldOrder: _order,
    sort: _sort,
    direction: _direction,
    ...rest
  } = search;
  const first = firstDirection(column);
  const now = sortOf(search, column);
  if (now === 'none') return companiesSearchOf({ ...rest, sort: column });
  const running = now === 'descending' ? 'desc' : 'asc';
  return running === first
    ? companiesSearchOf({ ...rest, sort: column, direction: first === 'asc' ? 'desc' : 'asc' })
    : companiesSearchOf(rest);
}

export function withText(search: CompaniesSearch, q: string): CompaniesSearch {
  return companiesSearchOf({ ...search, q });
}

/** What the field controls applied: their filter and order in place of the ones before. */
export function withFields(search: CompaniesSearch, fields: FieldListOptions): CompaniesSearch {
  return companiesSearchOf({ ...withoutFieldSearch(search), ...fields });
}

/** Whether the list is narrowed, so that an empty one means nothing matched, not none yet. */
export function narrowed(search: CompaniesSearch): boolean {
  return search.q !== undefined || search.fieldId !== undefined;
}

/** What the company panel holds: every field as its box shows it. */
export interface CompanyDraft {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly website: string;
  readonly address: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  /** A two-letter code, or '' for none. */
  readonly country: string;
  readonly description: string;
  readonly domain: string;
}

export const draftKeys = [
  'name',
  'phone',
  'email',
  'website',
  'address',
  'city',
  'state',
  'postalCode',
  'country',
  'description',
  'domain',
] as const satisfies readonly (keyof CompanyDraft)[];

/** The draft a panel opens with: the company's own values, or nothing for a new one. */
export function draftOf(company: Company | undefined): CompanyDraft {
  return {
    name: company?.name ?? '',
    phone: company?.phone ?? '',
    email: company?.email ?? '',
    website: company?.website ?? '',
    address: company?.address ?? '',
    city: company?.city ?? '',
    state: company?.state ?? '',
    postalCode: company?.postalCode ?? '',
    country: company?.country ?? '',
    description: company?.description ?? '',
    domain: company?.domain ?? '',
  };
}

export type CompanyBody = { readonly name: string } & Readonly<
  Record<Exclude<keyof CompanyDraft, 'name'>, string | null>
>;

/** A draft as the API takes it: an empty box is "none", which the API stores as null. */
export function bodyOf(draft: CompanyDraft): CompanyBody {
  const blank = (value: string): string | null => (value.trim() === '' ? null : value);
  return {
    name: draft.name,
    phone: blank(draft.phone),
    email: blank(draft.email),
    website: blank(draft.website),
    address: blank(draft.address),
    city: blank(draft.city),
    state: blank(draft.state),
    postalCode: blank(draft.postalCode),
    country: blank(draft.country),
    description: blank(draft.description),
    domain: blank(draft.domain),
  };
}

/** A country's name where the reader is, or its code when the browser has no name for it. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Where a company's website opens. It is stored as written, with or without its scheme,
 * so one written without gets https; nothing but http and https can come of it.
 */
export function websiteHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}
