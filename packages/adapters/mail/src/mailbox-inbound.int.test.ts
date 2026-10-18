import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { startGreenMail, type GreenMailServer } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createMailboxConnector } from './index.js';
import { startProbeImapPeer } from '../test/probe-imap-peer.js';

let server: GreenMailServer;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ server, stop } = await startGreenMail());
});
afterAll(async () => {
  await stop?.();
});

const login = () => ({
  host: 'localhost',
  port: server.imapPort,
  security: 'tls' as const,
  username: server.username,
  password: server.password,
});
const reader = (timeoutMs = 30_000) =>
  createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
    timeoutMs,
  });

async function withImap<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: server.address,
    port: server.imapPort,
    secure: true,
    servername: 'localhost',
    tls: { ca: server.ca, rejectUnauthorized: true },
    auth: { user: server.username, pass: server.password },
    logger: false,
    disableAutoIdle: true,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.close();
  }
}

beforeEach(async () => {
  await withImap(async (client) => {
    await client.mailboxOpen('INBOX');
    await client.messageDelete('1:*', { uid: true });
  });
});

const raw = (body = 'Private inbound body') =>
  Buffer.from(
    `From: Sender <sender@example.test>\r\nTo: fixture@localhost\r\nMessage-ID: <${randomUUID()}@example.test>\r\nSubject: Inbound fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
  );

async function append(sources: readonly Buffer[]): Promise<void> {
  await withImap(async (client) => {
    for (const source of sources) expect(await client.append('INBOX', source)).not.toBe(false);
  });
}

it('reads INBOX over verified TLS without marking mail seen and resumes after the exact UID', async () => {
  const empty = await reader().readInbox(login(), null);
  expect(empty.messages).toEqual([]);
  const sources = [raw('First'), raw('Second')];
  await append(sources);
  const first = await reader().readInbox(login(), empty.cursor);
  expect(first.messages.map((message) => message.source)).toEqual(sources);
  expect(first.messages.map((message) => message.outcome)).toEqual(['source', 'source']);
  expect(first.cursor.uidValidity).toMatch(/^[1-9][0-9]*$/);
  expect(first.cursor.lastUid).toBeGreaterThan(0);
  const repeated = await reader().readInbox(login(), first.cursor);
  expect(repeated.messages).toEqual([]);
  expect(repeated.cursor).toEqual(first.cursor);
  const next = raw('Third');
  await append([next]);
  const second = await reader().readInbox(login(), first.cursor);
  expect(second.messages.map((message) => message.source)).toEqual([next]);
  expect(second.cursor.lastUid).toBeGreaterThan(first.cursor.lastUid);
  await withImap(async (client) => {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const messages = await client.fetchAll('1:*', { flags: true });
      expect(messages.every((message) => !message.flags?.has('\\Seen'))).toBe(true);
    } finally {
      lock.release();
    }
  });
});

it('starts a fresh UID epoch when UIDVALIDITY changes rather than skipping reused UIDs', async () => {
  const source = raw();
  await append([source]);
  const result = await reader().readInbox(login(), {
    uidValidity: '4294967295',
    lastUid: 4294967295,
  });
  expect(result.cursor.uidValidity).not.toBe('4294967295');
  expect(result.messages.map((message) => message.source)).toEqual([source]);
});

it('captures the current end on connection, skips history and retains mail before the first poll', async () => {
  const history = raw('Before connecting');
  await append([history]);
  const baseline = await reader().readInbox(login(), null);
  expect(baseline.messages).toEqual([]);
  expect(baseline.cursor.lastUid).toBeGreaterThan(0);
  const arriving = raw('After connecting, before the first scheduled poll');
  await append([arriving]);
  const first = await reader().readInbox(login(), baseline.cursor);
  expect(first.messages.map((message) => message.source)).toEqual([arriving]);
  expect((await reader().readInbox(login(), first.cursor)).messages).toEqual([]);
});

it('preserves the IMAP receipt date separately from the untrusted message header', async () => {
  const baseline = await reader().readInbox(login(), null);
  const internalDate = new Date('2026-09-30T08:12:00Z');
  const source = Buffer.from('Date: not-a-date\r\n' + raw().toString('utf8'));
  await withImap(async (client) => {
    expect(await client.append('INBOX', source, [], internalDate)).not.toBe(false);
  });
  const result = await reader().readInbox(login(), baseline.cursor);
  expect(result.messages).toEqual([
    expect.objectContaining({ outcome: 'source', source, internalDate }),
  ]);
});

it('bounds each source and reports oversized mail while allowing the following message through', async () => {
  const baseline = await reader().readInbox(login(), null);
  const oversized = raw('x'.repeat(5 * 1024 * 1024));
  const ordinary = raw('After oversized');
  await append([oversized, ordinary]);
  const result = await reader().readInbox(login(), baseline.cursor);
  expect(result.messages).toHaveLength(2);
  expect(result.messages[0]).toMatchObject({ outcome: 'refused', reason: 'message_too_large' });
  expect(result.messages[0]).not.toHaveProperty('source');
  expect(result.messages[1]).toMatchObject({ outcome: 'source', source: ordinary });
  expect((await reader().readInbox(login(), result.cursor)).messages).toEqual([]);
});

it('returns at most twenty sources and leaves the remainder available at the next cursor', async () => {
  const baseline = await reader().readInbox(login(), null);
  const sources = Array.from({ length: 21 }, () => raw());
  await append(sources);
  const first = await reader().readInbox(login(), baseline.cursor);
  expect(first.messages.map((message) => message.source)).toEqual(sources.slice(0, 20));
  const second = await reader().readInbox(login(), first.cursor);
  expect(second.messages.map((message) => message.source)).toEqual(sources.slice(20));
  expect((await reader().readInbox(login(), second.cursor)).messages).toEqual([]);
});

it('makes progress through large messages without fetching their whole page in one deadline', async () => {
  const baseline = await reader().readInbox(login(), null);
  const sources = [
    raw('a'.repeat(4 * 1024 * 1024 + 512 * 1024)),
    raw('b'.repeat(4 * 1024 * 1024 + 512 * 1024)),
  ];
  await append(sources);
  const first = await reader().readInbox(login(), baseline.cursor);
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]?.source?.equals(sources[0] ?? Buffer.alloc(0))).toBe(true);
  const second = await reader().readInbox(login(), first.cursor);
  expect(second.messages).toHaveLength(1);
  expect(second.messages[0]?.source?.equals(sources[1] ?? Buffer.alloc(0))).toBe(true);
  expect((await reader().readInbox(login(), second.cursor)).messages).toEqual([]);
});

it.each(['missing_source', 'missing_size', 'oversize'] as const)(
  'retries an incomplete source without consuming its UID (%s)',
  async (scenario) => {
    const peer = await startProbeImapPeer(server.tlsContext, scenario);
    try {
      const cursor = { uidValidity: '1', lastUid: 0 };
      const settings = { ...login(), port: peer.port };
      await expect(reader().readInbox(settings, cursor)).rejects.toMatchObject({
        code: 'connection',
        message: 'Mail delivery failed (connection).',
      });
      peer.recoverSource();
      const retried = await reader().readInbox(settings, cursor);
      expect(retried.cursor).toEqual({ uidValidity: '1', lastUid: 1 });
      expect(retried.messages).toEqual([
        {
          outcome: 'source',
          uid: 1,
          internalDate: null,
          source: Buffer.from(
            'From: fixture@localhost\r\nSubject: Fixture\r\n\r\nFixture body.\r\n',
          ),
        },
      ]);
    } finally {
      await peer.stop();
    }
  },
);

it('retains a completed prefix at the deadline and retries the stalled UID on the next read', async () => {
  const peer = await startProbeImapPeer(server.tlsContext, 'stalled_second_source');
  try {
    const settings = { ...login(), port: peer.port };
    const first = await reader(2_000).readInbox(settings, { uidValidity: '1', lastUid: 0 });
    expect(first.cursor).toEqual({ uidValidity: '1', lastUid: 1 });
    expect(first.messages.map((message) => message.uid)).toEqual([1]);
    expect(first.messages[0]).toMatchObject({ outcome: 'source' });
    peer.recoverSource();
    const second = await reader(2_000).readInbox(settings, first.cursor);
    expect(second.cursor).toEqual({ uidValidity: '1', lastUid: 2 });
    expect(second.messages.map((message) => message.uid)).toEqual([2]);
    expect(second.messages[0]).toMatchObject({ outcome: 'source' });
  } finally {
    await peer.stop();
  }
});

it.each(['missing_uid_next', 'invalid_uid_next'] as const)(
  'rejects unusable mailbox UID metadata without returning a baseline (%s)',
  async (scenario) => {
    const peer = await startProbeImapPeer(server.tlsContext, scenario);
    try {
      await expect(reader().readInbox({ ...login(), port: peer.port }, null)).rejects.toMatchObject(
        {
          code: 'connection',
          message: 'Mail delivery failed (connection).',
        },
      );
    } finally {
      await peer.stop();
    }
  },
);

it('accepts a complete bounded source when the peer underreports its metadata size', async () => {
  const peer = await startProbeImapPeer(server.tlsContext, 'underreported_size');
  try {
    const result = await reader().readInbox(
      { ...login(), port: peer.port },
      { uidValidity: '1', lastUid: 0 },
    );
    expect(result.messages).toEqual([
      {
        outcome: 'source',
        uid: 1,
        source: Buffer.from('From: fixture@localhost\r\nSubject: Fixture\r\n\r\nFixture body.\r\n'),
        internalDate: null,
      },
    ]);
  } finally {
    await peer.stop();
  }
});

it('refuses untrusted certificates, bad credentials and private DNS with safe errors', async () => {
  await expect(
    createMailboxConnector({
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([server.address]),
    }).readInbox(login(), null),
  ).rejects.toMatchObject({ code: 'certificate', message: 'Mail delivery failed (certificate).' });
  await expect(
    reader().readInbox({ ...login(), password: 'private-wrong-password' }, null),
  ).rejects.toMatchObject({
    code: 'authentication',
    message: 'Mail delivery failed (authentication).',
  });
  await expect(
    createMailboxConnector({ resolve: () => Promise.resolve([server.address]) }).readInbox(
      { ...login(), host: 'private.example.test' },
      null,
    ),
  ).rejects.toMatchObject({
    code: 'private_address',
    message: 'Mail delivery failed (private_address).',
  });
});
