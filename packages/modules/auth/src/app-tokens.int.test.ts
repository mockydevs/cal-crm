// OAuth tokens for installed apps, as crm_auth: the token endpoint's work, the
// revocation endpoint's, and an access token's lookup. Rows are written as the tenancy
// commands write them; the commands themselves are tested in the tenancy module.
import { createHash, randomBytes } from 'node:crypto';

import { toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createAuthentication, type Authentication, type OAuthTokenOutcome } from './index.js';

let database: TestDatabase;
let auth: Authentication;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  auth = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-of-at-least-32-characters',
    publicUrl: 'https://crm.example.test',
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });
});

afterAll(async () => {
  await auth.close();
  await database.close();
});

const sha = (value: string) => createHash('sha256').update(value).digest();
const hex = () => randomBytes(32).toString('hex');
const REDIRECT = 'https://sync.example/cb';

const owner = <Row extends object = Record<string, unknown>>(text: string, values: unknown[]) =>
  database.as('crm_owner', (sql) => sql.query<Row>(text, values));

/**
 * An app with a client secret, installed in a new business with its app key, and a code
 * issued for it, all as the tenancy commands write them.
 */
async function installed() {
  const agency = await database.fixtures.agency();
  const slug = `oauth-${randomBytes(6).toString('hex')}`;
  const business = await database.fixtures.business(agency.id, { slug });
  const secret = `crm_cs_${hex()}`;
  const [app] = await owner<{ id: string }>(
    `insert into tenancy.marketplace_apps (agency_id, name, developer, scopes, read_groups, status,
       created_by, redirect_uris, client_secret_hash, client_secret_prefix, client_secret_set_at)
     values ($1, 'Harbor Sync', 'Harbor', '{tags.manage,not.a.permission}', '{Tags,Nonsense}',
             'listed', uuidv7(), array[$2], $3, $4, now())
     returning id`,
    [agency.id, REDIRECT, sha(secret), secret.slice(0, 15)],
  );
  const appId = app?.id ?? '';
  const [install] = await owner<{ id: string }>(
    `insert into tenancy.marketplace_installs (business_id, agency_id, app_id, granted_scopes,
       granted_read_groups, installed_by)
     values ($1, $2, $3, '{tags.manage,not.a.permission}', '{Tags,Nonsense}', uuidv7()) returning id`,
    [business.id, agency.id, appId],
  );
  const installId = install?.id ?? '';
  const [key] = await owner<{ id: string }>(
    `insert into tenancy.api_keys (agency_id, business_id, name, scopes, read_groups, marketplace_install_id)
     values ($1, $2, 'Harbor Sync', '{tags.manage,not.a.permission}', '{Tags,Nonsense}', $3)
     returning id`,
    [agency.id, business.id, installId],
  );
  const client = { clientId: toPublicId('marketplace_app', appId), clientSecret: secret };
  return { agency, business, slug, appId, installId, keyId: key?.id ?? '', client };
}

type Install = Awaited<ReturnType<typeof installed>>;

/** A code for the install, with a PKCE pair. */
async function codeFor(install: Install, values: { expired?: boolean } = {}) {
  const code = `crm_ac_${hex()}`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await owner(
    `insert into tenancy.marketplace_oauth_codes (business_id, agency_id, install_id, code_hash,
       redirect_uri, code_challenge, issued_by, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, uuidv7(), $7, $8)`,
    [
      install.business.id,
      install.agency.id,
      install.installId,
      sha(code),
      REDIRECT,
      challenge,
      values.expired === true ? new Date(Date.now() - 20 * 60_000) : new Date(),
      new Date(Date.now() + (values.expired === true ? -10 : 10) * 60_000),
    ],
  );
  return { code, verifier };
}

function issued(outcome: OAuthTokenOutcome) {
  if (outcome.outcome !== 'issued') throw new Error(`refused: ${outcome.description}`);
  return outcome.tokens;
}

async function trade(install: Install) {
  const { code, verifier } = await codeFor(install);
  return issued(
    await auth.oauthToken({
      grantType: 'authorization_code',
      code,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      ...install.client,
    }),
  );
}

