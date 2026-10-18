// What the two suites that try every endpoint need for the App Marketplace: an
// app of a business's agency and an install, added directly so each test pays a statement
// or two; an input for each operation that the business's own member could send and have
// accepted; and an example of every command for the permission matrix.
import { toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import type { LightMyRequestResponse } from 'fastify';

export interface MarketplaceRecords {
  readonly marketplace_app: string;
  readonly marketplace_install: string;
  readonly marketplace_delivery: string;
}

/** An app of the business's agency, asking for no permission, by its public id. */
export async function addMarketplaceApp(
  database: TestDatabase,
  businessId: string,
  status: 'draft' | 'listed' | 'delisted',
): Promise<string> {
  const row = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.marketplace_apps (agency_id, name, developer, status, created_by)
       select agency_id, 'Business B only', 'Matrix Labs', $2, uuidv7()
       from tenancy.businesses where id = $1 returning id`,
      [businessId, status],
    ),
  );
  return toPublicId('marketplace_app', row.id);
}

/**
 * A delisted app installed in the business. Its agency's other businesses can't see it:
 * delisted, an app is seen only where it is installed.
 */
export async function addMarketplaceRecords(
  database: TestDatabase,
  businessId: string,
): Promise<MarketplaceRecords> {
  const app = await database.as('crm_owner', (sql) =>
    sql.one<{ app: string; install: string; delivery: string }>(
      `with a as (
         insert into tenancy.marketplace_apps (agency_id, name, developer, status, created_by)
         select agency_id, 'Business B only', 'Matrix Labs', 'delisted', uuidv7()
         from tenancy.businesses where id = $1 returning agency_id, id
       ), i as (
         insert into tenancy.marketplace_installs
           (business_id, agency_id, app_id, granted_scopes, installed_by)
         select $1, a.agency_id, a.id, '{}', uuidv7() from a returning id, agency_id, app_id
       ), d as (
         insert into tenancy.marketplace_webhook_deliveries
           (business_id, agency_id, install_id, app_id, event_id, event_type, body)
         select $1, i.agency_id, i.id, i.app_id, uuidv7(), 'contact.created', '{}' from i
         returning id
       )
       select a.id as app, i.id as install, d.id as delivery from a, i, d`,
      [businessId],
    ),
  );
  return {
    marketplace_app: toPublicId('marketplace_app', app.app),
    marketplace_install: toPublicId('marketplace_install', app.install),
    marketplace_delivery: toPublicId('marketplace_delivery', app.delivery),
  };
}

/** Where the matrix's connectable apps send codes. */
export const MATRIX_REDIRECT = 'https://matrix.example/callback';

/**
 * A listed app of the business's agency that can be connected: a redirect
 * address, a client secret, and no permission asked for.
 */
export async function addConnectableApp(
  database: TestDatabase,
  businessId: string,
): Promise<string> {
  const row = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.marketplace_apps (agency_id, name, developer, status, created_by,
         redirect_uris, client_secret_hash, client_secret_prefix, client_secret_set_at)
       select agency_id, 'Connectable', 'Matrix Labs', 'listed', uuidv7(), array[$2],
              sha256(gen_random_uuid()::text::bytea), 'crm_cs_00000000', now()
       from tenancy.businesses where id = $1 returning id`,
      [businessId, MATRIX_REDIRECT],
    ),
  );
  return toPublicId('marketplace_app', row.id);
}

/** An authorization request for the app, as its consent page passes it on. */
export const authorizationRequest = (clientId: string): Record<string, string> => ({
  clientId,
  redirectUri: MATRIX_REDIRECT,
  responseType: 'code',
  state: 'matrix',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  codeChallengeMethod: 'S256',
});

const APP = { name: 'Reached from A', developer: 'Matrix Labs' };

/** What B's own member could send for each App Marketplace operation. */
export function marketplaceInputs(
  records: Readonly<Record<string, string>>,
): Readonly<Record<string, { payload?: unknown; query?: string }>> {
  const connect = authorizationRequest(records['marketplace_app'] ?? '');
  return {
    createMarketplaceApp: { payload: APP },
    updateMarketplaceApp: { payload: { ...APP, status: 'listed' } },
    readOAuthAuthorization: { query: `?${new URLSearchParams(connect).toString()}` },
    grantOAuthAuthorization: { payload: connect },
  };
}

type Call = (
  method: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'DELETE',
  path: string,
  options: { payload: unknown; type?: string; inBusiness: boolean },
) => Promise<LightMyRequestResponse>;

interface Example {
  readonly run: (call: Call, run: number) => Promise<LightMyRequestResponse>;
}

/** An example of every App Marketplace command, each on an app added for that try. */
export function marketplaceExamples(
  database: () => TestDatabase,
  business: () => string,
): Readonly<Record<string, Example>> {
  return {
    'marketplace_app.create': {
      run: (call, run) =>
        call('POST', '/agency/marketplace/apps', {
          payload: { ...APP, name: `Matrix ${String(run)}` },
          inBusiness: false,
        }),
    },
    'marketplace_app.update': {
      run: async (call) =>
        call(
          'PUT',
          `/agency/marketplace/apps/${await addMarketplaceApp(database(), business(), 'draft')}`,
          { payload: { ...APP, status: 'listed' }, inBusiness: false },
        ),
    },
    'marketplace_app.generate_secret': {
      run: async (call) =>
        call(
          'POST',
          `/agency/marketplace/apps/${await addMarketplaceApp(database(), business(), 'draft')}/client-secret`,
          { payload: undefined, inBusiness: false },
        ),
    },
    'marketplace_app.generate_webhook_secret': {
      run: async (call) =>
        call(
          'POST',
          `/agency/marketplace/apps/${await addMarketplaceApp(database(), business(), 'draft')}/webhook-secret`,
          { payload: undefined, inBusiness: false },
        ),
    },
    'marketplace_app.redeliver_webhook': {
      run: async (call) => {
        const { marketplace_delivery: delivery } = await addMarketplaceRecords(
          database(),
          business(),
        );
        return call('POST', `/agency/marketplace/deliveries/${delivery}/redeliver`, {
          payload: undefined,
          inBusiness: false,
        });
      },
    },
    'marketplace_app.authorize': {
      run: async (call) =>
        call('POST', '/oauth/authorize', {
          payload: authorizationRequest(await addConnectableApp(database(), business())),
          inBusiness: true,
        }),
    },
    'marketplace_app.install': {
      run: async (call) =>
        call(
          'POST',
          `/marketplace/apps/${await addMarketplaceApp(database(), business(), 'listed')}/install`,
          { payload: undefined, inBusiness: true },
        ),
    },
    'marketplace_app.uninstall': {
      run: async (call) => {
        const { marketplace_install: install } = await addMarketplaceRecords(
          database(),
          business(),
        );
        return call('DELETE', `/marketplace/installs/${install}`, {
          payload: undefined,
          inBusiness: true,
        });
      },
    },
  };
}

/** Publishing apps: the agency's own work (apps.manage, at the agency). */
export const MARKETPLACE_PUBLISH_COMMANDS: readonly string[] = [
  'marketplace_app.create',
  'marketplace_app.update',
  'marketplace_app.generate_secret',
  'marketplace_app.generate_webhook_secret',
  'marketplace_app.redeliver_webhook',
];

/**
 * Installing, uninstalling and connecting: apps.manage in the business, as API
 * keys are.
 */
export const MARKETPLACE_INSTALL_COMMANDS: readonly string[] = [
  'marketplace_app.install',
  'marketplace_app.uninstall',
  'marketplace_app.authorize',
];
