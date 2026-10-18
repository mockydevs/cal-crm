// Files: logos, attachments, imports and recordings, stored by the files service. The
// limits match files.files.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/**
 * The types a file may have. The files service also checks that images, PDFs, videos and
 * sounds start with their format's signature; SVG and HTML are left out, since they can
 * carry scripts.
 */
export const fileTypes = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  // What a media library holds besides pictures.
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
] as const;

export type FileType = (typeof fileTypes)[number];

/** The longest a file link may last: seven days, in seconds. */
export const MAX_FILE_LINK_SECONDS = 7 * 24 * 60 * 60;

export const storedFile = z
  .looseObject({
    id: publicId('file'),
    filename: z.string().meta({ examples: ['price-list.pdf'] }),
    contentType: z.string().meta({ examples: ['application/pdf'] }),
    size: z.int().min(0).meta({ description: 'In bytes.' }),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .meta({ description: 'The SHA-256 of its bytes, in hexadecimal.' }),
    createdAt: timestamp,
  })
  .meta({ id: 'File', description: 'A file stored for the agency or one of its businesses.' });

// Not File, which names the Web API's File in TypeScript.
export type StoredFile = z.infer<typeof storedFile>;

export const uploadFileQuery = z.strictObject({
  filename: z
    .string()
    .meta({ description: 'The name to show and download it under.', examples: ['logo.png'] }),
  library: z.enum(['true']).optional().meta({
    description:
      "Puts the file in the business's media library. It needs the permission to change the library as well.",
  }),
  folder: publicId('media_folder')
    .optional()
    .meta({ description: 'The library folder to put it in. Only with `library`.' }),
});

export const uploadFile = defineEndpoint({
  operationId: 'uploadFile',
  method: 'post',
  path: '/files',
  summary: 'Upload a file',
  group: 'Files',
  query: uploadFileQuery,
  upload: { types: fileTypes },
  response: {
    status: 201,
    description:
      "The stored file. It belongs to the business you're working in, or to the agency when you have none selected.",
    schema: storedFile,
  },
});

export const fileLink = z
  .looseObject({
    url: z.url().meta({ description: 'Opens the file, without signing in, until it expires.' }),
    expiresAt: timestamp,
  })
  .meta({ id: 'FileLink', description: 'A signed link to a file.' });

export type FileLink = z.infer<typeof fileLink>;

export const createFileLinkInput = z
  .strictObject({
    expiresIn: z
      .int()
      .min(1, { error: 'A link lasts at least a second.' })
      .max(MAX_FILE_LINK_SECONDS, { error: 'A link lasts at most seven days.' })
      .default(3600)
      .meta({ description: 'How long the link works, in seconds: up to seven days.' }),
  })
  .meta({ id: 'CreateFileLinkInput' });

export const createFileLink = defineEndpoint({
  operationId: 'createFileLink',
  method: 'post',
  path: '/files/{id}/links',
  summary: 'Create a link to a file',
  group: 'Files',
  params: z.object({ id: publicId('file') }),
  body: createFileLinkInput,
  response: {
    status: 201,
    description: 'A link that opens the file until it expires.',
    schema: fileLink,
  },
});
