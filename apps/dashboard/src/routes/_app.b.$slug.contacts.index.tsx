import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { getMyPermissions, publicId, type ContactTableColumnKey } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button, buttonVariants } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { EmptyState } from '@repo/ui/components/empty-state';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { CopyCheck, Download, EllipsisVertical, Plus, Trash2, Users } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { apiIn } from '../api';
import type { AddedContact, AddedPart } from '../contact-add-panel';
import { ContactTable } from '../contact-list';
import { CONTACT_COUNT_LIMIT } from '../contact-list-sizes';
import {
  fieldsFor,
  includeFor,
  useContactCount,
  useContactPages,
  type ContactsSearch,
  type ListFilters,
} from '../contact-pages';
import { rememberContactWalk } from '../contact-walk';
import { contactTitle } from '../contact-title';
import {
  filterConditionCount,
  verificationConditionOf,
  verificationFilterOf,
} from '../email-verification/list-filter-rules';
import { fieldListSearch, withoutFieldSearch } from '../field-list-search';
import {
  columnWidthsOf,
  contactColumnKeys,
  contactColumnsOf,
  firstTableColumnKeys,
  isFieldColumn,
  newListColumns,
  widthsShown,
  type ContactColumn,
} from '../list-columns';
import {
  FiltersStep,
  ListFilters as Filters,
  useListFields,
  type AppliedFilters,
} from '../list-filters';
import { filterCount, tableColumnsOf } from '../list-rules';
import { ListSort, SortStep, type BuiltInOrder, type ListOrder } from '../list-sort';
import { CountChip, ListSearch } from '../list-toolbar';
import type { FieldChoice } from '../manage-fields-types';
import { SavedViews } from '../saved-views';
import { usePageTitle } from '../shell/page';
import { useBusiness } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/contacts/');

const AddContactPanel = lazy(() => import('../contact-add-panel'));
// The column chooser, fetched as the list first draws: not part of what the page loads first.
const chooser = () => import('../contact-columns');
const ContactColumnsButton = lazy(async () => ({
  default: (await chooser()).ContactColumnsButton,
}));
const ContactColumnsStep = lazy(async () => ({ default: (await chooser()).ContactColumnsStep }));
// The bulk action bar and its words, fetched when a contact is first ticked: the list
// downloads none of it until then.
const ContactBulkBar = lazy(async () => {
  const [bar, words] = await Promise.all([
    import('../contact-bulk-bar'),
    import('../contact-bulk-words'),
  ]);
  await words.loadContactBulkWords();
  return bar;
});

/**
 * The columns a new list shows: the built-in ones in GoHighLevel's order, but for Email
 * verification, which Manage fields adds.
 */
const allColumns: readonly ContactColumn[] = newListColumns;

export const Route = createFileRoute('/_app/b/$slug/contacts/')({
  validateSearch: (search: Record<string, unknown>): ContactsSearch => {
    // The name is always the first column, whatever order an older address has it in.
    const columns = contactColumnsOf(search['columns']);
    const widths = columnWidthsOf(search['widths']);
    // Kept as it is: the page reads it (list-filter-rules.ts), so what everyone downloads
    // first holds no filter rules.
    const filter = search['filter'];
    return {
      ...fieldListSearch(search),
      ...(typeof search['q'] === 'string' && search['q'].trim() !== ''
        ? { q: search['q'].trim() }
        : {}),
      ...(search['sort'] === 'name' ? { sort: 'name' as const } : {}),
      ...(search['added'] === 'week' || search['added'] === 'month'
        ? { added: search['added'] }
        : {}),
      ...(publicId('saved_view').safeParse(search['view']).success
        ? { view: String(search['view']) }
        : {}),
      ...(typeof filter === 'object' && filter !== null ? { filter } : {}),
      ...(columns === undefined ? {} : { columns }),
      ...(widths === undefined ? {} : { widths }),
      ...(search['add'] === 'contact' ? { add: 'contact' as const } : {}),
    };
  },
  component: ContactsPage,
});

// Each part of the search, changed or left out when it's back to its default, since the
// router keeps no undefined values.
function withQuery(previous: ContactsSearch, q: string): ContactsSearch {
  const { q: _previous, ...rest } = previous;
  return q === '' ? rest : { ...rest, q };
}

