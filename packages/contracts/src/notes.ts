import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';
import { actor } from './activity.js';
import { noteDocument, type NoteDocument } from './note-document.js';

export { noteDocument, type NoteDocument };
export const createNoteInput = z
  .strictObject({ body: noteDocument })
  .meta({ id: 'CreateNoteInput' });

const revision = z.string().regex(/^[0-9a-f]{64}$/);
export const note = z
  .looseObject({
    id: publicId('note'),
    recordId,
    body: noteDocument,
    text: z.string(),
    // Who wrote it, which edits keep, and who changed it last: a person or a machine.
    author: actor,
    editedBy: actor.nullable(),
    editedAt: timestamp.nullable().meta({ description: 'When it was last edited. Null if never.' }),
    createdAt: timestamp,
    updatedAt: timestamp,
    revision,
  })
  .meta({ id: 'Note' });
export type Note = z.output<typeof note>;
export const recordNotes = z
  .looseObject({
    canManage: z.boolean(),
    items: z.array(note),
    nextCursor: publicId('note').nullable(),
  })
  .meta({ id: 'RecordNotes' });
export type RecordNotes = z.output<typeof recordNotes>;
const recordParams = z.object({ id: recordId });
const noteParams = recordParams.extend({ noteId: publicId('note') });
export const updateNoteInput = createNoteInput.extend({ revision }).meta({ id: 'UpdateNoteInput' });
export const deleteNoteInput = z.strictObject({ revision }).meta({ id: 'DeleteNoteInput' });
export const listRecordNotes = defineEndpoint({
  operationId: 'listRecordNotes',
  method: 'get',
  path: '/records/{id}/notes',
  summary: 'Read and search notes on a record',
  group: 'Notes',
  params: recordParams,
  query: z
    .strictObject({
      q: z.string().trim().max(200).optional(),
      after: publicId('note')
        .optional()
        .meta({ description: "Start after this note: the previous page's nextCursor." }),
    })
    .meta({ id: 'ListRecordNotesQuery' }),
  response: {
    status: 200,
    description: 'Newest written first (ties by id), 50 a page, with a cursor for the next page.',
    schema: recordNotes,
  },
});
export const createNote = defineEndpoint({
  operationId: 'createNote',
  method: 'post',
  path: '/records/{id}/notes',
  summary: 'Add a note to a record',
  group: 'Notes',
  params: recordParams,
  body: createNoteInput,
  response: { status: 201, description: 'The note with its trusted author.', schema: note },
});
export const updateNote = defineEndpoint({
  operationId: 'updateNote',
  method: 'put',
  path: '/records/{id}/notes/{noteId}',
  summary: 'Edit a note without overwriting another edit',
  group: 'Notes',
  params: noteParams,
  body: updateNoteInput,
  response: {
    status: 200,
    description: 'The saved note; its original author stays the same.',
    schema: note,
  },
});
export const deleteNote = defineEndpoint({
  operationId: 'deleteNote',
  method: 'delete',
  path: '/records/{id}/notes/{noteId}',
  summary: 'Delete a note after checking its revision',
  group: 'Notes',
  params: noteParams,
  body: deleteNoteInput,
  response: { status: 204, description: 'The note was deleted and the action recorded.' },
});
