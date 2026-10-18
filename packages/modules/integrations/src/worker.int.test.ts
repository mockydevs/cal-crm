// The worker's part, against real Postgres and the stand-in provider: refreshing a token
// that expired (and sealing the rotated one), what each refusal or silence of the provider
// does to a connection and who is told, revoking, verifying what a provider sent, and the
// schedule's sweep and clean-up.
import { createHmac, randomUUID } from 'node:crypto';

import type { IntegrationConnection, IntegrationList } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys } from '@repo/module-vault';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { connect, REDIRECT, route } from '../test/connect.js';
import {
  standInProvider,
  startFakeProvider,
  STANDIN_CLIENT,
  type FakeProvider,
} from '../test/fake-provider.js';
import { people, place, suite, work, type Person, type Place } from '../test/fixtures.js';
import {
  acceptIntegrationWebhook,
  createIntegrationWorker,
  maintainIntegrations,
  scheduleIntegrationChecks,
  type IntegrationOptions,
  type IntegrationProvider,
} from './index.js';

const db = suite();
let fake: FakeProvider;
let options: IntegrationOptions;
let at: Place;
let manager: Person;
const notices: { connectionId: string; connectedBy: string | null; provider: string }[] = [];

const workerFor = (
  providers: readonly IntegrationProvider[] = options.providers,
  fetcher = fetch,
) =>
  createIntegrationWorker({
    providers,
    vault: db.vault,
    fetch: fetcher,
    redirectUri: REDIRECT,
    notifyAttention: (_trx, _context, notice) => {
      notices.push(notice);
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => new Date(),
  });

beforeAll(async () => {
  fake = await startFakeProvider();
  options = {
    providers: [standInProvider(fake.origin)],
    vault: db.vault,
    redirectUri: REDIRECT,
    elsewhere: [],
    webhooks: {
      publicUrl: 'https://crm.example.test',
      secret: 'a-public-intake-secret-of-32-characters-or-more',
    },
    people,
  };
  at = await place(db);
  manager = await at.person();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  notices.length = 0;
});

let accounts = 0;

/** A new account of the stand-in, connected and confirmed; its connection. */
async function connected(): Promise<{
  account: string;
  connection: IntegrationConnection;
  id: string;
}> {
  accounts += 1;
  const account = `W-${String(accounts)}`;
  fake.addAccount({ id: account, name: `Workspace ${String(accounts)}` });
  await connect(options, db.services, fake, manager.invocation, account);
  await work(db, workerFor().tasks);
  const list = (await route(
    options,
    db.services,
    'listIntegrations',
    manager.invocation,
  )) as IntegrationList;
  const connection = list.entries[0]?.connections.find(
    (each) => each.accountLabel === `Workspace ${String(accounts)}`,
  );
  if (connection === undefined) throw new Error('Not connected.');
  return { account, connection, id: parsePublicId('integration_connection', connection.id) ?? '' };
}

const row = (id: string) =>
  db.database.as('crm_owner', (owner) =>
    owner.one<{
      status: string;
      error_code: string | null;
      error_detail: string | null;
      last_error_at: Date | null;
      secret_id: string | null;
      next_check_at: Date;
    }>(
      'select status, error_code, error_detail, last_error_at, secret_id, next_check_at from integrations.connections where id = $1',
      [id],
    ),
  );

const activity = (id: string) =>
  db.database.as('crm_owner', (owner) =>
    owner.query<{ kind: string; error_code: string | null }>(
      'select kind, error_code from integrations.activity where connection_id = $1 order by at desc, id desc',
      [id],
    ),
  );

const sealedOf = (secretId: string) =>
  withTenant(
    db.db,
    at.system,
    async (trx) =>
      JSON.parse(await db.vault.read(trx, secretId, 'integrations.standin.credentials')) as {
        accessToken: string;
        refreshToken: string | null;
        expiresAt: string | null;
      },
  );

async function check(id: string, providers?: readonly IntegrationProvider[], fetcher = fetch) {
  await withTenant(db.db, at.system, (trx) =>
    sql`select private.enqueue_integration_job('integrations.check', ${JSON.stringify({ connectionId: id })}::jsonb, ${`integration-check:${id}`}, null)`.execute(
      trx,
    ),
  );
  return work(db, workerFor(providers, fetcher).tasks);
}

/** Makes the sealed access token expired, as an hour later would. */
async function expire(id: string): Promise<void> {
  const { secret_id } = await row(id);
  const sealed = await sealedOf(secret_id ?? '');
  await withTenant(db.db, at.system, (trx) =>
    db.vault.replace(
      trx,
      secret_id ?? '',
      JSON.stringify({
        kind: 'oauth2',
        ...sealed,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ),
  );
}

describe('refreshing', () => {
  it('trades an expired access token for a new one, sealing the rotated refresh token', async () => {
    const { id } = await connected();
    const { secret_id } = await row(id);
    const before = await sealedOf(secret_id ?? '');
    await expire(id);
    await check(id);
    const after = await sealedOf(secret_id ?? '');
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect((await row(id)).status).toBe('connected');
    // The old refresh token was spent by the rotation; the new one works for the next.
    await expire(id);
    await check(id);
    expect((await row(id)).status).toBe('connected');
    expect((await activity(id)).map((each) => each.kind).slice(0, 2)).toEqual([
      'check_ok',
      'check_ok',
    ]);
  });

  it('asks for a sign-in again when the provider refuses the refresh token, and tells them once', async () => {
    const { account, id } = await connected();
    fake.revokeAccount(account);
    await expire(id);
    await check(id);
    expect(await row(id)).toMatchObject({
      status: 'needs_attention',
      error_code: 'reauthorize',
      error_detail: 'Stand-in stopped accepting this connection. Reconnect to resume.',
    });
    expect(notices).toEqual([{ connectionId: id, connectedBy: manager.id, provider: 'Stand-in' }]);
    const events = await db.database.as('crm_owner', (owner) =>
      owner.query<{ type: string; actor_kind: string }>(
        "select type, actor_kind from events.events where subject_id = $1 and type = 'integration.failed'",
        [id],
      ),
    );
    expect(events).toEqual([{ type: 'integration.failed', actor_kind: 'system' }]);
    // Asked again (a check from the page): still failing, nobody told twice.
    await check(id);
    expect(notices).toHaveLength(1);
    // A sweep leaves it alone until someone signs in again.
    await db.database.as('crm_owner', (owner) =>
      owner.query(
        "update integrations.connections set next_check_at = now() - interval '1 minute' where id = $1",
        [id],
      ),
    );
    const swept = await db.database.as('crm_owner', (owner) =>
      owner.query(
        'select connection_id from private.due_integration_checks(1000) where connection_id = $1',
        [id],
      ),
    );
    expect(swept).toEqual([]);
  });

  it('asks for a sign-in when an expired token has no refresh token to renew it', async () => {
    const { id } = await connected();
    const { secret_id } = await row(id);
    await withTenant(db.db, at.system, (trx) =>
      db.vault.replace(
        trx,
        secret_id ?? '',
        JSON.stringify({
          kind: 'oauth2',
          accessToken: 'x',
          refreshToken: null,
          expiresAt: new Date(0).toISOString(),
        }),
      ),
    );
    await check(id);
    expect((await row(id)).error_code).toBe('reauthorize');
  });

  it('calls the operator’s setup missing when the token endpoint refuses the client', async () => {
    const { id } = await connected();
    await expire(id);
    await check(id, [
      standInProvider(fake.origin, {
        client: { clientId: STANDIN_CLIENT.clientId, clientSecret: 'wrong' },
      }),
    ]);
    expect((await row(id)).error_code).toBe('config_missing');
  });

  it('notes a provider that does not answer a refresh, and tries again within the hour', async () => {
    const { id } = await connected();
    await expire(id);
    await check(id, undefined, () => Promise.reject(new TypeError('fetch failed')));
    const after = await row(id);
    expect(after.status).toBe('connected');
    expect(after.last_error_at).not.toBeNull();
    expect(after.next_check_at.getTime() - Date.now()).toBeLessThan(3_700_000);
    expect((await activity(id))[0]).toEqual({ kind: 'check_failed', error_code: 'provider_error' });
  });
});

describe('what a check reads', () => {
  it('marks a refused permission, comes back working, and notes a rate limit and an outage', async () => {
    const { id } = await connected();
    fake.failNextIdentity(403);
    await check(id);
    expect((await row(id)).error_code).toBe('missing_permission');
    await check(id);
    expect(await row(id)).toMatchObject({ status: 'connected', error_code: null });
    expect((await activity(id))[0]?.kind).toBe('check_ok');
    fake.failNextIdentity(429);
    await check(id);
    expect((await activity(id))[0]).toEqual({ kind: 'check_failed', error_code: 'rate_limited' });
    fake.failNextIdentity(503);
    await check(id);
    expect((await activity(id))[0]).toEqual({ kind: 'check_failed', error_code: 'provider_error' });
    expect((await row(id)).status).toBe('connected');
    fake.failNextIdentity(401);
    await check(id);
    expect((await row(id)).error_code).toBe('reauthorize');
  });

  it('notes an answer that names no account', async () => {
    const { id } = await connected();
    await check(id, [
      standInProvider(fake.origin, {
        identity: { url: `${fake.origin}/me`, id: 'account.missing', label: 'account.name' },
      }),
    ]);
    expect((await activity(id))[0]).toEqual({ kind: 'check_failed', error_code: 'provider_error' });
  });

  it('marks a connection whose provider this install no longer has, or whose secret it cannot read', async () => {
    const gone = await connected();
    await check(gone.id, []);
    expect((await row(gone.id)).error_code).toBe('config_missing');
    const garbled = await connected();
    const { secret_id } = await row(garbled.id);
    await withTenant(db.db, at.system, (trx) => db.vault.replace(trx, secret_id ?? '', 'not json'));
    await check(garbled.id);
    expect((await row(garbled.id)).error_code).toBe('config_missing');
    const wrong = await connected();
    const wrongSecret = (await row(wrong.id)).secret_id ?? '';
    await withTenant(db.db, at.system, (trx) =>
      db.vault.replace(trx, wrongSecret, JSON.stringify({ kind: 'other' })),
    );
    await check(wrong.id);
    expect((await row(wrong.id)).error_code).toBe('config_missing');
  });

  it('does nothing for a connection that is gone', async () => {
    const { id } = await connected();
    await db.database.as('crm_owner', (owner) =>
      owner.query(
        "update integrations.connections set status = 'disconnected', disconnected_reason = 'user', disconnected_at = now(), is_primary = false where id = $1",
        [id],
      ),
    );
    const ran = await check(id);
    expect(ran).toContain('integrations.check');
    expect((await row(id)).status).toBe('disconnected');
  });
});

describe('revoking', () => {
  it('waits for a provider that does not answer, keeping the credentials until it does', async () => {
    const { connection, id } = await connected();
    await route(options, db.services, 'disconnectIntegration', manager.invocation, {
      params: { provider: 'standin', id: connection.id },
    });
    await expect(
      work(db, workerFor(undefined, () => Promise.reject(new TypeError('down'))).tasks),
    ).rejects.toThrow('did not answer the revocation');
    expect((await row(id)).secret_id).not.toBeNull();
  });

  it('removes credentials it cannot read, and those of a provider the install no longer has', async () => {
    const first = await connected();
    const firstSecret = (await row(first.id)).secret_id ?? '';
    await withTenant(db.db, at.system, (trx) => db.vault.replace(trx, firstSecret, 'not json'));
    await route(options, db.services, 'disconnectIntegration', manager.invocation, {
      params: { provider: 'standin', id: first.connection.id },
    });
    await work(db, workerFor().tasks);
    expect((await row(first.id)).secret_id).toBeNull();
    const second = await connected();
    await route(options, db.services, 'disconnectIntegration', manager.invocation, {
      params: { provider: 'standin', id: second.connection.id },
    });
    await work(db, workerFor([]).tasks);
    expect((await row(second.id)).secret_id).toBeNull();
    expect((await activity(second.id))[0]?.kind).toBe('revoked');
  });
});

describe('what a provider sends', () => {
  async function received(webhookUrl: string | null, body: string, signature: string | undefined) {
    const token = webhookUrl?.split('/').at(-1) ?? '';
    const headers = signature === undefined ? {} : { 'x-standin-signature': signature };
    expect(
      await acceptIntegrationWebhook(db.db, options.providers, {
        provider: 'standin',
        token,
        headers: { ...headers, 'content-type': 'application/json', cookie: 'kept-out' },
        body: Buffer.from(body),
      }),
    ).toBe('accepted');
    await work(db, workerFor().tasks);
    return db.database.as('crm_owner', (owner) =>
      owner.one<{ signature_valid: boolean | null; headers: Record<string, string> }>(
        'select signature_valid, headers from intake.webhooks order by received_at desc limit 1',
      ),
    );
  }

  it('acts on a request signed with the operator app’s secret, and on nothing else', async () => {
    const { connection, id } = await connected();
    const body = '{"event":"ping"}';
    const good = `sha256=${createHmac('sha256', STANDIN_CLIENT.clientSecret).update(body).digest('hex')}`;
    const kept = await received(connection.webhookUrl, body, good);
    expect(kept.signature_valid).toBe(true);
    // Only what the check needs is kept of the request's headers.
    expect(Object.keys(kept.headers).sort()).toEqual(['content-type', 'x-standin-signature']);
    expect((await activity(id))[0]?.kind).toBe('webhook_received');
    expect(await received(connection.webhookUrl, body, 'sha256=00')).toMatchObject({
      signature_valid: false,
    });
    expect((await row(id)).status).toBe('connected');
    expect(await received(connection.webhookUrl, body, undefined)).toMatchObject({
      signature_valid: false,
    });
    expect((await activity(id))[0]?.kind).toBe('webhook_received');
  });

  it('stores nothing for an unknown address, a provider that sends nothing, or a malformed one', async () => {
    const request = { token: 'x'.repeat(43), headers: {}, body: Buffer.from('{}') };
    expect(
      await acceptIntegrationWebhook(db.db, options.providers, { ...request, provider: 'standin' }),
    ).toBe('unknown');
    expect(
      await acceptIntegrationWebhook(db.db, options.providers, { ...request, provider: 'nothing' }),
    ).toBe('unknown');
    expect(
      await acceptIntegrationWebhook(
        db.db,
        [standInProvider(fake.origin, { webhook: undefined })],
        { ...request, provider: 'standin' },
      ),
    ).toBe('unknown');
    expect(
      await acceptIntegrationWebhook(db.db, options.providers, {
        ...request,
        token: 'short',
        provider: 'standin',
      }),
    ).toBe('unknown');
  });
});

describe('the schedule', () => {
  it('queues the checks that are due, once, and clears what has expired', async () => {
    const { id } = await connected();
    await db.database.as('crm_owner', (owner) =>
      owner.query(
        "update integrations.connections set next_check_at = now() - interval '1 minute' where id = $1",
        [id],
      ),
    );
    expect(await scheduleIntegrationChecks(db.services)).toBeGreaterThanOrEqual(1);
    expect((await row(id)).next_check_at.getTime()).toBeGreaterThan(Date.now());
    expect(await scheduleIntegrationChecks(db.services)).toBe(0);
    expect(await work(db, workerFor().tasks)).toContain('integrations.check');
    expect(await maintainIntegrations(db.services)).toBeGreaterThanOrEqual(0);
  });
});

describe('edges', () => {
  it('keeps the refresh token a provider did not rotate', async () => {
    const { id } = await connected();
    const { secret_id } = await row(id);
    const before = await sealedOf(secret_id ?? '');
    fake.setRotation(false);
    try {
      await expire(id);
      await check(id);
    } finally {
      fake.setRotation(true);
    }
    const after = await sealedOf(secret_id ?? '');
    expect(after.refreshToken).toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
  });

  it('names the account by its id when the provider gives no name', async () => {
    const { id } = await connected();
    await check(id, [
      standInProvider(fake.origin, {
        identity: { url: `${fake.origin}/me`, id: 'account.id', label: 'account.nickname' },
      }),
    ]);
    const label = await db.database.as('crm_owner', (owner) =>
      owner.one<{ account_label: string; account_ref: string }>(
        'select account_label, account_ref from integrations.connections where id = $1',
        [id],
      ),
    );
    expect(label.account_label).toBe(label.account_ref);
  });

  it('cannot open credentials sealed under a key it does not hold, which is the operator to fix', async () => {
    const stranger = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
    const { connection, id } = await connected();
    const { secret_id } = await row(id);
    await withTenant(db.db, at.system, (trx) =>
      stranger.replace(trx, secret_id ?? '', JSON.stringify({ kind: 'api_key', apiKey: 'k' })),
    );
    await check(id);
    expect((await row(id)).error_code).toBe('config_missing');
    await route(options, db.services, 'disconnectIntegration', manager.invocation, {
      params: { provider: 'standin', id: connection.id },
    });
    await work(db, workerFor().tasks);
    expect((await row(id)).secret_id).toBeNull();
  });

  it('revokes an access token where there is no refresh token, and runs each job once', async () => {
    const { connection, id } = await connected();
    const { secret_id } = await row(id);
    const sealed = await sealedOf(secret_id ?? '');
    await withTenant(db.db, at.system, (trx) =>
      db.vault.replace(
        trx,
        secret_id ?? '',
        JSON.stringify({ kind: 'oauth2', ...sealed, refreshToken: null }),
      ),
    );
    const accessBefore = fake.revoked.access;
    await route(options, db.services, 'disconnectIntegration', manager.invocation, {
      params: { provider: 'standin', id: connection.id },
    });
    await work(db, workerFor().tasks);
    expect(fake.revoked.access).toBe(accessBefore + 1);
    // Queued again, as after a crash: nothing is left to do.
    await withTenant(db.db, at.system, (trx) =>
      sql`select private.enqueue_integration_job('integrations.revoke', ${JSON.stringify({ connectionId: id })}::jsonb, ${`integration-revoke:${id}`}, null)`.execute(
        trx,
      ),
    );
    expect(await work(db, workerFor().tasks)).toEqual(['integrations.revoke']);
    const stored = await db.database.as('crm_owner', (owner) =>
      owner.query<{ id: string }>(
        'select id from intake.webhooks where business_id = $1 order by received_at limit 1',
        [at.businessId],
      ),
    );
    await db.database.as('crm_owner', (owner) =>
      owner.query("select graphile_worker.add_job('integrations.verify_webhook', $1::json)", [
        JSON.stringify({
          agencyId: at.agencyId,
          businessId: at.businessId,
          correlationId: randomUUID(),
          causationId: null,
          data: { webhookId: stored[0]?.id ?? randomUUID() },
        }),
      ]),
    );
    expect(await work(db, workerFor().tasks)).toEqual(['integrations.verify_webhook']);
  });
});
