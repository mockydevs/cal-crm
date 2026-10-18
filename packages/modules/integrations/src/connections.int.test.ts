// Settings → Integrations against real Postgres and the local stand-in provider
// (test/fake-provider.ts): the list, connecting with the provider's sign-in and its callback,
// a pasted key, options, a check, disconnecting, the activity, and that no business sees or
// changes another's connection. Nothing here reaches a real provider.
import { randomUUID } from 'node:crypto';

import { runCommand, type Invocation } from '@repo/commands';
import type {
  IntegrationActivity,
  IntegrationConnection,
  IntegrationConnectStarted,
  IntegrationDetail,
  IntegrationList,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { createSealingVault, newSecretsKey, parseSecretsPublicKey } from '@repo/module-vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, REDIRECT, route, start } from '../test/connect.js';
import {
  standInKey,
  standInKeyProvider,
  standInProvider,
  startFakeProvider,
  STANDIN_CLIENT,
  type FakeProvider,
} from '../test/fake-provider.js';
import { people, place, suite, work, type Place } from '../test/fixtures.js';
import {
  completeIntegrationConnect,
  createIntegrationWorker,
  type IntegrationOptions,
  type IntegrationProvider,
} from './index.js';
import {
  completeIntegrationConnectCommand,
  updateIntegrationConnectionCommand,
} from './connections.js';
import { codeChallengeOf, codeVerifierOf, sha256 } from './rules.js';

const db = suite();
let fake: FakeProvider;
let options: IntegrationOptions;
let at: Place;
const notices: { connectionId: string; connectedBy: string | null; provider: string }[] = [];

const elsewhere = [
  {
    key: 'google_calendar',
    available: true,
    read: () => Promise.resolve({ connected: 2, attention: 1, label: null }),
  },
  {
    key: 'twilio',
    available: false,
    read: () => Promise.reject(new Error('An install without the vault reads nothing.')),
  },
  {
    key: 'apps_and_api_keys',
    available: true,
    read: () => Promise.resolve({ connected: 0, attention: 0, label: null }),
  },
];

function optionsWith(providers: readonly IntegrationProvider[]): IntegrationOptions {
  return { ...options, providers };
}

const worker = () =>
  createIntegrationWorker({
    providers: options.providers,
    vault: db.vault,
    fetch,
    redirectUri: REDIRECT,
    notifyAttention: (_trx, _context, notice) => {
      notices.push(notice);
      return Promise.resolve();
    },
    random: () => 0.5,
  });

beforeAll(async () => {
  fake = await startFakeProvider();
  options = {
    providers: [standInProvider(fake.origin), standInKeyProvider(fake.origin)],
    vault: db.vault,
    redirectUri: REDIRECT,
    elsewhere,
    webhooks: {
      publicUrl: 'https://crm.example.test',
      secret: 'a-public-intake-secret-of-32-characters-or-more',
    },
    people,
  };
  at = await place(db);
});
afterAll(async () => {
  await fake.close();
});

const list = (invocation: Invocation, using = options) =>
  route(using, db.services, 'listIntegrations', invocation) as Promise<IntegrationList>;

const entryOf = async (invocation: Invocation, key: string) =>
  (await list(invocation)).entries.find((each) => each.key === key);

/** The connection the person just connected, as the list shows it. */
async function connectionOf(
  invocation: Invocation,
  account: string,
): Promise<IntegrationConnection> {
  const entry = await entryOf(invocation, 'standin');
  const found = entry?.connections.find((each) => each.accountLabel === account);
  if (found === undefined) throw new Error(`No connection for ${account}.`);
  return found;
}

describe('the list', () => {
  it('draws the connections that live elsewhere with their readings, and the providers here', async () => {
    const manager = await at.person();
    const answer = await list(manager.invocation);
    expect(answer.canManage).toBe(true);
    expect(answer.entries.map((each) => each.key)).toEqual([
      'google_calendar',
      'twilio',
      'apps_and_api_keys',
      'standin',
      'standin_key',
    ]);
    expect(answer.entries[0]).toMatchObject({
      auth: 'elsewhere',
      page: 'calendar_connections',
      available: true,
      state: 'needs_attention',
      connected: 2,
      attention: 1,
      // A Google Calendar manager needs appointments.manage, which this person lacks.
      mayManage: false,
      connections: [],
    });
    // Not set up on this install: grey, nothing read, nothing to manage.
    expect(answer.entries[1]).toMatchObject({
      available: false,
      state: 'not_connected',
      mayManage: false,
    });
    expect(answer.entries[3]).toMatchObject({
      auth: 'oauth2',
      available: true,
      mayManage: true,
      state: 'not_connected',
      page: null,
      operatorGuide: null,
    });
  });

  it('leaves out a connection that lives elsewhere when nothing reads it', async () => {
    const manager = await at.person();
    const answer = await list(manager.invocation, { ...options, elsewhere: [] });
    expect(answer.entries.map((each) => each.key)).toEqual(['standin', 'standin_key']);
  });

  it('greys a provider whose operator app is not set, and every provider without a vault', async () => {
    const manager = await at.person();
    const unset = await list(
      manager.invocation,
      optionsWith([
        standInProvider(fake.origin, { client: undefined }),
        standInKeyProvider(fake.origin),
      ]),
    );
    expect(unset.entries.find((each) => each.key === 'standin')).toMatchObject({
      available: false,
      mayManage: false,
    });
    expect(unset.entries.find((each) => each.key === 'standin_key')?.available).toBe(true);
    const sealed = await list(manager.invocation, { ...options, vault: undefined });
    expect(
      sealed.entries.filter((each) => each.auth !== 'elsewhere').map((each) => each.available),
    ).toEqual([false, false]);
  });

  it('is read-only for a member who may not manage integrations, and open to every member', async () => {
    const member = await at.person(new Set(['contacts.manage', 'appointments.manage']));
    const answer = await list(member.invocation);
    expect(answer.canManage).toBe(false);
    expect(answer.entries.find((each) => each.key === 'standin')?.mayManage).toBe(false);
    expect(answer.entries.find((each) => each.key === 'google_calendar')?.mayManage).toBe(true);
  });

  it('reads one integration, and refuses one this install does not have', async () => {
    const manager = await at.person();
    const detail = (await route(options, db.services, 'getIntegration', manager.invocation, {
      params: { provider: 'google_calendar' },
    })) as IntegrationDetail;
    expect(detail.entry.key).toBe('google_calendar');
    expect(detail.activity).toEqual([]);
    await expect(
      route(options, db.services, 'getIntegration', manager.invocation, {
        params: { provider: 'slack' },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      route(options, db.services, 'getIntegration', manager.invocation, {
        params: { provider: 'google' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('connecting with the provider’s sign-in', () => {
  it('gives the consent address with a single-use state and its S256 challenge', async () => {
    const manager = await at.person();
    const started = await start(options, db.services, manager.invocation);
    expect(started.url.origin).toBe(fake.origin);
    expect(started.url.searchParams.get('client_id')).toBe(STANDIN_CLIENT.clientId);
    expect(started.url.searchParams.get('redirect_uri')).toBe(REDIRECT('standin'));
    expect(started.url.searchParams.get('scope')).toBe('account:read messages:write');
    expect(started.challenge).toBe(
      codeChallengeOf(codeVerifierOf(STANDIN_CLIENT.clientSecret, started.state)),
    );
    const attempts = await db.database.as('crm_owner', (sql) =>
      sql.query<{ provider: string; user_id: string }>(
        'select provider, user_id from integrations.connect_attempts where state_digest = $1',
        [sha256(started.state)],
      ),
    );
    expect(attempts).toEqual([{ provider: 'standin', user_id: manager.id }]);
  });

  it('sends no challenge to a provider that takes no PKCE', async () => {
    const manager = await at.person();
    const started = await start(
      optionsWith([standInProvider(fake.origin, { pkce: false })]),
      db.services,
      manager.invocation,
    );
    expect(started.challenge).toBeUndefined();
  });

  it('is refused to a member without the permission, to a program, and where it cannot be connected', async () => {
    const member = await at.person(new Set(['contacts.manage']));
    await expect(start(options, db.services, member.invocation)).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    const manager = await at.person();
    const { userId: _person, ...keyContext } = manager.invocation.context;
    const program: Invocation = {
      ...manager.invocation,
      context: { ...keyContext, actorKind: 'api_key' },
    };
    await expect(start(options, db.services, program)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      start(
        optionsWith([standInProvider(fake.origin, { client: undefined })]),
        db.services,
        manager.invocation,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(start(options, db.services, manager.invocation, 'slack')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      route(options, db.services, 'connectIntegration', manager.invocation, {
        params: { provider: 'standin' },
        body: { apiKey: 'sk_live' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('keeps the tokens sealed where the app cannot read them, and the worker confirms the account', async () => {
    fake.addAccount({ id: 'T-ACME', name: 'Acme Workspace' });
    const manager = await at.person();
    const result = await connect(options, db.services, fake, manager.invocation, 'T-ACME');
    expect(result).toEqual({ outcome: 'connected', path: `/b/${at.slug}/settings/integrations` });
    const before = await entryOf(manager.invocation, 'standin');
    expect(before?.state).toBe('connecting');
    const [connecting] = before?.connections ?? [];
    expect(connecting).toMatchObject({ status: 'connecting', accountLabel: null, primary: true });
    // What the vault holds is ciphertext: no token or refresh token in it.
    const sealed = await db.database.as('crm_owner', (sql) =>
      sql.one<{ purpose: string; ciphertext: Buffer }>(
        `select s.purpose, s.ciphertext from vault.secrets s
         join integrations.connections c on c.secret_id = s.id and c.business_id = s.business_id
         where c.id = $1`,
        [parsePublicId('integration_connection', connecting?.id ?? '')],
      ),
    );
    expect(sealed.purpose).toBe('integrations.standin.credentials');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('accessToken');
    // The app's vault seals and has no way to open.
    const appVault = await createSealingVault(
      parseSecretsPublicKey((await newSecretsKey(1)).publicKey),
    );
    expect('read' in appVault).toBe(false);

    expect(await work(db, worker().tasks)).toEqual(['integrations.check']);
    const after = await connectionOf(manager.invocation, 'Acme Workspace');
    expect(after).toMatchObject({ status: 'connected', primary: true, connectedBy: 'Dana Brooks' });
    // The stand-in sends updates: the account has an address of its own for them.
    expect(after.webhookUrl).toMatch(
      /^https:\/\/crm\.example\.test\/webhooks\/integrations\/standin\/[A-Za-z0-9_-]{43}$/,
    );
    const withoutPublic = await list(manager.invocation, { ...options, webhooks: undefined });
    expect(
      withoutPublic.entries.find((each) => each.key === 'standin')?.connections[0]?.webhookUrl,
    ).toBeNull();
    expect((await entryOf(manager.invocation, 'standin'))?.state).toBe('connected');
    const detail = (await route(options, db.services, 'getIntegration', manager.invocation, {
      params: { provider: 'standin' },
    })) as IntegrationDetail;
    expect(detail.activity.map((each) => each.kind)).toEqual(['confirmed', 'connected']);
  });

  it('keeps one row for an account signed into again, with the new credentials', async () => {
    const manager = await at.person();
    const before = await connectionOf(manager.invocation, 'Acme Workspace');
    const oldSecret = await db.database.as('crm_owner', (sql) =>
      sql.one<{ secret_id: string }>(
        'select secret_id from integrations.connections where id = $1',
        [parsePublicId('integration_connection', before.id)],
      ),
    );
    await connect(options, db.services, fake, manager.invocation, 'T-ACME');
    await work(db, worker().tasks);
    const entry = await entryOf(manager.invocation, 'standin');
    expect(entry?.connections.map((each) => [each.id, each.accountLabel])).toEqual([
      [before.id, 'Acme Workspace'],
    ]);
    const gone = await db.database.as('crm_owner', (sql) =>
      sql.query('select 1 from vault.secrets where id = $1', [oldSecret.secret_id]),
    );
    expect(gone).toEqual([]);
  });

  it('refuses a forged state, a spent one, one past its time, and one for another provider', async () => {
    const manager = await at.person();
    const person = {
      userId: manager.id,
      grantsIn: () => Promise.resolve(manager.invocation.permissions),
    };
    const finish = (state: string | undefined, key = 'standin', code = 'any') =>
      completeIntegrationConnect(
        options,
        db.services,
        fetch,
        key,
        { state, code, error: undefined },
        person,
        randomUUID(),
      );
    expect(await finish('forged')).toEqual({ outcome: 'expired', path: undefined });
    expect(await finish(undefined)).toEqual({ outcome: 'expired', path: undefined });
    expect(await finish('x'.repeat(201))).toEqual({ outcome: 'expired', path: undefined });

    const spent = await start(options, db.services, manager.invocation);
    const code = fake.consent({
      account: 'T-ACME',
      codeChallenge: spent.challenge,
      redirectUri: REDIRECT('standin'),
    });
    expect((await finish(spent.state, 'standin', code)).outcome).toBe('connected');
    expect((await finish(spent.state, 'standin', code)).outcome).toBe('expired');

    const late = await start(options, db.services, manager.invocation);
    await db.database.as('crm_owner', (sql) =>
      sql.query(
        "update integrations.connect_attempts set expires_at = now() - interval '1 second' where state_digest = $1",
        [sha256(late.state)],
      ),
    );
    expect((await finish(late.state)).outcome).toBe('expired');

    const other = await start(options, db.services, manager.invocation);
    expect(
      await completeIntegrationConnect(
        optionsWith([...options.providers, standInProvider(fake.origin, { key: 'standin_two' })]),
        db.services,
        fetch,
        'standin_two',
        { state: other.state, code: 'any', error: undefined },
        person,
        randomUUID(),
      ),
    ).toEqual({ outcome: 'failed', path: undefined });
    expect((await finish(other.state, 'standin_key')).outcome).toBe('failed');
    expect((await finish(other.state, 'nothing')).outcome).toBe('failed');
    expect(
      (
        await completeIntegrationConnect(
          { ...options, vault: undefined },
          db.services,
          fetch,
          'standin',
          { state: other.state, code: 'c', error: undefined },
          person,
          randomUUID(),
        )
      ).outcome,
    ).toBe('failed');
    await work(db, worker().tasks);
  });

  it('refuses a callback for another person without spending their attempt', async () => {
    const manager = await at.person();
    const someone = await at.person();
    const started = await start(options, db.services, manager.invocation);
    const code = fake.consent({
      account: 'T-ACME',
      codeChallenge: started.challenge,
      redirectUri: REDIRECT('standin'),
    });
    const result = await completeIntegrationConnect(
      options,
      db.services,
      fetch,
      'standin',
      { state: started.state, code, error: undefined },
      { userId: someone.id, grantsIn: () => Promise.resolve(someone.invocation.permissions) },
      randomUUID(),
    );
    expect(result).toEqual({ outcome: 'failed', path: undefined });
    const left = await db.database.as('crm_owner', (sql) =>
      sql.query('select 1 from integrations.connect_attempts where state_digest = $1', [
        sha256(started.state),
      ]),
    );
    expect(left).toHaveLength(1);
  });

  it('refuses a person who left the business or lost the permission since starting', async () => {
    const manager = await at.person();
    const finishAs = async (grants: Invocation['permissions'] | undefined) => {
      const started = await start(options, db.services, manager.invocation);
      return completeIntegrationConnect(
        options,
        db.services,
        fetch,
        'standin',
        { state: started.state, code: 'c', error: undefined },
        { userId: manager.id, grantsIn: () => Promise.resolve(grants) },
        randomUUID(),
      );
    };
    expect(await finishAs(undefined)).toEqual({ outcome: 'failed', path: undefined });
    expect(await finishAs(new Set(['contacts.manage']))).toEqual({
      outcome: 'failed',
      path: undefined,
    });
  });

  it('says denied when the person cancels, and failed when the code is refused', async () => {
    const manager = await at.person();
    const person = {
      userId: manager.id,
      grantsIn: () => Promise.resolve(manager.invocation.permissions),
    };
    const denied = await start(options, db.services, manager.invocation);
    expect(
      await completeIntegrationConnect(
        options,
        db.services,
        fetch,
        'standin',
        { state: denied.state, code: undefined, error: 'access_denied' },
        person,
        randomUUID(),
      ),
    ).toEqual({ outcome: 'denied', path: `/b/${at.slug}/settings/integrations` });
    const refused = await start(options, db.services, manager.invocation);
    expect(
      (
        await completeIntegrationConnect(
          options,
          db.services,
          fetch,
          'standin',
          { state: refused.state, code: 'not-a-code', error: undefined },
          person,
          randomUUID(),
        )
      ).outcome,
    ).toBe('failed');
  });

  it('keeps no partial consent: the token is revoked at the provider at once', async () => {
    const manager = await at.person();
    const revokedBefore = fake.revoked.refresh;
    const result = await connect(options, db.services, fake, manager.invocation, 'T-ACME', [
      'account:read',
    ]);
    expect(result.outcome).toBe('scopes_missing');
    expect(fake.revoked.refresh).toBe(revokedBefore + 1);
  });

  it('takes the scopes asked for when the provider names none granted', async () => {
    const manager = await at.person();
    const result = await connect(options, db.services, fake, manager.invocation, 'T-ACME', []);
    expect(result.outcome).toBe('connected');
    await work(db, worker().tasks);
  });
});

describe('connecting with a key', () => {
  it('seals the key, checks it, and replaces the account before it for a one-account provider', async () => {
    fake.addAccount({ id: 'K-1', name: 'Forms One' });
    fake.addAccount({ id: 'K-2', name: 'Forms Two' });
    const manager = await at.person();
    const connectKey = async (account: string) =>
      (await route(options, db.services, 'connectIntegration', manager.invocation, {
        params: { provider: 'standin_key' },
        body: { apiKey: await standInKey(fake, account) },
      })) as IntegrationConnectStarted;
    const first = await connectKey('K-1');
    expect(first.authorizeUrl).toBeNull();
    expect(first.connection).toMatchObject({ status: 'connecting', primary: true });
    await work(db, worker().tasks);
    await connectKey('K-2');
    await work(db, worker().tasks);
    const entry = await entryOf(manager.invocation, 'standin_key');
    expect(
      entry?.connections.map((each) => [each.accountLabel, each.status, each.primary]),
    ).toEqual([['Forms Two', 'connected', true]]);
    const audit = await db.database.as('crm_owner', (sql) =>
      sql.query<{ input: unknown }>(
        "select input from audit.commands where command = 'integration.connect' order by recorded_at desc limit 1",
      ),
    );
    expect(JSON.stringify(audit)).not.toContain('apiKey');
    await expect(
      route(options, db.services, 'connectIntegration', manager.invocation, {
        params: { provider: 'standin_key' },
        body: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('a connection’s options, check and disconnection', () => {
  it('makes another account primary at the revision read, and refuses a stale one or options', async () => {
    fake.addAccount({ id: 'T-BETA', name: 'Beta Workspace' });
    const manager = await at.person();
    await connect(options, db.services, fake, manager.invocation, 'T-BETA');
    await work(db, worker().tasks);
    const beta = await connectionOf(manager.invocation, 'Beta Workspace');
    expect(beta.primary).toBe(false);
    const update = (body: unknown) =>
      route(options, db.services, 'updateIntegrationConnection', manager.invocation, {
        params: { provider: 'standin', id: beta.id },
        body,
      }) as Promise<IntegrationConnection>;
    const made = await update({ primary: true, revision: beta.revision });
    expect(made).toMatchObject({ primary: true, revision: beta.revision + 1 });
    expect((await connectionOf(manager.invocation, 'Acme Workspace')).primary).toBe(false);
    await expect(update({ primary: true, revision: beta.revision })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(
      update({ settings: { colour: 'blue' }, revision: made.revision }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await update({ settings: {}, revision: made.revision })).revision).toBe(
      made.revision + 1,
    );
  });

  it('queues a check now, and refuses a connection that is not there', async () => {
    const manager = await at.person();
    const acme = await connectionOf(manager.invocation, 'Acme Workspace');
    const tested = (await route(
      options,
      db.services,
      'testIntegrationConnection',
      manager.invocation,
      {
        params: { provider: 'standin', id: acme.id },
      },
    )) as IntegrationConnection;
    expect(tested.id).toBe(acme.id);
    expect(await work(db, worker().tasks)).toEqual(['integrations.check']);
    await expect(
      route(options, db.services, 'testIntegrationConnection', manager.invocation, {
        params: {
          provider: 'standin',
          id: toPublicId('integration_connection', '01890a5d-ac96-774b-bcce-b302099a8057'),
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      route(options, db.services, 'testIntegrationConnection', manager.invocation, {
        params: { provider: 'standin_key', id: acme.id },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('pages the activity, newest first', async () => {
    const manager = await at.person();
    const acme = await connectionOf(manager.invocation, 'Acme Workspace');
    const id = parsePublicId('integration_connection', acme.id);
    await withTenant(db.db, at.system, (trx) =>
      trx
        .insertInto('integrations.activity')
        .values(
          Array.from({ length: 55 }, (_, index) => ({
            business_id: at.businessId,
            connection_id: id ?? '',
            kind: 'check_ok' as const,
            at: new Date(Date.UTC(2026, 0, 1, 0, index)),
          })),
        )
        .execute(),
    );
    const page = (before?: string) =>
      route(options, db.services, 'listIntegrationActivity', manager.invocation, {
        params: { provider: 'standin', id: acme.id },
        query: before === undefined ? {} : { before },
      }) as Promise<{ items: IntegrationActivity[]; next: string | null }>;
    const first = await page();
    expect(first.items).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const second = await page(first.next ?? undefined);
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.next).toBeNull();
    await expect(
      route(options, db.services, 'listIntegrationActivity', manager.invocation, {
        params: {
          provider: 'standin',
          id: toPublicId('integration_connection', '01890a5d-ac96-774b-bcce-b302099a8057'),
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('disconnects: the primary passes on, the token is revoked and the credentials removed', async () => {
    const manager = await at.person();
    const beta = await connectionOf(manager.invocation, 'Beta Workspace');
    expect(beta.primary).toBe(true);
    const revokedBefore = fake.revoked.refresh;
    await route(options, db.services, 'disconnectIntegration', manager.invocation, {
      params: { provider: 'standin', id: beta.id },
    });
    const entry = await entryOf(manager.invocation, 'standin');
    expect(entry?.connections.some((each) => each.id === beta.id)).toBe(false);
    expect(entry?.connections.find((each) => each.accountLabel === 'Acme Workspace')?.primary).toBe(
      true,
    );
    expect(await work(db, worker().tasks)).toEqual(['integrations.revoke']);
    expect(fake.revoked.refresh).toBe(revokedBefore + 1);
    const row = await db.database.as('crm_owner', (sql) =>
      sql.one<{ status: string; secret_id: string | null; disconnected_reason: string }>(
        'select status, secret_id, disconnected_reason from integrations.connections where id = $1',
        [parsePublicId('integration_connection', beta.id)],
      ),
    );
    expect(row).toEqual({ status: 'disconnected', secret_id: null, disconnected_reason: 'user' });
    await expect(
      route(options, db.services, 'disconnectIntegration', manager.invocation, {
        params: { provider: 'standin', id: beta.id },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('tenancy', () => {
  it('never shows, checks, changes or disconnects another business’s connection', async () => {
    const manager = await at.person();
    const acme = await connectionOf(manager.invocation, 'Acme Workspace');
    const elsewhereBusiness = await place(db);
    const stranger = await elsewhereBusiness.person();
    const theirs = await list(stranger.invocation);
    expect(theirs.entries.find((each) => each.key === 'standin')?.connections).toEqual([]);
    for (const operationId of [
      'testIntegrationConnection',
      'disconnectIntegration',
      'listIntegrationActivity',
    ])
      await expect(
        route(options, db.services, operationId, stranger.invocation, {
          params: { provider: 'standin', id: acme.id },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      route(options, db.services, 'updateIntegrationConnection', stranger.invocation, {
        params: { provider: 'standin', id: acme.id },
        body: { primary: true, revision: acme.revision },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await connectionOf(manager.invocation, 'Acme Workspace')).status).toBe('connected');
  });
});

describe('edges', () => {
  it('shows no name for a connector who is gone', async () => {
    fake.addAccount({ id: 'T-GONE', name: 'Gone Workspace' });
    const leaver = await at.person(undefined, 'Lee Gone');
    await connect(options, db.services, fake, leaver.invocation, 'T-GONE');
    await work(db, worker().tasks);
    await db.database.as('crm_owner', (sql) =>
      sql.query('update integrations.connections set connected_by = null where connected_by = $1', [
        leaver.id,
      ]),
    );
    const manager = await at.person();
    expect((await connectionOf(manager.invocation, 'Gone Workspace')).connectedBy).toBeNull();
  });

  it('starts with no body at all, and finishes without PKCE for a provider that takes none', async () => {
    const manager = await at.person();
    const started = (await route(options, db.services, 'connectIntegration', manager.invocation, {
      params: { provider: 'standin' },
    })) as IntegrationConnectStarted;
    expect(started.authorizeUrl).not.toBeNull();
    const plain = optionsWith([standInProvider(fake.origin, { pkce: false })]);
    const begun = await start(plain, db.services, manager.invocation);
    const code = fake.consent({ account: 'T-ACME', redirectUri: REDIRECT('standin') });
    const finished = await completeIntegrationConnect(
      plain,
      db.services,
      fetch,
      'standin',
      { state: begun.state, code, error: undefined },
      { userId: manager.id, grantsIn: () => Promise.resolve(manager.invocation.permissions) },
      randomUUID(),
    );
    expect(finished.outcome).toBe('connected');
    await work(db, worker().tasks);
  });

  it('refuses a connection id that is not one, and keeping tokens without a vault', async () => {
    const manager = await at.person();
    await expect(
      runCommand(
        db.services,
        updateIntegrationConnectionCommand(options),
        { key: 'standin', id: 'not-an-id', primary: true, revision: 1 },
        manager.invocation,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      runCommand(
        db.services,
        completeIntegrationConnectCommand({ ...options, vault: undefined }),
        {
          key: 'standin',
          attemptId: randomUUID(),
          accessToken: 'a',
          refreshToken: null,
          expiresAt: null,
          scopes: [],
        },
        manager.invocation,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
