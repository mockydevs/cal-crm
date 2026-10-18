import {
  lookupAddresses,
  lookupPtr,
  normalizeName,
  sameAddress,
  sendingAddress,
  type Lookup,
} from './dns.js';
import type { DnsCheckInput, DnsCheckResult, DnsFix, Resolve } from './types.js';

const key = 'reverse_dns';

// Only the IP's owner can set its PTR record. The SMTP host is named as the PTR to set
// only when it's proven to resolve to the IP, so the request can't be wrong.
async function askOwner(
  resolve: Resolve,
  ip: string,
  type: 'A' | 'AAAA',
  smtpHost: string | undefined,
): Promise<DnsFix> {
  if (smtpHost !== undefined) {
    const host = normalizeName(smtpHost);
    const addresses = await lookupAddresses(resolve, host, type);
    if (addresses.kind === 'found' && addresses.records.some((each) => sameAddress(each, ip)))
      return { kind: 'ask', who: 'ip_owner', ip, ptr: host };
  }
  return { kind: 'ask', who: 'ip_owner', ip };
}

const failedLookup = (
  entry: readonly [string, Lookup<string>],
): entry is readonly [string, { readonly kind: 'error'; readonly code: string }] =>
  entry[1].kind === 'error';

/**
 * Whether the sending IP has a PTR name that resolves back to it. It doesn't apply to a
 * provider the connector detected: their servers' reverse DNS isn't the user's to set.
 */
export async function checkReverseDns(
  input: Pick<DnsCheckInput, 'sendingIp' | 'smtpHost' | 'detectedProvider'>,
  resolve: Resolve,
): Promise<DnsCheckResult> {
  if (input.detectedProvider !== undefined)
    return {
      key,
      status: 'not_applicable',
      reason: 'provider_managed',
      found: { provider: input.detectedProvider },
    };
  if (input.sendingIp === undefined)
    return { key, status: 'could_not_check', reason: 'no_sending_ip', found: {} };
  const address = sendingAddress(input.sendingIp);
  if (address === undefined)
    return { key, status: 'could_not_check', reason: 'invalid_ip', found: { ip: input.sendingIp } };
  const { ip } = address;
  const type = address.family === 4 ? 'A' : 'AAAA';

  const ptr = await lookupPtr(resolve, ip);
  if (ptr.kind === 'error')
    return { key, status: 'could_not_check', reason: 'dns_error', found: { ip, code: ptr.code } };
  if (ptr.kind === 'none')
    return {
      key,
      status: 'fail',
      reason: 'no_ptr',
      found: { ip },
      fix: await askOwner(resolve, ip, type, input.smtpHost),
    };

  const names = ptr.records;
  const forward = await Promise.all(
    names.map(async (name) => [name, await lookupAddresses(resolve, name, type)] as const),
  );
  const confirmed = forward.find(
    ([, result]) => result.kind === 'found' && result.records.some((each) => sameAddress(each, ip)),
  );
  if (confirmed !== undefined)
    return {
      key,
      status: 'pass',
      reason: 'forward_confirmed',
      found: { ip, ptr: names, confirmed: confirmed[0] },
    };
  // A name we couldn't look up might have confirmed the IP: that's not a failure.
  const failed = forward.find(failedLookup);
  if (failed !== undefined)
    return {
      key,
      status: 'could_not_check',
      reason: 'dns_error',
      found: { ip, ptr: names, code: failed[1].code },
    };
  return {
    key,
    status: 'fail',
    reason: 'ptr_mismatch',
    found: {
      ip,
      ptr: names,
      forward: Object.fromEntries(
        forward.map(([name, result]) => [name, result.kind === 'found' ? result.records : []]),
      ),
    },
    fix: await askOwner(resolve, ip, type, input.smtpHost),
  };
}
