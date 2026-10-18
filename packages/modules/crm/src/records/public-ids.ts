import { parsePublicId, type PublicIdKind } from '@repo/kernel';

/** No row has this id: a lookup by it finds nothing. */
export const NO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The UUID inside a public id of this kind, for a lookup: one that names no such thing
 * gives NO_UUID, so the lookup finds nothing and says so in its own words.
 */
export const uuidOf = (kind: PublicIdKind, id: string): string =>
  parsePublicId(kind, id) ?? NO_UUID;
