import { Trans, useLingui } from '@lingui/react/macro';
import { noteDocument, type NoteDocument } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import type { Editor } from '@tiptap/react';
import { useState, type ReactElement, type ReactNode } from 'react';

/** The form stays separate from the rich-text engine so each loads within its budget. */
export default function NoteEditorControls({
  editor,
  active,
  pending,
  readOnly,
  onSave,
  onCancel,
  children,
}: {
  readonly editor: Editor | null;
  readonly active: {
    readonly bold: boolean;
    readonly italic: boolean;
    readonly code: boolean;
  } | null;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly onSave: (body: NoteDocument) => void;
  readonly onCancel: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  const [problem, setProblem] = useState<string>();
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (editor === null || pending || readOnly) return;
        const parsed = noteDocument.safeParse(editor.getJSON());
        if (!parsed.success) {
          setProblem(parsed.error.issues[0]?.message ?? t`Check the note and try again.`);
          return;
        }
        setProblem(undefined);
        onSave(parsed.data);
      }}
    >
      <div role="group" aria-label={t`Text formatting`} className="flex flex-wrap gap-1">
        <Button
          type="button"
          variant="secondary"
          size="small"
          aria-pressed={active?.bold ?? false}
          disabled={pending || readOnly || editor === null}
          onClick={() => {
            editor?.chain().focus().toggleBold().run();
          }}
        >
          <Trans>Bold</Trans>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="small"
          aria-pressed={active?.italic ?? false}
          disabled={pending || readOnly || editor === null}
          onClick={() => {
            editor?.chain().focus().toggleItalic().run();
          }}
        >
          <Trans>Italic</Trans>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="small"
          aria-pressed={active?.code ?? false}
          disabled={pending || readOnly || editor === null}
          onClick={() => {
            editor?.chain().focus().toggleCode().run();
          }}
        >
          <Trans>Code</Trans>
        </Button>
      </div>
      {children}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || readOnly || editor === null}>
          {pending ? t`Saving…` : t`Save note`}
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}
