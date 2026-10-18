import { salesDocumentLinkToken } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { linkDigest, linksAvailable, linkToken } from './links.js';
import type { CommerceOptions } from './shared.js';

const ID = '0198a5d0-0000-7000-8000-000000000001';
const options = (links: CommerceOptions['links']): CommerceOptions => ({
  business: { holdActive: () => Promise.resolve(true), profile: () => Promise.reject(new Error()) },
  contacts: { read: () => Promise.reject(new Error()) },
  deals: { read: () => Promise.reject(new Error()) },
  links,
});

describe('the token of a public address', () => {
  it('is 43 characters of base64url, the same each time for one row and one secret', () => {
    const token = linkToken('a-secret', ID);
    expect(salesDocumentLinkToken.safeParse(token).success).toBe(true);
    expect(linkToken('a-secret', ID)).toBe(token);
  });

  it('is another token for another row, and for another secret', () => {
    const token = linkToken('a-secret', ID);
    expect(linkToken('a-secret', '0198a5d0-0000-7000-8000-000000000002')).not.toBe(token);
    expect(linkToken('another-secret', ID)).not.toBe(token);
  });

  it('is kept only as its SHA-256', () => {
    const token = linkToken('a-secret', ID);
    expect(linkDigest(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(linkDigest(token)).not.toContain(token);
    expect(linkDigest(`${token}x`)).not.toBe(linkDigest(token));
  });
});

describe('whether an install gives documents public addresses', () => {
  it('does with a secret and a web address', () => {
    expect(linksAvailable(options({ secret: 's', publicUrl: 'https://crm.example.test' }))).toBe(
      true,
    );
    expect(linksAvailable(options({ secret: 's', publicUrl: 'http://localhost:3000' }))).toBe(true);
  });

  it('does not without either, or with an address that holds a password or is no web address', () => {
    expect(linksAvailable(options(undefined))).toBe(false);
    expect(linksAvailable(options({ secret: '', publicUrl: 'https://crm.example.test' }))).toBe(
      false,
    );
    expect(linksAvailable(options({ secret: 's', publicUrl: 'not an address' }))).toBe(false);
    expect(linksAvailable(options({ secret: 's', publicUrl: 'ftp://crm.example.test' }))).toBe(
      false,
    );
    expect(
      linksAvailable(options({ secret: 's', publicUrl: 'https://user:pass@crm.example.test' })),
    ).toBe(false);
  });
});
