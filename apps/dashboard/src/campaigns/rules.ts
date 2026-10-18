// What the email campaign screens work out before they draw (Marketing → Emails →
// Campaigns): a status and why a campaign waits, in words; who an audience is, as a
// sentence; every reason a contact gets nothing and every check, each in an owner's words
// with what to do about it; what a person may do with a campaign; the draft as its editor
// holds it and as the API takes it; a schedule chosen in the business's time zone; and when
// a send will finish. The vocabulary is the contract's own
// (packages/contracts/src/email-campaigns.ts): a reason or a check the contract gains and
// this file does not word fails the build and the unit test.
//
// Opens and clicks are not here: nothing measures them yet.
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import {
  campaignBatchDueAt,
  campaignSpreadDays,
  campaignWindowOpensAt,
  EMAIL_CAMPAIGN_LIMITS,
  emailCampaignActions,
  instantOfLocal,
  localTimeOf,
  type CampaignBatches,
  type CampaignBatchUnit,
  type EmailCampaignAudience,
  type EmailCampaignCheck,
  type EmailCampaignCheckCode,
  type EmailCampaignCounts,
  type EmailCampaignRecipientStatus,
  type EmailCampaignSkipReason,
  type EmailCampaignStatus,
  type EmailCampaignStatusReason,
  type EmailCampaignSummary,
  type EmailCampaignWaitReason,
} from '@repo/contracts';

// Status ------------------------------------------------------------------------------------

export const statusWords: Readonly<Record<EmailCampaignStatus, MessageDescriptor>> = {
  draft: msg`Draft`,
  scheduled: msg`Scheduled`,
  sending: msg`Sending`,
  paused: msg`Paused`,
  sent: msg`Sent`,
  cancelled: msg`Cancelled`,
  failed: msg`Failed`,
};

export type Tone = 'neutral' | 'good' | 'active' | 'warning' | 'bad';

export const statusTones: Readonly<Record<EmailCampaignStatus, Tone>> = {
  draft: 'neutral',
  scheduled: 'active',
  sending: 'active',
  paused: 'warning',
  sent: 'good',
  cancelled: 'neutral',
  failed: 'bad',
};

/** The statuses the list filters by, in GoHighLevel's order; "all" is no filter. */
export const statusFilters = [
  'all',
  'draft',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'cancelled',
  'failed',
] as const;
export type StatusFilter = (typeof statusFilters)[number];

export const statusFilterWords: Readonly<Record<StatusFilter, MessageDescriptor>> = {
  all: msg`All`,
  draft: msg`Drafts`,
  scheduled: msg`Scheduled`,
  sending: msg`Sending`,
  paused: msg`Paused`,
  sent: msg`Sent`,
  cancelled: msg`Cancelled`,
  failed: msg`Failed`,
};

interface ReasonWords {
  /** What happened. */
  readonly what: MessageDescriptor;
  /** What to do about it. */
  readonly todo: MessageDescriptor;
}

/** Why a campaign paused itself or failed, and what to do. */
export const statusReasonWords: Readonly<Record<EmailCampaignStatusReason, ReasonWords>> = {
  bounce_rate: {
    what: msg`It paused itself: too many of its emails bounced.`,
    todo: msg`Look at the recipients that bounced and correct or remove those addresses. Then resume it, or cancel it.`,
  },
  audience_unavailable: {
    what: msg`The smart list, tag or field its audience names is gone.`,
    todo: msg`Duplicate it as a new draft and choose the audience again.`,
  },
  audience_too_large: {
    what: msg`More contacts matched its audience than one campaign can reach.`,
    todo: msg`Duplicate it as a new draft and narrow the audience, or split it in two.`,
  },
  audience_empty: {
    what: msg`Nobody in its audience could be sent the email.`,
    todo: msg`Duplicate it as a new draft and look at the audience preview: it says why each contact gets nothing.`,
  },
  mailbox_unavailable: {
    what: msg`It paused itself: its mailbox is gone, paused or no longer switched on for campaigns.`,
    todo: msg`Put the mailbox right in Settings → Email Services, then resume it.`,
  },
};

