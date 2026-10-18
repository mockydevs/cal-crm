// Files on a record: the documents a person uploads to a contact (or another record) and
// the files a file upload field holds, with the attachments of the record's conversation
// listed beside them. The bytes are the files service's; a download is a signed link to
// the file (createFileLink).
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { documentContentTypes } from './document-formats.js';
import { defineEndpoint } from './endpoints.js';
import { fileLink } from './files.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

/** Where a record's file sits in its Documents panel, as GoHighLevel sorts them. */
export const recordFileFolders = ['internal', 'sent', 'received'] as const;
export type RecordFileFolder = (typeof recordFileFolders)[number];

export const recordFile = z
  .looseObject({
    id: publicId('file'),
    filename: z.string(),
    contentType: z.string(),
    size: z.int().min(0).meta({ description: 'In bytes.' }),
    createdAt: timestamp,
    folder: z.enum(recordFileFolders).meta({
      description:
        'internal: uploaded to the record, directly or to one of its file fields; sent: attached to a message sent to the contact; received: attached to a message the contact sent.',
    }),
    field: z
      .looseObject({ id: publicId('field'), label: z.string() })
      .nullable()
      .meta({
        description: 'The file upload field that holds it, or null.',
      }),
    addedBy: z
      .looseObject({ kind: z.enum(actorKinds), name: z.string().nullable(), you: z.boolean() })
      .nullable(),
    removable: z.boolean().meta({
      description:
        "Whether this reader may delete it: an uploaded file, for whoever may upload files (and edit field values, for a field's file). A message's attachment stays with the message.",
    }),
  })
  .meta({ id: 'RecordFile' });
export type RecordFile = z.infer<typeof recordFile>;

export const recordFilesPage = z
  .looseObject({
    items: z.array(recordFile),
    next: z.string().nullable().meta({ description: 'Pass as `after` for the next page.' }),
    canUpload: z.boolean(),
  })
  .meta({ id: 'RecordFiles' });
export type RecordFilesPage = z.infer<typeof recordFilesPage>;

export const listRecordFilesQuery = z.strictObject({
  folder: z.enum(['all', ...recordFileFolders]).default('all'),
  q: z.string().trim().max(200).optional().meta({ description: 'Part of a file name.' }),
  field: publicId('field').optional().meta({
    description: "Only the files of this file upload field: a field's own list.",
  }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().max(200).optional(),
});

const recordParams = z.strictObject({ id: recordId });

export const listRecordFiles = defineEndpoint({
  operationId: 'listRecordFiles',
  method: 'get',
  path: '/records/{id}/files',
  group: 'Files',
  summary: "List a record's documents, newest first",
  params: recordParams,
  query: listRecordFilesQuery,
  response: {
    status: 200,
    description: "The record's files: uploaded, in its file fields, and its messages' attachments.",
    schema: recordFilesPage,
  },
});

export const uploadRecordFileQuery = z.strictObject({
  filename: z.string().meta({
    description: 'The name to show and download it under. Its extension says its format.',
    examples: ['signed-contract.pdf'],
  }),
  field: publicId('field').optional().meta({
    description:
      "A file upload field of the record's object to put it in. Left out, it is a document of the record.",
  }),
});

export const uploadRecordFile = defineEndpoint({
  operationId: 'uploadRecordFile',
  method: 'post',
  path: '/records/{id}/files',
  group: 'Files',
  summary: 'Upload a document to a record, or a file to one of its file fields',
  params: recordParams,
  query: uploadRecordFileQuery,
  upload: { types: Object.values(documentContentTypes) },
  response: {
    status: 201,
    description: 'The stored file, as the record lists it.',
    schema: recordFile,
  },
});

export const deleteRecordFile = defineEndpoint({
  operationId: 'deleteRecordFile',
  method: 'delete',
  path: '/records/{id}/files/{fileId}',
  group: 'Files',
  summary: 'Delete a file uploaded to a record, for good',
  params: z.strictObject({ id: recordId, fileId: publicId('file') }),
  response: {
    status: 204,
    description:
      "The file is gone, and out of its field when it was in one. A message's attachment stays with its message: 404, as for any file that isn't one of the record's uploads.",
  },
});

/** How long a link to a record's file opens it: five minutes, enough to start a download. */
export const RECORD_FILE_LINK_SECONDS = 300;

export const createRecordFileLink = defineEndpoint({
  operationId: 'createRecordFileLink',
  method: 'post',
  path: '/records/{id}/files/{fileId}/links',
  group: 'Files',
  summary: "Create a short-lived link to one of a record's files",
  params: z.strictObject({ id: recordId, fileId: publicId('file') }),
  response: {
    status: 201,
    description:
      "A signed link that opens the file for five minutes, for whoever may see the record. 404 when the file is not one of the record's.",
    schema: fileLink,
  },
});

export const recordFileEndpoints = [
  listRecordFiles,
  uploadRecordFile,
  deleteRecordFile,
  createRecordFileLink,
] as const;
