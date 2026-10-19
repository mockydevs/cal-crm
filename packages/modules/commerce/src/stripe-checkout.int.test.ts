// Paying an invoice by card: "Pay now" on its public page, the worker making the Checkout Session
// at the business's own Stripe account, the page waiting and then sending the customer there, and
// every refusal in words for the customer. Stripe is a fake that records what it was asked.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import type { SalesDocument } from '@repo/contracts';
import { parsePublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { NOW } from '../test/commerce-fixtures.js';
import {
  PUBLIC_URL,
  sharingSuite,
  tokenOf,
  type SharingFixture,
} from '../test/sharing-fixtures.js';
import { createPublicDocumentHandlers } from './public.js';
import { createStripeCheckoutTask, STRIPE_RETURN_PURPOSE } from './stripe-checkout.js';
import { STRIPE_KEY_PURPOSE, type StripeVault } from './stripe-connect.js';
import type { StripeRequest, StripeResponse, StripeTransport } from './stripe-transport.js';

const suite = sharingSuite();
const KEY = `rk_test_${'K3y'.repeat(8)}`;
const SESSION_ID = `cs_test_${'a1B2'.repeat(10)}`;
const SESSION_URL = `https://checkout.stripe.com/c/pay/${SESSION_ID}#fid`;
/** An hour after the fixture's clock, as Stripe would answer for the session's expiry. */
const EXPIRES = Math.floor(new Date(NOW).getTime() / 1000) + 3600;

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
  return { vault, secrets };
}

function fakeStripe(answers: readonly (StripeResponse | 'lost')[]) {
  const seen: StripeRequest[] = [];
  const transport: StripeTransport = (request) => {
    seen.push(request);
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
    if (answer === 'lost' || answer === undefined) return Promise.reject(new Error('lost'));
    return Promise.resolve(answer);
  };
  return { transport, seen };
}

const session = (amountTotal = 150_000): StripeResponse => ({
  status: 200,
  body: {
    id: SESSION_ID,
    object: 'checkout.session',
    url: SESSION_URL,
    expires_at: EXPIRES,
    livemode: false,
    amount_total: amountTotal,
    currency: 'usd',
    status: 'open',
    payment_status: 'unpaid',
  },
});

interface World {
  readonly f: SharingFixture;
  readonly invoice: SalesDocument;
  readonly token: string;
  readonly memory: ReturnType<typeof memoryVault>;
  readonly stripe: ReturnType<typeof fakeStripe>;
  readonly visitor: ReturnType<typeof createPublicDocumentHandlers>;
  readonly runTask: (checkoutId: string) => Promise<void>;
  readonly html: () => Promise<string>;
}

