// What the tests of the in-app assistant share: the world of the Settings tests (a migrated
// database, the gateway as the worker composes it, and a local stand-in for Claude that a
// test scripts), with the assistant's conversation routes, the job that runs a turn, and a
// few tools.
//
// The tools are the CRM's own tag routes, which this module can reach, and a stand-in for
// publishing a form, which it cannot (forms are another module's; the real ones are proven
// with the assistant in apps/server). The stand-in keeps what matters to a tool that makes
// something live: it needs its own permission, it is proposed and never run by the
// assistant, and applying it leaves a mark a test can read.
import { randomUUID } from 'node:crypto';

import {
  defineCommand,
  defineProposable,
  requireBusiness,
  type ApiRoute,
  type Proposable,
} from '@repo/commands';
import {
  connectAiProvider,
  formRevisionInput,
  publicId,
  publishForm,
  type AssistantCheck,
  type AssistantTool,
  type Endpoint,
  type EndpointOutput,
  type Permission,
} from '@repo/contracts';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { crmRoutes } from '@repo/module-crm';
import type { DatabaseServer } from '@repo/testing';

import { createAssistantChatRoutes } from '../src/assistant-chat-routes.js';
import { createAssistantRoutes } from '../src/assistant-routes.js';
import { createAssistantToolbox, type AssistantToolbox } from '../src/assistant-toolbox.js';
import {
  createAssistantTurnTask,
  type AssistantTurnEvent,
  type AssistantTurnOptions,
} from '../src/assistant-turn.js';
import type { AiGateway } from '../src/gateway.js';
import {
  FAKE_ANTHROPIC_KEY,
  startSettingsWorld,
  type Person,
  type SettingsWorld,
} from './settings-world.js';

export interface CopilotWorld extends SettingsWorld {
  readonly chatRoutes: readonly ApiRoute[];
  readonly toolbox: AssistantToolbox;
  readonly proposables: readonly Proposable[];
  /** What each finished turn told the log. */
  readonly turnEvents: AssistantTurnEvent[];
  /** Faults the job reported. */
  readonly faults: unknown[];
  /**
   * What each person's role allows when a turn runs, by user id. A person a test has not
   * listed keeps what their request had; `undefined` is someone who no longer works there.
   */
  readonly grants: Map<string, ReadonlySet<Permission> | undefined>;
  /** Calls a route of the assistant as the HTTP layer would, and checks the answer's shape. */
  ask<E extends Endpoint>(
    endpoint: E,
    person: Pick<Person, 'invocation'>,
    input?: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
  ): Promise<EndpointOutput<E>>;
  /** A business that can call Claude with a key of its own, and its admin. */
  connected(): Promise<Person>;
  /** Someone else working in the same business, with every permission. */
  colleague(person: Person): Promise<Person>;
  /**
   * Runs the turns that are queued, as the worker would, and says how many it ran. A test
   * may give it another gateway, or other limits.
   */
  runTurns(options?: {
    readonly gateway?: Pick<AiGateway, 'generate'>;
    readonly limits?: AssistantTurnOptions['limits'];
  }): Promise<number>;
  /** Runs one turn's job directly, as a second delivery of it would. */
  runTurn(person: Person, turnId: string): Promise<void>;
  /** The names of the business's tags, in order: what the tools here leave behind. */
  tags(person: Person): Promise<string[]>;
}

/** The form every test's page is about: an id of the right shape, and no row behind it. */
export const STAND_IN_FORM = toPublicId('form', '01890a5d-ac96-774b-bcce-b302099a8057');
export const STAND_IN_REVISION = 'c'.repeat(64);
/** A form the page reader does not find. */
export const MISSING_FORM = toPublicId('form', '01890a5d-ac96-774b-bcce-b302099a8058');

export const STAND_IN_CHECKS: readonly AssistantCheck[] = [
  {
    severity: 'suggestion',
    code: 'no_consent_box',
    message: 'This form has no consent box.',
    target: { kind: 'form', id: STAND_IN_FORM, section: 'consent', path: '/consents' },
  },
  {
    severity: 'blocker',
    code: 'no_identity',
    message: 'Ask for an email address.',
    target: { kind: 'form', id: STAND_IN_FORM, section: 'questions', path: '/fields' },
  },
];

const REGISTRY: readonly AssistantTool[] = [
  { operationId: 'listTags', group: 'forms', effect: 'read' },
  { operationId: 'createTag', group: 'forms', effect: 'draft' },
  { operationId: 'getAssistantContext', group: 'forms', effect: 'read' },
  { operationId: 'publishForm', group: 'forms', effect: 'confirm' },
];

