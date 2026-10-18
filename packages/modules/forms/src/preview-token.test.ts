import { formPreviewToken } from '@repo/contracts';
import { expect, it } from 'vitest';

import { issuePreviewToken, readPreviewToken } from './preview-token.js';

const secret = 'forms-preview-fixture-key-with-at-least-32-bytes';
const form = {
  agencyId: '0198de17-876e-7000-aac7-9bc8ac22900d',
  businessId: '0198de17-876e-7111-8ac7-9bc8ac22900e',
  formId: '01a122e6-1d7b-7683-898b-c83ec14df1bf',
};
const now = Date.parse('2026-10-12T10:00:00.000Z');
const expiresAt = now + 30 * 60_000;
const token = issuePreviewToken(secret, form, expiresAt);

it('is what it names and a digest, in the shape the contract and the page address take', () => {
  expect(formPreviewToken.safeParse(token).success).toBe(true);
  expect(token).toMatch(/^[A-Za-z0-9_-]{70}\.[A-Za-z0-9_-]{22}$/);
  // Short enough to be a path segment of the server (it reads none over 100 characters).
  expect(token).toHaveLength(93);
  // Nothing random and nothing stored: the same form until the same second is the same link.
  expect(issuePreviewToken(secret, form, expiresAt)).toBe(token);
  expect(issuePreviewToken(secret, form, expiresAt + 999)).toBe(token);
  expect(issuePreviewToken(secret, form, expiresAt + 1000)).not.toBe(token);
});

it('names its form to this server until it runs out', () => {
  expect(readPreviewToken(secret, token, now)).toEqual(form);
  expect(readPreviewToken(secret, token, expiresAt - 1)).toEqual(form);
  expect(readPreviewToken(secret, token, expiresAt)).toBeUndefined();
  expect(readPreviewToken(secret, token, expiresAt + 86_400_000)).toBeUndefined();
  // It runs out on the whole second at or before the moment asked for, never after it.
  const partway = issuePreviewToken(secret, form, expiresAt + 600);
  expect(readPreviewToken(secret, partway, expiresAt - 1)).toEqual(form);
  expect(readPreviewToken(secret, partway, expiresAt)).toBeUndefined();
});

it('answers to no other key, and to nothing that was changed', () => {
  expect(readPreviewToken(`${secret}!`, token, now)).toBeUndefined();
  const [named = '', signature = ''] = token.split('.');
  // Another form, another business or a later end under the same digest is not ours.
  for (const change of [
    { ...form, formId: '01a122e6-1d7d-7768-9181-7f7be4fed4a5' },
    { ...form, businessId: '0198de17-876e-7222-8ac7-9bc8ac22900f' },
    { ...form, agencyId: '0198de17-876e-7333-8ac7-9bc8ac22900a' },
  ]) {
    const [other = ''] = issuePreviewToken(secret, change, expiresAt).split('.');
    expect(readPreviewToken(secret, `${other}.${signature}`, now)).toBeUndefined();
  }
  const [later = ''] = issuePreviewToken(secret, form, expiresAt + 86_400_000).split('.');
  expect(readPreviewToken(secret, `${later}.${signature}`, now)).toBeUndefined();
  const flipped = `${named}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
  expect(readPreviewToken(secret, flipped, now)).toBeUndefined();
});

it('has one spelling: no other last character reads as the same link', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // The last character of the digest carries four bits that decode to nothing.
  for (const last of alphabet) {
    const respelt = `${token.slice(0, -1)}${last}`;
    expect(readPreviewToken(secret, respelt, now)).toEqual(respelt === token ? form : undefined);
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

it('is made only for a form named by its ids', () => {
  expect(() => issuePreviewToken(secret, { ...form, formId: 'form_abc' }, expiresAt)).toThrow(
    'A preview names a form by its ids.',
  );
});