/** An issued invoice of 1,500.00 USD, and Stripe connected unless left out. */
async function world(
  settings: {
    readonly currency?: string;
    readonly connected?: boolean;
    readonly answers?: readonly (StripeResponse | 'lost')[];
  } = {},
): Promise<World> {
  // Every fake answer names the same session, which only one checkout may hold.
  await suite.rows('delete from commerce.stripe_checkouts where session_id = $1', [SESSION_ID]);
  const f = await suite.fixture();
  const issued = await suite.issued(f, 'invoice');
  await suite.rows('update commerce.documents set currency = $1 where id = $2', [
    settings.currency ?? 'USD',
    parsePublicId('sales_document', issued.id),
  ]);
  const memory = memoryVault();
  if (settings.connected !== false) {
    const keyId = await memory.vault.store(
      undefined as never,
      { agencyId: f.agency.id, businessId: f.business.id, purpose: STRIPE_KEY_PURPOSE },
      KEY,
    );
    await suite.rows(
      `insert into commerce.stripe_connections (business_id, status, livemode, key_secret_id,
         webhook_token_secret_id, webhook_digest, webhook_endpoint_id, webhook_secret_id, connected_at)
       values ($1, 'connected', false, $2, $3, $4, 'we_0000000000000001', $3, now())`,
      [f.business.id, keyId, randomUUID(), randomUUID().replaceAll('-', '').repeat(2)],
    );
  }
  const stripe = fakeStripe(settings.answers ?? [session()]);
  const visitor = createPublicDocumentHandlers(suite.db, suite.options, { vault: memory.vault });
  const system: Invocation = {
    context: { ...f.business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  const services = { db: suite.db, authorize: () => Promise.resolve(true) } as never;
  const token = tokenOf(issued.publicLink?.url);
  return {
    f,
    invoice: issued,
    token,
    memory,
    stripe,
    visitor,
    runTask: (checkoutId) =>
      createStripeCheckoutTask(memory.vault, stripe.transport, PUBLIC_URL).run(
        { checkoutId },
        { invocation: system, services },
      ),
    async html() {
      const found = await visitor.page(token, suite.request());
      if (found.outcome !== 'ok') throw new Error(`The page is ${found.outcome}.`);
      return found.value;
    },
  };
}

async function pressPay(w: World): Promise<string> {
  const pressed = await w.visitor.pay(w.token, suite.request());
  if (pressed.outcome !== 'ok' || !('checkoutId' in pressed.value))
    throw new Error('Pay now made no checkout.');
  return pressed.value.checkoutId;
}

const payment = (w: World, checkoutId: string) =>
  w.visitor.payment(w.token, checkoutId, suite.request());

describe('Pay now', () => {
  it('shows only for an owing invoice in a card currency, with Stripe connected', async () => {
    const shown = await world();
    expect(await shown.html()).toContain(`action="/d/${shown.token}/pay"`);

    const kes = await world({ currency: 'KES' });
    expect(await kes.html()).not.toContain('/pay"');
    const unconnected = await world({ connected: false });
    expect(await unconnected.html()).not.toContain('/pay"');
    // An install without the vault shows no button either.
    const plain = await suite.visitor.page(shown.token, suite.request());
    expect(plain.outcome === 'ok' && plain.value.includes('/pay"')).toBe(false);
  });

  it('waits while the session is made, then sends the customer to Stripe', async () => {
    const w = await world();
    const checkoutId = await pressPay(w);

    const waiting = await payment(w, checkoutId);
    expect(waiting.outcome === 'ok' && 'html' in waiting.value && waiting.value.html).toContain(
      '<meta http-equiv="refresh" content="2">',
    );
    // The page's token is sealed for the worker, never stored as it is.
    const [stored] = await suite.rows<Record<string, unknown>>(
      'select * from commerce.stripe_checkouts where id = $1',
      [checkoutId],
    );
    expect(JSON.stringify(stored)).not.toContain(w.token);
    expect([...w.memory.secrets.values()].map((secret) => secret.purpose)).toContain(
      STRIPE_RETURN_PURPOSE,
    );

    await w.runTask(checkoutId);

    expect(w.stripe.seen).toHaveLength(1);
    const [request] = w.stripe.seen;
    expect(request?.path).toBe('/v1/checkout/sessions');
    expect(request?.key).toBe(KEY);
    expect(request?.idempotencyKey).toBe(`cal-crm-checkout-${checkoutId}`);
    const form = request?.form;
    expect(form?.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(form?.get('line_items[0][price_data][unit_amount]')).toBe('150000');
    expect(form?.get('line_items[0][product_data][name]') ?? null).toBeNull();
    expect(form?.get('line_items[0][price_data][product_data][name]')).toBe(
      `Invoice ${w.invoice.number ?? ''}`,
    );
    expect(form?.get('client_reference_id')).toBe(checkoutId);
    expect(form?.get('success_url')).toBe(`${PUBLIC_URL}/d/${w.token}/paid`);
    expect(form?.get('cancel_url')).toBe(`${PUBLIC_URL}/d/${w.token}`);
    expect(form?.get('expires_at')).toBe(String(EXPIRES));
    expect(form?.get('integration_identifier')).toMatch(/^cal-crm-invoice-[a-z]{8}$/);

    expect(await payment(w, checkoutId)).toEqual({
      outcome: 'ok',
      value: { redirect: SESSION_URL },
    });
    const [open] = await suite.rows<{ status: string; amount: string; return_secret_id: unknown }>(
      'select status, amount, return_secret_id from commerce.stripe_checkouts where id = $1',
      [checkoutId],
    );
    expect(open).toEqual({ status: 'open', amount: '1500.0000', return_secret_id: null });
    // Used, the sealed token is gone.
    expect([...w.memory.secrets.values()].map((secret) => secret.purpose)).not.toContain(
      STRIPE_RETURN_PURPOSE,
    );
  });

  it('uses the same checkout when pressed again, and asks Stripe once', async () => {
    const w = await world();
    const first = await pressPay(w);
    expect(await pressPay(w)).toBe(first);
    await w.runTask(first);
    expect(await pressPay(w)).toBe(first);
    await w.runTask(first);
    expect(w.stripe.seen).toHaveLength(1);
    const rows = await suite.rows(
      'select id from commerce.stripe_checkouts where business_id = $1',
      [w.f.business.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('asks again with the same key and parameters when the answer was lost', async () => {
    const w = await world({ answers: ['lost', session()] });
    const checkoutId = await pressPay(w);
    await expect(w.runTask(checkoutId)).rejects.toThrow();
    // Still waiting for the retry.
    const waiting = await payment(w, checkoutId);
    expect(waiting.outcome === 'ok' && 'html' in waiting.value).toBe(true);
    await w.runTask(checkoutId);
    expect(w.stripe.seen).toHaveLength(2);
    const [first, second] = w.stripe.seen;
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.form?.toString()).toBe(first?.form?.toString());
    expect(await payment(w, checkoutId)).toEqual({
      outcome: 'ok',
      value: { redirect: SESSION_URL },
    });
  });

  it('says card payment is not available when Stripe refuses the key, and removes the token', async () => {
    const w = await world({
      answers: [{ status: 401, body: { error: { type: 'invalid_request_error' } } }],
    });
    const checkoutId = await pressPay(w);
    await w.runTask(checkoutId);
    const [row] = await suite.rows<{ status: string; failure: string }>(
      'select status, failure from commerce.stripe_checkouts where id = $1',
      [checkoutId],
    );
    expect(row).toEqual({ status: 'failed', failure: 'key_rejected' });
    const shown = await payment(w, checkoutId);
    expect(shown.outcome === 'ok' && 'html' in shown.value && shown.value.html).toContain(
      'Card payment isn’t available for this invoice right now.',
    );
    expect([...w.memory.secrets.values()].map((secret) => secret.purpose)).not.toContain(
      STRIPE_RETURN_PURPOSE,
    );
  });

  it('refuses a session that charges other than asked', async () => {
    const w = await world({ answers: [session(149_999)] });
    const checkoutId = await pressPay(w);
    await w.runTask(checkoutId);
    const shown = await payment(w, checkoutId);
    expect(shown.outcome === 'ok' && 'redirect' in shown.value).toBe(false);
  });

  it('refuses a currency Stripe is not known to take with two places, and makes nothing', async () => {
    const w = await world({ currency: 'KES' });
    const pressed = await w.visitor.pay(w.token, suite.request());
    expect(pressed.outcome === 'ok' && 'html' in pressed.value && pressed.value.html).toContain(
      'Card payment isn’t available in this invoice’s currency.',
    );
    expect(
      await suite.rows('select id from commerce.stripe_checkouts where business_id = $1', [
        w.f.business.id,
      ]),
    ).toHaveLength(0);
  });

  it("does not open another invoice's checkout", async () => {
    const one = await world();
    const two = await world();
    const checkoutId = await pressPay(one);
    expect((await payment(two, checkoutId)).outcome).toBe('unknown');
    expect((await two.visitor.payment(two.token, 'not-a-uuid', suite.request())).outcome).toBe(
      'unknown',
    );
  });

  it('thanks the customer on the way back, until the payment is confirmed', async () => {
    const w = await world();
    const back = await w.visitor.paid(w.token, suite.request());
    expect(back.outcome === 'ok' && back.value).toContain('Your payment is being confirmed');
  });
});
