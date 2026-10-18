// The duplicate finder's rules that need no database: how a page of groups is resumed, what
// makes a group a weaker sign, how similar names become groups, and when a rejection still
// hides a group. The match keys themselves are the database's (private.contact_match_key),
// so that every writer of an address keeps them the same way.
import type { DuplicateFindMode, DuplicateReason } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** As long as a key may be (crm.duplicate_rejections.value_key, an email address). */
const MAX_KEY = 320;

const badCursor = () =>
  new ValidationError([
    {
      path: '/cursor',
      code: 'invalid_cursor',
      message: "Start from a page's next, as the previous page gave it.",
    },
  ]);

/**
 * Where the next page starts: after this match key (email, phone), or after this contact,
 * the first of a name group. A key is an email address, so it travels encoded.
 */
export function encodeGroupCursor(by: DuplicateFindMode, value: string): string {
  return by === 'name' ? value : Buffer.from(value, 'utf8').toString('base64url');
}

/** The key or contact a cursor starts after; undefined for the first page. */
export function decodeGroupCursor(
  by: DuplicateFindMode,
  cursor: string | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  if (by === 'name') {
    if (!UUID.test(cursor)) throw badCursor();
    return cursor;
  }
  if (!BASE64URL.test(cursor)) throw badCursor();
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (key.length === 0 || key.length > MAX_KEY) throw badCursor();
  return key;
}

const sameName = (name: string | null) => (name ?? '').trim().toLocaleLowerCase();

/**
 * Whether a group is a weaker sign. The same address with another +tag outside Gmail: some
 * providers deliver a +tag to the address before it and some don't. The same last ten
 * digits under names that differ: a number can be read under the wrong country, or two
 * people can have numbers that end alike. Names are found only with a second sign.
 */
export function isWeakGroup(
  by: DuplicateFindMode,
  valueKey: string,
  names: readonly (string | null)[],
): boolean {
  if (by === 'email') return !valueKey.endsWith('@gmail.com');
  if (by === 'phone') {
    const first = names[0];
    return (
      first === undefined ||
      first === null ||
      names.some((name) => name === null || sameName(name) !== sameName(first))
    );
  }
  return false;
}

/** Two contacts with names alike, and which second signs they share. */
export interface NamePair {
  readonly a: string;
  readonly o: string;
  readonly company: boolean;
  readonly emailName: boolean;
  readonly phone: boolean;
}

export interface NameGroup {
  /** The contact the group was found from: the first by id. */
  readonly anchor: string;
  /** The anchor, then the others, by id. */
  readonly ids: readonly string[];
  readonly reasons: readonly DuplicateReason[];
}

/**
 * Each contact with the others whose names are alike and that share a second sign with it:
 * a name alone puts too many John Smiths together. Groups come in order of their first
 * contact, as a page of them is walked.
 */
export function nameGroupsOf(pairs: readonly NamePair[]): NameGroup[] {
  const backed = pairs.filter((pair) => pair.company || pair.emailName || pair.phone);
  const byAnchor = [...Map.groupBy(backed, (pair) => pair.a)].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return byAnchor.map(([anchor, each]) => {
    const signs = new Set<DuplicateReason>(['name']);
    for (const pair of each) {
      if (pair.company) signs.add('company');
      if (pair.emailName) signs.add('email_name');
      if (pair.phone) signs.add('phone');
    }
    const order: readonly DuplicateReason[] = ['name', 'company', 'email_name', 'phone'];
    return {
      anchor,
      ids: [anchor, ...[...new Set(each.map((pair) => pair.o))].sort()],
      reasons: order.filter((reason) => signs.has(reason)),
    };
  });
}

/** What a name group is kept under: its first contact's name, as people would compare it. */
export function nameKeyOf(name: string): string {
  return name.trim().toLocaleLowerCase().slice(0, MAX_KEY);
}

/**
 * Whether a group stays hidden: every contact in it was rejected together by the same sign.
 * One that another contact joined is shown again, so the newcomer is seen.
 */
export function isRejected(
  ids: readonly string[],
  rejections: readonly (readonly string[])[],
): boolean {
  return rejections.some((rejected) => ids.every((id) => rejected.includes(id)));
}
