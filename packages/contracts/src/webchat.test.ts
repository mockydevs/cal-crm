import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEBCHAT_SETTINGS,
  WEB_ORIGIN_INPUT,
  publicWebchatConfig,
  publicWebchatEndpoints,
  publicWebchatMessage,
  publicWebchatMessageInput,
  publicWebchatMessages,
  publicWebchatMessagesQuery,
  publicWebchatSession,
  publicWebchatSessionInput,
  WEBCHAT_LIMITS,
  webchatAdminEndpoints,
  webchatMessageText,
  webchatSessionToken,
  webchatWidget,
  webchatWidgetInput,
  webchatWidgetKey,
  webchatWidgetSettings,
} from './webchat.js';

const input = {
  name: 'Main site',
  allowedOrigins: ['https://Example.com/', 'https://example.com', 'https://www.example.com'],
  enabled: true,
  settings: DEFAULT_WEBCHAT_SETTINGS,
};

describe('WEB_ORIGIN_INPUT', () => {
  // The first check only. The stored form, and what has none (plain HTTP off loopback, a
  // trailing dot, a bad port), is canonicalWebOrigin's in the messaging module.
  it.each([
    'https://example.com',
    'https://example.com/',
    'HTTPS://Example.COM',
    'https://example.com:8443',
    'https://bücher.example',
    'http://localhost:4173',
    'http://[::1]:3000',
  ])('takes %s', (origin) => {
    expect(WEB_ORIGIN_INPUT.test(origin)).toBe(true);
  });

  it.each([
    ['a path', 'https://example.com/chat'],
    ['a second slash', 'https://example.com//'],
    ['a query', 'https://example.com?x=1'],
    ['an empty query', 'https://example.com/?'],
    ['a fragment', 'https://example.com#x'],
    ['user information that hides the host', 'https://example.com@evil.test'],
    ['a user and password', 'https://user:secret@example.com'],
    ['a backslash a parser reads as a slash', 'https://example.com\\@evil.test'],
    ['a wildcard', 'https://*.example.com'],
    ['a wildcard for everything', '*'],
    ['a leading space', ' https://example.com'],
    ['a trailing space', 'https://example.com '],
    ['a space in the host', 'https://exa mple.com'],
    ['a line break a parser would drop', 'https://exam\nple.com'],
    ['a trailing line break', 'https://example.com\n'],
    ['a tab a parser would drop', 'https://exam\tple.com'],
    ['a NUL', 'https://example.com\u0000'],
    ['a delete character', 'https://example.com\u007f'],
    ['a control character past ASCII', 'https://exam\u0085ple.com'],
    ['a space that is not the ASCII one', 'https://exam ple.com'],
    ['a line separator', 'https://example.com '],
    ['a percent escape a parser would decode', 'https://ex%61mple.com'],
    ['another scheme', 'ftp://example.com'],
    ['a script scheme', 'javascript:alert(1)'],
    ['no scheme', 'example.com'],
    ['a scheme-relative address', '//example.com'],
    ['a scheme with no slashes', 'https:example.com'],
    ['a scheme with one slash', 'https:/example.com'],
    ['a scheme with three slashes', 'https:///example.com'],
    ['the opaque origin', 'null'],
    ['nothing', ''],
    ['a scheme alone', 'https://'],
  ])('refuses %s', (_why, origin) => {
    expect(WEB_ORIGIN_INPUT.test(origin)).toBe(false);
  });
});

