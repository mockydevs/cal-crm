// The rules of an email campaign that need no database: what a person may do in each
// status, how many emails may be released now and why not more, when a campaign pauses
// itself, why a recipient is skipped, and how the content is made ready to send.
import {
  campaignBatchDueAt,
  campaignWindowOpen,
  campaignWindowOpensAt,
  EMAIL_UNSUBSCRIBE_MERGE_FIELD,
  emailCampaignActions,
  type CampaignBatches,
  type ConditionValues,
  type EmailCampaignSkipReason,
  type EmailCampaignStatus,
  type EmailCampaignWaitReason,
} from '@repo/contracts';

import { showsUnsubscribeLink } from './email-html.js';
import { mailboxDailyAllowance } from './mailbox-admission.js';
import type { OutboundPolicyDecision } from './outbound-policy.js';

/**
 * A campaign pauses itself once this share of its sent emails hard-bounced, counted after
 * this many were sent. Our own default: Google's and Yahoo's sender pages give no bounce
 * figure, only "reduce the sending volume" when mail bounces and "remove invalid
 * recipients" (support.google.com/a/answer/81126, senders.yahooinc.com/best-practices,
 * both read 2026-10-13).
 */
export const CAMPAIGN_BOUNCE_PAUSE = { percent: 5, afterSent: 100 } as const;

/**
 * The share of a mailbox's daily limit campaigns leave alone when the mailbox also carries
 * conversations, so a campaign never uses up the day's replies and workflow emails.
 */
export const CAMPAIGN_CONVERSATION_RESERVE = 0.2;

/**
 * What stands in the stored body where the recipient's unsubscribe address goes. The
 * address is made when the email leaves (unsubscribe.ts), so the body waits with this in
 * its place. `.invalid` never resolves (RFC 2606), so a message that somehow kept it leads
 * nowhere.
 */
export const UNSUBSCRIBE_PLACEHOLDER = 'https://unsubscribe.invalid/link';

export type CampaignAction =
  'edit' | 'delete' | 'send' | 'schedule' | 'pause' | 'resume' | 'cancel';

/** Whether a campaign in this status takes this action (the contract has the table). */
export function campaignAllows(status: EmailCampaignStatus, action: CampaignAction): boolean {
  return emailCampaignActions[status].includes(action);
}

/** Why the pipeline's policy refuses a contact, as a campaign names it; null when it does not. */
export function skipReasonOfPolicy(
  decision: OutboundPolicyDecision,
): EmailCampaignSkipReason | null {
  if (decision.action !== 'refuse') return null;
  if (decision.reason === 'suppressed') return skipReasonOfSuppression(decision.suppressionReason);
  return REFUSALS[decision.reason] ?? 'refused';
}

const REFUSALS: Readonly<Record<string, EmailCampaignSkipReason>> = {
  contact_inactive: 'contact_removed',
  sender_inactive: 'mailbox_unavailable',
  mailbox_unavailable: 'mailbox_unavailable',
  mailbox_use_disabled: 'mailbox_unavailable',
  do_not_contact: 'do_not_contact',
  consent_withdrawn: 'unsubscribed',
  consent_required: 'no_consent',
  timing_unknown: 'no_time_zone',
  recipient_changed: 'no_email',
  unsubscribe_unavailable: 'unsubscribe_unavailable',
  campaign_cancelled: 'cancelled',
};

function skipReasonOfSuppression(reason: string | null): EmailCampaignSkipReason {
  if (reason === 'unsubscribe') return 'unsubscribed';
  if (reason === 'complaint') return 'complained';
  if (reason === 'hard_bounce' || reason === 'invalid') return 'bounced';
  return 'suppressed';
}

/**
 * What became of a recipient whose message has ended, or null while it is still on its
 * way. A message the pipeline refused is a skip with its reason; one the mail server
 * refused, or whose delivery nobody can tell, is a failure.
 */
export function recipientOutcome(message: {
  readonly status: string;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
}):
  | { readonly status: 'sent' | 'failed'; readonly reason: null }
  | { readonly status: 'skipped'; readonly reason: EmailCampaignSkipReason }
  | null {
  if (['sent', 'delivered', 'read', 'bounced'].includes(message.status))
    return { status: 'sent', reason: null };
  if (message.status === 'unknown') return { status: 'failed', reason: null };
  if (message.status !== 'failed') return null;
  if (message.errorCode === 'delivery_rejected' || message.errorCode === null)
    return { status: 'failed', reason: null };
  if (message.errorCode === 'suppressed')
    return { status: 'skipped', reason: skipReasonOfSuppression(message.errorDetail) };
  return { status: 'skipped', reason: REFUSALS[message.errorCode] ?? 'refused' };
}

/** Whether a campaign's hard bounces have passed the threshold. */
export function bounceRateExceeded(sent: number, hardBounced: number): boolean {
  return (
    sent >= CAMPAIGN_BOUNCE_PAUSE.afterSent &&
    hardBounced * 100 >= sent * CAMPAIGN_BOUNCE_PAUSE.percent
  );
}

