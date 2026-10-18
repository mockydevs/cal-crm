import { describe, expect, it } from 'vitest';
import { connectMailboxInput, mailboxConnectionAttempt, permissionsOf } from './index.js';

const server = {
  host: 'mail.example.test',
  port: 465,
  security: 'tls',
  username: 'person@example.test',
  password: '  fixture password  ',
};
const input = {
  name: 'Work',
  email: 'person@example.test',
  displayName: 'Person',
  smtp: server,
  imap: { ...server, port: 993 },
};

describe('mailbox connection contract', () => {
  it('keeps password whitespace and requires both authenticated protocols', () => {
    expect(connectMailboxInput.parse(input).smtp.password).toBe(server.password);
    const { imap: _imap, ...smtpOnly } = input;
    expect(connectMailboxInput.safeParse(smtpOnly).success).toBe(false);
  });

  it.each([
    { ...input, smtp: { ...server, security: 'none' } },
    { ...input, smtp: { ...server, port: 0 } },
    { ...input, smtp: { ...server, port: 65_536 } },
    { ...input, smtp: { ...server, password: '' } },
    { ...input, smtp: { ...server, rejectUnauthorized: false } },
    { ...input, allowedPrivateHosts: ['localhost'] },
    { ...input, businessId: 'foreign-business' },
    { ...input, email: 'not-an-address' },
  ])('rejects invalid settings and request-controlled security bypasses %#', (value) => {
    expect(connectMailboxInput.safeParse(value).success).toBe(false);
  });

  it('does not permit secret fields in an attempt response', () => {
    expect(
      mailboxConnectionAttempt.safeParse({
        id: 'mtry_01h455vb4pex5vsknk084sn02q',
        status: 'pending',
        mailboxId: null,
        result: null,
        createdAt: '2026-10-09T01:00:00.000Z',
        password: server.password,
      }).success,
    ).toBe(false);
  });

  it('reserves mailbox management for owners/admins or explicitly granted custom roles', () => {
    for (const scope of ['agency', 'business'] as const) {
      for (const key of ['owner', 'admin']) {
        expect(
          permissionsOf({ scope, key, isBuiltin: true, permissions: [] }, 'business').has(
            'mailboxes.manage',
          ),
        ).toBe(true);
      }
      expect(
        permissionsOf({ scope, key: 'member', isBuiltin: true, permissions: [] }, 'business').has(
          'mailboxes.manage',
        ),
      ).toBe(false);
    }
    expect(
      permissionsOf(
        { scope: 'business', key: 'viewer', isBuiltin: true, permissions: [] },
        'business',
      ).has('mailboxes.manage'),
    ).toBe(false);
  });
});
