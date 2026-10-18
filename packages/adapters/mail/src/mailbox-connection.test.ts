import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { createMailboxConnector } from './index.js';

const settings = {
  host: '127.0.0.1',
  port: 993,
  security: 'tls' as const,
  username: 'fixture@example.test',
  password: 'fixture-only-password',
};

describe('mailbox connection network boundary', () => {
  it('refuses delivery to loopback with a safe error and no credentials or message body', async () => {
    const error = await createMailboxConnector()
      .send(
        settings,
        { address: 'sender@example.test', name: 'Fixture' },
        { to: 'person@example.test', subject: 'Sign in', text: 'secret-fixture-link' },
      )
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'MailboxDeliveryError', code: 'private_address' });
    expect(String(error)).not.toContain(settings.password);
    expect(String(error)).not.toContain('secret-fixture-link');
  });
  it('refuses loopback SMTP and IMAP targets before sending credentials', async () => {
    const result = await createMailboxConnector().verify({ smtp: settings, imap: settings });
    expect(result).toEqual({
      smtp: { status: 'fail', code: 'private_address', port: 993 },
      imap: { status: 'fail', code: 'private_address', port: 993 },
    });
    expect(JSON.stringify(result)).not.toContain(settings.password);
    expect(JSON.stringify(result)).not.toContain(settings.username);
  });

  it.each([
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('refuses non-public address %s', async (host) => {
    const login = { ...settings, host };
    const result = await createMailboxConnector().verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('private_address');
    expect(result.imap.code).toBe('private_address');
  });

  it.each([
    ['8.8.8.8', '10.0.0.1'],
    ['2001:4860:4860::8888', '::ffff:169.254.169.254'],
  ])('refuses every mixed public/private DNS answer: %j', async (...addresses) => {
    const login = { ...settings, host: 'mail.example.test' };
    const resolve = vi.fn(() => Promise.resolve(addresses));
    const result = await createMailboxConnector({ resolve }).verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('private_address');
    expect(result.imap.code).toBe('private_address');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it.each([[], ['not-an-ip']])('reports invalid DNS answers: %j', async (...addresses) => {
    const login = { ...settings, host: 'mail.example.test' };
    const result = await createMailboxConnector({
      resolve: () => Promise.resolve(addresses),
    }).verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('dns');
    expect(result.imap.code).toBe('dns');
  });

  it('reports resolver failures without exposing provider errors', async () => {
    const login = { ...settings, host: 'mail.example.test' };
    const result = await createMailboxConnector({
      resolve: () => Promise.reject(new Error('Private upstream DNS detail')),
    }).verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('dns');
    expect(result.imap.code).toBe('dns');
    expect(JSON.stringify(result)).not.toContain('Private upstream');
  });

  it('bounds DNS resolution time', async () => {
    const login = { ...settings, host: 'mail.example.test' };
    const result = await createMailboxConnector({
      timeoutMs: 20,
      resolve: () => new Promise(() => undefined),
    }).verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('timeout');
    expect(result.imap.code).toBe('timeout');
  });

  it('checks operating-system DNS answers when no custom resolver is configured', async () => {
    const login = { ...settings, host: 'localhost' };
    const result = await createMailboxConnector().verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('private_address');
    expect(result.imap.code).toBe('private_address');
  });

  it.each([
    '',
    'https://mail.example.test',
    'mail..example.test',
    '-mail.example.test',
    'mail.-example.test',
  ])('refuses invalid hostname %j without resolving it', async (host) => {
    const resolve = vi.fn(() => Promise.resolve(['127.0.0.1']));
    const login = { ...settings, host };
    const result = await createMailboxConnector({ resolve }).verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('invalid_host');
    expect(result.imap.code).toBe('invalid_host');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('normalizes the name and does not allow suffix matches for private-host exceptions', async () => {
    const login = { ...settings, host: 'PRIVATE.EXAMPLE.TEST.' };
    const resolve = vi.fn(() => Promise.resolve(['127.0.0.1']));
    const result = await createMailboxConnector({
      resolve,
      allowedPrivateHosts: ['example.test'],
    }).verify({ smtp: login, imap: login });
    expect(result.smtp.code).toBe('private_address');
    expect(resolve).toHaveBeenCalledWith('private.example.test');
  });

  it.each(['tls', 'starttls'] as const)(
    'bounds a stalled %s connection even for a trusted private host',
    async (security) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('Missing test port.');
        const login = { ...settings, port: address.port, security };
        const result = await createMailboxConnector({
          allowedPrivateHosts: ['127.0.0.1'],
          timeoutMs: 100,
        }).verify({ smtp: login, imap: login });
        expect(result.smtp.code).toBe('timeout');
        expect(result.imap.code).toBe('timeout');
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
      }
    },
  );

  it.each([0, -1, 30_001, 1.5, Number.NaN])('refuses invalid install timeout %s', (timeoutMs) => {
    expect(() => createMailboxConnector({ timeoutMs })).toThrow(RangeError);
  });
});