export interface CampaignMailboxFacts {
  readonly dailyLimit: number;
  readonly warmupEnabled: boolean;
  readonly elapsedDays: number;
  readonly pacingPerMinute: number;
  readonly useForConversations: boolean;
  /** Reservations of every lane in the last 24 hours, as mailbox admission counts them. */
  readonly recentAll: number;
  /** Those of the automation and campaign lanes. */
  readonly recentAutomated: number;
  /** When the oldest of them was made: a day later the mailbox has room again. */
  readonly earliestReservationMs: number | null;
  /** Campaign emails released to this mailbox and not yet handed to the mail server. */
  readonly inFlight: number;
}

/**
 * The most campaign emails a mailbox may be handed in a day: its daily limit, less what it
 * keeps back for conversations, and no more than its warm-up allowance.
 */
export function campaignDailyAllowance(
  mailbox: Pick<
    CampaignMailboxFacts,
    'dailyLimit' | 'warmupEnabled' | 'elapsedDays' | 'useForConversations'
  >,
): number {
  const reserve = mailbox.useForConversations
    ? Math.ceil(mailbox.dailyLimit * CAMPAIGN_CONVERSATION_RESERVE)
    : 0;
  return Math.max(
    0,
    Math.min(
      mailbox.dailyLimit - reserve,
      mailboxDailyAllowance(mailbox.dailyLimit, mailbox.warmupEnabled, mailbox.elapsedDays),
    ),
  );
}

/** The day's ceiling for a campaign from this mailbox: the least of every limit in force. */
export function campaignDailyCeiling(
  mailbox: Parameters<typeof campaignDailyAllowance>[0],
  businessLimit: number | null,
  agencyLimit: number | null,
): number {
  return Math.min(
    campaignDailyAllowance(mailbox),
    businessLimit ?? mailbox.dailyLimit,
    agencyLimit ?? Number.POSITIVE_INFINITY,
  );
}

export interface ReleaseFacts {
  readonly now: Date;
  readonly startedAt: Date;
  readonly timeZone: string;
  readonly batches: CampaignBatches | null;
  readonly batchNumber: number;
  readonly batchReleased: number;
  readonly pending: number;
  readonly mailbox: CampaignMailboxFacts;
  /** The business's ceiling; null is the mailbox's own daily limit. */
  readonly businessLimit: number | null;
  readonly businessReleased: number;
  /** The install's ceiling for one agency; null is none. */
  readonly agencyLimit: number | null;
  readonly agencyReleased: number;
}

export interface ReleasePlan {
  readonly batchNumber: number;
  readonly batchReleased: number;
  /** How many emails may be released now. */
  readonly release: number;
  /** Why it is not more, when something other than the audience ran out. */
  readonly wait: { readonly reason: EmailCampaignWaitReason; readonly until: Date | null } | null;
}

/**
 * How many of a campaign's pending recipients may be released now. Each limit is asked in
 * turn and the first with no room is the reason given: the batch schedule and its window,
 * the mailbox's day and warm-up, the business's and the agency's ceilings, then pacing,
 * which keeps what is released to what the mailbox sends in a minute so the queue never
 * holds a backlog in front of a reply.
 */
export function planRelease(facts: ReleaseFacts): ReleasePlan {
  const { batches, mailbox, now } = facts;
  let batchNumber = Math.max(1, facts.batchNumber);
  let batchReleased = facts.batchNumber === 0 ? 0 : facts.batchReleased;
  const waiting = (reason: EmailCampaignWaitReason, until: Date | null): ReleasePlan => ({
    batchNumber,
    batchReleased,
    release: 0,
    wait: { reason, until },
  });
  let batchRoom = Number.POSITIVE_INFINITY;
  if (batches !== null) {
    if (batchReleased >= batches.size) {
      // The batch after number n is index n: the first is index 0, due at the start.
      const due = campaignBatchDueAt(facts.startedAt, batches, batchNumber, facts.timeZone);
      if (due.getTime() > now.getTime()) return waiting('batch_interval', due);
      batchNumber += 1;
      batchReleased = 0;
    }
    if (!campaignWindowOpen(now, batches.window, facts.timeZone))
      return waiting('window', campaignWindowOpensAt(now, batches.window, facts.timeZone));
    batchRoom = batches.size - batchReleased;
  }
  const reserve = mailbox.useForConversations
    ? Math.ceil(mailbox.dailyLimit * CAMPAIGN_CONVERSATION_RESERVE)
    : 0;
  const dayRoom = mailbox.dailyLimit - reserve - mailbox.recentAll - mailbox.inFlight;
  if (dayRoom <= 0)
    return waiting(
      'mailbox_daily_limit',
      mailbox.earliestReservationMs === null
        ? null
        : new Date(mailbox.earliestReservationMs + 86_400_000),
    );
  const warmRoom = mailbox.warmupEnabled
    ? mailboxDailyAllowance(mailbox.dailyLimit, true, mailbox.elapsedDays) -
      mailbox.recentAutomated -
      mailbox.inFlight
    : Number.POSITIVE_INFINITY;
  if (warmRoom <= 0) return waiting('mailbox_warmup_limit', null);
  const businessRoom = (facts.businessLimit ?? mailbox.dailyLimit) - facts.businessReleased;
  if (businessRoom <= 0) return waiting('business_daily_limit', null);
  const agencyRoom =
    facts.agencyLimit === null
      ? Number.POSITIVE_INFINITY
      : facts.agencyLimit - facts.agencyReleased;
  if (agencyRoom <= 0) return waiting('agency_daily_limit', null);
  const paceRoom = mailbox.pacingPerMinute - mailbox.inFlight;
  if (paceRoom <= 0) return waiting('mailbox_pacing', null);
  const room = Math.min(batchRoom, dayRoom, warmRoom, businessRoom, agencyRoom, paceRoom);
  return { batchNumber, batchReleased, release: Math.min(room, facts.pending), wait: null };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);

