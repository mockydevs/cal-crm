// Settings → Integrations, laid out as GoHighLevel's: a large title and one line, a search,
// category chips, and a grid of cards, the last of which points to the App Marketplace.
// Cards connected on this page connect with the provider's sign-in or a pasted key; the
// others live on a page of their own, which their button opens. While an account is being
// checked the page asks again every two seconds. The provider's sign-in sends the browser
// back here with its outcome in the address: the page says it once, then clears the address.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  connectIntegration,
  disconnectIntegration,
  listIntegrations,
  type IntegrationConnection,
  type IntegrationConnectOutcome,
  type IntegrationEntry,
} from '@repo/contracts';
import { cn } from '@repo/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Store } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { ListSearch } from '../list-toolbar';
import { ConfirmDialog, ListProblem, retryFaults } from '../settings-list';
import { Page } from '../shell/page';
import { meQuery, useBusiness } from '../workspace';
import { IntegrationCard, type CardActions } from './card';
import { KeyDialog } from './key-dialog';
import { leaveFor } from './leave';
import { integrationsKey, ManagePanel } from './manage-panel';
import { anyConnecting, chipsOf, outcomeOf, saidBy, shownOf, type Chip } from './rules';
import { useIntegrationsWords } from './words';

/** How often the page asks again while an account is being checked. */
const CHECKING_INTERVAL_MS = 2000;

interface Arrival {
  readonly key: string;
  readonly outcome: IntegrationConnectOutcome;
}

interface Managing {
  readonly key: string;
  readonly activity: boolean;
}

interface Removing {
  readonly entry: IntegrationEntry;
  readonly connection: IntegrationConnection;
}

