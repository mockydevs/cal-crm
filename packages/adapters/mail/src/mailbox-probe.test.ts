import { expect, it } from 'vitest';
import { createMailboxConnector } from './index.js';

const settings = {
  email: 'sender@example.com',
  smtp: {
    host: 'smtp.example.com',
    port: 465,
    security: 'tls' as const,
    username: 'fixture-user',
    password: 'fixture-secret',
  },
  imap: {
    host: 'imap.example.com',
    port: 993,
    security: 'tls' as const,
    username: 'fixture-user',
    password: 'fixture-secret',
  },
};

it('refuses private addresses before authenticating or sending a self-test', async () => {
  const probe = createMailboxConnector({ resolve: () => Promise.resolve(['127.0.0.1']) });
  await expect(probe.probe(settings)).rejects.toMatchObject({
    code: 'private_address',
    message: 'Mailbox test is unavailable (private_address).',
  });
});

it('bounds the whole probe when DNS never resolves', async () => {
  const probe = createMailboxConnector({
    timeoutMs: 15,
    resolve: () => new Promise(() => undefined),
  });
  await expect(probe.probe(settings)).rejects.toMatchObject({ code: 'timeout' });
});

it.each([
  'other@example.com\r\nBcc: stranger@example.net',
  'a@example.com, b@example.com',
  'no-at-sign',
  'a,b@example.com',
  'a;hidden@example.com',
])('refuses an invalid self-address %s', async (email) => {
  await expect(createMailboxConnector().probe({ ...settings, email })).rejects.toMatchObject({
    code: 'invalid_address',
  });
});

it('never returns raw resolver error text or credentials in a probe failure', async () => {
  const probe = createMailboxConnector({
    resolve: () => Promise.reject(new Error('fixture-user fixture-secret resolver details')),
  });
  const failure: unknown = await probe.probe(settings).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'dns', message: 'Mailbox test is unavailable (dns).' });
  expect(failure).not.toHaveProperty('cause');
  expect(JSON.stringify(failure)).not.toContain('fixture-secret');
});
