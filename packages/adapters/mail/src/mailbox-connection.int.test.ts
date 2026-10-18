import { startGreenMail, startTlsMailpit, mailbox, type GreenMailServer } from '@repo/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createMailboxConnector, type MailServerLogin } from './index.js';
import { ImapFlow } from 'imapflow';
import { startTlsPeer } from '../test/starttls-peer.js';
import { startProbeImapPeer } from '../test/probe-imap-peer.js';

let server: GreenMailServer;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ server, stop } = await startGreenMail());
});
afterAll(async () => {
  await stop?.();
});

function settings(): { smtp: MailServerLogin; imap: MailServerLogin } {
  const login = {
    host: 'localhost',
    security: 'tls' as const,
    username: server.username,
    password: server.password,
  };
  return { smtp: { ...login, port: server.smtpPort }, imap: { ...login, port: server.imapPort } };
}

it('returns a safe submission receipt after actual TLS SMTP acceptance', async () => {
  const fixture = await startTlsMailpit();
  try {
    const connector = createMailboxConnector({
      ca: fixture.server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([fixture.server.address]),
    });
    const login = {
      host: 'localhost',
      port: fixture.server.smtpPort,
      security: 'tls' as const,
      username: fixture.server.username,
      password: fixture.server.password,
    };
    const messageId = '<crm-outbound.fixture@crm.invalid>';
    // A runtime caller may carry extra fields even though the typed port exposes none.
    const message = {
      messageId,
      to: 'recipient@example.test',
      subject: 'Outbound receipt',
      text: 'Body',
      headers: {
        'List-Unsubscribe': '<https://attacker.example.test>',
        'X-Injected': 'must-not-be-sent',
      },
    };
    expect(
      await connector.submit(login, { address: 'sender@example.test', name: 'Fixture' }, message),
    ).toEqual({ outcome: 'accepted', messageId });
    expect(await mailbox(fixture.server).messagesTo('recipient@example.test')).toMatchObject([
      { subject: 'Outbound receipt', text: 'Body\r\n' },
    ]);
    const [captured] = await mailbox(fixture.server).messagesTo('recipient@example.test');
    const rawResponse = await fetch(
      `${fixture.server.apiUrl}/api/v1/message/${captured?.id ?? ''}/raw`,
    );
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).not.toMatch(
      /^List-Unsubscribe:|^X-Injected:|^Auto-Submitted:/im,
    );
  } finally {
    await fixture.stop();
  }
});

it("marks a program's mail Auto-Submitted: auto-generated (RFC 3834) beside one-click unsubscribe", async () => {
  const fixture = await startTlsMailpit();
  try {
    const connector = createMailboxConnector({
      ca: fixture.server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([fixture.server.address]),
    });
    const login = {
      host: 'localhost',
      port: fixture.server.smtpPort,
      security: 'tls' as const,
      username: fixture.server.username,
      password: fixture.server.password,
    };
    const from = { address: 'sender@example.test', name: 'Fixture' };
    for (const [to, extra] of [
      ['auto@example.test', { autoSubmitted: true }],
      [
        'both@example.test',
        { autoSubmitted: true, unsubscribeUrl: 'https://crm.example.test/unsubscribe/t' },
      ],
    ] as const)
      expect(
        await connector.submit(login, from, {
          messageId: `<crm-outbound.${to}@crm.invalid>`,
          to,
          subject: 'Workflow',
          text: 'Body',
          ...extra,
        }),
      ).toMatchObject({ outcome: 'accepted' });
    const raw = async (to: string) => {
      const [captured] = await mailbox(fixture.server).messagesTo(to);
      return (
        await fetch(`${fixture.server.apiUrl}/api/v1/message/${captured?.id ?? ''}/raw`)
      ).text();
    };
    const auto = await raw('auto@example.test');
    expect(auto).toMatch(/^Auto-Submitted: auto-generated\r?$/im);
    expect(auto).not.toMatch(/^List-Unsubscribe:/im);
    const both = await raw('both@example.test');
    expect(both).toMatch(/^Auto-Submitted: auto-generated\r?$/im);
    expect(both).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r?$/im);
  } finally {
    await fixture.stop();
  }
});