/** The line under a status: why it is paused or failed, or nothing to say. */
export function statusLine(
  campaign: Pick<EmailCampaignSummary, 'status' | 'statusReason'>,
): string | undefined {
  if (campaign.statusReason !== null) return i18n._(statusReasonWords[campaign.statusReason].what);
  if (campaign.status === 'paused') return t`Paused by a person.`;
  if (campaign.status === 'failed') return t`It could not be sent.`;
  return undefined;
}

// Waiting -----------------------------------------------------------------------------------

/** Why a send is waiting, with the time it goes on when the server knows it. */
const waitWords: Readonly<Record<EmailCampaignWaitReason, (when: string | null) => string>> = {
  batch_interval: (when) =>
    when === null
      ? t`Waiting for the next batch.`
      : t`Waiting until ${when}, when the next batch is due.`,
  window: (when) =>
    when === null
      ? t`Waiting: the sending window is closed.`
      : t`Waiting until ${when}, when the sending window opens.`,
  mailbox_daily_limit: (when) =>
    when === null
      ? t`Waiting because the mailbox's daily limit is reached.`
      : t`Waiting until ${when} because the mailbox's daily limit is reached.`,
  mailbox_warmup_limit: (when) =>
    when === null
      ? t`Waiting because the mailbox's warm-up allowance for today is used.`
      : t`Waiting until ${when} because the mailbox's warm-up allowance for today is used.`,
  business_daily_limit: (when) =>
    when === null
      ? t`Waiting because the business's daily campaign limit is reached.`
      : t`Waiting until ${when} because the business's daily campaign limit is reached.`,
  agency_daily_limit: (when) =>
    when === null
      ? t`Waiting because the agency's daily campaign limit is reached.`
      : t`Waiting until ${when} because the agency's daily campaign limit is reached.`,
  mailbox_pacing: (when) =>
    when === null
      ? t`Sending at the mailbox's pace: a few emails a minute.`
      : t`Sending at the mailbox's pace: the next emails leave at ${when}.`,
};

/** A moment in the business's time zone: "Oct 14, 2026, 9:00 AM". */
export function momentIn(instant: string | Date, timeZone: string, locale = i18n.locale): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    // A time zone this browser does not know: the moment in the browser's own.
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      date,
    );
  }
}

export function waitingLine(
  campaign: Pick<EmailCampaignSummary, 'waiting' | 'timeZone' | 'status'>,
): string | undefined {
  if (campaign.waiting === null || campaign.status !== 'sending') return undefined;
  const { reason, until } = campaign.waiting;
  return waitWords[reason](until === null ? null : momentIn(until, campaign.timeZone));
}

// Audience ----------------------------------------------------------------------------------

export interface AudienceNames {
  /** The business's smart lists by id; undefined while they are not read. */
  readonly views: ReadonlyMap<string, string> | undefined;
  readonly tags: ReadonlyMap<string, string> | undefined;
}

/** Who a campaign is for, in words. */
export function audienceSentence(
  audience: EmailCampaignAudience | null,
  names: AudienceNames,
): string {
  if (audience === null) return t`No audience chosen`;
  switch (audience.kind) {
    case 'all':
      return t`Every contact`;
    case 'smart_list': {
      if (names.views === undefined) return t`A smart list`;
      const name = names.views.get(audience.viewId);
      return name === undefined ? t`A smart list that is gone` : t`Smart list: ${name}`;
    }
    case 'tags': {
      const known = names.tags;
      if (known === undefined)
        return plural(audience.tagIds.length, {
          one: 'Contacts with # tag',
          other: 'Contacts with # tags',
        });
      const list = audience.tagIds.map((id) => known.get(id) ?? t`a tag that is gone`).join(', ');
      if (audience.tagIds.length === 1) return t`Contacts tagged ${list}`;
      return audience.match === 'all'
        ? t`Contacts with all of these tags: ${list}`
        : t`Contacts with any of these tags: ${list}`;
    }
    case 'filter': {
      const conditions = audience.filter.groups.reduce(
        (sum, group) => sum + group.conditions.length,
        0,
      );
      return plural(conditions, {
        one: 'Contacts matching a filter with # condition',
        other: 'Contacts matching a filter with # conditions',
      });
    }
  }
}

// Why a contact gets nothing ----------------------------------------------------------------

interface SkipWords {
  /** A few words, for a row and a filter. */
  readonly label: MessageDescriptor;
  /** What it means and what to do about it, in a sentence or two. */
  readonly todo: MessageDescriptor;
}

