import { describe, expect, it } from 'vitest';

import {
  CODE_VERIFIER,
  marketplaceOAuthEndpoints,
  oauthAuthorizationRequest,
  oauthAuthorizationView,
  OAUTH_LIFETIMES,
  S256_CHALLENGE,
} from './marketplace-oauth.js';

describe('the OAuth contracts for installed apps', () => {
  it('passes any bounded request on, so the server can answer in OAuth terms', () => {
    expect(
      oauthAuthorizationRequest.parse({ clientId: 'nonsense', responseType: 'token' }),
    ).toEqual({ clientId: 'nonsense', responseType: 'token' });
    expect(oauthAuthorizationRequest.safeParse({ client_id: 'x' }).success).toBe(false);
    expect(oauthAuthorizationRequest.safeParse({ state: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('knows S256 challenges and RFC 7636 verifiers by their shape', () => {
    // RFC 7636 appendix B's example.
    expect(S256_CHALLENGE.test('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(CODE_VERIFIER.test('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(true);
    expect(CODE_VERIFIER.test('too-short')).toBe(false);
    expect(CODE_VERIFIER.test('x'.repeat(129))).toBe(false);
  });

  it('tells a consent from a refusal', () => {
    const refused = oauthAuthorizationView.parse({
      kind: 'refused',
      error: 'invalid_scope',
      description: 'The app asked for a permission it does not list.',
      redirectUrl: 'https://sync.example/cb?error=invalid_scope',
    });
    expect(refused.kind).toBe('refused');
    expect(
      oauthAuthorizationView.safeParse({ kind: 'refused', error: 'server_error' }).success,
    ).toBe(false);
  });

  it('gives a day to an access token and a year to a refresh token', () => {
    expect(OAUTH_LIFETIMES).toEqual({ code: 600, accessToken: 86_400, refreshToken: 31_536_000 });
  });

  it('puts the consent endpoints in the marketplace group, the secret under /agency', () => {
    for (const endpoint of marketplaceOAuthEndpoints) {
      expect(endpoint.group).toBe('App Marketplace');
    }
    expect(marketplaceOAuthEndpoints.map((each) => `${each.method} ${each.path}`)).toEqual([
      'get /oauth/authorize',
      'post /oauth/authorize',
      'post /agency/marketplace/apps/{appId}/client-secret',
    ]);
  });
});
