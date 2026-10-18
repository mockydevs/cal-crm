// Settings → Phone System → Calling: each connected Twilio account, and whether calling is set
// up on it. Setting up asks Twilio for the key that signs a person's calling token; the
// server does the asking, and this card only starts it and says how it went.
import { Trans, useLingui } from '@lingui/react/macro';
import { listCallingSetups, setUpCalling, type CallingSetup } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, type ReactElement } from 'react';
import { apiIn } from './api';
import { phoneSettingsKey } from './phone-system-parts';
import { retryFaults } from './settings-list';

export const callingSetupsKey = (businessId: string) => ['calling-setups', businessId] as const;

const inProgress = (account: CallingSetup): boolean =>
  account.setup?.status === 'requested' || account.setup?.status === 'creating';

export function CallingSetupCard({ businessId }: { readonly businessId: string }): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const client = apiIn(businessId);
  const accounts = useQuery({
    queryKey: callingSetupsKey(businessId),
    queryFn: () => client.request(listCallingSetups, {}),
    retry: retryFaults,
    // While the worker is asking Twilio, look again shortly; it takes a moment.
    refetchInterval: (query) => (query.state.data?.data.some(inProgress) === true ? 1000 : false),
  });
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={`${id}-title`} className="text-md font-semibold">
          {t`Calling`}
        </h2>
        <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
          <Trans>
            Calls go through your Twilio account. Set up calling once on each account whose numbers
            should make and take calls: it creates a key named “CRM browser calling” in Twilio.
          </Trans>
        </p>
      </div>
      {accounts.isPending ? (
        <p role="status">
          <Trans>Loading your Twilio accounts…</Trans>
        </p>
      ) : accounts.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert">
            <Trans>We couldn't load your Twilio accounts.</Trans>
          </p>
          <Button variant="secondary" onClick={() => void accounts.refetch()}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : accounts.data.data.length === 0 ? (
        <p className="text-md text-muted-foreground">
          <Trans>No Twilio account is connected yet. Connect one below to set up calling.</Trans>
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
          {accounts.data.data.map((account) => (
            <AccountRow key={account.connectionId} businessId={businessId} account={account} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AccountRow({
  businessId,
  account,
}: {
  readonly businessId: string;
  readonly account: CallingSetup;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const client = apiIn(businessId);
  const setUp = useMutation({
    mutationFn: () => client.request(setUpCalling, { params: { id: account.connectionId } }),
    onSettled: async () => {
      await cache.invalidateQueries({ queryKey: callingSetupsKey(businessId) });
      await cache.invalidateQueries({ queryKey: phoneSettingsKey(businessId) });
    },
  });
  const status = account.setup?.status ?? null;
  const badge =
    status === 'ready'
      ? { text: t`Ready`, variant: 'neutral' as const }
      : status === 'requested' || status === 'creating'
        ? { text: t`Setting up…`, variant: 'neutral' as const }
        : status === 'failed'
          ? { text: t`Failed`, variant: 'attention' as const }
          : status === 'unknown'
            ? { text: t`Unconfirmed`, variant: 'attention' as const }
            : { text: t`Not set up`, variant: 'neutral' as const };
  const note =
    account.connectionStatus !== 'connected'
      ? t`This account isn't connected. Connect it again before setting up calling.`
      : status === 'failed'
        ? (account.setup?.failure?.message ?? t`Setting up failed.`)
        : status === 'unknown'
          ? t`Twilio didn't confirm whether the key was created. In Twilio, look under API keys for “CRM browser calling” and delete it if it is there, then set up again.`
          : account.voiceNumbers === 0
            ? t`None of this account's registered numbers can take calls.`
            : null;
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium break-words">{account.label}</span>
          <Badge variant={badge.variant}>{badge.text}</Badge>
        </div>
        {note === null ? null : (
          <p className="max-w-[640px] text-sm leading-relaxed text-muted-foreground">{note}</p>
        )}
        {setUp.isError ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>We couldn't start setting up calling. Try again.</Trans>
          </p>
        ) : null}
      </div>
      {account.canSetUp ? (
        <Button
          variant={status === null ? 'primary' : 'secondary'}
          disabled={setUp.isPending}
          onClick={() => {
            setUp.mutate();
          }}
        >
          {status === null ? t`Set up calling` : t`Set up again`}
        </Button>
      ) : null}
    </li>
  );
}
