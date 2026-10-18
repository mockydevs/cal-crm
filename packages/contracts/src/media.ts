// Media Storage: a business's library of files, its folders and the public addresses of the
// files someone made public. A library file is a stored file (files.ts) that was uploaded
// into the library; the limits match files.files and files.folders.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** Bounds the folder tree a business keeps, and how deep it nests. */
export const MEDIA_FOLDER_LIMIT = 500;
export const MEDIA_FOLDER_MAX_DEPTH = 5;
/** The most files one move or delete names. */
export const MEDIA_BULK_LIMIT = 100;
/** The most files a page of the library holds. */
export const MEDIA_PAGE_LIMIT = 100;

/** The groups the library's type filter offers. */
export const mediaKinds = ['image', 'video', 'audio', 'document'] as const;
export type MediaKind = (typeof mediaKinds)[number];

/** The group a stored type belongs to: everything that is not a picture or a recording is a document. */
export function mediaKindOf(contentType: string): MediaKind {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'document';
}

export const mediaSorts = [
  'modified_desc',
  'modified_asc',
  'name_asc',
  'name_desc',
  'size_desc',
  'size_asc',
] as const;
export type MediaSort = (typeof mediaSorts)[number];

/** Where a file is used, as far as the database knows (files.file_usage). */
export const mediaUses = [
  'business_logo',
  'agency_logo',
  'user_picture',
  'calendar',
  'message_attachment',
  'import',
  'site_template',
  'record_file',
  'contact_export',
] as const;
export type MediaUse = (typeof mediaUses)[number];

const fileId = publicId('file');
const folderId = publicId('media_folder');

/** A file's name: an upload's rules (no control characters or direction overrides). */
export const mediaFileName = z
  .string()
  .trim()
  .min(1, { error: 'Give the file a name.' })
  .max(255, { error: 'Use at most 255 characters.' })
  .regex(/^[^\p{Cc}‪-‮⁦-⁩]*$/u, {
    error: "A file name can't hold control characters.",
  });

const folderName = z
  .string()
  .trim()
  .min(1, { error: 'Give the folder a name.' })
  .max(120, { error: 'Use at most 120 characters.' })
  .regex(/^[^\p{Cc}‪-‮⁦-⁩]*$/u, {
    error: "A folder name can't hold control characters.",
  });

