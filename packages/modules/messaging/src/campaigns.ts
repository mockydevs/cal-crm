// Email campaigns: the drafts people write and the commands that start, hold and stop a
// send. Nothing here sends an email: starting a campaign hands it to the campaign task
// (campaign-run.ts), which releases its recipients to the outbound pipeline.
//
// The audit log keeps names, ids and lengths, never a subject's or a body's words.
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  createEmailCampaignInput,
  emailCampaignMailbox,
  emailCampaignRevisionInput,
  emailCampaignSettingsInput,
  moveEmailCampaignInput,
  publicId,
  scheduleEmailCampaignInput,
  sendEmailCampaignInput,
  updateEmailCampaignInput,
  type CampaignBatches,
  type EmailCampaign,
  type EmailCampaignList,
  type EmailCampaignMailboxList,
  type EmailCampaignSettings,
  type listEmailCampaigns,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { readCampaignChecks, readBusinessCampaignLimit } from './campaign-checks.js';
import { CAMPAIGN_BOUNCE_PAUSE, campaignAllows, type CampaignAction } from './campaign-rules.js';
import {
  databaseNow,
  mayManageCampaigns,
  maySendCampaigns,
  presentCampaign,
  presentCampaigns,
  requireCampaign,
  statusOf,
  type CampaignOptions,
  type CampaignRow,
} from './campaign-store.js';

const idInput = z.strictObject({ id: publicId('email_campaign') });
const updateInput = updateEmailCampaignInput.safeExtend({ id: publicId('email_campaign') });
const revisionInput = emailCampaignRevisionInput.extend({ id: publicId('email_campaign') });
const moveInput = moveEmailCampaignInput.extend({ id: publicId('email_campaign') });
const sendInput = sendEmailCampaignInput.safeExtend({ id: publicId('email_campaign') });
const scheduleInput = scheduleEmailCampaignInput.safeExtend({ id: publicId('email_campaign') });

/** The furthest ahead a campaign may be scheduled. */
const SCHEDULE_HORIZON_MS = 366 * 86_400_000;

const invalid = (path: string, code: string, message: string) =>
  new ValidationError([{ path, code, message }]);

function requireAction(row: CampaignRow, action: CampaignAction): void {
  if (!campaignAllows(statusOf(row), action))
    throw new ConflictError(
      action === 'edit' || action === 'delete'
        ? 'Only a draft can be changed or deleted. This campaign was already sent or scheduled.'
        : `A campaign that is ${row.status} cannot ${action === 'send' || action === 'schedule' ? 'be sent' : action}.`,
    );
}

function requireRevision(row: CampaignRow, revision: number): void {
  if (row.revision !== revision)
    throw new ConflictError(
      'This campaign changed after you opened it. Read it again before saving or sending it.',
    );
}

/** The folder a public id names, which must be a folder of campaigns. */
async function folderOf(trx: DatabaseTransaction, folderId: string | null): Promise<string | null> {
  if (folderId === null) return null;
  const uuid = parsePublicId('email_campaign_folder', folderId);
  const folder =
    uuid === undefined
      ? undefined
      : await trx
          .selectFrom('messaging.template_folders')
          .select('id')
          .where('id', '=', uuid)
          .where('kind', '=', 'campaign')
          .executeTakeFirst();
  if (folder === undefined)
    throw invalid('/folderId', 'unknown_folder', 'Choose a folder of campaigns.');
  return folder.id;
}

async function mailboxOf(
  trx: DatabaseTransaction,
  mailboxId: string | null,
): Promise<string | null> {
  if (mailboxId === null) return null;
  const uuid = parsePublicId('mailbox', mailboxId);
  const mailbox =
    uuid === undefined
      ? undefined
      : await trx
          .selectFrom('messaging.mailboxes')
          .select('id')
          .where('id', '=', uuid)
          .executeTakeFirst();
  if (mailbox === undefined)
    throw invalid('/mailboxId', 'unknown_mailbox', 'Choose a mailbox of this business.');
  return mailbox.id;
}

