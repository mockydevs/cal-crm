import { Readable } from 'node:stream';
import { allowEveryone, type CommandContext, type Services } from '@repo/commands';
import type { StoredFile } from '@repo/contracts';
import type { Database, DatabaseTransaction } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { readContact, readDeal } from '@repo/module-crm';
import type { FileContent, Files } from '@repo/module-files';
import {
  checkContactEmail,
  findContactEmail,
  holdContactEmail,
  queueContactEmail,
} from '@repo/module-messaging';
import { holdActiveBusiness, readBusinessProfile } from '@repo/module-tenancy';
import { describe, expect, it, vi } from 'vitest';
import { attachmentReader, commerceOptions } from './commerce-options.js';

const fileUuid = '01890a5d-ac96-774b-bcce-b302099a8060';
const fileId = toPublicId('file', fileUuid);
const stored: StoredFile = {
  id: fileId,
  filename: 'Invoice INV-0042.pdf',
  contentType: 'application/pdf',
  size: 11,
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-12T09:00:00.000Z',
};
const context: TenantContext = {
  agencyId: '01890a5d-ac96-774b-bcce-b302099a8057',
  businessId: '01890a5d-ac96-774b-bcce-b302099a8058',
  actorKind: 'system',
  correlationId: '01890a5d-ac96-774b-bcce-b302099a8059',
};
// The fakes below never touch a database: these only stand for the caller's own handles.
const trx = {} as DatabaseTransaction;
const services: Services = { db: {} as Database, authorize: allowEveryone };

/** A file's content as the files service gives it, opened from its start each time. */
const contentOf = (file: StoredFile, chunks: readonly Uint8Array[]): FileContent => ({
  file,
  shared: false,
  open: () => Promise.resolve(Readable.from(chunks)),
});

/** A files service with only what the test hands over; the rest is not there to call. */
const filesWith = (parts: Partial<Files>): Files => parts as Files;

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe('what the commerce module is composed with', () => {
  it("always has the other modules' own readers and messaging's way out for an email", () => {
    expect(commerceOptions()).toEqual({
      business: { holdActive: holdActiveBusiness, profile: readBusinessProfile },
      contacts: { read: readContact },
      deals: { read: readDeal },
      mail: {
        hold: holdContactEmail,
        find: findContactEmail,
        check: checkContactEmail,
        send: queueContactEmail,
      },
    });
  });

  it('has no files and no public addresses on an install that has neither', () => {
    const options = commerceOptions({});
    expect(options.files).toBeUndefined();
    expect(options.links).toBeUndefined();
  });

  it('makes public addresses only with both the public URL and the intake secret', () => {
    const publicUrl = 'https://crm.example.test';
    const publicIntakeSecret = 'public-intake-test-key-with-at-least-32-bytes';
    expect(commerceOptions({ publicUrl }).links).toBeUndefined();
    expect(commerceOptions({ publicIntakeSecret }).links).toBeUndefined();
    expect(commerceOptions({ publicUrl, publicIntakeSecret }).links).toEqual({
      secret: publicIntakeSecret,
      publicUrl,
    });
    // A files service is not what an address is made with.
    expect(commerceOptions({ publicUrl, publicIntakeSecret }).files).toBeUndefined();
  });

  it("reads a logo through the files service, in the caller's own transaction", async () => {
    const logo = { ...stored, filename: 'logo.png', contentType: 'image/png', size: 8 };
    const contentIn = vi
      .fn<Files['contentIn']>()
      .mockResolvedValue(contentOf(logo, [Buffer.from('png-'), Buffer.from('logo')]));
    const options = commerceOptions({ files: filesWith({ contentIn }) });
    expect(options.links).toBeUndefined();

    const read = await options.files?.read(trx, fileId);

    expect(contentIn).toHaveBeenCalledExactlyOnceWith(trx, fileId);
    // What commerce prints with: the type, the size and the way to the bytes, nothing else.
    expect(Object.keys(read ?? {}).sort()).toEqual(['contentType', 'open', 'size']);
    expect(read).toMatchObject({ contentType: 'image/png', size: 8 });
    expect(read === undefined ? undefined : (await bytesOf(await read.open())).toString()).toBe(
      'png-logo',
    );
  });

  it('reads nothing for a logo that is gone', async () => {
    const contentIn = vi.fn<Files['contentIn']>().mockResolvedValue(undefined);
    const options = commerceOptions({ files: filesWith({ contentIn }) });
    expect(await options.files?.read(trx, fileId)).toBeUndefined();
  });

  it("keeps an emailed document as a PDF in the command's transaction, and gives its id", async () => {
    const store = vi.fn<Files['store']>().mockResolvedValue(stored);
    const options = commerceOptions({ files: filesWith({ store }) });
    const command: CommandContext = {
      context,
      permissions: 'all',
      emit: () => Promise.reject(new Error('Keeping a PDF emits nothing.')),
      enqueue: () => undefined,
    };
    const content = new Uint8Array(Buffer.from('%PDF-1.7 synthetic'));

    const id = await options.files?.store(trx, command, { filename: stored.filename, content });

    expect(id).toBe(fileId);
    expect(store).toHaveBeenCalledExactlyOnceWith(trx, command, {
      filename: stored.filename,
      content,
      contentType: 'application/pdf',
    });
  });
});

describe('how the worker reads a file an email carries', () => {
  it("reads the whole file, as the system, in the message's own business", async () => {
    const content = vi
      .fn<Files['content']>()
      .mockResolvedValue(contentOf(stored, [Buffer.from('%PDF-'), new Uint8Array([49, 46, 55])]));
    const read = attachmentReader(filesWith({ content }), services);

    const attachment = await read(context, fileUuid);

    expect(attachment).toEqual({
      filename: 'Invoice INV-0042.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.7'),
    });
    // A job holds the file's own id; the files service is asked by its public one.
    expect(content).toHaveBeenCalledExactlyOnceWith(
      services,
      { context, permissions: 'all' },
      fileId,
    );
  });

  it('gives nothing for a file that is gone, so the message is not sent', async () => {
    const content = vi.fn<Files['content']>().mockResolvedValue(undefined);
    const read = attachmentReader(filesWith({ content }), services);
    expect(await read(context, fileUuid)).toBeUndefined();
  });
});
