import { describe, expect, it } from 'vitest';

import {
  evaluateSessionStart,
  evaluateVisitorMessage,
  sessionIsLive,
  visitorName,
} from './webchat-policy.js';

const now = new Date('2026-10-09T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('evaluateSessionStart', () => {
  const limits = { sessionsPerHour: 3, sessionsPerDay: 5 };
  const quiet = {
    startedLastHour: 0,
    startedLastDay: 0,
    oldestInHour: null,
    oldestInDay: null,
    now,
  };

  it('allows a widget under both limits', () => {
    expect(evaluateSessionStart(quiet, limits)).toEqual({ allowed: true });
    expect(
      evaluateSessionStart({ ...quiet, startedLastHour: 2, startedLastDay: 4 }, limits),
    ).toEqual({ allowed: true });
  });

  it('refuses at the hourly limit until the oldest session of the hour is an hour old', () => {
    expect(
      evaluateSessionStart(
        { ...quiet, startedLastHour: 3, startedLastDay: 3, oldestInHour: ago(50 * 60_000) },
        limits,
      ),
    ).toEqual({ allowed: false, reason: 'hourly_sessions', retryAfterSeconds: 600 });
  });

  it('refuses at the daily limit first, for as long as that lasts', () => {
    expect(
      evaluateSessionStart(
        {
          startedLastHour: 3,
          startedLastDay: 5,
          oldestInHour: ago(60_000),
          oldestInDay: ago(23 * 3_600_000),
          now,
        },
        limits,
      ),
    ).toEqual({ allowed: false, reason: 'daily_sessions', retryAfterSeconds: 3600 });
  });

  it('refuses past a limit too, and never gives a retry time under a second or over the window', () => {
    const over = evaluateSessionStart(
      { ...quiet, startedLastHour: 99, startedLastDay: 4, oldestInHour: ago(3_600_000 - 1) },
      limits,
    );
    expect(over).toEqual({ allowed: false, reason: 'hourly_sessions', retryAfterSeconds: 1 });
    // A count with no oldest time, or one in the future, still gets a bounded answer.
    expect(evaluateSessionStart({ ...quiet, startedLastHour: 3 }, limits)).toEqual({
      allowed: false,
      reason: 'hourly_sessions',
      retryAfterSeconds: 3600,
    });
    expect(
      evaluateSessionStart({ ...quiet, startedLastDay: 5, oldestInDay: ago(-999_999_999) }, limits),
    ).toEqual({ allowed: false, reason: 'daily_sessions', retryAfterSeconds: 86_400 });
    // A count whose oldest time is already past the window, which the caller's own query
    // rules out: the answer is still a wait of a second, never zero, which invites a loop.
    expect(
      evaluateSessionStart(
        { ...quiet, startedLastHour: 3, oldestInHour: ago(2 * 3_600_000) },
        limits,
      ),
    ).toEqual({ allowed: false, reason: 'hourly_sessions', retryAfterSeconds: 1 });
    expect(
      evaluateSessionStart({ ...quiet, startedLastDay: 5, oldestInDay: ago(86_400_000) }, limits),
    ).toEqual({ allowed: false, reason: 'daily_sessions', retryAfterSeconds: 1 });
  });
});

describe('sessionIsLive', () => {
  const live = {
    expiresAt: new Date(now.getTime() + 1),
    endedAt: null,
    origin: 'https://example.com',
    requestOrigin: 'https://example.com',
    now,
  };

  it('answers a session that has not expired or ended, on its own website', () => {
    expect(sessionIsLive(live)).toBe(true);
  });

  it('ends at the expiry time exactly', () => {
    expect(sessionIsLive({ ...live, expiresAt: now })).toBe(false);
    expect(sessionIsLive({ ...live, expiresAt: ago(1) })).toBe(false);
  });

  it('stays ended once ended, whatever the expiry says', () => {
    expect(sessionIsLive({ ...live, endedAt: ago(1000) })).toBe(false);
    expect(sessionIsLive({ ...live, endedAt: new Date(now.getTime() + 1000) })).toBe(false);
  });

  it('refuses a token used from another of the widget websites', () => {
    expect(sessionIsLive({ ...live, requestOrigin: 'https://www.example.com' })).toBe(false);
  });
});

describe('evaluateVisitorMessage', () => {
  const limits = { messagesPerSession: 5, messagesPerMinute: 2 };
  const fresh = { sent: 0, minuteStartedAt: null, minuteCount: 0, now };

  it('starts a window with the first message', () => {
    expect(evaluateVisitorMessage(fresh, limits)).toEqual({
      allowed: true,
      minuteStartedAt: now,
      minuteCount: 1,
    });
  });

  it('counts within the window and keeps its start', () => {
    const started = ago(30_000);
    expect(
      evaluateVisitorMessage({ sent: 1, minuteStartedAt: started, minuteCount: 1, now }, limits),
    ).toEqual({ allowed: true, minuteStartedAt: started, minuteCount: 2 });
  });

  it('refuses the message past the per-minute limit until the window ends', () => {
    expect(
      evaluateVisitorMessage(
        { sent: 2, minuteStartedAt: ago(45_000), minuteCount: 2, now },
        limits,
      ),
    ).toEqual({ allowed: false, reason: 'too_fast', retryAfterSeconds: 15 });
    expect(
      evaluateVisitorMessage(
        { sent: 2, minuteStartedAt: ago(59_999), minuteCount: 9, now },
        limits,
      ),
    ).toEqual({ allowed: false, reason: 'too_fast', retryAfterSeconds: 1 });
  });

  it('opens a new window once a minute has passed', () => {
    expect(
      evaluateVisitorMessage(
        { sent: 2, minuteStartedAt: ago(60_000), minuteCount: 2, now },
        limits,
      ),
    ).toEqual({ allowed: true, minuteStartedAt: now, minuteCount: 1 });
  });

  it('keeps counting in a window that starts in the future, and bounds the wait', () => {
    const ahead = new Date(now.getTime() + 600_000);
    expect(
      evaluateVisitorMessage({ sent: 2, minuteStartedAt: ahead, minuteCount: 2, now }, limits),
    ).toEqual({ allowed: false, reason: 'too_fast', retryAfterSeconds: 60 });
  });

  it('refuses every message once the session is full, whatever the window', () => {
    expect(evaluateVisitorMessage({ ...fresh, sent: 5 }, limits)).toEqual({
      allowed: false,
      reason: 'session_full',
    });
    expect(evaluateVisitorMessage({ ...fresh, sent: 6 }, limits)).toEqual({
      allowed: false,
      reason: 'session_full',
    });
    expect(evaluateVisitorMessage({ ...fresh, sent: 4 }, limits).allowed).toBe(true);
  });
});

describe('visitorName', () => {
  it('splits one name field into first and last', () => {
    expect(visitorName('Maya')).toEqual({ firstName: 'Maya', lastName: null });
    expect(visitorName('  Maya   Wanjiru  Thompson ')).toEqual({
      firstName: 'Maya',
      lastName: 'Wanjiru Thompson',
    });
  });

  it('names a visitor who gave no name, since a contact needs one', () => {
    for (const name of [undefined, '', '   '])
      expect(visitorName(name)).toEqual({ firstName: 'Website visitor', lastName: null });
  });
});
