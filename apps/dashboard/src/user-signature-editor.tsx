// The email signature's editor in Settings → Users: the note editor's own rich text (bold,
// italic, code, line breaks), kept as the note
// document the app already renders safely. It is the same Tiptap set-up as note-editor.tsx,
// in a file of its own because that one is a form with its own Save, takes the keyboard as
// it opens and is named "Note": here the editor is one field of a larger form, and tells
// the form what it holds as it changes. Fetched when the form first shows it.
import { Trans, useLingui } from '@lingui/react/macro';
import { noteDocument, type NoteDocument } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Italic from '@tiptap/extension-italic';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder } from '@tiptap/extensions/placeholder';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { EditorContent, useEditor, useEditorState, type JSONContent } from '@tiptap/react';
import { useEffect, useState, type ReactElement } from 'react';
import type { SignatureDraft } from './users-rules';

// The placeholder is the extension's own: it marks the empty first paragraph, and the text
// is drawn from its data-placeholder attribute.
const editorClassName =
  'min-h-32 min-w-0 rounded-control border border-input bg-card p-3 text-md break-words focus-visible:outline-2 focus-visible:outline-ring [&_p+p]:mt-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]';

export default function UserSignatureEditor({
  initial,
  label,
  disabled,
  onChange,
}: {
  readonly initial: NoteDocument | null;
  /** What the editor is called, for a screen reader. */
  readonly label: string;
  readonly disabled: boolean;
  /** What the editor holds now: a document, nothing, or text that fits no document. */
  readonly onChange: (signature: SignatureDraft) => void;
}): ReactElement {
  const { t } = useLingui();
  // The API permits omitted arrays; Tiptap's exact optional types require present arrays
  // or absent keys. Captured once: later drafts are the editor's.
  const [content] = useState<JSONContent>(() => ({
    type: 'doc',
    content: (initial?.content ?? [{ type: 'paragraph' as const }]).map((paragraph) => ({
      type: 'paragraph',
      content: (paragraph.content ?? []).map((node): JSONContent =>
        node.type === 'hardBreak'
          ? { type: 'hardBreak' }
          : { type: 'text', text: node.text, marks: node.marks ?? [] },
      ),
    })),
  }));
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Code,
      HardBreak,
      UndoRedo,
      Placeholder.configure({ placeholder: t`Create your email signature` }),
    ],
    content,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
        class: editorClassName,
      },
    },
    onUpdate: ({ editor: changed }) => {
      // Nothing written is no signature. Anything else is a document, or does not fit one.
      if (changed.getText().trim() === '') {
        onChange({ document: null, valid: true });
        return;
      }
      const parsed = noteDocument.safeParse(changed.getJSON());
      onChange(
        parsed.success ? { document: parsed.data, valid: true } : { document: null, valid: false },
      );
    },
  });
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') ?? false,
      italic: current?.isActive('italic') ?? false,
      code: current?.isActive('code') ?? false,
    }),
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  const off = disabled || editor === null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="group" aria-label={t`Text formatting`} className="flex flex-wrap gap-1">
        <Button
          variant="secondary"
          size="small"
          aria-pressed={active?.bold ?? false}
          disabled={off}
          onClick={() => {
            editor?.chain().focus().toggleBold().run();
          }}
        >
          <Trans>Bold</Trans>
        </Button>
        <Button
          variant="secondary"
          size="small"
          aria-pressed={active?.italic ?? false}
          disabled={off}
          onClick={() => {
            editor?.chain().focus().toggleItalic().run();
          }}
        >
          <Trans>Italic</Trans>
        </Button>
        <Button
          variant="secondary"
          size="small"
          aria-pressed={active?.code ?? false}
          disabled={off}
          onClick={() => {
            editor?.chain().focus().toggleCode().run();
          }}
        >
          <Trans>Code</Trans>
        </Button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