it('names where answers go when the sender gives a reply address', async () => {
  const fixture = await startTlsMailpit();
  try {
    const connector = createMailboxConnector({
      ca: fixture.server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([fixture.server.address]),
    });
    const login = {
      host: 'localhost',
      port: fixture.server.smtpPort,
      security: 'tls' as const,
      username: fixture.server.username,
      password: fixture.server.password,
    };
    expect(
      await connector.submit(
        login,
        { address: 'sender@example.test', name: 'Fixture' },
        {
          messageId: '<crm-reply-to.fixture@crm.invalid>',
          to: 'reader@example.test',
          subject: 'Campaign',
          text: 'Body',
          replyTo: 'answers@example.test',
        },
      ),
    ).toMatchObject({ outcome: 'accepted' });
    const [captured] = await mailbox(fixture.server).messagesTo('reader@example.test');
    const raw = await fetch(`${fixture.server.apiUrl}/api/v1/message/${captured?.id ?? ''}/raw`);
    expect(await raw.text()).toMatch(/^Reply-To: answers@example\.test\r?$/im);
  } finally {
    await fixture.stop();
  }
});

it('sends to Cc and Bcc as addresses only, and to nobody a message does not name', async () => {
  const fixture = await startTlsMailpit();
  try {
    const connector = createMailboxConnector({
      ca: fixture.server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([fixture.server.address]),
    });
    const login = {
      host: 'localhost',
      port: fixture.server.smtpPort,
      security: 'tls' as const,
      username: fixture.server.username,
      password: fixture.server.password,
    };
    const message = {
      messageId: '<crm-copies.fixture@crm.invalid>',
      to: 'reader@example.test',
      subject: 'Workflow',
      text: 'Body',
    };
    expect(
      await connector.submit(
        login,
        { address: 'sender@example.test', name: 'Fixture' },
        {
          ...message,
          cc: ['team@example.test', 'second@example.test'],
          bcc: ['archive@example.test'],
        },
      ),
    ).toMatchObject({ outcome: 'accepted' });
    const [captured] = await mailbox(fixture.server).messagesTo('reader@example.test');
    const accepted = (await (
      await fetch(`${fixture.server.apiUrl}/api/v1/message/${captured?.id ?? ''}`)
    ).json()) as { Cc?: { Address: string }[]; Bcc?: { Address: string }[] };
    expect(accepted.Cc?.map((each) => each.Address)).toEqual([
      'team@example.test',
      'second@example.test',
    ]);
    expect(accepted.Bcc?.map((each) => each.Address)).toEqual(['archive@example.test']);
    const raw = await fetch(`${fixture.server.apiUrl}/api/v1/message/${captured?.id ?? ''}/raw`);
    expect(await raw.text()).toMatch(/^Cc: team@example\.test, second@example\.test\r?$/im);
    // A message with no copies is still for one recipient, and one alone.
    expect(
      await connector.submit(
        login,
        { address: 'sender@example.test', name: 'Fixture' },
        { ...message, messageId: '<crm-single.fixture@crm.invalid>', to: 'single@example.test' },
      ),
    ).toMatchObject({ outcome: 'accepted' });
    expect(await mailbox(fixture.server).messagesTo('single@example.test')).toHaveLength(1);
  } finally {
    await fixture.stop();
  }
});

