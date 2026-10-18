// What the tests of Settings → AI models share: a migrated database, the settings routes as
// the app composes them, the gateway and the test task as the worker does, and local
// stand-ins for the providers. No test calls a real provider.
//
// The vault here stands in for the real one (which is proven with the real gateway in
// apps/server): like it, the app's half can only seal and destroy, and the worker's half
// opens a secret only under the caller's row-level security and for the purpose asked.
import { randomBytes, randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import type { Endpoint, EndpointOutput, Permission } from '@repo/contracts';
import { connectDatabase, type Database, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, type TenantContext } from '@repo/kernel';
import { testDatabase, type DatabaseServer, type TestDatabase } from '@repo/testing';

import { parseLocalServers } from '../src/addresses.js';
import { createTestAiConnectionTask } from '../src/connection-tests.js';
import type { SecretSealer } from '../src/connections.js';
import {
  createAiGateway,
  type AiGateway,
  type GatewayEvent,
  type SecretReader,
} from '../src/gateway.js';
import { createAiSettingsRoutes } from '../src/settings-routes.js';
import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from './fake-anthropic.js';
import { FAKE_OPENAI_KEY, startFakeOpenAi } from './fake-openai.js';
import type { FakeProvider } from './fake-provider.js';

export { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY };

export interface Person {
  readonly invocation: Invocation;
  readonly context: TenantContext;
  readonly userId: string;
  readonly name: string;
}

export interface SettingsWorld {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
  readonly gateway: AiGateway;
  /** The Claude stand-in, reached as Anthropic's own address. */
  readonly claude: FakeProvider;
  /** The OpenAI stand-in, reached as OpenAI's own address; it wants FAKE_OPENAI_KEY. */
  readonly openai: FakeProvider;
  /** A model server of the install's own that asks for no key, listed by the operator. */
  readonly ollama: FakeProvider;
  /** What the gateway told the logs. */
  readonly events: GatewayEvent[];
  /** What is sealed, by secret id: what the worker's half of the vault would open. */
  readonly sealed: ReadonlyMap<string, string>;
  /** The clock every part reads; a test moves it. */
  readonly clock: { now: Date };
  /** Calls a route as the HTTP layer would, and answers as it would. */
  call<E extends Endpoint>(
    endpoint: E,
    person: Pick<Person, 'invocation'>,
    input?: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
  ): Promise<EndpointOutput<E>>;
  readonly routes: readonly ApiRoute[];
  /** Runs the tests that are queued, as the worker would, and says how many it ran. */
  runTests(): Promise<number>;
  /** Takes the queued tests off the queue without running one. */
  discardQueuedTests(): Promise<void>;
  /** Someone with every permission in a new business of a new (or the given) agency. */
  admin(agencyId?: string): Promise<Person>;
  /** Agency staff with every permission, working at the agency. */
  agencyAdmin(agencyId: string): Promise<Person>;
  /** The same person, allowed only what is listed. */
  limited(person: Person, permissions: readonly Permission[]): Person;
  close(): Promise<void>;
}

export async function startSettingsWorld(server: DatabaseServer): Promise<SettingsWorld> {
  const database = await testDatabase(server);
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const [claude, openai, ollama] = await Promise.all([
    startFakeAnthropic(),
    startFakeOpenAi(),
    startFakeOpenAi(null),
  ]);
  const sealed = new Map<string, string>();
  const clock = { now: new Date('2026-10-10T09:00:00.000Z') };
  const now = (): Date => clock.now;

  const sealer: SecretSealer = {
    async store(trx, owner, plaintext) {
      const { id } = await trx
        .insertInto('vault.secrets')
        .values({
          agency_id: owner.agencyId,
          business_id: owner.businessId,
          purpose: owner.purpose,
          key_version: 1,
          enc: randomBytes(32),
          // Sealed bytes say nothing of what they hold.
          ciphertext: randomBytes(48),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      sealed.set(id, plaintext);
      return id;
    },
    async remove(trx, secretId) {
      await trx.deleteFrom('vault.secrets').where('id', '=', secretId).execute();
      sealed.delete(secretId);
    },
  };
  const opener: SecretReader = {
    async read(trx: DatabaseTransaction, secretId: string, purpose: string): Promise<string> {
      const row = await trx
        .selectFrom('vault.secrets')
        .select('id')
        .where('id', '=', secretId)
        .where('purpose', '=', purpose)
        .executeTakeFirst();
      const plaintext = sealed.get(secretId);
      if (row === undefined || plaintext === undefined) throw new NotFoundError('secret', secretId);
      return plaintext;
    },
  };

  const names = new Map<string, string>();
  const services: Services = { db, authorize: allowEveryone };
  const events: GatewayEvent[] = [];
  const localServers = parseLocalServers(
    `${claude.hostPort},${openai.hostPort},${ollama.hostPort}`,
  );
  const gateway = createAiGateway({
    db,
    secrets: opener,
    localServers,
    baseUrls: { anthropic: claude.origin, openai: `${openai.origin}/v1` },
    now,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    onEvent: (event) => events.push(event),
  });
  const routes = createAiSettingsRoutes({
    vault: sealer,
    // As an operator would list one model server of the install's own.
    localServers: parseLocalServers(ollama.hostPort),
    people: (_trx, ids) =>
      Promise.resolve(
        new Map(ids.flatMap((id) => (names.has(id) ? [[id, names.get(id) ?? '']] : []))),
      ),
    now,
  });
  const task = createTestAiConnectionTask(gateway, now);

  async function person(context: TenantContext): Promise<Person> {
    const user = await database.fixtures.user();
    const name = `Person ${user.id.slice(-6)}`;
    names.set(user.id, name);
    const acting: TenantContext = {
      ...context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    };
    return {
      invocation: { context: acting, permissions: 'all' },
      context: acting,
      userId: user.id,
      name,
    };
  }

  return {
    database,
    db,
    services,
    gateway,
    claude,
    openai,
    ollama,
    events,
    sealed,
    clock,
    routes,
    async call(endpoint, { invocation }, input = {}) {
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
    async discardQueuedTests() {
      await database.runJobs(['ai.test_connection']);
    },
    async runTests() {
      const jobs = await database.runJobs(['ai.test_connection']);
      for (const job of jobs) {
        const payload = job.payload as {
          agencyId: string;
          businessId: string | null;
          correlationId: string;
          data: { testId: string };
        };
        await task.run(payload.data, {
          invocation: {
            context: {
              agencyId: payload.agencyId,
              ...(payload.businessId === null ? {} : { businessId: payload.businessId }),
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
    async admin(agencyId) {
      const agency = agencyId ?? (await database.fixtures.agency()).id;
      const business = await database.fixtures.business(agency);
      return person(business.context);
    },
    agencyAdmin: (agencyId) => person({ agencyId, actorKind: 'user', correlationId: randomUUID() }),
    limited: (who, permissions) => ({
      ...who,
      invocation: { ...who.invocation, permissions: new Set(permissions) },
    }),
    async close() {
      await Promise.all([claude.stop(), openai.stop(), ollama.stop()]);
      await db.destroy();
      await database.close();
    },
  };
}