export const skipReasonWords: Readonly<Record<EmailCampaignSkipReason, SkipWords>> = {
  no_email: {
    label: msg`No email address`,
    todo: msg`The contact has no email address. Add one on the contact.`,
  },
  do_not_contact: {
    label: msg`Do not contact`,
    todo: msg`The contact is marked do not contact, for every channel or for email. Change it on the contact only if they asked to hear from you.`,
  },
  unsubscribed: {
    label: msg`Unsubscribed`,
    todo: msg`They unsubscribed from marketing email. Only they can sign up again.`,
  },
  bounced: {
    label: msg`Bounced before`,
    todo: msg`An earlier email to this address bounced. Correct the address on the contact.`,
  },
  complained: {
    label: msg`Reported spam`,
    todo: msg`They reported an earlier email as spam. They are not emailed again.`,
  },
  suppressed: {
    label: msg`Suppressed`,
    todo: msg`The address is on this business's list of addresses not to email.`,
  },
  no_consent: {
    label: msg`No marketing consent`,
    todo: msg`No consent to marketing email is recorded. Record it on the contact once they agree, or collect it with a form's consent box.`,
  },
  no_time_zone: {
    label: msg`No time zone`,
    todo: msg`Quiet hours need the contact's time zone, and none is set. Set it on the contact.`,
  },
  contact_removed: {
    label: msg`Contact removed`,
    todo: msg`The contact was deleted or merged after the audience was fixed.`,
  },
  missing_merge_values: {
    label: msg`Missing a merge value`,
    todo: msg`The contact has no value for a field the email uses, so nothing was sent rather than an email with a gap. Fill the field in on the contact.`,
  },
  mailbox_unavailable: {
    label: msg`Mailbox unavailable`,
    todo: msg`The mailbox was paused, disconnected or switched off for campaigns when this email was due.`,
  },
  unsubscribe_unavailable: {
    label: msg`No unsubscribe link`,
    todo: msg`An unsubscribe link could not be made, and marketing email never leaves without one.`,
  },
  cancelled: {
    label: msg`Cancelled first`,
    todo: msg`The campaign was cancelled before this email left.`,
  },
  refused: {
    label: msg`Refused by the sending rules`,
    todo: msg`The sending rules refused this email as it was about to leave.`,
  },
};

export const recipientStatusWords: Readonly<
  Record<EmailCampaignRecipientStatus, MessageDescriptor>
> = {
  pending: msg`Not released yet`,
  queued: msg`Queued`,
  sent: msg`Sent`,
  skipped: msg`Skipped`,
  failed: msg`Failed`,
};

// Checks ------------------------------------------------------------------------------------

/** Where a check is put right: a section of the editor, or a page of Settings. */
export type CheckPlace = 'details' | 'content' | 'audience' | 'email-settings' | 'business-profile';

