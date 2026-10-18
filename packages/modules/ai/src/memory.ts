// Contact memory as the product keeps it: the facts the assistant knows about a contact,
// who sees them, and the only ways one is written, rewritten or removed.
//
//   * A fact is written by one command, `contact_fact.remember`. No route calls it: it is
//     what a proposal of the extraction job holds, so it runs when a person approves that
//     proposal, or when the assistant applies it where the business's rule for remembering
//     says "act" (the command names that delegation, and the command layer checks it).
//   * The command screens the words itself (memory-rules.ts), whoever runs it: a line that
//     reads as an instruction, a promise of the business, a contact detail or something in
//     a sensitive category is refused here even if a proposal holding it was approved.
//   * Anyone who can open the contact reads its facts. Rewriting or removing one needs
//     `contacts.manage`. Removing deletes the row: nothing later is given it.
//   * Every read and write is in the caller's tenant transaction and names one contact, so
//     row-level security holds it to the one business and the query to the one contact.
import { createHash } from 'node:crypto';

import {
  defineCommand,
  defineProposable,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Command,
  type Invocation,
  type Proposable,
  type Route,
} from '@repo/commands';
import {
  CONTACT_FACT_LIMIT,
  contactFactParams,
  correctContactFact,
  correctContactFactInput,
  deleteContactFact,
  listContactFacts,
  parseInput,
  rememberContactFactInput,
  storedFactKinds,
  type ContactFact,
  type ContactFacts,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  actorKinds,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { requireRecord, type ActorNames } from '@repo/module-crm';

import { normalizeFact, screenFact, type ScreenRefusal } from './memory-rules.js';
import { oneOf } from './stored-words.js';

/**
 * Finds a conversation of the request's business by its public id, through the module that
 * owns conversations: this module does not read another module's tables.
 */
export type FindFactConversation = (
  trx: DatabaseTransaction,
  publicConversationId: string,
) => Promise<{ readonly id: string; readonly contactId: string } | undefined>;

export interface MemoryOptions {
  /** Who wrote or confirmed a fact, by name. */
  readonly actorNames: ActorNames;
  readonly findConversation: FindFactConversation;
}

/** A fact that stands: one a person rejected, or a newer one replaced, is no longer known. */
export const STANDING = ['proposed', 'confirmed'] as const;

const columns = [
  'id',
  'contact_id',
  'statement',
  'kind',
  'status',
  'confidence',
  'quote',
  'conversation_id',
  'proposal_id',
  'source_event_ids',
  'created_by_kind',
  'created_by_id',
  'corrected_at',
  'confirmed_by_id',
  'confirmed_at',
  'created_at',
  'updated_at',
] as const;

interface FactRow {
  readonly id: string;
  readonly contact_id: string;
  readonly statement: string;
  readonly kind: string;
  readonly status: string;
  readonly confidence: number | null;
  readonly quote: string | null;
  readonly conversation_id: string | null;
  readonly proposal_id: string | null;
  readonly source_event_ids: string[];
  readonly created_by_kind: string;
  readonly created_by_id: string | null;
  readonly corrected_at: Date | null;
  readonly confirmed_by_id: string | null;
  readonly confirmed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** What a change to a fact is made on: a stale one is refused, never written over. */
const revisionOf = (row: FactRow): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        id: row.id,
        statement: row.statement,
        status: row.status,
        confirmedBy: row.confirmed_by_id,
        updatedAt: row.updated_at.toISOString(),
      }),
    )
    .digest('hex');

/** The names of the people behind some facts, looked up once for all of them. */
async function namesFor(
  trx: DatabaseTransaction,
  names: ActorNames,
  rows: readonly FactRow[],
): Promise<ReadonlyMap<string, string>> {
  const wanted = new Map<keyof ActorNames, Set<string>>();
  const want = (kind: keyof ActorNames, id: string | null): void => {
    if (id !== null) wanted.set(kind, (wanted.get(kind) ?? new Set<string>()).add(id));
  };
  for (const row of rows) {
    want(oneOf(actorKinds, row.created_by_kind), row.created_by_id);
    want('user', row.confirmed_by_id);
  }
  const found = new Map<string, string>();
  for (const [kind, ids] of wanted) {
    const lookup = names[kind];
    if (lookup === undefined) continue;
    for (const [id, name] of await lookup(trx, [...ids])) found.set(`${kind}:${id}`, name);
  }
  return found;
}

