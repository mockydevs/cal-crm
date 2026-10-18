// The proposals an assistant makes, and what a person does with one: Apply, Dismiss and
// Undo. "The AI works, people decide."
//
// A proposal is a row holding a command and its input. It is never another way to change
// the data:
//   * storing one runs nothing. The command is only checked, as it would be when run, so
//     that nothing is kept that could never be applied;
//   * Apply runs that command through the command layer (runProposedCommand) as whoever
//     applies it: validated again, permitted by that person's role, refused by the
//     command's own rules and policies as it would be for them, audited in their name and
//     marked with the proposal. The proposal's row is locked first, in the same
//     transaction, so two people, or two clicks, apply it once;
//   * what may happen to a proposal in each state is decided by the command layer's rules
//     (decideApply, decideDismiss, decideUndo), and the database refuses any other change;
//   * Undo runs the command that was worked out, when the proposal was applied, to reverse
//     it, the same way. Where nothing can reverse it, it says so.
import {
  decideApply,
  decideDismiss,
  decideUndo,
  defineCommand,
  proposableOf,
  requireBusiness,
  requirePermission,
  runCommand,
  type Command,
  type Invocation,
  type JsonRecord,
  type Proposable,
  type Services,
  type UndoPlan,
} from '@repo/commands';
import {
  aiAgents,
  autonomyLevels,
  proposal as proposalSchema,
  proposalChange,
  proposalCommand,
  proposalReference,
  proposalStatuses,
  proposalUndoPlan,
  undoRefusals,
  type AiAgent,
  type AutonomyLevel,
  type Permission,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type UndoRefusal,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction, type Json } from '@repo/db';
