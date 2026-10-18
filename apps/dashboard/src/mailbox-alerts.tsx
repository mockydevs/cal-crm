import { Trans, useLingui } from '@lingui/react/macro';
import { getMailboxSetupAlerts, type MailboxSetupCheck } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { apiIn } from './api';
import { useBusiness } from './workspace';

export function MailboxAlerts(): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const alerts = useQuery({
    queryKey: ['mailbox-alerts', business.id],
    queryFn: () => apiIn(business.id).request(getMailboxSetupAlerts, {}),
    retry: (count, failure) =>
      !(failure instanceof ApiError && failure.problem.status === 403) && count < 2,
  });
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
  if (alerts.error instanceof ApiError && alerts.error.problem.status === 403) return null;
  if (alerts.isError)
    return (
      <p role="alert">
        <Trans>We couldn't load mailbox alerts.</Trans>{' '}
        <Button
          variant="quiet"
          onClick={() => {
            void alerts.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </p>
    );
  if (alerts.data === undefined || alerts.data.data.length === 0) return null;
  return (
    <section
      aria-label={t`Mailbox alerts`}
      className="rounded-card border border-border bg-card p-[22px]"
    >
      <h2 className="text-lg font-semibold">
        <Trans>Mailbox needs attention</Trans>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        <Trans>A previously passing setup check now needs a fix.</Trans>
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {alerts.data.data.map((alert) => {
          const name = alert.name;
          const check = labels[alert.checkKey];
          return (
            <li key={`${alert.mailboxId}:${alert.checkKey}`}>
              <Link
                to="/b/$slug/settings/email"
                params={{ slug: business.slug }}
                className="break-words font-medium text-primary underline underline-offset-4"
              >
                {t`${name}: ${check} needs attention`}
              </Link>
            </li>
          );
        })}
      </ul>
      {alerts.data.hasMore ? (
        <p className="mt-3 text-sm">
          <Trans>More mailboxes need attention. Open Email settings to review them.</Trans>
        </p>
      ) : null}
    </section>
  );
}