function presentFact(
  row: FactRow,
  invocation: Invocation,
  names: ReadonlyMap<string, string>,
): ContactFact {
  const createdBy = oneOf(actorKinds, row.created_by_kind);
  const { userId } = invocation.context;
  return {
    id: toPublicId('contact_fact', row.id),
    statement: row.statement,
    kind: oneOf(storedFactKinds, row.kind),
    status: oneOf(STANDING, row.status),
    confidence: row.confidence,
    quote: row.quote,
    conversationId:
      row.conversation_id === null ? null : toPublicId('conversation', row.conversation_id),
    eventIds: row.source_event_ids.map((id) => toPublicId('event', id)),
    proposalId: row.proposal_id === null ? null : toPublicId('proposal', row.proposal_id),
    createdBy: {
      kind: createdBy,
      name: names.get(`${createdBy}:${row.created_by_id ?? ''}`) ?? null,
      you: createdBy === 'user' && userId !== undefined && row.created_by_id === userId,
    },
    corrected: row.corrected_at !== null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    confirmedBy:
      row.confirmed_by_id === null
        ? null
        : {
            name: names.get(`user:${row.confirmed_by_id}`) ?? null,
            you: row.confirmed_by_id === userId,
          },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revision: revisionOf(row),
  };
}

/** The contact a memory request names, or a NotFoundError: the CRM's own reader decides. */
async function requireContact(
  trx: DatabaseTransaction,
  publicContactId: string,
  lock = false,
): Promise<{ readonly id: string; readonly trashed: boolean }> {
  const record = await requireRecord(trx, publicContactId, lock);
  if (record.kind !== 'contact') throw new NotFoundError('Contact', publicContactId);
  return record;
}

/** The facts of one contact that stand, newest first. */
const standingOf = (trx: DatabaseTransaction, contactId: string) =>
  trx
    .selectFrom('ai.contact_facts')
    .select(columns)
    .where('contact_id', '=', contactId)
    .where('status', 'in', STANDING);

