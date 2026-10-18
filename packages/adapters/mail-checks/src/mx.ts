import { lookupAddresses, lookupMx, normalizeName } from './dns.js';
import type { DnsCheckResult, Resolve } from './types.js';

/**
 * Whether the From domain receives mail, so replies and bounces arrive: it has MX records.
 * A domain with none may still get mail at its own address, the implicit MX of RFC 5321
 * 5.1, which the result notes; but only MX records count. No fix is offered: only the mail
 * provider knows its exchangers.
 */
export async function checkMx(domain: string, resolve: Resolve): Promise<DnsCheckResult> {
  const name = normalizeName(domain);
  const mx = await lookupMx(resolve, name);
  if (mx.kind === 'error')
    return {
      key: 'mx',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { domain: name, code: mx.code },
    };
  if (mx.kind === 'found') {
    // A null MX (RFC 7505): one record whose exchange is the root says no mail is accepted.
    if (mx.records.length === 1 && mx.records[0]?.exchange === '')
      return { key: 'mx', status: 'fail', reason: 'null_mx', found: { domain: name } };
    const exchangers = [...mx.records].sort(
      (a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange),
    );
    return { key: 'mx', status: 'pass', reason: 'mx_found', found: { domain: name, exchangers } };
  }
  const addresses = await Promise.all([
    lookupAddresses(resolve, name, 'A'),
    lookupAddresses(resolve, name, 'AAAA'),
  ]);
  const implicitMx = addresses.some((each) => each.kind === 'found')
    ? 'address'
    : addresses.some((each) => each.kind === 'error')
      ? 'unknown'
      : 'none';
  return { key: 'mx', status: 'fail', reason: 'no_mx', found: { domain: name, implicitMx } };
}
