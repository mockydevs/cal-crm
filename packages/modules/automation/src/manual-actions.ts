// Manual actions: a call to place or a text to send by hand, left by a manual.call or
// manual.sms step. The step never dials or sends: it puts an action in the queue and the
// run waits at the step, with no timeout, until a person completes or skips the action; the
// step then runs again and the run goes on. A run that ends any other way takes its open
// action off the queue (migration 0065's trigger).
//
// Lock order: the run (its enrolment row) before its action, as the runner and that
// trigger take them.
import { createHash } from 'node:crypto';
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  assignManualAction,
  assignManualActionInput,
  closeManualActionInput,
  completeManualAction,
  MANUAL_ACTION_LIMITS,
  type AutomationStep,
  type ConditionValues,
  type ListManualActionsQuery,
  type ManualAction,
  type ManualActionList,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  AppError,
  ConflictError,
  isUuidV7,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import type { ActorNames, TaskOptions } from '@repo/module-crm';
import { renderWithTriggerLinks, SMS_BODY_MAX } from '@repo/module-messaging';
import { sql, type SqlBool } from 'kysely';
import * as z from 'zod';

import { queueStep } from './queue-step.js';
import type { StepPlan } from './steps.js';

export type ManualStep = Extract<AutomationStep, { type: 'manual.call' | 'manual.sms' }>;

export const isManualStep = (step: AutomationStep): step is ManualStep =>
  step.type === 'manual.call' || step.type === 'manual.sms';

/** What manual actions need from other modules, as the task and inbox routes get them. */
export interface ManualActionOptions {
  readonly assignees: TaskOptions['assignees'];
  readonly actorNames: ActorNames;
}

/** What an enrolment keeps while it waits on a manual action. */
const manualState = z.strictObject({
  step: z.string(),
  actionId: z.uuid(),
  /** Set by whoever closes the action; the step then runs again and takes it. */
  outcome: z.enum(['completed', 'skipped']).optional(),
});
type ManualState = z.output<typeof manualState>;

/** The manual action an enrolment's state says it waits on, if any. */
export function manualWait(state: unknown): ManualState | undefined {
  const parsed = z.looseObject({ manual: manualState.optional() }).safeParse(state);
  return parsed.success ? parsed.data.manual : undefined;
}

// The nil UUID, which no row has: an id that is not one names nothing.
const NOTHING = '00000000-0000-0000-0000-000000000000';

const failed = (error: string, explanation: string): StepPlan => ({
  kind: 'fail',
  error,
  explanation,
});

// Who the action is for: the step's own choice when that person is on the team, else the
// contact's owner when they are, else nobody, and anyone may take it.
async function assigneeOf(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: ManualActionOptions,
  chosen: string | undefined,
  contactId: string,
): Promise<string | null> {
  if (chosen !== undefined) {
    await sql`savepoint manual_assignee`.execute(trx);
    try {
      const user = await options.assignees.resolve(trx, command.context, chosen);
      await sql`release savepoint manual_assignee`.execute(trx);
      if (user !== null) return user;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // Someone who has left the team since the automation was published.
      await sql`rollback to savepoint manual_assignee`.execute(trx);
    }
  }
  const contact = await trx
    .selectFrom('crm.contacts')
    .select('owner_user_id')
    .where('id', '=', contactId)
    .executeTakeFirst();
  const owner = contact?.owner_user_id ?? null;
  if (owner === null) return null;
  return (await options.assignees.memberships(trx, command.context, [owner])).has(owner)
    ? owner
    : null;
}

/**
 * A visit to a manual step. The first puts the action in the queue and leaves the run
 * waiting at the step; the one after the action is closed takes its outcome as the step's
 * plan. 'waiting' when the run now waits; 'idle' when it was woken with nothing decided.
 */
