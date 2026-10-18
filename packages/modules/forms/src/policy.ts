// A form's own limits, as a pure decision over stored facts. The shared limiter in front of
// every public route counts requests per address; this counts what one form stores.
//
// Spam must never cost a business its real leads. So what is refused is counted per
// source (visitor-source.ts: one IPv4 address, or one IPv6 /64): a source that sends too
// much is told to wait, and everyone else carries on. A form that takes more than a quiet
// hour holds is "busy": it keeps taking submissions, but asks more of each source (one an
// hour, and a longer time on the page before sending). Only past a ceiling far above that,
// kept so a flood from very many addresses cannot fill the database without end, is a form
// refused for everyone.

export interface FormSubmissionLimits {
  /** Submissions in an hour past which a form is busy and asks more of each source. */
  readonly busyPerHour: number;
  /** Submissions one form stores in an hour and a day at the most, from everyone together. */
  readonly ceilingPerHour: number;
  readonly ceilingPerDay: number;
  /** Submissions one source may send one form in an hour, quiet or busy, and in a day. */
  readonly sourcePerHour: number;
  readonly busySourcePerHour: number;
  readonly sourcePerDay: number;
  /** Seconds a form must have been on the page before it is sent, quiet or busy. */
  readonly minFillSeconds: number;
  readonly busyMinFillSeconds: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Whole seconds until a moment, never under one: a retry time of zero invites a retry loop.
const secondsUntil = (moment: number, now: number, most: number): number =>
  Math.min(most, Math.max(1, Math.ceil((moment - now) / 1000)));

/** What was stored in a window, and the oldest of it. */
export interface Stored {
  readonly stored: number;
  readonly oldest: Date | null;
}

export interface SubmissionFacts {
  /** What this form stored in the last hour and day, from everyone. */
  readonly form: { readonly hour: Stored; readonly day: Stored };
  /** What this form stored in the last hour and day from this submission's source. */
  readonly source: { readonly hour: Stored; readonly day: Stored };
  readonly now: Date;
}

export type SubmissionDecision =
  | {
      readonly allowed: true;
      readonly busy: boolean;
      /** How long the form must have been on the page: longer while the form is busy. */
      readonly minFillSeconds: number;
    }
  | {
      readonly allowed: false;
      readonly reason: 'form_hourly' | 'form_daily' | 'source_hourly' | 'source_daily';
      readonly retryAfterSeconds: number;
    };

/** Whether one form may store another submission from this source now. */
export function evaluateSubmission(
  facts: SubmissionFacts,
  limits: FormSubmissionLimits,
): SubmissionDecision {
  const now = facts.now.getTime();
  // A day is checked before an hour: it lasts longer.
  const full = (window: Stored, most: number, length: number): number | undefined =>
    window.stored >= most
      ? secondsUntil((window.oldest?.getTime() ?? now) + length, now, length / 1000)
      : undefined;
  const busy = facts.form.hour.stored >= limits.busyPerHour;
  const checks = [
    ['form_daily', full(facts.form.day, limits.ceilingPerDay, DAY_MS)],
    ['form_hourly', full(facts.form.hour, limits.ceilingPerHour, HOUR_MS)],
    ['source_daily', full(facts.source.day, limits.sourcePerDay, DAY_MS)],
    [
      'source_hourly',
      full(facts.source.hour, busy ? limits.busySourcePerHour : limits.sourcePerHour, HOUR_MS),
    ],
  ] as const;
  for (const [reason, retryAfterSeconds] of checks)
    if (retryAfterSeconds !== undefined) return { allowed: false, reason, retryAfterSeconds };
  return {
    allowed: true,
    busy,
    minFillSeconds: busy ? limits.busyMinFillSeconds : limits.minFillSeconds,
  };
}