/**
 * Merge values as HTML takes them: each as the text a plain-text email would show,
 * escaped, so a contact's name can never become markup.
 */
export function htmlMergeValues(values: ConditionValues): ConditionValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === null || value === undefined
        ? value
        : escapeHtml(Array.isArray(value) ? value.join(', ') : String(value)),
    ]),
  );
}

const UNSUBSCRIBE_TOKEN = new RegExp(
  `\\{\\{\\s*${EMAIL_UNSUBSCRIBE_MERGE_FIELD.replace('.', '\\.')}\\s*\\}\\}`,
);

/** Whether this text places the unsubscribe link itself. */
export const hasUnsubscribeField = (text: string): boolean => UNSUBSCRIBE_TOKEN.test(text);

/**
 * Whether this HTML shows its own unsubscribe link where a reader can see it: a link hidden
 * by its styles, or with no words, is not one, and the standard line is added.
 */
export const showsUnsubscribeField = (html: string): boolean =>
  showsUnsubscribeLink(html, UNSUBSCRIBE_TOKEN);

// UNSUBSCRIBE_PLACEHOLDER, as a pattern.
const PLACEHOLDER_PATTERN = /https:\/\/unsubscribe\.invalid\/link/;

/** The same once the field was filled with the placeholder, as a queued email holds it. */
export const showsUnsubscribePlaceholder = (html: string): boolean =>
  showsUnsubscribeLink(html, PLACEHOLDER_PATTERN);

/**
 * A plain-text body that ends with the business's postal address, when given, and shows an
 * unsubscribe address: its own, or a line added at the end.
 */
export function textWithUnsubscribe(text: string, addressLine: string | null = null): string {
  const lines = [
    ...(addressLine === null ? [] : [addressLine]),
    ...(hasUnsubscribeField(text) ? [] : [`Unsubscribe: {{${EMAIL_UNSUBSCRIBE_MERGE_FIELD}}}`]),
  ];
  return lines.length === 0 ? text : `${text.trimEnd()}\n\n--\n${lines.join('\n')}\n`;
}

const UNSUBSCRIBE_LINK = `<a href="{{${EMAIL_UNSUBSCRIBE_MERGE_FIELD}}}">Unsubscribe</a>`;

/**
 * An HTML body that shows an unsubscribe link, with the preheader as the hidden first text
 * mail apps preview. Both go inside the body element when there is one.
 */
export function htmlWithUnsubscribe(
  html: string,
  preheader: string | null,
  addressLine: string | null = null,
): string {
  const hidden =
    preheader === null
      ? ''
      : `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(preheader)}</div>`;
  const opened = hidden === '' ? html : insertAfterBodyOpen(html, hidden);
  const lines = [
    ...(addressLine === null ? [] : [escapeHtml(addressLine)]),
    ...(showsUnsubscribeField(opened) ? [] : [UNSUBSCRIBE_LINK]),
  ];
  if (lines.length === 0) return opened;
  const footer = `<p style="font-size:12px;color:#666666">${lines.join('<br>')}</p>`;
  const close = opened.search(/<\/body\s*>/i);
  return close === -1
    ? `${opened}${footer}`
    : `${opened.slice(0, close)}${footer}${opened.slice(close)}`;
}

function insertAfterBodyOpen(html: string, addition: string): string {
  const open = /<body[^>]*>/i.exec(html);
  if (open === null) return `${addition}${html}`;
  const at = open.index + open[0].length;
  return `${html.slice(0, at)}${addition}${html.slice(at)}`;
}

/** The recipient's unsubscribe address put where the body was waiting for it. */
export function withUnsubscribeAddress(text: string, address: string): string {
  return text.replaceAll(UNSUBSCRIBE_PLACEHOLDER, address);
}
