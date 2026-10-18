import { dmarc } from 'mailauth/lib/dmarc/index.js';
import { budgetedResolver, codeOf, dnsError, normalizeName, readTxtRecords } from './dns.js';
import type { DnsCheckInput, DnsCheckResult, DnsFix, Resolve } from './types.js';

const keys = ['dmarc', 'dmarc_enforcement'] as const;
function both(
  status: DnsCheckResult['status'],
  reason: string,
  found: DnsCheckResult['found'],
): readonly [DnsCheckResult, DnsCheckResult] {
  return [
    { key: keys[0], status, reason, found },
    { key: keys[1], status, reason, found },
  ];
}

/** Policy discovery is distinct from SPF/DKIM message alignment (RFC9989 section4.10). */
export async function checkDmarc(
  input: Pick<DnsCheckInput, 'fromDomain' | 'dmarcReportUri'>,
  resolve: Resolve,
): Promise<readonly [DnsCheckResult, DnsCheckResult]> {
  const domain = normalizeName(input.fromDomain);
  const bounded = budgetedResolver(resolve, { maxQueries: 100, timeoutMs: 10_000 });
  const records = new Map<string, string[]>();
  let dnsCode: string | undefined;
  const resolver: Resolve = async (name, type) => {
    try {
      const answer = await bounded(name, type);
      if (type === 'TXT') {
        const texts = readTxtRecords(answer);
        if (texts === undefined) throw dnsError('EBADRESP', name);
        records.set(
          normalizeName(name),
          texts.filter((text) => /^[vV][ \t]*=[ \t]*DMARC1[ \t]*(?:;|$)/.test(text.trim())),
        );
      }
      return answer;
    } catch (error) {
      const code = codeOf(error);
      if (code !== 'ENOTFOUND' && code !== 'ENODATA') dnsCode = code;
      throw error;
    }
  };
  // mailauth's resolver declaration omits MX/NS shapes accepted by its installed runtime.
  const result = await dmarc({
    headerFrom: domain,
    strict: true,
    resolver: resolver as NonNullable<Parameters<typeof dmarc>[0]['resolver']>,
  });
  if (result === false) return both('could_not_check', 'invalid_domain', { domain });
  if (result.status.result === 'temperror')
    return both('could_not_check', 'dns_error', { domain, code: dnsCode ?? 'ETIMEOUT' });
  if (result.rr === undefined) {
    const rejected = [...records.values()].flat();
    if (rejected.length > 0)
      return both('fail', 'invalid_record', {
        domain,
        ...(rejected.length === 1 ? { record: rejected[0] } : { records: rejected }),
      });
    const report = input.dmarcReportUri;
    const value = `v=DMARC1; p=none${report !== undefined && /^mailto:[^\s;,<>]+@[^\s;,<>]+$/.test(report) ? `; rua=${report}` : ''}`;
    return [
      {
        key: 'dmarc',
        status: 'fail',
        reason: 'no_record',
        found: { domain },
        fix: { kind: 'record', type: 'TXT', name: `_dmarc.${domain}`, value },
      },
      { key: 'dmarc_enforcement', status: 'fail', reason: 'no_record', found: { domain } },
    ];
  }
  const record = result.rr;
  const policyDomain = result.policyDomain;
  const found = { domain, record, policyDomain, policy: result.policy, testMode: result.testMode };
  const discovery: DnsCheckResult = {
    key: 'dmarc',
    status: 'pass',
    reason: 'record_found',
    found: {
      ...found,
      organizationalDomain: result.domain,
      p: result.p,
      sp: result.sp,
      ...(result.np === undefined ? {} : { np: result.np }),
    },
  };
  if (result.testMode)
    return [discovery, { key: 'dmarc_enforcement', status: 'fail', reason: 'test_mode', found }];
  if (result.policy === 'quarantine' || result.policy === 'reject')
    return [discovery, { key: 'dmarc_enforcement', status: 'pass', reason: 'enforced', found }];
  if (policyDomain !== domain)
    return [
      discovery,
      { key: 'dmarc_enforcement', status: 'fail', reason: 'inherited_policy', found },
    ];
  const tags = record
    .split(';')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const index = tags.findIndex((tag) => /^p\s*=\s*none$/i.test(tag));
  let fix: DnsFix | undefined;
  if (index >= 0) {
    tags[index] = 'p=quarantine';
    fix = { kind: 'record', type: 'TXT', name: `_dmarc.${domain}`, value: tags.join('; ') };
  }
  return [
    discovery,
    {
      key: 'dmarc_enforcement',
      status: 'fail',
      reason: 'p_none',
      found,
      ...(fix === undefined ? {} : { fix }),
    },
  ];
}
