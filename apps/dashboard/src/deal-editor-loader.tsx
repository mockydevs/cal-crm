import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentProps,
  type ReactElement,
} from 'react';
import type DealEditor from './deal-editor';

export type DealEditorProps = ComponentProps<typeof DealEditor>;

const Editor = lazy(() => import('./deal-editor'));

/** What the boundary shows itself: nothing, since the loader shows the failure. */
function Nothing(): null {
  return null;
}

function EditorUnavailable({ onCancel }: { readonly onCancel: () => void }): ReactElement {
  // The person just chose to write, and the editor isn't there: the keyboard lands on the
  // way forward.
  const focusOnMount = useCallback((button: HTMLButtonElement | null) => {
    button?.focus();
  }, []);
  return (
    <div
      role="alert"
      className="m-5 flex min-w-0 flex-col items-start gap-2 rounded-control border border-border p-4 text-sm"
    >
      <p>
        <Trans>
          The opportunity editor couldn't load. Your opportunities are still here. Reload the page
          to try again.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={focusOnMount}
          variant="secondary"
          size="small"
          onClick={() => {
            window.location.reload();
          }}
        >
          <Trans>Reload page</Trans>
        </Button>
        <Button variant="quiet" size="small" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}

/** The opportunity editor with its loading and its failure kept to the dialog. */
export default function DealEditorLoader(props: DealEditorProps): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <EditorUnavailable onCancel={props.onClose} />;
  return (
    <CatchBoundary
      getResetKey={() => 'deal-editor'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <p aria-live="polite" className="flex-1 px-5 py-4">
            <Trans>Loading editor…</Trans>
          </p>
        }
      >
        <Editor {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
