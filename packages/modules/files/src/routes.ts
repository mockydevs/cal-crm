// The files module's API routes. Downloads aren't among them: a link opens a file without
// signing in, so the server serves /files/{id}/content itself, through Files.open.
import { Readable } from 'node:stream';

import type { ApiRoute, Route, UploadBody } from '@repo/commands';
import {
  createFileLink,
  createFileLinkInput,
  parseInput,
  uploadFile,
  uploadFileQuery,
} from '@repo/contracts';
import { ContentTooLargeError, ValidationError } from '@repo/kernel';

import type { Files } from './files.js';

/** The body the server hands an upload route; anything else is a fault in the server. */
function uploadBodyOf(body: unknown): UploadBody {
  if (
    typeof body === 'object' &&
    body !== null &&
    'stream' in body &&
    body.stream instanceof Readable
  ) {
    return {
      stream: body.stream,
      contentType:
        'contentType' in body && typeof body.contentType === 'string'
          ? body.contentType
          : undefined,
      contentLength:
        'contentLength' in body && typeof body.contentLength === 'number'
          ? body.contentLength
          : undefined,
    };
  }
  throw new Error('uploadFile takes the request body unread, as an UploadBody.');
}

/** The files module's API routes; links are absolute, under apiUrl (PUBLIC_URL/api/v1). */
export function fileRoutes(files: Files, options: { readonly apiUrl: string }): ApiRoute[] {
  const uploadFileRoute = {
    endpoint: uploadFile,
    command: files.createFileCommand,
    async run({ invocation, query, body }, services) {
      const { filename, library, folder } = parseInput(uploadFileQuery, query);
      if (folder !== undefined && library === undefined)
        throw new ValidationError([
          {
            path: '/folder',
            code: 'library_required',
            message: 'A folder is for a file that goes in the media library: send library=true.',
          },
        ]);
      const { stream, contentType, contentLength } = uploadBodyOf(body);
      // Refused before a byte is read, when the request says it's too large.
      if (contentLength !== undefined && contentLength > files.maxBytes) {
        throw new ContentTooLargeError(files.maxBytes);
      }
      return files.upload(services, invocation, {
        body: stream,
        contentType,
        filename,
        ...(library === undefined ? {} : { library: { folderId: folder ?? null } }),
      });
    },
  } satisfies Route<typeof uploadFile>;

  const createFileLinkRoute = {
    endpoint: createFileLink,
    async run({ invocation, params, body }, services) {
      const { id } = parseInput(createFileLink.params, params);
      const { expiresIn } = parseInput(createFileLinkInput, body);
      const link = await files.link(services, invocation, id, { seconds: expiresIn });
      return { url: `${options.apiUrl}${link.path}`, expiresAt: link.expiresAt };
    },
  } satisfies Route<typeof createFileLink>;

  return [uploadFileRoute, createFileLinkRoute];
}
