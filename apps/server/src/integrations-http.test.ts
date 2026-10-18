import type { Authentication, SignedIn, Workplace } from '@repo/module-auth';
import type { IntegrationWebhookRequest } from '@repo/module-integrations';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  registerIntegrationCallback,
  registerIntegrationWebhooks,
  type IntegrationCallbackTransport,
} from './integrations-http.js';

const person = {
  userId: 'u1',
  sessionId: 's1',
  agencyId: 'a1',
  memberOf: ['b1'],
  agencyStaff: false,
  roles: {},
  twoFactorRequired: false,
  twoFactorEnabled: false,
} as unknown as SignedIn;

function serve(
  signedIn: SignedIn | undefined,
  complete: IntegrationCallbackTransport['complete'],
  workplace: Workplace = {
    at: 'business',
    businessId: 'b1',
    permissions: new Set(['integrations.manage']),
  },
) {
  const app = Fastify();
  const authentication = {
    signedIn: () => Promise.resolve(signedIn),
    workplace: () => Promise.resolve(workplace),
  } as unknown as Authentication;
  registerIntegrationCallback(app, {
    authentication,
    transport: { complete },
    publicUrl: 'https://crm.example.test',
  });
  return app;
}

const never: IntegrationCallbackTransport['complete'] = () => {
  throw new Error('not called');
};

describe("a provider's redirect back", () => {
  it('finishes as the signed-in person and goes back to Settings → Integrations, saying how it went', async () => {
    let seen: unknown;
    const app = serve(person, async (key, callback, who) => {
      seen = {
        key,
        callback,
        grants: await who.grantsIn('b1'),
        elsewhere: await who.grantsIn('b2'),
      };
      return { outcome: 'connected', path: '/b/events/settings/integrations' };
    });
    const answer = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/standin/callback?state=st&code=c0de&extra=ignored',
    });
    expect(answer.statusCode).toBe(302);
    expect(answer.headers.location).toBe(
      'https://crm.example.test/b/events/settings/integrations?integration=standin&outcome=connected',
    );
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    expect(seen).toEqual({
      key: 'standin',
      callback: { state: 'st', code: 'c0de', error: undefined },
      grants: new Set(['integrations.manage']),
      elsewhere: undefined,
    });
  });

  it('sends someone signed out, or not through two-factor, home without trying', async () => {
    const out = await serve(undefined, never).inject({
      method: 'GET',
      url: '/api/v1/integrations/standin/callback',
    });
    expect(out.headers.location).toBe(
      'https://crm.example.test/?integration=standin&outcome=expired',
    );
    const unsecured = await serve(
      { ...person, twoFactorRequired: true, twoFactorEnabled: false },
      never,
    ).inject({ method: 'GET', url: '/api/v1/integrations/standin/callback' });
    expect(unsecured.headers.location).toBe(
      'https://crm.example.test/?integration=standin&outcome=failed',
    );
  });

  it('refuses a provider key that is not one, and says failed when finishing throws', async () => {
    const bad = await serve(person, never).inject({
      method: 'GET',
      url: '/api/v1/integrations/Not-A-Key/callback?code=x',
    });
    expect(bad.headers.location).toBe('https://crm.example.test/?outcome=failed');
    const thrown = await serve(person, () => Promise.reject(new Error('db down'))).inject({
      method: 'GET',
      url: '/api/v1/integrations/standin/callback?state=st',
    });
    expect(thrown.headers.location).toBe(
      'https://crm.example.test/?integration=standin&outcome=failed',
    );
  });

  it('ignores a query it cannot read, and goes home when the attempt names no business', async () => {
    let seen: unknown;
    const answer = await serve(person, (_key, callback) => {
      seen = callback;
      return Promise.resolve({ outcome: 'expired', path: undefined });
    }).inject({
      method: 'GET',
      url: `/api/v1/integrations/standin/callback?state=${'s'.repeat(300)}`,
    });
    expect(seen).toEqual({ state: undefined, code: undefined, error: undefined });
    expect(answer.headers.location).toBe(
      'https://crm.example.test/?integration=standin&outcome=expired',
    );
  });
});

describe("a provider's updates", () => {
  async function webhooks(
    accept: (request: IntegrationWebhookRequest) => Promise<string>,
  ): Promise<FastifyInstance> {
    const app = Fastify();
    await registerIntegrationWebhooks(app, {
      accept: accept as Parameters<typeof registerIntegrationWebhooks>[1]['accept'],
    });
    return app;
  }

  it('hands the raw bytes to intake and answers only whether they were taken', async () => {
    const seen: IntegrationWebhookRequest[] = [];
    const app = await webhooks((request) => {
      seen.push(request);
      return Promise.resolve('accepted');
    });
    const body = '{"event":"ping",  "spaced": true}';
    const answer = await app.inject({
      method: 'POST',
      url: `/webhooks/integrations/standin/${'t'.repeat(43)}`,
      headers: { 'content-type': 'application/json', 'x-standin-signature': 'sha256=ab' },
      payload: body,
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toBe('');
    expect(seen[0]?.provider).toBe('standin');
    expect(seen[0]?.token).toBe('t'.repeat(43));
    expect(seen[0]?.body.toString('utf8')).toBe(body);
    expect(seen[0]?.headers['x-standin-signature']).toBe('sha256=ab');
  });

  it.each([
    ['unknown', 404],
    ['refused', 400],
    ['over_capacity', 503],
  ])('answers %s with %i', async (outcome, status) => {
    const app = await webhooks(() => Promise.resolve(outcome));
    const answer = await app.inject({
      method: 'POST',
      url: `/webhooks/integrations/standin/${'t'.repeat(43)}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(answer.statusCode).toBe(status);
  });

  it('takes a request with no body, refuses one over the limit, and keeps a failure out of the log', async () => {
    const app = await webhooks((request) =>
      Promise.resolve(request.body.length === 0 ? 'refused' : 'accepted'),
    );
    const empty = await app.inject({
      method: 'POST',
      url: `/webhooks/integrations/standin/${'t'.repeat(43)}`,
    });
    expect(empty.statusCode).toBe(400);
    const huge = await app.inject({
      method: 'POST',
      url: `/webhooks/integrations/standin/${'t'.repeat(43)}`,
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(262_145),
    });
    expect(huge.statusCode).toBe(413);
    const down = await webhooks(() => Promise.reject(new Error('database down')));
    const failed = await down.inject({
      method: 'POST',
      url: `/webhooks/integrations/standin/${'t'.repeat(43)}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(failed.statusCode).toBe(503);
  });
});
