import type { CheckStatus } from './types.js';

/** Worker-only evidence from a self-addressed probe; never accepts arbitrary client mail. */
export interface MessageCheckInput {
  readonly source: Buffer;
  readonly expectedFrom: string;
  readonly expectedMessageId: string;
  readonly campaign: boolean;
  /** Observed authenticated, certificate-verified connections, not message header claims. */
  readonly smtpTls: boolean;
  readonly imapTls: boolean;
}

export interface MessageCheckResult {
  readonly key: 'dkim' | 'dmarc' | 'encryption' | 'unsubscribe';
  readonly status: CheckStatus;
  readonly reason: string;
  /** Allowlisted evidence only; no source, bodies, addresses, URLs or vendor error text. */
  readonly found: Readonly<Record<string, unknown>>;
}

export class MessageEvidenceError extends Error {
  override readonly name = 'MessageEvidenceError';
  constructor(
    readonly code:
      | 'unexpected_message'
      | 'too_large'
      | 'too_many_signatures'
      | 'malformed_message'
      | 'verification',
  ) {
    super(`Message evidence is unavailable (${code}).`);
  }
}
