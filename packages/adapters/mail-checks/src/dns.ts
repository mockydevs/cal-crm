import { isIP } from 'node:net';

import type { MxRecord, RecordType, Resolve } from './types.js';

/** What a lookup found: records, no records at all, or a failure to look. */
export type Lookup<T> =
  | { readonly kind: 'found'; readonly records: readonly T[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly code: string };

// node:dns's codes for a name that doesn't exist (NXDOMAIN) or has no records of the type
// (NODATA). Every other code means we couldn't tell, which a check never reads as a pass.
const NO_RECORDS: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

export function dnsError(code: string, name: string): Error {
  return Object.assign(new Error(`${code} ${name}`), { code });
}

export function codeOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'EUNKNOWN';
}

/** A DNS name as compared: in lower case, without the root's trailing dot. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

async function lookup<T>(
  resolve: Resolve,
  name: string,
  type: RecordType,
  read: (answer: unknown) => T[] | undefined,
): Promise<Lookup<T>> {
  let answer: unknown;
  try {
    answer = await resolve(name, type);
  } catch (error) {
    const code = codeOf(error);
    return NO_RECORDS.has(code) ? { kind: 'none' } : { kind: 'error', code };
  }
  // An answer of the wrong shape is a broken resolver, never records.
  const records = read(answer);
  if (records === undefined) return { kind: 'error', code: 'EBADRESP' };
  return records.length === 0 ? { kind: 'none' } : { kind: 'found', records };
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isMx = (value: unknown): value is MxRecord =>
  typeof value === 'object' &&
  value !== null &&
  'exchange' in value &&
  typeof value.exchange === 'string' &&
  'priority' in value &&
  typeof value.priority === 'number';

/** TXT records, each with its character-strings joined, as SPF reads them (RFC 7208 3.3). */
export function readTxtRecords(answer: unknown): string[] | undefined {
  return Array.isArray(answer) && answer.every(isStrings)
    ? answer.map((parts) => parts.join(''))
    : undefined;
}

export function lookupTxt(resolve: Resolve, name: string): Promise<Lookup<string>> {
  return lookup(resolve, normalizeName(name), 'TXT', readTxtRecords);
}

/** MX records, with exchanges as compared; a null MX's root exchange becomes "". */
export function lookupMx(resolve: Resolve, name: string): Promise<Lookup<MxRecord>> {
  return lookup(resolve, normalizeName(name), 'MX', (answer) =>
    Array.isArray(answer) && answer.every(isMx)
      ? answer.map((record) => ({
          exchange: normalizeName(record.exchange),
          priority: record.priority,
        }))
      : undefined,
  );
}

export function lookupAddresses(
  resolve: Resolve,
  name: string,
  type: 'A' | 'AAAA',
): Promise<Lookup<string>> {
  return lookup(resolve, normalizeName(name), type, (answer) =>
    isStrings(answer) ? answer : undefined,
  );
}

/** The PTR names of an address. */
export function lookupPtr(resolve: Resolve, ip: string): Promise<Lookup<string>> {
  return lookup(resolve, reverseName(ip), 'PTR', (answer) =>
    isStrings(answer) ? answer.map(normalizeName) : undefined,
  );
}

// The eight 16-bit groups of a valid IPv6 address, with "::" expanded and a trailing
// IPv4 address (RFC 4291 2.2) as its two groups.
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const ipv4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (ipv4 !== null) {
    const [a, b, c, d] = ipv4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, ipv4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const [head = '', tail] = text.split('::');
  const start = parse(head);
  if (tail === undefined) return start;
  const end = parse(tail);
  return [...start, ...Array<number>(8 - start.length - end.length).fill(0), ...end];
}

/**
 * The address a message came from, with an IPv4-mapped IPv6 address (::ffff:a.b.c.d) read
 * as the IPv4 address it carries, or undefined when it isn't an IP address.
 */
export function sendingAddress(
  value: string,
): { readonly ip: string; readonly family: 4 | 6 } | undefined {
  const family = isIP(value);
  if (family === 4) return { ip: value, family };
  if (family !== 6) return undefined;
  const groups = ipv6Groups(value);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return { ip: [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'), family: 4 };
  }
  return { ip: value.toLowerCase(), family };
}

/** Whether two addresses are the same, however each is written. */
export function sameAddress(left: string, right: string): boolean {
  const a = sendingAddress(left);
  const b = sendingAddress(right);
  if (a === undefined) return false;
  if (b === undefined) return false;
  if (a.family !== b.family) return false;
  if (a.family === 4) return a.ip === b.ip;
  const groups = ipv6Groups(b.ip);
  return ipv6Groups(a.ip).every((group, index) => group === groups[index]);
}

/** The name a PTR query asks for (RFC 1035 3.5, RFC 3596 2.5). */
export function reverseName(ip: string): string {
  const address = sendingAddress(ip);
  if (address === undefined) throw new TypeError(`Not an IP address: ${ip}`);
  if (address.family === 4) return `${address.ip.split('.').reverse().join('.')}.in-addr.arpa`;
  const nibbles = ipv6Groups(address.ip)
    .map((group) => group.toString(16).padStart(4, '0'))
    .join('')
    .split('')
    .reverse();
  return `${nibbles.join('.')}.ip6.arpa`;
}

export interface DnsBudget {
  /** Queries allowed in all, however many checks share the resolver. */
  readonly maxQueries: number;
  /** Time allowed in all, from when the resolver is made. */
  readonly timeoutMs: number;
}

/**
 * A resolver that gives up after maxQueries queries, or once timeoutMs has passed, with
 * code EBUDGET or ETIMEOUT, so a slow or hostile DNS server can't hold the checks, or the
 * worker running them, for long.
 */
export function budgetedResolver(resolve: Resolve, budget: DnsBudget): Resolve {
  const deadline = Date.now() + budget.timeoutMs;
  let queries = 0;
  return (name, type) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(dnsError('ETIMEOUT', name));
    queries += 1;
    if (queries > budget.maxQueries) return Promise.reject(dnsError('EBUDGET', name));
    return new Promise((answer, reject) => {
      const timer = setTimeout(() => {
        reject(dnsError('ETIMEOUT', name));
      }, remaining);
      resolve(name, type).then(
        (records) => {
          clearTimeout(timer);
          answer(records);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : dnsError(codeOf(error), name));
        },
      );
    });
  };
}
