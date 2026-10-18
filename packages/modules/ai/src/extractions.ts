// Field extraction as the product runs it. An arriving message queues this job for its
// conversation (migration 0061). The worker runs it, since only the worker has a gateway
// that can open a provider's key:
//
//   1. one transaction reads the conversation, the contact's fields that the business lets
//      AI fill from conversations, and what is already known, for the one business the job
//      runs in, and takes the reading over (ai.extractions: a thread as it stood is read
//      once);
//   2. the model is asked, through the gateway, outside any transaction (extraction.ts);
//   3. one transaction stores what the answer may propose, as proposals.
//
// The job writes two things: its own run row, and proposals. It never writes a contact's
// field or memory. Where the business has told this assistant to act on its own, the job
// then applies its own proposals through the command layer as the assistant, which checks
// that rule itself, and each command checks its own (a field's AI sources and overwrite
// setting; memory's screen). A refusal leaves the proposal waiting for a person.
import {
  defineTask,
  readAutonomy,
  requireBusiness,
  type Invocation,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { extractContactJob, type AutonomyLevel } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { AppError, NotFoundError, toPublicId } from '@repo/kernel';
import { readFields, readRecordField, requireRecord } from '@repo/module-crm';
import { randomUUID } from 'node:crypto';

import {
  extractFromConversation,
  sameValue,
  type DiscardReason,
  type ExtractionField,
  type ExtractionResult,
} from './extraction.js';
import type { AiGateway } from './gateway.js';
import { isRecord, type JsonRecord } from './json.js';
import { STANDING } from './memory.js';
import { factForPrompt, normalizeFact } from './memory-rules.js';
import { applyProposal, storeProposal, type ProposalOptions } from './proposals.js';

export const extractContactReference = {
  name: 'ai.extract_contact',
  data: extractContactJob,
} satisfies TaskReference<typeof extractContactJob>;

/** How long a proposal read from a conversation waits for a person before it expires. */
export const EXTRACTION_PROPOSAL_TTL_MS = 30 * 86_400_000;
/** The assistant's two kinds of action, as autonomy rules name them. */
const UPDATE_FIELD = 'update_field';
const REMEMBER_FACT = 'remember_fact';

/** How a reading can end. `extracted` is the only one with proposals. */
export type ExtractionOutcome =
  | 'extracted'
  | 'nothing_found'
  | 'nothing_to_read'
  | 'refused'
  | 'failed'
  | 'paused'
  | 'ai_off'
  | 'not_configured'
  | 'invalid_answer';

/** One message of the conversation, as the module that owns conversations hands it over. */
export interface ExtractionSourceMessage {
  /** The message's stored id: the subject of its message.received event. */
  readonly id: string;
  /**
   * Its number in the conversation, counted up as each message is stored: a later message
   * has a higher one.
   */
  readonly seq: number;
  readonly from: 'contact' | 'business';
  /** Sent by a machine, such as an auto-reply: nothing a person said about themselves. */
  readonly automated: boolean;
  readonly channel: string;
  readonly subject: string | null;
  readonly text: string;
  readonly at: Date;
}

/** One conversation as an assistant is shown it (messaging's readReplyContext). */
export interface ExtractionConversation {
  readonly conversationId: string;
  readonly contactId: string;
  readonly contactFirstName: string | null;
  readonly businessName: string;
  readonly businessLocale: string;
  /** Oldest first, without the team's internal notes. */
  readonly messages: readonly ExtractionSourceMessage[];
  /** The thread's fingerprint. */
  readonly revision: string;
}

/** Where the job reads what is not this module's own. Each read is in the job's business. */
export interface ExtractionSources {
  /** One conversation, by its stored id, or undefined when it is not there. */
  conversation(
    trx: DatabaseTransaction,
    invocation: Invocation,
    conversationId: string,
  ): Promise<ExtractionConversation | undefined>;
}

/** What a reading came to, for the server's log: ids, counts and categories, never words. */
export interface ExtractionEvent {
  readonly businessId: string;
  readonly conversationId: string;
  readonly outcome: ExtractionOutcome;
  readonly reason: string | null;
  readonly proposedFields: number;
  readonly proposedFacts: number;
  /** How many items of the answer were thrown away, by why. */
  readonly discarded: Readonly<Partial<Record<DiscardReason | StoreDiscard, number>>>;
}

/** Why an item that passed the answer's own checks was still not proposed. */
type StoreDiscard = 'protected' | 'already_proposed' | 'no_source';

export interface ExtractionOptions extends ProposalOptions {
  readonly sources: ExtractionSources;
  /** Told how each reading ended, to log it. */
  readonly onExtraction?: (event: ExtractionEvent) => void;
  /** How long the model is waited for, in milliseconds: two minutes unless said otherwise. */
  readonly timeoutMs?: number;
}

/** A field the business lets AI fill from conversations, with what its record holds now. */
interface FieldState extends ExtractionField {
  /** The field's public id. */
  readonly id: string;
  readonly revision: string;
  readonly aiOverwrite: 'ask' | 'allow' | 'never';
  /** Whether the value there now is a person's: entered by anyone but AI, or confirmed. */
  readonly personal: boolean;
}

/**
 * The contact's fields that the business lets AI fill from conversations, with their
 * values now. This list is the whole of what the model may be offered and the whole of
 * what an answer may name: a field with the source turned off is not in it.
 */
async function readFillableFields(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicContactId: string,
): Promise<FieldState[]> {
  const { items } = await readFields(trx, invocation);
  const fields: FieldState[] = [];
  for (const definition of items) {
    if (
      definition.objectKey !== 'contact' ||
      definition.archived ||
      !definition.aiFillSources.includes('conversations')
    )
      continue;
    let saved;
    try {
      saved = await readRecordField(trx, invocation, publicContactId, definition.id);
    } catch (error) {
      // A field merged into another is no longer a field of its own.
      if (error instanceof NotFoundError) continue;
      throw error;
    }
    const current = saved.value;
    // A text box list's boxes are never the assistant's to fill.
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) continue;
    fields.push({
      id: definition.id,
      key: definition.key,
      label: definition.label,
      description: definition.description,
      valueType: definition.valueType,
      options: definition.options
        .filter((option) => !option.archived)
        .map(({ key, label }) => ({ key, label })),
      currency: definition.currency,
      current,
      revision: saved.revision,
      aiOverwrite: definition.aiOverwrite,
      personal:
        saved.value !== null && (saved.source?.kind !== 'ai_agent' || saved.confirmedAt !== null),
    });
  }
  return fields;
}

