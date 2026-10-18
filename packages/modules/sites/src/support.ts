// What every part of the sites module shares: how an id that names nothing is answered,
// who may do what, how a list's page is marked, and the lock that makes a count still true
// when a row is added.
import type { CommandContext, Invocation } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import type { DatabaseTransaction, Json } from '@repo/db';
import {
  ConflictError,
  isUuidV7,
  parsePublicId,
  ValidationError,
  type PublicIdKind,
} from '@repo/kernel';
import { sql, type RawBuilder } from 'kysely';

export const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

// The UUID inside a public id, or the nil UUID, which no row has: an id that is not one
// names nothing, and is answered as an id nothing has.
const NOTHING = '00000000-0000-0000-0000-000000000000';
export const uuidOf = (kind: PublicIdKind, id: string): string =>
  parsePublicId(kind, id) ?? NOTHING;

export const may = (invocation: Invocation, permission: Permission): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has(permission);

export const asJson = (value: unknown): RawBuilder<Json> =>
  sql<Json>`${JSON.stringify(value)}::jsonb`;

/** Who a row was made by, as its created_by columns hold it. */
export const madeBy = (
  command: CommandContext,
): { created_by_kind: CommandContext['context']['actorKind']; created_by_id: string | null } => ({
  created_by_kind: command.context.actorKind,
  created_by_id: command.context.actorId ?? null,
});

/** Refuses a change made from a revision that is no longer the row's. */
export function requireRevision(current: number, given: number, what: string): void {
  if (current !== given)
    throw new ConflictError(`This ${what} changed since you opened it. Reload before saving.`);
}

/** A search as a LIKE pattern: the text anywhere, with its own % and _ taken literally. */
export const containing = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

// Where a page of a list ended: the last row's place in the order, and its id. Opaque to
// callers, and still good when that row has since been deleted.
export const encodeCursor = (place: string, id: string): string =>
  Buffer.from(JSON.stringify([place, id])).toString('base64url');

export function decodeCursor(cursor: string): readonly [place: string, id: string] {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(decoded) && decoded.length === 2) {
      const pair: readonly unknown[] = decoded;
      const [place, id] = pair;
      if (typeof place === 'string' && typeof id === 'string' && isUuidV7(id)) return [place, id];
    }
  } catch {
    // Not a cursor this list gave: answered below, like any other that isn't.
  }
  throw invalid('/after', 'invalid_cursor', 'Start from the next a page of this list gave.');
}

/**
 * One writer at a time adds to one of a business's collections, so the count it reads is
 * still true when it inserts.
 */
export async function serializeAdditions(
  trx: DatabaseTransaction,
  businessId: string,
  what: string,
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(${`sites.${what}:${businessId}`}, 0))
  `.execute(trx);
}

/** The values of a comma-separated filter, trimmed, without empties or repeats. */
export const several = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : [
        ...new Set(
          value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== ''),
        ),
      ];
