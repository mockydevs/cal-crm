// When an email campaign's batches leave. Pure arithmetic, shared
// by the server, which releases the batches, and the dashboard, which says when each one
// goes.
//
// A campaign starts at an instant. "Every N minutes" and "every N hours" count elapsed
// time. "Every N days" keeps the wall-clock time of the business's time zone, so a batch
// that leaves at 09:00 still leaves at 09:00 after the clocks change. A sending window is a
// span of the business's day (from, to); outside it nothing is released.
import * as z from 'zod';

export const campaignBatchUnits = ['minutes', 'hours', 'days'] as const;
export type CampaignBatchUnit = (typeof campaignBatchUnits)[number];

/** The most contacts one campaign reaches, as a bulk action's limit. */
export const EMAIL_CAMPAIGN_AUDIENCE_LIMIT = 100_000;

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Give a time of day as HH:MM.' })
  .meta({ examples: ['09:00'] });

export const campaignWindow = z
  .strictObject({ from: clock, to: clock })
  .refine((window) => window.from !== window.to, {
    error: 'The window must open and close at different times.',
    path: ['to'],
  })
  .meta({
    id: 'EmailCampaignWindow',
    description:
      "The hours of the business's day in which batches may leave. A window whose end is before its start runs past midnight.",
  });
export type CampaignWindow = z.output<typeof campaignWindow>;

export const campaignBatches = z
  .strictObject({
    size: z.int().min(1).max(EMAIL_CAMPAIGN_AUDIENCE_LIMIT),
    every: z.int().min(1).max(1440),
    unit: z.enum(campaignBatchUnits),
    window: campaignWindow.nullable().default(null),
  })
  .refine((batches) => batches.unit !== 'minutes' || batches.every >= 5, {
    error: 'Leave at least 5 minutes between batches.',
    path: ['every'],
  })
  .refine((batches) => batches.unit !== 'days' || batches.every <= 30, {
    error: 'Leave at most 30 days between batches.',
    path: ['every'],
  })
  .refine((batches) => batches.unit !== 'hours' || batches.every <= 720, {
    error: 'Leave at most 720 hours between batches.',
    path: ['every'],
  })
  .meta({
    id: 'EmailCampaignBatches',
    description:
      'Send in batches: this many emails, then wait, then the next. Left out, the campaign is sent as fast as the mailbox allows.',
  });
export type CampaignBatches = z.output<typeof campaignBatches>;

interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    // hourCycle h23: midnight is 00, never 24 (ECMA-402 DateTimeFormat options).
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock time an instant has in a time zone. */
export function localTimeOf(instant: Date, timeZone: string): LocalTime {
  const parts: Record<string, number> = {};
  for (const part of formatterOf(timeZone).formatToParts(instant))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 1,
    day: parts['day'] ?? 1,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

const asUtc = (local: LocalTime): number =>
  Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);

/**
 * The instant a wall-clock time names in a time zone. A time the clocks skip (spring
 * forward) gives the instant that much after the change; a time that happens twice (fall
 * back) gives the first.
 */
export function instantOfLocal(local: LocalTime, timeZone: string): Date {
  const wanted = asUtc(local);
  const offsetAt = (at: number) => asUtc(localTimeOf(new Date(at), timeZone)) - at;
  // The offset in force a day either side differs only across a change; the earlier of the
  // candidates that read back as the wanted time is the first occurrence.
  const candidates = [
    wanted - offsetAt(wanted - 86_400_000),
    wanted - offsetAt(wanted + 86_400_000),
  ]
    .filter((candidate) => asUtc(localTimeOf(new Date(candidate), timeZone)) === wanted)
    .sort((a, b) => a - b);
  const [first] = candidates;
  if (first !== undefined) return new Date(first);
  // Skipped by the clocks: keep the offset from before the change.
  return new Date(wanted - offsetAt(wanted - 86_400_000));
}

/** When batch `index` (0 is the first) may start leaving. */
export function campaignBatchDueAt(
  startedAt: Date,
  batches: Pick<CampaignBatches, 'every' | 'unit'>,
  index: number,
  timeZone: string,
): Date {
  if (index <= 0) return new Date(startedAt.getTime());
  if (batches.unit === 'minutes')
    return new Date(startedAt.getTime() + index * batches.every * 60_000);
  if (batches.unit === 'hours')
    return new Date(startedAt.getTime() + index * batches.every * 3_600_000);
  const local = localTimeOf(startedAt, timeZone);
  // Date.UTC normalises a day past the month's end, so adding days is calendar arithmetic.
  const moved = new Date(asUtc({ ...local, day: local.day + index * batches.every }));
  return instantOfLocal(
    {
      year: moved.getUTCFullYear(),
      month: moved.getUTCMonth() + 1,
      day: moved.getUTCDate(),
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    timeZone,
  );
}

const minutesOf = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whether the window is open at this instant. No window is always open. */
export function campaignWindowOpen(
  instant: Date,
  window: CampaignWindow | null,
  timeZone: string,
): boolean {
  if (window === null) return true;
  const local = localTimeOf(instant, timeZone);
  const now = local.hour * 60 + local.minute;
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The instant itself when the window is open, else when it next opens. */
export function campaignWindowOpensAt(
  instant: Date,
  window: CampaignWindow | null,
  timeZone: string,
): Date {
  if (window === null || campaignWindowOpen(instant, window, timeZone))
    return new Date(instant.getTime());
  const local = localTimeOf(instant, timeZone);
  const from = minutesOf(window.from);
  const opening = (dayOffset: number) => {
    const day = new Date(
      asUtc({ ...local, day: local.day + dayOffset, hour: 0, minute: 0, second: 0 }),
    );
    return instantOfLocal(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: Math.floor(from / 60),
        minute: from % 60,
        second: 0,
      },
      timeZone,
    );
  };
  const today = opening(0);
  return today.getTime() > instant.getTime() ? today : opening(1);
}

/**
 * How many days a send of `emails` takes at `perDay` a day: 1 when it fits in a day. With
 * batches, the batches' own pace counts too, whichever is slower.
 */
export function campaignSpreadDays(
  emails: number,
  perDay: number,
  batches: Pick<CampaignBatches, 'size' | 'every' | 'unit'> | null,
): number {
  if (emails <= 0) return 0;
  const byCeiling = Math.ceil(emails / Math.max(1, perDay));
  if (batches === null) return byCeiling;
  const minutes =
    batches.every * (batches.unit === 'minutes' ? 1 : batches.unit === 'hours' ? 60 : 1440);
  const waits = Math.ceil(emails / batches.size) - 1;
  return Math.max(byCeiling, Math.floor((waits * minutes) / 1440) + 1);
}
