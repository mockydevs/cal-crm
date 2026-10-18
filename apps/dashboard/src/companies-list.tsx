// Contacts → Companies (laid out as GoHighLevel's): every company of the business in one
// table, a page at a time as the server pages it. The search, the sortable headings and the
// custom-field controls are what `listCompanies` searches and orders on, and all of them
// are kept in the address. Reading is open to the business; adding and changing a company
// needs the permission the server reports with canManage.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { listCompanies, type Company, type CompanySort } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, Plus } from 'lucide-react';
import { lazy, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useActorLabel } from './activity';
import { apiIn } from './api';
import { companyKey } from './companies';
import {
  countryName,
  listQueryOf,
  narrowed,
  sortOf,
  withFields,
  withSort,
  withText,
} from './company-rules';
import type { CompaniesSearch } from './company-search';
import { linkClassName, RightPanel } from './conversation-extras-panel';
import { FieldListControls } from './field-list-controls';
import { fieldListSearch } from './field-list-search';
import { CountChip, ListSearch, PanelContent } from './list-toolbar';
import {
  cellClassName,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  sortButtonClassName,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import {
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type PageSize,
} from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const CompanyForm = lazy(async () => ({ default: (await import('./company-panel')).CompanyForm }));

interface Opened {
  /** The company to edit, or undefined for a new one. */
  readonly company: Company | undefined;
  /** How many companies "Save and add another" has added since the panel opened. */
  readonly round: number;
}

/** Whether the page asked for was anchored on a company that is no longer there. */
function cursorGone(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.problem.errors?.some((each) => each.path === '/after') === true
  );
}

/**
 * The table's columns after the name, in GoHighLevel's order, each with its width. The
 * table is laid out fixed, so every column has one: with the name's 240px and the actions'
 * 64px they come to the 2368px the table is at least.
 */
const columns: readonly { readonly key: CompanySort; readonly width: string }[] = [
  { key: 'phone', width: 'w-40' },
  { key: 'email', width: 'w-52' },
  { key: 'website', width: 'w-52' },
  { key: 'address', width: 'w-56' },
  { key: 'state', width: 'w-32' },
  { key: 'city', width: 'w-32' },
  { key: 'description', width: 'w-64' },
  { key: 'postalCode', width: 'w-28' },
  { key: 'country', width: 'w-36' },
  { key: 'created', width: 'w-44' },
  { key: 'updated', width: 'w-44' },
  { key: 'createdBy', width: 'w-36' },
];

