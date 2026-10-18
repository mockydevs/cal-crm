// The Dashboard's email numbers, put together from one count of a business's email by day.
// Pure: no clock, no database. email-report.ts does the counting.
import type { EmailReport } from '@repo/contracts';

/** What a count is of. */
export const emailMetrics = ['sent', 'not_sent', 'bounced', 'received', 'unsubscribed'] as const;
export type EmailMetric = (typeof emailMetrics)[number];

/**
 * How many emails of one day share a metric and a detail. The detail is who sent a sent
 * email, why one was not sent, how one bounced (`hard_bounce` or `soft_bounce`), and
 * whether a received one is a `reply`. An unsubscribe has none.
 */
export interface EmailCount {
  /** The business's calendar day, as YYYY-MM-DD. */
  readonly day: string;
  readonly metric: EmailMetric;
  readonly detail: string | null;
  readonly count: number;
}

type Numbers = Pick<EmailReport, 'totals' | 'notSentReasons' | 'senders' | 'days'>;
type Counts = Record<
  'sent' | 'notSent' | 'bounced' | 'received' | 'replies' | 'unsubscribed',
  number
>;
type Sender = EmailReport['senders'][number]['sender'];

// The order the contract promises (emailReportSenders).
const SENDERS = ['workflow', 'person', 'assistant', 'other'] as const satisfies readonly Sender[];

const sum = (counts: readonly EmailCount[]): number =>
  counts.reduce((total, each) => total + each.count, 0);

function countsOf(counts: readonly EmailCount[]): Counts {
  const of = (metric: EmailMetric) => counts.filter((each) => each.metric === metric);
  const received = of('received');
  return {
    sent: sum(of('sent')),
    notSent: sum(of('not_sent')),
    bounced: sum(of('bounced')),
    received: sum(received),
    replies: sum(received.filter((each) => each.detail === 'reply')),
    unsubscribed: sum(of('unsubscribed')),
  };
}

/** Who sent it. A sender this code does not know is still an email that was sent. */
const senderOf = (detail: string | null): Sender =>
  SENDERS.find((sender) => sender === detail) ?? 'other';

/**
 * The report's numbers. `days` is every calendar day of the range, each once and in order: a
 * day without a count is a row of zeros. A count on a day outside them is in no row and no total.
 */
export function emailNumbers(days: readonly string[], counts: readonly EmailCount[]): Numbers {
  const byDay = new Map<string, EmailCount[]>(days.map((date) => [date, []]));
  for (const each of counts) byDay.get(each.day)?.push(each);
  const kept = [...byDay.values()].flat();

  const reasons = new Map<string, number>();
  for (const each of kept)
    if (each.metric === 'not_sent') {
      const reason = each.detail ?? 'unknown';
      reasons.set(reason, (reasons.get(reason) ?? 0) + each.count);
    }
  const sent = kept.filter((each) => each.metric === 'sent');

  return {
    totals: {
      ...countsOf(kept),
      hardBounced: sum(
        kept.filter((each) => each.metric === 'bounced' && each.detail === 'hard_bounce'),
      ),
    },
    notSentReasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    senders: SENDERS.map((sender) => ({
      sender,
      count: sum(sent.filter((each) => senderOf(each.detail) === sender)),
    })),
    days: [...byDay].map(([date, group]) => ({ date, ...countsOf(group) })),
  };
}
