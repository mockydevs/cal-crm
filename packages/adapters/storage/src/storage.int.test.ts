// Both backends keep the same promises: local disk, and S3 against Garage.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { startS3, type S3Server } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localStorage, s3Storage, type Storage } from './index.js';

let directory: string;
// Started here rather than in a global setup, so @repo/testing's S3 server is measured too.
let s3: { server: S3Server; stop: () => Promise<void> };
const stores: Storage[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crm-storage-'));
  s3 = await startS3();
});

afterAll(async () => {
  await Promise.all(stores.map((storage) => storage.close()));
  await s3.stop();
  await rm(directory, { recursive: true, force: true });
});

const backends: [string, () => Storage][] = [
  ['local', () => localStorage({ directory })],
  ['s3', () => s3Storage({ ...s3.server, pathStyle: true, log: () => undefined })],
];

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe.each(backends)('%s storage', (_name, make) => {
  const open = () => {
    const storage = make();
    stores.push(storage);
    return storage;
  };

  it('gives back what it stored, byte for byte', async () => {
    const storage = open();
    const data = randomBytes(3 * 1024 * 1024 + 7);
    const key = randomUUID();

    await storage.put(key, Readable.from([data]), {
      size: data.length,
      contentType: 'application/pdf',
    });

    const stored = await storage.get(key);
    if (stored === undefined) throw new Error('Expected the object.');
    expect(sha256(await read(stored))).toBe(sha256(data));
  });

  it('gives back only the bytes of a range, its first and last included', async () => {
    const storage = open();
    const data = randomBytes(4096);
    const key = randomUUID();
    await storage.put(key, Readable.from([data]), {
      size: data.length,
      contentType: 'video/mp4',
    });

    for (const [start, end] of [
      [0, 0],
      [10, 99],
      [4000, 4095],
    ] as const) {
      const part = await storage.get(key, { start, end });
      if (part === undefined) throw new Error('Expected the object.');
      expect(
        (await read(part)).equals(data.subarray(start, end + 1)),
        `${String(start)}-${String(end)}`,
      ).toBe(true);
    }
  });

  it('finds nothing under a key it never stored', async () => {
    expect(await open().get(randomUUID())).toBeUndefined();
  });

  it('deletes, and deleting what is not there is fine', async () => {
    const storage = open();
    const key = randomUUID();
    await storage.put(key, Readable.from([Buffer.from('hello')]), {
      size: 5,
      contentType: 'text/plain',
    });

    await storage.delete(key);
    await storage.delete(key);

    expect(await storage.get(key)).toBeUndefined();
  });

  it.each([
    ['shorter', 6, 'The body is 5 bytes, not the 6 stated.'],
    ['longer', 4, 'The body is longer than the 4 bytes stated.'],
  ])('refuses a body %s than its stated size, and keeps nothing', async (_case, size, message) => {
    const storage = open();
    const key = randomUUID();

    await expect(
      storage.put(key, Readable.from([Buffer.from('hello')]), { size, contentType: 'text/plain' }),
    ).rejects.toThrow(message);

    expect(await storage.get(key)).toBeUndefined();
  });

  it('refuses a body that runs on past its size, however late, and keeps nothing', async () => {
    const storage = open();
    const key = randomUUID();
    // The stated bytes arrive at once, then an empty chunk, then the extra byte well after,
    // as from a slow sender.
    const body = Readable.from(
      (async function* () {
        yield Buffer.from('hello');
        yield Buffer.alloc(0);
        await delay(500);
        yield Buffer.from('!');
      })(),
    );

    await expect(storage.put(key, body, { size: 5, contentType: 'text/plain' })).rejects.toThrow(
      'The body is longer than the 5 bytes stated.',
    );

    expect(await storage.get(key)).toBeUndefined();
  });

  it('refuses a body that already failed, rather than wait for it', async () => {
    const storage = open();
    const body = new Readable({ read: () => undefined });
    const failed = once(body, 'error');
    body.destroy(new Error('the connection dropped'));
    await failed;

    await expect(
      storage.put(randomUUID(), body, { size: 5, contentType: 'text/plain' }),
    ).rejects.toThrow('the connection dropped');
  });

  it('lets go of a body it refuses', async () => {
    const storage = open();
    const endless = new Readable({
      read() {
        this.push(Buffer.alloc(1024));
      },
    });

    await expect(
      storage.put(randomUUID(), endless, { size: 10, contentType: 'text/plain' }),
    ).rejects.toThrow('The body is longer than the 10 bytes stated.');

    expect(endless.destroyed).toBe(true);
  });

  it('refuses a key that is not a file id', async () => {
    const storage = open();

    for (const key of ['../escape', 'a/b', '', randomUUID().toUpperCase()]) {
      const refused = `"${key}" isn't a file id`;
      const body = Readable.from([Buffer.from('hello')]);
      await expect(
        storage.put(key, body, { size: 5, contentType: 'text/plain' }),
        key,
      ).rejects.toThrow(refused);
      expect(body.destroyed, key).toBe(true);
      await expect(storage.get(key), key).rejects.toThrow(refused);
      await expect(storage.delete(key), key).rejects.toThrow(refused);
    }
  });
});

describe('S3 storage', () => {
  it("passes the SDK's own warnings to its log, not to the console", async () => {
    const logged: string[] = [];
    const storage = s3Storage({
      ...s3.server,
      pathStyle: true,
      log: (level) => {
        logged.push(level);
      },
    });
    stores.push(storage);

    await expect(
      storage.put(randomUUID(), Readable.from([Buffer.from('hello')]), {
        size: 6,
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('The body is 5 bytes, not the 6 stated.');

    expect(logged).toContain('warn');
  });

  it('treats a refused request as an error, not as a missing file', async () => {
    const storage = s3Storage({
      ...s3.server,
      secretAccessKey: 'not-the-secret',
      pathStyle: true,
      log: () => undefined,
    });
    stores.push(storage);
    // More than the service reads before it refuses the request.
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
    });

    await expect(storage.get(randomUUID())).rejects.toMatchObject({ name: 'AccessDenied' });
    await expect(
      storage.put(randomUUID(), body, { size: 64 * 1024 * 1024, contentType: 'text/plain' }),
    ).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(body.destroyed).toBe(true);
  });
});

describe('the S3 test server', () => {
  it('reports the setup step that failed, and stops', async () => {
    await expect(startS3({ bucket: 'Not A Bucket' })).rejects.toThrow(
      'garage bucket create Not A Bucket failed',
    );
  });
});

describe('local storage', () => {
  it('leaves nothing behind when the body fails partway', async () => {
    const own = await mkdtemp(join(tmpdir(), 'crm-storage-'));
    try {
      const storage = localStorage({ directory: own });
      const key = randomUUID();
      const failing = new Readable({
        read() {
          this.push(Buffer.alloc(1024));
          this.destroy(new Error('the connection dropped'));
        },
      });

      await expect(
        storage.put(key, failing, { size: 4096, contentType: 'text/plain' }),
      ).rejects.toThrow('the connection dropped');

      expect(await storage.get(key)).toBeUndefined();
      const left = await readdir(own, { recursive: true, withFileTypes: true });
      expect(left.filter((entry) => entry.isFile())).toEqual([]);
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });
});