export function CompaniesPage({
  search,
  onSearch,
}: {
  readonly search: CompaniesSearch;
  /** Changes the address: handed what it holds now, so two quick changes both land. */
  readonly onSearch: (change: (now: CompaniesSearch) => CompaniesSearch) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const actorLabel = useActorLabel();
  const [trail, setTrail] = useState(emptyTrail);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Another list starts at its first page.
  const asked = JSON.stringify(search);
  const [shown, setShown] = useState(asked);
  if (shown !== asked) {
    setShown(asked);
    setTrail(emptyTrail);
  }

  // The words being typed, and the ones last sent to the address once typing paused. A
  // search in the address that is neither came from outside (back, a link): show it.
  const [text, setText] = useState(search.q ?? '');
  const [sentText, setSentText] = useState(search.q ?? '');
  const [seenText, setSeenText] = useState(search.q ?? '');
  const typingRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  if ((search.q ?? '') !== seenText) {
    setSeenText(search.q ?? '');
    if ((search.q ?? '') !== sentText) {
      setText(search.q ?? '');
      setSentText(search.q ?? '');
    }
  }
  useEffect(
    () => () => {
      clearTimeout(typingRef.current);
    },
    [],
  );

  const query = listQueryOf(search, { limit: pageSize, after: trailCursor(trail) });
  const listKey = ['b', business.id, 'companies', 'list', query] as const;
  const companies = useQuery({
    queryKey: listKey,
    queryFn: () => apiIn(business.id).request(listCompanies, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const refused = companies.error instanceof ApiError && companies.error.status === 403;

  const open = (next: Opened, trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    setOpened(next);
    setNotice('');
  };
  const close = (message = '') => {
    setOpened(undefined);
    setNotice(message);
  };

  const listed = companies.data;
  const items = listed?.items ?? [];
  const total = listed?.total;
  const canManage = listed?.canManage === true;
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const turning = companies.isFetching && companies.isPlaceholderData;
  const pageNumber = trail.index + 1;
  const editing = opened?.company;

  const labels = {
    name: <Trans>Company Name</Trans>,
    phone: <Trans>Phone</Trans>,
    email: <Trans>Email</Trans>,
    website: <Trans>Website</Trans>,
    address: <Trans>Address</Trans>,
    state: <Trans>State</Trans>,
    city: <Trans>City</Trans>,
    description: <Trans>Description</Trans>,
    postalCode: <Trans>Postal Code</Trans>,
    country: <Trans>Country</Trans>,
    created: <Trans>Created At</Trans>,
    updated: <Trans>Updated At</Trans>,
    createdBy: <Trans>Created By</Trans>,
  } satisfies Record<CompanySort, ReactNode>;
  const heading = (column: CompanySort, className: string): ReactElement => {
    const sorted = sortOf(search, column);
    return (
      <th
        key={column}
        scope="col"
        aria-sort={sorted}
        className={`${headerCellClassName} ${className}`}
      >
        <button
          type="button"
          className={sortButtonClassName}
          onClick={() => {
            onSearch((now) => withSort(now, column));
          }}
        >
          {labels[column]}
          {sorted === 'ascending' ? (
            <ArrowUp aria-hidden className="size-3.5" strokeWidth={2} />
          ) : sorted === 'descending' ? (
            <ArrowDown aria-hidden className="size-3.5" strokeWidth={2} />
          ) : (
            <ArrowUpDown aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={2} />
          )}
        </button>
      </th>
    );
  };
  const cell = (company: Company, column: CompanySort): ReactNode => {
    if (column === 'created' || column === 'updated') {
      const at = column === 'created' ? company.createdAt : company.updatedAt;
      return <time dateTime={at}>{moment.format(new Date(at))}</time>;
    }
    if (column === 'createdBy')
      return company.createdBy === undefined ? null : actorLabel(company.createdBy);
    const value = company[column] ?? null;
    return column === 'country' && value !== null ? countryName(value, i18n.locale) : value;
  };
  const addButton = (
    <Button
      onClick={(event) => {
        open({ company: undefined, round: 0 }, event.currentTarget);
      }}
    >
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      <Trans>Add Company</Trans>
    </Button>
  );

  return (
    <Page title={t`Companies`} actions={canManage ? addButton : undefined}>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {listed !== undefined && !canManage ? (
        <p className="text-md text-muted-foreground">
          <Trans>
            You can read companies. Adding and changing them needs permission to manage companies.
          </Trans>
        </p>
      ) : null}
      {total === undefined ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <CountChip>
            <Plural value={total} one="# Company" other="# Companies" />
          </CountChip>
        </div>
      )}
      <section aria-label={t`Companies`} className={listCardClassName}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <FieldListControls
              objectKey="company"
              value={fieldListSearch(search)}
              onApply={(value) => {
                onSearch((now) => withFields(now, value));
              }}
            />
          </div>
          <div className="ml-auto flex min-w-0 flex-1 basis-48 justify-end">
            <ListSearch
              label={t`Search companies`}
              value={text}
              onChange={(next) => {
                setText(next);
                clearTimeout(typingRef.current);
                typingRef.current = setTimeout(() => {
                  setSentText(next.trim().slice(0, 200));
                  onSearch((now) => withText(now, next));
                }, 250);
              }}
            />
          </div>
        </div>
        {companies.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading companies…</Trans>
          </p>
        ) : null}
        {refused ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            <Trans>You don't have permission to see this business's companies.</Trans>
          </p>
        ) : companies.isError ? (
          <ListProblem
            onRetry={() => {
              if (cursorGone(companies.error)) setTrail(emptyTrail);
              else void companies.refetch();
            }}
          >
            <Trans>The companies couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {listed !== undefined && items.length === 0 ? (
          narrowed(search) ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              <Trans>No companies match.</Trans>
            </p>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-base font-medium text-foreground">
                <Trans>No Companies yet</Trans>
              </p>
              <p className="text-md text-muted-foreground">
                <Trans>Add a company to group the contacts who work there.</Trans>
              </p>
              {canManage ? addButton : null}
            </div>
          )
        ) : null}
        {items.length === 0 ? null : (
          <div role="region" aria-label={t`Companies table`} className={tableRegionClassName}>
            <table className={`${tableClassName} min-w-[2368px] table-fixed`}>
              <caption className="sr-only">
                <Trans>Companies</Trans>
              </caption>
              <thead>
                <tr>
                  {heading('name', 'w-60')}
                  {columns.map((column) => heading(column.key, column.width))}
                  {canManage ? (
                    <th scope="col" className={`${headerCellClassName} w-16`}>
                      <span className="sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {items.map((company) => {
                  const name = company.name;
                  return (
                    <tr key={company.id} className="hover:bg-muted">
                      <th scope="row" className={`${cellClassName} text-left font-medium`}>
                        <Link
                          to="/b/$slug/contacts/companies/$companyId"
                          params={{ slug: business.slug, companyId: company.id }}
                          className={`${linkClassName} font-medium wrap-anywhere`}
                        >
                          {name}
                        </Link>
                      </th>
                      {columns.map((column) =>
                        column.key === 'description' ? (
                          <td
                            key={column.key}
                            className={`${cellClassName} truncate`}
                            title={company.description ?? undefined}
                          >
                            {company.description}
                          </td>
                        ) : (
                          <td
                            key={column.key}
                            className={`${cellClassName} ${
                              column.key === 'created' || column.key === 'updated'
                                ? 'whitespace-nowrap'
                                : 'wrap-anywhere'
                            }`}
                          >
                            {cell(company, column.key)}
                          </td>
                        ),
                      )}
                      {canManage ? (
                        <td className={`${cellClassName} text-right`}>
                          {company.canManage ? (
                            <button
                              type="button"
                              className={iconButtonClassName}
                              aria-label={t`Edit ${name}`}
                              onClick={(event) => {
                                open({ company, round: 0 }, event.currentTarget);
                              }}
                            >
                              <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                            </button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {listed === undefined ? null : (
          <ListFooter
            perPageLabel={t`Rows per page`}
            pageSize={pageSize}
            onPageSize={(size) => {
              setPageSize(size);
              setTrail(emptyTrail);
            }}
            range={rangeOf({
              index: trail.index,
              pageSize,
              shown: items.length,
              // An answer without its total (the schema lets one by) counts what it has shown.
              total: total ?? 0,
            })}
            number={pageNumber}
            previous={trail.index > 0}
            next={listed.next !== null}
            busy={turning}
            onPrevious={() => {
              setTrail(trailBack);
            }}
            onNext={() => {
              setTrail(trailForward(trail, listed.next));
            }}
          />
        )}
      </section>

      <RightPanel
        open={opened !== undefined}
        onClose={close}
        returnFocus={returnFocusRef}
        title={editing === undefined ? <Trans>Add new Company</Trans> : <Trans>Edit company</Trans>}
      >
        {opened === undefined ? null : (
          <PanelContent>
            <CompanyForm
              key={editing === undefined ? `new:${String(opened.round)}` : editing.id}
              company={editing}
              addedBefore={opened.round > 0}
              onCancel={close}
              onSaved={async (saved, another) => {
                cache.setQueryData(companyKey(business.id, saved.id), saved);
                await cache.invalidateQueries({
                  queryKey: ['b', business.id, 'companies', 'list'],
                });
                if (another) setOpened({ company: undefined, round: opened.round + 1 });
                else close(editing === undefined ? t`Company added.` : t`Company saved.`);
              }}
            />
          </PanelContent>
        )}
      </RightPanel>
    </Page>
  );
}
