// The API of Settings → AI models. Every route here, reading included, needs `ai.manage`:
// what a business spends on AI, which provider it uses and where its model server is are
// not for everyone who can enter the business.
//
// No route can read a key back: the app's vault only seals. And none calls a provider: a
// test is queued for the worker (connection-tests.ts).
import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Route,
  type RouteCommand,
  type Services,
} from '@repo/commands';
import {
  connectAiProvider,
  getAiConnectionTest,
  getAiSettings,
  getAiUsage,
  listAiConnections,
  listAiModelPrices,
  parseInput,
  removeAiConnection,
  removeAiModelPrice,
  setAiModelPrice,
  startAiConnectionTest,
  updateAiConnection,
  updateAiConnectionInput,
  updateAiSettings,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import type { LocalServer } from './addresses.js';
import { createStartTestCommand, readAiConnectionTest } from './connection-tests.js';
import {
  createConnectionCommands,
  readAiConnections,
  type PeopleNames,
  type SecretSealer,
} from './connections.js';
import { createPriceCommands, readAiModelPrices } from './model-prices.js';
import { readAiSettings, readAiUsage, updateAiSettingsCommand } from './settings.js';

export interface AiSettingsOptions {
  /** The app's vault: it seals a key for the worker and cannot open one. */
  readonly vault: SecretSealer;
  /** Config.aiLocalServers: the only private or plain-http addresses that may be saved. */
  readonly localServers: readonly LocalServer[];
  /** Who added a connection, by name. */
  readonly people: PeopleNames;
  readonly now?: () => Date;
}

/** Reading is gated like changing: refuses, and records the refusal, without `ai.manage`. */
const allowed = (services: Services, name: string, invocation: Invocation): Promise<void> =>
  requirePermission(services, { name, permission: 'ai.manage' } satisfies RouteCommand, invocation);

export function createAiSettingsRoutes(options: AiSettingsOptions): readonly ApiRoute[] {
  const now = options.now ?? (() => new Date());
  const { people } = options;
  const connections = createConnectionCommands(
    { vault: options.vault, localServers: options.localServers, now },
    people,
  );
  const startTest = createStartTestCommand(now);
  const prices = createPriceCommands(now);

  return [
    {
      endpoint: listAiConnections,
      async run({ invocation }, services) {
        await allowed(services, 'ai.list_connections', invocation);
        return withTenant(services.db, invocation.context, async (trx) => ({
          data: await readAiConnections(trx, invocation.context, people),
        }));
      },
    } satisfies Route<typeof listAiConnections>,
    {
      endpoint: connectAiProvider,
      command: connections.connect,
      run: ({ invocation, body }, services) =>
        runCommand(services, connections.connect, body, invocation),
    } satisfies Route<typeof connectAiProvider>,
    {
      endpoint: updateAiConnection,
      command: connections.update,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          connections.update,
          {
            ...parseInput(updateAiConnection.params, params),
            changes: parseInput(updateAiConnectionInput, body),
          },
          invocation,
        ),
    } satisfies Route<typeof updateAiConnection>,
    {
      endpoint: startAiConnectionTest,
      command: startTest,
      run: ({ invocation, body }, services) => runCommand(services, startTest, body, invocation),
    } satisfies Route<typeof startAiConnectionTest>,
    {
      endpoint: getAiConnectionTest,
      async run({ invocation, params }, services) {
        await allowed(services, 'ai.read_connection_test', invocation);
        const { id } = parseInput(getAiConnectionTest.params, params);
        return withTenant(services.db, invocation.context, (trx) =>
          readAiConnectionTest(trx, invocation.context, id, now),
        );
      },
    } satisfies Route<typeof getAiConnectionTest>,
    {
      endpoint: removeAiConnection,
      command: connections.remove,
      run: ({ invocation, params }, services) =>
        runCommand(services, connections.remove, params, invocation),
    } satisfies Route<typeof removeAiConnection>,
    {
      endpoint: getAiSettings,
      async run({ invocation }, services) {
        await allowed(services, 'ai.read_settings', invocation);
        requireBusiness(invocation.context);
        return withTenant(services.db, invocation.context, (trx) =>
          readAiSettings(trx, invocation),
        );
      },
    } satisfies Route<typeof getAiSettings>,
    {
      endpoint: updateAiSettings,
      command: updateAiSettingsCommand,
      run: ({ invocation, body }, services) =>
        runCommand(services, updateAiSettingsCommand, body, invocation),
    } satisfies Route<typeof updateAiSettings>,
    {
      endpoint: getAiUsage,
      async run({ invocation }, services) {
        await allowed(services, 'ai.read_usage', invocation);
        requireBusiness(invocation.context);
        return withTenant(services.db, invocation.context, (trx) =>
          readAiUsage(trx, invocation, now),
        );
      },
    } satisfies Route<typeof getAiUsage>,
    {
      endpoint: listAiModelPrices,
      async run({ invocation }, services) {
        await allowed(services, 'ai.list_model_prices', invocation);
        return withTenant(services.db, invocation.context, (trx) =>
          readAiModelPrices(trx, invocation),
        );
      },
    } satisfies Route<typeof listAiModelPrices>,
    {
      endpoint: setAiModelPrice,
      command: prices.set,
      run: ({ invocation, body }, services) => runCommand(services, prices.set, body, invocation),
    } satisfies Route<typeof setAiModelPrice>,
    {
      endpoint: removeAiModelPrice,
      command: prices.remove,
      run: ({ invocation, query }, services) =>
        runCommand(services, prices.remove, query, invocation),
    } satisfies Route<typeof removeAiModelPrice>,
  ];
}
