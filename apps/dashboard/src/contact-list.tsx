// The contact list (laid out as GoHighLevel's): pages of 50 from the API, newest first, by
// name or by a field, with a search and filters. A TanStack Table lays out the rows, and
// the footer walks the pages the server gives one after another: each page is asked for
// with the cursor of the one before it, so "Next" loads a page the first time and "Prev"
// shows one already here (contact-pages.ts reads them).
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  ContactActivityChannel,
  ContactList,
  ContactSummary,
  FieldDefinition,
} from '@repo/contracts';
import { Avatar } from '@repo/ui/components/avatar';
import { Button } from '@repo/ui/components/button';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ChevronsUpDown,
  FileText,
  Mail,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import { tintOf } from './avatar-tint';
import { CONTACT_PAGE_SIZE } from './contact-list-sizes';
import type { ListFilters } from './contact-pages';
import { withEmailVerificationWords } from './email-verification/words';
import { isFieldColumn, newListColumns, type ContactColumn } from './list-columns';
import { nameFirst, pageOf, timeSince } from './list-rules';
import { initialsOf, useBusiness } from './workspace';

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, ContactSummary>();
const noContacts: ContactSummary[] = [];

const cellClassName = 'h-[42px] border-t border-border px-3 py-0 align-middle whitespace-nowrap';
const headerClassName =
  'h-10 bg-muted px-3 py-0 text-left align-middle text-xs font-medium whitespace-nowrap text-body';
const sortButtonClassName =
  '-mx-1.5 inline-flex min-h-11 items-center gap-1 rounded-control px-1.5 font-medium -outline-offset-2 hover:text-foreground lg:min-h-8';
const checkboxClassName = 'size-4 shrink-0 accent-primary';
const chipClassName =
  'inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground';

const channelIcons: Readonly<Record<ContactActivityChannel, LucideIcon>> = {
  email: Mail,
  sms: MessageSquare,
  webchat: MessagesSquare,
  form: FileText,
  appointment: CalendarDays,
  other: MessageCircle,
};

/** As many tags as fit a row; the rest are counted, and named in the count's tooltip. */
const TAGS_SHOWN = 2;

const noFields: readonly FieldDefinition[] = [];

// The edges and menus that resize columns, fetched as the table first draws: not part of
// what the list's page loads first.
const resizing = () => import('./column-resizer');
// A custom field's value, as the contact page shows it.
const ContactFieldCell = lazy(() => import('./contact-field-cell'));
// What email verification found of the primary email address, with its words.
const EmailVerificationCell = lazy(() =>
  withEmailVerificationWords(import('./email-verification/list-cell')),
);
const ColumnResizer = lazy(async () => ({ default: (await resizing()).ColumnResizer }));
const ColumnWidthMenu = lazy(async () => ({ default: (await resizing()).ColumnWidthMenu }));
const ResizeHint = lazy(async () => ({ default: (await resizing()).ResizeHint }));

/** A column as wide as it was dragged: no wider, no narrower, whatever its content. */
function widthStyle(width: number | undefined): CSSProperties | undefined {
  return width === undefined ? undefined : { width, minWidth: width, maxWidth: width };
}

