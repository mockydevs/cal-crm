import { Trans, useLingui } from '@lingui/react/macro';
import { getMailboxSetup, requestMailboxCheck, type MailboxSetupCheck } from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

function CopyRecordValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  const { t } = useLingui();
  const [message, setMessage] = useState<string>();
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(t`Copied.`);
    } catch {
      setMessage(t`Copying didn’t work: select the value and copy it.`);
    }
  }
  return (
    <>
      <Button
        variant="quiet"
        aria-label={t`Copy ${label} record value`}
        onClick={() => {
          void copy();
        }}
      >
        <Trans>Copy</Trans>
      </Button>
      {message === undefined ? null : <p role="status">{message}</p>}
    </>
  );
}

export function EmailChecks({
  client,
  businessId,
  mailboxId,
  mailboxName,
  active,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly mailboxId: string;
  /** Names the section, so each mailbox's setup is its own landmark on a page of several. */
  readonly mailboxName: string;
  readonly active: boolean;
}): ReactElement {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const queryKey = ['mailbox-setup', businessId, mailboxId];
  const latest = useQuery({
    queryKey,
    queryFn: () => client.request(getMailboxSetup, { params: { id: mailboxId } }),
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? 1000 : false),
  });
  const request = useMutation({
    mutationFn: () => client.request(requestMailboxCheck, { params: { id: mailboxId } }),
    onSuccess: (value) => {
      queryClient.setQueryData(queryKey, value);
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.problem.status === 409)
        void queryClient.invalidateQueries({ queryKey });
    },
  });
  const busy = request.isPending || latest.data?.state === 'pending';
  const labels: Record<MailboxSetupCheck['key'], string> = {
    connection: t`Connection`,
    encryption: t`Encryption`,
    spf: t`SPF`,
    dkim: t`DKIM`,
    dmarc: t`DMARC`,
    dmarc_enforcement: t`DMARC enforcement`,
    reverse_dns: t`Reverse DNS`,
    mx: t`Receiving mail`,
    blocklists: t`Blocklists`,
    unsubscribe: t`Unsubscribe`,
  };
  const statuses: Record<MailboxSetupCheck['status'], string> = {
    pass: t`Passed`,
    fail: t`Needs attention`,
    could_not_check: t`Could not check`,
    not_applicable: t`Not applicable`,
  };
  function explanation(check: MailboxSetupCheck): string {
    if (check.status === 'not_applicable') return t`This check does not apply to this mailbox.`;
    if (check.status === 'pass') return t`Verified by this check.`;
    if (check.status === 'could_not_check') {
      if (check.key === 'encryption')
        return t`This self-copy cannot prove encryption between mail servers.`;
      if (check.reason === 'no_sending_ip')
        return t`The public sending IP was not observed. No points were awarded for unconfirmed evidence.`;
      if (check.key === 'blocklists') return t`Blocklist checks are not configured.`;
      return t`There was not enough evidence to confirm this setting. No points were awarded.`;
    }
    return check.fix === undefined
      ? t`Review this setting with your email provider.`
      : t`Apply the change below, then check again.`;
  }
  return (
    <section
      aria-label={t`Mailbox setup: ${mailboxName}`}
      className="mt-5 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-md font-semibold">
          <Trans>Mailbox setup</Trans>
        </h3>
        <Button
          variant="quiet"
          disabled={!active || busy || latest.isPending}
          onClick={() => {
            request.mutate();
          }}
        >
          <Trans>Check again</Trans>
        </Button>
      </div>
      {latest.isPending ? (
        <p role="status">
          <Trans>Loading setup checks…</Trans>
        </p>
      ) : null}
      {latest.isError ? (
        <p role="alert">
          <Trans>We couldn't load setup checks.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void latest.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {request.isError ? (
        <p role="alert">
          {request.error instanceof ApiError && request.error.problem.status === 409
            ? t`A check is already running.`
            : t`We couldn't start the check. Try again.`}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="mt-3">
          <Trans>Checking mailbox setup…</Trans>
        </p>
      ) : null}
      {latest.data === null ? (
        <p className="mt-3 text-sm text-muted-foreground">
          <Trans>Run a setup check to see the score and any changes your mailbox needs.</Trans>
        </p>
      ) : null}
      {latest.data?.state === 'finished' ? (
        <>
          <p className="mt-3 text-lg font-semibold tabular-nums">{latest.data.score} / 100</p>
          <meter
            aria-label={t`Mailbox setup score`}
            min={0}
            max={100}
            value={latest.data.score}
            className="mt-2 h-2 w-full accent-primary"
          />
          <p className="mt-2 text-sm text-muted-foreground">
            <Trans>This score measures verified setup, not guaranteed inbox placement.</Trans>
          </p>
          <ul className="mt-4 divide-y divide-border">
            {latest.data.checks.map((check) => (
              <li key={check.key} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="font-medium">{labels[check.key]}</h4>
                  <span className="text-sm">
                    {statuses[check.status]} · {check.pointsAwarded}/{check.pointsPossible}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{explanation(check)}</p>
                {check.fix?.kind === 'record' ? (
                  <dl className="mt-3 grid min-w-0 gap-1 rounded-control bg-secondary p-3 text-sm">
                    <dt className="font-medium">
                      <Trans>Record type</Trans>
                    </dt>
                    <dd>{check.fix.type}</dd>
                    <dt className="font-medium">
                      <Trans>Name</Trans>
                    </dt>
                    <dd className="break-all font-mono select-all">{check.fix.name}</dd>
                    <dt className="font-medium">
                      <Trans>Value</Trans>
                    </dt>
                    <dd className="whitespace-pre-wrap break-all font-mono select-all">
                      {check.fix.value}
                    </dd>
                    <dd>
                      <CopyRecordValue label={labels[check.key]} value={check.fix.value} />
                    </dd>
                    {check.fix.exceedsLookupLimit === true ? (
                      <dd>
                        <Trans>
                          This change needs more than SPF's ten DNS lookups. Ask your provider to
                          simplify the record first.
                        </Trans>
                      </dd>
                    ) : null}
                  </dl>
                ) : check.fix?.kind === 'ask' ? (
                  <p className="mt-2 break-all text-sm">
                    <Trans>Ask the owner of this IP address to set its reverse DNS:</Trans>{' '}
                    {check.fix.ip}
                    {check.fix.ptr === undefined ? null : ` → ${check.fix.ptr}`}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
