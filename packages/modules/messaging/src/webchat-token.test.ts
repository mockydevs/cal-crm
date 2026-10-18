import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  bearerSessionToken,
  newSessionToken,
  newWidgetKey,
  sessionDigest,
} from './webchat-token.js';

const widget = '01890a5d-ac96-774b-bcce-b302099a8057';
const other = '01890a5d-ac96-774b-bcce-b302099a8058';

it('makes widget keys of 24 random bytes that fit the stored format', () => {
  const keys = Array.from({ length: 200 }, newWidgetKey);
  for (const key of keys) {
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(key, 'base64url')).toHaveLength(24);
  }
  expect(new Set(keys).size).toBe(keys.length);
});

it('makes session tokens of 32 random bytes in their canonical spelling', () => {
  const tokens = Array.from({ length: 200 }, newSessionToken);
  for (const token of tokens) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(Buffer.from(token, 'base64url').toString('base64url')).toBe(token);
  }
  expect(new Set(tokens).size).toBe(tokens.length);
});

it('stores a digest, never the token, and the same one every time', () => {
  const token = newSessionToken();
  const digest = sessionDigest(widget, token);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(digest).not.toContain(token);
  expect(sessionDigest(widget, token)).toBe(digest);
  expect(digest).toBe(
    createHash('sha256').update(`crm.webchat.session.v1\0${widget}\0${token}`).digest('hex'),
  );
  // Not the bare hash of the token, which another table or log could also hold.
  expect(digest).not.toBe(createHash('sha256').update(token).digest('hex'));
});

it('gives one token a different digest for every widget', () => {
  const token = newSessionToken();
  expect(sessionDigest(other, token)).not.toBe(sessionDigest(widget, token));
});

it('gives different tokens different digests', () => {
  expect(sessionDigest(widget, newSessionToken())).not.toBe(
    sessionDigest(widget, newSessionToken()),
  );
});

it('hashes nothing that is not a well-formed token for a well-formed widget id', () => {
  const token = newSessionToken();
  for (const bad of [
    undefined,
    null,
    42,
    '',
    'short',
    token.slice(1),
    `${token}A`,
    `${token.slice(0, 42)}9`,
    `${token.slice(0, 42)}=`,
    ` ${token}`,
    `${token}\n`,
    [token],
    'a'.repeat(100_000),
  ])
    expect(sessionDigest(widget, bad)).toBeUndefined();
  for (const id of ['', 'not-a-uuid', `${widget}\0`, widget.toUpperCase()])
    expect(sessionDigest(id, token)).toBeUndefined();
});

it('reads a token only from one well-formed Bearer header', () => {
  const token = newSessionToken();
  expect(bearerSessionToken(`Bearer ${token}`)).toBe(token);
  for (const header of [
    undefined,
    '',
    token,
    `bearer ${token}`,
    `BEARER ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} `,
    `Bearer ${token},Bearer ${token}`,
    `Basic ${token}`,
    `Bearer ${token.slice(1)}`,
    `Bearer ${token.slice(0, 42)}9`,
    'Bearer ',
    [`Bearer ${token}`],
  ])
    expect(bearerSessionToken(header)).toBeUndefined();
});
