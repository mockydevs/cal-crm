import { spf } from 'mailauth/lib/spf/index.js';
import { validateTerms } from 'mailauth/lib/spf/syntax.js';
import {
  budgetedResolver,
  codeOf,
  dnsError,
  lookupTxt,
  normalizeName,
  readTxtRecords,
  sendingAddress,
} from './dns.js';
import type { DnsCheckInput, DnsCheckResult, DnsFix, Resolve } from './types.js';

/** Syntax only: RFC7208 limits executed terms, not the number of conditional terms written. */
export function staticSpfProblem(record: string): 'invalid_record' | undefined {
  if (!/^v=spf1(?: |$)/i.test(record)) return 'invalid_record';
  return validateTerms(record.split(/ +/).slice(1).filter(Boolean)) === false
    ? undefined
    : 'invalid_record';
}

function authorize(
  domain: string,
  record: string,
  mechanism: string,
  lookups: number,
): Extract<DnsFix, { kind: 'record' }> | undefined {
  const terms = record.split(/ +/);
  if (terms.some((term) => term.replace(/^[+?~-]/, '') === mechanism)) return undefined;
  if (
    terms.some((term) =>
      /^[?~-](?:a(?:$|[:/])|mx(?:$|[:/])|ptr(?:$|:)|include:|exists:|ip[46]:)/i.test(term),
    )
  )
    return undefined;
  const index = terms.findIndex((term) => /^[+?~-]?all$/i.test(term) || /^redirect=/i.test(term));
  terms.splice(index < 0 ? terms.length : index, 0, mechanism);
  return {
    kind: 'record',
    type: 'TXT',
    name: domain,
    value: terms.join(' '),
    ...(lookups >= 10 && /^(include:|a(?:$|[:/])|mx(?:$|[:/])|exists:|ptr(?:$|:))/i.test(mechanism)
      ? { exceedsLookupLimit: true }
      : {}),
  };
}

/** SPF authorizes the observed sending IP; absent an IP, DNS never proves authorization. */
export async function checkSpf(
  input: Pick<DnsCheckInput, 'returnPathDomain' | 'sendingIp' | 'spfAuthorize'>,
  resolve: Resolve,
): Promise<DnsCheckResult> {
  const domain = normalizeName(input.returnPathDomain);
  const address = input.sendingIp === undefined ? undefined : sendingAddress(input.sendingIp);
  const base = {
    domain,
    ...(input.sendingIp === undefined ? {} : { ip: address?.ip ?? input.sendingIp }),
  };
  if (input.sendingIp !== undefined && address === undefined)
    return { key: 'spf', status: 'could_not_check', reason: 'invalid_ip', found: base };
  const bounded = budgetedResolver(resolve, { maxQueries: 100, timeoutMs: 10_000 });
  const txt = await lookupTxt(bounded, domain);
  if (txt.kind === 'error')
    return {
      key: 'spf',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { ...base, code: txt.code },
    };
  const records =
    txt.kind === 'none' ? [] : txt.records.filter((record) => /^v=spf1(?: |$)/i.test(record));
  if (records.length === 0) {
    const mechanism =
      input.spfAuthorize ??
      (address === undefined ? undefined : `ip${String(address.family)}:${address.ip}`);
    const fix =
      mechanism === undefined || staticSpfProblem(`v=spf1 ${mechanism} ~all`) !== undefined
        ? undefined
        : {
            kind: 'record' as const,
            type: 'TXT' as const,
            name: domain,
            value: `v=spf1 ${mechanism} ~all`,
          };
    return {
      key: 'spf',
      status: 'fail',
      reason: 'no_record',
      found: base,
      ...(fix === undefined ? {} : { fix }),
    };
  }
  if (records.length !== 1)
    return { key: 'spf', status: 'fail', reason: 'multiple_records', found: { ...base, records } };
  const record = records[0];
  if (record === undefined) throw new Error('Missing selected SPF record.');
  const found = { ...base, record };
  if (staticSpfProblem(record) !== undefined)
    return { key: 'spf', status: 'fail', reason: 'invalid_record', found };
  if (address === undefined)
    return { key: 'spf', status: 'could_not_check', reason: 'no_sending_ip', found };
  // The input proves the envelope domain and IP, not the local part or EHLO identity.
  const needsIdentity = (text: string) => /%\{[slh]/i.test(text);
  if (needsIdentity(record))
    return { key: 'spf', status: 'could_not_check', reason: 'sender_identity_required', found };
  const identityRequired = new Set<string>();
  let dnsCode: string | undefined;
  const resolver: Resolve = async (name, type) => {
    if (normalizeName(name) === domain && type === 'TXT') return [[record]];
    try {
      const answer = await bounded(name, type);
      if (type === 'TXT') {
        const texts = readTxtRecords(answer);
        if (texts === undefined) throw dnsError('EBADRESP', name);
        if (texts.some((text) => /^v=spf1(?: |$)/i.test(text) && needsIdentity(text))) {
          identityRequired.add(name);
          throw dnsError('EIDENTITY', name);
        }
      }
      return answer;
    } catch (error) {
      const code = codeOf(error);
      if (code !== 'ENOTFOUND' && code !== 'ENODATA') dnsCode = code;
      throw error;
    }
  };
  // mailauth's DNSResolver declaration omits node:dns MX objects; installed source accepts them.
  const result = await spf({
    sender: `postmaster@${domain}`,
    ip: address.ip,
    strict: true,
    maxResolveCount: 10,
    maxVoidCount: 2,
    maxElapsedTime: 10_000,
    resolver: resolver as NonNullable<Parameters<typeof spf>[0]['resolver']>,
  });
  const lookups = result.lookups?.count ?? 0;
  if (identityRequired.size > 0)
    return { key: 'spf', status: 'could_not_check', reason: 'sender_identity_required', found };
  if (result.status.result === 'temperror')
    return {
      key: 'spf',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { ...found, ...(dnsCode === undefined ? {} : { code: dnsCode }) },
    };
  if (result.status.result === 'permerror')
    return {
      key: 'spf',
      status: 'fail',
      reason: lookups > 10 ? 'too_many_lookups' : 'invalid_record',
      found: { ...found, lookups },
    };
  if (result.status.result === 'pass')
    return { key: 'spf', status: 'pass', reason: 'ip_allowed', found: { ...found, lookups } };
  const mechanism = input.spfAuthorize ?? `ip${String(address.family)}:${address.ip}`;
  const fix =
    staticSpfProblem(`v=spf1 ${mechanism} -all`) === undefined
      ? authorize(domain, record, mechanism, lookups)
      : undefined;
  return {
    key: 'spf',
    status: 'fail',
    reason: 'ip_not_allowed',
    found: { ...found, lookups },
    ...(fix === undefined ? {} : { fix }),
  };
}