export async function startCopilotWorld(server: DatabaseServer): Promise<CopilotWorld> {
  const world = await startSettingsWorld(server);
  const { database, services } = world;
  const now = (): Date => world.clock.now;

  // Stands in for publishing a form: it "publishes" by leaving a tag named for the form.
  const publishInput = formRevisionInput.extend({ id: publicId('form') });
  const publish = defineCommand({
    name: 'test.publish_form',
    permission: 'forms.manage',
    input: publishInput,
    delegation: { action: 'publish' },
    async handle(trx, { id }, command) {
      if (id === MISSING_FORM) throw new NotFoundError('Form', id);
      const tag = await trx
        .insertInto('crm.tags')
        .values({
          business_id: requireBusiness(command.context),
          name: `published ${id}`,
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({ type: 'form.published', subject: { kind: 'form', id: tag.id } });
      return { id };
    },
  });
  const proposables = [
    defineProposable({
      kind: 'form_publish',
      command: publish,
      agents: ['copilot'],
      subject: () => Promise.resolve({}),
      revision: (_trx, { revision }) => Promise.resolve(revision),
      present(_trx, { id }) {
        if (id === MISSING_FORM) throw new NotFoundError('Form', id);
        return Promise.resolve({
          kind: 'form_publish',
          formId: id,
          name: 'Wedding enquiry',
          questions: 3,
          consents: 0,
          republish: false,
        });
      },
      capture: () => Promise.resolve(null),
      result: (output) => ({ formId: output.id }),
      undo: () => ({ impossible: 'published_before' }),
    }),
  ];
  const actorNames = {
    user: (_trx: unknown, ids: readonly string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, `Person ${id.slice(-6)}`]))),
  };

  /** What a page shows, in place of the modules that own the pages. */
  const page: AssistantTurnOptions['page'] = (_trx, _invocation, asked) => {
    if (asked.record === undefined) return Promise.resolve({ subject: null, checks: [] });
    if (asked.record.id === MISSING_FORM)
      return Promise.reject(new NotFoundError('Form', asked.record.id));
    return Promise.resolve({
      subject: { kind: asked.record.kind, id: asked.record.id, name: 'Wedding enquiry' },
      checks: STAND_IN_CHECKS,
      chips: [
        { code: 'form.whats_missing', label: 'What is missing?', prompt: 'What is missing?' },
      ],
    });
  };

  const chatRoutes = createAssistantChatRoutes({ proposables, actorNames, page, now });
  const proposalRoutes = createAssistantRoutes({
    proposables,
    actorNames,
    findConversation: () => Promise.resolve(undefined),
    now,
  });
  const routes: readonly ApiRoute[] = [
    ...chatRoutes,
    ...proposalRoutes,
    ...crmRoutes,
    // Only its contract is read: a tool that makes something live is never run.
    {
      endpoint: publishForm,
      run: () => Promise.reject(new Error('The assistant ran a tool that makes something live.')),
    },
  ];
  const faults: unknown[] = [];
  const toolbox = createAssistantToolbox({
    routes,
    services,
    registry: REGISTRY,
    onFault: (_operationId, error) => faults.push(error),
  });
  const turnEvents: AssistantTurnEvent[] = [];
  const grants = new Map<string, ReadonlySet<Permission> | undefined>();
  const requested = new Map<string, ReadonlySet<Permission>>();

  const task = (
    gateway: Pick<AiGateway, 'generate'> = world.gateway,
    limits?: AssistantTurnOptions['limits'],
  ) =>
    createAssistantTurnTask(gateway, {
      toolbox,
      proposables,
      confirmations: {
        publishForm: {
          kind: 'form_publish',
          input: ({ params, body }) => ({ id: params['id'], revision: body['revision'] }),
          summary: (change) => `Publish the form “${String(change['name'])}”`,
        },
      },
      grants: (_trx, _context, userId) =>
        Promise.resolve(grants.has(userId) ? grants.get(userId) : requested.get(userId)),
      page,
      now,
      onTurn: (event) => turnEvents.push(event),
      onFault: (_turnId, error) => faults.push(error),
      ...(limits === undefined ? {} : { limits }),
    });

  const everything = (): ReadonlySet<Permission> =>
    new Set<Permission>([
      'assistant.use',
      'forms.manage',
      'tags.manage',
      'tags.configure',
      'ai.manage',
    ]);

  return {
    ...world,
    chatRoutes,
    toolbox,
    proposables,
    turnEvents,
    faults,
    grants,
    async ask(endpoint, { invocation }, input = {}) {
      const route = routes.find((each) => each.endpoint === endpoint);
      if (route === undefined) throw new Error(`No route for ${endpoint.operationId}.`);
      const answer = await route.run(
        {
          invocation,
          params: input.params ?? {},
          query: input.query ?? {},
          body: input.body,
        },
        services,
      );
      // What goes over the wire: whatever is not JSON would not arrive.
      const wire: unknown = answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
      if (endpoint.response.schema !== undefined) endpoint.response.schema.parse(wire);
      return wire as EndpointOutput<typeof endpoint>;
    },
    async connected() {
      const person = await world.admin();
      await database.withTenant(person.context, (sql) =>
        sql.query(
          `insert into ai.settings (business_id, key_source) values (app.business_id(), 'own')`,
        ),
      );
      await world.call(connectAiProvider, person, {
        body: { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY },
      });
      await database.runJobs(['ai.test_connection']);
      requested.set(person.userId, everything());
      return person;
    },
    async colleague(person) {
      const user = await database.fixtures.user();
      const context = {
        ...person.context,
        userId: user.id,
        actorId: user.id,
        correlationId: randomUUID(),
      };
      requested.set(user.id, everything());
      return {
        invocation: { context, permissions: 'all' },
        context,
        userId: user.id,
        name: `Person ${user.id.slice(-6)}`,
      };
    },
    async runTurns(options = {}) {
      const jobs = await database.runJobs(['ai.assistant_turn']);
      for (const job of jobs) {
        const payload = job.payload as {
          agencyId: string;
          businessId: string;
          correlationId: string;
          data: { turnId: string };
        };
        await task(options.gateway, options.limits).run(payload.data, {
          invocation: {
            context: {
              agencyId: payload.agencyId,
              businessId: payload.businessId,
              actorKind: 'system',
              correlationId: payload.correlationId,
            },
            permissions: 'all',
          },
          services,
        });
      }
      return jobs.length;
    },
    async runTurn(person, turnId) {
      await task().run(
        { turnId: parsePublicId('assistant_turn', turnId) ?? turnId },
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
          services,
        },
      );
    },
    tags: async (person) =>
      (
        await database.withTenant(person.context, (sql) =>
          sql.query<{ name: string }>('select name from crm.tags order by name'),
        )
      ).map((row) => row.name),
  };
}
