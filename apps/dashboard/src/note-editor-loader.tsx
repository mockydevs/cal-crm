// The note editor, fetched the first time someone writes or edits a note, so the contact
// page doesn't wait for Tiptap. If its code doesn't arrive, the panel says so in place: the
// page and its notes stay, and the person can cancel or reload. Reloading is the way to try
// again: React keeps a failed lazy component failed (react 19.3.0's lazyInitializer), and
// Chromium a failed module for the life of the page (a second import() of it fails without
// fetching), so only a new page fetches the editor afresh. The editor never opened, so
// there's no draft to lose.
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
import type NoteEditor from './note-editor';

export type NoteEditorProps = Omit<ComponentProps<typeof NoteEditor>, 'Controls'>;

// Fetch both halves together; neither download adds a sequential network wait. The editor
// is given its form here rather than loading it lazily itself: it must be whole in the
// commit that creates it, or it never gets the keyboard (see note-editor.tsx).
const Editor = lazy(async () => {
  const [editor, controls] = await Promise.all([
    import('./note-editor'),
    import('./note-editor-controls'),
  ]);
  function LoadedNoteEditor(props: NoteEditorProps): ReactElement {
    return <editor.default {...props} Controls={controls.default} />;
  }
  return { default: LoadedNoteEditor };
});

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
      className="flex min-w-0 flex-col items-start gap-2 rounded-control border border-border p-4 text-sm"
    >
      <p>
        <Trans>
          The editor couldn't load. Your notes are still here. Reload the page to try again.
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

/** The note editor with its loading and its failure kept to the notes panel. */
export default function NoteEditorLoader(props: NoteEditorProps): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <EditorUnavailable onCancel={props.onCancel} />;
  return (
    <CatchBoundary
      getResetKey={() => 'note-editor'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <p aria-live="polite">
            <Trans>Loading editor…</Trans>
          </p>
        }
      >
        <Editor {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