it('writes a reply into its thread, and never lets a received id write a header of its own', async () => {
  const fixture = await startTlsMailpit();
  try {
    const connector = createMailboxConnector({
      ca: fixture.server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([fixture.server.address]),
    });
    const login = {
      host: 'localhost',
      port: fixture.server.smtpPort,
      security: 'tls' as const,
      username: fixture.server.username,
      password: fixture.server.password,
    };
    const from = { address: 'sender@example.test', name: 'Fixture' };
    const headersOf = async (recipient: string) => {
      const [captured] = await mailbox(fixture.server).messagesTo(recipient);
      const response = await fetch(
        `${fixture.server.apiUrl}/api/v1/message/${captured?.id ?? ''}/raw`,
      );
      expect(response.status).toBe(200);
      const raw = await response.text();
      // The header block, unfolded: one line a header.
      return raw
        .slice(0, raw.search(/\r?\n\r?\n/))
        .replace(/\r?\n[ \t]+/g, ' ')
        .split(/\r?\n/);
    };
    const valuesOf = (headers: readonly string[], name: string) =>
      headers.filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));

    const thread = Array.from(
      { length: 12 },
      (_, index) => `<thread-${String(index)}.CAL+x=y_z@mail.example.test>`,
    );
    const parent = '<parent.$1@[192.0.2.1]>';
    expect(
      await connector.submit(login, from, {
        messageId: '<crm-outbound.threaded@crm.invalid>',
        to: 'threaded@example.test',
        subject: 'Re: Thread',
        text: 'Body',
        reply: { inReplyTo: parent, references: [...thread, parent] },
      }),
    ).toEqual({ outcome: 'accepted', messageId: '<crm-outbound.threaded@crm.invalid>' });
    const threaded = await headersOf('threaded@example.test');
    expect(valuesOf(threaded, 'In-Reply-To')).toEqual([`In-Reply-To: ${parent}`]);
    expect(valuesOf(threaded, 'References')).toEqual([
      `References: ${[...thread, parent].join(' ')}`,
    ]);
    expect(valuesOf(threaded, 'Message-ID')).toEqual([
      'Message-ID: <crm-outbound.threaded@crm.invalid>',
    ]);

    // What a hostile sender could have put in the mail being answered.
    expect(
      await connector.submit(login, from, {
        messageId: '<crm-outbound.hostile@crm.invalid>',
        to: 'hostile@example.test',
        subject: 'Re: Hostile',
        text: 'Body',
        reply: {
          inReplyTo: '<a@b>\r\nBcc: victim@example.test\r\nX-Injected: 1',
          references: [
            '<kept@mail.example.test>',
            '<c@d>\r\nX-Injected: 2',
            '<e@f>\n\nA body of their own',
            'no brackets at all',
            '<two@ids.test> <in@one.test>',
            '<"quoted string"@mail.example.test>',
          ],
        },
      }),
    ).toEqual({ outcome: 'accepted', messageId: '<crm-outbound.hostile@crm.invalid>' });
    const hostile = await headersOf('hostile@example.test');
    expect(valuesOf(hostile, 'In-Reply-To')).toEqual([]);
    expect(valuesOf(hostile, 'References')).toEqual(['References: <kept@mail.example.test>']);
    expect(valuesOf(hostile, 'Bcc')).toEqual([]);
    expect(valuesOf(hostile, 'X-Injected')).toEqual([]);
    expect(hostile.join('\n')).not.toMatch(/victim@example\.test|A body of their own/);
    expect(await mailbox(fixture.server).messagesTo('victim@example.test')).toEqual([]);

    // A message that answers nothing carries neither header.
    await connector.submit(login, from, {
      messageId: '<crm-outbound.first@crm.invalid>',
      to: 'first@example.test',
      subject: 'First',
      text: 'Body',
      reply: { inReplyTo: null, references: [] },
    });
    const first = await headersOf('first@example.test');
    expect(valuesOf(first, 'In-Reply-To')).toEqual([]);
    expect(valuesOf(first, 'References')).toEqual([]);
  } finally {
    await fixture.stop();
  }
});

it.each([
  { reply: 452, expected: { outcome: 'rejected', temporary: true } },
  { reply: 550, expected: { outcome: 'rejected', temporary: false } },
  { reply: 'disconnect', expected: { outcome: 'unknown' } },
] as const)(
  'classifies the complete SMTP DATA outcome $reply without exposing remote response text',
  async ({ reply, expected }) => {
    const peer = await startTlsPeer(
      'smtp',
      server.tlsContext,
      server.username,
      server.password,
      reply,
    );
    try {
      const connector = createMailboxConnector({
        ca: server.ca,
        allowedPrivateHosts: ['localhost'],
        resolve: () => Promise.resolve(['127.0.0.1']),
      });
      const result = await connector.submit(
        { ...settings().smtp, port: peer.port, security: 'starttls' },
        { address: 'fixture@localhost', name: 'Fixture' },
        {
          messageId: '<crm-outbound.fixture@crm.invalid>',
          to: 'fixture@localhost',
          subject: 'Outcome',
          text: 'Private body',
        },
      );
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain('fixture-private-response');
      expect(peer.authentications).toEqual([true]);
    } finally {
      await peer.stop();
    }
  },
);

