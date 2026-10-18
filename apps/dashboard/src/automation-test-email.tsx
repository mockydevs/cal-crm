import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationTestRun } from '@repo/contracts';
import type { ReactElement } from 'react';

type TestedEmail = NonNullable<AutomationTestRun['steps'][number]['email']>;

/**
 * The email a test run filled in for a Send email step: its subject, its first line, and
 * the merge fields with no value, on which a real send stops.
 */
export default function TestedEmailPreview({
  email,
}: {
  readonly email: TestedEmail;
}): ReactElement {
  const { t } = useLingui();
  const missing = email.missingValues.join(', ');
  return (
    <div
      role="group"
      aria-label={t`Email preview`}
      className="mt-1 rounded-xl border border-input px-3 py-2 text-sm"
    >
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">
          <Trans>Subject</Trans>
        </dt>
        <dd className="min-w-0 wrap-anywhere">{email.subject}</dd>
        <dt className="text-muted-foreground">
          <Trans>First line</Trans>
        </dt>
        <dd className="min-w-0 wrap-anywhere">{email.firstLine}</dd>
      </dl>
      {email.missingValues.length === 0 ? null : (
        <p className="mt-1 wrap-anywhere text-destructive">
          <Trans>
            Missing values: {missing}. A real send would stop here, and nothing would be sent.
          </Trans>
        </p>
      )}
    </div>
  );
}
