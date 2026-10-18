// Local disk: a directory on the data volume. A body is written to a temporary file and
// renamed into place, so a key never holds part of one.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { checkKey, exactly, type Storage } from './storage.js';

export interface LocalStorageOptions {
  readonly directory: string;
}

export function localStorage({ directory }: LocalStorageOptions): Storage {
  // Spread over 256 folders by the id's last two digits, which are random.
  const pathOf = (key: string) => join(directory, checkKey(key).slice(-2), key);
  const temporary = join(directory, '.tmp');
  return {
    kind: 'local',
    async put(key, body, { size }) {
      const partial = join(temporary, randomUUID());
      try {
        const target = pathOf(key);
        await mkdir(temporary, { recursive: true });
        await mkdir(dirname(target), { recursive: true });
        await pipeline(body, exactly(size), createWriteStream(partial, { flags: 'wx' }));
        await rename(partial, target);
      } catch (error) {
        body.destroy();
        await rm(partial, { force: true });
        throw error;
      }
    },
    async get(key, range) {
      const path = pathOf(key);
      try {
        const file = await open(path, 'r');
        // Node's start and end are both included, as a ByteRange's are.
        return file.createReadStream(range);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
    close: () => Promise.resolve(),
  };
}
