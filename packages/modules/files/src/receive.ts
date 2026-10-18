// Receiving an upload: the body goes to a temporary file of its own, counted on the way,
// and reading stops at the limit. Nothing reaches storage or the database until the whole
// body is here; then file.create checks it.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ContentTooLargeError } from '@repo/kernel';

export interface Received {
  /** The temporary file holding the body; the caller removes it. */
  readonly path: string;
  readonly size: number;
}

/**
 * Reads the body into a new file in the directory. A body over maxBytes is refused with
 * ContentTooLargeError as soon as it passes the limit; then, as on any failure, the body is
 * destroyed and nothing is kept.
 */
export async function receiveUpload(
  body: Readable,
  options: { readonly directory: string; readonly maxBytes: number },
): Promise<Received> {
  const { directory, maxBytes } = options;
  await mkdir(directory, { recursive: true });
  const path = join(directory, randomUUID());
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new ContentTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return { path, size };
}
