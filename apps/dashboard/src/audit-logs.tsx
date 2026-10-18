// Settings → Audit Logs: who changed what across the business, newest first.
//
// Laid out as GoHighLevel's page. Its help article
// (https://help.gohighlevel.com/support/solutions/articles/155000006667-audit-logs) names
// the filters (user, module, action type, time range) and a panel that opens from a row; it
// does not name the table's columns. Those are as read on the screen itself: Name with the
// record's id under it, Module, Action, Done By, Date & Time, and a "Search by Document ID"
// box, here "Search by record ID". GoHighLevel's panel shows each field before and after,
// and the page has an export: this product stores neither, so neither is drawn. What an
// entry does hold is shown.
//
// The list is `listAudit`'s: the commands that changed something (or, by the last filter,
// the ones refused or failed), fifty a page by cursor, with no total. Reading it needs the
// permission to read audit logs.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  auditActions,
  auditModuleNames,
  auditOutcomes,
  listAudit,
  listTaskAssignees,
  type AuditAction,
  type AuditListEntry,
  type AuditModule,
  type AuditOutcome,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Eye } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';

import { useActorLabel, useEventLabel } from './activity';
import { apiIn } from './api';
import { AuditEntrySummary, useCommandLabel } from './audit-entry';
import {
  auditQueryOf,
  auditRangeBackwards,
  noAuditFilters,
  recordPlace,
  type AuditFilters,
} from './audit-log-rules';
import { linkClassName, RightPanel, sidePanelBodyClassName } from './conversation-extras-panel';
import { ListSearch } from './list-toolbar';
import {
  cellClassName,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from './settings-list';
import { emptyTrail, trailBack, trailCursor, trailForward } from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const ANY = 'any';

/** The words for a module, an action and an outcome, shared by the filters, rows and panel. */
function useAuditWords(): {
  readonly module: (name: AuditListEntry['module']) => string;
  readonly action: (name: AuditAction) => string;
  readonly outcome: (name: AuditOutcome) => string;
} {
  const { t } = useLingui();
  const modules: Readonly<Record<AuditListEntry['module'], string>> = {
    contacts: t`Contacts`,
    companies: t`Companies`,
    opportunities: t`Opportunities`,
    tasks: t`Tasks`,
    notes: t`Notes`,
    tags: t`Tags`,
    custom_fields: t`Custom Fields`,
    custom_values: t`Custom Values`,
    conversations: t`Conversations`,
    calendars: t`Calendars`,
    automations: t`Automation`,
    forms: t`Forms`,
    imports: t`Import Data`,
    team: t`Users`,
    assistant: t`AI assistant`,
    settings: t`Settings`,
    trash: t`Trash`,
    other: t`Other`,
  };
  const actions: Readonly<Record<AuditAction, string>> = {
    created: t`Created`,
    updated: t`Updated`,
    deleted: t`Deleted`,
    restored: t`Restored`,
  };
  const outcomes: Readonly<Record<AuditOutcome, string>> = {
    ok: t`Changes made`,
    denied: t`Refused: no permission`,
    invalid: t`Refused: not valid`,
    failed: t`Failed`,
  };
  return {
    module: (name) => modules[name],
    action: (name) => actions[name],
    outcome: (name) => outcomes[name],
  };
}

export function AuditLogsPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const words = useAuditWords();
  const actorLabel = useActorLabel();
  const commandLabel = useCommandLabel();
  const [filters, setFilters] = useState<AuditFilters>(noAuditFilters);
  const [recordId, setRecordId] = useState('');
  const subject = useSettled(recordId);
  const [trail, setTrail] = useState(emptyTrail);
  const [viewing, setViewing] = useState<AuditListEntry>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const asked: AuditFilters = { ...filters, subject };
  // Another question starts at its first page.
  const askedKey = JSON.stringify(asked);
  const [shownKey, setShownKey] = useState(askedKey);
  if (shownKey !== askedKey) {
    setShownKey(askedKey);
    setTrail(emptyTrail);
  }
  const change = (next: Partial<AuditFilters>) => {
    setFilters({ ...filters, ...next });
  };

  const backwards = auditRangeBackwards(asked);
  const query = auditQueryOf(asked, trailCursor(trail));
  const log = useQuery({
    queryKey: ['b', business.id, 'audit-log', 'business', query],
    queryFn: () => api.request(listAudit, { query }),
    enabled: !backwards,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  // Who a change can be by: the team, as the task lists name it. Without it, only "Me".
  const people = useQuery({
    queryKey: ['b', business.id, 'task-assignees', 'first'],
    queryFn: () => api.request(listTaskAssignees, { query: {} }),
    retry: retryFaults,
  });
  const others = (people.data?.items ?? []).filter((person) => !person.you);

  const forbidden = log.error instanceof ApiError && log.error.status === 403;
  const listed = backwards || log.isError ? undefined : log.data;
  const items = listed?.items ?? [];
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pageNumber = trail.index + 1;
  const turning = log.isFetching && log.isPlaceholderData;
  const narrowed = askedKey !== JSON.stringify(noAuditFilters);

  return (
    <Page title={t`Audit Logs`}>
      <p className="text-md text-muted-foreground">
        <Trans>
          Who changed what in this business, newest first. Open an entry to see what it holds.
        </Trans>
      </p>
      {forbidden ? (
        <p role="alert" className="text-md">
          <Trans>You need permission to read audit logs.</Trans>
        </p>
      ) : (
        <section aria-label={t`Audit log`} className={listCardClassName}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              <Trans>User</Trans>
              <Select
                aria-label={t`User`}
                className="w-auto min-w-40"
                value={filters.member === '' ? ANY : filters.member}
                onValueChange={(value) => {
                  change({ member: value === ANY ? '' : value });
                }}
              >
                <option value={ANY}>{t`Anyone`}</option>
                <option value="me">{t`Me`}</option>
                {others.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name ?? t`Unavailable person`}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              <Trans>Module</Trans>
              <Select
                aria-label={t`Module`}
                className="w-auto min-w-40"
                value={filters.module === '' ? ANY : filters.module}
                onValueChange={(value) => {
                  change({
                    module: auditModuleNames.find((name: AuditModule) => name === value) ?? '',
                  });
                }}
              >
                <option value={ANY}>{t`All modules`}</option>
                {auditModuleNames.map((name) => (
                  <option key={name} value={name}>
                    {words.module(name)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              <Trans>Action</Trans>
              <Select
                aria-label={t`Action`}
                className="w-auto min-w-36"
                value={filters.action === '' ? ANY : filters.action}
                onValueChange={(value) => {
                  change({ action: auditActions.find((name) => name === value) ?? '' });
                }}
              >
                <option value={ANY}>{t`All actions`}</option>
                {auditActions.map((name) => (
                  <option key={name} value={name}>
                    {words.action(name)}
                  </option>
                ))}
              </Select>
            </label>
            <div
              role="group"
              aria-label={t`Date range`}
              className="flex min-w-0 flex-col gap-1.5 text-sm font-medium"
            >
              <span aria-hidden>
                <Trans>Date range</Trans>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  aria-label={t`From day`}
                  className="w-auto"
                  value={filters.from}
                  max={filters.to === '' ? undefined : filters.to}
                  onChange={(event) => {
                    change({ from: event.target.value });
                  }}
                />
                <span aria-hidden className="font-normal text-muted-foreground">
                  <Trans>to</Trans>
                </span>
                <Input
                  type="date"
                  aria-label={t`To day`}
                  className="w-auto"
                  value={filters.to}
                  min={filters.from === '' ? undefined : filters.from}
                  onChange={(event) => {
                    change({ to: event.target.value });
                  }}
                />
              </span>
            </div>
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              <Trans>Show</Trans>
              <Select
                aria-label={t`Show`}
                className="w-auto min-w-44"
                value={filters.outcome}
                onValueChange={(value) => {
                  change({ outcome: auditOutcomes.find((name) => name === value) ?? 'ok' });
                }}
              >
                {auditOutcomes.map((name) => (
                  <option key={name} value={name}>
                    {words.outcome(name)}
                  </option>
                ))}
              </Select>
            </label>
            <div className="ml-auto flex min-w-0 flex-1 basis-56 justify-end">
              <ListSearch
                label={t`Search by record ID`}
                value={recordId}
                onChange={(next) => {
                  setRecordId(next.slice(0, 100));
                }}
              />
            </div>
          </div>
          <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
            <li>
              <Trans>
                A bulk action is listed as Updated whatever it did, deleting included; it names how
                many records it touched, not which.
              </Trans>
            </li>
            <li>
              <Trans>
                A record's ID finds the changes to that record itself: a contact's ID finds changes
                to the contact, not to its tasks, notes or opportunities.
              </Trans>
            </li>
          </ul>
          {backwards ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              <Trans>The range ends before it starts.</Trans>
            </p>
          ) : null}
          {log.isPending && !backwards ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading the audit log…</Trans>
            </p>
          ) : null}
          {log.isError ? (
            <ListProblem
              onRetry={() => {
                if (trail.index > 0) setTrail(emptyTrail);
                else void log.refetch();
              }}
            >
              {log.error instanceof ApiError ? (
                (log.error.problem.errors?.[0]?.message ?? (
                  <Trans>The audit log couldn't be loaded.</Trans>
                ))
              ) : (
                <Trans>The audit log couldn't be loaded.</Trans>
              )}
            </ListProblem>
          ) : null}
          {listed !== undefined && items.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {narrowed ? (
                <Trans>Nothing in the audit log matches.</Trans>
              ) : (
                <Trans>Nothing has been recorded yet.</Trans>
              )}
            </p>
          ) : null}
          {items.length === 0 ? null : (
            <div role="region" aria-label={t`Audit log table`} className={tableRegionClassName}>
              <table className={`${tableClassName} min-w-[960px] table-fixed`}>
                <caption className="sr-only">
                  <Trans>Audit log</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Name</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[15%]`}>
                      <Trans>Module</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[20%]`}>
                      <Trans>Action</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[16%]`}>
                      <Trans>Done By</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-52`}>
                      <Trans>Date & Time ({timeZone})</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-16`}>
                      <span className="sr-only">
                        <Trans>Details</Trans>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((entry) => {
                    const what = commandLabel(entry.command);
                    const when = moment.format(new Date(entry.at));
                    return (
                      <tr key={entry.id} className="hover:bg-muted">
                        <th scope="row" className={`${cellClassName} text-left font-normal`}>
                          <AuditRecord entry={entry} />
                        </th>
                        <td className={cellClassName}>{words.module(entry.module)}</td>
                        <td className={cellClassName}>
                          <span className="flex min-w-0 flex-col">
                            <span className="text-foreground">{words.action(entry.action)}</span>
                            <span className="text-xs wrap-anywhere text-muted-foreground">
                              {what}
                            </span>
                          </span>
                        </td>
                        <td className={`${cellClassName} wrap-anywhere`}>
                          {actorLabel(entry.actor)}
                        </td>
                        <td className={`${cellClassName} whitespace-nowrap`}>
                          <time dateTime={entry.at}>{when}</time>
                        </td>
                        <td className={`${cellClassName} text-right`}>
                          <button
                            type="button"
                            className={iconButtonClassName}
                            aria-label={t`Details of ${what}, ${when}`}
                            onClick={(event) => {
                              returnFocusRef.current = event.currentTarget;
                              setViewing(entry);
                            }}
                          >
                            <Eye aria-hidden className="size-4" strokeWidth={1.8} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {listed === undefined ? null : (
            <nav
              aria-label={t`Pages`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
            >
              <p role="status" aria-busy={turning}>
                <Trans>Page {pageNumber}</Trans>
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Previous page`}
                  disabled={trail.index === 0 || turning}
                  onClick={() => {
                    setTrail(trailBack);
                  }}
                >
                  <Trans>Previous</Trans>
                </Button>
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Next page`}
                  disabled={listed.next === null || turning}
                  onClick={() => {
                    setTrail(trailForward(trail, listed.next));
                  }}
                >
                  <Trans>Next</Trans>
                </Button>
              </div>
            </nav>
          )}
        </section>
      )}

      <RightPanel
        open={viewing !== undefined}
        onClose={() => {
          setViewing(undefined);
        }}
        returnFocus={returnFocusRef}
        title={<Trans>Audit log entry</Trans>}
        description={
          <Trans>What this entry holds. Values before and after a change are not recorded.</Trans>
        }
      >
        {viewing === undefined ? null : (
          <>
            <div className={sidePanelBodyClassName}>
              <p className="flex min-w-0 flex-col gap-1 text-sm">
                <AuditEntrySummary entry={viewing} />
              </p>
              <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">
                  <Trans>Module</Trans>
                </dt>
                <dd>{words.module(viewing.module)}</dd>
                <dt className="text-muted-foreground">
                  <Trans>Action</Trans>
                </dt>
                <dd>{words.action(viewing.action)}</dd>
                <dt className="text-muted-foreground">
                  <Trans>Outcome</Trans>
                </dt>
                <dd className="wrap-anywhere">
                  {words.outcome(viewing.outcome)}
                  {viewing.errorCode === null ? null : (
                    <>
                      {' '}
                      <code className="font-mono text-xs">{viewing.errorCode}</code>
                    </>
                  )}
                </dd>
                <dt className="text-muted-foreground">
                  <Trans>Record</Trans>
                </dt>
                <dd className="min-w-0">
                  <AuditRecord entry={viewing} />
                </dd>
                <dt className="text-muted-foreground">
                  <Trans>Command</Trans>
                </dt>
                <dd>
                  <code className="font-mono text-xs wrap-anywhere">{viewing.command}</code>
                </dd>
                {Object.entries(viewing.detail).map(([name, value]) => (
                  <DetailRow key={name} name={name} value={value} />
                ))}
                <dt className="text-muted-foreground">
                  <Trans>Entry ID</Trans>
                </dt>
                <dd>
                  <code className="font-mono text-xs wrap-anywhere">{viewing.id}</code>
                </dd>
              </dl>
              <AuditEvents entry={viewing} />
            </div>
          </>
        )}
      </RightPanel>
    </Page>
  );
}

/** One named part of a command's input that the log keeps, as it was sent. */
function DetailRow({
  name,
  value,
}: {
  readonly name: string;
  readonly value: unknown;
}): ReactElement {
  return (
    <>
      <dt className="wrap-anywhere text-muted-foreground">{name}</dt>
      <dd className="wrap-anywhere">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
    </>
  );
}

/** What the command reported, oldest first: the events it wrote. */
function AuditEvents({ entry }: { readonly entry: AuditListEntry }): ReactElement | null {
  const { t } = useLingui();
  const eventLabel = useEventLabel();
  if (entry.events.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <h3 className="font-medium text-foreground">
        <Trans>What it reported</Trans>
      </h3>
      <ol aria-label={t`What it reported`} className="flex list-decimal flex-col gap-0.5 pl-5">
        {entry.events.map((event) => (
          <li key={event.id}>{eventLabel(event.type)}</li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What an entry is about: the record's name over its id, as a link while a contact, a
 * company, an opportunity or a task is still there; how many records for a bulk action;
 * and nothing for an attempt that changed none.
 */
function AuditRecord({ entry }: { readonly entry: AuditListEntry }): ReactElement {
  const business = useBusiness();
  const { record, recordCount } = entry;
  if (record === null)
    return recordCount > 1 ? (
      <span className="text-foreground">
        <Plural value={recordCount} one="# record" other="# records" />
      </span>
    ) : (
      <span className="text-muted-foreground">
        <Trans>No record</Trans>
      </span>
    );
  const place = recordPlace(record);
  const kind = record.kind.replace(/_/g, ' ');
  const name = record.name ?? kind;
  const slug = business.slug;
  return (
    <span className="flex min-w-0 flex-col">
      {place === undefined ? (
        <span className="wrap-anywhere text-foreground">
          {name}
          {record.exists === false ? (
            <>
              {' '}
              <span className="text-muted-foreground">
                <Trans>(no longer exists)</Trans>
              </span>
            </>
          ) : null}
        </span>
      ) : place.kind === 'contact' ? (
        <Link
          to="/b/$slug/contacts/$contactId"
          params={{ slug, contactId: place.id }}
          className={`${linkClassName} wrap-anywhere`}
        >
          {name}
        </Link>
      ) : place.kind === 'company' ? (
        <Link
          to="/b/$slug/contacts/companies/$companyId"
          params={{ slug, companyId: place.id }}
          className={`${linkClassName} wrap-anywhere`}
        >
          {name}
        </Link>
      ) : place.kind === 'deal' ? (
        <Link
          to="/b/$slug/deals"
          params={{ slug }}
          search={{ deal: place.id }}
          className={`${linkClassName} wrap-anywhere`}
        >
          {name}
        </Link>
      ) : (
        <Link
          to="/b/$slug/tasks"
          params={{ slug }}
          search={place.name === null ? {} : { q: place.name.slice(0, 200) }}
          className={`${linkClassName} wrap-anywhere`}
        >
          {name}
        </Link>
      )}
      {record.id === null ? null : (
        <code className="font-mono text-xs wrap-anywhere text-muted-foreground">{record.id}</code>
      )}
    </span>
  );
}
