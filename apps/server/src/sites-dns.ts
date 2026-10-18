// Looking a host name up for "Connect a domain": the names its CNAME chain passes through
// and the addresses it resolves to. The sites module judges what was found; this file only
// asks. A name that does not resolve is an answer with nothing in it.
import { Resolver } from 'node:dns/promises';

import type { ResolveHost } from '@repo/module-sites';

/** The three questions asked of DNS, as node:dns/promises answers them. */
export interface DnsLookups {
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** How many CNAMEs are followed before the chain is taken as it stands. */
const MAX_HOPS = 5;

const none = (): string[] => [];

/** A resolver that gives up on a slow name server rather than hold a request open. */
export function createHostResolver(
  dns: DnsLookups = new Resolver({ timeout: 3000, tries: 2 }),
): ResolveHost {
  return async (hostname) => {
    const cnames: string[] = [];
    let current = hostname;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const [next] = await dns.resolveCname(current).catch(none);
      if (next === undefined || cnames.includes(next)) break;
      cnames.push(next);
      current = next;
    }
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(none),
      dns.resolve6(hostname).catch(none),
    ]);
    return { cnames, addresses: [...v4, ...v6] };
  };
}
