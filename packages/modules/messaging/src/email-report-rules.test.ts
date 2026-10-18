// The Dashboard's email numbers, worked out by hand for a few days of counts and held
// against the rules. No database: email-report.int.test.ts counts real messages.
import { describe, expect, it } from 'vitest';

import { emailNumbers, type EmailCount } from './email-report-rules.js';

const DAYS = ['2026-03-01', '2026-03-02', '2026-03-03'];
const count = (
  day: string,
  metric: EmailCount['metric'],
  detail: string | null,
  n: number,
): EmailCount => ({ day, metric, detail, count: n });
const ZERO = { sent: 0, notSent: 0, bounced: 0, received: 0, replies: 0, unsubscribed: 0 };

describe('the email numbers of a range', () => {
  it('are zeros for every day when nothing was counted', () => {
    expect(emailNumbers(DAYS, [])).toEqual({
      totals: { ...ZERO, hardBounced: 0 },
      notSentReasons: [],
      senders: [
        { sender: 'workflow', count: 0 },
        { sender: 'person', count: 0 },
        { sender: 'assistant', count: 0 },
        { sender: 'other', count: 0 },
      ],
      days: DAYS.map((date) => ({ date, ...ZERO })),
    });
    expect(emailNumbers([], []).days).toEqual([]);
  });

  it('add each count to its day and to the totals, and leave the other days at zero', () => {
    const numbers = emailNumbers(DAYS, [
      count('2026-03-01', 'sent', 'workflow', 5),
      count('2026-03-01', 'sent', 'person', 2),
      count('2026-03-03', 'sent', 'assistant', 1),
      count('2026-03-03', 'sent', 'other', 4),
      count('2026-03-01', 'not_sent', 'consent_required', 3),
      count('2026-03-03', 'not_sent', 'suppressed', 1),
      count('2026-03-03', 'bounced', 'hard_bounce', 2),
      count('2026-03-03', 'bounced', 'soft_bounce', 1),
      count('2026-03-01', 'received', 'reply', 2),
      count('2026-03-01', 'received', 'other', 3),
      count('2026-03-03', 'unsubscribed', null, 1),
    ]);
    expect(numbers.days).toEqual([
      { date: '2026-03-01', ...ZERO, sent: 7, notSent: 3, received: 5, replies: 2 },
      { date: '2026-03-02', ...ZERO },
      { date: '2026-03-03', ...ZERO, sent: 5, notSent: 1, bounced: 3, unsubscribed: 1 },
    ]);
    expect(numbers.totals).toEqual({
      sent: 12,
      notSent: 4,
      bounced: 3,
      hardBounced: 2,
      received: 5,
      replies: 2,
      unsubscribed: 1,
    });
    expect(numbers.senders).toEqual([
      { sender: 'workflow', count: 5 },
      { sender: 'person', count: 2 },
      { sender: 'assistant', count: 1 },
      { sender: 'other', count: 4 },
    ]);
  });

  it('name the reasons an email was not sent, the most common first and then by name', () => {
    const { notSentReasons, totals } = emailNumbers(DAYS, [
      count('2026-03-01', 'not_sent', 'suppressed', 2),
      count('2026-03-02', 'not_sent', 'consent_required', 1),
      count('2026-03-03', 'not_sent', 'consent_required', 4),
      count('2026-03-02', 'not_sent', 'do_not_contact', 2),
      count('2026-03-02', 'not_sent', null, 1),
      // A bounce is not a reason an email was not sent: it was.
      count('2026-03-02', 'bounced', 'hard_bounce', 9),
    ]);
    expect(notSentReasons).toEqual([
      { reason: 'consent_required', count: 5 },
      { reason: 'do_not_contact', count: 2 },
      { reason: 'suppressed', count: 2 },
      { reason: 'unknown', count: 1 },
    ]);
    expect(notSentReasons.reduce((total, each) => total + each.count, 0)).toBe(totals.notSent);
  });

  it('count a sender they do not know as other, so the senders add up to what was sent', () => {
    const { senders, totals } = emailNumbers(DAYS, [
      count('2026-03-01', 'sent', 'workflow', 1),
      count('2026-03-01', 'sent', 'campaign', 2),
      count('2026-03-01', 'sent', null, 3),
    ]);
    expect(senders).toEqual([
      { sender: 'workflow', count: 1 },
      { sender: 'person', count: 0 },
      { sender: 'assistant', count: 0 },
      { sender: 'other', count: 5 },
    ]);
    expect(totals.sent).toBe(6);
  });

  it('leave a count dated outside the days out of every row and every total', () => {
    const numbers = emailNumbers(DAYS, [
      count('2026-02-28', 'sent', 'person', 7),
      count('2026-03-04', 'not_sent', 'suppressed', 7),
      count('2026-03-02', 'sent', 'person', 1),
    ]);
    expect(numbers.totals).toEqual({ ...ZERO, sent: 1, hardBounced: 0 });
    expect(numbers.notSentReasons).toEqual([]);
    expect(numbers.days.map((day) => day.sent)).toEqual([0, 1, 0]);
  });
});
