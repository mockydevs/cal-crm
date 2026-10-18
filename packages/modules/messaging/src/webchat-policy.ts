// The web chat widget's own limits, as pure decisions over stored facts. The shared limiter
// in front of every public route counts requests per address; these count what one widget
// and one session may do, whoever asks and from however many addresses.

export interface WebchatSessionLimits {
  readonly sessionsPerHour: number;
  readonly sessionsPerDay: number;
}

export interface WebchatMessageLimits {
  readonly messagesPerSession: number;
  readonly messagesPerMinute: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Whole seconds until a moment, never under one: a retry time of zero invites a retry loop.
const secondsUntil = (moment: number, now: number, most: number): number =>
  Math.min(most, Math.max(1, Math.ceil((moment - now) / 1000)));

export interface SessionStartFacts {
  /** Sessions this widget started in the last hour and day, and the oldest of each. */
  readonly startedLastHour: number;
  readonly startedLastDay: number;
  readonly oldestInHour: Date | null;
  readonly oldestInDay: Date | null;
  readonly now: Date;
}

export type SessionStartDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'hourly_sessions' | 'daily_sessions';
      readonly retryAfterSeconds: number;
    };

/** Whether one widget may start another session now. The day is checked first: it lasts longer. */
export function evaluateSessionStart(
  facts: SessionStartFacts,
  limits: WebchatSessionLimits,
): SessionStartDecision {
  const now = facts.now.getTime();
  if (facts.startedLastDay >= limits.sessionsPerDay)
    return {
      allowed: false,
      reason: 'daily_sessions',
      retryAfterSeconds: secondsUntil((facts.oldestInDay?.getTime() ?? now) + DAY_MS, now, 86_400),
    };
  if (facts.startedLastHour >= limits.sessionsPerHour)
    return {
      allowed: false,
      reason: 'hourly_sessions',
      retryAfterSeconds: secondsUntil((facts.oldestInHour?.getTime() ?? now) + HOUR_MS, now, 3600),
    };
  return { allowed: true };
}

export interface SessionFacts {
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
  /** The website the session was started from. */
  readonly origin: string;
  /** The website this request comes from, already matched against the widget's list. */
  readonly requestOrigin: string;
  readonly now: Date;
}

/**
 * Whether a session still answers. It ends at its expiry, when the visitor or a key
 * rotation ends it, and it works only from the website it was started on: a token copied
 * to another of the widget's websites opens nothing there.
 */
export function sessionIsLive(facts: SessionFacts): boolean {
  return (
    facts.endedAt === null &&
    facts.expiresAt.getTime() > facts.now.getTime() &&
    facts.origin === facts.requestOrigin
  );
}

export interface VisitorMessageFacts {
  /** Messages the visitor has sent in this session so far. */
  readonly sent: number;
  /** The session's current one-minute window, if it has one, and what was sent in it. */
  readonly minuteStartedAt: Date | null;
  readonly minuteCount: number;
  readonly now: Date;
}

export type VisitorMessageDecision =
  | {
      readonly allowed: true;
      /** What to store with the message: the window it falls in, and the count with it. */
      readonly minuteStartedAt: Date;
      readonly minuteCount: number;
    }
  | { readonly allowed: false; readonly reason: 'session_full' }
  | { readonly allowed: false; readonly reason: 'too_fast'; readonly retryAfterSeconds: number };

/** Whether a visitor may send one more message in a session now. */
export function evaluateVisitorMessage(
  facts: VisitorMessageFacts,
  limits: WebchatMessageLimits,
): VisitorMessageDecision {
  if (facts.sent >= limits.messagesPerSession) return { allowed: false, reason: 'session_full' };
  const now = facts.now.getTime();
  const started = facts.minuteStartedAt?.getTime();
  // A window that began in the future (a clock stepped back) still counts: stricter, not looser.
  if (started === undefined || now - started >= MINUTE_MS)
    return { allowed: true, minuteStartedAt: facts.now, minuteCount: 1 };
  if (facts.minuteCount >= limits.messagesPerMinute)
    return {
      allowed: false,
      reason: 'too_fast',
      retryAfterSeconds: secondsUntil(started + MINUTE_MS, now, 60),
    };
  return {
    allowed: true,
    minuteStartedAt: new Date(started),
    minuteCount: facts.minuteCount + 1,
  };
}

/** A visitor's one name field as a contact's two; never empty, since a contact needs a name. */
export function visitorName(name: string | undefined): {
  firstName: string;
  lastName: string | null;
} {
  const [first, ...rest] = (name ?? '').split(/\s+/).filter(Boolean);
  if (first === undefined) return { firstName: 'Website visitor', lastName: null };
  return { firstName: first, lastName: rest.length === 0 ? null : rest.join(' ') };
}
