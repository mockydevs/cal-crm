// What the tests of field extraction and contact memory share: the world of the Settings
// tests (a migrated database, the gateway as the worker composes it, and a local stand-in
// for Claude that a test scripts), with the CRM's own field commands and their proposable,
// memory's routes and proposables, the assistant's routes, and a conversation to read.
//
// The conversation reader here is the test's own: it reads the conversation's rows under
// row-level security, as the Inbox's reader does. The Inbox's reader is proven in the
// messaging module, and the two composed, with the real vault, in apps/server.
import { randomUUID } from 'node:crypto';

import type { ApiRoute, Invocation, Proposable } from '@repo/commands';
import {
  connectAiProvider,
  type AiAgent,
  type AutonomyLevel,
  type Endpoint,
  type EndpointOutput,
  type FieldDefinition,
  type RecordField,
} from '@repo/contracts';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { createCrmRoutes, createFieldProposables } from '@repo/module-crm';
import type { DatabaseServer } from '@repo/testing';

import { createAssistantRoutes } from '../src/assistant-routes.js';
import {
  createExtractContactTask,
  type ExtractionEvent,
  type ExtractionSources,
} from '../src/extractions.js';
import type { AiGateway } from '../src/gateway.js';
import {
  createMemoryProposables,
  createMemoryRoutes,
  type FindFactConversation,
} from '../src/memory.js';
import type { ProposalOptions } from '../src/proposals.js';
import { anthropicText } from './fake-anthropic.js';
import {
  FAKE_ANTHROPIC_KEY,
  startSettingsWorld,
  type Person,
  type SettingsWorld,
} from './settings-world.js';

/** A contact with a conversation, as a first message makes one. */
export interface Thread {
  /** The conversation's stored id and its public one. */
  readonly id: string;
  readonly publicId: string;
  /** The contact's stored id and its public one. */
  readonly contactId: string;
  readonly contact: string;
  /** A message from the contact, with its event. Gives the event's public id. */
  says(text: string, options?: { readonly automated?: boolean }): Promise<string>;
  /** A reply the business sent. */
  answered(text: string): Promise<void>;
}

export interface MemoryWorld extends SettingsWorld {
  readonly registry: readonly Proposable[];
  readonly proposals: ProposalOptions;
  /** Every route a test may call: memory's, the assistant's and the CRM's. */
  readonly memoryRoutes: readonly ApiRoute[];
  /** What each run of the extraction job told the logs. */
  readonly readings: ExtractionEvent[];
  /** Calls a route as the HTTP layer would, and checks the answer's shape. */
  ask<E extends Endpoint>(
    endpoint: E,
    person: Pick<Person, 'invocation'>,
    input?: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
  ): Promise<EndpointOutput<E>>;
  /** A business that can call Claude with a key of its own. */
  connected(agencyId?: string): Promise<Person>;
  /** A contact of the person's business with a conversation. */
  thread(person: Person, firstName?: string): Promise<Thread>;
  /** A contact field that AI may fill from conversations, unless a test says otherwise. */
  field(
    person: Person,
    key: string,
    options?: Partial<
      Pick<FieldDefinition, 'valueType' | 'aiFillSources' | 'aiOverwrite' | 'options' | 'label'>
    >,
  ): Promise<FieldDefinition>;
  /** A field's saved value for a contact, as the record editor reads it. */
  value(person: Person, thread: Thread, field: FieldDefinition): Promise<RecordField>;
  /** Types a value in, as the person. */
  types(person: Person, thread: Thread, field: FieldDefinition, value: unknown): Promise<void>;
  /** What the stand-in answers the next request with: this object, as JSON text. */
  answers(answer: unknown): void;
  /** Runs the extraction job for a conversation as the worker would. */
  extract(
    person: Person,
    conversationId: string,
    options?: { readonly gateway?: Pick<AiGateway, 'generate'>; readonly causationId?: string },
  ): Promise<void>;
  /** The extraction assistant in the person's business, as the job acts. */
  assistant(person: Person): Invocation;
  setRule(
    person: Person,
    action: 'update_field' | 'remember_fact',
    level: AutonomyLevel,
    contactId?: string | null,
    agent?: AiAgent,
  ): Promise<void>;
  /** The body of the one request the stand-in was sent since the list was cleared. */
  asked(): { readonly raw: string; readonly json: Record<string, unknown> };
}

