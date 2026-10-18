// TypeID, version 0.3.0 of the spec (https://github.com/jetify-com/typeid/tree/main/spec):
// a type prefix, an underscore, then the UUID's 128 bits as 26 characters of base32.
// The encoding keeps the UUID's order, so TypeIDs of UUIDv7s sort by creation time.

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const PREFIX = /^(?:[a-z](?:[a-z_]{0,61}[a-z])?)?$/;
// 26 characters from the alphabet; the first is at most 7, because 26 × 5 bits is 130
// and the two extra bits must be zero.
const SUFFIX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TypeId {
  /** The type prefix; empty when the TypeID has none. */
  prefix: string;
  /** The UUID, in lowercase. */
  uuid: string;
}

/** The TypeID for a UUID (any version) with this prefix. */
export function encodeTypeId(prefix: string, uuid: string): string {
  if (!PREFIX.test(prefix)) {
    throw new TypeError(`Not a TypeID prefix: ${prefix}`);
  }
  if (!UUID.test(uuid)) {
    throw new TypeError(`Not a UUID: ${uuid}`);
  }
  let bits = BigInt(`0x${uuid.replaceAll('-', '')}`);
  let suffix = '';
  for (let index = 0; index < 26; index += 1) {
    suffix = ALPHABET.charAt(Number(bits & 31n)) + suffix;
    bits >>= 5n;
  }
  return prefix === '' ? suffix : `${prefix}_${suffix}`;
}

/** The prefix and UUID in a TypeID, or undefined when the value isn't a valid TypeID. */
export function decodeTypeId(value: string): TypeId | undefined {
  const separator = value.lastIndexOf('_');
  // When the prefix is empty, the separator is left out too.
  if (separator === 0) {
    return undefined;
  }
  const prefix = separator === -1 ? '' : value.slice(0, separator);
  const suffix = value.slice(separator + 1);
  if (!PREFIX.test(prefix) || !SUFFIX.test(suffix)) {
    return undefined;
  }
  let bits = 0n;
  for (const character of suffix) {
    bits = (bits << 5n) | BigInt(ALPHABET.indexOf(character));
  }
  const hex = bits.toString(16).padStart(32, '0');
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
  return { prefix, uuid };
}
