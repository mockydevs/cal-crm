import { describe, expect, it } from 'vitest';

import { isDisposableDomain, isRoleAddress, readList } from './lists.js';

describe('isDisposableDomain', () => {
  it('flags a listed domain, in any case, with or without the root dot', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('MAILINATOR.COM.')).toBe(true);
  });

  it('flags a subdomain of a listed domain', () => {
    expect(isDisposableDomain('a.b.mailinator.com')).toBe(true);
  });

  it('does not flag an ordinary domain, or one that only ends in the same letters', () => {
    expect(isDisposableDomain('example.com')).toBe(false);
    expect(isDisposableDomain('xmailinator.com')).toBe(false);
  });

  it('never flags an allowed mailbox provider or its subdomains', () => {
    expect(isDisposableDomain('gmail.com')).toBe(false);
    expect(isDisposableDomain('eu.outlook.com')).toBe(false);
  });
});

describe('isRoleAddress', () => {
  it.each(['info', 'Support', 'postmaster', 'abuse', 'webmaster', 'sales+leads', 'no-reply'])(
    'flags %s',
    (local) => {
      expect(isRoleAddress(local)).toBe(true);
    },
  );

  it.each(['john', 'jane.doe', 'infos-team-lead', ''])('does not flag %j', (local) => {
    expect(isRoleAddress(local)).toBe(false);
  });
});

describe('readList', () => {
  it('skips comments and blank lines and lowercases entries', () => {
    expect([...readList('# note\n\nOne.com\r\n two.org \n')]).toEqual(['one.com', 'two.org']);
  });
});

describe('the snapshots', () => {
  it('record where they came from', async () => {
    const { readFile } = await import('node:fs/promises');
    const disposable = await readFile(
      new URL('../data/disposable-domains.txt', import.meta.url),
      'utf8',
    );
    expect(disposable).toMatch(/^# Commit: [0-9a-f]{40} /m);
    expect(disposable).toMatch(/^# Licence: CC0 1\.0 Universal/m);
    const roles = await readFile(new URL('../data/role-addresses.txt', import.meta.url), 'utf8');
    expect(roles).toMatch(/^# Copyright \(c\) 2015 Mixmax, Inc$/m);
  });
});