export async function startMemoryWorld(server: DatabaseServer): Promise<MemoryWorld> {
  const world = await startSettingsWorld(server);
  const { database } = world;
  const actorNames: ProposalOptions['actorNames'] = {
    user: (_trx, ids) => Promise.resolve(new Map(ids.map((id) => [id, `Person ${id.slice(-6)}`]))),
  };
  // In place of the Inbox's own finder: the conversation's row, under row-level security.
  const findConversation: FindFactConversation = async (trx, publicConversationId) => {
    const row = await trx
      .selectFrom('messaging.conversations')
      .select(['id', 'contact_id'])
      .where('id', '=', parsePublicId('conversation', publicConversationId) ?? '')
      .executeTakeFirst();
    return row === undefined ? undefined : { id: row.id, contactId: row.contact_id };
  };
  const registry = [...createFieldProposables(), ...createMemoryProposables(findConversation)];
  const proposals: ProposalOptions = { registry, actorNames, now: () => world.clock.now };
  const memoryRoutes = [
    ...createMemoryRoutes({ actorNames, findConversation }),
    ...createAssistantRoutes({
      proposables: registry,
      actorNames,
      findConversation,
      now: () => world.clock.now,
    }),
    ...createCrmRoutes(actorNames),
  ];
  const sources: ExtractionSources = {
    async conversation(trx, _invocation, conversationId) {
      const row = await trx
        .selectFrom('messaging.conversations as c')
        .innerJoin('crm.contacts as k', 'k.id', 'c.contact_id')
        .innerJoin('tenancy.businesses as b', 'b.id', 'c.business_id')
        .select(['c.id', 'c.contact_id', 'k.first_name', 'b.name', 'b.locale'])
        .where('c.id', '=', conversationId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const messages = await trx
        .selectFrom('messaging.messages')
        .select([
          'id',
          'seq',
          'direction',
          'channel',
          'subject',
          'body_text',
          'automated',
          'created_at',
        ])
        .where('conversation_id', '=', row.id)
        .where('direction', '<>', 'internal')
        .orderBy('seq')
        .execute();
      return {
        conversationId: row.id,
        contactId: row.contact_id,
        contactFirstName: row.first_name,
        businessName: row.name,
        businessLocale: row.locale,
        revision: `thread:${String(messages.length)}`,
        messages: messages.map((message) => ({
          id: message.id,
          seq: Number(message.seq),
          from: message.direction === 'inbound' ? 'contact' : 'business',
          automated: message.automated,
          channel: message.channel,
          subject: message.subject,
          text: message.body_text,
          at: message.created_at,
        })),
      };
    },
  };
  const readings: ExtractionEvent[] = [];
  const task = (gateway: Pick<AiGateway, 'generate'> = world.gateway) =>
    createExtractContactTask(gateway, {
      ...proposals,
      sources,
      onExtraction: (event) => readings.push(event),
    });

  const ask: MemoryWorld['ask'] = async (endpoint, { invocation }, input = {}) => {
    const route = memoryRoutes.find((each) => each.endpoint === endpoint);
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
  };
  /** A CRM route by its operation id: the fields' own commands, as their API runs them. */
  const crm = async <Output>(
    operationId: string,
    person: Pick<Person, 'invocation'>,
    input: { readonly params?: unknown; readonly body?: unknown },
  ): Promise<Output> => {
    const route = memoryRoutes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`No route for ${operationId}.`);
    return (await route.run(
      {
        invocation: {
          ...person.invocation,
          context: { ...person.invocation.context, correlationId: randomUUID() },
        },
        params: input.params ?? {},
        query: {},
        body: input.body,
      },
      world.services,
    )) as Output;
  };
  const value: MemoryWorld['value'] = async (person, thread, field) => {
    const { items } = await crm<{ items: RecordField[] }>('getRecordFields', person, {
      params: { id: thread.contact },
    });
    const found = items.find((item) => item.definition.id === field.id);
    if (found === undefined) throw new Error(`The contact has no field ${field.key}.`);
    return found;
  };

  return {
    ...world,
    registry,
    proposals,
    memoryRoutes,
    readings,
    ask,
    async connected(agencyId) {
      const person = await world.admin(agencyId);
      await database.withTenant(person.context, (sql) =>
        sql.query(
          `insert into ai.settings (business_id, key_source) values (app.business_id(), 'own')`,
        ),
      );
      await world.call(connectAiProvider, person, {
        body: { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY },
      });
      await database.runJobs(['ai.test_connection']);
      return person;
    },
    async thread(person, firstName = 'Maya') {
      const contact = await database.fixtures.contact(person.context, { firstName });
      const query = <Row extends object>(text: string, values: readonly unknown[] = []) =>
        database.withTenant(person.context, (sql) => sql.query<Row>(text, values));
      const [row] = await query<{ id: string }>(
        `insert into messaging.conversations (business_id, contact_id)
         values (app.business_id(), $1) returning id`,
        [contact.id],
      );
      const [account] = await query<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name, status)
         values (app.business_id(), 'webchat', $1, 'active') returning id`,
        [`Chat ${randomUUID().slice(0, 8)}`],
      );
      if (row === undefined || account === undefined) throw new Error('No conversation.');
      const message = async (
        text: string,
        direction: 'inbound' | 'outbound',
        automated: boolean,
      ): Promise<string> => {
        const [stored] = await query<{ id: string }>(
          `insert into messaging.messages (business_id, conversation_id, channel,
             channel_account_id, direction, status, body_text, author_kind, author_id,
             idempotency_key, automated)
           values (app.business_id(), $1, 'webchat', $2, $3, $4, $5, $6, $7, $8, $9)
           returning id`,
          [
            row.id,
            account.id,
            direction,
            direction === 'inbound' ? 'received' : 'sent',
            text,
            direction === 'inbound' ? 'contact' : 'system',
            direction === 'inbound' ? contact.id : null,
            direction === 'inbound' ? null : randomUUID(),
            automated,
          ],
        );
        if (stored === undefined) throw new Error('No message.');
        return stored.id;
      };
      return {
        id: row.id,
        publicId: toPublicId('conversation', row.id),
        contactId: contact.id,
        contact: toPublicId('contact', contact.id),
        async says(text, options = {}) {
          const messageId = await message(text, 'inbound', options.automated ?? false);
          const [event] = await query<{ id: string }>(
            `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                                        subject_kind, subject_id, payload)
             values (app.agency_id(), app.business_id(), 'message.received', 'contact', $1,
                     'message', $2, $3)
             returning id`,
            [randomUUID(), messageId, { conversationId: row.id, channel: 'webchat' }],
          );
          if (event === undefined) throw new Error('No event.');
          return toPublicId('event', event.id);
        },
        async answered(text) {
          await message(text, 'outbound', false);
        },
      };
    },
    field: (person, key, options = {}) =>
      crm<FieldDefinition>('createField', person, {
        body: {
          objectKey: 'contact',
          key,
          label: options.label ?? key.replaceAll('_', ' '),
          description: `What the contact said about ${key.replaceAll('_', ' ')}.`,
          valueType: options.valueType ?? 'text',
          currency: null,
          options: options.options ?? [],
          aiFillSources: options.aiFillSources ?? ['conversations'],
          aiOverwrite: options.aiOverwrite ?? 'ask',
          archived: false,
        },
      }),
    value,
    async types(person, thread, field, typed) {
      const { revision } = await value(person, thread, field);
      await crm('setRecordField', person, {
        params: { id: thread.contact, fieldId: field.id },
        body: { value: typed, revision },
      });
    },
    answers(answer) {
      world.claude.next(
        anthropicText(typeof answer === 'string' ? answer : JSON.stringify(answer)),
      );
    },
    async extract(person, conversationId, options = {}) {
      await task(options.gateway).run(
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
            ...(options.causationId === undefined ? {} : { causationId: options.causationId }),
          },
          services: world.services,
        },
      );
    },
    assistant: (person) => ({
      context: {
        agencyId: person.context.agencyId,
        ...(person.context.businessId === undefined
          ? {}
          : { businessId: person.context.businessId }),
        actorKind: 'ai_agent',
        correlationId: randomUUID(),
      },
      permissions: new Set(['fields.values', 'contacts.manage']),
      agent: 'extraction',
    }),
    async setRule(person, action, level, contactId = null, agent = 'extraction') {
      await database.withTenant(person.context, (sql) =>
        sql.query(
          `insert into ai.autonomy_rules (business_id, agent, action, contact_id, level)
           values (app.business_id(), $1, $2, $3, $4)
           on conflict on constraint autonomy_rules_unique do update set level = excluded.level`,
          [agent, action, contactId, level],
        ),
      );
    },
    asked() {
      const [request, ...more] = world.claude.requests.filter(
        (each) => each.path === '/v1/messages',
      );
      if (request === undefined || more.length > 0)
        throw new Error(
          `Expected one request to the stand-in, saw ${String(more.length + (request === undefined ? 0 : 1))}.`,
        );
      return { raw: request.body, json: request.json as Record<string, unknown> };
    },
  };
}
