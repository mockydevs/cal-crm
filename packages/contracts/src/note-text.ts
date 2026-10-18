import type { NoteDocument } from './note-document.js';

/** Plain text uses supported line-break nodes; callers still validate the note limits. */
export function noteDocumentFromText(text: string): NoteDocument {
  const content: NonNullable<NoteDocument['content'][number]['content']> = [];
  for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
    if (index > 0) content.push({ type: 'hardBreak' });
    if (line !== '') content.push({ type: 'text', text: line });
  }
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

/**
 * A note document as plain text: a paragraph or a line break is a new line, and marks such
 * as bold leave their words. What an email signature is sent as.
 */
export function noteDocumentToText(document: NoteDocument): string {
  return document.content
    .map((paragraph) =>
      (paragraph.content ?? []).map((node) => (node.type === 'text' ? node.text : '\n')).join(''),
    )
    .join('\n');
}
