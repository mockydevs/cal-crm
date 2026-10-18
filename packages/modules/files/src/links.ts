// Signed download links. A link names one file, the scope it's read in, and when it stops
// working, all signed with FILES_LINK_SECRET. The server reads the file under the scope the
// link names, so row-level security keeps a link to its own agency or business.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { MAX_FILE_LINK_SECONDS } from '@repo/contracts';
import * as z from 'zod';

/** The longest a link may last: seven days. */
export const MAX_LINK_SECONDS = MAX_FILE_LINK_SECONDS;

/** Where a file is read: its agency, and its business unless it's the agency's own. */
export interface FileScope {
  readonly agencyId: string;
  readonly businessId: string | undefined;
}

export type LinkCheck =
  | { readonly valid: true; readonly scope: FileScope }
  | { readonly valid: false; readonly reason: 'invalid' | 'expired' };

// A UUID's text, an expiry in whole seconds, and an HMAC-SHA256 in base64url (43 characters).
const linkQuery = z.object({
  agency: z.uuid(),
  business: z.uuid().optional(),
  expires: z.string().regex(/^[1-9][0-9]{0,11}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// Every field has a fixed form (UUIDs and digits), so the newlines can't be forged.
function signature(secret: string, fileId: string, scope: FileScope, expires: number): Buffer {
  return createHmac('sha256', secret)
    .update(
      ['crm.files.link.v1', fileId, scope.agencyId, scope.businessId ?? '', String(expires)].join(
        '\n',
      ),
    )
    .digest();
}

/**
 * The query string of a link to the file, lasting the given whole number of seconds, from
 * one second to seven days.
 */
export function signFileLink(
  secret: string,
  fileId: string,
  scope: FileScope,
  lifetime: { readonly now: Date; readonly seconds: number },
): string {
  const { now, seconds } = lifetime;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_LINK_SECONDS) {
    throw new RangeError(
      `A link lasts 1 to ${String(MAX_LINK_SECONDS)} seconds, not ${String(seconds)}.`,
    );
  }
  const expires = Math.floor(now.getTime() / 1000) + seconds;
  const query = new URLSearchParams({ agency: scope.agencyId });
  if (scope.businessId !== undefined) query.set('business', scope.businessId);
  query.set('expires', String(expires));
  query.set('signature', signature(secret, fileId, scope, expires).toString('base64url'));
  return query.toString();
}

/**
 * Whether a link's query opens the file, and in which scope. The signature is checked
 * first, in constant time, so only a genuine link is ever reported as expired.
 */
export function checkFileLink(
  secret: string,
  fileId: string,
  query: unknown,
  now: Date,
): LinkCheck {
  const parsed = linkQuery.safeParse(query);
  if (!parsed.success) return { valid: false, reason: 'invalid' };
  const { agency, business, expires } = parsed.data;
  const scope: FileScope = { agencyId: agency, businessId: business };
  const expected = signature(secret, fileId, scope, Number(expires));
  const given = Buffer.from(parsed.data.signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { valid: false, reason: 'invalid' };
  }
  if (now.getTime() >= Number(expires) * 1000) return { valid: false, reason: 'expired' };
  return { valid: true, scope };
}
