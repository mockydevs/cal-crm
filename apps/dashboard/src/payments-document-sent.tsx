// When a quote, an invoice or a receipt was last emailed to its customer, and how many
// times: one line, on the document's page and on the receipt's.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactElement } from 'react';

export function SentLine({
  kind,
  lastSentAt,
  sendCount,
}: {
  readonly kind: 'document' | 'receipt';
  readonly lastSentAt: string | null | undefined;
  readonly sendCount: number | undefined;
}): ReactElement {
  const { i18n } = useLingui();
  if (lastSentAt === null || lastSentAt === undefined)
    return kind === 'receipt' ? (
      <Trans>This receipt has not been sent to the customer yet.</Trans>
    ) : (
      <Trans>Not sent yet. Issuing sends nothing by itself.</Trans>
    );
  const when = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(lastSentAt));
  const times = plural(sendCount ?? 1, { one: 'sent # time', other: 'sent # times' });
  return (
    <Trans>
      Last sent {when} · {times}
    </Trans>
  );
}
