// How a search's text becomes the lookups that private.search_contacts, search_companies
// and search_deals run: word prefixes for the full-text indexes, and a LIKE pattern for the
// trigram indexes.

/**
 * The shortest search matched anywhere in a name or address: trigram indexes need three
 * characters. A shorter one matches the start of a name's words.
 */
export const MIN_PART = 3;

/** Text for LIKE that matches itself: %, _ and the escape character lose their meaning. */
export const literal = (text: string): string =>
  text.replace(/[\\%_]/g, (character) => `\\${character}`);

/** Each word as a prefix, all of them required: "thom may" finds Maya Thompson. */
export function prefixQuery(text: string): string | undefined {
  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word !== '');
  return words.length === 0 ? undefined : words.map((word) => `${word}:*`).join(' & ');
}

/** The LIKE pattern for any part of a name, for a search long enough to have one. */
export const partPattern = (text: string): string | undefined =>
  text.length >= MIN_PART ? `%${literal(text)}%` : undefined;