const batchColumns = (batches: CampaignBatches | null) => ({
  batch_size: batches?.size ?? null,
  batch_every: batches?.every ?? null,
  batch_unit: batches?.unit ?? null,
  window_from: batches?.window?.from ?? null,
  window_to: batches?.window?.to ?? null,
});

export async function readCampaigns(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listEmailCampaigns.query>,
): Promise<EmailCampaignList> {
  let selection = trx
    .selectFrom('messaging.email_campaigns')
    .selectAll()
    .where('business_id', '=', requireBusiness(invocation.context));
  if (query.status !== undefined) selection = selection.where('status', '=', query.status);
  if (query.folder === 'root') selection = selection.where('folder_id', 'is', null);
  else if (query.folder !== undefined)
    selection = selection.where(
      'folder_id',
      '=',
      parsePublicId('email_campaign_folder', query.folder) ?? '',
    );
  if (query.q !== undefined && query.q !== '')
    selection = selection.where(sql<boolean>`strpos(lower(name), lower(${query.q})) > 0`);
  // Every campaign that matches, on every page together: counted before the page's place.
  const { total } = await selection
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  // Ids are UUIDv7, so newest first is by id.
  if (query.after !== undefined)
    selection = selection.where('id', '<', parsePublicId('email_campaign', query.after) ?? '');
  const rows = await selection
    .orderBy('id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: await presentCampaigns(trx, invocation, page),
    next:
      rows.length > query.limit && last !== undefined
        ? toPublicId('email_campaign', last.id)
        : null,
    canManage: mayManageCampaigns(invocation),
    canSend: maySendCampaigns(invocation),
    total: Number(total),
  };
}

export async function readCampaign(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<EmailCampaign> {
  return presentCampaign(trx, invocation, await requireCampaign(trx, invocation.context, id));
}

/**
 * The business's mailboxes as the campaign screens need them, for someone who may write
 * campaigns and not manage mailboxes: no servers, sign-ins or limits.
 */
export async function readCampaignMailboxes(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<EmailCampaignMailboxList> {
  const rows = await trx
    .selectFrom('messaging.mailboxes as mailbox')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'mailbox.id')
        .onRef('channel.business_id', '=', 'mailbox.business_id'),
    )
    .select([
      'mailbox.id',
      'channel.name',
      'channel.status',
      'mailbox.email_address',
      'mailbox.display_name',
      'mailbox.use_for_campaigns',
    ])
    .where('mailbox.business_id', '=', requireBusiness(invocation.context))
    .orderBy('mailbox.created_at')
    .orderBy('mailbox.id')
    .execute();
  return {
    items: rows.map((row) => ({
      id: toPublicId('mailbox', row.id),
      name: row.name,
      email: row.email_address,
      displayName: row.display_name,
      status: emailCampaignMailbox.shape.status.parse(row.status),
      useForCampaigns: row.use_for_campaigns,
    })),
  };
}

export async function readCampaignSettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
  options: CampaignOptions,
): Promise<EmailCampaignSettings> {
  requireBusiness(invocation.context);
  return {
    dailyLimit: await readBusinessCampaignLimit(trx),
    agencyDailyLimit: options.agencyDailyLimit ?? null,
    bounceRatePause: { ...CAMPAIGN_BOUNCE_PAUSE },
    canManage: invocation.permissions === 'all' || invocation.permissions.has('mailboxes.manage'),
  };
}

export interface CampaignCommands {
  readonly create: Command<typeof createEmailCampaignInput, EmailCampaign>;
  readonly update: Command<typeof updateInput, EmailCampaign>;
  readonly remove: Command<typeof revisionInput, undefined>;
  readonly move: Command<typeof moveInput, EmailCampaign>;
  readonly send: Command<typeof sendInput, EmailCampaign>;
  readonly schedule: Command<typeof scheduleInput, EmailCampaign>;
  readonly pause: Command<typeof idInput, EmailCampaign>;
  readonly resume: Command<typeof idInput, EmailCampaign>;
  readonly cancel: Command<typeof idInput, EmailCampaign>;
  readonly settings: Command<typeof emailCampaignSettingsInput, EmailCampaignSettings>;
}

