import { parsePublicId, publicIdPrefixes, toPublicId, type PublicIdKind } from '@repo/kernel';
import * as z from 'zod';

// Any UUIDv7, to show what an id of each kind looks like.
const EXAMPLE_UUID = '01890a5d-ac96-774b-bcce-b302099a8057';

// What follows the prefix: a UUIDv7 in TypeID's base32.
const ENCODED = '_[0-7][0-9a-hjkmnp-tv-z]{25}';

/**
 * A public id of one kind, such as tag_01h455vb4pex5vsknk084sn02q. The pattern documents
 * the format in OpenAPI; the refinement also checks the UUIDv7 inside. A value that misses
 * the pattern stops there, so it gets one issue rather than two.
 */
export function publicId(kind: PublicIdKind): z.ZodString {
  const name = kind.replaceAll('_', ' ');
  const article = /^[aeiou]/.test(name) ? 'an' : 'a';
  const error = `Not ${article} ${name} id.`;
  return z
    .string()
    .regex(new RegExp(`^${publicIdPrefixes[kind]}${ENCODED}$`), { error, abort: true })
    .refine((value) => parsePublicId(kind, value) !== undefined, { error })
    .meta({
      description: `${article === 'an' ? 'An' : 'A'} ${name} id.`,
      examples: [toPublicId(kind, EXAMPLE_UUID)],
    });
}

/** The kinds of record (crm.records) the API shows ids for. */
export const recordKinds = [
  'contact',
  'company',
  'deal',
] as const satisfies readonly PublicIdKind[];

export type RecordKind = (typeof recordKinds)[number];

/** The kind of record a public id names, and its UUID, or undefined if it names none. */
export function parseRecordId(value: string): { kind: RecordKind; id: string } | undefined {
  for (const kind of recordKinds) {
    const id = parsePublicId(kind, value);
    if (id !== undefined) {
      return { kind, id };
    }
  }
  return undefined;
}

const recordIdError = 'Not a record id.';

/** A record's public id, of any kind in recordKinds, such as a contact's con_… */
export const recordId = z
  .string()
  .regex(
    new RegExp(`^(${recordKinds.map((kind) => publicIdPrefixes[kind]).join('|')})${ENCODED}$`),
    { error: recordIdError, abort: true },
  )
  .refine((value) => parseRecordId(value) !== undefined, { error: recordIdError })
  .meta({
    description: 'A record id: a contact, company or deal.',
    examples: [toPublicId('contact', EXAMPLE_UUID)],
  });