export const mediaFile = z
  .looseObject({
    id: fileId,
    name: z.string().meta({ examples: ['storefront.jpg'] }),
    contentType: z.string().meta({ examples: ['image/jpeg'] }),
    kind: z.enum(mediaKinds),
    size: z.int().min(0).meta({ description: 'In bytes.' }),
    folderId: folderId.nullable().meta({ description: 'Null at the top of the library.' }),
    public: z.boolean(),
    publicUrl: z.url().nullable().meta({
      description:
        'Its public address, which anyone can open and which stays the same until the file is made private or deleted. Null while it is private.',
    }),
    previewUrl: z.url().nullable().meta({
      description:
        'A signed address a browser can show the file from (an image, a video, a sound or a PDF) for about an hour. Null for a type a browser does not show.',
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'MediaFile', description: "A file in the business's media library." });
export type MediaFile = z.output<typeof mediaFile>;

export const mediaFileDetail = mediaFile
  .extend({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    usedIn: z.array(z.enum(mediaUses)).meta({
      description:
        'Where the file is used, as far as the database knows. A file that is used cannot be deleted. A file named only inside a form or a page is not seen.',
    }),
  })
  .meta({ id: 'MediaFileDetail' });
export type MediaFileDetail = z.output<typeof mediaFileDetail>;

export const mediaFileList = z
  .looseObject({
    canManage: z.boolean(),
    canPublish: z.boolean().meta({
      description:
        'Whether this install answers public addresses at all. Where it does not, no file can be made public.',
    }),
    items: z.array(mediaFile).max(MEDIA_PAGE_LIMIT),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'MediaFileList' });
export type MediaFileList = z.output<typeof mediaFileList>;

export const listMediaQuery = z.strictObject({
  folder: z
    .union([folderId, z.literal('root')])
    .optional()
    .meta({
      description:
        'A folder\'s id, or "root" for the top of the library. Left out: every folder, which is how a search reads the whole library.',
    }),
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .meta({ description: 'Part of a file name, in any case.' }),
  kind: z.enum(mediaKinds).optional(),
  visibility: z
    .enum(['public'])
    .optional()
    .meta({ description: 'Only the files with a public address.' }),
  sort: z.enum(mediaSorts).default('modified_desc'),
  limit: z.coerce.number().int().min(1).max(MEDIA_PAGE_LIMIT).default(50),
  cursor: z
    .string()
    .max(600)
    .optional()
    .meta({ description: 'The `nextCursor` of the page before, with the same sort.' }),
});

export const mediaUsage = z
  .looseObject({
    files: z.int().min(0).meta({ description: 'How many files the library holds.' }),
    bytes: z.int().min(0).meta({ description: 'What the library holds, in bytes.' }),
    businessBytes: z.int().min(0).meta({
      description:
        'Every live file of the business, in bytes: the library, attachments, imports and generated documents. This is what the quota counts.',
    }),
    quotaBytes: z.int().min(1).nullable().meta({
      description: 'The most the business may store, or null when the install sets no limit.',
    }),
    maxFileBytes: z.int().min(1).meta({ description: 'The largest single upload taken.' }),
  })
  .meta({ id: 'MediaUsage' });
export type MediaUsage = z.output<typeof mediaUsage>;

export const updateMediaFileInput = z
  .strictObject({
    name: mediaFileName.optional(),
    public: z.boolean().optional().meta({
      description:
        'True gives the file a public address; false takes it away. Making it public again gives a new address.',
    }),
  })
  .refine((input) => input.name !== undefined || input.public !== undefined, {
    error: 'Give a new name, or say whether the file is public.',
  })
  .meta({ id: 'UpdateMediaFileInput' });

const ids = z
  .array(fileId)
  .min(1, { error: 'Name at least one file.' })
  .max(MEDIA_BULK_LIMIT, { error: `Name at most ${String(MEDIA_BULK_LIMIT)} files at once.` })
  .refine((list) => new Set(list).size === list.length, { error: 'Name each file once.' });

export const moveMediaInput = z
  .strictObject({
    ids,
    folderId: folderId.nullable().meta({ description: 'Null moves to the top of the library.' }),
  })
  .meta({ id: 'MoveMediaInput' });

export const deleteMediaInput = z.strictObject({ ids }).meta({ id: 'DeleteMediaInput' });

export const mediaBulkResult = z
  .looseObject({ count: z.int().min(0) })
  .meta({ id: 'MediaBulkResult', description: 'How many files the request changed.' });
export type MediaBulkResult = z.output<typeof mediaBulkResult>;

export const mediaFolder = z
  .looseObject({
    id: folderId,
    parentId: folderId.nullable(),
    name: z.string(),
    fileCount: z.int().min(0).meta({ description: 'The files directly inside it.' }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'MediaFolder' });
export type MediaFolder = z.output<typeof mediaFolder>;

export const mediaFolderList = z
  .looseObject({
    canManage: z.boolean(),
    items: z.array(mediaFolder).max(MEDIA_FOLDER_LIMIT),
  })
  .meta({ id: 'MediaFolderList' });
export type MediaFolderList = z.output<typeof mediaFolderList>;

export const createMediaFolderInput = z
  .strictObject({ name: folderName, parentId: folderId.nullable().default(null) })
  .meta({ id: 'CreateMediaFolderInput' });

export const updateMediaFolderInput = z
  .strictObject({ name: folderName.optional(), parentId: folderId.nullable().optional() })
  .refine((input) => input.name !== undefined || input.parentId !== undefined, {
    error: 'Give a new name or destination folder.',
  })
  .meta({ id: 'UpdateMediaFolderInput' });

const fileParams = z.strictObject({ id: fileId });
const folderParams = z.strictObject({ id: folderId });
const group = 'Media storage';

export const listMedia = defineEndpoint({
  operationId: 'listMedia',
  method: 'get',
  path: '/media',
  summary: 'List the files in the media library',
  group,
  query: listMediaQuery,
  response: {
    status: 200,
    description: 'A page of files, with whether the caller may change the library.',
    schema: mediaFileList,
  },
});

export const getMediaUsage = defineEndpoint({
  operationId: 'getMediaUsage',
  method: 'get',
  path: '/media/usage',
  summary: 'Read how much the business stores',
  group,
  response: {
    status: 200,
    description: "The library's size, the business's whole storage and the limits.",
    schema: mediaUsage,
  },
});

export const getMediaFile = defineEndpoint({
  operationId: 'getMediaFile',
  method: 'get',
  path: '/media/{id}',
  summary: 'Read a file in the media library',
  group,
  params: fileParams,
  response: {
    status: 200,
    description: 'The file, and where it is used.',
    schema: mediaFileDetail,
  },
});

export const updateMediaFile = defineEndpoint({
  operationId: 'updateMediaFile',
  method: 'patch',
  path: '/media/{id}',
  summary: 'Rename a file, or make it public or private',
  group,
  params: fileParams,
  body: updateMediaFileInput,
  response: { status: 200, description: 'The file after the change.', schema: mediaFile },
});

export const moveMedia = defineEndpoint({
  operationId: 'moveMedia',
  method: 'post',
  path: '/media/move',
  summary: 'Move files to a folder',
  group,
  body: moveMediaInput,
  response: {
    status: 200,
    description:
      'All of the files moved, or none: a file that is not in the library refuses the request.',
    schema: mediaBulkResult,
  },
});

export const deleteMedia = defineEndpoint({
  operationId: 'deleteMedia',
  method: 'post',
  path: '/media/delete',
  summary: 'Delete files for good',
  group,
  body: deleteMediaInput,
  response: {
    status: 200,
    description:
      'All of the files are deleted and their bytes removed from storage, or none: a file that is still used somewhere refuses the request with 409.',
    schema: mediaBulkResult,
  },
});

export const listMediaFolders = defineEndpoint({
  operationId: 'listMediaFolders',
  method: 'get',
  path: '/media-folders',
  summary: 'Read the media folder tree',
  group,
  response: {
    status: 200,
    description: 'Every folder, with how many files each holds directly.',
    schema: mediaFolderList,
  },
});

export const createMediaFolder = defineEndpoint({
  operationId: 'createMediaFolder',
  method: 'post',
  path: '/media-folders',
  summary: 'Create a media folder',
  group,
  body: createMediaFolderInput,
  response: { status: 201, description: 'The new folder.', schema: mediaFolder },
});

export const updateMediaFolder = defineEndpoint({
  operationId: 'updateMediaFolder',
  method: 'patch',
  path: '/media-folders/{id}',
  summary: 'Rename or move a media folder',
  group,
  params: folderParams,
  body: updateMediaFolderInput,
  response: {
    status: 200,
    description: 'The folder after the change. A move into itself or too deep is refused.',
    schema: mediaFolder,
  },
});

export const removeMediaFolder = defineEndpoint({
  operationId: 'removeMediaFolder',
  method: 'delete',
  path: '/media-folders/{id}',
  summary: 'Remove a folder, moving what it holds to its parent',
  group,
  params: folderParams,
  response: {
    status: 204,
    description: 'The folder is gone; its files and folders are now in its parent.',
  },
});

export const mediaEndpoints = [
  listMedia,
  getMediaUsage,
  getMediaFile,
  updateMediaFile,
  moveMedia,
  deleteMedia,
  listMediaFolders,
  createMediaFolder,
  updateMediaFolder,
  removeMediaFolder,
] as const;
