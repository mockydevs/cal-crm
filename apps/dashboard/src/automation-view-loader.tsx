// The builder's views that are fetched when first opened: the canvas and the run history.
// Each is its own chunk, so opening an automation doesn't wait for a view nobody asked for.
// If a view's code doesn't arrive, the builder says so in that view's place and stays as it
// is: the draft being edited is in the builder, not in the view, so nothing is lost, and the
// other views still work. React keeps a failed lazy component failed, so only a new page
// fetches it afresh (see automation-builder-loader.tsx).
import { Trans } from '@lingui/react/macro';
import { CatchBoundary } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import type CanvasView from './automation-canvas';
import type ExecutionLogs from './automation-logs';
import type RunHistory from './automation-runs';
import type SettingsTab from './automation-settings-tab';
import type { StepsView } from './automation-steps-view';
import type { PublishDialog } from './automation-publish-dialog';
import type TestDialog from './automation-test-dialog';
import type VersionsDialog from './automation-versions';

const Canvas = lazy(() => import('./automation-canvas'));
const Runs = lazy(() => import('./automation-runs'));
const Logs = lazy(() => import('./automation-logs'));
const Settings = lazy(() => import('./automation-settings-tab'));
const Steps = lazy(async () => {
  const steps = await import('./automation-steps-view');
  return { default: steps.StepsView };
});
const Test = lazy(() => import('./automation-test-dialog'));
const Publish = lazy(async () => {
  const publish = await import('./automation-publish-dialog');
  return { default: publish.PublishDialog };
});
const Versions = lazy(() => import('./automation-versions'));

/** What the boundary shows itself: nothing, since the loader shows the failure. */
function Nothing(): null {
  return null;
}

function LazyView({
  name,
  loading,
  unavailable,
  children,
}: {
  /** Which view, for the boundary to tell one view's failure from another's. */
  readonly name: string;
  readonly loading: ReactNode;
  readonly unavailable: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div
        role="alert"
        className="flex min-w-0 flex-col items-start gap-2 rounded-card border border-border bg-card p-5 text-md"
      >
        {unavailable}
      </div>
    );
  return (
    <CatchBoundary
      getResetKey={() => name}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense fallback={<p role="status">{loading}</p>}>{children}</Suspense>
    </CatchBoundary>
  );
}

export function CanvasLoader(props: ComponentProps<typeof CanvasView>): ReactElement {
  return (
    <LazyView
      name="automation-canvas"
      loading={<Trans>Loading the canvas…</Trans>}
      unavailable={
        <Trans>
          The canvas couldn't load. Your draft is still here: use the Steps or JSON view, or save
          and reload the page to try again.
        </Trans>
      }
    >
      <Canvas {...props} />
    </LazyView>
  );
}

/** The Steps view: the canvas is what opens, so the list's code waits until it is asked for. */
export function StepsLoader(props: ComponentProps<typeof StepsView>): ReactElement {
  return (
    <LazyView
      name="automation-steps"
      loading={<Trans>Loading the steps…</Trans>}
      unavailable={
        <Trans>
          The Steps view couldn't load. Your draft is still here: use the Canvas or JSON view, or
          save and reload the page to try again.
        </Trans>
      }
    >
      <Steps {...props} />
    </LazyView>
  );
}

export function RunsLoader(props: ComponentProps<typeof RunHistory>): ReactElement {
  return (
    <LazyView
      name="automation-runs"
      loading={<Trans>Loading the runs…</Trans>}
      unavailable={
        <Trans>
          The run history couldn't load. Your draft is still here. Save it and reload the page to
          try again.
        </Trans>
      }
    >
      <Runs {...props} />
    </LazyView>
  );
}

export function LogsLoader(props: ComponentProps<typeof ExecutionLogs>): ReactElement {
  return (
    <LazyView
      name="automation-logs"
      loading={<Trans>Loading the logs…</Trans>}
      unavailable={
        <Trans>
          The execution logs couldn't load. Your draft is still here. Save it and reload the page to
          try again.
        </Trans>
      }
    >
      <Logs {...props} />
    </LazyView>
  );
}

export function SettingsLoader(props: ComponentProps<typeof SettingsTab>): ReactElement {
  return (
    <LazyView
      name="automation-settings"
      loading={<Trans>Loading the settings…</Trans>}
      unavailable={
        <Trans>
          The settings couldn't load. Your draft is still here. Save it and reload the page to try
          again.
        </Trans>
      }
    >
      <Settings {...props} />
    </LazyView>
  );
}

/**
 * A dialog fetched when it is first asked for: nothing shows while its code is on the way,
 * and if it never arrives, the page says so in its place once the dialog is wanted.
 */
function LazyDialog({
  name,
  open,
  onOpenChange,
  unavailable,
  children,
}: {
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly unavailable: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return open ? (
      <div
        role="alert"
        className="mx-4 flex min-w-0 flex-col items-start gap-2 rounded-card border border-border bg-card p-5 text-md"
      >
        {unavailable}
      </div>
    ) : (
      <></>
    );
  return (
    <CatchBoundary
      getResetKey={() => name}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
        onOpenChange(true);
      }}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </CatchBoundary>
  );
}

/** The test dialog. */
export function TestLoader(props: ComponentProps<typeof TestDialog>): ReactElement {
  return (
    <LazyDialog
      name="automation-test"
      open={props.open}
      onOpenChange={props.onOpenChange}
      unavailable={
        <Trans>The test couldn't load. Save your draft and reload the page to try again.</Trans>
      }
    >
      <Test {...props} />
    </LazyDialog>
  );
}

/** The version history. */
export function VersionsLoader(props: ComponentProps<typeof VersionsDialog>): ReactElement {
  return (
    <LazyDialog
      name="automation-versions"
      open={props.open}
      onOpenChange={props.onOpenChange}
      unavailable={<Trans>The version history couldn't load. Reload the page to try again.</Trans>}
    >
      <Versions {...props} />
    </LazyDialog>
  );
}

/** The publish dialog, with the wording of what changed. */
export function PublishLoader(props: ComponentProps<typeof PublishDialog>): ReactElement {
  return (
    <LazyDialog
      name="automation-publish"
      open={props.open}
      onOpenChange={props.onOpenChange}
      unavailable={
        <Trans>Publishing couldn't load. Save your draft and reload the page to try again.</Trans>
      }
    >
      <Publish {...props} />
    </LazyDialog>
  );
}
