import { checkDomain, type DomainCheckOptions } from './domain.js';
import { isDisposableDomain, isRoleAddress } from './lists.js';
import type {
  MailboxOutcome,
  MailboxProvider,
  VerificationReason,
  VerificationStatus,
} from './provider.js';
import { checkSyntax } from './syntax.js';

export interface VerifyEmailOptions extends DomainCheckOptions {
  /** A mailbox verification service; without one, only the free checks run. */
  readonly provider?: MailboxProvider;
  readonly signal?: AbortSignal;
}

export interface EmailVerification {
  readonly status: VerificationStatus;
  /**
   * domain: our own checks (syntax, DNS, lists) say the domain takes mail, never that the
   * mailbox exists. mailbox: a provider checked the mailbox itself.
   */
  readonly depth: 'domain' | 'mailbox';
  /** Every finding, in a fixed order, each once. */
  readonly reasons: readonly VerificationReason[];
  /** The address as checked, its domain in lower-case ASCII; absent when it doesn't parse. */
  readonly address?: string;
  /** What the provider answered, when one was asked: for the checks ledger and support. */
  readonly provider?: { readonly name: string; readonly outcome: MailboxOutcome };
}

const ORDER: readonly VerificationReason[] = [
  'bad_syntax',
  'unsupported_syntax',
  'domain_not_found',
  'no_mail_server',
  'no_mail_accepted',
  'mailbox_not_found',
  'smtp_rejected',
  'dns_unavailable',
  'disposable',
  'catch_all',
  'mailbox_full',
  'low_quality',
  'low_deliverability',
  'mail_server_unavailable',
  'provider_error',
  'role',
  'free_provider',
];

// The worse of two findings wins: invalid, then risky, then unknown, then valid.
const SEVERITY: Readonly<Record<VerificationStatus, number>> = {
  valid: 0,
  unknown: 1,
  risky: 2,
  invalid: 3,
};

const worse = (a: VerificationStatus, b: VerificationStatus): VerificationStatus =>
  SEVERITY[b] > SEVERITY[a] ? b : a;

const ordered = (reasons: Iterable<VerificationReason>): VerificationReason[] =>
  [...new Set(reasons)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

/**
 * Checks an address: its syntax, whether its domain takes mail, the disposable and role
 * lists, and then, when a provider is given and nothing so far has proven it invalid, the
 * mailbox itself. Only invalid should stop a send; risky is sent to with a warning, and
 * unknown is checked again later.
 *
 * Resolves for every input: DNS and provider failures come back as unknown, never as an
 * exception. Nothing is logged.
 */
export async function verifyEmail(
  input: string,
  options: VerifyEmailOptions = {},
): Promise<EmailVerification> {
  const syntax = checkSyntax(input);
  if (syntax.kind === 'invalid')
    return { status: 'invalid', depth: 'domain', reasons: ['bad_syntax'] };
  if (syntax.kind === 'unsupported')
    return { status: 'unknown', depth: 'domain', reasons: ['unsupported_syntax'] };
  const { address } = syntax;

  const domain = await checkDomain(syntax.domain, options);
  if (domain.kind === 'invalid')
    return { status: 'invalid', depth: 'domain', reasons: [domain.reason], address };

  // Our own findings that a provider's answer leaves standing.
  let status: VerificationStatus = 'valid';
  const reasons: VerificationReason[] = [];
  if (isDisposableDomain(syntax.domain)) {
    status = 'risky';
    reasons.push('disposable');
  }
  if (isRoleAddress(syntax.local)) reasons.push('role');

  const { provider } = options;
  if (provider === undefined) {
    if (domain.kind === 'unknown') {
      status = worse(status, 'unknown');
      reasons.push('dns_unavailable');
    }
    return { status, depth: 'domain', reasons: ordered(reasons), address };
  }

  const outcome = await askProvider(provider, address, options.signal);
  const asked = { name: provider.name, outcome };
  if (outcome.kind === 'failed') {
    if (domain.kind === 'unknown') reasons.push('dns_unavailable');
    return {
      status: worse(status, 'unknown'),
      depth: 'domain',
      reasons: ordered([...reasons, 'provider_error']),
      address,
      provider: asked,
    };
  }
  // The provider resolved the domain itself, so our own DNS failure no longer counts.
  return {
    status: worse(status, outcome.status),
    depth: 'mailbox',
    reasons: ordered([...reasons, ...outcome.reasons]),
    address,
    provider: asked,
  };
}

async function askProvider(
  provider: MailboxProvider,
  address: string,
  signal: AbortSignal | undefined,
): Promise<MailboxOutcome> {
  try {
    return await provider.verify(address, signal === undefined ? {} : { signal });
  } catch {
    // A provider should never throw; if one does, its error (which may quote the address)
    // is dropped and the check is unknown.
    return { kind: 'failed', problem: 'unexpected_error', connectionFailing: false };
  }
}