describe('webchatWidgetInput', () => {
  it('passes websites on as typed, for the server to store canonically', () => {
    expect(webchatWidgetInput.parse(input).allowedOrigins).toEqual(input.allowedOrigins);
  });

  it('refuses a website that is not one exact origin, and says which', () => {
    const result = webchatWidgetInput.safeParse({
      ...input,
      allowedOrigins: ['https://example.com', 'https://*.example.com'],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['allowedOrigins', 1]);
    expect(
      webchatWidgetInput.safeParse({
        ...input,
        allowedOrigins: [`https://${'a'.repeat(250)}.com`],
      }).success,
    ).toBe(false);
  });

  it('refuses more websites than the limit, unknown fields and an empty name', () => {
    const many = Array.from({ length: WEBCHAT_LIMITS.allowedOrigins + 1 }, (_each, index) => {
      return `https://site-${String(index)}.example.com`;
    });
    expect(webchatWidgetInput.safeParse({ ...input, allowedOrigins: many }).success).toBe(false);
    expect(webchatWidgetInput.safeParse({ ...input, allowedOrigins: many.slice(1) }).success).toBe(
      true,
    );
    expect(webchatWidgetInput.safeParse({ ...input, businessId: 'other' }).success).toBe(false);
    expect(webchatWidgetInput.safeParse({ ...input, publicKey: 'a'.repeat(32) }).success).toBe(
      false,
    );
    expect(webchatWidgetInput.safeParse({ ...input, name: '   ' }).success).toBe(false);
  });

  it('bounds every setting and refuses control characters in what visitors read', () => {
    const settings = (change: object) =>
      webchatWidgetSettings.safeParse({ ...DEFAULT_WEBCHAT_SETTINGS, ...change }).success;
    expect(settings({})).toBe(true);
    expect(settings({ title: '' })).toBe(false);
    expect(settings({ title: 'a'.repeat(WEBCHAT_LIMITS.titleLength + 1) })).toBe(false);
    expect(settings({ greeting: '' })).toBe(true);
    expect(settings({ greeting: 'a'.repeat(WEBCHAT_LIMITS.greetingLength + 1) })).toBe(false);
    expect(settings({ greeting: 'two\nlines' })).toBe(false);
    expect(settings({ greeting: 'bell\u0007' })).toBe(false);
    expect(settings({ greeting: 'past ASCII\u009b' })).toBe(false);
    expect(settings({ greeting: 'Karibu. Tunaweza kukusaidiaje? \u{1f44b}' })).toBe(true);
    expect(settings({ marketingConsentWording: '' })).toBe(false);
    expect(settings({ marketingConsentWording: 'Email me news and offers.' })).toBe(true);
    expect(
      settings({ marketingConsentWording: 'a'.repeat(WEBCHAT_LIMITS.consentWordingLength + 1) }),
    ).toBe(false);
    expect(settings({ emailRequired: 'yes' })).toBe(false);
    expect(settings({ accentColor: '#000000' })).toBe(false);
  });

  it('defaults to asking for an email address and to no marketing box', () => {
    expect(DEFAULT_WEBCHAT_SETTINGS).toMatchObject({
      emailRequired: true,
      marketingConsentWording: null,
    });
  });
});

describe('keys and tokens', () => {
  it('takes a widget key of exactly 24 random bytes', () => {
    expect(webchatWidgetKey.safeParse(Buffer.alloc(24, 7).toString('base64url')).success).toBe(
      true,
    );
    for (const key of [
      '',
      'a'.repeat(31),
      'a'.repeat(33),
      `${'a'.repeat(31)}/`,
      `${'a'.repeat(31)}=`,
    ])
      expect(webchatWidgetKey.safeParse(key).success).toBe(false);
  });

  it('takes a session token of exactly 32 random bytes in its one canonical spelling', () => {
    const token = Buffer.alloc(32, 255).toString('base64url');
    expect(webchatSessionToken.safeParse(token).success).toBe(true);
    // The last character of 32 bytes carries two unused bits; a spelling that sets them
    // would be a second name for the same bytes.
    expect(webchatSessionToken.safeParse(`${token.slice(0, 42)}9`).success).toBe(false);
    for (const other of ['', token.slice(1), `${token}A`, `${token.slice(0, 42)}=`, ` ${token}`])
      expect(webchatSessionToken.safeParse(other).success).toBe(false);
  });
});

describe('the public inputs', () => {
  const session = { marketingConsent: false };

  it('normalizes the email address and takes a visitor with no details', () => {
    expect(publicWebchatSessionInput.parse(session)).toEqual(session);
    expect(
      publicWebchatSessionInput.parse({ ...session, name: ' Maya ', email: ' Maya@Example.test ' }),
    ).toEqual({ ...session, name: 'Maya', email: 'maya@example.test' });
  });

  it('never assumes marketing consent', () => {
    expect(publicWebchatSessionInput.safeParse({}).success).toBe(false);
    expect(publicWebchatSessionInput.safeParse({ marketingConsent: 'true' }).success).toBe(false);
    expect(publicWebchatSessionInput.safeParse({ marketingConsent: 1 }).success).toBe(false);
  });

  it('refuses scope, identity and consent proof chosen by the caller', () => {
    for (const forged of [
      { businessId: 'other' },
      { contactId: 'other' },
      { widgetId: 'other' },
      { token: 'chosen' },
      { sessionId: 'chosen' },
      { origin: 'https://example.com' },
      { ipAddress: '203.0.113.1' },
      { phone: '+254712345678' },
    ])
      expect(publicWebchatSessionInput.safeParse({ ...session, ...forged }).success).toBe(false);
  });

  it('bounds the name and the email address, and refuses rather than cuts', () => {
    const parse = (change: object) =>
      publicWebchatSessionInput.safeParse({ ...session, ...change }).success;
    expect(parse({ name: 'a'.repeat(WEBCHAT_LIMITS.nameLength) })).toBe(true);
    expect(parse({ name: 'a'.repeat(WEBCHAT_LIMITS.nameLength + 1) })).toBe(false);
    expect(parse({ name: 'Maya\u0000' })).toBe(false);
    expect(parse({ name: 'Maya\nThompson' })).toBe(false);
    expect(parse({ email: 'not-an-address' })).toBe(false);
    expect(parse({ email: `${'a'.repeat(WEBCHAT_LIMITS.emailLength)}@example.test` })).toBe(false);
  });

  const message = { clientMessageId: '5ef5926d-d3b7-4b95-a513-198a51a2c5d1', text: 'Hello' };

  it('keeps a message exactly as typed, markup and line breaks included', () => {
    const text = '  <b>Hi</b>\n\tsecond line <script>alert(1)</script>  ';
    expect(publicWebchatMessageInput.parse({ ...message, text }).text).toBe(text);
  });

  it('refuses a message that is empty, blank, too long or carries control characters', () => {
    const parse = (text: unknown) => webchatMessageText.safeParse(text).success;
    expect(parse('a'.repeat(WEBCHAT_LIMITS.messageLength))).toBe(true);
    expect(parse('a'.repeat(WEBCHAT_LIMITS.messageLength + 1))).toBe(false);
    expect(parse('')).toBe(false);
    expect(parse(' \n\t ')).toBe(false);
    expect(parse('nul\u0000byte')).toBe(false);
    expect(parse('escape\u001b[31m')).toBe(false);
    expect(parse('delete\u007f')).toBe(false);
    expect(parse('next line\u0085')).toBe(false);
    // Not control characters: other alphabets, emoji and the two line separators people type.
    expect(parse('habari \u{1f44b} مرحبا\r\nsecond\tline')).toBe(true);
    expect(parse(42)).toBe(false);
    expect(parse(['Hello'])).toBe(false);
  });

  it('needs a message id from the widget, and takes no other field', () => {
    expect(publicWebchatMessageInput.safeParse({ text: 'Hello' }).success).toBe(false);
    expect(publicWebchatMessageInput.safeParse({ ...message, clientMessageId: '1' }).success).toBe(
      false,
    );
    for (const forged of [
      { html: '<b>Hello</b>' },
      { from: 'team' },
      { seq: 1 },
      { attachments: [] },
      { sentAt: '2026-10-09T09:00:00Z' },
    ])
      expect(publicWebchatMessageInput.safeParse({ ...message, ...forged }).success).toBe(false);
  });

  it('reads a place from the query string, within bounds', () => {
    expect(publicWebchatMessagesQuery.parse({})).toEqual({ after: 0 });
    expect(publicWebchatMessagesQuery.parse({ after: '12' })).toEqual({ after: 12 });
    for (const after of ['-1', '1.5', 'abc', '2147483648', '1e3x'])
      expect(publicWebchatMessagesQuery.safeParse({ after }).success).toBe(false);
    expect(publicWebchatMessagesQuery.safeParse({ after: '1', limit: '5000' }).success).toBe(false);
  });
});

describe('the public outputs', () => {
  const sent = { seq: 1, from: 'visitor', text: 'Hello', sentAt: '2026-10-09T09:00:00.000Z' };

  it('carries a message as text only, with nothing that names a person or a record', () => {
    expect(publicWebchatMessage.safeParse(sent).success).toBe(true);
    for (const extra of [
      { html: '<b>Hello</b>' },
      { id: 'x' },
      { authorId: 'x' },
      { contactId: 'x' },
      { conversationId: 'x' },
      { authorName: 'Agent' },
    ])
      expect(publicWebchatMessage.safeParse({ ...sent, ...extra }).success).toBe(false);
    expect(publicWebchatMessage.safeParse({ ...sent, from: 'system' }).success).toBe(false);
    expect(publicWebchatMessage.safeParse({ ...sent, seq: 0 }).success).toBe(false);
    expect(
      publicWebchatMessage.safeParse({
        ...sent,
        text: 'a'.repeat(WEBCHAT_LIMITS.messageLength + 1),
      }).success,
    ).toBe(false);
  });

  it('bounds a page of messages', () => {
    const page = (count: number) =>
      publicWebchatMessages.safeParse({
        messages: Array.from({ length: count }, (_each, index) => ({ ...sent, seq: index + 1 })),
        cursor: count,
        more: false,
      }).success;
    expect(page(WEBCHAT_LIMITS.pageSize)).toBe(true);
    expect(page(WEBCHAT_LIMITS.pageSize + 1)).toBe(false);
  });

  it('gives a session only its token and when it ends', () => {
    const session = {
      token: Buffer.alloc(32, 3).toString('base64url'),
      expiresAt: '2026-11-08T09:00:00.000Z',
    };
    expect(publicWebchatSession.safeParse(session).success).toBe(true);
    expect(publicWebchatSession.safeParse({ ...session, contactId: 'x' }).success).toBe(false);
    expect(publicWebchatSession.safeParse({ ...session, sessionId: 'x' }).success).toBe(false);
  });

  it('shows a widget only what its form needs', () => {
    const config = {
      title: 'Chat with us',
      greeting: '',
      emailRequired: true,
      marketingConsentWording: null,
      messageLength: WEBCHAT_LIMITS.messageLength,
    };
    expect(publicWebchatConfig.safeParse(config).success).toBe(true);
    for (const extra of [{ allowedOrigins: [] }, { businessId: 'x' }, { name: 'Main site' }])
      expect(publicWebchatConfig.safeParse({ ...config, ...extra }).success).toBe(false);
  });
});

describe('the endpoints', () => {
  it('marks every public endpoint public, under one widget key, and no admin endpoint', () => {
    for (const endpoint of publicWebchatEndpoints) {
      expect(endpoint.audience).toBe('public');
      expect(endpoint.path.startsWith('/public/webchat/{widgetKey}')).toBe(true);
      expect(Object.keys(endpoint.params.shape)).toEqual(['widgetKey']);
    }
    for (const endpoint of webchatAdminEndpoints) {
      expect('audience' in endpoint).toBe(false);
      expect(endpoint.path.startsWith('/webchat/widgets')).toBe(true);
    }
  });

  it('never puts the session token in a path or a query', () => {
    for (const endpoint of publicWebchatEndpoints) {
      expect(endpoint.path).not.toMatch(/token|session\}/i);
      if ('query' in endpoint) expect(Object.keys(endpoint.query.shape)).toEqual(['after']);
    }
  });

  it('names each operation once', () => {
    const ids = [...publicWebchatEndpoints, ...webchatAdminEndpoints].map(
      (endpoint) => endpoint.operationId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows a widget with its id, key and snippet, and nothing of its tenant', () => {
    const widget = {
      id: 'wcw_01h455vb4pex5vsknk084sn02q',
      name: 'Main site',
      publicKey: 'a'.repeat(32),
      enabled: true,
      allowedOrigins: ['https://example.com'],
      settings: DEFAULT_WEBCHAT_SETTINGS,
      embedSnippet: '<script async src="https://crm.example.test/webchat/widget.js"></script>',
      createdAt: '2026-10-09T09:00:00.000Z',
      updatedAt: '2026-10-09T09:00:00.000Z',
    };
    expect(webchatWidget.safeParse(widget).success).toBe(true);
    expect(webchatWidget.safeParse({ ...widget, businessId: 'x' }).success).toBe(false);
    // Another kind's id, and the bare UUID, are not a widget's.
    for (const id of ['mbx_01h455vb4pex5vsknk084sn02q', '01890a5d-ac96-774b-bcce-b302099a8057'])
      expect(webchatWidget.safeParse({ ...widget, id }).success).toBe(false);
  });
});
