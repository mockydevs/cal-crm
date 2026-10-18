// What the commerce module is composed with, for its API routes and for its public pages
// alike: tenancy says who the business is, the CRM who the contact is and whether an
// opportunity is the business's, the files service reads a logo and keeps a PDF that is
// emailed, and messaging sends that email through its own outbound pipeline.
import type { Services } from '@repo/commands';
import { toPublicId } from '@repo/kernel';
import type { CommerceOptions } from '@repo/module-commerce';
import { readContact, readDeal } from '@repo/module-crm';
import type { Files } from '@repo/module-files';
import {
  checkContactEmail,
  findContactEmail,
  holdContactEmail,
  queueContactEmail,
  type OutboundAttachmentReader,
} from '@repo/module-messaging';
import { holdActiveBusiness, readBusinessProfile } from '@repo/module-tenancy';

/** What only a running install has: its files service, and what public addresses are made with. */
export interface CommerceInstall {
  /** The files service, where this role has one. */
  readonly files?: Files | undefined;
  /** PUBLIC_URL. */
  readonly publicUrl?: string | undefined;
  /** PUBLIC_INTAKE_SECRET: without it the install serves no public page of any kind. */
  readonly publicIntakeSecret?: string | undefined;
}

export function commerceOptions(install: CommerceInstall = {}): CommerceOptions {
  const { files, publicUrl, publicIntakeSecret } = install;
  return {
    business: { holdActive: holdActiveBusiness, profile: readBusinessProfile },
    contacts: { read: readContact },
    deals: { read: readDeal },
    // An email is queued in the sending command's own transaction; the worker delivers it.
    mail: {
      hold: holdContactEmail,
      find: findContactEmail,
      check: checkContactEmail,
      send: queueContactEmail,
    },
    ...(files === undefined
      ? {}
      : {
          files: {
            read: async (trx, fileId) => {
              const found = await files.contentIn(trx, fileId);
              return found === undefined
                ? undefined
                : {
                    contentType: found.file.contentType,
                    size: found.file.size,
                    open: () => found.open(),
                  };
            },
            store: async (trx, command, file) =>
              (await files.store(trx, command, { ...file, contentType: 'application/pdf' })).id,
          },
        }),
    ...(publicUrl === undefined || publicIntakeSecret === undefined
      ? {}
      : { links: { secret: publicIntakeSecret, publicUrl } }),
  };
}

/**
 * How the worker reads a file an email carries: through the files service, in the
 * message's own business, as the system. A file that is gone is undefined, and the message
 * is then not sent.
 */
export function attachmentReader(files: Files, services: Services): OutboundAttachmentReader {
  return async (context, fileId) => {
    const found = await files.content(
      services,
      { context, permissions: 'all' },
      toPublicId('file', fileId),
    );
    if (found === undefined) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of await found.open()) chunks.push(Buffer.from(chunk as Uint8Array));
    return {
      filename: found.file.filename,
      contentType: found.file.contentType,
      content: Buffer.concat(chunks),
    };
  };
}
