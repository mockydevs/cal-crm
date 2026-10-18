// An email campaign as it is stored and as the API shows it. Everything that reads or
// writes messaging.email_campaigns starts from here.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  campaignBatches,
  emailCampaignAudience,
  emailCampaignMergeFields,
  emailCampaignStatuses,
  emailCampaignStatusReasons,
  emailCampaignWaitReasons,
  type CampaignBatches,
  type ConditionValues,
  type EmailCampaign,
  type EmailCampaignAudience,
  type EmailCampaignContent,
  type EmailCampaignStatus,
  type EmailCampaignSummary,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import type { FilterPeople } from '@repo/module-crm';
import { NotFoundError, parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { sql, type Selectable } from 'kysely';

import type { ReadTemplateFields } from './message-templates.js';

export type CampaignRow = Selectable<DB['messaging.email_campaigns']>;

/** What campaigns need of the modules that own contact values, the team and the install. */
export interface CampaignOptions {
  /** A contact's values by merge field, as any send reads them (automation's contactValues). */
  readonly values: (trx: DatabaseTransaction, contactId: string) => Promise<ConditionValues>;
  /** Every merge field a send can fill in. Left out, the checks cannot name unfillable ones. */
  readonly fields?: ReadTemplateFields | undefined;
  /** PUBLIC_URL: where unsubscribe and trigger links get their address. */
  readonly publicUrl?: string | undefined;
  /** Who is on the team, for an audience filtered by owner. */
  readonly people?: FilterPeople | undefined;
  /** People's sign-in addresses, for a test sent to "me". Left out, "me" is refused. */
  readonly team?:
    | ((
        trx: DatabaseTransaction,
        ids: readonly string[],
      ) => Promise<ReadonlyMap<string, { readonly email: string }>>)
    | undefined;
  /**
   * The install's ceiling for one agency's campaign emails in 24 hours, over all its
   * businesses (CAMPAIGN_AGENCY_DAILY_LIMIT). Left out, there is none.
   */
  readonly agencyDailyLimit?: number | undefined;
}

/** The one row of a query that always answers with one: a count over a table, the clock. */
export function only<Row>(rows: readonly Row[]): Row {
  const [row] = rows;
  if (row === undefined) throw new Error('A query that always answers gave no row.');
  return row;
}

/** The transaction's own time, which every interval in SQL is counted from. */
export async function databaseNow(trx: DatabaseTransaction): Promise<Date> {
  return only((await sql<{ now: Date }>`select now() as now`.execute(trx)).rows).now;
}

export const mayManageCampaigns = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('campaigns.manage');
export const maySendCampaigns = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('campaigns.send');

export const statusOf = (row: Pick<CampaignRow, 'status'>): EmailCampaignStatus =>
  emailCampaignStatuses.find((status) => status === row.status) ?? 'failed';

/** The batch plan a campaign was started with, or null when it is sent in one go. */
export function batchesOf(row: CampaignRow): CampaignBatches | null {
  if (row.batch_size === null) return null;
  return campaignBatches.parse({
    size: row.batch_size,
    every: row.batch_every,
    unit: row.batch_unit,
    window:
      row.window_from === null || row.window_to === null
        ? null
        : { from: row.window_from.slice(0, 5), to: row.window_to.slice(0, 5) },
  });
}

export function contentOf(row: CampaignRow): EmailCampaignContent {
  return row.body_html === null
    ? { format: 'text', text: row.body_text }
    : { format: 'html', html: row.body_html, text: row.body_text };
}

export function audienceOf(row: CampaignRow): EmailCampaignAudience | null {
  return row.audience === null ? null : emailCampaignAudience.parse(row.audience);
}

export async function businessTimeZone(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<string> {
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('timezone')
    .where('id', '=', requireBusiness(context))
    .executeTakeFirstOrThrow();
  return business.timezone;
}

function summaryOf(row: CampaignRow, timeZone: string): EmailCampaignSummary {
  const status = statusOf(row);
  const waitReason = emailCampaignWaitReasons.find((reason) => reason === row.wait_reason);
  return {
    id: toPublicId('email_campaign', row.id),
    name: row.name,
    folderId: row.folder_id === null ? null : toPublicId('email_campaign_folder', row.folder_id),
    status,
    statusReason: emailCampaignStatusReasons.find((reason) => reason === row.status_reason) ?? null,
    mailboxId: row.mailbox_id === null ? null : toPublicId('mailbox', row.mailbox_id),
    subject: row.subject,
    format: row.body_html === null ? 'text' : 'html',
    schedule:
      status === 'draft'
        ? null
        : { sendAt: row.send_at?.toISOString() ?? null, batches: batchesOf(row) },
    timeZone,
    counts: {
      audience: row.audience_count,
      pending: row.pending_count,
      queued: row.queued_count,
      sent: row.sent_count,
      skipped: row.skipped_count,
      failed: row.failed_count,
    },
    waiting:
      status === 'sending' && waitReason !== undefined
        ? { reason: waitReason, until: row.wait_until?.toISOString() ?? null }
        : null,
    audience: audienceOf(row),
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export async function presentCampaigns(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly CampaignRow[],
): Promise<EmailCampaignSummary[]> {
  const timeZone = await businessTimeZone(trx, invocation.context);
  return rows.map((row) => summaryOf(row, timeZone));
}

export async function presentCampaign(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: CampaignRow,
): Promise<EmailCampaign> {
  const content = contentOf(row);
  return {
    ...summaryOf(row, await businessTimeZone(trx, invocation.context)),
    fromName: row.from_name,
    replyTo: row.reply_to,
    preheader: row.preheader,
    content,
    templateId: row.template_id === null ? null : toPublicId('template', row.template_id),
    mergeFields: emailCampaignMergeFields({ subject: row.subject, content }),
    canManage: mayManageCampaigns(invocation),
    canSend: maySendCampaigns(invocation),
  };
}

/** The campaign a public id names, held for the transaction when `lock` is set. */
export async function requireCampaign(
  trx: DatabaseTransaction,
  context: TenantContext,
  id: string,
  lock = false,
): Promise<CampaignRow> {
  const uuid = parsePublicId('email_campaign', id);
  const row =
    uuid === undefined ? undefined : await findCampaign(trx, requireBusiness(context), uuid, lock);
  if (row === undefined) throw new NotFoundError('Email campaign', id);
  return row;
}

export async function findCampaign(
  trx: DatabaseTransaction,
  businessId: string,
  uuid: string,
  lock = false,
): Promise<CampaignRow | undefined> {
  let query = trx
    .selectFrom('messaging.email_campaigns')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('id', '=', uuid);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}
