import type { DKIMResult, DKIMVerifyResult } from 'mailauth';
import { dmarc } from 'mailauth/lib/dmarc/index.js';
import type { MessageCheckResult } from './message-types.js';
import type { Resolve } from './types.js';

/** RFC9989 alignment uses the actual policy, not DKIM's preliminary PSL guess. */
export async function messageAlignment(
  verified: DKIMVerifyResult,
  passing: readonly DKIMResult[],
  resolve: Resolve,
): Promise<MessageCheckResult> {
  const policy = await dmarc({
    headerFrom: verified.headerFrom,
    fromFields: verified.fromFields,
    dkimDomains: passing.flatMap((signature) =>
      signature.signingDomain === undefined ? [] : [{ domain: signature.signingDomain }],
    ),
    strict: true,
    resolver: resolve as NonNullable<Parameters<typeof dmarc>[0]['resolver']>,
  });
  if (policy === false)
    return { key: 'dmarc', status: 'could_not_check', reason: 'invalid_from', found: {} };
  if (policy.status.result === 'temperror')
    return { key: 'dmarc', status: 'could_not_check', reason: 'dns_error', found: {} };
  if (policy.rr === undefined)
    return { key: 'dmarc', status: 'fail', reason: 'no_valid_policy', found: {} };
  const found = { policyDomain: policy.policyDomain };
  if (policy.status.result === 'pass')
    return { key: 'dmarc', status: 'pass', reason: 'dkim_aligned', found };
  // A self-copy provides no independently observed public sending IP for SPF.
  // Unaligned DKIM alone cannot prove DMARC failed when aligned SPF is unknown.
  return { key: 'dmarc', status: 'could_not_check', reason: 'spf_not_observed', found };
}
