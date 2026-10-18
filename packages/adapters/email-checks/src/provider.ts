/**
 * What a check says about an address. Only invalid stops mail being sent; risky is sent to
 * with a warning; unknown is checked again later.
 */
export type VerificationStatus = 'valid' | 'risky' | 'invalid' | 'unknown';

/** Why, as stable codes the dashboard words in the reader's language. */
export type VerificationReason =
  // Syntax
  | 'bad_syntax'
  | 'unsupported_syntax'
  // DNS
  | 'domain_not_found'
  | 'no_mail_server'
  | 'no_mail_accepted'
  | 'dns_unavailable'
  // Lists and provider flags
  | 'disposable'
  | 'role'
  | 'free_provider'
  | 'catch_all'
  | 'mailbox_full'
  // A provider's mailbox check
  | 'mailbox_not_found'
  | 'smtp_rejected'
  | 'low_quality'
  | 'low_deliverability'
  | 'mail_server_unavailable'
  | 'provider_error';

/** Why a provider gave no answer. */
export type ProviderProblem =
  /** The key was missing, refused or revoked. */
  | 'unauthorized'
  /** The account has no credits left. */
  | 'no_credits'
  | 'rate_limited'
  /** The provider is still checking; asking again soon gets the answer. */
  | 'slow'
  | 'unavailable'
  | 'bad_request'
  | 'unexpected_status'
  | 'bad_response'
  | 'timeout'
  | 'cancelled'
  | 'network'
  /** The provider's adapter threw, which it never should. */
  | 'unexpected_error';

/** A provider's answer about one mailbox. */
export interface MailboxResult {
  readonly kind: 'result';
  readonly status: VerificationStatus;
  readonly reasons: readonly VerificationReason[];
  /**
   * The provider's own state and reason words, kept for support. Never the names, gender
   * or other details some providers infer from an address.
   */
  readonly raw: { readonly state: string; readonly reason: string | null };
  /** Whether the provider says this answer used a credit. */
  readonly charged: boolean;
}

/** No answer: the check is unknown and nothing was charged. */
export interface ProviderFailure {
  readonly kind: 'failed';
  readonly problem: ProviderProblem;
  /** The connection needs a person (a bad key, no credits); asking again won't help. */
  readonly connectionFailing: boolean;
  /** How long to wait before asking again, when the provider said. */
  readonly retryAfterMs?: number;
}

export type MailboxOutcome = MailboxResult | ProviderFailure;

/** A connection test: the key works, and the credits left. */
export type AccountOutcome =
  | {
      readonly kind: 'ok';
      readonly availableCredits: number;
      /** A test key: answers are simulated and use no credits. */
      readonly testMode: boolean;
    }
  | ProviderFailure;

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * A mailbox verification service. Both calls resolve, never reject: every failure comes
 * back as a ProviderFailure. Neither the address nor the key is ever logged.
 */
export interface MailboxProvider {
  /** The provider's name as stored with each check, such as "emailable". */
  readonly name: string;
  verify(address: string, options?: ProviderCallOptions): Promise<MailboxOutcome>;
  account(options?: ProviderCallOptions): Promise<AccountOutcome>;
}