/** A setup check by the name Settings → Email Services lists it under. */
function setupCheckName(check: EmailCampaignCheck['check']): string {
  if (check === undefined) return '';
  if (check === 'unsubscribe') return t`Unsubscribe`;
  // The three are the standards' own names, the same in every language.
  return { spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' }[check];
}

interface CheckWords {
  readonly say: (check: EmailCampaignCheck) => string;
  readonly place?: CheckPlace;
}

const numberOf = (value: number | undefined): string => (value ?? 0).toLocaleString(i18n.locale);

export const checkWords: Readonly<Record<EmailCampaignCheckCode, CheckWords>> = {
  subject_missing: { say: () => t`Give the email a subject.`, place: 'details' },
  body_missing: { say: () => t`Write the email.`, place: 'content' },
  text_part_missing: {
    say: () => t`Add the plain-text part of the email, for mail apps that show no formatting.`,
    place: 'content',
  },
  audience_missing: { say: () => t`Choose who to send to.`, place: 'audience' },
  audience_unavailable: {
    say: () =>
      t`The audience names a smart list, tag or field that is gone or that you cannot open. Choose it again.`,
    place: 'audience',
  },
  audience_empty: {
    say: () => t`Nobody in this audience can be sent the email. The audience preview says why.`,
    place: 'audience',
  },
  audience_too_large: {
    say: (check) => {
      const limit = numberOf(check.count ?? EMAIL_CAMPAIGN_LIMITS.audience);
      return t`A campaign reaches at most ${limit} contacts. Narrow the audience, or split it in two.`;
    },
    place: 'audience',
  },
  mailbox_missing: { say: () => t`Choose the mailbox to send from.`, place: 'details' },
  mailbox_inactive: {
    say: () =>
      t`This mailbox is paused or disconnected. Reconnect it in Settings → Email Services.`,
    place: 'email-settings',
  },
  mailbox_not_for_campaigns: {
    say: () =>
      t`This mailbox is not switched on for campaigns. Tick “Use for campaigns” for it in Settings → Email Services.`,
    place: 'email-settings',
  },
  mailbox_not_checked: {
    say: () =>
      t`This mailbox's setup has not been checked yet. Check it in Settings → Email Services, then come back.`,
    place: 'email-settings',
  },
  mailbox_check_failing: {
    say: (check) => {
      const name = setupCheckName(check.check);
      return name === ''
        ? t`The mailbox fails one of its setup checks. The fix is in Settings → Email Services.`
        : t`The mailbox fails its ${name} check. The fix is in Settings → Email Services.`;
    },
    place: 'email-settings',
  },
  mailbox_check_unknown: {
    say: (check) => {
      const name = setupCheckName(check.check);
      return name === ''
        ? t`One of the mailbox's setup checks could not be confirmed.`
        : t`The ${name} check could not be confirmed for this mailbox.`;
    },
    place: 'email-settings',
  },
  unsubscribe_unavailable: {
    say: () =>
      t`This install has no public HTTPS address, so it cannot make unsubscribe links, and marketing email never leaves without one. Whoever runs the server sets its public address.`,
  },
  unfillable_merge_fields: {
    say: (check) => {
      const fields = (check.fields ?? []).map((field) => `{{${field}}}`).join(', ');
      return fields === ''
        ? t`The email uses a merge field no contact has a value for, so nobody would get it. Remove or correct it.`
        : t`No contact has a value for ${fields}, so nobody would get this email. Remove or correct these merge fields.`;
    },
    place: 'content',
  },
  unsubscribe_line_added: {
    say: () =>
      t`The email has no unsubscribe link of its own, so a standard unsubscribe line is added at its end.`,
  },
  postal_address_missing: {
    say: () =>
      t`Your business profile has no postal address. US law (CAN-SPAM) requires every marketing email to show a valid physical postal address: a street address, or a PO box or private mailbox registered for mail. Add it in the Business Profile; it is added to the end of every campaign email.`,
    place: 'business-profile',
  },
  html_may_be_clipped: {
    say: (check) => {
      const size = numberOf(check.count);
      return t`The email's HTML is ${size} KB. Gmail cuts messages off at about 102 KB, hiding the unsubscribe link and postal address at the end. Make it smaller.`;
    },
    place: 'content',
  },
  subject_long: {
    say: (check) => {
      const length = numberOf(check.count);
      const advice = EMAIL_CAMPAIGN_LIMITS.subjectAdvice;
      return t`The subject has ${length} characters. Mail apps cut long subjects short: ${advice} or fewer is safer.`;
    },
    place: 'details',
  },
  spread_over_days: {
    say: (check) => {
      const perDay = numberOf(check.count);
      const days = check.days ?? 2;
      return t`At most ${perDay} campaign emails can leave this mailbox in a day now, so this send will take about ${days} days.`;
    },
  },
  some_will_not_receive: {
    say: (check) =>
      plural(check.count ?? 0, {
        one: '# contact in the audience will not get it. The audience preview says why.',
        other: '# contacts in the audience will not get it. The audience preview says why.',
      }),
    place: 'audience',
  },
};

const severityOrder = { blocking: 0, warning: 1, info: 2 } as const;

/** Blocking items first, then warnings, then notes; the server's order inside each. */
export function sortedChecks(items: readonly EmailCampaignCheck[]): EmailCampaignCheck[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        severityOrder[left.item.severity] - severityOrder[right.item.severity] ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

/** A check in the dashboard's words: a code this build does not know keeps the server's. */
export function checkSentence(check: EmailCampaignCheck): string {
  const words = (checkWords as Readonly<Record<string, CheckWords | undefined>>)[check.code];
  return words === undefined ? check.message : words.say(check);
}

export function checkPlace(check: EmailCampaignCheck): CheckPlace | undefined {
  return (checkWords as Readonly<Record<string, CheckWords | undefined>>)[check.code]?.place;
}

// What a person may do ----------------------------------------------------------------------

export type CampaignAction = (typeof emailCampaignActions)[EmailCampaignStatus][number];

export interface Permissions {
  readonly canManage: boolean;
  readonly canSend: boolean;
}

const sendingActions: readonly CampaignAction[] = ['send', 'schedule', 'pause', 'resume', 'cancel'];

/** Whether the status offers the action and the person's role allows it. */
export function allowed(
  status: EmailCampaignStatus,
  action: CampaignAction,
  permissions: Permissions,
): boolean {
  if (!emailCampaignActions[status].includes(action)) return false;
  return sendingActions.includes(action) ? permissions.canSend : permissions.canManage;
}

export type RowAction =
  'open' | 'edit' | 'duplicate' | 'move' | 'pause' | 'resume' | 'delete' | 'cancel';

/**
 * A row's menu: everyone opens (a draft someone may change is edited); the rest is by status
 * and role, as the server allows it: delete a draft, pause a send, resume a paused one,
 * cancel what has not finished.
 */
export function rowActions(status: EmailCampaignStatus, permissions: Permissions): RowAction[] {
  return [
    allowed(status, 'edit', permissions) ? 'edit' : 'open',
    ...(permissions.canManage ? (['duplicate', 'move'] as const) : []),
    ...(allowed(status, 'pause', permissions) ? (['pause'] as const) : []),
    ...(allowed(status, 'resume', permissions) ? (['resume'] as const) : []),
    ...(allowed(status, 'delete', permissions) ? (['delete'] as const) : []),
    ...(allowed(status, 'cancel', permissions) ? (['cancel'] as const) : []),
  ];
}

/** What cancelling does, which depends on whether sending started. */
export function cancelConsequence(status: EmailCampaignStatus): string {
  return status === 'scheduled'
    ? t`It has not started, so it becomes a draft again. Nobody is sent anything.`
    : t`It stops for good and cannot be resumed. Everyone who has not been sent it yet is skipped; emails that already left stay sent.`;
}

/** The moment a list row shows: when it is due, when it started, or when it finished. */
export function rowMoment(
  campaign: Pick<EmailCampaignSummary, 'status' | 'schedule' | 'startedAt' | 'finishedAt'>,
): { readonly kind: 'due' | 'started' | 'finished'; readonly at: string } | undefined {
  const sendAt = campaign.schedule?.sendAt ?? null;
  if (campaign.status === 'scheduled' && sendAt !== null) return { kind: 'due', at: sendAt };
  if (campaign.finishedAt !== null) return { kind: 'finished', at: campaign.finishedAt };
  if (campaign.startedAt !== null) return { kind: 'started', at: campaign.startedAt };
  return undefined;
}

/** How far a send is: everyone it is finished with, of the audience. */
export function progressOf(counts: EmailCampaignCounts): {
  readonly done: number;
  readonly percent: number;
} {
  const done = counts.sent + counts.skipped + counts.failed;
  const percent = counts.audience === 0 ? 0 : Math.round((done / counts.audience) * 100);
  return { done, percent: Math.min(100, percent) };
}

// As `z.email()` reads one, near enough to say so before the server does.
const address = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>().]{2,}$/;
export const looksLikeEmail = (text: string): boolean => address.test(text.trim());

// Tests -------------------------------------------------------------------------------------

export interface TestRecipients {
  /** "me" for the person's own sign-in address, and the other addresses. */
  readonly to: string[];
  readonly problem?: string;
}

/** Where a test goes: "me" and the other addresses typed, split at commas, spaces and lines. */
export function testRecipients(me: boolean, typed: string, mayNameOthers: boolean): TestRecipients {
  const others = [
    ...new Set(
      typed
        .split(/[\s,;]+/)
        .map((each) => each.trim())
        .filter((each) => each !== ''),
    ),
  ];
  const to = [...(me ? ['me'] : []), ...others];
  if (others.length > 0 && !mayNameOthers)
    return { to, problem: t`Your role can send a test to yourself only.` };
  const wrong = others.find((each) => !looksLikeEmail(each));
  if (wrong !== undefined) return { to, problem: t`“${wrong}” is not an email address.` };
  if (to.length === 0) return { to, problem: t`Choose where the test goes.` };
  const limit = EMAIL_CAMPAIGN_LIMITS.testAddresses;
  if (to.length > limit) return { to, problem: t`A test goes to at most ${limit} addresses.` };
  return { to };
}

// Scheduling --------------------------------------------------------------------------------

const two = (value: number): string => String(value).padStart(2, '0');

/** An instant as a date-and-time box holds it, on the business's clock: 2026-10-14T09:00. */
export function inputOfInstant(instant: Date, timeZone: string): string {
  const local = localTimeOf(instant, timeZone);
  return `${String(local.year).padStart(4, '0')}-${two(local.month)}-${two(local.day)}T${two(local.hour)}:${two(local.minute)}`;
}

/** The instant a date-and-time box names on the business's clock, or undefined if it names none. */
export function instantOfInput(value: string, timeZone: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  )
    return undefined;
  return instantOfLocal({ year, month, day, hour, minute, second: 0 }, timeZone);
}

