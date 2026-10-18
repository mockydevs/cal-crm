import { resolve as nodeResolve } from 'node:dns/promises';

import {
  budgetedResolver,
  lookupAddresses,
  lookupMx,
  type DnsBudget,
  type Resolve,
} from '@repo/mail-checks';

/** Whether a domain can receive mail, as far as DNS alone tells. */
export type DomainCheck =
  | { readonly kind: 'accepts_mail'; readonly via: 'mx' | 'address' }
  | {
      readonly kind: 'invalid';
      /**
       * domain_not_found: the name doesn't exist. no_mail_server: it exists with neither
       * MX nor address records. no_mail_accepted: it publishes a null MX (RFC 7505).
       */
      readonly reason: 'domain_not_found' | 'no_mail_server' | 'no_mail_accepted';
    }
  | {
      readonly kind: 'unknown';
      readonly reason: 'dns_unavailable';
      /** The resolver's code, such as ESERVFAIL, ETIMEOUT or EBUDGET. */
      readonly code: string;
    };

export interface DomainCheckOptions {
  /** node:dns/promises' resolve unless given. */
  readonly resolve?: Resolve;
  readonly budget?: DnsBudget;
}

/** At most three queries are asked (MX, A, AAAA); the rest is headroom. */
export const DEFAULT_DNS_BUDGET: DnsBudget = { maxQueries: 6, timeoutMs: 3000 };

/**
 * Whether a domain accepts mail. RFC 5321 5.1: mail goes to the MX hosts, or with no MX
 * records to the domain's own address (the implicit MX); a name that doesn't exist is an
 * error. A failed lookup (SERVFAIL, a timeout, a spent budget) is never read as invalid:
 * it is unknown, to be checked again later.
 */
export async function checkDomain(
  domain: string,
  options: DomainCheckOptions = {},
): Promise<DomainCheck> {
  const bounded = budgetedResolver(
    options.resolve ?? nodeResolve,
    options.budget ?? DEFAULT_DNS_BUDGET,
  );
  // lookupMx reads NXDOMAIN and NODATA both as no records; which one it was decides
  // between "not found" and "no mail server".
  const seen = { nameMissing: false };
  const watched: Resolve = (name, type) =>
    bounded(name, type).catch((error: unknown) => {
      if (type === 'MX' && codeOf(error) === 'ENOTFOUND') seen.nameMissing = true;
      throw error;
    });

  const mx = await lookupMx(watched, domain);
  if (mx.kind === 'error') return unknown(mx.code);
  if (mx.kind === 'found')
    return mx.records.some((record) => record.exchange !== '')
      ? { kind: 'accepts_mail', via: 'mx' }
      : { kind: 'invalid', reason: 'no_mail_accepted' };

  const addresses = await Promise.all([
    lookupAddresses(watched, domain, 'A'),
    lookupAddresses(watched, domain, 'AAAA'),
  ]);
  if (addresses.some((each) => each.kind === 'found'))
    return { kind: 'accepts_mail', via: 'address' };
  for (const each of addresses) if (each.kind === 'error') return unknown(each.code);
  return { kind: 'invalid', reason: seen.nameMissing ? 'domain_not_found' : 'no_mail_server' };
}

function unknown(code: string): DomainCheck {
  return { kind: 'unknown', reason: 'dns_unavailable', code };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
