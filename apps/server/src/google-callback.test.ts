import type { Authentication, SignedIn, Workplace } from '@repo/module-auth';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  GOOGLE_CALLBACK_PATH,
  registerGoogleCallback,
  type GoogleCallbackTransport,
} from './google-callback.js';

const person: SignedIn = {
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
  complete: GoogleCallbackTransport['complete'],
  workplace: Workplace = { at: 'business', businessId: 'b1', permissions: new Set() },
) {
  const app = Fastify();
  const authentication = {
    signedIn: () => Promise.resolve(signedIn),
    workplace: () => Promise.resolve(workplace),
  } as unknown as Authentication;
  registerGoogleCallback(app, {
    authentication,
    transport: { complete },
    publicUrl: 'https://crm.example.test',
  });
  return app;
}

describe('Google’s redirect back', () => {
  it('finishes as the signed-in person and goes back to their Connections page', async () => {
    let seen: unknown;
    const app = serve(person, async (callback, who) => {
      seen = { callback, grants: await who.grantsIn('b1'), elsewhere: await who.grantsIn('b2') };
      return { outcome: 'connected', path: '/b/events/settings/calendars/connections' };
    });
    const answer = await app.inject({
      method: 'GET',
      url: `${GOOGLE_CALLBACK_PATH}?state=st&code=4/c&scope=x`,
    });
    expect(answer.statusCode).toBe(302);
    expect(answer.headers.location).toBe(
      'https://crm.example.test/b/events/settings/calendars/connections?google=connected',
    );
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(seen).toEqual({
      callback: { state: 'st', code: '4/c', error: undefined },
      grants: new Set(),
      elsewhere: undefined,
    });
  });

  it('sends someone signed out, or not through two-factor, home without trying', async () => {
    const never: GoogleCallbackTransport['complete'] = () => {
      throw new Error('not called');
    };
    const out = await serve(undefined, never).inject({ method: 'GET', url: GOOGLE_CALLBACK_PATH });
    expect(out.headers.location).toBe('https://crm.example.test/?google=expired');
    const unsecured = await serve(
      { ...person, twoFactorRequired: true, twoFactorEnabled: false },
      never,
    ).inject({ method: 'GET', url: GOOGLE_CALLBACK_PATH });
    expect(unsecured.headers.location).toBe('https://crm.example.test/?google=failed');
  });

  it('says failed when finishing throws, and ignores a query it can’t read', async () => {
    const thrown = await serve(person, () => Promise.reject(new Error('db down'))).inject({
      method: 'GET',
      url: `${GOOGLE_CALLBACK_PATH}?state=st`,
    });
    expect(thrown.headers.location).toBe('https://crm.example.test/?google=failed');
    let given: unknown;
    const odd = await serve(person, (callback) => {
      given = callback;
      return Promise.resolve({ outcome: 'expired', path: undefined });
    }).inject({ method: 'GET', url: `${GOOGLE_CALLBACK_PATH}?state=${'x'.repeat(300)}` });
    expect(odd.headers.location).toBe('https://crm.example.test/?google=expired');
    expect(given).toEqual({ state: undefined, code: undefined, error: undefined });
  });
});
