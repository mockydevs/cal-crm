// The business's own Stripe account: connecting with a restricted key, the worker making the
// webhook endpoint, failures in plain codes, replacing and disconnecting with the old endpoint
// deleted at Stripe, and nothing secret ever coming back out.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import type { StripeConnection } from '@repo/contracts';
import { ConflictError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { sharingSuite, type SharingFixture } from '../test/sharing-fixtures.js';
import {
  createRemoveStripeEndpointsTask,
  createSetUpStripeTask,
  STRIPE_KEY_PURPOSE,
  STRIPE_WEBHOOK_SECRET_PURPOSE,
  STRIPE_WEBHOOK_TOKEN_PURPOSE,
  type StripeVault,
} from './stripe-connect.js';
import { createStripeRoutes } from './stripe-routes.js';
import type { StripeRequest, StripeResponse, StripeTransport } from './stripe-transport.js';

const suite = sharingSuite();
const PUBLIC_URL = 'https://crm.example.com';
const KEY = `rk_test_${'K3y'.repeat(8)}`;
const OTHER_KEY = `rk_live_${'Ot4'.repeat(8)}`;
const SECRET = `whsec_${'S3cr'.repeat(6)}`;

/** The vault, kept in memory: what was sealed, under which purpose, and what was removed. */
function memoryVault() {
  const secrets = new Map<string, { purpose: string; plaintext: string }>();
  const removed: string[] = [];
  const vault: StripeVault = {
    store(_trx, owner, plaintext) {
      const id = randomUUID();
      secrets.set(id, { purpose: owner.purpose, plaintext });
      return Promise.resolve(id);
    },
    read(_trx, secretId, purpose) {
      const secret = secrets.get(secretId);
      if (secret?.purpose !== purpose) return Promise.reject(new Error('No such secret.'));
      return Promise.resolve(secret.plaintext);
    },
    remove(_trx, secretId) {
      secrets.delete(secretId);
      removed.push(secretId);
      return Promise.resolve();
    },
  };
  return { vault, secrets, removed };
}

/** Stripe, answering each request in turn from the list given (the last answer repeats). */
function fakeStripe(answers: readonly StripeResponse[]) {
  const seen: StripeRequest[] = [];
  const transport: StripeTransport = (request) => {
    seen.push(request);
    return Promise.resolve(
      answers[Math.min(seen.length - 1, answers.length - 1)] ?? { status: 500, body: null },
    );
  };
  return { transport, seen };
}

const created = (id = 'we_1Mr5jULkdIwHu7ix1ibLTM0x'): StripeResponse => ({
  status: 200,
  body: { id, object: 'webhook_endpoint', livemode: false, status: 'enabled', secret: SECRET },
});

function setUp(
  f: SharingFixture,
  memory: ReturnType<typeof memoryVault>,
  transport: StripeTransport,
) {
  const routes = createStripeRoutes(suite.options, memory.vault);
  const system: Invocation = {
    context: { ...f.business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  const services = { db: suite.db, authorize: () => Promise.resolve(true) } as never;
  return {
    read: () =>
      suite.api(
        f,
        'getStripeConnection',
        undefined,
        f.manager,
        routes,
      ) as Promise<StripeConnection>,
    connect: (key: string) =>
      suite.api(
        f,
        'connectStripe',
        { body: { key } },
        f.manager,
        routes,
      ) as Promise<StripeConnection>,
    disconnect: () =>
      suite.api(f, 'disconnectStripe', undefined, f.manager, routes) as Promise<StripeConnection>,
    async digest(): Promise<string> {
      const [row] = await suite.rows<{ webhook_digest: string }>(
        'select webhook_digest from commerce.stripe_connections where business_id = $1',
        [f.business.id],
      );
      if (row === undefined) throw new Error('No connection.');
      return row.webhook_digest;
    },
    async runSetUp(publicUrl = PUBLIC_URL) {
      const task = createSetUpStripeTask(memory.vault, transport, publicUrl);
      await task.run({ digest: await this.digest() }, { invocation: system, services });
    },
    async runRemovals() {
      const task = createRemoveStripeEndpointsTask(memory.vault, transport);
      await task.run({}, { invocation: system, services });
    },
  };
}

describe('connecting a Stripe account', () => {
  it('connects with a restricted key and creates the webhook endpoint', async () => {
    const f = await suite.fixture();
    const memory = memoryVault();
    const stripe = fakeStripe([created()]);
    const s = setUp(f, memory, stripe.transport);

    expect(await s.connect(KEY)).toMatchObject({ status: 'connecting', livemode: false });
    await s.runSetUp();

    const connection = await s.read();
    expect(connection.status).toBe('connected');
    expect(connection.connectedAt).not.toBeNull();
    expect(stripe.seen).toHaveLength(1);
    const [request] = stripe.seen;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v1/webhook_endpoints');
    expect(request?.key).toBe(KEY);
    const url = request?.form?.get('url') ?? '';
    expect(url.startsWith(`${PUBLIC_URL}/webhooks/stripe/`)).toBe(true);
    expect(request?.idempotencyKey).toBe(`cal-crm-stripe-webhook-${await s.digest()}`);
    // The key, the token in the address and the signing secret are each sealed for their purpose.
    expect([...memory.secrets.values()].map((secret) => secret.purpose).sort()).toEqual(
      [STRIPE_KEY_PURPOSE, STRIPE_WEBHOOK_SECRET_PURPOSE, STRIPE_WEBHOOK_TOKEN_PURPOSE].sort(),
    );
  });

  it('never shows the key, the token or the signing secret', async () => {
    const f = await suite.fixture();
    const memory = memoryVault();
    const s = setUp(f, memory, fakeStripe([created()]).transport);
    const answers = [JSON.stringify(await s.connect(KEY))];
    await s.runSetUp();
    answers.push(JSON.stringify(await s.read()));
    const token = [...memory.secrets.values()].find(
      (secret) => secret.purpose === STRIPE_WEBHOOK_TOKEN_PURPOSE,
    )?.plaintext;
    const [row] = await suite.rows<Record<string, unknown>>(
      'select * from commerce.stripe_connections where business_id = $1',
      [f.business.id],
    );
    const audits = await suite.rows<{ input: unknown }>(
      "select input from audit.commands where command = 'commerce.connect_stripe'",
    );
    for (const text of [...answers, JSON.stringify(row), JSON.stringify(audits)]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(SECRET);
      if (token !== undefined) expect(text).not.toContain(token);
    }
  });

  it('refuses a secret key', async () => {
    const f = await suite.fixture();
    const s = setUp(f, memoryVault(), fakeStripe([created()]).transport);
    await expect(s.connect(`sk_test_${'a'.repeat(24)}`)).rejects.toThrow();
    expect((await s.read()).status).toBe('not_connected');
  });

  it('fails with key_rejected when Stripe refuses the key', async () => {
    const f = await suite.fixture();
    const s = setUp(
      f,
      memoryVault(),
      fakeStripe([{ status: 401, body: { error: { type: 'invalid_request_error' } } }]).transport,
    );
    await s.connect(KEY);
    await s.runSetUp();
    expect(await s.read()).toMatchObject({ status: 'failed', failure: 'key_rejected' });
  });

  it('fails with missing_permission when the key lacks a permission', async () => {
    const f = await suite.fixture();
    const s = setUp(
      f,
      memoryVault(),
      fakeStripe([{ status: 403, body: { error: { type: 'invalid_request_error' } } }]).transport,
    );
    await s.connect(KEY);
    await s.runSetUp();
    expect(await s.read()).toMatchObject({ status: 'failed', failure: 'missing_permission' });
  });

  it('fails without a public https address and calls Stripe for nothing', async () => {
    const f = await suite.fixture();
    const stripe = fakeStripe([created()]);
    const s = setUp(f, memoryVault(), stripe.transport);
    await s.connect(KEY);
    await s.runSetUp('http://localhost:3000');
    expect(await s.read()).toMatchObject({ status: 'failed', failure: 'no_public_address' });
    expect(stripe.seen).toEqual([]);
  });

  it('asks again with the same idempotency key when Stripe’s answer was lost', async () => {
    const f = await suite.fixture();
    const stripe = fakeStripe([{ status: 500, body: null }, created()]);
    const s = setUp(f, memoryVault(), stripe.transport);
    await s.connect(KEY);
    await expect(s.runSetUp()).rejects.toThrow();
    expect((await s.read()).status).toBe('connecting');
    await s.runSetUp();
    expect((await s.read()).status).toBe('connected');
    expect(stripe.seen.map((request) => request.idempotencyKey)).toEqual([
      stripe.seen[0]?.idempotencyKey,
      stripe.seen[0]?.idempotencyKey,
    ]);
  });
});

describe('changing the connection', () => {
  it('replaces an earlier connection and removes its endpoint at Stripe', async () => {
    const f = await suite.fixture();
    const memory = memoryVault();
    const stripe = fakeStripe([
      created('we_firstEndpoint01'),
      created('we_secondEndpoint02'),
      { status: 200, body: { deleted: true } },
    ]);
    const s = setUp(f, memory, stripe.transport);
    await s.connect(KEY);
    await s.runSetUp();
    await s.connect(OTHER_KEY);
    expect(await s.read()).toMatchObject({ status: 'connecting', livemode: true });
    await s.runSetUp();
    await s.runRemovals();
    const deletion = stripe.seen.find((request) => request.method === 'DELETE');
    expect(deletion?.path).toBe('/v1/webhook_endpoints/we_firstEndpoint01');
    expect(deletion?.key).toBe(KEY);
    expect(
      await suite.rows('select 1 from commerce.stripe_endpoint_removals where business_id = $1', [
        f.business.id,
      ]),
    ).toEqual([]);
    // Only the new connection's three secrets are left.
    expect(memory.secrets.size).toBe(3);
    expect([...memory.secrets.values()].some((secret) => secret.plaintext === KEY)).toBe(false);
  });

  it('refuses to change a connection while it is still being set up', async () => {
    const f = await suite.fixture();
    const s = setUp(f, memoryVault(), fakeStripe([created()]).transport);
    await s.connect(KEY);
    await expect(s.connect(OTHER_KEY)).rejects.toBeInstanceOf(ConflictError);
    await expect(s.disconnect()).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets a setup that never finished be replaced after ten minutes', async () => {
    const f = await suite.fixture();
    const s = setUp(f, memoryVault(), fakeStripe([created()]).transport);
    await s.connect(KEY);
    await suite.rows(
      "update commerce.stripe_connections set created_at = now() - interval '11 minutes' where business_id = $1",
      [f.business.id],
    );
    expect(await s.connect(OTHER_KEY)).toMatchObject({ status: 'connecting', livemode: true });
  });

  it('disconnects, deletes the endpoint, and counts one Stripe already deleted as gone', async () => {
    const f = await suite.fixture();
    const memory = memoryVault();
    const stripe = fakeStripe([
      created(),
      { status: 404, body: { error: { type: 'invalid_request_error' } } },
    ]);
    const s = setUp(f, memory, stripe.transport);
    await s.connect(KEY);
    await s.runSetUp();
    expect((await s.disconnect()).status).toBe('not_connected');
    expect((await s.read()).status).toBe('not_connected');
    await s.runRemovals();
    expect(memory.secrets.size).toBe(0);
    expect(
      await suite.rows('select 1 from commerce.stripe_endpoint_removals where business_id = $1', [
        f.business.id,
      ]),
    ).toEqual([]);
  });

  it('keeps trying to delete an endpoint when Stripe’s answer was lost', async () => {
    const f = await suite.fixture();
    const memory = memoryVault();
    const stripe = fakeStripe([created(), { status: 503, body: null }]);
    const s = setUp(f, memory, stripe.transport);
    await s.connect(KEY);
    await s.runSetUp();
    await s.disconnect();
    await expect(s.runRemovals()).rejects.toThrow();
    expect(
      await suite.rows('select 1 from commerce.stripe_endpoint_removals where business_id = $1', [
        f.business.id,
      ]),
    ).toHaveLength(1);
  });

  it('keeps two businesses’ connections apart', async () => {
    const one = await suite.fixture();
    const two = await suite.fixture();
    const a = setUp(one, memoryVault(), fakeStripe([created()]).transport);
    const b = setUp(two, memoryVault(), fakeStripe([created()]).transport);
    await a.connect(KEY);
    await a.runSetUp();
    expect((await a.read()).status).toBe('connected');
    expect((await b.read()).status).toBe('not_connected');
    await b.connect(OTHER_KEY);
    expect((await a.read()).livemode).toBe(false);
    expect((await b.read()).livemode).toBe(true);
  });
});
