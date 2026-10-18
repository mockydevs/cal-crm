// A widget's body, fetched apart from the page that shows it: the charts and the code that
// turns an answer into them arrive once, after the page's own frame, and a page that fails
// to fetch them says so in each widget's place.
import { Trans } from '@lingui/react/macro';
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, useState, type ReactElement } from 'react';
import { Loading } from './parts';
import type { WidgetBodyProps } from './widget';

const Body = lazy(async () => ({ default: (await import('./widget')).WidgetBody }));

function Nothing(): null {
  return null;
}

export function LazyWidgetBody(props: WidgetBodyProps): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p role="alert" className="py-4 text-sm text-body">
        <Trans>This widget couldn't be loaded. Reload the page to try again.</Trans>
      </p>
    );
  return (
    <CatchBoundary
      getResetKey={() => 'report-widget'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense fallback={<Loading />}>
        <Body {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
