// What stands in the way of sending a campaign, worked out with no model: the content, the
// audience, the mailbox and its setup checks, and how long the send will take under the
// limits in force. Sending and scheduling refuse while a blocking item is left.
import type { Invocation } from '@repo/commands';
import {
  campaignSpreadDays,
  EMAIL_CAMPAIGN_LIMITS,
  EMAIL_UNSUBSCRIBE_MERGE_FIELD,
  emailCampaignMergeFields,
  triggerLinkKeys,
  triggerLinkMergeKey,
  type EmailCampaignAudiencePreview,
  type EmailCampaignCheck,
  type EmailCampaignChecks,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';

import { readAudiencePreview } from './campaign-audience.js';
import {
  campaignDailyCeiling,
  hasUnsubscribeField,
  showsUnsubscribeField,
} from './campaign-rules.js';
import { audienceOf, contentOf, type CampaignOptions, type CampaignRow } from './campaign-store.js';
import { readPostalAddressLine } from './email-compose.js';

const SETUP_CHECKS = ['spf', 'dkim', 'dmarc', 'unsubscribe'] as const;
type SetupCheck = (typeof SETUP_CHECKS)[number];

const SETUP_WORDS: Readonly<Record<SetupCheck, string>> = {
  spf: 'SPF',
  dkim: 'DKIM',
  dmarc: 'DMARC',
  unsubscribe: 'one-click unsubscribe',
};

/** Whether one-click unsubscribe links can be made: only on a public HTTPS address. */
export function unsubscribeAvailable(publicUrl: string | undefined): boolean {
  if (publicUrl === undefined) return false;
  const origin = new URL(publicUrl);
  return origin.protocol === 'https:' && origin.username === '' && origin.password === '';
}

export interface CampaignMailbox {
  readonly id: string;
  readonly active: boolean;
  readonly use_for_campaigns: boolean;
  readonly use_for_conversations: boolean;
  readonly daily_limit: number;
  readonly pacing_per_minute: number;
  readonly warmup_enabled: boolean;
  readonly elapsed_days: number;
}

/** The campaign's mailbox with what sending from it depends on, or undefined when it is gone. */
export async function readCampaignMailbox(
  trx: DatabaseTransaction,
  mailboxId: string | null,
): Promise<CampaignMailbox | undefined> {
  if (mailboxId === null) return undefined;
  const {
    rows: [row],
  } = await sql<CampaignMailbox>`
    select mb.id, (a.status = 'active') as active, mb.use_for_campaigns, mb.use_for_conversations,
      mb.daily_limit, mb.pacing_per_minute, mb.warmup_enabled,
      (extract(epoch from (now() - coalesce(mb.warmup_started_at, mb.created_at))) / 86400)::float8 as elapsed_days
    from messaging.mailboxes mb
    join messaging.channel_accounts a on a.business_id = mb.business_id and a.id = mb.id
    where mb.id = ${mailboxId}::uuid
  `.execute(trx);
  return row;
}

/** The business's own ceiling on campaign emails in 24 hours; null is each mailbox's limit. */
export async function readBusinessCampaignLimit(trx: DatabaseTransaction): Promise<number | null> {
  const settings = await trx
    .selectFrom('messaging.settings')
    .select('campaign_daily_limit')
    .executeTakeFirst();
  return settings?.campaign_daily_limit ?? null;
}

/** The latest finished setup check's verdicts for a mailbox, by check; empty when none finished. */
async function setupVerdicts(
  trx: DatabaseTransaction,
  mailboxId: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  const run = await trx
    .selectFrom('messaging.mailbox_check_runs')
    .select('id')
    .where('mailbox_id', '=', mailboxId)
    .where('finished_at', 'is not', null)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (run === undefined) return undefined;
  const results = await trx
    .selectFrom('messaging.mailbox_check_results')
    .select(['check_key', 'status'])
    .where('run_id', '=', run.id)
    .execute();
  return new Map(results.map((result) => [result.check_key, result.status]));
}

async function mailboxItems(
  trx: DatabaseTransaction,
  mailbox: CampaignMailbox | undefined,
  chosen: boolean,
): Promise<EmailCampaignCheck[]> {
  if (mailbox === undefined)
    return [
      {
        code: 'mailbox_missing',
        severity: 'blocking',
        message: chosen
          ? 'The mailbox this campaign was to be sent from is gone. Choose another.'
          : 'Choose the mailbox to send from.',
      },
    ];
  const items: EmailCampaignCheck[] = [];
  if (!mailbox.active)
    items.push({
      code: 'mailbox_inactive',
      severity: 'blocking',
      message: 'This mailbox is paused or disconnected. Reconnect it in Settings, Email.',
    });
  if (!mailbox.use_for_campaigns)
    items.push({
      code: 'mailbox_not_for_campaigns',
      severity: 'blocking',
      message:
        'This mailbox is not switched on for campaigns. Turn on "Campaigns" under how it is used, in Settings, Email.',
    });
  const verdicts = await setupVerdicts(trx, mailbox.id);
  if (verdicts === undefined)
    return [
      ...items,
      {
        code: 'mailbox_not_checked',
        severity: 'blocking',
        message:
          "This mailbox's setup has not been checked yet. Run Check again in Settings, Email, then come back.",
      },
    ];
  for (const check of SETUP_CHECKS) {
    const status = verdicts.get(check);
    if (status === 'fail')
      items.push({
        code: 'mailbox_check_failing',
        severity: 'blocking',
        check,
        message: `The mailbox fails its ${SETUP_WORDS[check]} check. The fix is in Settings, Email.`,
      });
    else if (status !== 'pass' && status !== 'not_applicable')
      items.push({
        code: 'mailbox_check_unknown',
        severity: 'warning',
        check,
        message: `The ${SETUP_WORDS[check]} check could not be confirmed for this mailbox.`,
      });
  }
  return items;
}

async function contentItems(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaign: CampaignRow,
  options: CampaignOptions,
): Promise<EmailCampaignCheck[]> {
  const content = contentOf(campaign);
  const items: EmailCampaignCheck[] = [];
  if (campaign.subject.trim() === '')
    items.push({
      code: 'subject_missing',
      severity: 'blocking',
      message: 'Give the email a subject.',
    });
  else if (campaign.subject.length > EMAIL_CAMPAIGN_LIMITS.subjectAdvice)
    items.push({
      code: 'subject_long',
      severity: 'warning',
      count: campaign.subject.length,
      message: `The subject has ${String(campaign.subject.length)} characters. Mail apps cut long subjects short; ${String(EMAIL_CAMPAIGN_LIMITS.subjectAdvice)} or fewer is safer.`,
    });
  if (content.format === 'html' && content.html.trim() === '')
    items.push({ code: 'body_missing', severity: 'blocking', message: 'Write the email.' });
  if (content.text.trim() === '')
    items.push(
      content.format === 'html'
        ? {
            code: 'text_part_missing',
            severity: 'blocking',
            message: 'Add the plain-text version of the email, for mail apps that show no HTML.',
          }
        : { code: 'body_missing', severity: 'blocking', message: 'Write the email.' },
    );
  const used = emailCampaignMergeFields({ subject: campaign.subject, content });
  const links = new Set(triggerLinkKeys(used).map(triggerLinkMergeKey));
  if (options.fields !== undefined && used.length > 0) {
    const fillable = new Set(await options.fields(trx, invocation.context));
    const unfillable = used.filter(
      (field) =>
        field !== EMAIL_UNSUBSCRIBE_MERGE_FIELD && !fillable.has(field) && !links.has(field),
    );
    if (unfillable.length > 0)
      items.push({
        code: 'unfillable_merge_fields',
        severity: 'blocking',
        fields: unfillable,
        message: `No contact has a value for ${unfillable.join(', ')}, so nobody would get this email. Remove or correct these merge fields.`,
      });
  }
  if (content.format === 'html') {
    const bytes = Buffer.byteLength(content.html, 'utf8');
    if (bytes > EMAIL_CAMPAIGN_LIMITS.htmlClipAdvice)
      items.push({
        code: 'html_may_be_clipped',
        severity: 'warning',
        count: Math.ceil(bytes / 1024),
        message: `The email's HTML is ${String(Math.ceil(bytes / 1024))} KB. Gmail cuts messages off at about 102 KB, hiding the unsubscribe link and postal address at the end. Make it smaller.`,
      });
  }
  const placed =
    hasUnsubscribeField(content.text) &&
    (content.format === 'text' || showsUnsubscribeField(content.html));
  if (!placed)
    items.push({
      code: 'unsubscribe_line_added',
      severity: 'info',
      message: `The email has no {{${EMAIL_UNSUBSCRIBE_MERGE_FIELD}}} of its own, so a standard unsubscribe line is added at its end.`,
    });
  return items;
}

function audienceItems(preview: EmailCampaignAudiencePreview | 'missing' | 'unavailable') {
  const items: EmailCampaignCheck[] = [];
  if (preview === 'missing')
    return [
      { code: 'audience_missing', severity: 'blocking', message: 'Choose who to send to.' },
    ] satisfies EmailCampaignCheck[];
  if (preview === 'unavailable')
    return [
      {
        code: 'audience_unavailable',
        severity: 'blocking',
        message:
          'The audience names a smart list, tag or field that is gone or that you cannot open. Choose it again.',
      },
    ] satisfies EmailCampaignCheck[];
  if (preview.tooMany)
    items.push({
      code: 'audience_too_large',
      severity: 'blocking',
      count: EMAIL_CAMPAIGN_LIMITS.audience,
      message: `A campaign reaches at most ${String(EMAIL_CAMPAIGN_LIMITS.audience)} contacts. Narrow the audience or split it.`,
    });
  if (preview.willReceive === 0)
    items.push({
      code: 'audience_empty',
      severity: 'blocking',
      message:
        preview.total === 0
          ? 'Nobody matches this audience.'
          : 'Nobody in this audience can be sent the email. The audience step says why.',
    });
  else if (preview.willNot > 0)
    items.push({
      code: 'some_will_not_receive',
      severity: 'warning',
      count: preview.willNot,
      message: `${String(preview.willNot)} of ${String(preview.total)} contacts will not get it. The audience step says why.`,
    });
  return items;
}

/** The audience preview, or why there is none to count. */
async function previewOrProblem(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaign: CampaignRow,
  options: CampaignOptions,
): Promise<EmailCampaignAudiencePreview | 'missing' | 'unavailable'> {
  const audience = audienceOf(campaign);
  if (audience === null) return 'missing';
  try {
    return await readAudiencePreview(trx, invocation, campaign, audience, options);
  } catch (error) {
    // Refused before any statement ran: the list is gone, or the filter names a tag or a
    // field the business no longer has.
    if (!(error instanceof NotFoundError || error instanceof ValidationError)) throw error;
    return 'unavailable';
  }
}

export async function readCampaignChecks(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaign: CampaignRow,
  options: CampaignOptions,
): Promise<EmailCampaignChecks> {
  const mailbox = await readCampaignMailbox(trx, campaign.mailbox_id);
  const preview = await previewOrProblem(trx, invocation, campaign, options);
  const items: EmailCampaignCheck[] = [
    ...(await contentItems(trx, invocation, campaign, options)),
    ...audienceItems(preview),
    ...(await mailboxItems(trx, mailbox, campaign.mailbox_id !== null)),
  ];
  // US law asks every commercial email for the sender's "valid physical postal address" (15
  // U.S.C. 7704(a)(5)(A)(iii); 16 CFR 316.2(p): a street address, or a PO box or private
  // mailbox registered for mail). Every campaign email ends with the profile's
  // (smtp-outbound.ts), so a profile without one blocks the send.
  if ((await readPostalAddressLine(trx, invocation.context)) === null)
    items.push({
      code: 'postal_address_missing',
      severity: 'blocking',
      message:
        'Your business profile has no postal address. US law (CAN-SPAM) requires every marketing email to show a valid physical postal address: a street address, or a PO box or private mailbox registered for mail. Add it in Settings → Business profile; it is added to the end of every campaign email.',
    });
  if (!unsubscribeAvailable(options.publicUrl))
    items.push({
      code: 'unsubscribe_unavailable',
      severity: 'blocking',
      message:
        'This install has no public HTTPS address, so it cannot make unsubscribe links, and marketing email is refused without one. Set PUBLIC_URL to an https address.',
    });
  const dailyCeiling =
    mailbox === undefined
      ? null
      : campaignDailyCeiling(
          {
            dailyLimit: mailbox.daily_limit,
            warmupEnabled: mailbox.warmup_enabled,
            elapsedDays: mailbox.elapsed_days,
            useForConversations: mailbox.use_for_conversations,
          },
          await readBusinessCampaignLimit(trx),
          options.agencyDailyLimit ?? null,
        );
  if (dailyCeiling !== null && typeof preview === 'object') {
    const days = campaignSpreadDays(preview.willReceive, dailyCeiling, null);
    if (days > 1)
      items.push({
        code: 'spread_over_days',
        severity: 'warning',
        days,
        count: dailyCeiling,
        message: `At most ${String(dailyCeiling)} campaign emails can leave this mailbox in a day now, so this send will take about ${String(days)} days.`,
      });
  }
  return { canSend: items.every((item) => item.severity !== 'blocking'), dailyCeiling, items };
}