const YEAR_MS = 365 * 86_400_000;

/** Why a chosen start cannot be scheduled, or nothing when it can. */
export function scheduleProblem(sendAt: Date | undefined, now: Date): string | undefined {
  if (sendAt === undefined) return t`Choose a date and a time.`;
  if (sendAt.getTime() <= now.getTime()) return t`Choose a time that is still ahead.`;
  if (sendAt.getTime() > now.getTime() + YEAR_MS) return t`Choose a time within a year.`;
  return undefined;
}

/** Batches as the dialog's boxes hold them. */
export interface BatchesForm {
  readonly size: string;
  readonly every: string;
  readonly unit: CampaignBatchUnit;
  readonly windowed: boolean;
  readonly from: string;
  readonly to: string;
}

export const startingBatches: BatchesForm = {
  size: '500',
  every: '1',
  unit: 'days',
  windowed: false,
  from: '09:00',
  to: '17:00',
};

export type BatchesField = 'size' | 'every' | 'window';

const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
const wholeNumber = (text: string): number | undefined =>
  /^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : undefined;

/** The batches as the API takes them, or what is wrong with each box. */
export function batchesOf(
  form: BatchesForm,
):
  | { readonly batches: CampaignBatches; readonly problems?: undefined }
  | { readonly batches?: undefined; readonly problems: Partial<Record<BatchesField, string>> } {
  const problems: Partial<Record<BatchesField, string>> = {};
  const size = wholeNumber(form.size);
  const every = wholeNumber(form.every);
  const most = EMAIL_CAMPAIGN_LIMITS.audience.toLocaleString(i18n.locale);
  if (size === undefined || size < 1 || size > EMAIL_CAMPAIGN_LIMITS.audience)
    problems.size = t`Give a whole number of emails, from 1 to ${most}.`;
  if (every === undefined || every < 1) problems.every = t`Give a whole number, 1 or more.`;
  else if (form.unit === 'minutes' && every < 5)
    problems.every = t`Leave at least 5 minutes between batches.`;
  else if (form.unit === 'minutes' && every > 1440)
    problems.every = t`Leave at most 1,440 minutes between batches, or count in hours.`;
  else if (form.unit === 'hours' && every > 720)
    problems.every = t`Leave at most 720 hours between batches.`;
  else if (form.unit === 'days' && every > 30)
    problems.every = t`Leave at most 30 days between batches.`;
  if (form.windowed) {
    if (!clock.test(form.from) || !clock.test(form.to))
      problems.window = t`Give both ends of the window as times of day.`;
    else if (form.from === form.to)
      problems.window = t`The window must open and close at different times.`;
  }
  if (Object.keys(problems).length > 0 || size === undefined || every === undefined)
    return { problems };
  return {
    batches: {
      size,
      every,
      unit: form.unit,
      window: form.windowed ? { from: form.from, to: form.to } : null,
    },
  };
}

