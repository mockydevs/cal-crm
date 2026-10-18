import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createMarketplaceApp,
  generateAppWebhookSecret,
  generateMarketplaceClientSecret,
  getMarketplaceApp,
  grantOAuthAuthorization,
  installMarketplaceApp,
  listAgencyMarketplaceApps,
  listInstalledMarketplaceApps,
  listMarketplaceApps,
  listMarketplaceDeliveries,
  oauthAuthorizationRequest,
  parseInput,
  readOAuthAuthorization,
  redeliverMarketplaceWebhook,
  uninstallMarketplaceApp,
  updateMarketplaceApp,
  updateMarketplaceAppInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import type { PeopleNames } from '../api-keys/api-keys.js';
import {
  createMarketplaceAppCommand,
  installMarketplaceAppCommand,
  mayInstall,
  readAgencyApps,
  readInstalledApps,
  readListedApps,
  readMarketplaceApp,
  uninstallMarketplaceAppCommand,
  updateMarketplaceAppCommand,
} from './marketplace.js';
import {
  generateClientSecretCommand,
  grantAuthorizationCommand,
  readAuthorization,
} from './oauth.js';
import {
  generateWebhookSecretCommand,
  readDeliveries,
  redeliverCommand,
  type AppWebhookSealer,
} from './webhooks.js';

export interface MarketplaceOptions {
  /** How to name the people who installed apps; the server passes the auth module's lookup. */
  readonly people: PeopleNames;
  /**
   * The install's public address: the OAuth issuer, sent back to apps as `iss` (RFC 9207).
   * Without one, apps can't be connected, so the consent routes aren't offered.
   */
  readonly issuer?: string;
  /**
   * The app's side of the vault, which seals webhook signing secrets. Without one, an app's
   * webhook secret can't be made, so that route isn't offered.
   */
  readonly webhookVault?: AppWebhookSealer;
}

/**
 * The App Marketplace's routes: the agency's apps, a business's installs, and the
 * consent page's read and decision.
 */
export function marketplaceRoutes({
  people,
  issuer,
  webhookVault,
}: MarketplaceOptions): readonly ApiRoute[] {
  const installCommand = installMarketplaceAppCommand(people);

  const listAgency = {
    endpoint: listAgencyMarketplaceApps,
    run: async ({ invocation }, { db }) => ({
      items: await withTenant(db, invocation.context, (trx) =>
        readAgencyApps(trx, invocation.context),
      ),
    }),
  } satisfies Route<typeof listAgencyMarketplaceApps>;

  const create = {
    endpoint: createMarketplaceApp,
    command: createMarketplaceAppCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createMarketplaceAppCommand, body, invocation),
  } satisfies Route<typeof createMarketplaceApp>;

  const update = {
    endpoint: updateMarketplaceApp,
    command: updateMarketplaceAppCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        updateMarketplaceAppCommand,
        {
          ...parseInput(updateMarketplaceAppInput, body),
          ...parseInput(updateMarketplaceApp.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof updateMarketplaceApp>;

  const list = {
    endpoint: listMarketplaceApps,
    run: async ({ invocation, query }, { db }) => {
      const parsed = parseInput(listMarketplaceApps.query, query);
      return {
        items: await withTenant(db, invocation.context, (trx) =>
          readListedApps(trx, invocation.context, parsed, people),
        ),
        canInstall: mayInstall(invocation.permissions),
      };
    },
  } satisfies Route<typeof listMarketplaceApps>;

  const get = {
    endpoint: getMarketplaceApp,
    run: ({ invocation, params }, { db }) => {
      const { appId } = parseInput(getMarketplaceApp.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readMarketplaceApp(trx, invocation.context, invocation.permissions, appId, people),
      );
    },
  } satisfies Route<typeof getMarketplaceApp>;

  const install = {
    endpoint: installMarketplaceApp,
    command: installCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        installCommand,
        parseInput(installMarketplaceApp.params, params),
        invocation,
      ),
  } satisfies Route<typeof installMarketplaceApp>;

  const listInstalled = {
    endpoint: listInstalledMarketplaceApps,
    run: async ({ invocation }, { db }) => ({
      items: await withTenant(db, invocation.context, (trx) =>
        readInstalledApps(trx, invocation.context, people),
      ),
      canInstall: mayInstall(invocation.permissions),
    }),
  } satisfies Route<typeof listInstalledMarketplaceApps>;

  const uninstall = {
    endpoint: uninstallMarketplaceApp,
    command: uninstallMarketplaceAppCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        uninstallMarketplaceAppCommand,
        parseInput(uninstallMarketplaceApp.params, params),
        invocation,
      ),
  } satisfies Route<typeof uninstallMarketplaceApp>;

  const secret = {
    endpoint: generateMarketplaceClientSecret,
    command: generateClientSecretCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        generateClientSecretCommand,
        parseInput(generateMarketplaceClientSecret.params, params),
        invocation,
      ),
  } satisfies Route<typeof generateMarketplaceClientSecret>;

  const deliveries = {
    endpoint: listMarketplaceDeliveries,
    run: async ({ invocation, params, query }, { db }) => {
      const { appId } = parseInput(listMarketplaceDeliveries.params, params);
      const { status } = parseInput(listMarketplaceDeliveries.query, query);
      return {
        items: await withTenant(db, invocation.context, (trx) =>
          readDeliveries(trx, invocation.context, appId, status),
        ),
      };
    },
  } satisfies Route<typeof listMarketplaceDeliveries>;

  const redeliver = {
    endpoint: redeliverMarketplaceWebhook,
    command: redeliverCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        redeliverCommand,
        parseInput(redeliverMarketplaceWebhook.params, params),
        invocation,
      ),
  } satisfies Route<typeof redeliverMarketplaceWebhook>;

  const routes: ApiRoute[] = [
    listAgency,
    create,
    update,
    list,
    get,
    install,
    listInstalled,
    uninstall,
    secret,
    deliveries,
    redeliver,
  ];
  if (webhookVault !== undefined) {
    const webhookSecretCommand = generateWebhookSecretCommand(webhookVault);
    routes.push({
      endpoint: generateAppWebhookSecret,
      command: webhookSecretCommand,
      run: ({ invocation, params }, services) =>
        runCommand(
          services,
          webhookSecretCommand,
          parseInput(generateAppWebhookSecret.params, params),
          invocation,
        ),
    } satisfies Route<typeof generateAppWebhookSecret>);
  }
  if (issuer === undefined) return routes;

  const grantCommand = grantAuthorizationCommand(issuer);
  const readConsent = {
    endpoint: readOAuthAuthorization,
    run: ({ invocation, query }, { db }) => {
      const request = parseInput(readOAuthAuthorization.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readAuthorization(trx, invocation.context, invocation.permissions, request, issuer),
      );
    },
  } satisfies Route<typeof readOAuthAuthorization>;
  const grant = {
    endpoint: grantOAuthAuthorization,
    command: grantCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, grantCommand, parseInput(oauthAuthorizationRequest, body), invocation),
  } satisfies Route<typeof grantOAuthAuthorization>;
  return [...routes, readConsent, grant];
}