export default function IntegrationsPage({
  integration,
  outcome,
  onArrived,
}: {
  /** The integration the provider's sign-in came back for, from the address. */
  readonly integration?: string | undefined;
  readonly outcome?: string | undefined;
  /** Clears the address once its outcome has been read. */
  readonly onArrived: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const words = useIntegrationsWords();
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const [managing, setManaging] = useState<Managing>();
  const [keying, setKeying] = useState<IntegrationEntry>();
  const [removing, setRemoving] = useState<Removing>();
  const [removeProblem, setRemoveProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [arrival] = useState((): Arrival | undefined => {
    const said = outcomeOf(outcome);
    return said === undefined ? undefined : { key: integration ?? '', outcome: said };
  });

  useEffect(() => {
    if (integration !== undefined || outcome !== undefined) onArrived();
  }, [integration, outcome, onArrived]);

  const me = useQuery(meQuery);
  const list = useQuery({
    queryKey: integrationsKey(business.id),
    queryFn: () => api.request(listIntegrations, {}),
    retry: retryFaults,
    refetchInterval: (query) =>
      query.state.data !== undefined && anyConnecting(query.state.data.entries)
        ? CHECKING_INTERVAL_MS
        : false,
  });
  const refresh = (): Promise<void> =>
    cache.invalidateQueries({ queryKey: integrationsKey(business.id) });

  const connect = useMutation({
    mutationFn: (entry: IntegrationEntry) =>
      api.request(connectIntegration, { params: { provider: entry.key }, body: {} }),
    onSuccess: async (started) => {
      if (started.authorizeUrl !== null) {
        leaveFor(started.authorizeUrl);
        return;
      }
      await refresh();
    },
    onError: (error) => {
      setNotice('');
      setProblem(saidBy(error, t`It couldn't be connected. Check your connection and try again.`));
    },
  });
  const disconnect = useMutation({
    mutationFn: ({ entry, connection }: Removing) =>
      api.request(disconnectIntegration, { params: { provider: entry.key, id: connection.id } }),
    onSuccess: async (_, { entry }) => {
      await refresh();
      setRemoving(undefined);
      setProblem(undefined);
      const name = words.nameOf(entry);
      setNotice(t`${name} was disconnected.`);
    },
    onError: (error) => {
      setRemoveProblem(
        saidBy(error, t`It wasn't disconnected. Check your connection and try again.`),
      );
    },
  });

  const startConnect = (entry: IntegrationEntry): void => {
    setProblem(undefined);
    if (entry.auth === 'api_key') setKeying(entry);
    else connect.mutate(entry);
  };
  const actions: CardActions = {
    remember: (trigger) => {
      returnFocusRef.current = trigger;
    },
    onConnect: startConnect,
    onManage: (entry, activity) => {
      setManaging({ key: entry.key, activity });
    },
    onDisconnect: (entry, connection) => {
      setRemoveProblem(undefined);
      setRemoving({ entry, connection });
    },
  };

  const data = list.data;
  const entries = data?.entries ?? [];
  const canManage = data?.canManage === true;
  const agencyStaff = me.data?.agencyStaff === true;
  const chips = chipsOf(entries);
  const current = chips.includes(chip) ? chip : 'all';
  const shown = shownOf(
    entries,
    current,
    search,
    (entry) => `${words.nameOf(entry)} ${words.descriptionOf(entry)}`,
  );
  const chipName = (each: Chip): string =>
    each === 'all' ? t`All` : each === 'connected' ? t`Connected` : words.categories[each];
  const managed = entries.find((each) => each.key === managing?.key);
  const arrivedFor = entries.find((each) => each.key === arrival?.key);
  const arrivalSaid =
    arrival === undefined || (data === undefined && arrival.outcome !== 'expired')
      ? ''
      : words.outcome(
          arrival.outcome,
          arrivedFor === undefined ? arrival.key : words.nameOf(arrivedFor),
        );
  const said = notice === '' ? arrivalSaid : notice;
  const removingName = removing === undefined ? '' : words.nameOf(removing.entry);

  return (
    <Page title={t`Integrations`}>
      <p className="text-md text-muted-foreground">
        <Trans>Connect the tools your business already uses.</Trans>
      </p>
      <p
        role="status"
        className={
          said === '' ? 'sr-only' : 'rounded-card border bg-card px-4 py-3 text-sm text-foreground'
        }
      >
        {said}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      {list.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the integrations…</Trans>
        </p>
      ) : null}
      {list.isError ? (
        <ListProblem
          onRetry={() => {
            void list.refetch();
          }}
        >
          <Trans>The integrations couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {data === undefined ? null : (
        <div className="flex flex-col gap-4">
          {canManage ? null : (
            <p className="text-md text-muted-foreground">
              <Trans>You need permission to manage integrations.</Trans>
            </p>
          )}
          <ListSearch label={t`Search integrations`} value={search} onChange={setSearch} />
          <div role="group" aria-label={t`Categories`} className="flex flex-wrap gap-2">
            {chips.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={each === current}
                className="inline-flex min-h-11 items-center rounded-full border border-input bg-card px-3 text-sm font-medium text-body -outline-offset-2 hover:bg-muted aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-link lg:min-h-8"
                onClick={() => {
                  setChip(each);
                }}
              >
                {chipName(each)}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              <Trans>No integrations match.</Trans>
            </p>
          ) : null}
          <ul
            aria-label={t`Integrations`}
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          >
            {shown.map((entry) => (
              <li key={entry.key} className="min-w-0">
                <IntegrationCard
                  entry={entry}
                  slug={business.slug}
                  canManage={canManage}
                  agencyStaff={agencyStaff}
                  busy={connect.isPending && connect.variables.key === entry.key}
                  actions={actions}
                />
              </li>
            ))}
            <li className="min-w-0">
              <Link
                to="/b/$slug/app-marketplace"
                params={{ slug: business.slug }}
                className={cn(
                  'flex h-full min-h-32 flex-col items-center justify-center gap-2 rounded-card border border-dashed p-4 text-center text-sm font-medium text-link',
                  'hover:bg-accent',
                )}
              >
                <Store aria-hidden className="size-6" strokeWidth={1.8} />
                <Trans>Find more in App Marketplace</Trans>
              </Link>
            </li>
          </ul>
        </div>
      )}
      {managed === undefined || managing === undefined ? null : (
        <ManagePanel
          entry={managed}
          onActivity={managing.activity}
          canManage={canManage}
          returnFocus={returnFocusRef}
          onClose={() => {
            setManaging(undefined);
          }}
          onAddAccount={startConnect}
        />
      )}
      {keying === undefined ? null : (
        <KeyDialog
          integrationKey={keying.key}
          name={words.nameOf(keying)}
          returnFocus={returnFocusRef}
          onClose={() => {
            setKeying(undefined);
          }}
          onConnected={() => {
            const name = words.nameOf(keying);
            setKeying(undefined);
            setNotice(t`${name} is connected. Checking the account…`);
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== undefined}
        title={t`Disconnect ${removingName}?`}
        description={t`Its steps stop and it no longer sends anything here. What it already brought in stays.`}
        confirmLabel={t`Disconnect`}
        destructive
        busy={disconnect.isPending}
        problem={removeProblem}
        returnFocus={returnFocusRef}
        onConfirm={() => {
          if (removing !== undefined) disconnect.mutate(removing);
        }}
        onClose={() => {
          setRemoving(undefined);
        }}
      />
    </Page>
  );
}