export async function visitManualAction(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: ManualActionOptions & { readonly publicUrl?: string | undefined },
  input: {
    readonly businessId: string;
    readonly enrolmentId: string;
    readonly automationId: string;
    readonly versionId: string;
    readonly recordId: string;
    readonly recordKind: string;
    readonly stepKey: string;
    readonly step: ManualStep;
    readonly state: Readonly<Record<string, unknown>>;
    readonly sequence: number;
    readonly values: ConditionValues;
  },
): Promise<StepPlan | 'waiting' | 'idle'> {
  const waiting = manualWait(input.state);
  const next = typeof input.step.next === 'string' ? input.step.next : null;
  if (waiting?.step === input.stepKey) {
    if (waiting.outcome === undefined) return 'idle';
    return {
      kind: 'next',
      next,
      branch: null,
      output: { outcome: waiting.outcome },
      explanation:
        waiting.outcome === 'completed'
          ? 'The manual action was completed.'
          : 'The manual action was skipped.',
    };
  }

  const kind = input.step.type === 'manual.sms' ? 'sms' : 'call';
  if (input.recordKind !== 'contact')
    return failed('unsupported_record', `A ${input.recordKind} can't be called or sent a text.`);
  const phone = await trx
    .selectFrom('crm.contact_identities')
    .select('id')
    .where('contact_id', '=', input.recordId)
    .where('kind', '=', 'phone')
    .where('is_primary', '=', true)
    .executeTakeFirst();
  if (phone === undefined)
    return failed('no_phone_number', 'The contact has no phone number to call or text.');
  const text =
    input.step.type === 'manual.sms' ? input.step.config.message : (input.step.config.notes ?? '');
  // Filled in now, for this contact, so the queue shows what to say as it will be said.
  const rendered = await renderWithTriggerLinks(trx, command.context, {
    contactId: input.recordId,
    text: { subject: '', body: text },
    values: input.values,
    publicUrl: options.publicUrl,
  });
  if (!rendered.ok)
    return failed('missing_values', `The contact has no value for ${rendered.fields.join(', ')}.`);
  const limit = kind === 'sms' ? SMS_BODY_MAX : MANUAL_ACTION_LIMITS.body;
  if (rendered.body.length > limit)
    return failed(
      'manual_body_too_long',
      `Filled in, the text is ${String(rendered.body.length)} characters; this step holds ${String(limit)} at most.`,
    );
  const assignee = await assigneeOf(trx, command, options, input.step.config.user, input.recordId);
  const action = await trx
    .insertInto('automation.manual_actions')
    .values({
      business_id: input.businessId,
      automation_id: input.automationId,
      enrolment_id: input.enrolmentId,
      step_key: input.stepKey,
      contact_id: input.recordId,
      kind,
      body: rendered.body,
      assignee_user_id: assignee,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('automation.step_runs')
    .values({
      business_id: input.businessId,
      enrolment_id: input.enrolmentId,
      automation_id: input.automationId,
      version_id: input.versionId,
      step_key: input.stepKey,
      status: 'waiting',
      input: JSON.stringify({
        sequence: input.sequence,
        type: input.step.type,
        config: input.step.config,
      }),
      output: JSON.stringify({ manualActionId: toPublicId('manual_action', action.id) }),
      // Waiting, and unfinished, until the step runs again with the action's outcome.
      explanation:
        kind === 'sms'
          ? 'Manual text added to the manual actions queue.'
          : 'Manual call added to the manual actions queue.',
    })
    .execute();
  const armed: ManualState = { step: input.stepKey, actionId: action.id };
  await trx
    .updateTable('automation.enrolments')
    .set({
      status: 'waiting',
      // No timeout: only closing the action, or ending the run, moves it on.
      wake_at: null,
      updated_at: sql<Date>`now()`,
      state: JSON.stringify({ ...input.state, sequence: input.sequence + 1, manual: armed }),
    })
    .where('id', '=', input.enrolmentId)
    .execute();
  // On the contact's timeline, and what tells whoever it is for.
  await command.emit({
    type: 'manual_action.created',
    subject: { kind: 'manual_action', id: action.id },
    records: [input.recordId],
    payload: {
      type: kind,
      automationId: toPublicId('automation', input.automationId),
      ...(assignee === null ? {} : { assignedUserId: assignee }),
    },
  });
  return 'waiting';
}

// The queue ---------------------------------------------------------------------------

interface ActionRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly body: string;
  readonly contact_id: string;
  readonly contact_name: string;
  readonly contact_phone: string | null;
  readonly contact_trashed: boolean;
  readonly automation_id: string;
  readonly automation_name: string;
  readonly enrolment_id: string;
  readonly assignee_user_id: string | null;
  readonly created_at: Date;
  readonly closed_at: Date | null;
  readonly closed_by_kind: string | null;
  readonly closed_by_id: string | null;
  /** created_at to the microsecond, which a JavaScript Date would round away. */
  readonly position: string;
}

// Everything a person can change about an action: whose it is, and whether it is open.
const revisionOf = (row: Pick<ActionRow, 'id' | 'status' | 'assignee_user_id'>): string =>
  createHash('sha256')
    .update(JSON.stringify([row.id, row.status, row.assignee_user_id]))
    .digest('hex');

type WorkPermission = 'conversations.manage' | 'conversations.reply';
const allows = (invocation: Invocation, permission: WorkPermission): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has(permission);

/** The permission a caller who may work the queue has, or the one to refuse them by. */
export const manualActionPermission = (invocation: Invocation): WorkPermission =>
  !allows(invocation, 'conversations.manage') && allows(invocation, 'conversations.reply')
    ? 'conversations.reply'
    : 'conversations.manage';

function actions(trx: DatabaseTransaction) {
  return trx
    .selectFrom('automation.manual_actions as m')
    .innerJoin('crm.contacts as k', (join) =>
      join.onRef('k.business_id', '=', 'm.business_id').onRef('k.id', '=', 'm.contact_id'),
    )
    .innerJoin('automation.automations as a', (join) =>
      join.onRef('a.business_id', '=', 'm.business_id').onRef('a.id', '=', 'm.automation_id'),
    )
    .select([
      'm.id',
      'm.kind',
      'm.status',
      'm.body',
      'm.contact_id',
      'm.automation_id',
      'a.name as automation_name',
      'm.enrolment_id',
      'm.assignee_user_id',
      'm.created_at',
      'm.closed_at',
      'm.closed_by_kind',
      'm.closed_by_id',
      sql<string>`to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'position',
      ),
      sql<string>`coalesce(k.display_name, (
        select i.value_normalized from crm.contact_identities i
        where i.business_id = k.business_id and i.contact_id = k.id and i.is_primary
        order by i.kind limit 1), '')`.as('contact_name'),
      sql<string | null>`(
        select i.value_normalized from crm.contact_identities i
        where i.business_id = k.business_id and i.contact_id = k.id and i.is_primary
          and i.kind = 'phone' limit 1)`.as('contact_phone'),
      sql<boolean>`k.deleted_at is not null`.as('contact_trashed'),
    ]);
}

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly ActionRow[],
  options: ManualActionOptions,
): Promise<ManualAction[]> {
  const userIds = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.assignee_user_id === null ? [] : [row.assignee_user_id]),
        ...(row.closed_by_kind === 'user' && row.closed_by_id !== null ? [row.closed_by_id] : []),
      ]),
    ),
  ];
  const memberships = await options.assignees.memberships(trx, invocation.context, userIds);
  const lookup = options.actorNames.user;
  const names =
    lookup === undefined || userIds.length === 0
      ? new Map<string, string>()
      : await lookup(trx, userIds);
  const person = (userId: string | null) =>
    userId === null
      ? null
      : {
          membershipId: memberships.get(userId) ?? null,
          name: names.get(userId) ?? null,
          you: invocation.context.actorKind === 'user' && userId === invocation.context.userId,
        };
  return rows.map((row) => ({
    id: toPublicId('manual_action', row.id),
    type: row.kind === 'sms' ? 'sms' : 'call',
    status: z.enum(['pending', 'completed', 'skipped', 'cancelled']).parse(row.status),
    body: row.body,
    contact: {
      id: toPublicId('contact', row.contact_id),
      name: row.contact_name,
      phone: row.contact_phone,
      trashed: row.contact_trashed,
    },
    automation: { id: toPublicId('automation', row.automation_id), name: row.automation_name },
    runId: toPublicId('automation_enrolment', row.enrolment_id),
    assignee: person(row.assignee_user_id),
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    closedBy: row.closed_by_kind === 'user' ? person(row.closed_by_id) : null,
    revision: revisionOf(row),
  }));
}

async function requireAction(trx: DatabaseTransaction, actionId: string): Promise<ActionRow> {
  const row = await actions(trx)
    .where('m.id', '=', parsePublicId('manual_action', actionId) ?? NOTHING)
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Manual action', actionId);
  return row;
}

/**
 * The action, with its run and then itself held for a write (the lock order above), read
 * again once held: what it was before the wait may have changed.
 */
async function holdAction(trx: DatabaseTransaction, actionId: string): Promise<ActionRow> {
  const seen = await requireAction(trx, actionId);
  await trx
    .selectFrom('automation.enrolments')
    .select('id')
    .where('id', '=', seen.enrolment_id)
    .forUpdate()
    .executeTakeFirst();
  await trx
    .selectFrom('automation.manual_actions')
    .select('id')
    .where('id', '=', seen.id)
    .forUpdate()
    .executeTakeFirst();
  return requireAction(trx, actionId);
}

function requireWritable(row: ActionRow, revision: string): void {
  if (revisionOf(row) !== revision)
    throw new ConflictError('This action changed. Read it again before changing it.');
  if (row.status !== 'pending')
    throw new ConflictError(`This action is already ${row.status}, so nothing more is done to it.`);
}

/** One action, for whoever may work the queue. */
export async function readManualAction(
  trx: DatabaseTransaction,
  invocation: Invocation,
  actionId: string,
  options: ManualActionOptions,
): Promise<ManualAction> {
  requireBusiness(invocation.context);
  const [action] = await present(trx, invocation, [await requireAction(trx, actionId)], options);
  if (action === undefined) throw new NotFoundError('Manual action', actionId);
  return action;
}

const encodeCursor = (position: string, id: string): string =>
  Buffer.from(JSON.stringify([position, id])).toString('base64url');

function decodeCursor(cursor: string): readonly [position: string, id: string] {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(decoded) && decoded.length === 2) {
      const pair: readonly unknown[] = decoded;
      const [position, id] = pair;
      if (
        typeof position === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(position) &&
        typeof id === 'string' &&
        isUuidV7(id)
      )
        return [position, id];
    }
  } catch {
    // Not a cursor this list gave: answered below, like any other that isn't.
  }
  throw new ValidationError([
    {
      path: '/after',
      code: 'invalid_cursor',
      message: 'Start from the next a page of this list gave.',
    },
  ]);
}

/** A page of the queue, oldest first, and how many actions match. */
export async function readManualActions(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListManualActionsQuery,
  options: ManualActionOptions,
): Promise<ManualActionList> {
  requireBusiness(invocation.context);
  let matching = actions(trx);
  if (query.status !== 'all') matching = matching.where('m.status', '=', query.status);
  if (query.type !== undefined) matching = matching.where('m.kind', '=', query.type);
  if (query.automationId !== undefined)
    matching = matching.where(
      'm.automation_id',
      '=',
      parsePublicId('automation', query.automationId) ?? NOTHING,
    );
  if (query.assignee === 'unassigned') matching = matching.where('m.assignee_user_id', 'is', null);
  else if (query.assignee === 'me')
    matching =
      invocation.context.actorKind === 'user' && invocation.context.userId !== undefined
        ? matching.where('m.assignee_user_id', '=', invocation.context.userId)
        : matching.where(sql<boolean>`false`);
  else if (query.assignee !== 'anyone') {
    // Tenancy decides who is on this team; someone who isn't reads as an invalid choice.
    const userId = z
      .uuid()
      .parse(await options.assignees.resolve(trx, invocation.context, query.assignee));
    matching = matching.where('m.assignee_user_id', '=', userId);
  }
  const { total } = await matching
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  let page = matching;
  if (query.after !== undefined) {
    const [position, id] = decodeCursor(query.after);
    page = page.where(sql<SqlBool>`(m.created_at, m.id) > (${position}::timestamptz, ${id}::uuid)`);
  }
  const rows = await page
    .orderBy('m.created_at')
    .orderBy('m.id')
    .limit(query.limit + 1)
    .execute();
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: await present(trx, invocation, shown, options),
    total: Number(total),
    next:
      rows.length > query.limit && last !== undefined ? encodeCursor(last.position, last.id) : null,
    canWork:
      allows(invocation, 'conversations.manage') || allows(invocation, 'conversations.reply'),
    canAssign: allows(invocation, 'conversations.manage'),
  };
}

const assignInput = assignManualActionInput.extend(assignManualAction.params.shape);
const closeInput = closeManualActionInput.extend(completeManualAction.params.shape);

export interface ManualActionCommands {
  readonly assign: Command<typeof assignInput, ManualAction>;
  readonly complete: Command<typeof closeInput, ManualAction>;
  readonly skip: Command<typeof closeInput, ManualAction>;
}

/**
 * The queue's commands, for a role that works conversations: one that manages them, or one
 * that replies. The route picks the permission the caller has, as the inbox does. Someone
 * who only replies may take an action for themselves or put it back, and no more.
 */
export function createManualActionCommands(
  options: ManualActionOptions,
  permission: WorkPermission = 'conversations.manage',
): ManualActionCommands {
  const answer = async (
    trx: DatabaseTransaction,
    command: CommandContext,
    actionId: string,
  ): Promise<ManualAction> => readManualAction(trx, command, actionId, options);

  const assign = defineCommand({
    name: 'manual_action.assign',
    permission,
    input: assignInput,
    audit: ({ actionId, assignee }) => ({ actionId, assignee }),
    async handle(trx, input, command): Promise<ManualAction> {
      requireBusiness(command.context);
      const current = await holdAction(trx, input.actionId);
      requireWritable(current, input.revision);
      // Tenancy decides who is on this team, and holds the membership until commit.
      const assignee = await options.assignees.resolve(trx, command.context, input.assignee);
      const self = command.context.actorKind === 'user' ? command.context.userId : undefined;
      if (
        !allows(command, 'conversations.manage') &&
        ((assignee !== null && assignee !== self) ||
          (assignee === null && current.assignee_user_id !== (self ?? null)))
      )
        throw new ValidationError([
          {
            path: '/assignee',
            code: 'not_allowed',
            message:
              'You can take an action for yourself, or put back one that is yours. Giving one to someone else needs permission to manage conversations.',
          },
        ]);
      if (assignee !== current.assignee_user_id) {
        await trx
          .updateTable('automation.manual_actions')
          .set({ assignee_user_id: assignee })
          .where('id', '=', current.id)
          .execute();
        await command.emit({
          type: assignee === null ? 'manual_action.unassigned' : 'manual_action.assigned',
          subject: { kind: 'manual_action', id: current.id },
          records: [current.contact_id],
          payload: {
            type: current.kind,
            automationId: toPublicId('automation', current.automation_id),
            ...(assignee === null ? {} : { assignedUserId: assignee }),
          },
        });
      }
      return answer(trx, command, input.actionId);
    },
  });

  const close = (outcome: 'completed' | 'skipped') =>
    defineCommand({
      name: outcome === 'completed' ? 'manual_action.complete' : 'manual_action.skip',
      permission,
      input: closeInput,
      audit: ({ actionId }) => ({ actionId }),
      async handle(trx, input, command): Promise<ManualAction> {
        requireBusiness(command.context);
        const current = await holdAction(trx, input.actionId);
        requireWritable(current, input.revision);
        await trx
          .updateTable('automation.manual_actions')
          .set({
            status: outcome,
            closed_at: sql<Date>`now()`,
            closed_by_kind: command.context.actorKind,
            closed_by_id: command.context.actorId ?? null,
          })
          .where('id', '=', current.id)
          .execute();
        // The run goes on only if it still waits on this very action.
        const enrolment = await trx
          .selectFrom('automation.enrolments')
          .select(['id', 'status', 'state'])
          .where('id', '=', current.enrolment_id)
          .executeTakeFirst();
        const waiting = manualWait(enrolment?.state);
        if (
          enrolment?.status === 'waiting' &&
          waiting?.actionId === current.id &&
          waiting.outcome === undefined
        ) {
          // Only its own key: the rest of the state may have changed since it was read, such
          // as an event kept for when the run ends (reentry-mark.ts).
          await trx
            .updateTable('automation.enrolments')
            .set({
              state: sql`state || ${JSON.stringify({ manual: { ...waiting, outcome } })}::jsonb`,
              updated_at: sql<Date>`now()`,
            })
            .where('id', '=', enrolment.id)
            .execute();
          await queueStep(trx, enrolment.id);
        }
        await command.emit({
          type: outcome === 'completed' ? 'manual_action.completed' : 'manual_action.skipped',
          subject: { kind: 'manual_action', id: current.id },
          records: [current.contact_id],
          payload: {
            type: current.kind,
            automationId: toPublicId('automation', current.automation_id),
          },
        });
        return answer(trx, command, input.actionId);
      },
    });

  return { assign, complete: close('completed'), skip: close('skipped') };
}
