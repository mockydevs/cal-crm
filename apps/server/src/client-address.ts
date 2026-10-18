// The visitor's address, read through the proxies in front (TRUST_PROXY;
// docs/HOSTING.md 13.4). The public rate limits, the sign-in limit, the audit log and the
// request log all count by request.ip, and this file decides it.
//
// The chain is the connection's own address, then X-Forwarded-For read from the right.
// Every proxy appends the address that connected to it, so walking from the right through
// the proxies we trust reaches the first address no trusted proxy vouches for: the visitor.
// That is how Fastify's own trustProxy works (@fastify/proxy-addr's `all`); this file adds
// one rule to it.
//
// The rule is for Cloudflare. Its addresses are shared by everything that runs on its
// network, not only the edge that serves this install's domain: a request that comes from
// one of them "only proves a request came from the Cloudflare network — not from your
// account specifically"
// (https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/).
// Anyone's Worker can send this domain an X-Forwarded-For of its own, which Cloudflare
// appends to, so an entry to the left of a Cloudflare address is never believed. Cloudflare
// sets CF-Connecting-IP, "the client IP address connecting to Cloudflare", on what it sends
// to the origin, and a cross-zone Worker request gets 2a06:98c0:3600::103 there "for security
// reasons" (https://developers.cloudflare.com/fundamentals/reference/http-headers/), an
// address inside a published range. When the walk reaches a Cloudflare address, the visitor
// is CF-Connecting-IP; if that is not exactly one address, it is the Cloudflare address.
//
// Wrong settings fail closed: an address that is not a trusted proxy ends the walk and is
// the visitor, so a header is believed only when every hop to its right was trusted.
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { CLOUDFLARE_RANGES } from './cloudflare-ranges.js';

/** The names TRUST_PROXY takes besides addresses and ranges, as proxy-addr defines the first three. */
const NAMED_RANGES: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.1/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};
export const CLOUDFLARE = 'cloudflare';

/**
 * The widest range a proxy entry may be. No proxy needs more, and a range that holds
 * visitors' own addresses lets them write their own X-Forwarded-For and pick a new address,
 * and a new allowance, with every request.
 */
const WIDEST_PREFIX = { 4: 8, 6: 16 } as const;

interface Range {
  readonly network: string;
  readonly prefix: number;
  readonly family: 4 | 6;
}

const mappedIpv4 = new BlockList();
mappedIpv4.addSubnet('::ffff:0:0', 96, 'ipv6');

function rangeOf(entry: string): Range | undefined {
  const [network = '', prefixText, extra] = entry.split('/');
  const family = isIP(network);
  if (extra !== undefined || (family !== 4 && family !== 6)) return undefined;
  const longest = family === 4 ? 32 : 128;
  if (prefixText === undefined) return { network, prefix: longest, family };
  if (!/^\d{1,3}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  return prefix > longest ? undefined : { network, prefix, family };
}

/** What is wrong with one TRUST_PROXY entry, or undefined when it is usable. */
export function proxyEntryProblem(entry: string): string | undefined {
  if (entry === CLOUDFLARE || entry in NAMED_RANGES) return undefined;
  const range = rangeOf(entry);
  if (range === undefined)
    return `${entry} is not an address, a CIDR range, or one of loopback, linklocal, uniquelocal, cloudflare`;
  if (range.prefix < WIDEST_PREFIX[range.family])
    return `${entry} is wider than /${String(WIDEST_PREFIX[range.family])}: name the proxies' own addresses, or uniquelocal for every private range`;
  if (range.family === 6 && range.prefix < 128 && mappedIpv4.check(range.network, 'ipv6'))
    return `${entry} is an IPv4 range written as IPv6: write it as IPv4`;
  return undefined;
}

function matcher(ranges: readonly Range[]): (address: string) => boolean {
  const list = new BlockList();
  for (const { network, prefix, family } of ranges)
    list.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6');
  return (address) => {
    const family = isIP(address);
    if (family === 0) return false;
    // A zone (fe80::1%eth0) names this server's interface, not the peer.
    const bare = address.split('%', 1)[0] ?? '';
    return list.check(bare, family === 4 ? 'ipv4' : 'ipv6');
  };
}

export interface ProxyTrust {
  /** A proxy named in TRUST_PROXY: its X-Forwarded-For is believed. */
  readonly isProxy: (address: string) => boolean;
  /** One of Cloudflare's addresses, when TRUST_PROXY names cloudflare. */
  readonly isCloudflare: (address: string) => boolean;
}

/** TRUST_PROXY's entries, as config.ts has checked them, made into tests. */
export function proxyTrust(entries: readonly string[]): ProxyTrust {
  const ranges = entries
    .filter((entry) => entry !== CLOUDFLARE)
    .flatMap((entry) => NAMED_RANGES[entry] ?? [entry])
    .map(rangeOf)
    .filter((range) => range !== undefined);
  const cloudflare = entries.includes(CLOUDFLARE)
    ? CLOUDFLARE_RANGES.map(rangeOf).filter((range) => range !== undefined)
    : [];
  return { isProxy: matcher(ranges), isCloudflare: matcher(cloudflare) };
}

/** One address, or undefined: a repeated or malformed header is not believed. */
function singleAddress(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = value.trim();
  return isIP(address) === 0 ? undefined : address;
}

/** X-Forwarded-For's entries from the right, as @fastify/forwarded reads them. */
function forwardedFromTheRight(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(',') : (value ?? '');
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .reverse();
}

export interface Arrival {
  /** The connection's own address. */
  readonly peer: string;
  readonly forwardedFor?: string | string[] | undefined;
  readonly cfConnectingIp?: string | string[] | undefined;
}

/** The visitor's address: see the top of this file. */
export function clientAddress(arrival: Arrival, trust: ProxyTrust): string {
  const chain = [arrival.peer, ...forwardedFromTheRight(arrival.forwardedFor)];
  // Through trusted proxies to the first address that is Cloudflare's, untrusted, or last.
  const reached =
    chain.find(
      (address, hop) =>
        trust.isCloudflare(address) || !trust.isProxy(address) || hop === chain.length - 1,
    ) ?? arrival.peer;
  return trust.isCloudflare(reached) ? (singleAddress(arrival.cfConnectingIp) ?? reached) : reached;
}

/**
 * Fastify's options for TRUST_PROXY. With entries, the server works the visitor out before
 * Fastify routes the request (rewriteUrl is the first thing Fastify runs, before even its
 * request log) and leaves it as the only X-Forwarded-For entry; Fastify then trusts the
 * connection alone, so request.ip is that entry exactly when the connection came from a
 * trusted proxy, and the connection's address otherwise.
 */
export function forwardingOptions(entries: readonly string[]):
  | { readonly trustProxy: false }
  | {
      readonly trustProxy: (address: string, hop: number) => boolean;
      readonly rewriteUrl: (request: IncomingMessage) => string;
    } {
  if (entries.length === 0) return { trustProxy: false };
  const trust = proxyTrust(entries);
  const trusted = (address: string) => trust.isProxy(address) || trust.isCloudflare(address);
  return {
    trustProxy: (address, hop) => hop === 0 && trusted(address),
    rewriteUrl: (request) => {
      const peer = request.socket.remoteAddress;
      if (peer !== undefined && trusted(peer))
        request.headers['x-forwarded-for'] = clientAddress(
          {
            peer,
            forwardedFor: request.headers['x-forwarded-for'],
            cfConnectingIp: request.headers['cf-connecting-ip'],
          },
          trust,
        );
      return request.url ?? '/';
    },
  };
}