it('sends through the verified SMTP connection and delivers the complete message', async () => {
  const connector = createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
  });
  await connector.send(
    settings().smtp,
    { address: 'fixture@localhost', name: 'Fixture' },
    {
      to: 'fixture@localhost',
      subject: 'Fixture install sign-in',
      text: 'Fixture link: https://crm.example.test/one-use',
    },
  );
  const client = new ImapFlow({
    host: server.address,
    port: server.imapPort,
    secure: true,
    servername: 'localhost',
    tls: { ca: server.ca, rejectUnauthorized: true },
    auth: { user: server.username, pass: server.password },
    logger: false,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    const message = await client.fetchOne('*', { envelope: true, source: true });
    expect(message && message.envelope?.subject).toBe('Fixture install sign-in');
    expect(message && message.source?.toString()).toContain('https://crm.example.test/one-use');
  } finally {
    client.close();
  }
});

it('sends a unique test only to itself and reads that copy without marking mail seen', async () => {
  const connector = createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
  });
  const first = await connector.probe({ ...settings(), email: 'fixture@localhost' });
  const second = await connector.probe({ ...settings(), email: 'fixture@localhost' });
  expect(first.messageId).not.toBe(second.messageId);
  expect(first.source.toString()).toContain(first.messageId);
  expect(second.source.toString()).toContain(second.messageId);
  expect(second.source.toString()).not.toContain(first.messageId);
  expect(first).toMatchObject({ smtpTls: true, imapTls: true });
  const client = new ImapFlow({
    host: server.address,
    port: server.imapPort,
    secure: true,
    servername: 'localhost',
    tls: { ca: server.ca, rejectUnauthorized: true },
    auth: { user: server.username, pass: server.password },
    logger: false,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    const ids = await client.search(
      { header: { 'message-id': first.messageId }, seen: false },
      { uid: true },
    );
    expect(ids && ids.length).toBe(1);
  } finally {
    client.close();
  }
});

it.each([
  ['duplicate', 'ambiguous_copy'],
  ['missing_source', 'read_failed'],
  ['oversize', 'too_large'],
  ['oversize_literal', 'connection'],
] as const)('refuses an IMAP peer returning %s with a safe %s error', async (scenario, code) => {
  const peer = await startProbeImapPeer(server.tlsContext, scenario);
  try {
    const login = settings();
    await expect(
      createMailboxConnector({
        ca: server.ca,
        allowedPrivateHosts: ['localhost'],
        resolve: () => Promise.resolve([server.address]),
      }).probe({ ...login, email: 'fixture@localhost', imap: { ...login.imap, port: peer.port } }),
    ).rejects.toMatchObject({ code, message: `Mailbox test is unavailable (${code}).` });
  } finally {
    await peer.stop();
  }
});

it('polls for a delayed self-copy without concurrent IMAP commands', async () => {
  const peer = await startProbeImapPeer(server.tlsContext, 'delayed');
  try {
    const login = settings();
    const result = await createMailboxConnector({
      ca: server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([server.address]),
    }).probe({ ...login, email: 'fixture@localhost', imap: { ...login.imap, port: peer.port } });
    expect(result.source.toString()).toContain('Fixture body.');
    expect(peer.searches).toBe(2);
  } finally {
    await peer.stop();
  }
});