import {
  actorKinds,
  AppError,
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import type { ActorNames } from '@repo/module-crm';

import { oneOf } from './stored-words.js';

export interface ProposalOptions {
  /** Every command that can be proposed, from the modules that own them. */
  readonly registry: readonly Proposable[];
  /** Who decided, by name. */
  readonly actorNames: ActorNames;
  readonly now?: () => Date;
}

/** How long a reply draft waits for a person before it expires. */
export const PROPOSAL_TTL_MS = 7 * 86_400_000;

const columns = [
  'id',
  'agent',
  'kind',
  'status',
  'autonomy',
  'summary',
  'conversation_id',
  'record_id',
  'form_id',
  'command',
  'after',
  'basis',
  'revision',
  'edited',
  'result',
  'undo',
  'expires_at',
  'created_at',
  'decided_at',
  'decided_by_kind',
  'decided_by_id',
  'undone_at',
  'undone_by_kind',
  'undone_by_id',
] as const;

interface ProposalRow {
  readonly id: string;
  readonly agent: string;
  readonly kind: string;
  readonly status: string;
  readonly autonomy: string;
  readonly summary: string;
  readonly conversation_id: string | null;
  readonly record_id: string | null;
  readonly form_id: string | null;
  readonly command: Json;
  readonly after: Json | null;
  readonly basis: Json | null;
  readonly revision: string;
  readonly edited: boolean;
  readonly result: Json | null;
  readonly undo: Json | null;
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly decided_by_kind: string | null;
  readonly decided_by_id: string | null;
  readonly undone_at: Date | null;
  readonly undone_by_kind: string | null;
  readonly undone_by_id: string | null;
}

/** A plain object for a jsonb column: node-postgres writes an object as JSON. */
const asJson = (value: JsonRecord): Json => JSON.parse(JSON.stringify(value)) as Json;

/** The command a row holds. The table's check keeps it to a name and an input. */
const commandOf = (row: Pick<ProposalRow, 'command'>) => proposalCommand.parse(row.command);
/** How to reverse it, when it was applied. */
const undoOf = (row: Pick<ProposalRow, 'undo'>): UndoPlan | null =>
  row.undo === null ? null : proposalUndoPlan.parse(row.undo);
const statusOf = (row: Pick<ProposalRow, 'status'>): ProposalStatus =>
  oneOf(proposalStatuses, row.status);
const agentOf = (row: Pick<ProposalRow, 'agent'>): AiAgent => oneOf(aiAgents, row.agent);

function find(trx: DatabaseTransaction, id: string) {
  return trx.selectFrom('ai.proposals').select(columns).where('id', '=', id);
}

/** A proposal with the proposable its kind names. */
interface Found {
  readonly row: ProposalRow;
  readonly proposable: Proposable;
}

/**
 * A proposal of the request's business, or a NotFoundError; optionally held for a write.
 * A row of a kind this version has no command for is not found either: nothing here could
 * show it, apply it or say what deciding it needs.
 */
async function requireProposal(
  trx: DatabaseTransaction,
  context: TenantContext,
  registry: readonly Proposable[],
  publicProposalId: string,
  lock = false,
): Promise<Found> {
  requireBusiness(context);
  const id = parsePublicId('proposal', publicProposalId);
  const query = id === undefined ? undefined : find(trx, id);
  const row = await (lock ? query?.forUpdate() : query)?.executeTakeFirst();
  const proposable = row === undefined ? undefined : proposableOf(registry, row.kind);
  if (row === undefined || proposable === undefined)
    throw new NotFoundError('Proposal', publicProposalId);
  return { row, proposable };
}

/** Why Apply, Dismiss or Undo refused: said in a 409, in words a person can act on. */
class ProposalRefused extends ConflictError {}

const APPLY_REFUSALS = {
  dismissed: 'This suggestion was dismissed, so it can no longer be applied.',
  expired: 'This suggestion has expired. Ask for a new one.',
  undone: 'This suggestion was applied and then undone. Ask for a new one.',
  stale:
    'Things have changed since this was suggested, so it was not applied. Ask for a new suggestion, or dismiss this one.',
} as const;
const DISMISS_REFUSALS = {
  applied: 'This suggestion was already applied, so it can’t be dismissed.',
  expired: 'This suggestion has already expired.',
  undone: 'This suggestion was applied and then undone.',
} as const;
const UNDO_WORDS: Readonly<Record<UndoRefusal, string>> = {
  message_sent: 'A message that was sent can’t be unsent.',
  not_sent: 'This reply was never sent, so there is nothing to undo.',
  already_known: 'This was already known when it was applied, so there is nothing to undo.',
  published_before:
    'This form was already live before it was published again, so there is no draft to go back to. Unpublish it from the form if you want it taken down.',
};
const NOT_UNDOABLE = 'This can’t be undone from here.';
const NOT_APPLIED = 'Only a suggestion that was applied can be undone.';
const CHANGED_SINCE =
  'This was changed again after the suggestion was applied, so undoing it would overwrite newer work. Nothing was changed.';

const isUndoRefusal = (reason: string): reason is UndoRefusal =>
  (undoRefusals as readonly string[]).includes(reason);

async function actorOf(
  trx: DatabaseTransaction,
  invocation: Invocation,
  names: ActorNames,
  kind: string | null,
  id: string | null,
): Promise<Proposal['decidedBy']> {
  if (kind === null) return null;
  const actorKind = oneOf(actorKinds, kind);
  const lookup = names[actorKind];
  const name = id === null || lookup === undefined ? null : (await lookup(trx, [id])).get(id);
  return {
    kind: actorKind,
    name: name ?? null,
    you:
      actorKind === 'user' &&
      invocation.context.actorKind === 'user' &&
      id === invocation.context.userId,
  };
}

/** A proposal as the API shows it. */
async function presentProposal(
  trx: DatabaseTransaction,
  invocation: Invocation,
  options: ProposalOptions,
  { row, proposable }: Found,
  at: Date,
): Promise<Proposal> {
  const stored = statusOf(row);
  const expired =
    stored === 'pending' && row.expires_at !== null && row.expires_at.getTime() <= at.getTime();
  const status: ProposalStatus = expired ? 'expired' : stored;
  // A waiting proposal is stale when what it was made on has moved, or can no longer be
  // read as its command reads it. Only a waiting one is checked: nothing else can be applied.
  let stale = false;
  if (status === 'pending') {
    try {
      stale = (await proposable.revision(trx, commandOf(row).input)) !== row.revision;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      stale = true;
    }
  }
  const undo = undoOf(row);
  // The record as the proposal's own command names it: every command about a record takes
  // the record's public id as `id`.
  const named = commandOf(row).input['id'];
  return {
    id: toPublicId('proposal', row.id),
    agent: agentOf(row),
    kind: proposable.kind,
    status,
    autonomy: oneOf(autonomyLevels, row.autonomy),
    summary: row.summary,
    conversationId:
      row.conversation_id === null ? null : toPublicId('conversation', row.conversation_id),
    recordId: row.record_id === null || typeof named !== 'string' ? null : named,
    formId: row.form_id === null ? null : toPublicId('form', row.form_id),
    // Kept when the proposal was stored, and again when it was applied: what the card says.
    change: proposalChange.parse(row.after),
    basis: proposalSchema.shape.basis.parse(row.basis),
    stale,
    edited: row.edited,
    canDecide:
      invocation.permissions === 'all' || invocation.permissions.has(proposable.permission),
    result: proposalSchema.shape.result.parse(row.result),
    undo:
      status !== 'applied' || undo === null
        ? null
        : 'impossible' in undo
          ? {
              available: false,
              reason: isUndoRefusal(undo.impossible) ? undo.impossible : null,
              message: isUndoRefusal(undo.impossible) ? UNDO_WORDS[undo.impossible] : NOT_UNDOABLE,
            }
          : { available: true, reason: null, message: null },
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedBy: await actorOf(
      trx,
      invocation,
      options.actorNames,
      row.decided_by_kind,
      row.decided_by_id,
    ),
    undoneAt: row.undone_at?.toISOString() ?? null,
    undoneBy: await actorOf(
      trx,
      invocation,
      options.actorNames,
      row.undone_by_kind,
      row.undone_by_id,
    ),
  };
}

export async function readProposal(
  trx: DatabaseTransaction,
  invocation: Invocation,
  options: ProposalOptions,
  publicProposalId: string,
): Promise<Proposal> {
  const found = await requireProposal(trx, invocation.context, options.registry, publicProposalId);
  return presentProposal(trx, invocation, options, found, (options.now ?? (() => new Date()))());
}

/** What is waiting for a conversation, then what was applied or undone in the last day. */
export async function readConversationProposals(
  trx: DatabaseTransaction,
  invocation: Invocation,
  options: ProposalOptions,
  conversationId: string,
): Promise<Proposal[]> {
  const at = (options.now ?? (() => new Date()))();
  const of = () =>
    trx
      .selectFrom('ai.proposals')
      .select(columns)
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
  // At most one of a kind waits for a conversation (the table's index), so this is short.
  const waiting = await of().where('status', '=', 'pending').limit(RECENT_LIMIT).execute();
  const decided = await of()
    .where('status', 'in', ['applied', 'undone'])
    .where('decided_at', '>', new Date(at.getTime() - RECENT_MS))
    .limit(RECENT_LIMIT)
    .execute();
  const shown: Proposal[] = [];
  for (const row of [...waiting, ...decided]) {
    const proposable = proposableOf(options.registry, row.kind);
    // A kind this version has no command for cannot be shown or decided here.
    if (proposable === undefined) continue;
    const proposal = await presentProposal(trx, invocation, options, { row, proposable }, at);
    // A waiting proposal whose time is up is no longer waiting, swept yet or not.
    if (proposal.status !== 'expired') shown.push(proposal);
  }
  return shown;
}

/** The most waiting proposals shown for one record: a contact's page lists them all. */
const RECORD_PENDING_LIMIT = 50;

/** What is waiting about a record, then what was applied or undone in the last day. */
export async function readRecordProposals(
  trx: DatabaseTransaction,
  invocation: Invocation,
  options: ProposalOptions,
  recordId: string,
): Promise<Proposal[]> {
  const at = (options.now ?? (() => new Date()))();
  const of = () =>
    trx
      .selectFrom('ai.proposals')
      .select(columns)
      .where('record_id', '=', recordId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
  const waiting = await of().where('status', '=', 'pending').limit(RECORD_PENDING_LIMIT).execute();
  const decided = await of()
    .where('status', 'in', ['applied', 'undone'])
    .where('decided_at', '>', new Date(at.getTime() - RECENT_MS))
    .limit(RECORD_PENDING_LIMIT)
    .execute();
  const shown: Proposal[] = [];
  for (const row of [...waiting, ...decided]) {
    const proposable = proposableOf(options.registry, row.kind);
    // A kind this version has no command for cannot be shown or decided here.
    if (proposable === undefined) continue;
    const proposal = await presentProposal(trx, invocation, options, { row, proposable }, at);
    // A waiting proposal whose time is up is no longer waiting, swept yet or not.
    if (proposal.status !== 'expired') shown.push(proposal);
  }
  return shown;
}

/** How long an applied proposal stays beside its conversation, and how many do. */
const RECENT_MS = 86_400_000;
const RECENT_LIMIT = 5;

export interface ProposalDraft {
  readonly agent: AiAgent;
  readonly kind: ProposalKind;
  /** The command's input, as the command takes it. */
  readonly input: JsonRecord;
  /** One line for a person: what it is, never what a model said it is. */
  readonly summary: string;
  /** The assistant's level for this action as it proposes. */
  readonly autonomy: AutonomyLevel;
  /** The model call it came from, when it came from one. */
  readonly requestId?: string;
  /** What the assistant was given to work from, for "Why this?". */
  readonly basis?: JsonRecord;
  readonly expiresAt?: Date;
}

/**
 * Stores what an assistant proposes, in the caller's transaction. Nothing is run: the
 * command's input is only checked as the command would check it, fingerprinted and shown.
 * An older waiting proposal of the same kind for the same conversation, or the same form,
 * is closed as expired, since the new one replaces it.
 */
export async function storeProposal(
  trx: DatabaseTransaction,
  invocation: Invocation,
  registry: readonly Proposable[],
  draft: ProposalDraft,
): Promise<{ readonly id: string }> {
  const businessId = requireBusiness(invocation.context);
  const proposable = proposableOf(registry, draft.kind);
  if (proposable === undefined) throw new Error(`Nothing can be proposed as ${draft.kind}.`);
  if (!proposable.agents.includes(draft.agent))
    throw new Error(`The ${draft.agent} assistant may not propose a ${draft.kind}.`);
  proposable.check(draft.input);
  const subject = await proposable.subject(trx, draft.input);
  const revision = await proposable.revision(trx, draft.input);
  const change = await proposable.present(trx, draft.input, invocation);
  if (subject.conversationId !== undefined)
    await trx
      .updateTable('ai.proposals')
      .set((eb) => ({
        status: 'expired',
        decided_at: eb.fn<Date>('now', []),
        decided_by_kind: 'system',
        decided_by_id: null,
      }))
      .where('conversation_id', '=', subject.conversationId)
      .where('kind', '=', draft.kind)
      .where('status', '=', 'pending')
      .execute();
  // And for a form: asking to publish it again replaces the card that was waiting.
  if (subject.formId !== undefined)
    await trx
      .updateTable('ai.proposals')
      .set((eb) => ({
        status: 'expired',
        decided_at: eb.fn<Date>('now', []),
        decided_by_kind: 'system',
        decided_by_id: null,
      }))
      .where('form_id', '=', subject.formId)
      .where('kind', '=', draft.kind)
      .where('status', '=', 'pending')
      .execute();
  return trx
    .insertInto('ai.proposals')
    .values({
      business_id: businessId,
      agent: draft.agent,
      kind: draft.kind,
      conversation_id: subject.conversationId ?? null,
      record_id: subject.recordId ?? null,
      automation_id: subject.automationId ?? null,
      form_id: subject.formId ?? null,
      summary: draft.summary,
      command: asJson({ name: proposable.commandName, input: draft.input }),
      after: asJson(change),
      basis: draft.basis === undefined ? null : asJson(draft.basis),
      autonomy: draft.autonomy,
      revision,
      request_id: draft.requestId ?? null,
      expires_at: draft.expiresAt ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/**
 * Applies a proposal as whoever the invocation is, with `changes` in place of what was
 * proposed where the kind allows a change. The command runs once, however often and by
 * however many people this is called: a second call finds the proposal applied and
 * answers with it.
 */
export async function applyProposal(
  services: Services,
  options: ProposalOptions,
  invocation: Invocation,
  publicProposalId: string,
  changes?: JsonRecord,
): Promise<Proposal> {
  const now = options.now ?? (() => new Date());
  const { context } = invocation;
  const read = (lock: boolean) => (trx: DatabaseTransaction) =>
    requireProposal(trx, context, options.registry, publicProposalId, lock);
  const { row: first, proposable } = await withTenant(services.db, context, read(false));
  const proposed = commandOf(first).input;
  if (changes !== undefined && !proposable.changeable)
    throw new ValidationError([
      { path: '/changes', code: 'not_changeable', message: 'This suggestion can’t be changed.' },
    ]);
  const input = changes === undefined ? proposed : proposable.change(proposed, changes);

  // What the card says once a person has changed the proposal: read before the command
  // runs, as the first one was, so that "from" is still how things were.
  let changed: JsonRecord | undefined;
  await proposable.run(services, input, invocation, {
    proposal: { id: first.id, agent: agentOf(first) },
    async begin(trx) {
      // Held until the command's transaction ends: whoever comes second waits here, and
      // then reads the proposal as the first left it.
      const { row } = await read(true)(trx);
      const decision = decideApply(
        { status: statusOf(row), expiresAt: row.expires_at, revision: row.revision },
        now(),
        // Of what was proposed, not of the changes: the question is whether the record
        // is still the one the proposal was made on.
        await proposable.revision(trx, commandOf(row).input),
      );
      if (decision.action === 'refuse') throw new ProposalRefused(APPLY_REFUSALS[decision.reason]);
      if (decision.action === 'run' && changes !== undefined)
        changed = await proposable.present(trx, input, invocation);
      return decision.action;
    },
    async finish(trx, done) {
      await trx
        .updateTable('ai.proposals')
        .set((eb) => ({
          status: 'applied',
          decided_at: eb.fn<Date>('now', []),
          decided_by_kind: context.actorKind,
          decided_by_id: context.actorId ?? null,
          applied_event_id: done.eventIds[0] ?? null,
          edited: changes !== undefined,
          // What ran, and what the card now says, when a person changed it first.
          command: asJson({ name: proposable.commandName, input }),
          ...(changed === undefined ? {} : { after: asJson(changed) }),
          result: asJson(done.result),
          undo: asJson(done.undo),
        }))
        .where('id', '=', first.id)
        .execute();
    },
  });
  return withTenant(services.db, context, (trx) =>
    readProposal(trx, invocation, options, publicProposalId),
  );
}

/**
 * Dismissing is a command of its own, needing the permission the proposal's command
 * needs: whoever could not apply it does not decide what becomes of it either.
 */
function dismissCommand(
  permission: Permission,
  registry: readonly Proposable[],
  now: () => Date,
): Command<typeof proposalReference, undefined> {
  return defineCommand({
    name: 'proposal.dismiss',
    permission,
    input: proposalReference,
    async handle(trx, { id }, command): Promise<undefined> {
      const { row } = await requireProposal(trx, command.context, registry, id, true);
      const decision = decideDismiss({ status: statusOf(row), expiresAt: row.expires_at }, now());
      if (decision.action === 'refuse')
        throw new ProposalRefused(DISMISS_REFUSALS[decision.reason]);
      if (decision.action === 'repeat') return undefined;
      await trx
        .updateTable('ai.proposals')
        .set((eb) => ({
          status: 'dismissed',
          decided_at: eb.fn<Date>('now', []),
          decided_by_kind: command.context.actorKind,
          decided_by_id: command.context.actorId ?? null,
        }))
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'proposal.dismissed',
        subject: { kind: 'proposal', id: row.id },
        payload: { agent: row.agent, kind: row.kind },
      });
      return undefined;
    },
  });
}

/** Dismisses a waiting proposal: nothing is run. Dismissing twice is dismissing once. */
export async function dismissProposal(
  services: Services,
  options: ProposalOptions,
  invocation: Invocation,
  publicProposalId: string,
): Promise<Proposal> {
  const { context } = invocation;
  const { proposable } = await withTenant(services.db, context, (trx) =>
    requireProposal(trx, context, options.registry, publicProposalId),
  );
  await runCommand(
    services,
    dismissCommand(proposable.permission, options.registry, options.now ?? (() => new Date())),
    { id: publicProposalId },
    invocation,
  );
  return withTenant(services.db, context, (trx) =>
    readProposal(trx, invocation, options, publicProposalId),
  );
}

/**
 * Undoes an applied proposal as whoever the invocation is, by running the command that
 * was worked out to reverse it when it was applied. Refused in plain words where nothing
 * can reverse it, and where the record was changed again since.
 */
export async function undoProposal(
  services: Services,
  options: ProposalOptions,
  invocation: Invocation,
  publicProposalId: string,
): Promise<Proposal> {
  const { context } = invocation;
  const read = (lock: boolean) => (trx: DatabaseTransaction) =>
    requireProposal(trx, context, options.registry, publicProposalId, lock);
  /** What to do with the proposal as it is, or the refusal. */
  const decide = (row: ProposalRow) => {
    const decision = decideUndo({ status: statusOf(row), undo: undoOf(row) });
    if (decision.action !== 'refuse') return decision;
    if (decision.reason === 'not_applied') throw new ProposalRefused(NOT_APPLIED);
    throw new ProposalRefused(
      isUndoRefusal(decision.why) ? UNDO_WORDS[decision.why] : NOT_UNDOABLE,
    );
  };
  const answer = () =>
    withTenant(services.db, context, (trx) =>
      readProposal(trx, invocation, options, publicProposalId),
    );

  const { row: first, proposable: proposed } = await withTenant(services.db, context, read(false));
  let decision: ReturnType<typeof decide>;
  try {
    decision = decide(first);
  } catch (error) {
    // Refused all the same for someone who could not have applied it, and recorded.
    await requirePermission(
      services,
      { name: proposed.commandName, permission: proposed.permission },
      invocation,
      {},
      { id: first.id, agent: agentOf(first) },
    );
    throw error;
  }
  if (decision.action === 'repeat') return answer();
  const reverse = proposableOf(options.registry, decision.kind);
  // The way back names a kind there is no longer a command for.
  if (reverse === undefined) throw new ProposalRefused(NOT_UNDOABLE);

  try {
    await reverse.run(services, decision.input, invocation, {
      proposal: { id: first.id, agent: agentOf(first) },
      // Held as Apply holds it: a second Undo waits, then finds the first one's.
      begin: async (trx) => decide((await read(true)(trx)).row).action,
      async finish(trx) {
        await trx
          .updateTable('ai.proposals')
          .set((eb) => ({
            status: 'undone',
            undone_at: eb.fn<Date>('now', []),
            undone_by_kind: context.actorKind,
            undone_by_id: context.actorId ?? null,
          }))
          .where('id', '=', first.id)
          .execute();
      },
    });
  } catch (error) {
    // The reversing command's own "this changed" refusal, in Undo's words.
    if (error instanceof ConflictError && !(error instanceof ProposalRefused))
      throw new ProposalRefused(CHANGED_SINCE);
    throw error;
  }
  return answer();
}
