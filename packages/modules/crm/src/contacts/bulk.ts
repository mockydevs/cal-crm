// Bulk actions on contacts: add or remove tags, move to the trash, reassign the owner, add
// to a workflow, export as CSV, send an email or a text message, set do not disturb, add an
// opportunity and verify email addresses, for the contacts selected in the list or for a whole filtered list.
//
// An action is a row and its items: the contacts it names, fixed when it starts, each with
// what became of it. A batch takes the next contacts without an outcome, changes each by
// the command a single edit uses, inside a savepoint of its own, and writes the outcomes
// and the action's counts in the same transaction. So a batch that fails leaves nothing,
// and the next run applies those contacts; one that committed is never applied again. The
// action's row is locked for the length of a batch, so two runs of one action take turns
// and the second finds the first one's contacts already done.
//
// An action can wait for a start time, and drip mode reaches a number of contacts, then
// waits, then reaches the next: the action keeps when it may next run and how far the
// current batch of the drip reaches, and a job keyed by the action is queued for that time.
// An export is written once every contact has its outcome, as a file of the contacts it
// wrote (bulk-export.ts); the action ends when the file is kept, or fails saying why.
//
// Whoever starts an action is checked for what it does, once: a role's permissions are the
// same for every contact. Each contact is then checked for what can differ: that it is this
// business's (row-level security), that it exists, and that it is not in the trash.
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
  type TaskReference,
} from '@repo/commands';
import {
  bulkContactsInput,
  CONTACT_BULK_INLINE_LIMIT,
  CONTACT_BULK_LIMIT,
  contactBulkActionIdInput,
  contactBulkActionKinds,
  contactBulkSkipCodes,
  dndChannels,
  type ContactBulkAction,
  type ContactBulkActionKind,
  type ContactBulkItemList,
  type ContactBulkActionList,
  type ContactBulkOutcome,
  type ContactBulkSkipCode,
  type ContactEmailCheckPreview,
  type contactBulkActionsQuery,
  type previewContactEmailChecksInput,
  type contactBulkItemsQuery,
  type DndChannel,
  type Permission,
} from '@repo/contracts';
import type { DatabaseTransaction, Json } from '@repo/db';
import {
  actorKinds,
  AppError,
  ContentTooLargeError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { namesOf } from '../activity/activity.js';
import { createDealCommand } from '../deals/deals.js';
import { holdOwnerRules } from '../deals/owner-rules.js';
import { assignRecordTagCommand, removeRecordTagCommand } from '../tags/assignments.js';
import { checkExportColumns, exportContent, exportFileName } from './bulk-export.js';
import type { BulkEmailCheckBatch, BulkMessage, ContactBulkOptions } from './bulk-options.js';
import { lockContactsInOrder, trashContactCommand } from './contacts.js';
import { dndRevisionOf, ownerRevisionOf, storedDndChannels } from './details.js';
import { setContactDndCommand } from './dnd.js';
import { contactListScope } from './list-scope.js';
import { assignContactOwnerCommand, memberOf } from './people.js';

/** The job that applies a queued action's batches. The worker holds its handler (bulk-task.ts). */
export const runContactBulkReference = {
  name: 'contacts.bulk_run',
  data: z.strictObject({ bulkActionId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/** What an action applies, as the ids and settings it resolved when it started. */
const storedParameters = z.object({
  tagIds: z.array(z.uuid()).optional(),
  allTags: z.boolean().optional(),
  ownerUserId: z.uuid().nullable().optional(),
  ownerMembership: z.string().nullable().optional(),
  workflowId: z.uuid().optional(),
  /** An export's columns: a built-in key, or a field's stored id. */
  columns: z.array(z.string()).optional(),
  /** A send's mailbox or number, and an email's template, by public id as chosen. */
  sender: z.string().optional(),
  templateId: z.string().optional(),
  dnd: z.enum(['on', 'off']).optional(),
  dndChannels: z.union([z.literal('all'), z.array(z.enum(dndChannels))]).optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  dealStatus: z.enum(['open', 'won']).optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
  allowDuplicates: z.boolean().optional(),
});
type Parameters = z.output<typeof storedParameters>;

/** What the person wrote for the action to use, kept until it ends (migration 0118). */
const storedContent = z.object({
  message: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  fromName: z.string().optional(),
  reason: z.string().optional(),
  opportunityName: z.string().optional(),
  source: z.string().optional(),
});
type Content = z.output<typeof storedContent>;

/** What each action changes, which whoever starts it must be allowed to change. */
const ALSO_NEEDS: Readonly<Record<ContactBulkActionKind, Permission | undefined>> = {
  add_tags: assignRecordTagCommand.permission,
  remove_tags: removeRecordTagCommand.permission,
  trash: undefined,
  assign_owner: undefined,
  // Enrolling a contact is the automation module's, which manage permission covers.
  add_to_workflow: 'automations.manage',
  export: 'contacts.export',
  // A message to many contacts at once is a campaign in all but name, and is held to the
  // permission that sends one.
  send_email: 'campaigns.send',
  send_sms: 'campaigns.send',
  set_dnd: undefined,
  add_opportunity: createDealCommand.permission,
  // Verifying an address is a change to the contact, as Verify on its page is.
  verify_emails: undefined,
};

function requireAlso(command: CommandContext, permission: Permission | undefined): void {
  if (permission === undefined) return;
  if (command.permissions === 'all' || command.permissions.has(permission)) return;
  throw new ForbiddenError(`Your role doesn't allow this: it needs ${permission}.`, permission);
}

const notFound = (id: string) => new NotFoundError('Bulk action', id);

const invalid = (issue: Issue): ValidationError => new ValidationError([issue]);

const SKIP_WORDS: Readonly<Record<ContactBulkSkipCode, string>> = {
  not_found: 'This contact was not found.',
  in_trash: 'This contact is in the trash. Restore it before changing it.',
  unknown_tag: 'A tag of this action no longer exists.',
  unavailable_member: 'The new owner is no longer on the team.',
  already_in_workflow: 'This contact is in the workflow now, and is in it once at a time.',
  reentry_not_allowed:
    'This contact has been through the workflow, which takes a contact once (re-entry is off).',
  workflow_unavailable: 'The workflow was paused, deleted or unpublished since the action began.',
  no_address: 'This contact has no address to send it to.',
  do_not_disturb: 'Do not disturb is on for this contact.',
  no_consent: 'This contact has not agreed to get these messages, or has withdrawn.',
  suppressed: 'This address bounced, complained or unsubscribed, so nothing is sent to it.',
  missing_values: 'This contact has no value for a merge field of the message.',
  sender_unavailable: 'The mailbox or number can no longer send.',
  message_refused: 'Messaging refused to send this message.',
  has_opportunity: 'This contact is with an opportunity already, and duplicates are off.',
  no_name: 'This contact has no name, email address or phone number to name an opportunity by.',
  stage_unavailable: 'The pipeline or stage was archived since the action began.',
  verification_excluded: 'This email address is excluded from email verification.',
  daily_limit: "Today's email verification limit is used up. Verify the rest tomorrow.",
  verification_off: 'Email verification was turned off since the action began.',
  refused: 'This contact could not be changed.',
};

/** Why Verify emails skipped a contact without an address: said for what it does. */
const NO_EMAIL_TO_VERIFY = 'This contact has no email address to verify.';

/**
 * Why an action failed: an export whose file could not be kept, or an action whose starter
 * is no longer on the team or no longer allowed to do what it does.
 */
const FAILURE_WORDS: Readonly<Record<string, string>> = {
  file_too_large: 'The file is larger than this install keeps. Export fewer contacts or columns.',
  storage_full:
    "The business's file storage is full. Delete files to make room, then export again.",
  file_refused: 'The files service refused the file.',
  files_unavailable: 'This install has no file storage, so the file could not be kept.',
  starter_removed:
    'The person who started this action is no longer on the team, so it was stopped.',
  starter_not_allowed:
    'The person who started this action may no longer do this, so it was stopped.',
};

/** The failures finishExport can come to, as the action keeps them. */
type ExportFailure = 'file_too_large' | 'storage_full' | 'file_refused' | 'files_unavailable';

/**
 * How many contacts one transaction of an action reaches. A send holds the outbound path's
 * lock on the business from its first message until the batch commits, and every other
 * message of the business (a reply in the Inbox, a workflow's) waits for it meanwhile. One
 * text took about 45 ms through the real path on a developer's machine, so ten hold the
 * lock about half a second, where a hundred held it more than four.
 */
export const CONTACT_BULK_SEND_BATCH = 10;
const batchOf = (kind: ContactBulkActionKind): number =>
  kind === 'send_email' || kind === 'send_sms'
    ? CONTACT_BULK_SEND_BATCH
    : CONTACT_BULK_INLINE_LIMIT;

/** How long an export's file is kept, as GoHighLevel keeps one: thirty days. */
export const CONTACT_EXPORT_KEPT_DAYS = 30;
/** The furthest ahead an action may start: thirty days, as GoHighLevel's drip allows. */
const LATEST_START_DAYS = 30;
/** How long a bulk email waits when the agency's daily ceiling is reached, in seconds. */
const CEILING_WAIT_SECONDS = 15 * 60;

const isSkipCode = (code: string | null): code is ContactBulkSkipCode =>
  (contactBulkSkipCodes as readonly string[]).includes(code ?? '');

/** Why a refusal of a single-contact command skips the contact. */
function skipCodeOf(error: AppError): ContactBulkSkipCode {
  if (error instanceof NotFoundError)
    return error.message.startsWith('Tag') ? 'unknown_tag' : 'not_found';
  if (error instanceof ValidationError) {
    if (error.issues.some((issue) => issue.code === 'unavailable_member'))
      return 'unavailable_member';
    if (error.issues.some((issue) => issue.path === '/stageId')) return 'stage_unavailable';
  }
  return 'refused';
}

interface Applied {
  readonly outcome: ContactBulkOutcome;
  readonly reason?: ContactBulkSkipCode;
}

const skipped = (reason: ContactBulkSkipCode): Applied => ({ outcome: 'skipped', reason });

/** The message an action sends, from what it kept. */
function messageOf(
  action: ContactBulkActionKind,
  parameters: Parameters,
  content: Content,
): BulkMessage {
  return action === 'send_sms'
    ? { channel: 'sms', number: parameters.sender, message: content.message ?? '' }
    : {
        channel: 'email',
        mailbox: parameters.sender,
        fromName: content.fromName,
        subject: content.subject,
        body: content.body,
        templateId: parameters.templateId,
      };
}

/** The do-not-disturb settings an action asks for, from what a contact has now. */
function dndAfter(
  parameters: Parameters,
  now: { readonly all: boolean; readonly channels: readonly DndChannel[] },
): { all: boolean; channels: DndChannel[] } {
  const on = parameters.dnd === 'on';
  const named = parameters.dndChannels ?? [];
  if (named === 'all')
    return on ? { all: true, channels: [...now.channels] } : { all: false, channels: [] };
  return {
    all: now.all,
    channels: dndChannels.filter((channel) =>
      named.includes(channel) ? on : now.channels.includes(channel),
    ),
  };
}

/** One contact's turn: the action, what it kept, and the contact it is applied to. */
interface Turn {
  readonly actionId: string;
  readonly kind: ContactBulkActionKind;
  readonly parameters: Parameters;
  readonly content: Content;
  readonly contactId: string;
  /** Where the contact is in the action, and when the action began. */
  readonly position: number;
  readonly since: Date;
  /** The batch's email checks, for Verify emails. */
  readonly checks?: BulkEmailCheckBatch | undefined;
}

/** The single-contact commands an action applies, made with what they need of other modules. */
function appliers(options: ContactBulkOptions) {
  const assignOwner = assignContactOwnerCommand(options);
  const setDnd = setContactDndCommand(options);

  /** Changes one contact, which the caller holds, and says what became of it. */
  return async function apply(
    trx: DatabaseTransaction,
    command: CommandContext,
    turn: Turn,
  ): Promise<Applied> {
    const { kind: action, parameters, content, contactId } = turn;
    const businessId = requireBusiness(command.context);
    const id = toPublicId('contact', contactId);
    // Held to the end of the batch, so what is read here is what is changed.
    const contact = await trx
      .selectFrom('crm.contacts')
      .select([
        'id',
        'deleted_at',
        'owner_user_id',
        'display_name',
        'do_not_contact',
        'dnd_channels',
        'dnd_inbound',
      ])
      .where('business_id', '=', businessId)
      .where('id', '=', contactId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (contact === undefined) return skipped('not_found');
    if (action === 'trash') {
      if (contact.deleted_at !== null) return { outcome: 'unchanged' };
      await trashContactCommand.handle(trx, { id }, command);
      return { outcome: 'done' };
    }
    if (contact.deleted_at !== null) return skipped('in_trash');

    // Written into the file when every contact has its turn (bulk-export.ts).
    if (action === 'export') return { outcome: 'done' };

    if (action === 'add_to_workflow') {
      const { workflows } = options;
      if (workflows === undefined || parameters.workflowId === undefined)
        return skipped('workflow_unavailable');
      const enrolled = await workflows.enrol(trx, command, parameters.workflowId, contactId);
      return enrolled === 'started'
        ? { outcome: 'done' }
        : skipped(
            enrolled === 'already_running'
              ? 'already_in_workflow'
              : enrolled === 'already_went_through'
                ? 'reentry_not_allowed'
                : 'workflow_unavailable',
          );
    }

    if (action === 'send_email' || action === 'send_sms') {
      if (options.messages === undefined) return skipped('sender_unavailable');
      // The same contact of the same action is one message, however often a batch runs.
      const sent = await options.messages.send(
        trx,
        command,
        messageOf(action, parameters, content),
        { id: contactId, idempotencyKey: `contact-bulk:${turn.actionId}:${contactId}` },
      );
      return sent.queued ? { outcome: 'done' } : skipped(sent.reason);
    }

    if (action === 'verify_emails') {
      if (turn.checks === undefined) return skipped('verification_off');
      const outcome = await turn.checks.queue(trx, command, contactId, {
        position: turn.position,
        since: turn.since,
      });
      if (outcome === 'queued') return { outcome: 'done' };
      if (outcome === 'current') return { outcome: 'unchanged' };
      return skipped(
        outcome === 'no_email'
          ? 'no_address'
          : outcome === 'excluded'
            ? 'verification_excluded'
            : outcome === 'daily_limit'
              ? 'daily_limit'
              : 'verification_off',
      );
    }

    if (action === 'set_dnd') {
      const stored = storedDndChannels(contact.dnd_channels);
      const next = dndAfter(parameters, { all: contact.do_not_contact, channels: stored });
      if (next.all === contact.do_not_contact && next.channels.join() === stored.join())
        return { outcome: 'unchanged' };
      await setDnd.handle(
        trx,
        {
          id,
          all: next.all,
          channels: next.channels,
          reason: content.reason ?? '',
          revision: dndRevisionOf(contact.do_not_contact, stored, contact.dnd_inbound),
        },
        command,
      );
      return { outcome: 'done' };
    }

    if (action === 'add_opportunity') {
      if (parameters.allowDuplicates !== true) {
        const linked = await trx
          .selectFrom('crm.record_links as link')
          .innerJoin('crm.deals as deal', (join) =>
            join
              .onRef('deal.business_id', '=', 'link.business_id')
              .onRef('deal.id', '=', 'link.from_record_id'),
          )
          .select('deal.id')
          .where('link.business_id', '=', businessId)
          .where('link.to_record_id', '=', contactId)
          .where('deal.deleted_at', 'is', null)
          .executeTakeFirst();
        if (linked !== undefined) return skipped('has_opportunity');
      }
      // As GoHighLevel names a new opportunity: as asked, else its contact's name, else
      // any other way the contact is known.
      const known = await trx
        .selectFrom('crm.contact_identities')
        .select('value_normalized')
        .where('business_id', '=', businessId)
        .where('contact_id', '=', contactId)
        .where('is_primary', '=', true)
        .orderBy('kind')
        .executeTakeFirst();
      const name = content.opportunityName ?? contact.display_name ?? known?.value_normalized;
      if (name === undefined) return skipped('no_name');
      await createDealCommand.handle(
        trx,
        {
          name: name.slice(0, 200),
          pipelineId: toPublicId('pipeline', parameters.pipelineId ?? ''),
          stageId: toPublicId('stage', parameters.stageId ?? ''),
          amount: parameters.amount ?? null,
          currency: parameters.currency ?? '',
          expectedCloseDate: null,
          status: parameters.dealStatus ?? 'open',
          outcomeReason: null,
          ...(content.source === undefined ? {} : { source: content.source }),
          primaryContactId: id,
        },
        command,
      );
      return { outcome: 'done' };
    }

    if (action === 'assign_owner') {
      const owner = parameters.ownerUserId ?? null;
      if (contact.owner_user_id === owner) return { outcome: 'unchanged' };
      await assignOwner.handle(
        trx,
        {
          id,
          owner: parameters.ownerMembership ?? null,
          revision: ownerRevisionOf(contact.owner_user_id),
        },
        command,
      );
      return { outcome: 'done' };
    }

    const has = await trx
      .selectFrom('crm.record_tags')
      .select('tag_id')
      .where('business_id', '=', businessId)
      .where('record_id', '=', contactId)
      .execute();
    const held = new Set(has.map((row) => row.tag_id));
    const named = parameters.tagIds ?? [];
    if (action === 'add_tags') {
      const missing = named.filter((tagId) => !held.has(tagId));
      for (const tagId of missing)
        await assignRecordTagCommand.handle(trx, { id, tagId: toPublicId('tag', tagId) }, command);
      return { outcome: missing.length === 0 ? 'unchanged' : 'done' };
    }
    const removing =
      parameters.allTags === true ? [...held] : named.filter((tagId) => held.has(tagId));
    for (const tagId of removing)
      await removeRecordTagCommand.handle(trx, { id, tagId: toPublicId('tag', tagId) }, command);
    return { outcome: removing.length === 0 ? 'unchanged' : 'done' };
  };
}

interface ActionRow {
  readonly id: string;
  readonly name: string | null;
  readonly action: string;
  readonly parameters: Json;
  readonly content: Json | null;
  readonly status: string;
  readonly requested_count: number;
  readonly done_count: number;
  readonly unchanged_count: number;
  readonly skipped_count: number;
  readonly cancel_requested_at: Date | null;
  readonly actor_kind: string;
  readonly actor_id: string | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly file_id: string | null;
  readonly failure: string | null;
  readonly drip_batch_size: number | null;
  readonly drip_interval_seconds: number | null;
  readonly next_run_at: Date | null;
  readonly window_end: number | null;
}

const ENDED: readonly string[] = ['completed', 'cancelled', 'failed'];

const kindOf = (action: string): ContactBulkActionKind => {
  const kind = contactBulkActionKinds.find((each) => each === action);
  if (kind === undefined) throw new Error(`Unknown bulk action ${action}.`);
  return kind;
};

const statusOf = (status: string): ContactBulkAction['status'] =>
  status === 'running' || status === 'completed' || status === 'cancelled' || status === 'failed'
    ? status
    : 'queued';

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly ActionRow[],
  options: ContactBulkOptions,
): Promise<ContactBulkAction[]> {
  const { context } = invocation;
  const actors = rows.map((row) => ({
    actor_kind: actorKinds.find((each) => each === row.actor_kind) ?? 'system',
    actor_id: row.actor_id,
  }));
  const names = await namesOf(trx, actors, options.actorNames);
  const fileIds = rows.flatMap((row) => (row.file_id === null ? [] : [row.file_id]));
  const files =
    fileIds.length === 0
      ? []
      : await trx
          .selectFrom('files.files')
          .select(['id', 'filename', 'size_bytes'])
          .where('id', 'in', fileIds)
          .where('deleted_at', 'is', null)
          .execute();
  const mayChange =
    invocation.permissions === 'all' || invocation.permissions.has('contacts.manage');
  const now = new Date();
  return rows.map((row, index) => {
    const kind = actors[index]?.actor_kind ?? 'system';
    const file = files.find((each) => each.id === row.file_id);
    return {
      id: toPublicId('bulk_action', row.id),
      name: row.name,
      action: kindOf(row.action),
      status: statusOf(row.status),
      requested: row.requested_count,
      done: row.done_count,
      unchanged: row.unchanged_count,
      skipped: row.skipped_count,
      actor: {
        kind,
        name: names.get(`${kind}:${row.actor_id ?? ''}`) ?? null,
        you: kind === 'user' && context.actorKind === 'user' && row.actor_id === context.userId,
      },
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
      canCancel: mayChange && !ENDED.includes(row.status),
      drip:
        row.drip_batch_size === null || row.drip_interval_seconds === null
          ? null
          : {
              batchSize: row.drip_batch_size,
              intervalMinutes: Math.round(row.drip_interval_seconds / 60),
            },
      // Only a time still ahead: one that has come is the job's to run now.
      nextBatchAt:
        ENDED.includes(row.status) || row.next_run_at === null || row.next_run_at <= now
          ? null
          : row.next_run_at.toISOString(),
      file: file === undefined ? null : { filename: file.filename, size: Number(file.size_bytes) },
      fileExpiresAt:
        row.action === 'export' && row.status === 'completed' && row.finished_at !== null
          ? keptUntil(row.finished_at).toISOString()
          : null,
      failure:
        row.failure === null
          ? null
          : {
              code: row.failure,
              message: FAILURE_WORDS[row.failure] ?? 'The action could not be finished.',
            },
    };
  });
}

const actions = (trx: DatabaseTransaction, businessId: string) =>
  trx.selectFrom('crm.contact_bulk_actions').selectAll().where('business_id', '=', businessId);

async function actionOf(
  trx: DatabaseTransaction,
  businessId: string,
  id: string,
  lock = false,
): Promise<ActionRow> {
  const uuid = parsePublicId('bulk_action', id);
  let query = actions(trx, businessId).where('id', '=', uuid ?? '');
  if (lock) query = query.forNoKeyUpdate();
  const row = uuid === undefined ? undefined : await query.executeTakeFirst();
  if (row === undefined) throw notFound(id);
  return row;
}

/** Whether a time is still ahead, by the database's clock. */
async function ahead(trx: DatabaseTransaction, at: Date | string | null): Promise<boolean> {
  if (at === null) return false;
  const { rows } = await sql<{ ahead: boolean }>`
    select ${at instanceof Date ? at.toISOString() : at}::timestamptz > now() as ahead
  `.execute(trx);
  return rows[0]?.ahead === true;
}

/** Whether a start time is further ahead than an action may wait, by the database's clock. */
async function tooFar(trx: DatabaseTransaction, at: string): Promise<boolean> {
  const { rows } = await sql<{ far: boolean }>`
    select ${at}::timestamptz > now() + make_interval(days => ${LATEST_START_DAYS}) as far
  `.execute(trx);
  return rows[0]?.far === true;
}

/** When an export's file, kept when the export finished, is removed. */
const keptUntil = (finishedAt: Date): Date =>
  new Date(finishedAt.getTime() + CONTACT_EXPORT_KEPT_DAYS * 24 * 60 * 60 * 1000);

/** The task that removes an export's file once it has been kept long enough. */
export const expireContactExportReference = {
  name: 'contacts.bulk_expire_export',
  data: z.strictObject({ bulkActionId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/**
 * Queues one of the action's jobs for a time: its batches from its start or the next batch
 * of its drip, or the removal of an export's file.
 */
async function runAt(
  trx: DatabaseTransaction,
  actionId: string,
  at: Date | string,
  task: string = runContactBulkReference.name,
): Promise<void> {
  await sql`
    select private.enqueue_contact_bulk(${actionId}::uuid, ${at instanceof Date ? at.toISOString() : at}::timestamptz, ${task})
  `.execute(trx);
}

/** Ends an action that cannot go on, saying why. What was done stays done. */
async function failAction(
  trx: DatabaseTransaction,
  businessId: string,
  actionId: string,
  failure: string,
): Promise<void> {
  await trx
    .updateTable('crm.contact_bulk_actions')
    .set({ status: 'failed', failure, finished_at: sql<Date>`now()`, content: null })
    .where('business_id', '=', businessId)
    .where('id', '=', actionId)
    .execute();
}

/**
 * Settles every contact of an export at once, by what the list holds now: written, or
 * skipped when it was deleted or is in the trash. One statement, no contact held: an
 * export changes no contact, so nothing it reads needs holding still.
 */
async function settleExport(
  trx: DatabaseTransaction,
  businessId: string,
  actionId: string,
): Promise<{ done: number; skipped: number }> {
  const { rows } = await sql<{ outcome: string }>`
    update crm.contact_bulk_action_items item
    set outcome = case when found.deleted_at is null and found.id is not null then 'done' else 'skipped' end,
      reason = case when found.id is null then 'not_found'
        when found.deleted_at is not null then 'in_trash' end
    from (
      select pending.position, c.id, c.deleted_at
      from crm.contact_bulk_action_items pending
      left join crm.contacts c on c.business_id = pending.business_id and c.id = pending.contact_id
      where pending.business_id = ${businessId} and pending.bulk_action_id = ${actionId}
        and pending.outcome is null
    ) found
    where item.business_id = ${businessId} and item.bulk_action_id = ${actionId}
      and item.position = found.position
    returning item.outcome
  `.execute(trx);
  const done = rows.filter((row) => row.outcome === 'done').length;
  return { done, skipped: rows.length - done };
}

/** What a run of an action's job does next. */
type BatchState = 'more' | 'ended' | 'waiting' | 'write_file';

/**
 * Applies the next batch of an action whose row the caller holds, and writes what became of
 * each contact and of the action. Gives the action as it is afterwards, and what follows.
 */
async function applyBatch(
  trx: DatabaseTransaction,
  command: CommandContext,
  apply: ReturnType<typeof appliers>,
  action: ActionRow,
  options: ContactBulkOptions,
): Promise<{ row: ActionRow; state: BatchState }> {
  const businessId = requireBusiness(command.context);
  const kind = kindOf(action.action);
  if (kind === 'export') {
    // Every contact at once; the file is written next, by the job.
    const settled = await settleExport(trx, businessId, action.id);
    const row = await trx
      .updateTable('crm.contact_bulk_actions')
      .set({
        done_count: action.done_count + settled.done,
        skipped_count: action.skipped_count + settled.skipped,
        status: 'running',
        started_at: action.started_at ?? sql<Date>`now()`,
      })
      .where('business_id', '=', businessId)
      .where('id', '=', action.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row, state: 'write_file' };
  }
  const parameters = storedParameters.parse(action.parameters);
  const content = storedContent.parse(action.content ?? {});
  // Before any contact, what the single commands take first: a change of owner may also
  // write on the contact's deals, and the rule that says so is held first by the single
  // command too (deals/owner-rules.ts); a send takes the outbound path's lock on the
  // business, and an opportunity reads the business, before either holds a contact.
  if (kind === 'assign_owner') await holdOwnerRules(trx, businessId);
  if ((kind === 'send_email' || kind === 'send_sms') && options.messages !== undefined)
    await options.messages.hold(trx, command);
  if (kind === 'add_opportunity')
    await trx
      .selectFrom('tenancy.businesses')
      .select('id')
      .where('id', '=', businessId)
      .forShare()
      .execute();
  // Bulk email counts against the agency's daily ceiling on campaign emails: a batch sends
  // no more than there is room for, and with none waits for room to come.
  let most = batchOf(kind);
  if (kind === 'send_email' && options.messages !== undefined) {
    const room = await options.messages.emailAllowance(trx, command);
    if (room !== null && room <= 0) {
      const row = await trx
        .updateTable('crm.contact_bulk_actions')
        .set({
          status: 'running',
          started_at: action.started_at ?? sql<Date>`now()`,
          next_run_at: sql<Date>`now() + make_interval(secs => ${CEILING_WAIT_SECONDS})`,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', action.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (row.next_run_at !== null) await runAt(trx, row.id, row.next_run_at);
      return { row, state: 'waiting' };
    }
    if (room !== null) most = Math.min(most, room);
  }
  let pending = trx
    .selectFrom('crm.contact_bulk_action_items')
    .select(['position', 'contact_id'])
    .where('business_id', '=', businessId)
    .where('bulk_action_id', '=', action.id)
    .where('outcome', 'is', null);
  if (action.window_end !== null) pending = pending.where('position', '<=', action.window_end);
  const items = await pending.orderBy('position').limit(most).execute();
  // Verify emails reads the day's verification limit once for the batch.
  const checks =
    kind === 'verify_emails' && items.length > 0
      ? await options.emailChecks?.start(trx, command)
      : undefined;
  // Adding to a workflow holds each contact's runs, which come before the contact: all of
  // the batch's are held first, in id order, as a merge holds them.
  if (kind === 'add_to_workflow')
    await options.workflows?.hold?.(trx, [...new Set(items.map((item) => item.contact_id))].sort());
  // The batch's contacts, held in id order before the first is changed, as a merge and an
  // import hold theirs; each is still changed, and reported, in its place in the action.
  await lockContactsInOrder(
    trx,
    businessId,
    items.map((item) => item.contact_id),
  );
  const counts = { done: 0, unchanged: 0, skipped: 0 };
  for (const item of items) {
    let applied: Applied;
    await sql`savepoint bulk_contact`.execute(trx);
    try {
      applied = await apply(trx, command, {
        actionId: action.id,
        kind,
        parameters,
        content,
        contactId: item.contact_id,
        position: item.position,
        since: action.created_at,
        checks,
      });
      await sql`release savepoint bulk_contact`.execute(trx);
    } catch (error) {
      await sql`rollback to savepoint bulk_contact`.execute(trx);
      await sql`release savepoint bulk_contact`.execute(trx);
      // Anything the commands did not refuse by name is a fault: the whole batch fails,
      // nothing of it is kept, and the job tries it again.
      if (!(error instanceof AppError)) throw error;
      applied = skipped(skipCodeOf(error));
    }
    counts[applied.outcome] += 1;
    await trx
      .updateTable('crm.contact_bulk_action_items')
      .set({ outcome: applied.outcome, reason: applied.reason ?? null })
      .where('business_id', '=', businessId)
      .where('bulk_action_id', '=', action.id)
      .where('position', '=', item.position)
      .execute();
  }
  const settled = action.done_count + action.unchanged_count + action.skipped_count + items.length;
  const complete = settled >= action.requested_count;
  // A drip batch that has reached its last contact waits for the next one's time, which
  // reaches as many contacts again.
  const interval = action.drip_interval_seconds;
  const dripDone =
    !complete && interval !== null && action.window_end !== null && settled >= action.window_end;
  const row = await trx
    .updateTable('crm.contact_bulk_actions')
    .set({
      done_count: action.done_count + counts.done,
      unchanged_count: action.unchanged_count + counts.unchanged,
      skipped_count: action.skipped_count + counts.skipped,
      status: complete ? 'completed' : 'running',
      started_at: action.started_at ?? sql<Date>`now()`,
      ...(complete ? { finished_at: sql<Date>`now()`, content: null } : {}),
      ...(dripDone
        ? {
            next_run_at: sql<Date>`now() + make_interval(secs => ${interval})`,
            window_end: settled + (action.drip_batch_size ?? 1),
          }
        : {}),
    })
    .where('business_id', '=', businessId)
    .where('id', '=', action.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (dripDone && row.next_run_at !== null) await runAt(trx, row.id, row.next_run_at);
  return { row, state: complete ? 'ended' : dripDone ? 'waiting' : 'more' };
}

export interface ContactBulkCommands {
  readonly start: Command<typeof bulkContactsInput, ContactBulkAction>;
  readonly applyBatch: Command<typeof applyBatchInput, { state: BatchState }>;
  readonly finishExport: Command<typeof applyBatchInput, { ended: boolean }>;
  readonly expireExport: Command<typeof applyBatchInput, { removed: boolean }>;
  readonly cancel: Command<typeof contactBulkActionIdInput, ContactBulkAction>;
}

const applyBatchInput = z.strictObject({ bulkActionId: z.uuid() });

/** Why the person who started an action may not go on with it now; undefined, they may. */
async function starterRefusal(
  trx: DatabaseTransaction,
  command: CommandContext,
  action: ActionRow,
  options: ContactBulkOptions,
): Promise<'starter_removed' | 'starter_not_allowed' | undefined> {
  if (options.grants === undefined || action.actor_kind !== 'user' || action.actor_id === null)
    return undefined;
  const granted = await options.grants(trx, command.context, action.actor_id);
  if (granted === undefined) return 'starter_removed';
  const also = ALSO_NEEDS[kindOf(action.action)];
  return granted.has('contacts.manage') && (also === undefined || granted.has(also))
    ? undefined
    : 'starter_not_allowed';
}

/** What an action keeps of what it was asked, as ids and settings and as the words written. */
async function resolve(
  trx: DatabaseTransaction,
  command: CommandContext,
  input: z.output<typeof bulkContactsInput>,
  options: ContactBulkOptions,
): Promise<{ parameters: Parameters; content: Content | null }> {
  const businessId = requireBusiness(command.context);
  const parameters: Parameters = {};
  if (input.action === 'add_tags' || input.action === 'remove_tags') {
    if (input.action === 'remove_tags' && input.all === true) parameters.allTags = true;
    const named = input.tagIds ?? [];
    const ids = named.map((tagId) => parsePublicId('tag', tagId) ?? '');
    const known =
      ids.length === 0
        ? []
        : await trx
            .selectFrom('crm.tags')
            .select('id')
            .where('business_id', '=', businessId)
            .where('id', 'in', ids)
            .execute();
    const have = new Set(known.map((row) => row.id));
    const issues = ids.flatMap((id, index) =>
      have.has(id)
        ? []
        : [
            {
              path: `/tagIds/${String(index)}`,
              code: 'unknown_tag',
              message: 'Choose a tag of this business.',
            },
          ],
    );
    const [first, ...rest] = issues;
    if (first !== undefined) throw new ValidationError([first, ...rest]);
    if (ids.length > 0) parameters.tagIds = ids;
    return { parameters, content: null };
  }
  if (input.action === 'assign_owner') {
    const owner =
      input.owner === null ? null : await memberOf(options, trx, command, input.owner, '/owner');
    parameters.ownerUserId = owner;
    // Kept as a membership, which is how the single command is told who: "me" is
    // whoever started the action, not whoever runs its batches.
    parameters.ownerMembership =
      owner === null
        ? null
        : ((await options.assignees.memberships(trx, command.context, [owner])).get(owner) ?? null);
    return { parameters, content: null };
  }
  if (input.action === 'add_to_workflow') {
    // Only a published workflow that is not paused, as GoHighLevel's article says.
    const found = await options.workflows?.resolve(trx, command, input.workflowId);
    if (found === undefined || found === 'not_found')
      throw invalid({
        path: '/workflowId',
        code: 'unknown_workflow',
        message: 'Choose a workflow of this business.',
      });
    if (found === 'not_published')
      throw invalid({
        path: '/workflowId',
        code: 'workflow_not_published',
        message: 'Choose a published workflow that is not paused.',
      });
    parameters.workflowId = found.id;
    return { parameters, content: null };
  }
  if (input.action === 'export') {
    if (options.files === undefined)
      throw invalid({
        path: '/action',
        code: 'export_unavailable',
        message: "This install has no file storage, so it can't keep an export.",
      });
    const checked = await checkExportColumns(trx, businessId, input.columns);
    if (!checked.ok)
      throw invalid({
        path: `/columns/${String(checked.at)}`,
        code: 'unknown_field',
        message: 'Choose a field of contacts in this business.',
      });
    parameters.columns = checked.columns;
    return { parameters, content: null };
  }
  if (input.action === 'send_email' || input.action === 'send_sms') {
    if (options.messages === undefined)
      throw invalid({
        path: '/action',
        code: 'sending_unavailable',
        message: "This install can't send messages.",
      });
    const content: Content =
      input.action === 'send_sms'
        ? { message: input.message }
        : {
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.fromName === undefined ? {} : { fromName: input.fromName }),
          };
    const sender = input.action === 'send_sms' ? input.number : input.mailbox;
    if (sender !== undefined) parameters.sender = sender;
    if (input.action === 'send_email' && input.templateId !== undefined)
      parameters.templateId = input.templateId;
    const issue = await options.messages.check(
      trx,
      command,
      messageOf(input.action, parameters, content),
    );
    if (issue !== undefined) throw invalid(issue);
    return { parameters, content };
  }
  if (input.action === 'verify_emails') {
    if (options.emailChecks === undefined)
      throw invalid({
        path: '/action',
        code: 'verification_unavailable',
        message: "This install can't verify email addresses.",
      });
    if (!(await options.emailChecks.enabled(trx, command)))
      throw invalid({
        path: '/action',
        code: 'verification_off',
        message:
          'Turn on email verification in Settings → Email Services → Email Verification first.',
      });
    return { parameters, content: null };
  }
  if (input.action === 'set_dnd') {
    parameters.dnd = input.dnd;
    parameters.dndChannels = input.channels;
    return { parameters, content: { reason: input.reason } };
  }
  if (input.action === 'add_opportunity') {
    const pipelineId = parsePublicId('pipeline', input.pipelineId) ?? '';
    let stages = trx
      .selectFrom('crm.pipeline_stages as s')
      .innerJoin('crm.pipelines as p', (join) =>
        join.onRef('p.business_id', '=', 's.business_id').onRef('p.id', '=', 's.pipeline_id'),
      )
      .select('s.id')
      .where('s.business_id', '=', businessId)
      .where('s.pipeline_id', '=', pipelineId)
      .where('s.archived_at', 'is', null)
      .where('p.archived_at', 'is', null);
    // Left out, the pipeline's first stage, as GoHighLevel's Create Opportunity does.
    if (input.stageId !== undefined)
      stages = stages.where('s.id', '=', parsePublicId('stage', input.stageId) ?? '');
    const stage = await stages.orderBy('s.position').orderBy('s.id').executeTakeFirst();
    if (stage === undefined)
      throw invalid({
        path: input.stageId === undefined ? '/pipelineId' : '/stageId',
        code: 'unavailable',
        message:
          input.stageId === undefined
            ? 'Choose an active pipeline of this business.'
            : 'Choose an active stage in this pipeline.',
      });
    const business = await trx
      .selectFrom('tenancy.businesses')
      .select('currency')
      .where('id', '=', businessId)
      .executeTakeFirstOrThrow();
    Object.assign(parameters, {
      pipelineId,
      stageId: stage.id,
      dealStatus: input.status,
      currency: business.currency,
      allowDuplicates: input.allowDuplicates,
      ...(input.amount === undefined ? {} : { amount: input.amount }),
    });
    return {
      parameters,
      content: {
        ...(input.opportunityName === undefined ? {} : { opportunityName: input.opportunityName }),
        ...(input.source === undefined ? {} : { source: input.source }),
      },
    };
  }
  return { parameters, content: null };
}

type WholeList = Exclude<z.output<typeof bulkContactsInput>['selection'], { ids: unknown }>;

/** The list a whole-list selection is, with its search and filters. */
const selectionScope = (
  trx: DatabaseTransaction,
  invocation: Invocation,
  selection: WholeList,
  options: ContactBulkOptions,
) =>
  contactListScope(
    trx,
    invocation,
    {
      q: selection.q,
      createdFrom: selection.createdFrom,
      createdBefore: selection.createdBefore,
      fieldId: selection.fieldId,
      fieldOperator: selection.fieldOperator,
      fieldValue: selection.fieldValue,
      filter: selection.filter === undefined ? undefined : JSON.stringify(selection.filter),
    },
    options,
  );

/**
 * The contacts a selection holds now, in the list's order, as an action fixes them when it
 * starts: the ones named, or the whole list less those left out. Refused, as starting an
 * action is, when it holds none or more than an action may cover.
 */
async function selectedContacts(
  trx: DatabaseTransaction,
  invocation: Invocation,
  selection: z.output<typeof bulkContactsInput>['selection'],
  options: ContactBulkOptions,
): Promise<string[]> {
  if ('ids' in selection) return selection.ids.map((id) => parsePublicId('contact', id) ?? '');
  const scope = await selectionScope(trx, invocation, selection, options);
  const except = (selection.except ?? []).map((id) => parsePublicId('contact', id) ?? '');
  const { rows } = await sql<{ id: string }>`
    select c.id from crm.contacts c
    where ${scope.test} and c.id <> all(${except}::uuid[])
    limit ${CONTACT_BULK_LIMIT + 1}`.execute(trx);
  if (rows.length === 0)
    throw invalid({
      path: '/selection',
      code: 'empty_selection',
      message: 'No contact matches this selection.',
    });
  if (rows.length > CONTACT_BULK_LIMIT)
    throw invalid({
      path: '/selection',
      code: 'too_many_contacts',
      message: `Select at most ${String(CONTACT_BULK_LIMIT)} contacts at a time.`,
    });
  return rows.map((row) => row.id);
}

/**
 * What "Verify emails" would do for a selection: how many contacts, how many keep a current
 * result for free, how many would be checked and use a provider credit, and how many are
 * skipped. Read for the confirm dialog; nothing is queued.
 */
export async function previewContactEmailChecks(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: z.output<typeof previewContactEmailChecksInput>,
  options: ContactBulkOptions,
): Promise<ContactEmailCheckPreview> {
  if (options.emailChecks === undefined)
    throw invalid({
      path: '/selection',
      code: 'verification_unavailable',
      message: "This install can't verify email addresses.",
    });
  const named = await selectedContacts(trx, invocation, input.selection, options);
  // Only this business's contacts outside the trash are counted, as an action skips the rest.
  const live = await trx
    .selectFrom('crm.contacts')
    .select('id')
    .where('business_id', '=', requireBusiness(invocation.context))
    .where('id', '=', sql<string>`any(${named}::uuid[])`)
    .where('deleted_at', 'is', null)
    .execute();
  return options.emailChecks.preview(
    trx,
    invocation,
    live.map((row) => row.id),
  );
}

/** The bulk commands, made with what they need of the modules that own the team and names. */
export function contactBulkCommands(options: ContactBulkOptions): ContactBulkCommands {
  const apply = appliers(options);

  const start = defineCommand({
    name: 'contact.bulk',
    permission: 'contacts.manage',
    input: bulkContactsInput,
    // What was asked and of how many: ids and settings, and for a selection by hand its ids.
    // Never a search's words or a filter's values, a message or an opportunity's name,
    // which can hold anything a person typed; the reason do not disturb changes is kept,
    // as the single change keeps it.
    audit: (input) => ({
      action: input.action,
      ...('tagIds' in input && input.tagIds !== undefined ? { tagIds: input.tagIds } : {}),
      ...('all' in input && input.all === true ? { allTags: true } : {}),
      ...('owner' in input ? { owner: input.owner } : {}),
      ...('workflowId' in input ? { workflowId: input.workflowId } : {}),
      ...('columns' in input ? { columns: input.columns } : {}),
      ...('number' in input && input.number !== undefined ? { number: input.number } : {}),
      ...('mailbox' in input && input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
      ...('templateId' in input && input.templateId !== undefined
        ? { templateId: input.templateId }
        : {}),
      ...(input.action === 'set_dnd'
        ? { dnd: input.dnd, channels: input.channels, reason: input.reason }
        : {}),
      ...(input.action === 'add_opportunity'
        ? {
            pipelineId: input.pipelineId,
            ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
            status: input.status,
            allowDuplicates: input.allowDuplicates,
          }
        : {}),
      ...('delivery' in input && input.delivery !== undefined ? { delivery: input.delivery } : {}),
      selection:
        'ids' in input.selection
          ? { ids: input.selection.ids }
          : { all: true, except: input.selection.except ?? [] },
    }),
    async handle(trx, input, command): Promise<ContactBulkAction> {
      const businessId = requireBusiness(command.context);
      requireAlso(command, ALSO_NEEDS[input.action]);

      // The same request again is the action it started the first time. The unique index
      // settles two that arrive together: the second waits, then fails on the key, and its
      // retry finds the first one's action.
      if (input.requestId !== undefined) {
        const earlier = await actions(trx, businessId)
          .where('request_key', '=', input.requestId)
          .executeTakeFirst();
        if (earlier !== undefined) {
          const [shown] = await present(trx, command, [earlier], options);
          if (shown !== undefined) return shown;
        }
      }

      const { parameters, content } = await resolve(trx, command, input, options);
      const delivery = 'delivery' in input ? input.delivery : undefined;
      const drip = delivery?.drip;
      const startAt = delivery?.startAt;
      const later = startAt !== undefined && (await ahead(trx, startAt));
      // What a person wrote waits with the action, so it may not wait for long.
      if (startAt !== undefined && (await tooFar(trx, startAt)))
        throw invalid({
          path: '/delivery/startAt',
          code: 'too_far',
          message: `Start within ${String(LATEST_START_DAYS)} days.`,
        });

      const created = await trx
        .insertInto('crm.contact_bulk_actions')
        .values({
          business_id: businessId,
          name: input.name ?? null,
          action: input.action,
          parameters: JSON.stringify(parameters),
          content: content === null ? null : JSON.stringify(content),
          // Set below, once the contacts are counted; 1 satisfies the row's own rule.
          requested_count: 1,
          request_key: input.requestId ?? null,
          actor_kind: command.context.actorKind,
          actor_id: command.context.actorId ?? null,
          ...(drip === undefined
            ? {}
            : {
                drip_batch_size: drip.batchSize,
                drip_interval_seconds: drip.intervalMinutes * 60,
                window_end: drip.batchSize,
              }),
          ...(startAt !== undefined && later ? { next_run_at: startAt } : {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      let requested: number;
      if ('ids' in input.selection) {
        const ids = input.selection.ids.map((id) => parsePublicId('contact', id) ?? '');
        await trx
          .insertInto('crm.contact_bulk_action_items')
          .values(
            ids.map((contactId, index) => ({
              business_id: businessId,
              bulk_action_id: created.id,
              position: index + 1,
              contact_id: contactId,
            })),
          )
          .execute();
        requested = ids.length;
      } else {
        // The list as it is now, in its own order, less the contacts left out. One more
        // than the limit is asked for, so that too many is told from exactly enough.
        const scope = await selectionScope(trx, command, input.selection, options);
        const except = (input.selection.except ?? []).map(
          (id) => parsePublicId('contact', id) ?? '',
        );
        const { numAffectedRows } = await sql`
          insert into crm.contact_bulk_action_items (business_id, bulk_action_id, position, contact_id)
          select ${businessId}, ${created.id}, row_number() over (order by chosen.created_at desc, chosen.id desc), chosen.id
          from (
            select c.id, c.created_at from crm.contacts c
            where ${scope.test} and c.id <> all(${except}::uuid[])
            limit ${CONTACT_BULK_LIMIT + 1}
          ) chosen
        `.execute(trx);
        requested = Number(numAffectedRows ?? 0);
        if (requested === 0)
          throw invalid({
            path: '/selection',
            code: 'empty_selection',
            message: 'No contact matches this selection.',
          });
        if (requested > CONTACT_BULK_LIMIT)
          throw invalid({
            path: '/selection',
            code: 'too_many_contacts',
            message: `Select at most ${String(CONTACT_BULK_LIMIT)} contacts at a time.`,
          });
      }
      let row: ActionRow = await trx
        .updateTable('crm.contact_bulk_actions')
        .set({ requested_count: requested })
        .where('business_id', '=', businessId)
        .where('id', '=', created.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // A few contacts, now and in one go, are changed before the request answers: one
      // batch's worth. An export is always the worker's, which writes its file; an action
      // for later or in drip mode waits for its time.
      if (later || drip !== undefined) await runAt(trx, row.id, row.next_run_at ?? 'now');
      else if (requested <= batchOf(input.action) && input.action !== 'export') {
        ({ row } = await applyBatch(trx, command, apply, row, options));
        // A bulk email held back by the agency's ceiling goes on in the background.
        if (!ENDED.includes(row.status) && row.next_run_at === null)
          command.enqueue(runContactBulkReference, { bulkActionId: row.id });
      } else command.enqueue(runContactBulkReference, { bulkActionId: row.id });
      const [shown] = await present(trx, command, [row], options);
      if (shown === undefined) throw new Error('A bulk action was not presented.');
      return shown;
    },
  });

  const batch = defineCommand({
    name: 'contact.bulk.apply_batch',
    permission: 'contacts.manage',
    input: applyBatchInput,
    async handle(trx, input, command): Promise<{ state: BatchState }> {
      const businessId = requireBusiness(command.context);
      // Held for the batch: a second run of the job waits here, then finds these contacts
      // have their outcomes and takes the ones after them.
      const action = await actions(trx, businessId)
        .where('id', '=', input.bulkActionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (action === undefined || ENDED.includes(action.status)) return { state: 'ended' };
      // Its time has not come: a job is queued for it.
      if (await ahead(trx, action.next_run_at)) return { state: 'waiting' };
      // Whoever started it is asked again, before each batch: someone taken off the team,
      // or who may no longer do this, does not go on doing it through the action.
      const refusal = await starterRefusal(trx, command, action, options);
      if (refusal !== undefined) {
        await failAction(trx, businessId, action.id, refusal);
        return { state: 'ended' };
      }
      const { state } = await applyBatch(trx, command, apply, action, options);
      return { state };
    },
  });

  // The export's file is written and kept in the transaction that ends the action, which
  // holds the action's row: the file is the action's or there is none, a run of the job
  // again never keeps a second one, and an export stopped meanwhile keeps nothing.
  const finishExport = defineCommand({
    name: 'contact.bulk.finish_export',
    permission: 'contacts.manage',
    input: applyBatchInput,
    async handle(trx, input, command): Promise<{ ended: boolean }> {
      const businessId = requireBusiness(command.context);
      const action = await actions(trx, businessId)
        .where('id', '=', input.bulkActionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (action === undefined || ENDED.includes(action.status) || action.action !== 'export')
        return { ended: false };
      const refusal = await starterRefusal(trx, command, action, options);
      if (refusal !== undefined) {
        await failAction(trx, businessId, action.id, refusal);
        return { ended: true };
      }
      const { files } = options;
      let failure: ExportFailure | undefined;
      let fileId: string | undefined;
      if (files === undefined) failure = 'files_unavailable';
      else {
        const columns = storedParameters.parse(action.parameters).columns ?? [];
        const content = await exportContent(trx, businessId, action.id, columns, files.maxBytes);
        if (content === 'too_large') failure = 'file_too_large';
        else {
          await sql`savepoint export_file`.execute(trx);
          try {
            const stored = await files.store(trx, command, {
              filename: exportFileName(action.name, action.created_at),
              contentType: 'text/csv',
              content,
              purpose: 'contact_export',
              quota: true,
            });
            await sql`release savepoint export_file`.execute(trx);
            fileId = parsePublicId('file', stored.id);
          } catch (error) {
            await sql`rollback to savepoint export_file`.execute(trx);
            await sql`release savepoint export_file`.execute(trx);
            // The files service refused it by name: it ends saying why. Anything else is a
            // fault, which the job runs again.
            failure =
              error instanceof ContentTooLargeError
                ? 'file_too_large'
                : error instanceof ValidationError &&
                    error.issues.some((issue) => issue.code === 'storage_full')
                  ? 'storage_full'
                  : error instanceof ValidationError
                    ? 'file_refused'
                    : undefined;
            if (failure === undefined) throw error;
          }
        }
      }
      if (failure !== undefined || fileId === undefined) {
        await failAction(trx, businessId, action.id, failure ?? 'file_refused');
        return { ended: true };
      }
      const row = await trx
        .updateTable('crm.contact_bulk_actions')
        .set({
          status: 'completed',
          finished_at: sql<Date>`now()`,
          file_id: fileId,
          content: null,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', action.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // Kept thirty days, as GoHighLevel keeps an export, then removed.
      if (row.finished_at !== null)
        await runAt(trx, row.id, keptUntil(row.finished_at), expireContactExportReference.name);
      return { ended: true };
    },
  });

  // An export's file goes when it has been kept long enough: its bytes and its row, through
  // the files service. The action stays, saying its file has expired.
  const expireExport = defineCommand({
    name: 'contact.bulk.expire_export',
    permission: 'contacts.manage',
    input: applyBatchInput,
    async handle(trx, input, command): Promise<{ removed: boolean }> {
      const businessId = requireBusiness(command.context);
      const action = await actions(trx, businessId)
        .where('id', '=', input.bulkActionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (action?.file_id === undefined || action.file_id === null || action.finished_at === null)
        return { removed: false };
      // A job early by the clock waits for its time again.
      if (keptUntil(action.finished_at) > new Date()) {
        await runAt(
          trx,
          action.id,
          keptUntil(action.finished_at),
          expireContactExportReference.name,
        );
        return { removed: false };
      }
      const { files } = options;
      if (files === undefined)
        throw new Error('An export file cannot be removed without the files service.');
      await sql`savepoint expire_file`.execute(trx);
      try {
        await files.discard(trx, command, action.file_id);
        await sql`release savepoint expire_file`.execute(trx);
      } catch (error) {
        await sql`rollback to savepoint expire_file`.execute(trx);
        await sql`release savepoint expire_file`.execute(trx);
        // Already gone is what was asked for.
        if (!(error instanceof NotFoundError)) throw error;
      }
      await trx
        .updateTable('crm.contact_bulk_actions')
        .set({ file_id: null })
        .where('business_id', '=', businessId)
        .where('id', '=', action.id)
        .execute();
      return { removed: true };
    },
  });

  const cancel = defineCommand({
    name: 'contact.bulk.cancel',
    permission: 'contacts.manage',
    input: contactBulkActionIdInput,
    async handle(trx, input, command): Promise<ContactBulkAction> {
      const businessId = requireBusiness(command.context);
      // Held: a batch holds the row for its length, so once this has it no batch is in
      // hand, and the action stops at once. What was done stays done; a job still queued
      // finds it ended, and a job that died leaves nothing behind it running.
      const action = await actionOf(trx, businessId, input.id, true);
      let row = action;
      if (!ENDED.includes(action.status))
        row = await trx
          .updateTable('crm.contact_bulk_actions')
          .set({
            cancel_requested_at: sql<Date>`now()`,
            status: 'cancelled',
            finished_at: sql<Date>`now()`,
            content: null,
          })
          .where('business_id', '=', businessId)
          .where('id', '=', action.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      const [shown] = await present(trx, command, [row], options);
      if (shown === undefined) throw new Error('A bulk action was not presented.');
      return shown;
    },
  });

  return { start, applyBatch: batch, finishExport, expireExport, cancel };
}

/** Who started an action and what its file is to hold, for the job that runs it. */
export async function readContactBulkRun(
  trx: DatabaseTransaction,
  businessId: string,
  bulkActionId: string,
): Promise<
  | {
      readonly actorKind: string;
      readonly actorId: string | null;
      readonly name: string | null;
      readonly createdAt: Date;
      readonly columns: readonly string[];
    }
  | undefined
> {
  const row = await actions(trx, businessId).where('id', '=', bulkActionId).executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    name: row.name,
    createdAt: row.created_at,
    columns: storedParameters.parse(row.parameters).columns ?? [],
  };
}

/** The stored id of an export's file, for a link to it, or why there is none. */
export async function readContactExportFile(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<{ readonly fileId: string } | 'expired' | 'none'> {
  const row = await actionOf(trx, requireBusiness(invocation.context), id);
  if (row.file_id !== null) return { fileId: row.file_id };
  return row.action === 'export' && row.status === 'completed' ? 'expired' : 'none';
}

export async function readContactBulkAction(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: ContactBulkOptions,
): Promise<ContactBulkAction> {
  const row = await actionOf(trx, requireBusiness(invocation.context), id);
  const [shown] = await present(trx, invocation, [row], options);
  if (shown === undefined) throw notFound(id);
  return shown;
}

export async function readContactBulkActions(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof contactBulkActionsQuery>,
  options: ContactBulkOptions,
): Promise<ContactBulkActionList> {
  let selection = actions(trx, requireBusiness(invocation.context));
  if (query.action !== undefined) selection = selection.where('action', '=', query.action);
  if (query.status !== undefined) selection = selection.where('status', '=', query.status);
  // Ids are UUIDv7, so newest first is by id.
  if (query.after !== undefined)
    selection = selection.where('id', '<', parsePublicId('bulk_action', query.after) ?? '');
  const rows = await selection
    .orderBy('id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: await present(trx, invocation, page, options),
    next:
      rows.length > query.limit && last !== undefined ? toPublicId('bulk_action', last.id) : null,
  };
}

export async function readContactBulkItems(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  query: z.output<typeof contactBulkItemsQuery>,
): Promise<ContactBulkItemList> {
  const businessId = requireBusiness(invocation.context);
  const action = await actionOf(trx, businessId, id);
  let selection = trx
    .selectFrom('crm.contact_bulk_action_items as item')
    .leftJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'item.business_id')
        .onRef('contact.id', '=', 'item.contact_id'),
    )
    .select([
      'item.position',
      'item.contact_id',
      'item.outcome',
      'item.reason',
      'contact.display_name',
    ])
    .where('item.business_id', '=', businessId)
    .where('item.bulk_action_id', '=', action.id);
  if (query.outcome === 'pending') selection = selection.where('item.outcome', 'is', null);
  else if (query.outcome !== undefined)
    selection = selection.where('item.outcome', '=', query.outcome);
  if (query.after !== undefined) selection = selection.where('item.position', '>', query.after);
  const rows = await selection
    .orderBy('item.position')
    .limit(query.limit + 1)
    .execute();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const code = isSkipCode(row.reason) ? row.reason : row.reason === null ? null : 'refused';
      return {
        contactId: toPublicId('contact', row.contact_id),
        name: row.display_name,
        outcome:
          row.outcome === 'done' || row.outcome === 'unchanged' || row.outcome === 'skipped'
            ? row.outcome
            : null,
        reason:
          code === null
            ? null
            : {
                code,
                message:
                  code === 'no_address' && action.action === 'verify_emails'
                    ? NO_EMAIL_TO_VERIFY
                    : SKIP_WORDS[code],
              },
      };
    }),
    next: rows.length > query.limit && last !== undefined ? last.position : null,
  };
}