describe('the token endpoint', () => {
  it('trades a code for a pair, naming only the scopes a key may hold', async () => {
    const install = await installed();
    const tokens = await trade(install);
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 86_400,
      scope: 'tags.manage',
    });
    expect(tokens.access_token).toMatch(/^crm_at_[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toMatch(/^crm_rt_[0-9a-f]{64}$/);
    const [row] = await owner<{ access: number; refresh: number }>(
      `select extract(epoch from access_expires_at - created_at)::int as access,
              extract(epoch from refresh_expires_at - created_at)::int as refresh
         from tenancy.marketplace_oauth_tokens where access_hash = $1`,
      [sha(tokens.access_token)],
    );
    expect(row).toEqual({ access: 86_400, refresh: 31_536_000 });
  });

  it('asks for what is missing, and refuses other grants and wrong clients', async () => {
    const install = await installed();
    const { code, verifier } = await codeFor(install);
    expect(await auth.oauthToken({ ...install.client })).toMatchObject({
      error: 'invalid_request',
    });
    expect(
      await auth.oauthToken({ grantType: 'client_credentials', ...install.client }),
    ).toMatchObject({
      error: 'unsupported_grant_type',
    });
    for (const client of [
      {},
      { clientId: install.client.clientId },
      { clientId: 'not-an-app', clientSecret: install.client.clientSecret },
      { clientId: install.client.clientId, clientSecret: `crm_cs_${hex()}` },
      {
        clientId: toPublicId('marketplace_app', '01890000-0000-7000-8000-000000000000'),
        clientSecret: 'x',
      },
    ]) {
      expect(
        await auth.oauthToken({
          grantType: 'authorization_code',
          code,
          redirectUri: REDIRECT,
          codeVerifier: verifier,
          ...client,
        }),
      ).toMatchObject({ outcome: 'refused', status: 401, error: 'invalid_client' });
    }
    expect(
      await auth.oauthToken({ grantType: 'authorization_code', code, ...install.client }),
    ).toMatchObject({ status: 400, error: 'invalid_request' });
    expect(await auth.oauthToken({ grantType: 'refresh_token', ...install.client })).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('refuses a code that is malformed, expired, for another address or verifier, or used', async () => {
    const install = await installed();
    const grant = (values: Record<string, string>) =>
      auth.oauthToken({
        grantType: 'authorization_code',
        redirectUri: REDIRECT,
        ...install.client,
        ...values,
      });
    const fresh = await codeFor(install);
    expect(await grant({ code: 'nope', codeVerifier: fresh.verifier })).toMatchObject({
      error: 'invalid_grant',
    });
    expect(await grant({ code: `crm_ac_${hex()}`, codeVerifier: fresh.verifier })).toMatchObject({
      error: 'invalid_grant',
    });
    const old = await codeFor(install, { expired: true });
    expect(await grant({ code: old.code, codeVerifier: old.verifier })).toMatchObject({
      description: 'The code has expired.',
    });
    expect(
      await grant({ code: fresh.code, codeVerifier: fresh.verifier, redirectUri: `${REDIRECT}/x` }),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(await grant({ code: fresh.code, codeVerifier: 'short' })).toMatchObject({
      error: 'invalid_grant',
    });
    expect(
      await grant({ code: fresh.code, codeVerifier: randomBytes(32).toString('base64url') }),
    ).toMatchObject({ error: 'invalid_grant' });
    issued(await grant({ code: fresh.code, codeVerifier: fresh.verifier }));
    expect(await grant({ code: fresh.code, codeVerifier: fresh.verifier })).toMatchObject({
      description: 'The code was used already.',
    });
    const [family] = await owner<{ revoked_reason: string }>(
      `select revoked_reason from tenancy.marketplace_oauth_tokens t
         join tenancy.marketplace_oauth_codes c on c.business_id = t.business_id and c.id = t.code_id
        where c.code_hash = $1`,
      [sha(fresh.code)],
    );
    expect(family?.revoked_reason).toBe('code_reused');
  });

  it('refuses a code or a refresh token once the app is uninstalled', async () => {
    const install = await installed();
    const tokens = await trade(install);
    const { code, verifier } = await codeFor(install);
    await owner(
      `update tenancy.marketplace_installs set uninstalled_at = now(), uninstalled_by = uuidv7() where id = $1`,
      [install.installId],
    );
    expect(
      await auth.oauthToken({
        grantType: 'authorization_code',
        code,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        ...install.client,
      }),
    ).toMatchObject({ description: 'The app is no longer installed there.' });
    expect(
      await auth.oauthToken({
        grantType: 'refresh_token',
        refreshToken: tokens.refresh_token,
        ...install.client,
      }),
    ).toMatchObject({ description: 'The app is no longer installed there.' });
  });

  it('rotates a refresh token, and a replay stops the family', async () => {
    const install = await installed();
    const first = await trade(install);
    const refresh = (refreshToken: string) =>
      auth.oauthToken({ grantType: 'refresh_token', refreshToken, ...install.client });
    expect(await refresh('crm_rt_bad')).toMatchObject({ error: 'invalid_grant' });
    const second = issued(await refresh(first.refresh_token));
    expect(await refresh(first.refresh_token)).toMatchObject({
      description: 'The refresh token was used already.',
    });
    expect(await refresh(second.refresh_token)).toMatchObject({
      description: 'The refresh token is not valid.',
    });
    expect(await auth.appToken(second.access_token)).toBeUndefined();
  });

  it('refuses a refresh token that has expired', async () => {
    const install = await installed();
    const tokens = await trade(install);
    await owner(
      `update tenancy.marketplace_oauth_tokens
          set created_at = now() - interval '400 days', access_expires_at = now() - interval '399 days',
              refresh_expires_at = now() - interval '1 day'
        where refresh_hash = $1`,
      [sha(tokens.refresh_token)],
    );
    expect(
      await auth.oauthToken({
        grantType: 'refresh_token',
        refreshToken: tokens.refresh_token,
        ...install.client,
      }),
    ).toMatchObject({ description: 'The refresh token has expired.' });
  });
});

describe('revoking', () => {
  it('stops the family of either token, and answers the same for anything else', async () => {
    const install = await installed();
    const byAccess = await trade(install);
    expect(await auth.oauthRevoke({ token: byAccess.access_token, ...install.client })).toEqual({
      outcome: 'revoked',
    });
    expect(await auth.appToken(byAccess.access_token)).toBeUndefined();
    const byRefresh = await trade(install);
    await auth.oauthRevoke({ token: byRefresh.refresh_token, ...install.client });
    expect(await auth.appToken(byRefresh.access_token)).toBeUndefined();
    expect(await auth.oauthRevoke({ token: 'anything', ...install.client })).toEqual({
      outcome: 'revoked',
    });
    // Another app's client can't revoke this app's tokens.
    const other = await installed();
    const kept = await trade(install);
    await auth.oauthRevoke({ token: kept.access_token, ...other.client });
    expect(await auth.appToken(kept.access_token)).toBeDefined();
  });

  it('needs a token and the client', async () => {
    const install = await installed();
    expect(await auth.oauthRevoke({ ...install.client })).toEqual({
      outcome: 'refused',
      status: 400,
      error: 'invalid_request',
    });
    expect(await auth.oauthRevoke({ token: 'x' })).toEqual({
      outcome: 'refused',
      status: 401,
      error: 'invalid_client',
    });
  });
});

describe('an access token', () => {
  it('is the install’s app key in its business, reading only its groups', async () => {
    const install = await installed();
    const tokens = await trade(install);
    const access = await auth.appToken(tokens.access_token);
    expect(access).toEqual({
      keyId: install.keyId,
      agencyId: install.agency.id,
      businessId: install.business.id,
      readGroups: ['Tags'],
      permissions: new Set(['tags.manage']),
    });
    const [key] = await owner<{ used: boolean }>(
      'select last_used_at is not null as used from tenancy.api_keys where id = $1',
      [install.keyId],
    );
    expect(key?.used).toBe(true);
  });

  it('works only in its own business, by id or slug', async () => {
    const install = await installed();
    const { access_token: token } = await trade(install);
    expect(await auth.appToken(token, { businessId: install.business.id })).toBeDefined();
    expect(await auth.appToken(token, { businessSlug: install.slug })).toBeDefined();
    expect(await auth.appToken(token, { businessId: crypto.randomUUID() })).toBeUndefined();
    expect(await auth.appToken(token, { businessSlug: 'elsewhere' })).toBeUndefined();
    expect(await auth.appToken(token, { businessSlug: 'Not A Slug' })).toBeUndefined();
    expect(
      await auth.appToken(token, { businessId: install.business.id, businessSlug: install.slug }),
    ).toBeUndefined();
    expect(await auth.appToken(`crm_live_${hex()}`)).toBeUndefined();
  });

  it('stops when its key is revoked or its business suspended', async () => {
    const install = await installed();
    const { access_token: token } = await trade(install);
    await owner(`update tenancy.businesses set status = 'suspended' where id = $1`, [
      install.business.id,
    ]);
    expect(await auth.appToken(token)).toBeUndefined();
    await owner(`update tenancy.businesses set status = 'active' where id = $1`, [
      install.business.id,
    ]);
    expect(await auth.appToken(token)).toBeDefined();
    await owner(`update tenancy.api_keys set revoked_at = now() where id = $1`, [install.keyId]);
    expect(await auth.appToken(token)).toBeUndefined();
  });
});