export interface SendEstimate {
  /** Emails that will leave: the audience preview's "will receive". */
  readonly emails: number;
  /** The most the mailbox may release in a day now; null when the server gave none. */
  readonly perDay: number | null;
  /** Days from the start to the last email, 1 when it fits in a day. */
  readonly days: number;
  /** How many batches, when it is sent in batches. */
  readonly batches: number | null;
  /** When the last batch may start leaving. */
  readonly lastBatchAt: Date | null;
}

/** When a send will finish, by the arithmetic the server releases batches with. */
export function sendEstimate(input: {
  readonly emails: number;
  readonly dailyCeiling: number | null;
  readonly batches: CampaignBatches | null;
  readonly startAt: Date;
  readonly timeZone: string;
}): SendEstimate {
  const { emails, dailyCeiling, batches, startAt, timeZone } = input;
  // With no ceiling known, only the batches' own pace is counted.
  const days = campaignSpreadDays(emails, dailyCeiling ?? Math.max(1, emails), batches);
  if (batches === null || emails <= 0)
    return { emails, perDay: dailyCeiling, days, batches: null, lastBatchAt: null };
  const count = Math.ceil(emails / batches.size);
  const due = campaignBatchDueAt(startAt, batches, count - 1, timeZone);
  return {
    emails,
    perDay: dailyCeiling,
    days,
    batches: count,
    lastBatchAt: campaignWindowOpensAt(due, batches.window, timeZone),
  };
}

