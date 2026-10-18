import { describe, expect, it } from 'vitest';

import { checkFileLink, MAX_LINK_SECONDS, signFileLink, type FileScope } from './links.js';

const secret = 'a-files-link-secret-of-32-characters-or-more';
const fileId = '0199a000-0000-7000-8000-00000000f001';
const agencyOnly: FileScope = {
  agencyId: '0199a000-0000-7000-8000-000000000001',
  businessId: undefined,
};
const inBusiness: FileScope = {
  agencyId: agencyOnly.agencyId,
  businessId: '0199a000-0000-7000-8000-000000000002',
};
const signedAt = new Date('2026-10-08T09:00:00Z');

/** A link's query string as a server would hand it over: one value per name. */
function parse(query: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(query));
}

function sign(scope: FileScope, seconds = 3600, now = signedAt): Record<string, string> {
  return parse(signFileLink(secret, fileId, scope, { now, seconds }));
}

describe('a signed link', () => {
  it.each([
    ['an agency file', agencyOnly],
    ['a business file', inBusiness],
  ])('opens %s in the scope it was signed for', (_case, scope) => {
    expect(checkFileLink(secret, fileId, sign(scope), signedAt)).toEqual({ valid: true, scope });
  });

  it('carries the scope, the expiry and the signature, and nothing else', () => {
    expect(Object.keys(sign(inBusiness)).sort()).toEqual([
      'agency',
      'business',
      'expires',
      'signature',
    ]);
    expect(sign(agencyOnly)).not.toHaveProperty('business');
    expect(sign(inBusiness, 60)['expires']).toBe(String(signedAt.getTime() / 1000 + 60));
  });

  it('stops working when it expires, and says so', () => {
    const query = sign(inBusiness, 60);
    const at = (seconds: number) => new Date(signedAt.getTime() + seconds * 1000);

    expect(checkFileLink(secret, fileId, query, at(59)).valid).toBe(true);
    expect(checkFileLink(secret, fileId, query, at(60))).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it.each([
    ['another file', { fileId: '0199a000-0000-7000-8000-00000000f002' }],
    ['another agency', { agency: '0199a000-0000-7000-8000-000000000009' }],
    ['another business', { business: '0199a000-0000-7000-8000-000000000003' }],
    ['a later expiry', { expires: String(signedAt.getTime() / 1000 + 7200) }],
    ['a changed signature', { signature: 'A'.repeat(43) }],
    ['another secret', { secret: 'another-secret-of-32-characters-or-more!!' }],
  ])('refuses a link altered to name %s', (_case, change) => {
    const {
      fileId: otherFile,
      secret: otherSecret,
      ...query
    } = {
      ...sign(inBusiness),
      ...change,
    } as Record<string, string>;

    expect(checkFileLink(otherSecret ?? secret, otherFile ?? fileId, query, signedAt)).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('refuses a business link with its business taken out, which would widen what it reads', () => {
    const { business: _business, ...widened } = sign(inBusiness);

    expect(checkFileLink(secret, fileId, widened, signedAt)).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it.each([
    ['no query', undefined],
    ['a string', 'agency=x'],
    ['missing parts', { agency: agencyOnly.agencyId }],
    [
      'a repeated part',
      { ...sign(agencyOnly), agency: [agencyOnly.agencyId, agencyOnly.agencyId] },
    ],
    ['an id that is not a UUID', { ...sign(agencyOnly), agency: 'not-a-uuid' }],
    ['an expiry that is not a number', { ...sign(agencyOnly), expires: '1e10' }],
    ['a signature of the wrong length', { ...sign(agencyOnly), signature: 'abc' }],
  ])('refuses %s', (_case, query) => {
    expect(checkFileLink(secret, fileId, query, signedAt)).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('lasts at most seven days, and at least a second', () => {
    expect(() => sign(inBusiness, MAX_LINK_SECONDS)).not.toThrow();
    expect(() => sign(inBusiness, MAX_LINK_SECONDS + 1)).toThrow(RangeError);
    expect(() => sign(inBusiness, 0)).toThrow(RangeError);
    expect(() => sign(inBusiness, 1.5)).toThrow(RangeError);
  });
});
