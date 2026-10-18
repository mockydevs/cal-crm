import { useLingui } from '@lingui/react/macro';
import type { NoteDocument } from '@repo/contracts';
import { EditorContent, useEditor, useEditorState, type JSONContent } from '@tiptap/react';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Italic from '@tiptap/extension-italic';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { useEffect, useState, type ReactElement } from 'react';
import type NoteEditorControls from './note-editor-controls';

const editorClassName =
  'min-h-32 min-w-0 rounded-control border border-input bg-card p-3 text-md break-words focus-visible:outline-2 focus-visible:outline-ring [&_p+p]:mt-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1';

/**
 * Loaded only while writing. The editor owns the draft across failed requests/refetches.
 *
 * Its form (`Controls`) is a chunk of its own, and the loader hands it over already
 * fetched, so the editor's place in the page is there in the commit that creates the
 * editor. Tiptap focuses a new editor once, a moment after creating it; an editor still
 * waiting for its place then (as when the form was a lazy component in here, and the code
 * took longer than React holds a loading message back) is never focused at all.
 */
export default function NoteEditor({
  Controls,
  initialBody,
  pending,
  readOnly,
  onSave,
  onCancel,
}: {
  readonly Controls: typeof NoteEditorControls;
  readonly initialBody: NoteDocument;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly onSave: (body: NoteDocument) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useLingui();
  // The API permits omitted arrays; Tiptap's exact optional types require present
  // arrays or absent keys. Capture the initial document once, preserving later drafts.
  const [content] = useState<JSONContent>(() => ({
    type: 'doc',
    content: initialBody.content.map((paragraph) => ({
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
    extensions: [Document, Paragraph, Text, Bold, Italic, Code, HardBreak, UndoRedo],
    content,
    autofocus: 'end',
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': t`Note`,
        'aria-multiline': 'true',
        class: editorClassName,
      },
    },
  });
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold') ?? false,
      italic: editor?.isActive('italic') ?? false,
      code: editor?.isActive('code') ?? false,
    }),
  });
  useEffect(() => {
    editor?.setEditable(!pending && !readOnly);
  }, [editor, pending, readOnly]);
  return (
    <Controls
      editor={editor}
      active={active}
      pending={pending}
      readOnly={readOnly}
      onSave={onSave}
      onCancel={onCancel}
    >
      <EditorContent editor={editor} />
    </Controls>
  );
}
