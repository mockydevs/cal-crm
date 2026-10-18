/** Product default, not a provider quota: 50/day to the chosen cap across 28 days. */
export function mailboxDailyAllowance(cap: number, enabled: boolean, elapsedDays: number): number {
  const initial = Math.min(50, cap);
  return enabled
    ? initial +
        Math.floor(((cap - initial) * Math.max(0, Math.min(27, Math.floor(elapsedDays)))) / 27)
    : cap;
}

export interface MailboxAdmissionFacts {
  readonly nowMs: number;
  readonly dailyLimit: number;
  readonly warmupEnabled: boolean;
  readonly elapsedDays: number;
  readonly recentAll: number;
  readonly recentAutomated: number;
  readonly earliestReservationMs: number | null;
  readonly lastReservationMs: number | null;
  readonly pacingPerMinute: number;
  readonly pausedUntilMs: number | null;
  readonly lane: 'reply' | 'transactional' | 'automation' | 'campaign';
}
export type MailboxAdmissionDecision =
  | { readonly action: 'allow' }
  | {
      readonly action: 'defer';
      readonly reason:
        'mailbox_daily_limit' | 'mailbox_warmup_limit' | 'mailbox_pacing' | 'provider_temporary';
      readonly retryAtMs: number;
    };

/** Reservations consume budget even when a remote outcome is ambiguous. */
export function evaluateMailboxAdmission(facts: MailboxAdmissionFacts): MailboxAdmissionDecision {
  if (facts.pausedUntilMs !== null && facts.pausedUntilMs > facts.nowMs)
    return { action: 'defer', reason: 'provider_temporary', retryAtMs: facts.pausedUntilMs };
  const dailyRetry = (facts.earliestReservationMs ?? facts.nowMs) + 86_400_000;
  if (facts.recentAll >= facts.dailyLimit)
    return { action: 'defer', reason: 'mailbox_daily_limit', retryAtMs: dailyRetry };
  if (
    facts.warmupEnabled &&
    (facts.lane === 'automation' || facts.lane === 'campaign') &&
    facts.recentAutomated >=
      mailboxDailyAllowance(facts.dailyLimit, facts.warmupEnabled, facts.elapsedDays)
  )
    return {
      action: 'defer',
      reason: 'mailbox_warmup_limit',
      retryAtMs: Math.min(
        dailyRetry,
        Math.ceil(
          facts.nowMs +
            (Math.max(0, Math.floor(facts.elapsedDays)) + 1 - facts.elapsedDays) * 86_400_000,
        ),
      ),
    };
  const next = (facts.lastReservationMs ?? -Infinity) + Math.ceil(60_000 / facts.pacingPerMinute);
  if (next > facts.nowMs) return { action: 'defer', reason: 'mailbox_pacing', retryAtMs: next };
  return { action: 'allow' };
}
