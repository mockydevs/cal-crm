// What the tests of proposals and reply drafts share: the world of the Settings tests (a
// migrated database, the gateway as the worker composes it, and local stand-ins for the
// providers), with the assistant's routes, a conversation to propose about, and two
// commands that can be proposed.
//
// The two commands stand in for the Inbox's own, which the AI module cannot reach (they
// are the messaging module's, proven with their proposals in that module and, composed
// with this one, in apps/server). They keep what matters to a proposal: one sends and
// cannot be undone, one changes a conversation and can; each needs its own permission and
// names its own kind of action; each checks its own input.
import { createHash, randomUUID } from 'node:crypto';

import {
  defineCommand,
  defineProposable,
  requireBusiness,
  type ApiRoute,
  type Invocation,
  type Proposable,
} from '@repo/commands';
import {
  conversation as conversationSchema,
  getConversation,
  sendConversationReplyInput,
  type AutonomyLevel,
  type Endpoint,
  type EndpointOutput,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import type { DatabaseServer } from '@repo/testing';

import { createAssistantRoutes } from '../src/assistant-routes.js';
import type { AiGateway } from '../src/gateway.js';
import type { ProposalOptions } from '../src/proposals.js';
import type { ReplyDraftKnowledge } from '../src/reply-draft.js';
import {
  createDraftReplyTask,
  type DraftConversation,
  type ReplyDraftSources,
} from '../src/reply-drafts.js';
import { startSettingsWorld, type Person, type SettingsWorld } from './settings-world.js';

/** A stop a test puts inside a command's transaction, to hold it there. */
export interface Hold {
  /** Settles when a command has reached the stop, inside its transaction. */
  readonly reached: Promise<void>;
  /** Lets the command go on. */
  release(): void;
}

export interface AssistantWorld extends SettingsWorld {
  readonly proposables: readonly Proposable[];
  readonly proposals: ProposalOptions;
  readonly assistantRoutes: readonly ApiRoute[];
  /**
   * What the draft job reads of a conversation, in place of the Inbox's own reader: the
   * conversation's row from the database, with the thread a test gives it. Unless a test
   * says otherwise, the contact wrote last and a reply can go out by email.
   */
  readonly threads: Map<string, Partial<DraftConversation>>;
  /** What the business has written down, as the server would hand it over. */
  readonly knowledge: ReplyDraftKnowledge[];
  /**
   * Runs the draft job for a conversation as the worker would, in the person's business.
   * A test may give it another gateway, or less time to wait for the model.
   */
  draft(
    person: Person,
    conversationId: string,
    options?: { readonly gateway?: Pick<AiGateway, 'generate'>; readonly timeoutMs?: number },
  ): Promise<void>;
  /** Runs the draft jobs that are queued and due, and says how many it ran. */
  runDrafts(): Promise<number>;
  /** Calls an assistant route as the HTTP layer would, and checks the answer's shape. */
  ask<E extends Endpoint>(
    endpoint: E,
    person: Pick<Person, 'invocation'>,
    input?: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
  ): Promise<EndpointOutput<E>>;
  /** The next run of either command waits at a stop, inside its transaction, until released. */
  holdNext(): Hold;
  /**
   * Waits until `count` sessions of this database are seen waiting on a lock. Another
   * role's wait events are hidden from crm_app, so the superuser watches.
   */
  waitingOnLock(count?: number): Promise<void>;
  /** A contact of the person's business with a conversation, as a first message makes one. */
  conversation(person: Person): Promise<Talk>;
  /** The inbox agent in the person's business, with the permissions given. */
  assistant(person: Person, permissions?: Invocation['permissions']): Invocation;
  setRule(
    person: Person,
    action: string,
    level: AutonomyLevel,
    contactId?: string | null,
  ): Promise<void>;
}

export interface Talk {
  /** The conversation's stored id and its public one. */
  readonly id: string;
  readonly publicId: string;
  readonly contactId: string;
  /** What the sending command has "sent" for this conversation, oldest first. */
  sent(): Promise<string[]>;
  status(): Promise<string>;
  /** Moves the thread on, as a new message would. */
  newMessage(): Promise<void>;
  /** The input of a reply proposal, as the Inbox's reply command takes it. */
  reply(text: string): { id: string; reply: ReplyContent & { idempotencyKey: string } };
  /** What a person sends to change a reply before applying it: everything but the key. */
  changes(text: string): ReplyContent;
  /** The input of a status proposal, made on the conversation as it is now. */
  statusChange(
    status: 'open' | 'closed',
  ): Promise<{ id: string; status: string; revision: string }>;
}

/** What the composer chooses for a reply. */
export interface ReplyContent {
  readonly channel: 'email';
  readonly accountId: string;
  readonly to: string;
  readonly text: string;
}

/** Any mailbox and any address: the stand-in command sends nowhere. */
const ACCOUNT = toPublicId('channel_account', '01890a5d-ac96-774b-bcce-b302099a8057');
const ADDRESS = toPublicId('contact_identity', '01890a5d-ac96-774b-bcce-b302099a8058');

/** A status's fingerprint, in the form the contract gives a conversation's revision. */
const revisionOf = (status: string): string => createHash('sha256').update(status).digest('hex');

// The shape of the Inbox's own reply command: the conversation, and the reply beside it.
const sendInput = getConversation.params.extend({ reply: sendConversationReplyInput });
const statusInput = getConversation.params.extend({
  status: conversationSchema.shape.status,
  revision: conversationSchema.shape.revision,
});

async function conversationOf(trx: DatabaseTransaction, publicId: string) {
  const row = await trx
    .selectFrom('messaging.conversations')
    .select(['id', 'contact_id', 'status', 'message_seq'])
    .where('id', '=', parsePublicId('conversation', publicId) ?? '')
    .executeTakeFirst();
  if (row === undefined)
    throw new ValidationError([
      { path: '/id', code: 'unknown_conversation', message: 'No such conversation.' },
    ]);
  return row;
}

export async function startAssistantWorld(server: DatabaseServer): Promise<AssistantWorld> {
  const world = await startSettingsWorld(server);
  const { database } = world;
  let hold: { reached: () => void; released: Promise<void> } | undefined;

  /** Waits where a test asked the next command to wait, with its transaction still open. */
  const stopIfHeld = async (): Promise<void> => {
    const stop = hold;
    if (stop === undefined) return;
    hold = undefined;
    stop.reached();
    await stop.released;
  };

  // Stands in for the Inbox's reply: it "sends" by keeping the words as a tag of the
  // business. A tag's name is unique, so the same words sent twice fail loudly: a second
  // send can never go unnoticed.
  const send = defineCommand({
    name: 'test.send',
    permission: 'conversations.reply',
    input: sendInput,
    audit: ({ id }) => ({ id }),
    delegation: {
      action: 'send_message',
      contact: async (trx, { id }) => (await conversationOf(trx, id)).contact_id,
    },
    async handle(trx, { id, reply }, command) {
      const talk = await conversationOf(trx, id);
      if (reply.text.includes('REFUSED BY POLICY'))
        throw new ValidationError([
          { path: '/text', code: 'refused', message: 'The pipeline refused this.' },
        ]);
      const tag = await trx
        .insertInto('crm.tags')
        .values({
          business_id: requireBusiness(command.context),
          name: reply.text,
          description: talk.id,
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'message.submitted',
        subject: { kind: 'message', id: tag.id },
        records: [talk.contact_id],
      });
      await stopIfHeld();
      return { id: tag.id, text: reply.text };
    },
  });

  // Stands in for the Inbox's open and close: it checks the revision it was made on, as
  // that command does, and gives the new one back.
  const setStatus = defineCommand({
    name: 'test.set_status',
    permission: 'conversations.manage',
    input: statusInput,
    delegation: {
      action: 'update_conversation',
      contact: async (trx, { id }) => (await conversationOf(trx, id)).contact_id,
    },
    async handle(trx, input, command) {
      const talk = await conversationOf(trx, input.id);
      if (revisionOf(talk.status) !== input.revision)
        throw new ConflictError('This conversation changed. Refresh it, then try again.');
      if (input.status === 'snoozed')
        throw new ValidationError([
          { path: '/status', code: 'unsupported', message: 'Open or close it.' },
        ]);
      await trx
        .updateTable('messaging.conversations')
        .set({ status: input.status })
        .where('id', '=', talk.id)
        .execute();
      await command.emit({
        type: `conversation.${input.status === 'open' ? 'opened' : 'closed'}`,
        subject: { kind: 'conversation', id: talk.id },
        records: [talk.contact_id],
      });
      await stopIfHeld();
      return { revision: revisionOf(input.status) };
    },
  });

  const subject = async (trx: DatabaseTransaction, { id }: { readonly id: string }) => {
    const talk = await conversationOf(trx, id);
    return { conversationId: talk.id, contactId: talk.contact_id };
  };
  const proposables = [
    defineProposable({
      kind: 'reply',
      command: send,
      agents: ['inbox'],
      subject,
      revision: async (trx, { id }) => `thread:${(await conversationOf(trx, id)).message_seq}`,
      change: (input, changes) => ({
        id: input.id,
        reply: { ...changes, idempotencyKey: input.reply.idempotencyKey },
      }),
      present: (_trx, { reply }) =>
        Promise.resolve({
          kind: 'reply',
          channel: reply.channel,
          accountId: reply.accountId,
          to: reply.to,
          subject: reply.subject,
          text: reply.text,
        }),
      capture: () => Promise.resolve(null),
      result: (output) => ({ messageId: toPublicId('message', output.id) }),
      undo: (_captured, output) => ({
        impossible: output.text.includes('UNKNOWN REASON') ? 'some_new_reason' : 'message_sent',
      }),
    }),
    defineProposable({
      kind: 'conversation_status',
      command: setStatus,
      agents: ['inbox'],
      subject,
      revision: (_trx, { revision }) => Promise.resolve(revision),
      present: async (trx, input) => ({
        kind: 'conversation_status',
        from: (await conversationOf(trx, input.id)).status,
        to: input.status,
        until: null,
      }),
      capture: async (trx, { id }) => (await conversationOf(trx, id)).status,
      result: () => ({}),
      undo: (before, output, { id }) => ({
        kind: 'conversation_status',
        input: { id, status: before, revision: output.revision },
      }),
    }),
  ];

  const proposals: ProposalOptions = {
    registry: proposables,
    // The Settings world names each person it makes this way (settings-world.ts).
    actorNames: {
      user: (_trx, ids) =>
        Promise.resolve(new Map(ids.map((id) => [id, `Person ${id.slice(-6)}`]))),
    },
    now: () => world.clock.now,
  };
  const assistantRoutes = createAssistantRoutes({
    proposables,
    actorNames: proposals.actorNames,
    // In place of the Inbox's own finder: the conversation's row, under row-level security.
    findConversation: async (trx, publicConversationId) => {
      const row = await trx
        .selectFrom('messaging.conversations')
        .select(['id', 'contact_id'])
        .where('id', '=', parsePublicId('conversation', publicConversationId) ?? '')
        .executeTakeFirst();
      return row === undefined ? undefined : { id: row.id, contactId: row.contact_id };
    },
    now: () => world.clock.now,
  });

  const threads = new Map<string, Partial<DraftConversation>>();
  const knowledge: ReplyDraftKnowledge[] = [];
  const sources: ReplyDraftSources = {
    async conversation(trx, _invocation, conversationId) {
      const row = await trx
        .selectFrom('messaging.conversations')
        .select(['id', 'contact_id', 'message_seq'])
        .where('id', '=', conversationId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        conversationId: row.id,
        contactId: row.contact_id,
        contactFirstName: 'Maya',
        contactLocale: null,
        businessName: 'Harbor Lights Events',
        businessLocale: 'en',
        messages: [
          {
            from: 'contact',
            channel: 'email',
            subject: 'June 13',
            text: 'Is June 13 still open?',
            at: new Date('2026-10-10T08:00:00.000Z'),
          },
        ],
        state: 'needs_reply',
        revision: `thread:${row.message_seq}`,
        reply: { channel: 'email', accountId: ACCOUNT, to: ADDRESS, subject: 'Re: June 13' },
        ...threads.get(row.id),
      };
    },
    knowledge: () => Promise.resolve(knowledge),
  };
  const draftTask = (
    gateway: Pick<AiGateway, 'generate'> = world.gateway,
    timeoutMs?: number,
  ): ReturnType<typeof createDraftReplyTask> =>
    createDraftReplyTask(gateway, {
      ...proposals,
      sources,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  return {
    ...world,
    proposables,
    proposals,
    assistantRoutes,
    threads,
    knowledge,
    async draft(person, conversationId, options = {}) {
      await draftTask(options.gateway, options.timeoutMs).run(
        { conversationId },
        {
          invocation: {
            context: {
              agencyId: person.context.agencyId,
              ...(person.context.businessId === undefined
                ? {}
                : { businessId: person.context.businessId }),
              actorKind: 'system',
              correlationId: randomUUID(),
            },
            permissions: 'all',
          },
          services: world.services,
        },
      );
    },
    async runDrafts() {
      const jobs = await database.runJobs(['ai.draft_reply']);
      for (const job of jobs) {
        const payload = job.payload as {
          agencyId: string;
          businessId: string;
          correlationId: string;
          data: { conversationId: string };
        };
        await draftTask().run(payload.data, {
          invocation: {
            context: {
              agencyId: payload.agencyId,
              businessId: payload.businessId,
              actorKind: 'system',
              correlationId: payload.correlationId,
            },
            permissions: 'all',
          },
          services: world.services,
        });
      }
      return jobs.length;
    },
    async ask(endpoint, { invocation }, input = {}) {
      const route = assistantRoutes.find((each) => each.endpoint === endpoint);
      if (route === undefined) throw new Error(`No route for ${endpoint.operationId}.`);
      const answer = await route.run(
        {
          invocation: {
            ...invocation,
            context: { ...invocation.context, correlationId: randomUUID() },
          },
          params: input.params ?? {},
          query: input.query ?? {},
          body: input.body,
        },
        world.services,
      );
      // What goes over the wire: whatever is not JSON would not arrive.
      const wire: unknown = answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
      if (endpoint.response.schema !== undefined) endpoint.response.schema.parse(wire);
      return wire as EndpointOutput<typeof endpoint>;
    },
    holdNext() {
      let reached = (): void => undefined;
      let release = (): void => undefined;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { reached, released };
      return { reached: arrived, release };
    },
    async waitingOnLock(count = 1) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [row] = await database.as('postgres', (sql) =>
          sql.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'`,
          ),
        );
        if ((row?.waiting ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Fixture timeout: ${String(count)} session(s) never waited on a lock.`);
    },
    async conversation(person) {
      const contact = await database.fixtures.contact(person.context, { firstName: 'Maya' });
      const query = <Row extends object>(text: string, values: readonly unknown[] = []) =>
        database.withTenant(person.context, (sql) => sql.query<Row>(text, values));
      const [row] = await query<{ id: string }>(
        `insert into messaging.conversations (business_id, contact_id)
         values (app.business_id(), $1) returning id`,
        [contact.id],
      );
      if (row === undefined) throw new Error('No conversation.');
      const publicId = toPublicId('conversation', row.id);
      const status = async (): Promise<string> => {
        const [found] = await query<{ status: string }>(
          'select status from messaging.conversations where id = $1',
          [row.id],
        );
        return found?.status ?? '';
      };
      return {
        id: row.id,
        publicId,
        contactId: contact.id,
        status,
        async sent() {
          const rows = await query<{ name: string }>(
            'select name from crm.tags where description = $1 order by created_at, id',
            [row.id],
          );
          return rows.map((each) => each.name);
        },
        async newMessage() {
          await query(
            'update messaging.conversations set message_seq = message_seq + 1 where id = $1',
            [row.id],
          );
        },
        reply: (text) => ({
          id: publicId,
          reply: {
            channel: 'email',
            accountId: ACCOUNT,
            to: ADDRESS,
            text,
            idempotencyKey: `proposal-${randomUUID().replaceAll('-', '')}`,
          },
        }),
        changes: (text) => ({ channel: 'email', accountId: ACCOUNT, to: ADDRESS, text }),
        statusChange: async (to) => ({
          id: publicId,
          status: to,
          revision: revisionOf(await status()),
        }),
      };
    },
    assistant: (
      person,
      permissions = new Set(['conversations.reply', 'conversations.manage']),
    ) => ({
      context: {
        agencyId: person.context.agencyId,
        ...(person.context.businessId === undefined
          ? {}
          : { businessId: person.context.businessId }),
        actorKind: 'ai_agent',
        correlationId: randomUUID(),
      },
      permissions,
      agent: 'inbox',
    }),
    async setRule(person, action, level, contactId = null) {
      await database.withTenant(person.context, (sql) =>
        sql.query(
          `insert into ai.autonomy_rules (business_id, agent, action, contact_id, level)
           values (app.business_id(), 'inbox', $1, $2, $3)
           on conflict on constraint autonomy_rules_unique do update set level = excluded.level`,
          [action, contactId, level],
        ),
      );
    },
  };
}