/** What the assistant knows about a contact, as people see it. Reading calls no model. */
export async function readContactFacts(
  trx: DatabaseTransaction,
  invocation: Invocation,
  options: Pick<MemoryOptions, 'actorNames'>,
  publicContactId: string,
): Promise<ContactFacts> {
  requireBusiness(invocation.context);
  const contact = await requireContact(trx, publicContactId);
  const rows = await standingOf(trx, contact.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(CONTACT_FACT_LIMIT)
    .execute();
  const names = await namesFor(trx, options.actorNames, rows);
  return {
    items: rows.map((row) => presentFact(row, invocation, names)),
    canManage:
      !contact.trashed &&
      (invocation.permissions === 'all' || invocation.permissions.has('contacts.manage')),
  };
}

const REFUSED: Readonly<Record<ScreenRefusal, string>> = {
  instruction: 'This reads as an instruction, not as something about the contact.',
  business_claim:
    'This says what the business said, promised or allowed. Memory keeps what is known about the contact.',
  contact_detail: 'Contact details and links are kept in the contact’s own fields, not in memory.',
  sensitive:
    'This is about health, money matters, beliefs, origin, sexuality, criminal history or a credential, which memory does not keep.',
};

/** What remembering a fact made: the fact, and whether it was new. */
export interface RememberedFact {
  readonly id: string;
  /** False when the same thing was already known: nothing was written. */
  readonly created: boolean;
}

/**
 * Keeps a fact about a contact. Only ever run from a proposal: by the person who approves
 * it, whose approval confirms the fact, or by the assistant where the rule for
 * `remember_fact` says act, which leaves it for a person to confirm.
 */
export function createRememberFactCommand(
  find: FindFactConversation,
): Command<typeof rememberContactFactInput, RememberedFact> {
  return defineCommand({
    name: 'contact_fact.remember',
    permission: 'contacts.manage',
    input: rememberContactFactInput,
    // The audit log is never edited, so it keeps none of a fact's words: a fact a person
    // later removes is then gone from every place this command wrote it.
    audit: ({ id, kind }) => ({ id, kind }),
    delegation: {
      action: 'remember_fact',
      contact: async (trx, { id }) => (await requireContact(trx, id)).id,
    },
    async handle(trx, input, command): Promise<RememberedFact> {
      const businessId = requireBusiness(command.context);
      // Held until the transaction ends: two facts for one contact are written in turn.
      const contact = await requireContact(trx, input.id, true);
      const refused = screenFact(input.statement);
      if (refused !== undefined)
        throw new ValidationError([
          { path: '/statement', code: `fact_${refused}`, message: REFUSED[refused] },
        ]);
      const conversation = await find(trx, input.conversationId);
      // A fact is read from the contact's own conversation, never from another contact's.
      if (conversation?.contactId !== contact.id)
        throw new ValidationError([
          {
            path: '/conversationId',
            code: 'not_the_contacts_conversation',
            message: 'A fact comes from a conversation with this contact.',
          },
        ]);
      const eventIds = input.eventIds.map((id) => parsePublicId('event', id) ?? '');
      const events = await trx
        .selectFrom('events.events')
        .select('id')
        .where('id', 'in', eventIds)
        .where('type', '=', 'message.received')
        .execute();
      if (new Set(events.map((event) => event.id)).size !== new Set(eventIds).size)
        throw new ValidationError([
          {
            path: '/eventIds',
            code: 'unknown_event',
            message: 'A fact names the messages it was read in.',
          },
        ]);

      const standing = await standingOf(trx, contact.id).execute();
      const normalized = normalizeFact(input.statement);
      const known = standing.find((row) => normalizeFact(row.statement) === normalized);
      if (known !== undefined) return { id: toPublicId('contact_fact', known.id), created: false };
      if (standing.length >= CONTACT_FACT_LIMIT)
        throw new ConflictError(
          `Memory holds ${String(CONTACT_FACT_LIMIT)} facts about this contact, which is the most it keeps. Remove one first.`,
        );

      const { actorKind, userId } = command.context;
      // A person's approval is the confirmation. What the assistant writes on its own
      // waits for one.
      const approver = actorKind === 'user' ? userId : undefined;
      const row = await trx
        .insertInto('ai.contact_facts')
        .values({
          business_id: businessId,
          contact_id: contact.id,
          statement: input.statement,
          kind: input.kind,
          status: approver === undefined ? 'proposed' : 'confirmed',
          confidence: input.confidence ?? null,
          quote: input.quote,
          conversation_id: conversation.id,
          proposal_id: command.proposal?.id ?? null,
          source_event_ids: eventIds,
          created_by_kind: actorKind,
          created_by_id: command.context.actorId ?? null,
          confirmed_by_id: approver ?? null,
          confirmed_at: approver === undefined ? null : new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const id = toPublicId('contact_fact', row.id);
      await command.emit({
        type: 'contact_fact.remembered',
        subject: { kind: 'contact_fact', id: row.id },
        records: [contact.id],
        payload: { factId: id, kind: input.kind },
      });
      return { id, created: true };
    },
  });
}

/** Removes a fact for good. The timeline says one was removed, without its words. */
export const deleteContactFactCommand = defineCommand({
  name: 'contact_fact.delete',
  permission: 'contacts.manage',
  input: contactFactParams,
  async handle(trx, { id, factId }, command): Promise<undefined> {
    requireBusiness(command.context);
    // A contact in the trash can still have a fact removed: that is not a change to undo.
    const contact = await requireContact(trx, id);
    const removed = await trx
      .deleteFrom('ai.contact_facts')
      .where('id', '=', parsePublicId('contact_fact', factId) ?? '')
      .where('contact_id', '=', contact.id)
      .returning(['id', 'kind'])
      .executeTakeFirst();
    if (removed === undefined) throw new NotFoundError('Fact', factId);
    await command.emit({
      type: 'contact_fact.deleted',
      subject: { kind: 'contact_fact', id: removed.id },
      records: [contact.id],
      payload: { factId, kind: removed.kind },
    });
    return undefined;
  },
});

const correctInput = correctContactFactInput.extend(contactFactParams.shape);

/**
 * A person rewrites a fact, or confirms it as it reads. Either way it is theirs afterwards:
 * confirmed, by them. What a person writes is held to one short line like any fact, and is
 * not screened: it is a member of staff's own word about their contact.
 */
export function createCorrectFactCommand(
  options: Pick<MemoryOptions, 'actorNames'>,
): Command<typeof correctInput, ContactFact> {
  return defineCommand({
    name: 'contact_fact.correct',
    permission: 'contacts.manage',
    input: correctInput,
    audit: ({ id, factId }) => ({ id, factId }),
    async handle(trx, input, command): Promise<ContactFact> {
      requireBusiness(command.context);
      const { userId } = command.context;
      if (command.context.actorKind !== 'user' || userId === undefined)
        throw new ForbiddenError('Only a signed-in person can confirm or rewrite a fact.');
      const contact = await requireContact(trx, input.id, true);
      const factId = parsePublicId('contact_fact', input.factId) ?? '';
      const row = await standingOf(trx, contact.id)
        .where('id', '=', factId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Fact', input.factId);
      if (revisionOf(row) !== input.revision)
        throw new ConflictError('This fact changed. Reload it before changing it again.');
      const rewritten = input.statement !== row.statement;
      if (rewritten) {
        const normalized = normalizeFact(input.statement);
        const others = await standingOf(trx, contact.id).where('id', '<>', factId).execute();
        if (others.some((other) => normalizeFact(other.statement) === normalized))
          throw new ConflictError('This is already known about the contact.');
      }
      const at = new Date();
      const saved = await trx
        .updateTable('ai.contact_facts')
        .set({
          statement: input.statement,
          status: 'confirmed',
          confirmed_by_id: userId,
          confirmed_at: at,
          ...(rewritten ? { corrected_at: at } : {}),
        })
        .where('id', '=', factId)
        .returning(columns)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: rewritten ? 'contact_fact.corrected' : 'contact_fact.confirmed',
        subject: { kind: 'contact_fact', id: saved.id },
        records: [contact.id],
        payload: { factId: input.factId },
      });
      return presentFact(saved, command, await namesFor(trx, options.actorNames, [saved]));
    },
  });
}

/**
 * What memory lets an assistant propose: keeping a fact. Taking one out again is only the
 * way back from that, for a person: no assistant may propose or run it.
 */
export function createMemoryProposables(find: FindFactConversation): readonly Proposable[] {
  const subject = async (trx: DatabaseTransaction, { id }: { readonly id: string }) => {
    const contact = await requireContact(trx, id);
    return { recordId: contact.id, contactId: contact.id };
  };
  // Made on the contact being there to remember something about: one that was purged
  // makes the proposal stale.
  const revision = async (trx: DatabaseTransaction, { id }: { readonly id: string }) => {
    await requireContact(trx, id);
    return 'contact';
  };
  return [
    defineProposable({
      kind: 'memory_fact',
      command: createRememberFactCommand(find),
      agents: ['extraction'],
      subject,
      revision,
      present: (_trx, input) =>
        Promise.resolve({
          kind: 'memory_fact',
          statement: input.statement,
          factKind: input.kind,
          quote: input.quote,
        }),
      capture: () => Promise.resolve(null),
      result: (fact) => ({ factId: fact.id }),
      // Undo removes the fact this made. Where the same thing was already known, nothing
      // was made, and there is nothing of this proposal's to take back.
      undo: (_captured, fact, input) =>
        fact.created
          ? { kind: 'memory_fact_removal', input: { id: input.id, factId: fact.id } }
          : { impossible: 'already_known' },
    }),
    defineProposable({
      kind: 'memory_fact_removal',
      command: deleteContactFactCommand,
      agents: [],
      action: 'remember_fact',
      subject,
      revision,
      present: () => Promise.resolve({ kind: 'memory_fact_removal' }),
      capture: () => Promise.resolve(null),
      result: () => ({}),
      undo: () => ({ impossible: 'fact_removed' }),
    }),
  ];
}

/** The API of contact memory's facts. No route here calls a model, or writes a new fact. */
export function createMemoryRoutes(options: MemoryOptions): readonly ApiRoute[] {
  const correct = createCorrectFactCommand(options);
  return [
    {
      endpoint: listContactFacts,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(listContactFacts.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readContactFacts(trx, invocation, options, id),
        );
      },
    } satisfies Route<typeof listContactFacts>,
    {
      endpoint: correctContactFact,
      command: correct,
      run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const named = parseInput(correctContactFact.params, params);
        return runCommand(
          services,
          correct,
          { ...parseInput(correctContactFactInput, body), ...named },
          invocation,
        );
      },
    } satisfies Route<typeof correctContactFact>,
    {
      endpoint: deleteContactFact,
      command: deleteContactFactCommand,
      run({ invocation, params }, services) {
        requireBusiness(invocation.context);
        return runCommand(
          services,
          deleteContactFactCommand,
          parseInput(deleteContactFact.params, params),
          invocation,
        );
      },
    } satisfies Route<typeof deleteContactFact>,
  ];
}