export function createCampaignCommands(options: CampaignOptions): CampaignCommands {
  const saved = async (trx: DatabaseTransaction, command: CommandContext, id: string) => {
    const row = await trx
      .selectFrom('messaging.email_campaigns')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return presentCampaign(trx, command, row);
  };

  const create = defineCommand({
    name: 'campaign.create',
    permission: 'campaigns.manage',
    input: createEmailCampaignInput,
    audit: (input) => ({ name: input.name, folderId: input.folderId, source: input.source }),
    async handle(trx, input, command): Promise<EmailCampaign> {
      const businessId = requireBusiness(command.context);
      const folderId = await folderOf(trx, input.folderId);
      const author = {
        business_id: businessId,
        name: input.name,
        folder_id: folderId,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      };
      let values: typeof author & Partial<CampaignRow> = author;
      if (input.source.kind === 'template') {
        const templateId = parsePublicId('template', input.source.templateId);
        const template =
          templateId === undefined
            ? undefined
            : await trx
                .selectFrom('messaging.templates')
                .select(['id', 'subject', 'body'])
                .where('id', '=', templateId)
                .where('channel', '=', 'email')
                .where('archived_at', 'is', null)
                .executeTakeFirst();
        if (template === undefined) throw new NotFoundError('Template', input.source.templateId);
        values = {
          ...author,
          subject: template.subject,
          body_text: template.body,
          template_id: template.id,
        };
      } else if (input.source.kind === 'campaign') {
        const source = await requireCampaign(trx, command.context, input.source.campaignId);
        values = {
          ...author,
          mailbox_id: source.mailbox_id,
          from_name: source.from_name,
          reply_to: source.reply_to,
          subject: source.subject,
          preheader: source.preheader,
          format: source.format,
          body_text: source.body_text,
          body_html: source.body_html,
          template_id: source.template_id,
          audience: source.audience,
        };
      }
      const { audience, ...columns } = values;
      const { id } = await trx
        .insertInto('messaging.email_campaigns')
        .values({
          ...columns,
          ...(audience === undefined || audience === null
            ? {}
            : { audience: JSON.stringify(audience) }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'campaign.created',
        subject: { kind: 'email_campaign', id },
        payload: { source: input.source.kind },
      });
      return saved(trx, command, id);
    },
  });

  const update = defineCommand({
    name: 'campaign.update',
    permission: 'campaigns.manage',
    input: updateInput,
    audit: (input) => ({
      id: input.id,
      revision: input.revision,
      name: input.name,
      folderId: input.folderId,
      mailboxId: input.mailboxId,
      format: input.content.format,
      subjectLength: input.subject.length,
      textLength: input.content.text.length,
      audience: input.audience?.kind ?? null,
    }),
    async handle(trx, input, command): Promise<EmailCampaign> {
      const row = await requireCampaign(trx, command.context, input.id, true);
      requireAction(row, 'edit');
      requireRevision(row, input.revision);
      await trx
        .updateTable('messaging.email_campaigns')
        .set({
          name: input.name,
          folder_id: await folderOf(trx, input.folderId),
          mailbox_id: await mailboxOf(trx, input.mailboxId),
          from_name: input.fromName,
          reply_to: input.replyTo,
          subject: input.subject,
          preheader: input.preheader,
          format: input.content.format,
          body_text: input.content.text,
          body_html: input.content.format === 'html' ? input.content.html : null,
          audience: input.audience === null ? null : JSON.stringify(input.audience),
          revision: row.revision + 1,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.updated',
        subject: { kind: 'email_campaign', id: row.id },
      });
      return saved(trx, command, row.id);
    },
  });

  const remove = defineCommand({
    name: 'campaign.delete',
    permission: 'campaigns.manage',
    input: revisionInput,
    async handle(trx, input, command): Promise<undefined> {
      const row = await requireCampaign(trx, command.context, input.id, true);
      requireAction(row, 'delete');
      requireRevision(row, input.revision);
      await trx.deleteFrom('messaging.email_campaigns').where('id', '=', row.id).execute();
      await command.emit({
        type: 'campaign.deleted',
        subject: { kind: 'email_campaign', id: row.id },
        payload: { name: row.name },
      });
      return undefined;
    },
  });

  const move = defineCommand({
    name: 'campaign.move',
    permission: 'campaigns.manage',
    input: moveInput,
    async handle(trx, input, command): Promise<EmailCampaign> {
      const row = await requireCampaign(trx, command.context, input.id, true);
      await trx
        .updateTable('messaging.email_campaigns')
        .set({ folder_id: await folderOf(trx, input.folderId) })
        .where('id', '=', row.id)
        .execute();
      return saved(trx, command, row.id);
    },
  });

  /** A draft that may leave: held, at the revision read, with no blocking check left. */
  const ready = async (
    trx: DatabaseTransaction,
    command: CommandContext,
    input: { readonly id: string; readonly revision: number },
    action: 'send' | 'schedule',
  ): Promise<CampaignRow> => {
    const row = await requireCampaign(trx, command.context, input.id, true);
    requireAction(row, action);
    requireRevision(row, input.revision);
    const checks = await readCampaignChecks(trx, command, row, options);
    const blocking = checks.items.filter((item) => item.severity === 'blocking');
    const [first, ...rest] = blocking.map((item) => ({
      path: '',
      code: item.code,
      message: item.message,
    }));
    if (first !== undefined) throw new ValidationError([first, ...rest]);
    return row;
  };

  const starter = (command: CommandContext) => ({
    started_by_kind: command.context.actorKind,
    started_by_id: command.context.actorId ?? null,
  });

  const send = defineCommand({
    name: 'campaign.send',
    permission: 'campaigns.send',
    input: sendInput,
    async handle(trx, input, command): Promise<EmailCampaign> {
      const row = await ready(trx, command, input, 'send');
      await trx
        .updateTable('messaging.email_campaigns')
        .set({
          status: 'sending',
          status_reason: null,
          started_at: sql`now()`,
          next_run_at: sql`now()`,
          ...batchColumns(input.batches),
          ...starter(command),
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.started',
        subject: { kind: 'email_campaign', id: row.id },
        payload: { name: row.name, batches: input.batches !== null },
      });
      await sql`select private.enqueue_email_campaign(${row.id}::uuid)`.execute(trx);
      return saved(trx, command, row.id);
    },
  });

  const schedule = defineCommand({
    name: 'campaign.schedule',
    permission: 'campaigns.send',
    input: scheduleInput,
    async handle(trx, input, command): Promise<EmailCampaign> {
      const row = await ready(trx, command, input, 'schedule');
      const sendAt = new Date(input.sendAt);
      const now = (await databaseNow(trx)).getTime();
      if (sendAt.getTime() <= now)
        throw invalid('/sendAt', 'in_the_past', 'Choose a time that has not passed, or send now.');
      if (sendAt.getTime() > now + SCHEDULE_HORIZON_MS)
        throw invalid('/sendAt', 'too_far', 'Schedule at most a year ahead.');
      await trx
        .updateTable('messaging.email_campaigns')
        .set({
          status: 'scheduled',
          status_reason: null,
          send_at: sendAt,
          next_run_at: sendAt,
          ...batchColumns(input.batches),
          ...starter(command),
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.scheduled',
        subject: { kind: 'email_campaign', id: row.id },
        payload: { name: row.name, sendAt: sendAt.toISOString() },
      });
      return saved(trx, command, row.id);
    },
  });

  const pause = defineCommand({
    name: 'campaign.pause',
    permission: 'campaigns.send',
    input: idInput,
    async handle(trx, input, command): Promise<EmailCampaign> {
      const row = await requireCampaign(trx, command.context, input.id, true);
      requireAction(row, 'pause');
      await trx
        .updateTable('messaging.email_campaigns')
        .set({ status: 'paused', status_reason: null, wait_reason: null, wait_until: null })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.paused',
        subject: { kind: 'email_campaign', id: row.id },
        payload: { name: row.name, by: 'person' },
      });
      return saved(trx, command, row.id);
    },
  });

  const resume = defineCommand({
    name: 'campaign.resume',
    permission: 'campaigns.send',
    input: idInput,
    async handle(trx, input, command): Promise<EmailCampaign> {
      const row = await requireCampaign(trx, command.context, input.id, true);
      requireAction(row, 'resume');
      await trx
        .updateTable('messaging.email_campaigns')
        .set({
          status: 'sending',
          status_reason: null,
          resumed_at: sql`now()`,
          next_run_at: sql`now()`,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'campaign.resumed',
        subject: { kind: 'email_campaign', id: row.id },
        payload: { name: row.name },
      });
      await sql`select private.enqueue_email_campaign(${row.id}::uuid)`.execute(trx);
      return saved(trx, command, row.id);
    },
  });

  const cancel = defineCommand({
    name: 'campaign.cancel',
    permission: 'campaigns.send',
    input: idInput,
    async handle(trx, input, command): Promise<EmailCampaign> {
      const row = await requireCampaign(trx, command.context, input.id, true);
      requireAction(row, 'cancel');
      if (row.status === 'scheduled') {
        // Nothing was sent and nobody was chosen: it is a draft again, to edit or reschedule.
        await trx
          .updateTable('messaging.email_campaigns')
          .set({
            status: 'draft',
            send_at: null,
            next_run_at: null,
            ...batchColumns(null),
            revision: row.revision + 1,
          })
          .where('id', '=', row.id)
          .execute();
      } else {
        // Whoever has not been released is skipped now. Emails already released are refused
        // by the pipeline as they come up (campaign-gate.ts), and the task writes them off.
        await trx
          .updateTable('messaging.email_campaign_recipients')
          .set({ status: 'skipped', reason: 'cancelled' })
          .where('campaign_id', '=', row.id)
          .where('status', '=', 'pending')
          .execute();
        await trx
          .updateTable('messaging.email_campaigns')
          .set({
            status: 'cancelled',
            status_reason: null,
            finished_at: sql`now()`,
            next_run_at: sql`now()`,
            wait_reason: null,
            wait_until: null,
          })
          .where('id', '=', row.id)
          .execute();
      }
      await command.emit({
        type: 'campaign.cancelled',
        subject: { kind: 'email_campaign', id: row.id },
        payload: { name: row.name, was: row.status },
      });
      return saved(trx, command, row.id);
    },
  });

  const settings = defineCommand({
    name: 'campaign.settings',
    // The ceiling is a sending limit, set where the mailboxes' limits are.
    permission: 'mailboxes.manage',
    input: emailCampaignSettingsInput,
    async handle(trx, input, command): Promise<EmailCampaignSettings> {
      const businessId = requireBusiness(command.context);
      await trx
        .insertInto('messaging.settings')
        .values({ business_id: businessId, campaign_daily_limit: input.dailyLimit })
        .onConflict((conflict) =>
          conflict.column('business_id').doUpdateSet({ campaign_daily_limit: input.dailyLimit }),
        )
        .execute();
      return readCampaignSettings(trx, command, options);
    },
  });

  return { create, update, remove, move, send, schedule, pause, resume, cancel, settings };
}

/** Refuses a person who may write campaigns and may not send them. */
export function requireSend(invocation: Invocation): void {
  if (!maySendCampaigns(invocation))
    throw new ForbiddenError(
      "Your role doesn't allow this: it needs campaigns.send.",
      'campaigns.send',
    );
}
