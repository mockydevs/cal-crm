// A record's run history, fetched after the record's own page: the page doesn't wait for
// it, and doesn't carry the automation contracts for the people who never look. If its code
// doesn't arrive, the panel says so in its place and the rest of the page is as it was.
import { Trans, useLingui } from '@lingui/react/macro';
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, useState, type ReactElement } from 'react';
import { ContactPanel } from './contact-panels';

const Runs = lazy(() =>
  import('./automation-record-runs').then((module) => ({ default: module.RecordAutomationRuns })),
);

/** What the boundary shows itself: nothing, since the loader shows the failure. */
function Nothing(): null {
  return null;
}

export function RecordAutomationRunsLoader({
  recordId,
}: {
  readonly recordId: string;
}): ReactElement {
  const { t } = useLingui();
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <ContactPanel title={t`Workflows`}>
        <p role="alert" className="text-sm">
          <Trans>The automations couldn't be loaded. Reload the page to try again.</Trans>
        </p>
      </ContactPanel>
    );
  return (
    <CatchBoundary
      getResetKey={() => 'record-automation-runs'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <ContactPanel title={t`Workflows`}>
            <p aria-live="polite">
              <Trans>Loading automations…</Trans>
            </p>
          </ContactPanel>
        }
      >
        <Runs recordId={recordId} />
      </Suspense>
    </CatchBoundary>
  );
}
