import type { CheckStatus } from '@repo/mail-checks';
import { mailboxCheckPoints } from '@repo/contracts';

// EMAIL.md section5: setup points total100; connection is required and carries no points.
export type MailboxCheckKey = keyof typeof mailboxCheckPoints;
const keys: readonly MailboxCheckKey[] = [
  'connection',
  'encryption',
  'spf',
  'dkim',
  'dmarc',
  'dmarc_enforcement',
  'reverse_dns',
  'mx',
  'blocklists',
  'unsubscribe',
];
export type MailboxCheckStatuses = Readonly<Record<MailboxCheckKey, CheckStatus>>;
export interface ScoredMailboxCheck {
  readonly key: MailboxCheckKey;
  readonly status: CheckStatus;
  readonly pointsPossible: number;
  readonly pointsAwarded: number;
}
export interface MailboxScore {
  readonly score: number;
  readonly checks: readonly ScoredMailboxCheck[];
}

/** Scores observed setup evidence; it never predicts inbox placement. */
export function scoreMailboxChecks(statuses: MailboxCheckStatuses): MailboxScore {
  const checks = keys.map((key) => ({
    key,
    status: statuses[key],
    pointsPossible: mailboxCheckPoints[key],
    pointsAwarded:
      statuses[key] === 'pass' || statuses[key] === 'not_applicable' ? mailboxCheckPoints[key] : 0,
  }));
  return { score: checks.reduce((total, check) => total + check.pointsAwarded, 0), checks };
}
