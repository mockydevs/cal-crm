import { describe, expect, it } from 'vitest';

import { noteDocumentFromText, noteDocumentToText } from './note-text.js';
import { noteDocument } from './notes.js';

describe('a note document as plain text', () => {
  it('puts each paragraph and each line break on a new line, and drops the marks', () => {
    const document = noteDocument.parse({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ada Lovelace', marks: [{ type: 'bold' }] },
            { type: 'hardBreak' },
            { type: 'text', text: 'Analytical Engines Ltd' },
          ],
        },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: '+1 305 555 0123' }] },
      ],
    });
    expect(noteDocumentToText(document)).toBe(
      'Ada Lovelace\nAnalytical Engines Ltd\n\n+1 305 555 0123',
    );
  });

  it('gives back the text a document was made from', () => {
    const text = 'Kind regards,\nAda\n\nSent from the office';
    expect(noteDocumentToText(noteDocumentFromText(text))).toBe(text);
  });
});