const unitWords = (every: number, unit: CampaignBatchUnit): string =>
  unit === 'minutes'
    ? plural(every, { one: 'every minute', other: 'every # minutes' })
    : unit === 'hours'
      ? plural(every, { one: 'every hour', other: 'every # hours' })
      : plural(every, { one: 'every day', other: 'every # days' });

/** Batches as a phrase: "500 emails every day, between 09:00 and 17:00". */
export function batchesSentence(batches: CampaignBatches): string {
  const size = batches.size.toLocaleString(i18n.locale);
  const pace = unitWords(batches.every, batches.unit);
  if (batches.window === null) return t`${size} emails ${pace}`;
  const { from, to } = batches.window;
  return t`${size} emails ${pace}, between ${from} and ${to}`;
}

/**
 * The estimate as the sentence shown before confirming: "About 3 days: at most 500 a day
 * from Calari mailbox."
 */
export function estimateSentence(
  estimate: SendEstimate,
  mailbox: string | undefined,
  timeZone: string,
): string {
  if (estimate.emails <= 0) return t`Nobody in the audience can be sent it as things stand.`;
  const from = mailbox ?? t`the chosen mailbox`;
  const perDay = estimate.perDay?.toLocaleString(i18n.locale);
  const days = estimate.days;
  const length =
    perDay === undefined
      ? plural(days, { one: 'About a day.', other: 'About # days.' })
      : days <= 1
        ? t`About a day: ${from} can release up to ${perDay} campaign emails a day now.`
        : t`About ${days} days: at most ${perDay} a day from ${from}.`;
  if (estimate.batches === null || estimate.lastBatchAt === null) return length;
  const last = momentIn(estimate.lastBatchAt, timeZone);
  const batches = plural(estimate.batches, {
    one: 'One batch.',
    other: `# batches; the last may start ${last}.`,
  });
  return `${batches} ${length}`;
}

// Folders -----------------------------------------------------------------------------------

interface FolderLike {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
}

/** Each folder with the path that leads to it: "Newsletters / 2026". */
export function folderLabels(folders: readonly FolderLike[]): ReadonlyMap<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const labels = new Map<string, string>();
  for (const folder of folders) {
    const names: string[] = [];
    const visited = new Set<string>();
    let current: FolderLike | undefined = folder;
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      names.unshift(current.name);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    labels.set(folder.id, names.join(' / '));
  }
  return labels;
}

/** Where a folder may be moved: anywhere but into itself or a folder inside it. */
export function folderDestinations<Folder extends FolderLike>(
  folders: readonly Folder[],
  movingId?: string,
): readonly Folder[] {
  if (movingId === undefined) return folders;
  const excluded = new Set<string>([movingId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders)
      if (folder.parentId !== null && excluded.has(folder.parentId) && !excluded.has(folder.id)) {
        excluded.add(folder.id);
        grew = true;
      }
  }
  return folders.filter((folder) => !excluded.has(folder.id));
}
