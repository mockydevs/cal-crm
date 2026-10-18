// Where the worker may connect to reach a model.
//
// A hosted provider is an https address on port 443 whose every DNS answer is on the public
// internet. A model server of the install's own (Ollama, llama.cpp, vLLM, LM Studio) lives
// on a private address and usually speaks plain http, so it is allowed only when the person
// who runs the install has listed its host and port in AI_LOCAL_SERVERS. Nothing a user
// types in Settings can add to that list.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** A model server the install's operator vouches for: an exact host and port. */
export interface LocalServer {
  /** As a URL writes it: lower case, an IPv6 address in brackets. */
  readonly host: string;
  readonly port: number;
}

const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

function localServer(entry: string): LocalServer | undefined {
  const colon = entry.lastIndexOf(':');
  if (colon < 1) return undefined;
  const host = entry.slice(0, colon);
  const port = entry.slice(colon + 1);
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535) return undefined;
  const bracketed = host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6;
  if (!bracketed && !HOST_NAME.test(host)) return undefined;
  // Through URL, so that an address has the one spelling a base URL will have too.
  const url = `http://${host}:1`;
  return URL.canParse(url) ? { host: new URL(url).hostname, port: Number(port) } : undefined;
}

/**
 * Reads AI_LOCAL_SERVERS: `host:port` pairs separated by commas, such as
 * `ollama:11434,192.168.1.20:8080,[::1]:1234`. A mistake stops the start; the message
 * names the entry by position only.
 */
export function parseLocalServers(value: string | undefined): readonly LocalServer[] {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map((entry, index) => {
    const server = localServer(entry.trim());
    if (server === undefined)
      throw new RangeError(`AI_LOCAL_SERVERS: entry ${String(index + 1)} is not host:port.`);
    return server;
  });
}

export type ServerUrlProblem =
  'not_a_url' | 'not_https' | 'has_credentials' | 'port_not_allowed' | 'has_query';

export type ServerUrlCheck =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly port: number;
      /** One of the install's listed servers: private addresses and http are allowed. */
      readonly local: boolean;
      readonly secure: boolean;
    }
  | { readonly ok: false; readonly reason: ServerUrlProblem };

const HTTPS_PORT = 443;
const HTTP_PORT = 80;

/**
 * Checks an address by its shape alone, before any DNS: Settings uses it when an address is
 * saved, and the transport before every call. Where the name points is checked when
 * connecting (resolveServerAddress).
 */
export function checkServerUrl(
  value: string,
  localServers: readonly LocalServer[],
): ServerUrlCheck {
  if (!URL.canParse(value)) return { ok: false, reason: 'not_a_url' };
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'has_credentials' };
  const secure = url.protocol === 'https:';
  // URL drops a scheme's default port.
  const port = url.port === '' ? (secure ? HTTPS_PORT : HTTP_PORT) : Number(url.port);
  const local = localServers.some((server) => server.host === url.hostname && server.port === port);
  if (local) return { ok: true, url, port, local, secure };
  if (!secure) return { ok: false, reason: 'not_https' };
  // Other ports are refused so that a key can't be aimed at whatever else has an address.
  if (port !== HTTPS_PORT) return { ok: false, reason: 'port_not_allowed' };
  return { ok: true, url, port, local, secure };
}

/**
 * Checks the address of a model server as a person gives it in Settings: checkServerUrl's
 * rules, and no query or fragment, since the adapter adds its own paths to it.
 */
export function checkBaseUrl(value: string, localServers: readonly LocalServer[]): ServerUrlCheck {
  const checked = checkServerUrl(value, localServers);
  if (checked.ok && (checked.url.search !== '' || checked.url.hash !== ''))
    return { ok: false, reason: 'has_query' };
  return checked;
}

// The same lists as the automation webhook's guard (packages/modules/automation/src/
// webhook.ts): IPv4 that is not the public internet (IANA special-purpose registry).
// BlockList also matches the IPv4-mapped IPv6 form of each.
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
// Inside global unicast (2000::/3) but not public: protocol assignments including Teredo,
// documentation, and 6to4, which carries an IPv4 address that would go unchecked.
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

const blocked = new BlockList();
for (const [network, prefix] of BLOCKED_V4) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_V6) blocked.addSubnet(network, prefix, 'ipv6');
// Everything public in IPv6 is in 2000::/3; loopback, unique-local, link-local, multicast
// and NAT64 are all outside it.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const mappedV4 = new BlockList();
mappedV4.addSubnet('::ffff:0:0', 96, 'ipv6');

/** Whether an IP address is on the public internet. Anything else, or not an IP, is false. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // A zone (fe80::1%eth0) names a local interface.
  if (family !== 6 || address.includes('%')) return false;
  // An IPv4-mapped address connects over IPv4, so the IPv4 rules decide.
  if (mappedV4.check(address, 'ipv6')) return !blocked.check(address, 'ipv6');
  return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export interface ServerAddress {
  readonly address: string;
  readonly family: number;
}
/** DNS for a host name: every address it has. */
export type ServerLookup = (hostname: string) => Promise<readonly ServerAddress[]>;

export type ResolvedServer =
  | { readonly ok: true; readonly address: string; readonly family: 4 | 6 }
  | { readonly ok: false; readonly code: 'blocked_address' | 'network' };

const systemLookup: ServerLookup = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Resolves a checked address once. Unless it is one of the install's listed servers, it is
 * refused if ANY of its addresses is not public, so a name can't hide a private address
 * behind a public one. The caller connects to the address returned and never resolves the
 * name again.
 */
export async function resolveServerAddress(
  checked: Extract<ServerUrlCheck, { readonly ok: true }>,
  lookup: ServerLookup = systemLookup,
): Promise<ResolvedServer> {
  const host = checked.url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[];
  if (isIP(host) === 0) {
    try {
      addresses = (await lookup(host)).map((found) => found.address);
    } catch {
      addresses = [];
    }
  } else addresses = [host];
  const [first] = addresses;
  if (first === undefined) return { ok: false, code: 'network' };
  if (!checked.local && !addresses.every(isPublicAddress))
    return { ok: false, code: 'blocked_address' };
  return { ok: true, address: first, family: isIP(first) === 6 ? 6 : 4 };
}
