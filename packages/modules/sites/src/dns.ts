// Connecting a domain: the one DNS record a business adds, and how a lookup of its host
// name is judged. Pure rules: the lookup itself is the server's, handed in.

/** Where this install's sites answer: what a connected domain must point at. */
export interface SitesTarget {
  /** The host a subdomain's CNAME names, such as sites.example-crm.com. */
  readonly hostname: string;
  /** The addresses a root domain's A record names. May be empty when none is configured. */
  readonly addresses: readonly string[];
}

/** What a lookup of a host name found. */
export interface Resolution {
  /** The names its CNAME chain passes through, in any case, with or without a final dot. */
  readonly cnames: readonly string[];
  /** The IPv4 and IPv6 addresses it resolves to. */
  readonly addresses: readonly string[];
}

export type ResolveHost = (hostname: string) => Promise<Resolution>;

export interface DomainRecord {
  readonly type: 'CNAME' | 'A';
  readonly host: string;
  readonly value: string;
}

// Second-level labels that registries sell names under (example.co.ke, example.com.au). A
// short list, not the Public Suffix List: it only decides which record is suggested, and
// either record verifies a domain.
const REGISTRY_LABELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'go',
  'gov',
  'info',
  'me',
  'mobi',
  'ne',
  'net',
  'or',
  'org',
  'sc',
]);

/** How many labels the registered domain under a host name has: example.com 2, example.co.ke 3. */
function rootSize(labels: readonly string[]): number {
  const [second = '', top = ''] = labels.slice(-2);
  return labels.length >= 3 && top.length === 2 && REGISTRY_LABELS.has(second) ? 3 : 2;
}

/** Whether the name is a registered domain itself (example.com) rather than a subdomain. */
export function isRootDomain(hostname: string): boolean {
  const labels = hostname.split('.');
  return labels.length <= rootSize(labels);
}

/**
 * The record to add for a host name: a CNAME for a subdomain, an A record for a root
 * domain (which cannot hold a CNAME). Undefined for a root domain when the install has no
 * address configured to point one at.
 */
export function recordFor(hostname: string, target: SitesTarget): DomainRecord | undefined {
  const labels = hostname.split('.');
  const size = rootSize(labels);
  if (labels.length > size)
    return {
      type: 'CNAME',
      // www.example.com → www; a.b.example.co.ke → a.b.
      host: labels.slice(0, labels.length - size).join('.'),
      value: target.hostname,
    };
  const [address] = target.addresses;
  return address === undefined ? undefined : { type: 'A', host: '@', value: address };
}

const plain = (name: string): string => name.toLowerCase().replace(/\.$/, '');

export type Verdict =
  { readonly verified: true } | { readonly verified: false; readonly error: string };

/** Whether what was found points the host at this install, and if not, why, in words. */
export function judgeResolution(hostname: string, target: SitesTarget, found: Resolution): Verdict {
  const cnames = found.cnames.map(plain);
  if (cnames.includes(plain(target.hostname))) return { verified: true };
  const ours = new Set(target.addresses.map(plain));
  if (found.addresses.some((address) => ours.has(plain(address)))) return { verified: true };
  const [elsewhere] = [...cnames, ...found.addresses];
  if (elsewhere === undefined)
    return {
      verified: false,
      error: `No DNS record was found for ${hostname} yet. A new record can take a while to be seen everywhere.`,
    };
  return {
    verified: false,
    error: `${hostname} points at ${elsewhere}, not at this install. Change the record and check again.`,
  };
}
