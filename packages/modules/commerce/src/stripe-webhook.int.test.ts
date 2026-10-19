// Stripe's notice that an invoice was paid: kept by the API as it came, checked and applied by
// the worker, and recorded as one card payment, however often or oddly it arrives.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import { parsePublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { sharingSuite } from '../test/sharing-fixtures.js';
import {
  STRIPE_KEY_PURPOSE,
  STRIPE_WEBHOOK_SECRET_PURPOSE,
  stripeWebhookDigest,
  type StripeVault,
} from './stripe-connect.js';
import { acceptStripeWebhook, createApplyStripeWebhookTask } from './stripe-webhook.js';

const suite = sharingSuite();
const SECRET = `whsec_${'S3cr'.repeat(8)}`;

function memoryVault() {
  const secrets = new Map<string, { purpose: string; plaintext: string }>();
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
      return Promise.resolve();
    },
  };
  return vault;
}

const sign = (body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): string =>
  `t=${String(at)},v1=${createHmac('sha256', secret)
    .update(`${String(at)}.${body}`)
    .digest('hex')}`;

/** An issued invoice of 1,500.00 USD with an open checkout, and Stripe connected. */
async function world() {
  const f = await suite.fixture();
  const invoice = await suite.issued(f, 'invoice');
  const documentId = parsePublicId('sales_document', invoice.id);
  await suite.rows('update commerce.documents set currency = $1 where id = $2', [
    'USD',
    documentId,
  ]);
  const vault = memoryVault();
  const owner = (purpose: string) => ({
    agencyId: f.agency.id,
    businessId: f.business.id,
    purpose,
  });
  const keyId = await vault.store(undefined as never, owner(STRIPE_KEY_PURPOSE), 'rk_test_x');
  const secretId = await vault.store(
    undefined as never,
    owner(STRIPE_WEBHOOK_SECRET_PURPOSE),
    SECRET,
  );
  const token = randomBytes(32).toString('base64url');
  await suite.rows(
    `insert into commerce.stripe_connections (business_id, status, livemode, key_secret_id,
       webhook_token_secret_id, webhook_digest, webhook_endpoint_id, webhook_secret_id, connected_at)
     values ($1, 'connected', false, $2, $2, $3, 'we_0000000000000001', $4, now())`,
    [f.business.id, keyId, stripeWebhookDigest(token), secretId],
  );
  const sessionId = `cs_test_${randomBytes(12).toString('hex')}`;
  const [checkout] = await suite.rows<{ id: string }>(
    `insert into commerce.stripe_checkouts (business_id, document_id, status, amount, currency,
       session_id, session_url, expires_at, livemode)
     values ($1, $2, 'open', 1500, 'USD', $3, 'https://checkout.stripe.com/c/pay/' || $3,
             now() + interval '1 hour', false)
     returning id`,
    [f.business.id, documentId, sessionId],
  );
  if (checkout === undefined) throw new Error('No checkout.');
  const system: Invocation = {
    context: { ...f.business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  const services = { db: suite.db, authorize: () => Promise.resolve(true) } as never;
  const task = createApplyStripeWebhookTask(suite.options, vault);

  const eventOf = (changes: { type?: string; session?: Record<string, unknown> } = {}) =>
    JSON.stringify({
      id: `evt_${randomBytes(12).toString('hex')}`,
      object: 'event',
      type: changes.type ?? 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: sessionId,
          object: 'checkout.session',
          payment_status: 'paid',
          status: 'complete',
          amount_total: 150_000,
          currency: 'usd',
          client_reference_id: checkout.id,
          payment_intent: 'pi_3Mtw4kLkdIwHu7ix0abcdefg',
          ...changes.session,
        },
      },
    });

  /** Sends one request as Stripe would, then runs the job it queued. */
  async function deliver(body: string, signature = sign(body)): Promise<string> {
    const accepted = await acceptStripeWebhook(suite.db, {
      token,
      signature,
      body: Buffer.from(body),
    });
    if (accepted !== 'accepted') return accepted;
    const [row] = await suite.rows<{ id: string }>(
      `select id from commerce.stripe_webhooks
       where business_id = $1 and processed_at is null order by received_at desc limit 1`,
      [f.business.id],
    );
    if (row === undefined) throw new Error('Nothing kept.');
    await task.run({ webhookId: row.id }, { invocation: system, services });
    return accepted;
  }

  const state = async () => {
    const payments = await suite.rows<{ amount: string; method: string; reference: string }>(
      'select amount, method, reference from commerce.payments where document_id = $1',
      [documentId],
    );
    const [document] = await suite.rows<{ status: string; balance_due: string }>(
      'select status, balance_due from commerce.documents where id = $1',
      [documentId],
    );
    const [kept] = await suite.rows<{ status: string; payment_id: string | null }>(
      'select status, payment_id from commerce.stripe_checkouts where id = $1',
      [checkout.id],
    );
    const webhooks = await suite.rows<{ outcome: string | null }>(
      'select outcome from commerce.stripe_webhooks where business_id = $1 order by received_at',
      [f.business.id],
    );
    return { payments, document, checkout: kept, webhooks: webhooks.map((w) => w.outcome) };
  };

  return { f, token, documentId, checkoutId: checkout.id, eventOf, deliver, state };
}