/** One order applies to a list: newest first, by name, or by a field in a direction. */
function withOrder(
  previous: ContactsSearch,
  order: ListOrder<ListFilters['sort']>,
): ContactsSearch {
  const { sort: _previous, sortField: _field, fieldOrder: _order, ...rest } = previous;
  if ('field' in order) return { ...rest, sortField: order.field, fieldOrder: order.direction };
  return order.by === 'name' ? { ...rest, sort: order.by } : rest;
}

const DAY = 24 * 60 * 60 * 1000;

/** No contact ticked. */
const noneTicked: ReadonlySet<string> = new Set();

/** How long after typing stops the search runs. */
const SEARCH_DELAY = 250;

function ContactsPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  // Manage Duplicates is in the menu for whoever may manage duplicates (contacts.merge).
  const grants = useQuery({
    queryKey: ['b', business.id, 'my-permissions'],
    queryFn: () => apiIn(business.id).request(getMyPermissions, {}),
    staleTime: 60_000,
  });
  const search = route.useSearch();
  const navigate = route.useNavigate();
  usePageTitle(t`Contacts`);
  // The menus open inside the page's own landmark, as everything on a page is in one.
  const headerRef = useRef<HTMLElement>(null);
  // The Add Contact panel is in the address (?add=contact), so the old "new contact"
  // address can open it. What it added is said above the list, with the way to it.
  const addButtonRef = useRef<HTMLElement | null>(null);
  const [added, setAdded] = useState<AddedContact>();
  // Whether contacts may be added, as the list last said: the button and the panel stay
  // while the list is read again, as it is after each contact added.
  const [canAdd, setCanAdd] = useState(false);
  // The contacts ticked for a bulk action, kept with the list they were ticked in: a list
  // read again, or another one, starts with none.
  const [ticked, setTicked] = useState<{ readonly list: string; readonly ids: Set<string> }>();
  // Every contact the list holds, less the ones unticked since: a bulk action takes the
  // list's search and filters rather than ids, so contacts not yet loaded are in it too.
  // The bar stays once fetched, so what an action came to is still said after it clears.
  const [bulkUsed, setBulkUsed] = useState(false);
  const [everyone, setEveryone] = useState<{
    readonly list: string;
    readonly except: ReadonlySet<string>;
  }>();
  const [text, setText] = useState(search.q ?? '');
  const [previousQuery, setPreviousQuery] = useState(search.q ?? '');
  const query = search.q ?? '';
  // Navigation can change the URL without remounting this page. Reset an old draft
  // before committing effects, while preserving raw text when our own debounce lands.
  if (query !== previousQuery) {
    setPreviousQuery(query);
    if (query !== text.trim()) setText(query);
  }
  // A relative period stays put until the person explicitly opens another view.
  const [opened, setOpened] = useState(() => Date.now());
  const [generation, setGeneration] = useState(0);
  const columns = search.columns ?? allColumns;
  // The Filters panel's Email verification, the one filter this page reads from the address:
  // anything else there is left out of what the list is asked.
  const verification = verificationConditionOf(search.filter);
  const listFilter = verificationFilterOf(verification);
  // The widths a list is saved with: those of the columns it shows.
  const shownWidths = widthsShown(search.widths, columns);

  useEffect(() => {
    const q = text.trim();
    if (q === (search.q ?? '')) return;
    const timer = setTimeout(() => {
      void navigate({
        search: (previous) => withQuery(previous, q),
        replace: true,
      });
    }, SEARCH_DELAY);
    return () => {
      clearTimeout(timer);
    };
  }, [text, search.q, navigate]);

  // The contact fields in use. A field column shows, and is asked for, only while its field
  // is: one archived or deleted since the list was saved drops out.
  const listFields = useListFields('contact');
  const fields = useMemo(() => listFields.data ?? [], [listFields.data]);
  const fieldsKnown = listFields.isSuccess || listFields.isError;
  const include = includeFor(columns);
  const fieldValues = fieldsFor(
    columns.filter((key) => !isFieldColumn(key) || fields.some((field) => field.id === key)),
  );
  const filters = useMemo<ListFilters>(
    () => ({
      ...fieldListSearch(search),
      q: search.q ?? '',
      sort: search.sort ?? 'newest',
      createdFrom:
        search.added === undefined
          ? undefined
          : new Date(opened - (search.added === 'week' ? 7 : 30) * DAY).toISOString(),
      ...(listFilter === undefined ? {} : { filter: listFilter }),
      // Each row carries only what the columns that show need.
      ...(include === undefined ? {} : { include }),
      ...(fieldValues === undefined ? {} : { fields: fieldValues }),
    }),
    [search, opened, include, fieldValues, listFilter],
  );
  // With field columns, the list waits for the fields, so it is read once with their values.
  const pages = useContactPages(business.id, filters, generation, {
    enabled: fieldsKnown || !columns.some(isFieldColumn),
  });
  const listKey = `${JSON.stringify({ ...filters, include: undefined, fields: undefined })}:${String(generation)}`;
  const loadedIds = useMemo(
    () => pages.data?.pages.flatMap((page) => page.items.map((item) => item.id)) ?? [],
    [pages.data],
  );
  const everyoneHere = everyone?.list === listKey ? everyone : undefined;
  const selected = useMemo(
    () =>
      everyoneHere === undefined
        ? ticked?.list === listKey
          ? ticked.ids
          : noneTicked
        : new Set(loadedIds.filter((id) => !everyoneHere.except.has(id))),
    [everyoneHere, ticked, listKey, loadedIds],
  );
  // How many the list holds comes from the server; until it answers, or when it can't,
  // the chip says how many have loaded.
  const counted = useContactCount(business.id, filters, generation).data;
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.locale), [i18n.locale]);
  const unavailableField =
    pages.error instanceof ApiError &&
    pages.error.status === 422 &&
    pages.error.problem.errors?.some((issue) => issue.code === 'unknown_field') === true;
  const first = pages.data?.pages[0];
  if (first !== undefined && first.canManage !== canAdd) setCanAdd(first.canManage);
  const loaded = pages.data?.pages.reduce((count, page) => count + page.items.length, 0) ?? 0;
  const narrowed =
    filters.q !== '' ||
    filters.createdFrom !== undefined ||
    filters.fieldId !== undefined ||
    filters.filter !== undefined;
  const countLimit = numbers.format(CONTACT_COUNT_LIMIT);
  const order: ListOrder<ListFilters['sort']> =
    search.sortField === undefined
      ? { by: filters.sort }
      : { field: search.sortField, direction: search.fieldOrder ?? 'asc' };
  const changeOrder = useCallback(
    (next: ListOrder<ListFilters['sort']>) => {
      void navigate({ search: (previous) => withOrder(previous, next), replace: true });
    },
    [navigate],
  );
  const sortBy = useCallback(
    (by: ListFilters['sort']) => {
      changeOrder({ by });
    },
    [changeOrder],
  );
  // What the toolbar's Filters, Sort and Manage fields change, and the panel that adds or
  // edits a smart list changes too, as its steps: the same forms over the same list.
  const filterValue: AppliedFilters = {
    ...(search.added === undefined ? {} : { added: search.added }),
    ...(search.fieldId === undefined ? {} : { fieldId: search.fieldId }),
    ...(search.fieldOperator === undefined ? {} : { fieldOperator: search.fieldOperator }),
    ...(search.fieldValue === undefined ? {} : { fieldValue: search.fieldValue }),
    ...(verification === undefined ? {} : { emailVerification: verification }),
  };
  const applyFilters = ({ emailVerification, ...value }: AppliedFilters) => {
    const filter = verificationFilterOf(emailVerification);
    void navigate({
      search: ({
        added: _added,
        fieldId: _id,
        fieldOperator: _operator,
        fieldValue: _value,
        filter: _filter,
        ...rest
      }) => ({ ...rest, ...value, ...(filter === undefined ? {} : { filter }) }),
    });
  };
  const orders: readonly [
    BuiltInOrder<ListFilters['sort']>,
    ...BuiltInOrder<ListFilters['sort']>[],
  ] = [
    { key: 'newest', label: t`Created, newest first` },
    { key: 'name', label: t`Contact name, A to Z` },
  ];
  // The built-in columns; the chooser adds the custom fields, each under its folder, as
  // GoHighLevel's Manage fields lists them.
  const columnChoices: readonly FieldChoice<ContactColumn>[] = [
    { key: 'name', label: t`Contact name` },
    { key: 'phone', label: t`Phone` },
    { key: 'email', label: t`Email` },
    { key: 'company', label: t`Business name` },
    { key: 'added', label: t`Created` },
    { key: 'lastActivity', label: t`Last activity` },
    { key: 'tags', label: t`Tags` },
    { key: 'emailVerification', label: t`Email verification` },
  ];
  const applyColumns = (value: ContactColumn[]) => {
    void navigate({
      // A column taken away takes its width with it.
      search: ({ widths, ...previous }) => {
        const kept = columnWidthsOf(
          Object.fromEntries(
            Object.entries(widths ?? {}).filter(([key]) => value.some((each) => each === key)),
          ),
        );
        return { ...previous, columns: value, ...(kept === undefined ? {} : { widths: kept }) };
      },
      replace: true,
    });
  };
  const resizeColumn = (column: ContactColumn, width: number | undefined) => {
    void navigate({
      search: ({ widths, ...previous }) => {
        const { [column]: _old, ...others } = widths ?? {};
        const next = width === undefined ? others : { ...others, [column]: width };
        return Object.keys(next).length === 0 ? previous : { ...previous, widths: next };
      },
      replace: true,
    });
  };
  const { filter: _addressFilter, ...searchState } = search;
  const filtersApplied = filterCount(searchState) + filterConditionCount(listFilter);
  const columnCount = columns.length;
  const orderLabel =
    'field' in order
      ? (fields.find((field) => field.id === order.field)?.label ?? t`Unavailable field`)
      : (orders.find((each) => each.key === order.by)?.label ?? '');
  const closeAdd = () => {
    void navigate({ search: ({ add: _add, ...rest }) => rest, replace: true });
  };
  const partNames: Readonly<Record<AddedPart, string>> = {
    timeZone: t`the time zone`,
    labels: t`the phone labels`,
    dnd: t`do not disturb`,
  };
  const addedName = added === undefined ? '' : (contactTitle(added.contact) ?? t`The contact`);
  const addedMissing = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(
    (added?.missing ?? []).map((part) => partNames[part]),
  );
  // A contact opened from the list can walk it: its page reads the same pages.
  const rememberList = useCallback(() => {
    rememberContactWalk(cache, business.id, { filters, generation, search });
  }, [cache, business.id, filters, generation, search]);

  return (
    <>
      <header ref={headerRef} className="flex min-w-0 flex-col gap-3">
        <h1 className="sr-only">
          <Trans>Contacts</Trans>
        </h1>
        <SavedViews
          key={business.id}
          current={{
            objectKey: 'contact',
            state: {
              ...fieldListSearch(search),
              ...(text.trim() === '' ? {} : { q: text.trim() }),
              ...(search.sort === undefined ? {} : { sort: search.sort }),
              ...(search.added === undefined ? {} : { added: search.added }),
              ...(listFilter === undefined ? {} : { filter: listFilter }),
            },
            // The four columns the first table had, for anything that still reads only those.
            columns: firstTableColumnKeys.filter((key) => columns.includes(key)),
            // The built-in columns alone, for the screens that read only those, and the
            // whole layout with custom fields and the widths columns were dragged to.
            tableColumns: columns.filter(
              (key): key is ContactTableColumnKey => !isFieldColumn(key),
            ),
            columnLayout: [...columns],
            ...(shownWidths === undefined ? {} : { columnWidths: shownWidths }),
          }}
          selectedId={search.view}
          container={headerRef}
          steps={[
            {
              key: 'filters',
              label: t`Filters`,
              ...(filtersApplied === 0 ? {} : { summary: t`${filtersApplied} applied` }),
              render: (back) => (
                <FiltersStep
                  fields={fields}
                  period
                  verification
                  value={filterValue}
                  onCancel={back}
                  onApply={(value) => {
                    applyFilters(value);
                    back();
                  }}
                />
              ),
            },
            {
              key: 'sort',
              label: t`Sort by`,
              summary: orderLabel,
              render: (back) => (
                <SortStep
                  orders={orders}
                  fields={fields}
                  value={order}
                  onChange={changeOrder}
                  onDone={back}
                />
              ),
            },
            {
              key: 'fields',
              label: t`Fields`,
              summary: t`${columnCount} selected`,
              render: (back) => (
                <Suspense fallback={null}>
                  <ContactColumnsStep
                    builtIns={columnChoices}
                    fields={fields}
                    value={columns}
                    onCancel={back}
                    onApply={(value) => {
                      applyColumns(value);
                      back();
                    }}
                  />
                </Suspense>
              ),
            },
          ]}
          onApply={(configuration, view) => {
            if (configuration !== undefined && configuration.objectKey !== 'contact') return;
            setGeneration((previous) => previous + 1);
            setOpened(Date.now());
            const nextQuery = configuration?.state.q ?? '';
            setText((previous) => (previous.trim() === nextQuery ? previous : nextQuery));
            const widths =
              configuration === undefined ? undefined : columnWidthsOf(configuration.columnWidths);
            void navigate({
              search:
                configuration === undefined
                  ? {}
                  : {
                      ...configuration.state,
                      // The whole layout when the list has one, else its built-in columns.
                      columns: contactColumnsOf(configuration.columnLayout) ??
                        tableColumnsOf(
                          configuration.tableColumns ?? configuration.columns,
                          contactColumnKeys,
                        ) ?? [...allColumns],
                      ...(widths === undefined ? {} : { widths }),
                      ...(view === undefined ? {} : { view }),
                    },
            });
          }}
          actions={
            <>
              {canAdd ? (
                <Button
                  onClick={(event) => {
                    addButtonRef.current = event.currentTarget;
                    setAdded(undefined);
                    void navigate({ search: (previous) => ({ ...previous, add: 'contact' }) });
                  }}
                >
                  <Plus aria-hidden className="size-[18px]" strokeWidth={2} />
                  <Trans>Add contact</Trans>
                </Button>
              ) : null}
              {canAdd ? (
                <Link
                  to="/b/$slug/settings/import"
                  params={{ slug: business.slug }}
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  <Download aria-hidden className="size-[18px]" strokeWidth={1.8} />
                  <Trans>Import</Trans>
                </Link>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t`More`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-lg text-body hover:bg-muted hover:text-foreground data-popup-open:bg-muted lg:size-9"
                >
                  <EllipsisVertical aria-hidden className="size-5" strokeWidth={1.8} />
                </DropdownMenuTrigger>
                <DropdownMenuContent container={headerRef} align="end" className="min-w-48">
                  {grants.data?.permissions.includes('contacts.merge') === true ? (
                    <DropdownMenuLinkItem
                      className="min-h-11 lg:min-h-9"
                      render={
                        <Link to="/b/$slug/contacts/duplicates" params={{ slug: business.slug }} />
                      }
                    >
                      <CopyCheck aria-hidden className="size-[18px]" strokeWidth={1.8} />
                      <Trans>Manage Duplicates</Trans>
                    </DropdownMenuLinkItem>
                  ) : null}
                  <DropdownMenuLinkItem
                    className="min-h-11 lg:min-h-9"
                    render={<Link to="/b/$slug/trash" params={{ slug: business.slug }} />}
                  >
                    <Trash2 aria-hidden className="size-[18px]" strokeWidth={1.8} />
                    <Trans>Trash</Trans>
                  </DropdownMenuLinkItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />
        {added === undefined ? null : (
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-sm">
            {added.missing.length === 0 ? (
              <Trans>{addedName} added.</Trans>
            ) : (
              <Trans>
                {addedName} was added, but this wasn't saved: {addedMissing}. Open the contact to
                set it.
              </Trans>
            )}
            <Link
              to="/b/$slug/contacts/$contactId"
              params={{ slug: business.slug, contactId: added.contact.id }}
              className="font-medium text-link underline"
            >
              <Trans>Open contact</Trans>
            </Link>
          </p>
        )}
      </header>
      {search.add === 'contact' && canAdd ? (
        <Suspense fallback={null}>
          <AddContactPanel
            returnFocus={addButtonRef}
            onClose={closeAdd}
            onAdded={(next, another) => {
              setAdded(next);
              // The list is read again, so the new contact is in it.
              setGeneration((previous) => previous + 1);
              if (!another) closeAdd();
            }}
          />
        </Suspense>
      ) : null}
      <section
        aria-label={t`Contacts`}
        className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-3.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Filters
              fields={fields}
              period
              verification
              count={filtersApplied}
              value={filterValue}
              onApply={applyFilters}
            />
            <ListSort orders={orders} fields={fields} value={order} onChange={changeOrder} />
            {pages.data === undefined ? null : (
              <CountChip>
                {counted?.exact === true ? (
                  <Plural value={counted.count} one="# Contact" other="# Contacts" />
                ) : counted !== undefined ? (
                  <Trans>{countLimit}+ Contacts</Trans>
                ) : pages.hasNextPage ? (
                  <Trans>{loaded}+ Contacts</Trans>
                ) : (
                  <Plural value={loaded} one="# Contact" other="# Contacts" />
                )}
              </CountChip>
            )}
          </div>
          <div className="flex min-w-0 flex-1 basis-72 flex-wrap items-center justify-end gap-2">
            <Suspense fallback={null}>
              <ContactColumnsButton
                builtIns={columnChoices}
                fields={fields}
                value={columns}
                onApply={applyColumns}
              />
            </Suspense>
            <ListSearch label={t`Search contacts`} value={text} onChange={setText} />
          </div>
        </div>
        {bulkUsed ? (
          <Suspense fallback={null}>
            <ContactBulkBar
              businessId={business.id}
              slug={business.slug}
              ticked={selected}
              everyone={everyoneHere}
              loaded={loadedIds.length}
              counted={counted}
              list={filters}
              columns={columns}
              fields={fields.map((field) => ({ id: field.id, label: field.label }))}
              onSelectAll={() => {
                setEveryone({ list: listKey, except: new Set() });
              }}
              onClear={() => {
                setTicked(undefined);
                setEveryone(undefined);
              }}
              onDone={() => {
                setTicked(undefined);
                setEveryone(undefined);
                // What the action changed shows: the list is read again.
                setGeneration((previous) => previous + 1);
              }}
            />
          </Suspense>
        ) : null}
        {pages.isPending ? (
          <p role="status">
            <Trans>Loading contacts…</Trans>
          </p>
        ) : pages.isError ? (
          <p role="alert">
            <Trans>We couldn't load the contacts.</Trans>{' '}
            <Button
              variant="quiet"
              onClick={() => {
                void pages.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
            {unavailableField ? (
              <Button
                variant="quiet"
                onClick={() => {
                  void navigate({
                    search: (previous) => withoutFieldSearch(previous),
                    replace: true,
                  });
                }}
              >
                <Trans>Clear field filter and order</Trans>
              </Button>
            ) : null}
          </p>
        ) : loaded === 0 && !narrowed ? (
          <EmptyState
            className="border-0 px-2 py-6"
            icon={<Users strokeWidth={1.8} />}
            title={<Trans>No contacts yet</Trans>}
            description={<Trans>People you add are listed here.</Trans>}
          />
        ) : loaded === 0 ? (
          <p className="px-2 py-4 text-md">
            <Trans>No contacts match this search.</Trans>
          </p>
        ) : (
          <ContactTable
            // A list read again starts from its first page; choosing columns doesn't.
            key={listKey}
            pages={pages}
            count={counted?.exact === true ? counted.count : undefined}
            visibleColumns={columns}
            fields={fields}
            {...(search.widths === undefined ? {} : { widths: search.widths })}
            onResize={resizeColumn}
            sort={search.sortField === undefined ? filters.sort : undefined}
            onSort={sortBy}
            onOpen={rememberList}
            {...(canAdd
              ? {
                  selection: {
                    selected,
                    onChange: (ids: Set<string>) => {
                      setBulkUsed(true);
                      if (everyoneHere === undefined) setTicked({ list: listKey, ids });
                      else
                        setEveryone({
                          list: listKey,
                          except: new Set(loadedIds.filter((id) => !ids.has(id))),
                        });
                    },
                  },
                }
              : {})}
          />
        )}
      </section>
    </>
  );
}
