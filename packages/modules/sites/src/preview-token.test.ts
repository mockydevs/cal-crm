import { sitePreviewToken } from '@repo/contracts';
import { expect, it } from 'vitest';

import { issuePreviewToken, readPreviewToken } from './preview-token.js';

const secret = 'sites-preview-fixture-key-with-at-least-32-bytes';
const page = {
  agencyId: '0198de17-876e-7000-aac7-9bc8ac22900d',
  businessId: '0198de17-876e-7111-8ac7-9bc8ac22900e',
  pageId: '01a122e6-1d7b-7683-898b-c83ec14df1bf',
};
const now = Date.parse('2026-10-12T10:00:00.000Z');
const expiresAt = now + 30 * 60_000;
const token = issuePreviewToken(secret, page, expiresAt);

it('is what it names and a digest, in the shape the contract and the page address take', () => {
  expect(sitePreviewToken.safeParse(token).success).toBe(true);
  expect(token).toMatch(/^[A-Za-z0-9_-]{70}\.[A-Za-z0-9_-]{22}$/);
  // Short enough to be a path segment of the server (it reads none over 100 characters).
  expect(token).toHaveLength(93);
  // Nothing random and nothing stored: the same page until the same second is the same link.
  expect(issuePreviewToken(secret, page, expiresAt)).toBe(token);
  expect(issuePreviewToken(secret, page, expiresAt + 999)).toBe(token);
  expect(issuePreviewToken(secret, page, expiresAt + 1000)).not.toBe(token);
});

it('names its page to this server until it runs out', () => {
  expect(readPreviewToken(secret, token, now)).toEqual(page);
  expect(readPreviewToken(secret, token, expiresAt - 1)).toEqual(page);
  expect(readPreviewToken(secret, token, expiresAt)).toBeUndefined();
  expect(readPreviewToken(secret, token, expiresAt + 86_400_000)).toBeUndefined();
  // It runs out on the whole second at or before the moment asked for, never after it.
  const partway = issuePreviewToken(secret, page, expiresAt + 600);
  expect(readPreviewToken(secret, partway, expiresAt - 1)).toEqual(page);
  expect(readPreviewToken(secret, partway, expiresAt)).toBeUndefined();
});

it('answers to no other key, and to nothing that was changed', () => {
  expect(readPreviewToken(`${secret}!`, token, now)).toBeUndefined();
  const [named = '', signature = ''] = token.split('.');
  // Another page, another business or a later end under the same digest is not ours.
  for (const change of [
    { ...page, pageId: '01a122e6-1d7d-7768-9181-7f7be4fed4a5' },
    { ...page, businessId: '0198de17-876e-7222-8ac7-9bc8ac22900f' },
    { ...page, agencyId: '0198de17-876e-7333-8ac7-9bc8ac22900a' },
  ]) {
    const [other = ''] = issuePreviewToken(secret, change, expiresAt).split('.');
    expect(readPreviewToken(secret, `${other}.${signature}`, now)).toBeUndefined();
  }
  const [later = ''] = issuePreviewToken(secret, page, expiresAt + 86_400_000).split('.');
  expect(readPreviewToken(secret, `${later}.${signature}`, now)).toBeUndefined();
  const flipped = `${named}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
  expect(readPreviewToken(secret, flipped, now)).toBeUndefined();
});

it('has one spelling: no other last character reads as the same link', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // The last character of the digest carries four bits that decode to nothing.
  for (const last of alphabet) {
    const respelt = `${token.slice(0, -1)}${last}`;
    expect(readPreviewToken(secret, respelt, now)).toEqual(respelt === token ? page : undefined);
  }
});

it('reads nothing that is not a token', () => {
  const [named = '', signature = ''] = token.split('.');
  for (const given of [
    undefined,
    null,
    7,
    '',
    named,
    `${named}.`,
    `${named}.${signature}x`,
    `${named.slice(1)}.${signature}`,
    `${named}.${'='.repeat(22)}`,
    ` ${token}`,
    [token],
    // The proof of when a form was shown is another kind of token altogether.
    `1790000000000.${'A'.repeat(43)}`,
  ])
    expect(readPreviewToken(secret, given, now)).toBeUndefined();
});

it('is made only for a page named by its ids', () => {
  expect(() => issuePreviewToken(secret, { ...page, pageId: 'spg_abc' }, expiresAt)).toThrow(
    'A preview names a page by its ids.',
  );
});