export function ContactTable({
  pages,
  count,
  visibleColumns = newListColumns,
  fields = noFields,
  widths,
  onResize,
  sort,
  onSort,
  onOpen,
  selection,
}: {
  readonly pages: UseInfiniteQueryResult<InfiniteData<ContactList>>;
  /** How many contacts the list holds, when the server has counted them all. */
  readonly count: number | undefined;
  /** The columns, in order: built-in ones, and custom fields the rows answer. */
  readonly visibleColumns?: readonly ContactColumn[];
  /** The business's contact fields in use: a field column shows only while its field is. */
  readonly fields?: readonly FieldDefinition[];
  /** The widths, in pixels, columns were dragged to; the others are as wide as their content. */
  readonly widths?: Readonly<Record<string, number>>;
  /**
   * A column was resized, by dragging its edge or with the keyboard, or put back to its
   * content's width (undefined). Left out, columns can't be resized.
   */
  readonly onResize?: (column: ContactColumn, width: number | undefined) => void;
  /** The built-in order the list is in, or undefined when a field orders it. */
  readonly sort: ListFilters['sort'] | undefined;
  readonly onSort: (sort: ListFilters['sort']) => void;
  /** A contact was opened from the list: its page can then walk the list. */
  readonly onOpen?: () => void;
  /**
   * The contacts ticked for a bulk action, and what ticking changes. Left out, the rows
   * have no checkbox: for someone who may not change contacts.
   */
  readonly selection?: {
    readonly selected: ReadonlySet<string>;
    readonly onChange: (next: Set<string>) => void;
  };
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const [index, setIndex] = useState(0);
  // "3 days ago" is counted from when the table was drawn, and again when the list is.
  const [drawn] = useState(() => new Date());
  const loaded = pages.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const pageSize = CONTACT_PAGE_SIZE;
  const paging = pageOf({
    index,
    loaded,
    more: hasNextPage,
    pageSize,
    ...(count === undefined ? {} : { count }),
  });
  const contacts = pages.data?.pages[paging.number - 1]?.items ?? noContacts;

  // A field column shows while its field is in use: an archived or deleted one drops out.
  const shownColumns = useMemo(
    () =>
      nameFirst(visibleColumns).filter(
        (key) => !isFieldColumn(key) || fields.some((field) => field.id === key),
      ),
    [visibleColumns, fields],
  );
  // The width a column is being dragged to, shown before it is let go.
  // How an edge is moved, said once for the table's edges.
  const resizeHintId = useId();
  const [dragging, setDragging] = useState<{ readonly key: string; readonly width: number }>();
  const widthOf = (key: string): number | undefined =>
    dragging?.key === key ? dragging.width : widths?.[key];
  const columns = useMemo(() => {
    const added = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
    const moment = new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const ago = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'always' });
    const channels: Readonly<Record<ContactActivityChannel, string>> = {
      email: t`Email`,
      sms: t`SMS`,
      webchat: t`Web chat`,
      form: t`Form`,
      appointment: t`Appointment`,
      other: t`Message`,
    };
    const showsEmail = shownColumns.includes('email');
    const definitions = {
      name: helper.accessor('name', {
        header: t`Contact name`,
        cell: ({ row }) => {
          const contact = row.original;
          return (
            <span className="flex min-w-0 items-center gap-2">
              {contact.name === null ? (
                <Avatar
                  fallback="?"
                  className="size-6 bg-muted text-[10px] font-medium text-body"
                />
              ) : (
                <Avatar
                  fallback={initialsOf(contact.name, '?')}
                  tint={tintOf(contact.id)}
                  className="size-6 text-[10px] font-medium"
                />
              )}
              <span className="flex min-w-0 flex-col">
                <Link
                  to="/b/$slug/contacts/$contactId"
                  params={{ slug: business.slug, contactId: contact.id }}
                  className="truncate py-0.5 font-medium text-foreground underline-offset-2 hover:text-link hover:underline"
                  onClick={onOpen}
                >
                  {contact.name ?? contact.email ?? contact.phone?.display ?? t`Unnamed contact`}
                </Link>
                {showsEmail && contact.name !== null && contact.email !== null ? (
                  <span className="truncate text-xs text-muted-foreground sm:hidden">
                    {contact.email}
                  </span>
                ) : null}
              </span>
            </span>
          );
        },
      }),
      phone: helper.accessor('phone', {
        header: t`Phone`,
        cell: ({ getValue }) => getValue()?.display,
      }),
      email: helper.accessor('email', { header: t`Email` }),
      company: helper.accessor('company', {
        header: t`Business name`,
        cell: ({ getValue }) => {
          const company = getValue();
          return company === undefined || company === null ? null : (
            <Link
              to="/b/$slug/contacts/companies/$companyId"
              params={{ slug: business.slug, companyId: company.id }}
              className="underline-offset-2 hover:text-link hover:underline"
            >
              {company.name}
            </Link>
          );
        },
      }),
      added: helper.accessor('createdAt', {
        header: t`Created`,
        cell: ({ getValue }) => added.format(new Date(getValue())),
      }),
      lastActivity: helper.accessor('lastActivity', {
        header: t`Last activity`,
        cell: ({ getValue }) => {
          const activity = getValue();
          if (activity === undefined || activity === null) return null;
          const at = new Date(activity.at);
          const since = timeSince(at, drawn);
          const Icon = channelIcons[activity.channel];
          return (
            <span className="inline-flex items-center gap-1.5" title={moment.format(at)}>
              <Icon aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
              {channels[activity.channel]}
              <span aria-hidden>·</span>
              {since.value === 0 ? t`Just now` : ago.format(since.value, since.unit)}
            </span>
          );
        },
      }),
      tags: helper.accessor('tags', {
        header: t`Tags`,
        cell: ({ getValue }) => {
          const tags = getValue() ?? [];
          const more = tags.length - TAGS_SHOWN;
          return tags.length === 0 ? null : (
            <span className="flex items-center gap-1">
              {tags.slice(0, TAGS_SHOWN).map((tag) => (
                <span key={tag.id} className={`${chipClassName} max-w-32 truncate`}>
                  {tag.name}
                </span>
              ))}
              {more > 0 ? (
                <span
                  className={chipClassName}
                  title={tags
                    .slice(TAGS_SHOWN)
                    .map((tag) => tag.name)
                    .join(', ')}
                >
                  <Trans>+{more} more</Trans>
                </span>
              ) : null}
            </span>
          );
        },
      }),
      emailVerification: helper.accessor('emailVerification', {
        header: t`Email verification`,
        cell: ({ getValue }) => {
          const state = getValue();
          // Absent until the row is read with it: nothing is said rather than a guess.
          return state === undefined ? null : (
            <Suspense fallback={null}>
              <EmailVerificationCell state={state} />
            </Suspense>
          );
        },
      }),
    };
    // A custom field's column: its value as the contact page shows it, empty when unset.
    const fieldColumn = (field: FieldDefinition) =>
      helper.accessor((row) => row.fields?.[field.id] ?? null, {
        id: field.id,
        header: field.label,
        cell: ({ getValue }) => {
          const value = getValue();
          return value === null ? null : (
            <Suspense fallback={null}>
              <ContactFieldCell definition={field} value={value} />
            </Suspense>
          );
        },
      });
    const list: (
      (typeof definitions)[keyof typeof definitions] | ReturnType<typeof fieldColumn>
    )[] = [];
    for (const key of shownColumns) {
      if (!isFieldColumn(key)) list.push(definitions[key]);
      else {
        const field = fields.find((each) => each.id === key);
        if (field !== undefined) list.push(fieldColumn(field));
      }
    }
    return helper.columns(list);
  }, [t, i18n.locale, business.slug, shownColumns, fields, onOpen, drawn]);
  const table = useTable({ features, columns, data: contacts, getRowId: (row) => row.id });
  const rows = table.getRowModel().rows;
  // The orders the server has, each in its one direction: by name from A, or newest first.
  const orderOf: Partial<Record<string, { sort: ListFilters['sort']; label: string }>> = {
    name: { sort: 'name', label: t`Sort by contact name, A to Z` },
    createdAt: { sort: 'newest', label: t`Sort by created, newest first` },
  };
  const { number, total } = paging;
  const pageTicked =
    contacts.length > 0 && contacts.every((contact) => selection?.selected.has(contact.id));
  const selectLabel = (contact: ContactSummary): string => {
    const name = contact.name ?? contact.email ?? contact.phone?.display ?? t`Unnamed contact`;
    return t`Select ${name}`;
  };

  return (
    <>
      {onResize === undefined ? null : (
        <Suspense fallback={null}>
          <ResizeHint id={resizeHintId} />
        </Suspense>
      )}
      <div
        role="region"
        aria-label={t`Contacts table`}
        className="max-w-full overflow-x-auto rounded-lg border border-border"
      >
        <table
          className={`w-full border-separate border-spacing-0 text-left text-sm text-body ${shownColumns.length > 4 ? 'min-w-[1040px]' : 'min-w-[720px]'}`}
        >
          <caption className="sr-only">
            <Trans>Contacts</Trans>
          </caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {selection === undefined ? null : (
                  <td className={`${headerClassName} w-10`}>
                    <input
                      type="checkbox"
                      className={checkboxClassName}
                      aria-label={t`Select all contacts on this page`}
                      checked={pageTicked}
                      onChange={(event) => {
                        const next = new Set(selection.selected);
                        for (const contact of contacts)
                          if (event.target.checked) next.add(contact.id);
                          else next.delete(contact.id);
                        selection.onChange(next);
                      }}
                    />
                  </td>
                )}
                {group.headers.map((header) => {
                  const key = header.column.id;
                  const order = orderOf[key];
                  const active = order !== undefined && order.sort === sort;
                  const heading = header.column.columnDef.header;
                  const label = typeof heading === 'string' ? heading : key;
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        active ? (order.sort === 'name' ? 'ascending' : 'descending') : undefined
                      }
                      // Resizable, a header is named by its column alone: its buttons and its
                      // edge would otherwise be read out with every cell under it. Its content
                      // stays clear of the edge's target at the right.
                      {...(onResize === undefined ? {} : { 'aria-label': label })}
                      className={`${headerClassName} relative ${onResize === undefined ? '' : 'pr-7'}`}
                      style={widthStyle(widthOf(key))}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        {order === undefined ? (
                          <span className="min-w-0 truncate">
                            <table.FlexRender header={header} />
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={sortButtonClassName}
                            title={order.label}
                            onClick={() => {
                              onSort(order.sort);
                            }}
                          >
                            <table.FlexRender header={header} />
                            {!active ? (
                              <ChevronsUpDown
                                aria-hidden
                                className="size-3.5 text-muted-foreground"
                                strokeWidth={1.8}
                              />
                            ) : order.sort === 'name' ? (
                              <ArrowUp aria-hidden className="size-3.5" strokeWidth={2} />
                            ) : (
                              <ArrowDown aria-hidden className="size-3.5" strokeWidth={2} />
                            )}
                          </button>
                        )}
                        {onResize === undefined ? null : (
                          <Suspense fallback={null}>
                            <ColumnWidthMenu
                              label={label}
                              width={widths?.[key]}
                              onResize={(width) => {
                                const column = shownColumns.find((each) => each === key);
                                if (column !== undefined) onResize(column, width);
                              }}
                            />
                          </Suspense>
                        )}
                      </span>
                      {onResize === undefined ? null : (
                        <Suspense fallback={null}>
                          <ColumnResizer
                            describedBy={resizeHintId}
                            label={label}
                            width={widths?.[key]}
                            onPreview={(width) => {
                              setDragging(width === undefined ? undefined : { key, width });
                            }}
                            onResize={(width) => {
                              const column = shownColumns.find((each) => each === key);
                              if (column !== undefined) onResize(column, width);
                            }}
                          />
                        </Suspense>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.id} data-index={rowIndex} className="hover:bg-muted">
                {selection === undefined ? null : (
                  <td className={`${cellClassName} w-10`}>
                    <input
                      type="checkbox"
                      className={checkboxClassName}
                      aria-label={selectLabel(row.original)}
                      checked={selection.selected.has(row.id)}
                      onChange={(event) => {
                        const next = new Set(selection.selected);
                        if (event.target.checked) next.add(row.id);
                        else next.delete(row.id);
                        selection.onChange(next);
                      }}
                    />
                  </td>
                )}
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`${cellClassName} ${cell.column.id === 'name' ? 'max-w-80 text-foreground' : 'max-w-64 truncate'}`}
                    style={widthStyle(widthOf(cell.column.id))}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav
        aria-label={t`Pages`}
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
      >
        <p role="status">
          {total === undefined ? (
            <Trans>Page {number}</Trans>
          ) : (
            <Trans>
              Page {number} of {total}
            </Trans>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            <Trans>{pageSize} per page</Trans>
          </span>
          <Button
            variant="quiet"
            size="small"
            aria-label={t`Previous page`}
            disabled={!paging.previous}
            onClick={() => {
              setIndex(number - 2);
            }}
          >
            <Trans>Prev</Trans>
          </Button>
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-control border border-primary font-medium text-link"
          >
            {number}
          </span>
          <Button
            variant="quiet"
            size="small"
            aria-label={t`Next page`}
            aria-busy={isFetchingNextPage}
            disabled={!paging.next || isFetchingNextPage}
            onClick={() => {
              // The page after the one showing: here already, or asked for now and shown
              // once it arrives.
              setIndex(number);
              if (number >= loaded) void fetchNextPage();
            }}
          >
            <Trans>Next</Trans>
          </Button>
        </div>
      </nav>
    </>
  );
}
