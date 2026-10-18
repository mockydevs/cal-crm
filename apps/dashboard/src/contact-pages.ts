// How the contact list is read: its pages, one after another, and how many contacts it
// holds. On their own, apart from the table that draws them, so a contact's page can walk
// the list it was opened from without carrying the table.
import type {
  ContactCount,
  ContactFilter,
  ContactList,
  ContactViewState,
  FieldListOptions,
} from '@repo/contracts';
import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiIn } from './api';
import { contactListExtras } from './contact-list-sizes';
import { isFieldColumn, type ContactColumn } from './list-columns';

/** The list's endpoints, arriving with the first read rather than with the page. */
const endpoints = () => import('./contact-list-api');

/** The list's search, order, filters and columns, kept in the address so Back and links keep them. */
export interface ContactsSearch extends Omit<ContactViewState, 'filter'> {
  /**
   * The Filters panel's conditions as the address holds them, read by the page
   * (email-verification/list-filter-rules.ts) rather than by the code everyone loads first.
   */
  readonly filter?: unknown;
  readonly view?: string;
  /** The columns the table shows, in order: built-in ones and custom fields. */
  readonly columns?: ContactColumn[];
  /** The widths, in pixels, the person dragged columns to, by column. */
  readonly widths?: Record<string, number>;
  /** The Add Contact panel is open over the list. */
  readonly add?: 'contact';
}

/** What the list shows: a search, an order, contacts added since a moment, and conditions. */
export interface ListFilters extends FieldListOptions {
  readonly q: string;
  readonly sort: 'newest' | 'name';
  /** An ISO timestamp, or undefined for any time. */
  readonly createdFrom: string | undefined;
  /** The Filters panel's conditions, such as Email verification: the server's `filter`. */
  readonly filter?: ContactFilter;
  /** What each row also carries, for the columns that show it: the server's `include`. */
  readonly include?: string;
  /** The custom fields each row answers, for the columns that show them: the server's `fields`. */
  readonly fields?: string;
}

/**
 * What the rows must carry for these columns: last activity, tags and the company are each
 * read only when their column shows.
 */
export function includeFor(columns: readonly ContactColumn[]): string | undefined {
  const extras = contactListExtras.filter((extra) => columns.includes(extra));
  return extras.length === 0 ? undefined : extras.join(',');
}

/** The custom fields these columns show, for the server to answer on each row. */
export function fieldsFor(columns: readonly ContactColumn[]): string | undefined {
  const fields = columns.filter(isFieldColumn);
  return fields.length === 0 ? undefined : fields.join(',');
}

/** Where a list's pages are cached: under its business, its filters and its opening. */
export function contactPagesKey(
  businessId: string,
  filters: ListFilters,
  generation: number,
): readonly unknown[] {
  return ['b', businessId, 'contacts', 'list', filters, generation];
}

/** The pages of the list, loaded one after another. */
export function useContactPages(
  businessId: string,
  filters: ListFilters,
  generation = 0,
  options: { readonly enabled?: boolean; readonly staleTime?: number } = {},
): UseInfiniteQueryResult<InfiniteData<ContactList>> {
  return useInfiniteQuery({
    queryKey: contactPagesKey(businessId, filters, generation),
    ...options,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(businessId).request((await endpoints()).listContacts, {
        query: {
          fieldId: filters.fieldId,
          fieldOperator: filters.fieldOperator,
          fieldValue: filters.fieldValue,
          sortField: filters.sortField,
          fieldOrder: filters.fieldOrder,
          sort: filters.sort,
          ...(filters.q === '' ? {} : { q: filters.q }),
          ...(filters.createdFrom === undefined ? {} : { createdFrom: filters.createdFrom }),
          ...(filters.filter === undefined ? {} : { filter: JSON.stringify(filters.filter) }),
          ...(filters.include === undefined ? {} : { include: filters.include }),
          ...(filters.fields === undefined ? {} : { fields: filters.fields }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });
}

/**
 * How many contacts the list holds, counted by the server with the list's own search and
 * filters. Its order, its columns and its place in the pages don't change the number.
 */
export function useContactCount(
  businessId: string,
  filters: ListFilters,
  generation = 0,
  options: { readonly enabled?: boolean; readonly staleTime?: number } = {},
): UseQueryResult<ContactCount> {
  const narrowing = {
    ...(filters.q === '' ? {} : { q: filters.q }),
    ...(filters.createdFrom === undefined ? {} : { createdFrom: filters.createdFrom }),
    ...(filters.fieldId === undefined ? {} : { fieldId: filters.fieldId }),
    ...(filters.fieldOperator === undefined ? {} : { fieldOperator: filters.fieldOperator }),
    ...(filters.fieldValue === undefined ? {} : { fieldValue: filters.fieldValue }),
    ...(filters.filter === undefined ? {} : { filter: JSON.stringify(filters.filter) }),
  };
  return useQuery({
    queryKey: ['b', businessId, 'contacts', 'count', narrowing, generation],
    // The list still works without its count: the chip then says what has loaded.
    retry: 1,
    ...options,
    queryFn: async () =>
      apiIn(businessId).request((await endpoints()).countContacts, { query: narrowing }),
  });
}
