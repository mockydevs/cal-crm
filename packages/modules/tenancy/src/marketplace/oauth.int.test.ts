// OAuth for installed apps, the tenancy side: the client secret, the consent
// page's read and decision, and what installing and uninstalling do to the app's access.
import { createHash, randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  agencyMarketplaceApp,
  agencyMarketplaceAppList,
  marketplaceClientSecret,
  marketplaceInstall,
  oauthAuthorizationGrant,
  oauthAuthorizationView,
  oauthClientSecretFormat,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { readApiKeys } from '../api-keys/api-keys.js';
import { marketplaceRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;

const issuer = 'https://crm.example';
const routes = marketplaceRoutes({ people: () => Promise.resolve(new Map()), issuer });

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
) {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`No route for ${operationId}.`);
  return found.run(
    {
      invocation,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );
}

async function person(
  where: TenantContext,
  permissions: Iterable<Permission> | 'all',
): Promise<Invocation> {
  const user = await database.fixtures.user();
  return {
    context: {
      ...where,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: permissions === 'all' ? 'all' : new Set(permissions),
  };
}

const redirectUri = 'https://sync.example/oauth/callback?tenant=7';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** An agency's listed app with a redirect address and a client secret, and a business. */
async function connectableApp(values: Record<string, unknown> = {}) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const publisher = await person(
    { agencyId: agency.id, actorKind: 'system', correlationId: randomUUID() },
    ['apps.manage'],
  );
  const body = {
    name: 'Harbor Sync',
    developer: 'Harbor Labs',
    scopes: ['tags.manage', 'contacts.manage'],
    readGroups: ['Tags', 'Contacts'],
    redirectUris: [redirectUri, 'http://localhost:3000/cb'],
    ...values,
  };
  const app = agencyMarketplaceApp.parse(await call('createMarketplaceApp', publisher, { body }));
  await call('updateMarketplaceApp', publisher, {
    params: { appId: app.id },
    body: { ...body, status: 'listed' },
  });
  const secret = marketplaceClientSecret.parse(
    await call('generateMarketplaceClientSecret', publisher, { params: { appId: app.id } }),
  );
  const installer = await person(business.context, [
    'apps.manage',
    'tags.manage',
    'contacts.manage',
  ]);
  return { agency, business, publisher, app, secret, installer };
}

const request = (clientId: string, values: Record<string, string | undefined> = {}) => ({
  clientId,
  redirectUri,
  responseType: 'code',
  state: 'xyz-123',
  codeChallenge: challenge,
  codeChallengeMethod: 'S256',
  ...values,
});

const read = async (invocation: Invocation, query: Record<string, unknown>) =>
  oauthAuthorizationView.parse(await call('readOAuthAuthorization', invocation, { query }));

const grant = async (invocation: Invocation, body: Record<string, unknown>) =>
  oauthAuthorizationGrant.parse(await call('grantOAuthAuthorization', invocation, { body }));

const ownerQuery = <Row extends object>(text: string, values: readonly unknown[]) =>
  database.as('crm_owner', (sql) => sql.query<Row>(text, values));

describe('the client secret', () => {
  it('is shown once, kept as a hash, and replaced by the next one', async () => {
    const { publisher, app, secret } = await connectableApp();
    expect(secret.clientId).toBe(app.id);
    expect(secret.clientSecret).toMatch(oauthClientSecretFormat);
    expect(secret.clientSecretPrefix).toBe(secret.clientSecret.slice(0, 15));

    const [listed] = agencyMarketplaceAppList.parse(
      await call('listAgencyMarketplaceApps', publisher),
    ).items;
    expect(listed).toMatchObject({
      clientSecretPrefix: secret.clientSecretPrefix,
      clientSecretSetAt: secret.clientSecretSetAt,
      redirectUris: [redirectUri, 'http://localhost:3000/cb'],
    });
    const [stored] = await ownerQuery<{ client_secret_hash: Buffer }>(
      'select client_secret_hash from tenancy.marketplace_apps where id = $1',
      [parsePublicId('marketplace_app', app.id)],
    );
    expect(stored?.client_secret_hash).toEqual(
      createHash('sha256').update(secret.clientSecret).digest(),
    );

    const next = marketplaceClientSecret.parse(
      await call('generateMarketplaceClientSecret', publisher, { params: { appId: app.id } }),
    );
    expect(next.clientSecret).not.toBe(secret.clientSecret);
  });

  it('is only the agency’s own app’s, and only a person generates it', async () => {
    const { app } = await connectableApp();
    const other = await database.fixtures.agency();
    const stranger = await person(
      { agencyId: other.id, actorKind: 'system', correlationId: randomUUID() },
      ['apps.manage'],
    );
    await expect(
      call('generateMarketplaceClientSecret', stranger, { params: { appId: app.id } }),
    ).rejects.toThrow(NotFoundError);
    const key: Invocation = {
      context: { ...stranger.context, actorKind: 'api_key', actorId: randomUUID() },
      permissions: 'all',
    };
    await expect(
      call('generateMarketplaceClientSecret', key, { params: { appId: app.id } }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('reading an authorization request', () => {
  it('shows the app, what it gets here and where Cancel goes', async () => {
    const { app, installer } = await connectableApp();
    const view = await read(installer, request(app.id));
    expect(view).toEqual({
      kind: 'consent',
      app: {
        id: app.id,
        name: 'Harbor Sync',
        developer: 'Harbor Labs',
        iconUrl: null,
        websiteUrl: null,
      },
      scopes: ['tags.manage', 'contacts.manage'],
      readGroups: ['Tags', 'Contacts'],
      webhookEvents: [],
      missingScopes: [],
      canInstall: true,
      installed: false,
      denyUrl:
        'https://sync.example/oauth/callback?tenant=7&error=access_denied&state=xyz-123&iss=https%3A%2F%2Fcrm.example',
    });
  });

  it('names the permissions the reader lacks', async () => {
    const { app, business } = await connectableApp();
    const reader = await person(business.context, ['tags.manage']);
    const view = await read(reader, request(app.id));
    expect(view).toMatchObject({ missingScopes: ['contacts.manage'], canInstall: false });
  });

  it('never sends anyone to an app it can’t name, or an address the app didn’t register', async () => {
    const { app, installer } = await connectableApp();
    await expect(read(installer, request('not-an-app'))).rejects.toThrow(ValidationError);
    await expect(read(installer, request(app.id, { clientId: undefined }))).rejects.toThrow(
      ValidationError,
    );
    await expect(
      read(installer, request(app.id, { redirectUri: 'https://evil.example/cb' })),
    ).rejects.toThrow(ValidationError);
    // The registered address is matched exactly: without its query it is another one.
    await expect(
      read(installer, request(app.id, { redirectUri: 'https://sync.example/oauth/callback' })),
    ).rejects.toThrow(ValidationError);
    const other = await connectableApp();
    await expect(read(installer, request(other.app.id))).rejects.toThrow(NotFoundError);
  });

  it('a draft app is not found, as on the marketplace', async () => {
    const { app, publisher, installer } = await connectableApp();
    await call('updateMarketplaceApp', publisher, {
      params: { appId: app.id },
      body: {
        name: app.name,
        developer: app.developer,
        scopes: app.scopes,
        redirectUris: [redirectUri],
        status: 'draft',
      },
    });
    await expect(read(installer, request(app.id))).rejects.toThrow(NotFoundError);
  });

  it('tells the app, in OAuth’s words, what else is wrong with its request', async () => {
    const { app, installer } = await connectableApp();
    const refusal = async (values: Record<string, string | undefined>) => {
      const view = await read(installer, request(app.id, values));
      if (view.kind !== 'refused') throw new Error('expected a refusal');
      const url = new URL(view.redirectUrl);
      expect(url.origin + url.pathname).toBe('https://sync.example/oauth/callback');
      expect(url.searchParams.get('tenant')).toBe('7');
      expect(url.searchParams.get('state')).toBe('xyz-123');
      expect(url.searchParams.get('iss')).toBe(issuer);
      expect(url.searchParams.get('error')).toBe(view.error);
      return view.error;
    };
    expect(await refusal({ responseType: 'token' })).toBe('unsupported_response_type');
    expect(await refusal({ codeChallengeMethod: 'plain' })).toBe('invalid_request');
    expect(await refusal({ codeChallengeMethod: undefined })).toBe('invalid_request');
    expect(await refusal({ codeChallenge: 'short' })).toBe('invalid_request');
    expect(await refusal({ scope: 'tags.manage payments.manage' })).toBe('invalid_scope');
    // Asking for part of what the app lists is fine.
    expect((await read(installer, request(app.id, { scope: 'tags.manage' }))).kind).toBe('consent');
  });

  it('refuses an app whose developer hasn’t a client secret yet', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const publisher = await person(
      { agencyId: agency.id, actorKind: 'system', correlationId: randomUUID() },
      ['apps.manage'],
    );
    const body = { name: 'No Secret', developer: 'Harbor', redirectUris: [redirectUri] };
    const app = agencyMarketplaceApp.parse(await call('createMarketplaceApp', publisher, { body }));
    await call('updateMarketplaceApp', publisher, {
      params: { appId: app.id },
      body: { ...body, status: 'listed' },
    });
    const installer = await person(business.context, ['apps.manage']);
    const view = await read(installer, request(app.id));
    expect(view).toMatchObject({ kind: 'refused', error: 'unauthorized_client' });
  });
});

describe('allowing an app', () => {
  it('installs it, makes its app key and issues a code for its redirect address', async () => {
    const { app, business, installer } = await connectableApp();
    const { redirectUrl } = await grant(installer, request(app.id));
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe('https://sync.example/oauth/callback');
    expect(url.searchParams.get('tenant')).toBe('7');
    expect(url.searchParams.get('state')).toBe('xyz-123');
    expect(url.searchParams.get('iss')).toBe(issuer);
    const code = url.searchParams.get('code') ?? '';
    expect(code).toMatch(/^crm_ac_[0-9a-f]{64}$/);

    const appId = parsePublicId('marketplace_app', app.id);
    const [install] = await ownerQuery<{ id: string; granted_scopes: string[] }>(
      'select id, granted_scopes from tenancy.marketplace_installs where app_id = $1 and business_id = $2',
      [appId, business.id],
    );
    expect(install?.granted_scopes).toEqual(['tags.manage', 'contacts.manage']);
    const [key] = await ownerQuery<{
      name: string;
      scopes: string[];
      read_groups: string[] | null;
      key_hash: Buffer | null;
    }>(
      'select name, scopes, read_groups, key_hash from tenancy.api_keys where marketplace_install_id = $1',
      [install?.id],
    );
    expect(key).toEqual({
      name: 'Harbor Sync',
      scopes: ['tags.manage', 'contacts.manage'],
      read_groups: ['Tags', 'Contacts'],
      key_hash: null,
    });
    const [stored] = await ownerQuery<{
      redirect_uri: string;
      code_challenge: string;
      issued_by: string;
      ttl: number;
      used_at: Date | null;
    }>(
      `select redirect_uri, code_challenge, issued_by, used_at,
              extract(epoch from expires_at - created_at)::int as ttl
         from tenancy.marketplace_oauth_codes where code_hash = $1`,
      [createHash('sha256').update(code).digest()],
    );
    expect(stored).toEqual({
      redirect_uri: redirectUri,
      code_challenge: challenge,
      issued_by: installer.context.userId,
      used_at: null,
      ttl: 600,
    });
    const events = await ownerQuery<{ type: string }>(
      `select type from events.events where business_id = $1 and subject_id = $2 order by occurred_at, id`,
      [business.id, appId],
    );
    expect(events.map((each) => each.type)).toEqual([
      'marketplace_app.installed',
      'marketplace_app.authorized',
    ]);
  });

  it('issues a new code for an app already installed, without a second install', async () => {
    const { app, business, installer } = await connectableApp();
    await grant(installer, request(app.id));
    const again = await read(installer, request(app.id));
    expect(again).toMatchObject({ kind: 'consent', installed: true });
    await grant(installer, request(app.id, { redirectUri: 'http://localhost:3000/cb' }));
    const installs = await ownerQuery<{ id: string }>(
      'select id from tenancy.marketplace_installs where business_id = $1',
      [business.id],
    );
    expect(installs).toHaveLength(1);
    const codes = await ownerQuery<{ id: string }>(
      'select id from tenancy.marketplace_oauth_codes where business_id = $1',
      [business.id],
    );
    expect(codes).toHaveLength(2);
  });

  it('is refused to someone without every permission, or without apps.manage', async () => {
    const { app, business, installer } = await connectableApp();
    const partial = await person(business.context, ['apps.manage', 'tags.manage']);
    await expect(grant(partial, request(app.id))).rejects.toThrow(ForbiddenError);
    // Installed by someone who could; still refused to someone who couldn't.
    await grant(installer, request(app.id));
    await expect(grant(partial, request(app.id))).rejects.toThrow(ForbiddenError);
  });

  it('is refused for a request the app has to be told about', async () => {
    const { app, installer } = await connectableApp();
    await expect(grant(installer, request(app.id, { responseType: 'token' }))).rejects.toThrow(
      ValidationError,
    );
    await expect(
      grant(installer, request(app.id, { redirectUri: 'https://evil.example/cb' })),
    ).rejects.toThrow(ValidationError);
  });
});

describe('installing and uninstalling', () => {
  it('an install from the marketplace makes an app key that the API keys page leaves out', async () => {
    const { app, business, installer } = await connectableApp();
    const install = marketplaceInstall.parse(
      await call('installMarketplaceApp', installer, { params: { appId: app.id } }),
    );
    const [key] = await ownerQuery<{ id: string }>(
      'select id from tenancy.api_keys where marketplace_install_id = $1',
      [parsePublicId('marketplace_install', install.id)],
    );
    expect(key).toBeDefined();
    const listed = await withTenant(db, installer.context, (trx) =>
      readApiKeys(trx, business.id, () => Promise.resolve(new Map())),
    );
    expect(listed).toEqual([]);
  });

  it('uninstalling stops the app key and every token, and says why', async () => {
    const { app, business, installer } = await connectableApp();
    await grant(installer, request(app.id));
    const [install] = await ownerQuery<{ id: string; agency_id: string }>(
      'select id, agency_id from tenancy.marketplace_installs where business_id = $1',
      [business.id],
    );
    const [code] = await ownerQuery<{ id: string }>(
      'select id from tenancy.marketplace_oauth_codes where business_id = $1',
      [business.id],
    );
    await ownerQuery(
      `insert into tenancy.marketplace_oauth_tokens (business_id, agency_id, install_id, code_id,
         access_hash, access_expires_at, refresh_hash, refresh_expires_at)
       values ($1, $2, $3, $4, sha256(gen_random_uuid()::text::bytea), now() + interval '1 day',
               sha256(gen_random_uuid()::text::bytea), now() + interval '365 days')`,
      [business.id, install?.agency_id, install?.id, code?.id],
    );
    await call('uninstallMarketplaceApp', installer, {
      params: { installId: toPublicId('marketplace_install', install?.id ?? '') },
    });
    const [key] = await ownerQuery<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from tenancy.api_keys where marketplace_install_id = $1',
      [install?.id],
    );
    expect(key?.revoked).toBe(true);
    const tokens = await ownerQuery<{ revoked_reason: string | null }>(
      'select revoked_reason from tenancy.marketplace_oauth_tokens where install_id = $1',
      [install?.id],
    );
    expect(tokens).toEqual([{ revoked_reason: 'uninstalled' }]);
  });
});

describe('without a public address', () => {
  it('offers no consent routes, since no app could be sent back', () => {
    const offered = marketplaceRoutes({ people: () => Promise.resolve(new Map()) }).map(
      (each) => each.endpoint.operationId,
    );
    expect(offered).toContain('generateMarketplaceClientSecret');
    expect(offered).not.toContain('readOAuthAuthorization');
    expect(offered).not.toContain('grantOAuthAuthorization');
  });
});