/** The facts that stand about a contact, as lines a prompt may be given, oldest first. */
async function readKnownFacts(trx: DatabaseTransaction, contactId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('ai.contact_facts')
    .select('statement')
    .where('contact_id', '=', contactId)
    .where('status', 'in', STANDING)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows
    .map((row) => factForPrompt(row.statement))
    .filter((line) => line !== undefined)
    .reverse();
}

/** What a reading's answer is recorded as when nothing in it may be proposed. */
function unread(result: Exclude<ExtractionResult, { readonly outcome: 'read' }>): {
  readonly outcome: ExtractionOutcome;
  readonly reason?: string;
  readonly requestId?: string;
} {
  switch (result.outcome) {
    case 'refused':
      return { outcome: 'refused', requestId: result.requestId };
    case 'failed':
    case 'invalid_answer':
      return { outcome: result.outcome, reason: result.reason, requestId: result.requestId };
    case 'paused':
    case 'not_configured':
      return { outcome: result.outcome, reason: result.reason };
    case 'ai_off':
      return { outcome: 'ai_off' };
  }
}

/**
 * Reads the conversation a message arrived in and proposes what it found. Only the worker
 * has a gateway that can open a key. The model is asked outside any database transaction.
 */
export function createExtractContactTask(
  gateway: Pick<AiGateway, 'generate'>,
  options: ExtractionOptions,
): Task<typeof extractContactReference.data> {
  const now = options.now ?? (() => new Date());
  return defineTask({
    ...extractContactReference,
    async run({ conversationId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      // The extraction assistant, with what its two commands need and no more. It reads
      // through this context too, so its reads are this one business's.
      const agent: Invocation = {
        context: {
          agencyId: invocation.context.agencyId,
          businessId,
          actorKind: 'ai_agent',
          correlationId: invocation.context.correlationId,
        },
        permissions: new Set(['fields.values', 'contacts.manage']),
        agent: 'extraction',
        ...(invocation.causationId === undefined ? {} : { causationId: invocation.causationId }),
      };
      const claim = randomUUID();
      const counts = new Map<DiscardReason | StoreDiscard, number>();
      const discard = (reason: DiscardReason | StoreDiscard): void => {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      };
      const tell = (
        outcome: ExtractionOutcome,
        reason: string | undefined,
        proposedFields = 0,
        proposedFacts = 0,
      ): void => {
        options.onExtraction?.({
          businessId,
          conversationId,
          outcome,
          reason: reason ?? null,
          proposedFields,
          proposedFacts,
          discarded: Object.fromEntries(counts),
        });
      };
      const finish = async (
        trx: DatabaseTransaction,
        id: string,
        outcome: ExtractionOutcome,
        more: {
          readonly reason?: string | undefined;
          readonly requestId?: string | undefined;
          readonly proposedFields?: number;
          readonly proposedFacts?: number;
        } = {},
      ): Promise<void> => {
        await trx
          .updateTable('ai.extractions')
          .set({
            status: 'finished',
            outcome,
            reason: more.reason ?? null,
            request_id: more.requestId ?? null,
            proposed_fields: more.proposedFields ?? 0,
            proposed_facts: more.proposedFacts ?? 0,
            discarded: [...counts.values()].reduce((sum, count) => sum + count, 0),
            finished_at: now(),
          })
          .where('id', '=', id)
          .where('status', '=', 'pending')
          .execute();
        tell(outcome, more.reason, more.proposedFields, more.proposedFacts);
      };

      const prepared = await withTenant(services.db, agent.context, async (trx) => {
        const conversation = await options.sources.conversation(trx, agent, conversationId);
        if (conversation === undefined) return undefined;
        const publicContactId = toPublicId('contact', conversation.contactId);
        // The thread as it stands is read once: a job run again (after a crash, or a
        // retry) finds its own row. One still pending is taken over with a claim of this
        // job's, so the job that left it leaves its answer unused.
        const existing = await trx
          .selectFrom('ai.extractions')
          .select(['id', 'status'])
          .where('conversation_id', '=', conversation.conversationId)
          .where('revision', '=', conversation.revision)
          .forUpdate()
          .executeTakeFirst();
        if (existing?.status === 'finished') return undefined;
        // What arrived since the conversation was last read to its end: only that is read
        // from. The older messages are context.
        const last = await trx
          .selectFrom('ai.extractions')
          .select((eb) => eb.fn.max('through_seq').as('seq'))
          .where('conversation_id', '=', conversation.conversationId)
          .where('status', '=', 'finished')
          .where('outcome', 'in', ['extracted', 'nothing_found'])
          .executeTakeFirst();
        const readThrough = Number(last?.seq ?? 0);
        const run =
          existing ??
          (await trx
            .insertInto('ai.extractions')
            .values({
              business_id: businessId,
              conversation_id: conversation.conversationId,
              contact_id: conversation.contactId,
              revision: conversation.revision,
              through_seq: Math.max(0, ...conversation.messages.map((message) => message.seq)),
            })
            .returning(['id', 'status'])
            .executeTakeFirstOrThrow());
        const messages = conversation.messages.map((message) => ({
          ...message,
          isNew:
            message.from === 'contact' &&
            !message.automated &&
            message.text.trim() !== '' &&
            message.seq > readThrough,
        }));
        const contact = await requireRecord(trx, publicContactId);
        if (contact.trashed || !messages.some((message) => message.isNew)) {
          await finish(trx, run.id, 'nothing_to_read');
          return undefined;
        }
        await trx.updateTable('ai.extractions').set({ claim }).where('id', '=', run.id).execute();
        return {
          runId: run.id,
          conversation,
          messages,
          publicContactId,
          fields: await readFillableFields(trx, agent, publicContactId),
          knownFacts: await readKnownFacts(trx, conversation.contactId),
        };
      });
      if (prepared === undefined) return;
      const { conversation, messages, publicContactId, knownFacts } = prepared;

      const result = await extractFromConversation(
        gateway,
        agent.context,
        {
          business: { name: conversation.businessName, locale: conversation.businessLocale },
          contact: { firstName: conversation.contactFirstName, knownFacts },
          fields: prepared.fields,
          messages: messages.map((message) => ({
            from: message.from,
            isNew: message.isNew,
            channel: message.channel,
            subject: message.subject,
            text: message.text,
            at: message.at.toISOString(),
          })),
        },
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      );

      const stored = await withTenant(services.db, agent.context, async (trx) => {
        const run = await trx
          .selectFrom('ai.extractions')
          .select(['id', 'status', 'claim'])
          .where('id', '=', prepared.runId)
          .forUpdate()
          .executeTakeFirst();
        // Another job took the reading over, or it was closed: this answer is not used.
        if (run?.status !== 'pending' || run.claim !== claim) return [];
        if (result.outcome !== 'read') {
          const ended = unread(result);
          await finish(trx, run.id, ended.outcome, ended);
          return [];
        }
        for (const reason of result.extraction.discarded) discard(reason);
        const { requestId } = result;
        const basis = {
          messages: messages.length,
          facts: knownFacts.length,
          summary: false,
          knowledge: [],
        };
        const expiresAt = new Date(now().getTime() + EXTRACTION_PROPOSAL_TTL_MS);
        const made: { readonly id: string; readonly level: AutonomyLevel }[] = [];

        // The event of each message a finding was read in: what a fact links to, and what
        // "Why?" follows. A message with no event of its own (imported history) is no
        // source, and what was read in it is not kept.
        const cited = [...result.extraction.fields, ...result.extraction.facts].map(
          (finding) => messages[finding.message]?.id ?? '',
        );
        const events =
          cited.length === 0
            ? []
            : await trx
                .selectFrom('events.events')
                .select(['id', 'subject_id'])
                .where('type', '=', 'message.received')
                .where('subject_kind', '=', 'message')
                .where('subject_id', 'in', cited)
                .execute();
        const eventOf = (message: number): string | undefined => {
          const id = messages[message]?.id;
          const event = events.find((each) => each.subject_id === id);
          return event === undefined ? undefined : toPublicId('event', event.id);
        };
        /** The waiting proposals about this contact, as their commands' inputs. */
        const waiting = await trx
          .selectFrom('ai.proposals')
          .select(['id', 'kind', 'command'])
          .where('record_id', '=', conversation.contactId)
          .where('status', '=', 'pending')
          .where('kind', 'in', ['field_value', 'memory_fact'])
          .execute();
        const inputOf = (row: (typeof waiting)[number]): JsonRecord => {
          const command: unknown = row.command;
          const input = isRecord(command) ? command['input'] : undefined;
          return isRecord(input) ? input : {};
        };

        const fieldLevel = await readAutonomy(trx, {
          agent: 'extraction',
          action: UPDATE_FIELD,
          contactId: conversation.contactId,
        });
        let proposedFields = 0;
        // Read again, in this transaction: a person may have filled a field while the
        // model was reading, and a field's settings may have changed.
        const fields = await readFillableFields(trx, agent, publicContactId);
        for (const finding of result.extraction.fields) {
          const field = fields.find((each) => each.key === finding.key);
          const eventId = eventOf(finding.message);
          // Turned off for conversations, archived or merged meanwhile: no longer offered.
          if (field === undefined) discard('unknown_field');
          else if (eventId === undefined) discard('no_source');
          else if (field.current !== null && sameValue(field.current, finding.value))
            discard('unchanged');
          // "Never": nothing AI reads replaces a value a person entered or confirmed, so
          // nothing is proposed that could not be applied.
          else if (field.personal && field.aiOverwrite === 'never') discard('protected');
          else {
            const earlier = waiting.filter(
              (row) => row.kind === 'field_value' && inputOf(row)['fieldId'] === field.id,
            );
            const value: unknown = finding.value;
            if (
              earlier.some((row) => JSON.stringify(inputOf(row)['value']) === JSON.stringify(value))
            ) {
              discard('already_proposed');
              continue;
            }
            // A newer reading of the same field replaces the one that waits.
            if (earlier.length > 0)
              await trx
                .updateTable('ai.proposals')
                .set((eb) => ({
                  status: 'expired',
                  decided_at: eb.fn<Date>('now', []),
                  decided_by_kind: 'system',
                  decided_by_id: null,
                }))
                .where(
                  'id',
                  'in',
                  earlier.map((row) => row.id),
                )
                .where('status', '=', 'pending')
                .execute();
            const proposal = await storeProposal(trx, agent, options.registry, {
              agent: 'extraction',
              kind: 'field_value',
              input: {
                id: publicContactId,
                fieldId: field.id,
                value: finding.value,
                revision: field.revision,
                aiSource: 'conversations',
                ...(finding.confidence === null ? {} : { confidence: finding.confidence }),
              },
              // The product's own words: the field's name is the business's, not the model's.
              summary: `Set ${field.label}`.slice(0, 500),
              autonomy: fieldLevel.level,
              requestId,
              basis: { ...basis, quote: finding.quote, eventIds: [eventId] },
              expiresAt,
            });
            made.push({ id: proposal.id, level: fieldLevel.level });
            proposedFields += 1;
          }
        }

        const factLevel = await readAutonomy(trx, {
          agent: 'extraction',
          action: REMEMBER_FACT,
          contactId: conversation.contactId,
        });
        let proposedFacts = 0;
        const known = new Set(
          (await readKnownFacts(trx, conversation.contactId)).map(normalizeFact),
        );
        const proposedAlready = new Set(
          waiting
            .filter((row) => row.kind === 'memory_fact')
            .map((row) => {
              const statement = inputOf(row)['statement'];
              return typeof statement === 'string' ? normalizeFact(statement) : '';
            }),
        );
        for (const finding of result.extraction.facts) {
          const normalized = normalizeFact(finding.statement);
          const eventId = eventOf(finding.message);
          if (eventId === undefined) discard('no_source');
          else if (known.has(normalized)) discard('known');
          else if (proposedAlready.has(normalized)) discard('already_proposed');
          else {
            const proposal = await storeProposal(trx, agent, options.registry, {
              agent: 'extraction',
              kind: 'memory_fact',
              input: {
                id: publicContactId,
                statement: finding.statement,
                kind: finding.kind,
                quote: finding.quote,
                conversationId: toPublicId('conversation', conversation.conversationId),
                eventIds: [eventId],
                ...(finding.confidence === null ? {} : { confidence: finding.confidence }),
              },
              summary: 'Remember a fact about this contact',
              autonomy: factLevel.level,
              requestId,
              basis: { ...basis, quote: finding.quote, eventIds: [eventId] },
              expiresAt,
            });
            proposedAlready.add(normalized);
            made.push({ id: proposal.id, level: factLevel.level });
            proposedFacts += 1;
          }
        }

        await finish(trx, run.id, made.length === 0 ? 'nothing_found' : 'extracted', {
          requestId,
          proposedFields,
          proposedFacts,
        });
        return made;
      });

      // "Act": the assistant applies its own proposals, as itself. The command layer reads
      // the rule again and refuses unless it still says act; each command then keeps its
      // own rule. A refusal leaves the proposal waiting for a person, which is where it
      // would have been at any other level.
      for (const proposal of stored) {
        if (proposal.level !== 'act') continue;
        try {
          await applyProposal(services, options, agent, toPublicId('proposal', proposal.id));
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
    },
  });
}
