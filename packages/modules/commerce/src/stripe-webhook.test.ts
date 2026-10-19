import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyStripeSignature } from './stripe-webhook.js';

const SECRET = `whsec_${'S3cr'.repeat(8)}`;
const BODY = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}');
const AT = new Date('2026-10-19T12:00:00Z');
const T = AT.getTime() / 1000;

/** What Stripe sends: HMAC-SHA256 of "<t>.<body>" keyed with the whole whsec_ secret, in hex. */
const sign = (t: number, body: Uint8Array = BODY, secret = SECRET): string =>
  createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(body)
    .digest('hex');

describe('verifyStripeSignature', () => {
  it('accepts a v1 signature of the body at a time near its arrival', () => {
    expect(verifyStripeSignature(`t=${String(T)},v1=${sign(T)}`, BODY, SECRET, AT)).toBe(true);
  });

  it('accepts any one of several v1 signatures, as when the secret is being rolled', () => {
    const other = sign(T, BODY, `whsec_${'0ld'.repeat(8)}`);
    expect(
      verifyStripeSignature(`t=${String(T)},v1=${other},v1=${sign(T)}`, BODY, SECRET, AT),
    ).toBe(true);
  });

  it('ignores every scheme but v1, such as the v0 of test events', () => {
    expect(verifyStripeSignature(`t=${String(T)},v0=${sign(T)}`, BODY, SECRET, AT)).toBe(false);
  });

  it('refuses another secret, a changed body or a changed time', () => {
    const wrong = sign(T, BODY, `whsec_${'Wr0n'.repeat(8)}`);
    expect(verifyStripeSignature(`t=${String(T)},v1=${wrong}`, BODY, SECRET, AT)).toBe(false);
    const changed = Buffer.from('{"id":"evt_2","type":"checkout.session.completed"}');
    expect(verifyStripeSignature(`t=${String(T)},v1=${sign(T)}`, changed, SECRET, AT)).toBe(false);
    expect(verifyStripeSignature(`t=${String(T + 1)},v1=${sign(T)}`, BODY, SECRET, AT)).toBe(false);
  });

  it('refuses a signature more than five minutes from when the request came in', () => {
    const old = T - 301;
    expect(verifyStripeSignature(`t=${String(old)},v1=${sign(old)}`, BODY, SECRET, AT)).toBe(false);
    const edge = T - 300;
    expect(verifyStripeSignature(`t=${String(edge)},v1=${sign(edge)}`, BODY, SECRET, AT)).toBe(
      true,
    );
    const ahead = T + 301;
    expect(verifyStripeSignature(`t=${String(ahead)},v1=${sign(ahead)}`, BODY, SECRET, AT)).toBe(
      false,
    );
  });

  it('refuses a header without a time or a signature, or with a malformed one', () => {
    for (const header of [
      '',
      `v1=${sign(T)}`,
      `t=${String(T)}`,
      `t=${String(T)},v1=${sign(T).slice(0, 63)}`,
      `t=abc,v1=${sign(T)}`,
      `t=${String(T)},v1=${sign(T).toUpperCase()}`,
    ])
      expect(verifyStripeSignature(header, BODY, SECRET, AT)).toBe(false);
  });
});
