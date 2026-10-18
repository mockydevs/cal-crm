import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  clipped,
  codeChallengeOf,
  codeVerifierOf,
  credentialsPurpose,
  failureDetail,
  fieldAt,
  nextCheckAt,
  readingOf,
  sealedCredentials,
  sha256,
  sha256Hex,
  signatureValid,
  stateOf,
  tokenFresh,
} from './rules.js';

describe('PKCE', () => {
  it('makes a 43-character verifier from the state and the secret, and its S256 challenge', () => {
    const verifier = codeVerifierOf('client-secret', 'state');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeVerifierOf('client-secret', 'state')).toBe(verifier);
    expect(codeVerifierOf('another-secret', 'state')).not.toBe(verifier);
    expect(codeChallengeOf(verifier)).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });
});

describe('digests', () => {
  it('are SHA-256, as bytes for a state and hex for a capability', () => {
    expect(sha256('x')).toHaveLength(32);
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signatureValid', () => {
  const body = Buffer.from('{"event":"ping"}');
  const hex = createHmac('sha256', 'secret').update(body).digest('hex');
  const base64 = createHmac('sha256', 'secret').update(body).digest('base64');

  it('accepts an HMAC-SHA256 of the raw body, with its prefix, in either encoding', () => {
    expect(
      signatureValid(
        { header: 'X-Sig', encoding: 'hex', prefix: 'sha256=' },
        'secret',
        { 'x-sig': `sha256=${hex}` },
        body,
      ),
    ).toBe(true);
    expect(
      signatureValid(
        { header: 'x-sig', encoding: 'base64', prefix: '' },
        'secret',
        { 'x-sig': base64 },
        body,
      ),
    ).toBe(true);
  });

  it('refuses another secret, another body, a missing or unprefixed header, and a short one', () => {
    const signing = { header: 'x-sig', encoding: 'hex', prefix: 'sha256=' } as const;
    expect(signatureValid(signing, 'other', { 'x-sig': `sha256=${hex}` }, body)).toBe(false);
    expect(signatureValid(signing, 'secret', { 'x-sig': `sha256=${hex}` }, Buffer.from('{}'))).toBe(
      false,
    );
    expect(signatureValid(signing, 'secret', {}, body)).toBe(false);
    expect(signatureValid(signing, 'secret', { 'x-sig': hex }, body)).toBe(false);
    expect(signatureValid(signing, 'secret', { 'x-sig': 'sha256=ab' }, body)).toBe(false);
    expect(signatureValid(signing, 'secret', { 'x-sig': ['sha256=ab'] }, body)).toBe(false);
  });
});

describe('sealed credentials', () => {
  it('are a token pair or a key, under the provider’s purpose', () => {
    expect(credentialsPurpose('standin')).toBe('integrations.standin.credentials');
    expect(
      sealedCredentials.safeParse({
        kind: 'oauth2',
        accessToken: 'a',
        refreshToken: null,
        expiresAt: null,
      }).success,
    ).toBe(true);
    expect(sealedCredentials.safeParse({ kind: 'api_key', apiKey: '' }).success).toBe(false);
  });

  it('are fresh while more than a minute of the access token is left, and a key always', () => {
    const now = new Date('2026-10-18T09:00:00.000Z');
    const pair = (expiresAt: string | null) =>
      ({ kind: 'oauth2', accessToken: 'a', refreshToken: 'r', expiresAt }) as const;
    expect(tokenFresh(pair('2026-10-18T09:05:00.000Z'), now)).toBe(true);
    expect(tokenFresh(pair('2026-10-18T09:00:30.000Z'), now)).toBe(false);
    expect(tokenFresh(pair(null), now)).toBe(true);
    expect(tokenFresh({ kind: 'api_key', apiKey: 'k' }, now)).toBe(true);
  });
});

describe('what a card says', () => {
  it('counts working and failing connections, and names a single live account', () => {
    expect(readingOf([])).toEqual({ connected: 0, attention: 0, label: null });
    expect(readingOf([{ status: 'connected', label: 'Acme' }])).toEqual({
      connected: 1,
      attention: 0,
      label: 'Acme',
    });
    expect(
      readingOf([
        { status: 'connected', label: 'Acme' },
        { status: 'needs_attention', label: 'Beta' },
        { status: 'disconnected', label: 'Gone' },
      ]),
    ).toEqual({ connected: 1, attention: 1, label: null });
    expect(readingOf([{ status: 'connecting', label: null }])).toEqual({
      connected: 0,
      attention: 0,
      label: null,
    });
  });

  it('puts attention first, then working, then connecting, then nothing', () => {
    expect(stateOf({ connected: 2, attention: 1, label: null })).toBe('needs_attention');
    expect(stateOf({ connected: 1, attention: 0, label: null }, true)).toBe('connected');
    expect(stateOf({ connected: 0, attention: 0, label: null }, true)).toBe('connecting');
    expect(stateOf({ connected: 0, attention: 0, label: null })).toBe('not_connected');
  });
});

describe('nextCheckAt', () => {
  it('is a day on, spread from 18 to 30 hours, whatever the random number', () => {
    const now = new Date('2026-10-18T00:00:00.000Z');
    const hours = (random: number) =>
      (nextCheckAt(now, random).getTime() - now.getTime()) / 3_600_000;
    expect(hours(0)).toBe(18);
    expect(hours(0.5)).toBe(24);
    expect(hours(1)).toBe(30);
    expect(hours(-3)).toBe(18);
    expect(hours(7)).toBe(30);
  });
});

describe('failureDetail', () => {
  it.each([
    'reauthorize',
    'missing_permission',
    'rate_limited',
    'provider_error',
    'plan_limit',
    'config_missing',
  ] as const)('says %s in words that name the provider and fit the column', (code) => {
    const words = failureDetail(code, 'Stand-in');
    expect(words).toContain('Stand-in');
    expect(words.length).toBeLessThanOrEqual(300);
  });
});

describe('fieldAt', () => {
  it('reads a dotted path as text, numbers included, and nothing else', () => {
    const body = { team: { id: 'T1', name: ' Acme ', size: 4, tags: ['a'] }, blank: ' ' };
    expect(fieldAt(body, 'team.id')).toBe('T1');
    expect(fieldAt(body, 'team.name')).toBe('Acme');
    expect(fieldAt(body, 'team.size')).toBe('4');
    expect(fieldAt(body, 'team.tags')).toBeUndefined();
    expect(fieldAt(body, 'team.tags.0')).toBeUndefined();
    expect(fieldAt(body, 'blank')).toBeUndefined();
    expect(fieldAt(body, 'missing.id')).toBeUndefined();
    expect(fieldAt(null, 'id')).toBeUndefined();
  });
});

describe('clipped', () => {
  it('keeps short words and ends long ones with an ellipsis at the length', () => {
    expect(clipped('Acme', 10)).toBe('Acme');
    expect(clipped('abcdefghijkl', 5)).toBe('abcd…');
  });
});
