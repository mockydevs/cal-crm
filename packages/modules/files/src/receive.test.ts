import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { ContentTooLargeError } from '@repo/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { receiveUpload } from './receive.js';

let directory: string;
beforeEach(async () => {
  directory = join(await mkdtemp(join(tmpdir(), 'crm-receive-')), 'uploads');
});
afterEach(async () => {
  await rm(join(directory, '..'), { recursive: true, force: true });
});

/** A body sent a few bytes at a time, as a slow connection delivers it. */
function trickle(data: Buffer, chunk = 5): Readable {
  const chunks: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunk) chunks.push(data.subarray(at, at + chunk));
  return Readable.from(chunks);
}

describe('receiving an upload', () => {
  it('keeps the body in a file of its own, and counts it', async () => {
    const data = randomBytes(10_000);

    const received = await receiveUpload(trickle(data), { directory, maxBytes: 10_000 });

    expect(received.size).toBe(10_000);
    expect(await readFile(received.path)).toEqual(data);
    expect(received.path.startsWith(directory)).toBe(true);
  });

  it('takes an empty body', async () => {
    const received = await receiveUpload(Readable.from([]), { directory, maxBytes: 10 });

    expect(received.size).toBe(0);
    expect(await readFile(received.path)).toEqual(Buffer.alloc(0));
  });

  it('stops at the limit, keeps nothing, and lets go of the body', async () => {
    let sent = 0;
    const endless = new Readable({
      read() {
        sent += 1024;
        this.push(Buffer.alloc(1024));
      },
    });

    const refused = receiveUpload(endless, { directory, maxBytes: 4096 });

    await expect(refused).rejects.toBeInstanceOf(ContentTooLargeError);
    await expect(refused).rejects.toMatchObject({ maxBytes: 4096 });
    // Streams read ahead a little, how much depends on the platform; then reading stops.
    const atRefusal = sent;
    await delay(50);
    expect(sent).toBe(atRefusal);
    expect(sent).toBeLessThan(1024 * 1024);
    expect(endless.destroyed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps nothing when the body fails partway', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(100));
        this.destroy(new Error('the connection dropped'));
      },
    });

    await expect(receiveUpload(failing, { directory, maxBytes: 4096 })).rejects.toThrow(
      'the connection dropped',
    );
    expect(await readdir(directory)).toEqual([]);
  });
});
