// What the Send email action's panel works out besides its settings (config.ts): the rows
// of its Statistics tab and how each is worded, the range of dates they are asked for, the
// other workflow actions that use a template, and a file's size in words.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type {
  TemplateWorkflowAction,
  WorkflowEmailSkipReason,
  WorkflowEmailStepStatistics,
} from '@repo/contracts';

/** The most the files of one email may weigh together: 15 MiB, as the server sends it. */
export const ATTACHMENTS_BYTES = 15 * 1024 * 1024;

/** A file's size as people read it: 840 KB, 2.4 MB. */
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---------------------------------------------------------------- statistics */

export const STATISTICS_RANGES = ['7', '30', '90', 'all'] as const;
export type StatisticsRange = (typeof STATISTICS_RANGES)[number];

export const rangeNames: Readonly<Record<StatisticsRange, MessageDescriptor>> = {
  '7': msg`Last 7 days`,
  '30': msg`Last 30 days`,
  '90': msg`Last 90 days`,
  all: msg`All time`,
};

/** The start of a range as the API takes it, counted back from now; nothing for all time. */
export function rangeStart(range: StatisticsRange, now: Date): string | undefined {
  if (range === 'all') return undefined;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - Number(range));
  // To the minute, so asking again within it is the same question.
  start.setUTCSeconds(0, 0);
  return start.toISOString();
}

const skipReasons: Readonly<Record<WorkflowEmailSkipReason, MessageDescriptor>> = {
  no_consent: msg`No consent to marketing email`,
  unsubscribed: msg`Unsubscribed`,
  do_not_contact: msg`Do not contact is on`,
  suppressed: msg`On the suppression list`,
  bounced_before: msg`An earlier email bounced`,
  complained: msg`Marked an earlier email as spam`,
  no_email_address: msg`No email address`,
  contact_removed: msg`The contact was deleted`,
  no_time_zone: msg`No time zone to keep quiet hours by`,
  mailbox_unavailable: msg`The mailbox wasn't available`,
  unsubscribe_unavailable: msg`No unsubscribe link could be made`,
  other: msg`Another reason`,
};

/** Why an email was not sent to a contact, in words; a reason this version doesn't know as written. */
export const skipReasonWords = (reason: string): string =>
  Object.hasOwn(skipReasons, reason)
    ? i18n._(skipReasons[reason as WorkflowEmailSkipReason])
    : reason;

export interface StatisticRow {
  readonly key: string;
  readonly label: string;
  /** The count as it is shown, or the words for a number nothing measures. */
  readonly value: string;
  /** False for a number that is not measured: shown quieter, never as zero. */
  readonly measured: boolean;
  /** A line under it: what the number means. */
  readonly note?: string;
}

const count = (value: number): string => value.toLocaleString(i18n.locale || 'en-US');

/**
 * The rows of the Statistics tab. A number the server does not measure is null: it is said
 * to be not measured or not tracked yet, never shown as zero.
 */
export function statisticRows(statistics: WorkflowEmailStepStatistics): StatisticRow[] {
  const notTracked = i18n._(msg`Not tracked yet`);
  const row = (
    key: string,
    label: MessageDescriptor,
    value: number | null,
    unmeasured: string,
    note?: MessageDescriptor,
  ): StatisticRow => ({
    key,
    label: i18n._(label),
    value: value === null ? unmeasured : count(value),
    measured: value !== null,
    ...(note === undefined ? {} : { note: i18n._(note) }),
  });
  return [
    row('total', msg`Reached this action`, statistics.total, ''),
    row('sent', msg`Sent`, statistics.sent, '', msg`Accepted by the mail server.`),
    row(
      'delivered',
      msg`Delivered`,
      statistics.delivered,
      i18n._(msg`Not measured`),
      msg`A mail server accepting an email is not proof it reached the inbox.`,
    ),
    row(
      'waiting',
      msg`Waiting to send`,
      statistics.waiting,
      '',
      msg`Held for quiet hours, a daily limit or the sending pace.`,
    ),
    row('failed', msg`Failed`, statistics.failed, ''),
    row('bounced', msg`Bounced`, statistics.bounced, ''),
    row('skipped', msg`Skipped`, statistics.skipped.total, ''),
    row('unsubscribed', msg`Unsubscribed`, statistics.unsubscribed, ''),
    row('opened', msg`Opened`, statistics.opened, notTracked),
    row('clicked', msg`Clicked`, statistics.clicked, notTracked),
  ];
}

/** Why emails were skipped, most first; a reason with none is left out. */
export function skipRows(
  statistics: WorkflowEmailStepStatistics,
): { readonly reason: string; readonly label: string; readonly value: string }[] {
  return statistics.skipped.reasons
    .filter((each) => each.count > 0)
    .toSorted((left, right) => right.count - left.count)
    .map((each) => ({
      reason: each.reason,
      label: skipReasonWords(each.reason),
      value: count(each.count),
    }));
}

/* ---------------------------------------------------------------- who else uses a template */

export interface OtherUse {
  readonly key: string;
  /** The workflow's name, and the action's own name when it has one. */
  readonly name: string;
  readonly mode: TemplateWorkflowAction['mode'];
  readonly published: boolean;
}

/**
 * The other workflow actions that use a template: every one but this action in this
 * workflow's draft. An action listed for both its draft and its running version is one line.
 */
export function otherUses(
  actions: readonly TemplateWorkflowAction[],
  self: { readonly automation: string | undefined; readonly step: string | undefined },
): OtherUse[] {
  const uses = new Map<string, OtherUse>();
  for (const action of actions) {
    if (action.automation.id === self.automation && action.step === self.step) continue;
    const key = `${action.automation.id}:${action.step}`;
    const held = uses.get(key);
    const published = action.scope === 'published';
    if (held !== undefined) {
      // The running version is what sends today: its mode is the one to show.
      if (published) uses.set(key, { ...held, mode: action.mode, published: true });
      continue;
    }
    uses.set(key, {
      key,
      name:
        action.label === null || action.label.trim() === ''
          ? action.automation.name
          : `${action.automation.name} · ${action.label}`,
      mode: action.mode,
      published,
    });
  }
  return [...uses.values()];
}

/** How many different workflows use a template, for the templates list. */
export const workflowCount = (actions: readonly TemplateWorkflowAction[]): number =>
  new Set(actions.map((action) => action.automation.id)).size;

const modeNames: Readonly<Record<TemplateWorkflowAction['mode'], MessageDescriptor>> = {
  sync: msg`syncs with it`,
  reference: msg`sends it as it is`,
  copy: msg`holds a copy`,
};

/** How an action uses a template, in words. */
export const modeWords = (mode: TemplateWorkflowAction['mode']): string => i18n._(modeNames[mode]);