describe("Stripe's notice of a payment", () => {
  it('records one card payment and marks the invoice paid', async () => {
    const w = await world();
    expect(await w.deliver(w.eventOf())).toBe('accepted');
    const now = await w.state();
    expect(now.payments).toEqual([
      { amount: '1500.0000', method: 'card', reference: 'pi_3Mtw4kLkdIwHu7ix0abcdefg' },
    ]);
    expect(now.document).toEqual({ status: 'paid', balance_due: '0.0000' });
    expect(now.checkout?.status).toBe('paid');
    expect(now.checkout?.payment_id).not.toBeNull();
    expect(now.webhooks).toEqual(['applied']);
  });

  it('records it once, whether the same event or another for the session arrives again', async () => {
    const w = await world();
    const body = w.eventOf();
    await w.deliver(body);
    await w.deliver(body);
    await w.deliver(w.eventOf({ type: 'checkout.session.async_payment_succeeded' }));
    const now = await w.state();
    expect(now.payments).toHaveLength(1);
    expect(now.webhooks).toEqual(['applied', 'ignored', 'ignored']);
  });

  it('records a payment that succeeds later, and nothing before', async () => {
    const w = await world();
    await w.deliver(w.eventOf({ session: { payment_status: 'unpaid' } }));
    expect((await w.state()).payments).toHaveLength(0);
    await w.deliver(
      w.eventOf({
        type: 'checkout.session.async_payment_failed',
        session: { payment_status: 'unpaid' },
      }),
    );
    expect((await w.state()).payments).toHaveLength(0);
    await w.deliver(w.eventOf({ type: 'checkout.session.async_payment_succeeded' }));
    const now = await w.state();
    expect(now.payments).toHaveLength(1);
    expect(now.webhooks).toEqual(['ignored', 'ignored', 'applied']);
  });

  it('refuses what another secret signed, an old signature, or a body that was changed', async () => {
    const w = await world();
    const body = w.eventOf();
    await w.deliver(body, sign(body, `whsec_${'Wr0n'.repeat(8)}`));
    await w.deliver(body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 600));
    await w.deliver(body.replace('150000', '1'), sign(body));
    const now = await w.state();
    expect(now.payments).toHaveLength(0);
    expect(now.checkout?.status).toBe('open');
    expect(now.webhooks).toEqual(['refused', 'refused', 'refused']);
  });

  it('leaves the checkout unmatched when Stripe charged other than asked, and records nothing', async () => {
    const w = await world();
    await w.deliver(w.eventOf({ session: { amount_total: 100_000 } }));
    const now = await w.state();
    expect(now.payments).toHaveLength(0);
    expect(now.checkout?.status).toBe('unmatched');
    expect(now.document?.status).not.toBe('paid');
  });

  it('leaves the checkout unmatched when the invoice was paid another way meanwhile', async () => {
    const w = await world();
    // Paid in full by bank transfer before Stripe's notice came.
    await suite.rows(
      "update commerce.documents set amount_paid = total, balance_due = 0, status = 'paid' where id = $1",
      [w.documentId],
    );
    await w.deliver(w.eventOf());
    const now = await w.state();
    expect(now.payments).toHaveLength(0);
    expect(now.checkout?.status).toBe('unmatched');
  });

  it('ignores a session this install did not make', async () => {
    const w = await world();
    await w.deliver(w.eventOf({ session: { id: `cs_test_${'z'.repeat(24)}` } }));
    const now = await w.state();
    expect(now.payments).toHaveLength(0);
    expect(now.webhooks).toEqual(['ignored']);
  });

  it('keeps nothing for an address that is not a connected account', async () => {
    const w = await world();
    const body = w.eventOf();
    expect(
      await acceptStripeWebhook(suite.db, {
        token: randomBytes(32).toString('base64url'),
        signature: sign(body),
        body: Buffer.from(body),
      }),
    ).toBe('unknown');
    expect(
      await acceptStripeWebhook(suite.db, {
        token: 'short',
        signature: sign(body),
        body: Buffer.from(body),
      }),
    ).toBe('unknown');
    expect(
      await acceptStripeWebhook(suite.db, {
        token: w.token,
        signature: undefined,
        body: Buffer.from(body),
      }),
    ).toBe('refused');
    expect((await w.state()).webhooks).toEqual([]);
  });
});
