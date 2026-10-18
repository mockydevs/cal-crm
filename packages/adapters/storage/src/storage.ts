// What the files service needs from a storage backend.
import { Transform, type Readable } from 'node:stream';

export interface ObjectInfo {
  /** The body's exact length, in bytes. */
  readonly size: number;
  readonly contentType: string;
}

/** Part of an object: its first and last byte, both counted from 0 and both included. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface Storage {
  /** Recorded with each file, in files.files.storage. */
  readonly kind: 'local' | 's3';
  /**
   * Stores the body under the key, reading it to its end. A body longer or shorter than
   * its size is refused, and nothing is kept. When the put fails, the body is destroyed.
   */
  put(key: string, body: Readable, info: ObjectInfo): Promise<void>;
  /**
   * The stored bytes, or undefined when there's nothing under the key. With a range, only
   * those bytes: the caller keeps the range inside the object, whose size it knows.
   */
  get(key: string, range?: ByteRange): Promise<Readable | undefined>;
  /** Removes the object; removing one that isn't there is fine. */
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

// A key is the file row's id, a lower-case UUID, so it can't reach outside its place.
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function checkKey(key: string): string {
  if (!FILE_ID.test(key)) {
    throw new Error(`"${key}" isn't a file id.`);
  }
  return key;
}

/**
 * Passes the body through, failing as soon as it's longer than stated, or at its end if
 * it's shorter. The latest chunk waits for the next one, or for the end, so a reader never
 * has every stated byte of a body that turns out longer: an S3 service would store it.
 */
export function exactly(size: number): Transform {
  let seen = 0;
  let held: Buffer | undefined;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length === 0) {
        callback();
        return;
      }
      seen += chunk.length;
      if (seen > size) {
        callback(new Error(`The body is longer than the ${String(size)} bytes stated.`));
        return;
      }
      const previous = held;
      held = chunk;
      callback(null, previous);
    },
    flush(callback) {
      if (seen !== size) {
        callback(new Error(`The body is ${String(seen)} bytes, not the ${String(size)} stated.`));
        return;
      }
      callback(null, held);
    },
  });
}
