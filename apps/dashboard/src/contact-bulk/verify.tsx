// Contacts → Verify emails on the contacts selected (GoHighLevel's Email verification bulk
// action): first what it would do, counted by the server for the same selection (how many
// keep a current result at no cost, how many are checked and how many of those use a
// provider credit, how many are skipped and why, and what today's limit leaves), then the
// check of each primary email address, within the business's daily verification limit.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { previewContactEmailChecks } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { apiIn } from '../api';
import { retryFaults } from '../settings-list';
import { BulkDialogShell, type BulkDialogProps } from './parts';

export default function VerifyDialog(props: BulkDialogProps): ReactElement {
  const { t, i18n } = useLingui();
  const { businessId, selection } = props;
  const preview = useQuery({
    queryKey: ['b', businessId, 'contacts', 'email-check-preview', selection],
    queryFn: () => apiIn(businessId).request(previewContactEmailChecks, { body: { selection } }),
    retry: retryFaults,
    // The counts are of this moment: opening the dialog again counts again.
    gcTime: 0,
  });
  const counts = preview.data;
  const number = (value: number): string => new Intl.NumberFormat(i18n.locale).format(value);
  const skippedCount = (counts?.noEmail ?? 0) + (counts?.excluded ?? 0) + (counts?.overLimit ?? 0);
  const checks = number(counts?.checks ?? 0);
  const credits = number(counts?.providerCalls ?? 0);
  const skipped = number(skippedCount);
  const missing =
    counts === undefined
      ? preview.isError
        ? t`The counts couldn't be loaded.`
        : t`Counting the email addresses…`
      : !counts.enabled
        ? t`Email verification is off.`
        : counts.checks === 0
          ? t`Nothing to check: every address is current or skipped.`
          : undefined;
  return (
    <BulkDialogShell
      {...props}
      title={t`Verify emails`}
      description={t`Each contact's primary email address is checked unless it has a current result: valid, risky or invalid from the last 90 days, and from the mailbox while a provider is connected.`}
      timing={false}
      missing={missing}
      confirm="verify"
      bodyOf={({ delivery: _now, ...common }) => ({ action: 'verify_emails', ...common })}
    >
      {() =>
        counts === undefined ? (
          preview.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-destructive">
                <Trans>The counts couldn't be loaded.</Trans>
              </span>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void preview.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Counting the email addresses…</Trans>
            </p>
          )
        ) : (
          <div role="status" className="flex flex-col gap-2 text-sm text-body">
            {counts.enabled ? null : (
              <p className="font-medium text-destructive">
                <Trans>
                  Email verification is off. Turn it on in Settings → Email Services → Email
                  Verification.
                </Trans>
              </p>
            )}
            <p className="font-medium text-foreground">
              {plural(counts.contacts, {
                one: '# contact in the selection.',
                other: '# contacts in the selection.',
              })}
            </p>
            <p>
              {plural(counts.current, {
                one: '# already has a current result: kept as it is, at no cost.',
                other: '# already have a current result: kept as they are, at no cost.',
              })}
            </p>
            <p>
              {counts.providerCalls === 0
                ? t`${checks} will be checked, none using a provider credit.`
                : t`${checks} will be checked, ${credits} of them using a provider credit.`}
            </p>
            {skippedCount === 0 ? null : (
              <div className="flex flex-col gap-1">
                <p>
                  <Trans>{skipped} skipped:</Trans>
                </p>
                <ul className="flex list-disc flex-col gap-1 pl-5">
                  {counts.noEmail === 0 ? null : (
                    <li>
                      {plural(counts.noEmail, {
                        one: '# has no email address',
                        other: '# have no email address',
                      })}
                    </li>
                  )}
                  {counts.excluded === 0 ? null : (
                    <li>
                      {plural(counts.excluded, {
                        one: '# is excluded from email verification',
                        other: '# are excluded from email verification',
                      })}
                    </li>
                  )}
                  {counts.overLimit === 0 ? null : (
                    <li>
                      {plural(counts.overLimit, {
                        one: "# is over today's verification limit",
                        other: "# are over today's verification limit",
                      })}
                    </li>
                  )}
                </ul>
              </div>
            )}
            {counts.remainingToday === null ? null : (
              <p>
                {plural(counts.remainingToday, {
                  one: '# provider check left today.',
                  other: '# provider checks left today.',
                })}
              </p>
            )}
            {counts.provider === null || counts.provider === 'disconnected' ? (
              <p className="text-muted-foreground">
                <Trans>Mailbox checks need a verification provider. Domain checks still run.</Trans>
              </p>
            ) : counts.provider === 'failing' ? (
              <p className="text-muted-foreground">
                <Trans>
                  The verification provider's connection is failing. Check it in Settings → Email
                  Services → Email Verification.
                </Trans>
              </p>
            ) : null}
          </div>
        )
      }
    </BulkDialogShell>
  );
}
