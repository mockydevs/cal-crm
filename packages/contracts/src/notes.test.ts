import { expect, it } from 'vitest';
import { createNoteInput, listRecordNotes, noteDocument, note, updateNoteInput } from './notes.js';

it('accepts a structured note and refuses client-supplied authors or search text', () => {
  const body = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Call Maya about the garden venue.' }] },
    ],
  };
  expect(createNoteInput.parse({ body })).toEqual({ body });
  expect(createNoteInput.safeParse({ body, authorId: 'someone-else' }).success).toBe(false);
  expect(createNoteInput.safeParse({ body, bodyText: 'Hidden text' }).success).toBe(false);
});

it('uses the shared actor vocabulary when presenting who wrote a note', () => {
  const saved = {
    id: 'note_01h455vb4pex5vsknk084sn02q',
    recordId: 'con_01h455vb4pex5vsknk084sn02q',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Garden venue' }] }],
    },
    text: 'Garden venue',
    author: { kind: 'user', name: 'Dana Brooks', you: true },
    editedBy: null,
    editedAt: null,
    createdAt: '2026-10-08T12:00:00Z',
    updatedAt: '2026-10-08T12:00:00Z',
    revision: 'a'.repeat(64),
  };
  expect(note.parse(saved).author).toEqual(saved.author);
  expect(note.safeParse({ ...saved, author: { ...saved.author, kind: 'unknown' } }).success).toBe(
    false,
  );
  // Edited, it keeps its author and says who edited it last, and when.
  const edited = {
    ...saved,
    editedBy: { kind: 'api_key', name: 'Zapier', you: false },
    editedAt: '2026-10-08T13:00:00Z',
  };
  expect(note.parse(edited)).toMatchObject({ author: saved.author, editedBy: edited.editedBy });
  expect(note.safeParse({ ...saved, editedBy: undefined }).success).toBe(false);
});

it('takes no editor from the caller, and only a search and a cursor to list', () => {
  const body = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Garden venue' }] }],
  };
  const revision = 'a'.repeat(64);
  expect(
    updateNoteInput.safeParse({ body, revision, editedBy: { kind: 'system', name: null } }).success,
  ).toBe(false);
  expect(
    updateNoteInput.safeParse({ body, revision, editedAt: '2026-10-08T13:00:00Z' }).success,
  ).toBe(false);
  expect(listRecordNotes.query.parse({ q: ' garden ' })).toEqual({ q: 'garden' });
  expect(listRecordNotes.query.safeParse({ q: 'garden', sort: 'oldest' }).success).toBe(false);
});

it('refuses duplicate formatting and code mixed with other marks that the editor cannot preserve', () => {
  for (const marks of [
    [{ type: 'bold' }, { type: 'bold' }],
    [{ type: 'code' }, { type: 'italic' }],
  ]) {
    expect(
      noteDocument.safeParse({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Venue', marks }] }],
      }).success,
    ).toBe(false);
  }
});

it('preserves simple rich text and line breaks while refusing executable or oversized content', () => {
  const body = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Maya', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'hardBreak' },
          { type: 'text', text: '<script>still just text</script>', marks: [{ type: 'code' }] },
        ],
      },
    ],
  };
  expect(noteDocument.parse(body)).toEqual(body);
  expect(
    noteDocument.safeParse({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Click',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    noteDocument.safeParse({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'https://tracker.test/image' } }],
    }).success,
  ).toBe(false);
  expect(
    noteDocument.safeParse({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a'.repeat(60000) },
            { type: 'text', text: 'b'.repeat(60000) },
          ],
        },
      ],
    }).success,
  ).toBe(false);
  expect(noteDocument.safeParse({ type: 'doc', content: [{ type: 'paragraph' }] }).success).toBe(
    false,
  );
});
