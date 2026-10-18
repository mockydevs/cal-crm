// An integration's Manage panel, sliding in from the right: each connected account with its
// status, who connected it and when it was last checked, and what can be done with it (make
// it the primary account, check it now, disconnect it); "Add account" for an integration that
// takes several; then what has happened to its accounts, newest first, with older activity a
// page at a time.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  disconnectIntegration,
  getIntegration,
  INTEGRATION_LIMITS,
  listIntegrationActivity,
  testIntegrationConnection,
  updateIntegrationConnection,
  type IntegrationActivity,
  type IntegrationConnection,
  type IntegrationEntry,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { sidePanelBodyClassName } from '../side-panel-classes';
import { ConfirmDialog, ListProblem, retryFaults, returnTo } from '../settings-list';
import { useBusiness } from '../workspace';
import { firstCursors, lastCheckedOf, newestFirst, saidBy, type ActivityCursor } from './rules';
import { useIntegrationsWords } from './words';

export const integrationsKey = (businessId: string) => ['b', businessId, 'integrations'] as const;

interface Older {
  readonly items: readonly IntegrationActivity[];
  /** Where each account's next page starts; none before the first "Older". */
  readonly cursors: readonly ActivityCursor[] | undefined;
}

export function ManagePanel({
  entry,
  onActivity,
  canManage,
  returnFocus,
  onClose,
  onAddAccount,
}: {
  /** The card the panel was opened from, for its name and what it allows. */
  readonly entry: IntegrationEntry;
  /** Opened from the menu's Activity: the keyboard starts on the activity. */
  readonly onActivity: boolean;
  readonly canManage: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onAddAccount: (entry: IntegrationEntry) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const words = useIntegrationsWords();
  const name = words.nameOf(entry);
  const activityId = useId();
  const activityRef = useRef<HTMLHeadingElement>(null);
  const confirmReturnRef = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const [removing, setRemoving] = useState<IntegrationConnection>();
  const [removeProblem, setRemoveProblem] = useState<string>();
  const [older, setOlder] = useState<Older>({ items: [], cursors: undefined });
  const [copied, setCopied] = useState('');

  const detail = useQuery({
    queryKey: [...integrationsKey(business.id), entry.key],
    queryFn: () => api.request(getIntegration, { params: { provider: entry.key } }),
    retry: retryFaults,
  });
  const refresh = (): Promise<void> =>
    cache.invalidateQueries({ queryKey: integrationsKey(business.id) });
  const dateFormat = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const date = (at: string): string => dateFormat.format(new Date(at));

  const params = (connection: IntegrationConnection) => ({
    provider: entry.key,
    id: connection.id,
  });
  const makePrimary = useMutation({
    mutationFn: (connection: IntegrationConnection) =>
      api.request(updateIntegrationConnection, {
        params: params(connection),
        body: { primary: true, revision: connection.revision },
      }),
    onSuccess: async (saved) => {
      await refresh();
      setProblem(undefined);
      const label = saved.accountLabel ?? name;
      setNotice(t`${label} is the primary account now.`);
    },
    onError: (error) => {
      setNotice('');
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t`This connection changed since you opened it.`
          : saidBy(error, t`It wasn't changed. Check your connection and try again.`),
      );
      void refresh();
    },
  });
  const check = useMutation({
    mutationFn: (connection: IntegrationConnection) =>
      api.request(testIntegrationConnection, { params: params(connection) }),
    onSuccess: async () => {
      await refresh();
      setProblem(undefined);
      setNotice(t`Checking the account now. The answer shows in the activity.`);
    },
    onError: (error) => {
      setNotice('');
      setProblem(saidBy(error, t`It wasn't checked. Check your connection and try again.`));
    },
  });
  const disconnect = useMutation({
    mutationFn: (connection: IntegrationConnection) =>
      api.request(disconnectIntegration, { params: params(connection) }),
    onSuccess: async () => {
      await refresh();
      setRemoving(undefined);
      setProblem(undefined);
      setNotice(t`Disconnected.`);
    },
    onError: (error) => {
      setRemoveProblem(
        saidBy(error, t`It wasn't disconnected. Check your connection and try again.`),
      );
    },
  });
  const loadOlder = useMutation({
    mutationFn: async (cursors: readonly ActivityCursor[]) => {
      const pages = await Promise.all(
        cursors.map(async (cursor) => ({
          cursor,
          page: await api.request(listIntegrationActivity, {
            params: { provider: entry.key, id: cursor.connectionId },
            query: { before: cursor.before },
          }),
        })),
      );
      return pages;
    },
    onSuccess: (pages) => {
      setOlder((current) => ({
        items: [...current.items, ...pages.flatMap(({ page }) => page.items)],
        cursors: pages.flatMap(({ cursor, page }) =>
          page.next === null ? [] : [{ connectionId: cursor.connectionId, before: page.next }],
        ),
      }));
    },
  });

  const data = detail.data;
  const connections = data?.entry.connections ?? [];
  const recent = data?.activity ?? [];
  const activity = newestFirst([...recent, ...older.items]);
  const more =
    older.cursors === undefined
      ? recent.length >= INTEGRATION_LIMITS.recentActivity
      : older.cursors.length > 0;
  const may = canManage;
  const removingLabel = removing?.accountLabel ?? name;

  // Opened on its activity: the keyboard starts there once the activity has arrived.
  const arrived = data !== undefined;
  useEffect(() => {
    if (onActivity && arrived) activityRef.current?.focus();
  }, [onActivity, arrived]);

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          finalFocus={returnTo(returnFocus)}
          className="fixed inset-y-0 right-0 z-60 flex w-[min(480px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
            <Dialog.Title className="text-base font-medium wrap-break-word">
              {t`Manage ${name}`}
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <div className={sidePanelBodyClassName}>
            <p role="status" className="sr-only">
              {notice}
            </p>
            {problem === undefined ? null : (
              <p role="alert" className="text-sm font-medium text-destructive">
                {problem}
              </p>
            )}
            {detail.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                <Trans>Loading the accounts…</Trans>
              </p>
            ) : null}
            {detail.isError ? (
              <ListProblem
                onRetry={() => {
                  void detail.refetch();
                }}
              >
                <Trans>The accounts couldn't be loaded.</Trans>
              </ListProblem>
            ) : null}
            {data === undefined ? null : (
              <>
                <section className="flex flex-col gap-3" aria-label={t`Accounts`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">
                      <Trans>Accounts</Trans>
                    </h3>
                    {may && data.entry.multipleAccounts && data.entry.mayManage ? (
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => {
                          onAddAccount(data.entry);
                        }}
                      >
                        <Trans>Add account</Trans>
                      </Button>
                    ) : null}
                  </div>
                  {connections.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No account is connected.</Trans>
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {connections.map((connection) => (
                        <Account
                          key={connection.id}
                          connection={connection}
                          name={name}
                          several={connections.length > 1}
                          may={may}
                          busy={makePrimary.isPending || check.isPending}
                          copied={copied === connection.id}
                          date={date}
                          onPrimary={() => {
                            makePrimary.mutate(connection);
                          }}
                          onCheck={() => {
                            check.mutate(connection);
                          }}
                          onDisconnect={(trigger) => {
                            confirmReturnRef.current = trigger;
                            setRemoveProblem(undefined);
                            setRemoving(connection);
                          }}
                          onCopied={() => {
                            setCopied(connection.id);
                            setNotice(t`Update address copied.`);
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </section>
                <section className="flex flex-col gap-3" aria-labelledby={activityId}>
                  <h3
                    id={activityId}
                    ref={activityRef}
                    tabIndex={-1}
                    className="text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trans>Activity</Trans>
                  </h3>
                  {activity.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Nothing has happened yet.</Trans>
                    </p>
                  ) : (
                    <ol className="flex flex-col divide-y" aria-label={t`Activity`}>
                      {activity.map((each, index) => (
                        <li
                          key={`${each.connectionId}-${each.at}-${String(index)}`}
                          className="flex flex-col gap-0.5 py-2 text-sm"
                        >
                          <span className="font-medium text-foreground">
                            {words.activity[each.kind]}
                          </span>
                          {each.detail === null ? null : (
                            <span className="wrap-anywhere text-body">{each.detail}</span>
                          )}
                          <span className="text-muted-foreground">
                            <time dateTime={each.at}>{date(each.at)}</time>
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {more ? (
                    <Button
                      variant="secondary"
                      size="small"
                      className="w-fit"
                      disabled={loadOlder.isPending}
                      onClick={() => {
                        loadOlder.mutate(
                          older.cursors ??
                            firstCursors(
                              connections.map((each) => each.id),
                              recent,
                            ),
                        );
                      }}
                    >
                      <Trans>Older</Trans>
                    </Button>
                  ) : null}
                  {loadOlder.isError ? (
                    <p role="alert" className="text-sm font-medium text-destructive">
                      <Trans>The older activity couldn't be loaded. Try again.</Trans>
                    </p>
                  ) : null}
                </section>
              </>
            )}
          </div>
          <ConfirmDialog
            open={removing !== undefined}
            title={t`Disconnect ${removingLabel}?`}
            description={t`Its steps stop and it no longer sends anything here. What it already brought in stays.`}
            confirmLabel={t`Disconnect`}
            destructive
            busy={disconnect.isPending}
            problem={removeProblem}
            returnFocus={confirmReturnRef}
            onConfirm={() => {
              if (removing !== undefined) disconnect.mutate(removing);
            }}
            onClose={() => {
              setRemoving(undefined);
            }}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Account({
  connection,
  name,
  several,
  may,
  busy,
  copied,
  date,
  onPrimary,
  onCheck,
  onDisconnect,
  onCopied,
}: {
  readonly connection: IntegrationConnection;
  readonly name: string;
  /** More than one account: one of them is the primary. */
  readonly several: boolean;
  readonly may: boolean;
  readonly busy: boolean;
  readonly copied: boolean;
  readonly date: (at: string) => string;
  readonly onPrimary: () => void;
  readonly onCheck: () => void;
  readonly onDisconnect: (trigger: HTMLElement) => void;
  readonly onCopied: () => void;
}): ReactElement {
  const { t } = useLingui();
  const words = useIntegrationsWords();
  const labelId = useId();
  const addressId = useId();
  const label = connection.accountLabel ?? t`${name} account`;
  const who = connection.connectedBy;
  const when = date(connection.connectedAt);
  const checked = lastCheckedOf(connection);
  const checkedAt = checked === null ? undefined : date(checked);
  const webhookUrl = connection.webhookUrl;
  return (
    <li aria-labelledby={labelId} className="flex flex-col gap-2 rounded-card border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={labelId} className="font-medium wrap-anywhere text-foreground">
          {label}
        </h4>
        {several && connection.primary ? (
          <Badge size="count">
            <Trans>Primary</Trans>
          </Badge>
        ) : null}
      </div>
      <p
        className={
          connection.status === 'needs_attention' ? 'font-medium text-destructive' : 'text-body'
        }
      >
        {words.statuses[connection.status]}
      </p>
      {connection.errorDetail === null ? null : (
        <p className="wrap-anywhere text-destructive">{connection.errorDetail}</p>
      )}
      <p className="text-muted-foreground">
        {who === null ? t`Connected ${when}` : t`Connected by ${who} · ${when}`}
      </p>
      <p className="text-muted-foreground">
        {checkedAt === undefined ? t`Not checked yet` : t`Last checked ${checkedAt}`}
      </p>
      {webhookUrl === null ? null : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={addressId} className="font-medium">
            <Trans>Update address</Trans>
          </label>
          <div className="flex min-w-0 gap-2">
            <Input
              id={addressId}
              readOnly
              value={webhookUrl}
              className="min-w-0 flex-1 font-mono"
            />
            <Button
              variant="secondary"
              size="small"
              aria-label={t`Copy update address`}
              onClick={() => {
                void navigator.clipboard.writeText(webhookUrl).then(onCopied, () => undefined);
              }}
            >
              {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
            </Button>
          </div>
        </div>
      )}
      {may ? (
        <div className="flex flex-wrap gap-2">
          {several && !connection.primary ? (
            <Button variant="secondary" size="small" disabled={busy} onClick={onPrimary}>
              <Trans>Make primary</Trans>
            </Button>
          ) : null}
          <Button variant="secondary" size="small" disabled={busy} onClick={onCheck}>
            <Trans>Check now</Trans>
          </Button>
          <Button
            variant="secondary"
            size="small"
            className="border-destructive text-destructive"
            onClick={(event) => {
              onDisconnect(event.currentTarget);
            }}
          >
            <Trans>Disconnect</Trans>
          </Button>
        </div>
      ) : null}
    </li>
  );
}
