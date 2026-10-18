// The forms of the contact's time zone and do-not-contact panel, fetched the first time
// someone changes either, so the contact page doesn't wait for the picker's code. If that
// code doesn't arrive, the panel says so in place: the settings stay shown, and the person
// can cancel or reload. Reloading is the way to try again, as for the note editor
// (note-editor-loader.tsx): React keeps a failed lazy component failed.
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useState, type ReactElement } from 'react';
import type { ContactPreferenceFormProps } from './contact-preferences-forms';

const PreferenceForm = lazy(() => import('./contact-preferences-forms'));

/** What the boundary shows itself: nothing, since the loader shows the failure. */
function Nothing(): null {
  return null;
}

function FormUnavailable({ onCancel }: { readonly onCancel: () => void }): ReactElement {
  // The person just chose to change a setting, and the form isn't there: the keyboard
  // lands on the way forward.
  const focusOnMount = useCallback((button: HTMLButtonElement | null) => {
    button?.focus();
  }, []);
  return (
    <div
      role="alert"
      className="flex min-w-0 flex-col items-start gap-2 rounded-control border border-border p-4 text-sm"
    >
      <p>
        <Trans>The form couldn't load. Nothing was changed. Reload the page to try again.</Trans>
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

/** One of the two forms, with its loading and its failure kept to the panel. */
export default function ContactPreferenceFormLoader(
  props: ContactPreferenceFormProps,
): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <FormUnavailable
        onCancel={() => {
          props.close();
        }}
      />
    );
  return (
    <CatchBoundary
      getResetKey={() => 'contact-preferences'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <p role="status" className="text-sm">
            <Trans>Loading form…</Trans>
          </p>
        }
      >
        <PreferenceForm {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