it('stops waiting for a missing self-copy at the overall deadline', async () => {
  const peer = await startProbeImapPeer(server.tlsContext, 'missing');
  try {
    const login = settings();
    await expect(
      createMailboxConnector({
        ca: server.ca,
        allowedPrivateHosts: ['localhost'],
        resolve: () => Promise.resolve([server.address]),
        timeoutMs: 1000,
      }).probe({ ...login, email: 'fixture@localhost', imap: { ...login.imap, port: peer.port } }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(peer.searches).toBeGreaterThan(0);
  } finally {
    await peer.stop();
  }
});

it('upgrades both protocols to verified TLS before authenticating', async () => {
  const smtp = await startTlsPeer('smtp', server.tlsContext, server.username, server.password);
  const imap = await startTlsPeer('imap', server.tlsContext, server.username, server.password);
  try {
    const login = settings();
    login.smtp = { ...login.smtp, security: 'starttls', port: smtp.port };
    login.imap = { ...login.imap, security: 'starttls', port: imap.port };
    const result = await createMailboxConnector({
      ca: server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve(['127.0.0.1']),
      timeoutMs: 2000,
    }).verify(login);
    expect(result).toEqual({
      smtp: { status: 'pass', code: 'connected', port: smtp.port },
      imap: { status: 'pass', code: 'connected', port: imap.port },
    });
    expect(smtp.authentications).toEqual([true]);
    expect(imap.authentications).toEqual([true]);
  } finally {
    await Promise.all([smtp.stop(), imap.stop()]);
  }
});

it('names an untrusted STARTTLS certificate and sends no authentication', async () => {
  const smtp = await startTlsPeer('smtp', server.tlsContext, server.username, server.password);
  const imap = await startTlsPeer('imap', server.tlsContext, server.username, server.password);
  try {
    const login = settings();
    login.smtp = { ...login.smtp, security: 'starttls', port: smtp.port };
    login.imap = { ...login.imap, security: 'starttls', port: imap.port };
    const result = await createMailboxConnector({
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve(['127.0.0.1']),
      timeoutMs: 2000,
    }).verify(login);
    expect(result.smtp.code).toBe('certificate');
    expect(result.imap.code).toBe('certificate');
    expect(smtp.authentications).toEqual([]);
    expect(imap.authentications).toEqual([]);
  } finally {
    await Promise.all([smtp.stop(), imap.stop()]);
  }
});

it('authenticates both SMTP and IMAP with the trusted local server certificate', async () => {
  const resolve = vi.fn(() => Promise.resolve([server.address]));
  const result = await createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve,
  }).verify(settings());
  expect(result).toEqual({
    smtp: { status: 'pass', code: 'connected', port: server.smtpPort },
    imap: { status: 'pass', code: 'connected', port: server.imapPort },
  });
  expect(resolve).toHaveBeenCalledTimes(2);
});

it.each(['smtp', 'imap'] as const)(
  'reports a wrong %s password while preserving the other successful sign-in',
  async (protocol) => {
    const login = settings();
    login[protocol] = { ...login[protocol], password: 'deliberately-wrong-fixture-password' };
    const result = await createMailboxConnector({
      ca: server.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([server.address]),
    }).verify(login);
    const other = protocol === 'smtp' ? 'imap' : 'smtp';
    expect(result[protocol]).toEqual({
      status: 'fail',
      code: 'authentication',
      port: login[protocol].port,
    });
    expect(result[other]).toEqual({ status: 'pass', code: 'connected', port: login[other].port });
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain(server.username);
  },
);

it('rejects the test server certificate when its CA is not trusted', async () => {
  const result = await createMailboxConnector({
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
  }).verify(settings());
  expect(result.smtp.code).toBe('certificate');
  expect(result.imap.code).toBe('certificate');
});

it('rejects a trusted certificate belonging to a different hostname', async () => {
  const login = settings();
  login.smtp = { ...login.smtp, host: 'different.example.test' };
  login.imap = { ...login.imap, host: 'different.example.test' };
  const result = await createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['different.example.test'],
    resolve: () => Promise.resolve([server.address]),
  }).verify(login);
  expect(result.smtp.code).toBe('certificate');
  expect(result.imap.code).toBe('certificate');
});

it('refuses STARTTLS on real peers that support only implicit TLS', async () => {
  const login = settings();
  login.smtp = { ...login.smtp, security: 'starttls', port: server.smtpStarttlsPort };
  login.imap = { ...login.imap, security: 'starttls', port: server.imapStarttlsPort };
  const result = await createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
  }).verify(login);
  expect(result.smtp).toEqual({
    status: 'fail',
    code: 'tls_required',
    port: server.smtpStarttlsPort,
  });
  expect(result.imap).toEqual({
    status: 'fail',
    code: 'tls_required',
    port: server.imapStarttlsPort,
  });
});
