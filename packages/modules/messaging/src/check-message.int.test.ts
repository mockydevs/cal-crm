import { startGreenMail, type GreenMailServer } from '@repo/testing';
import { createMailboxConnector } from '@repo/mail';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkSelfMessage } from './index.js';

let server: GreenMailServer;
let stop: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ server, stop } = await startGreenMail());
});
afterAll(async () => {
  await stop?.();
});

it('checks an actual SMTP/IMAP self-copy without exposing raw mail or falsely confirming unsigned DKIM', async () => {
  const probe = createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
  });
  const login = {
    host: 'localhost',
    security: 'tls' as const,
    username: server.username,
    password: server.password,
  };
  const results = await checkSelfMessage(
    probe,
    {
      email: 'fixture@localhost',
      smtp: { ...login, port: server.smtpPort },
      imap: { ...login, port: server.imapPort },
    },
    () => Promise.reject(Object.assign(new Error('No fixture DNS record.'), { code: 'ENOTFOUND' })),
  );
  expect(results).toHaveLength(4);
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: 'dkim',
        status: 'could_not_check',
        reason: 'unsigned_local_copy',
      }),
      expect.objectContaining({
        key: 'encryption',
        status: 'could_not_check',
        reason: 'receiving_hop_not_observed',
      }),
      expect.objectContaining({ key: 'unsubscribe', status: 'not_applicable' }),
    ]),
  );
  expect(JSON.stringify(results)).not.toContain('Mailbox setup check');
  expect(JSON.stringify(results)).not.toContain('fixture@localhost');
  expect(JSON.stringify(results)).not.toContain(server.password);
});
