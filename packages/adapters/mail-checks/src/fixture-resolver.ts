import { dnsError } from './dns.js';
import type { MxRecord, RecordType, Resolve } from './types.js';

/** A name's records, or an error code every query for it rejects with. */
export type FixtureEntry =
  | {
      readonly A?: readonly string[];
      readonly AAAA?: readonly string[];
      readonly MX?: readonly MxRecord[];
      /** Each record as one string, or as its character-strings. */
      readonly TXT?: readonly (string | readonly string[])[];
      readonly PTR?: readonly string[];
      readonly NS?: readonly string[];
    }
  | { readonly error: string };

export type FixtureZone = Readonly<Record<string, FixtureEntry>>;

export interface FixtureResolver extends Resolve {
  /** Every query asked, in order, as name and type. */
  readonly queries: readonly (readonly [string, RecordType])[];
}

/**
 * A resolver that answers from fixed zones, as node:dns does: a name that isn't there
 * rejects with ENOTFOUND, a type it doesn't have with ENODATA. For tests of the checks.
 */
export function fixtureResolver(zone: FixtureZone): FixtureResolver {
  const entries = new Map(
    Object.entries(zone).map(([name, entry]) => [name.toLowerCase().replace(/\.$/, ''), entry]),
  );
  const queries: (readonly [string, RecordType])[] = [];
  const resolve = (name: string, type: RecordType): Promise<unknown> => {
    const key = name.toLowerCase().replace(/\.$/, '');
    queries.push([key, type]);
    const entry = entries.get(key);
    if (entry === undefined) return Promise.reject(dnsError('ENOTFOUND', key));
    if ('error' in entry) return Promise.reject(dnsError(entry.error, key));
    if (type === 'TXT') {
      const records = entry.TXT;
      if (records === undefined) return Promise.reject(dnsError('ENODATA', key));
      return Promise.resolve(
        records.map((record) => (typeof record === 'string' ? [record] : [...record])),
      );
    }
    const records = entry[type];
    if (records === undefined) return Promise.reject(dnsError('ENODATA', key));
    return Promise.resolve(
      records.map((record) => (typeof record === 'string' ? record : { ...record })),
    );
  };
  return Object.assign(resolve, { queries });
}
