// A document's public address: /d/<token>, a read-only page with the PDF, where a sent
// quote can be accepted or declined. One address a document.
//
// The token is never stored. It is a keyed digest of the address's own row id (HMAC-SHA-256
// under the install's public intake secret, 256 bits), so the server can write the address
// again whenever it emails the document, and a copy of the database alone opens nothing.
// What the row keeps is the SHA-256 of the token, which finds it when the address is
// opened. Making a new address deletes the row and writes another: the old address stops.
import { createHash, createHmac } from 'node:crypto';

import type { CommandContext } from '@repo/commands';
import { SALES_DOCUMENT_LINK_PATH, type SalesDocumentLink } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError } from '@repo/kernel';
import { sql } from 'kysely';

import { actorOf, type CommerceLinks, type CommerceOptions } from './shared.js';

/** Separates these digests from any other use of the same key. */
const LABEL = 'crm.commerce.document-link.v1';

/** The token of the address whose row has this id. */
export const linkToken = (secret: string, linkId: string): string =>
  createHmac('sha256', secret).update(LABEL).update('\0').update(linkId).digest('base64url');

/** What a row keeps of its token, and what an opened address is looked up by. */
export const linkDigest = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Where addresses start, or nothing when the install has no usable public address. */
function addressBase(publicUrl: string): URL | undefined {
  if (!URL.canParse(publicUrl)) return undefined;
  const base = new URL(publicUrl);
  const web = base.protocol === 'https:' || base.protocol === 'http:';
  return web && base.username === '' && base.password === '' ? base : undefined;
}

/** What the install makes addresses with, or nothing where it serves no public pages. */
function usable(
  links: CommerceLinks | undefined,
): { readonly secret: string; readonly base: URL } | undefined {
  if (links === undefined || links.secret === '') return undefined;
  const base = addressBase(links.publicUrl);
  return base === undefined ? undefined : { secret: links.secret, base };
}

/** Whether this install gives documents public addresses. */
export const linksAvailable = (options: CommerceOptions): boolean =>
  usable(options.links) !== undefined;

const addressOf = (base: URL, token: string): string =>
  new URL(`${SALES_DOCUMENT_LINK_PATH}/${token}`, base).toString();

/**
 * The document's public address, or null when it has none: no row, an install without
 * public pages, or a row made under a secret the install no longer has (its address would
 * open nothing, so it is not shown).
 */
export async function readLink(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  documentId: string,
): Promise<SalesDocumentLink | null> {
  const install = usable(options.links);
  if (install === undefined) return null;
  const row = await trx
    .selectFrom('commerce.document_links')
    .select(['id', 'digest', 'created_at'])
    .where('document_id', '=', documentId)
    .executeTakeFirst();
  if (row === undefined) return null;
  const token = linkToken(install.secret, row.id);
  if (linkDigest(token) !== row.digest) return null;
  return { url: addressOf(install.base, token), createdAt: row.created_at.toISOString() };
}

/** The refusal of an install that serves no public pages, in words for whoever runs it. */
const unavailable = (): ConflictError =>
  new ConflictError(
    'This install gives documents no public address: it needs PUBLIC_INTAKE_SECRET and a PUBLIC_URL.',
  );

/**
 * The document's public address, made if it has none, or made anew when asked (which stops
 * the one before). The caller holds the document's row. Says whether a new one was made.
 */
export async function ensureLink(
  options: CommerceOptions,
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  documentId: string,
  regenerate = false,
): Promise<{ readonly link: SalesDocumentLink; readonly made: boolean }> {
  const install = usable(options.links);
  if (install === undefined) throw unavailable();
  if (!regenerate) {
    const link = await readLink(options, trx, documentId);
    if (link !== null) return { link, made: false };
  }
  // A row whose address no longer works, or one being replaced, goes first.
  await trx.deleteFrom('commerce.document_links').where('document_id', '=', documentId).execute();
  // The id comes first: the token is made from it.
  const { id } = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow();
  const token = linkToken(install.secret, id);
  const actor = actorOf(command.context);
  const row = await trx
    .insertInto('commerce.document_links')
    .values({
      business_id: businessId,
      id,
      document_id: documentId,
      digest: linkDigest(token),
      created_by_kind: actor.kind,
      created_by_id: actor.id,
    })
    .returning('created_at')
    .executeTakeFirstOrThrow();
  return {
    link: { url: addressOf(install.base, token), createdAt: row.created_at.toISOString() },
    made: true,
  };
}
