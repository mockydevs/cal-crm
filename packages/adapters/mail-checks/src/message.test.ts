import { describe, expect, it } from 'vitest';
import { checkMessage } from './index.js';
import { fixtureResolver } from './fixture-resolver.js';
import {
  baseHeaders,
  campaignSource,
  messageResolver,
  signedMessage,
  unsubscribeHeaders,
} from '../test/message-fixture.js';

const source = Buffer.from(
  [
    'From: Harbor <sender@example.com>',
    'To: sender@example.com',
    'Date: Fri, 09 Oct 2026 00:00:00 +0000',
    'Message-ID: <probe@example.com>',
    'Subject: Mailbox setup check',
    '',
    'This is a mailbox setup check.',
    '',
  ].join('\r\n'),
);
const input = {
  source,
  expectedFrom: 'sender@example.com',
  expectedMessageId: '<probe@example.com>',
  campaign: false,
  smtpTls: true,
  imapTls: true,
};

describe('a self-addressed test copy', () => {
  it('matches the same author domain regardless of DNS letter case', async () => {
    const results = await checkMessage(
      { ...input, expectedFrom: 'sender@EXAMPLE.COM' },
      fixtureResolver({}),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ key: 'dkim', reason: 'unsigned_local_copy' }),
    );
  });
  it('does not treat a different case-sensitive local part as the expected author', async () => {
    await expect(
      checkMessage({ ...input, expectedFrom: 'Sender@example.com' }, fixtureResolver({})),
    ).rejects.toMatchObject({ code: 'unexpected_message' });
  });
  it('cannot confirm DKIM when the local server delivers an unsigned copy', async () => {
    const results = await checkMessage(input, fixtureResolver({}));
    expect(results).toContainEqual({
      key: 'dkim',
      status: 'could_not_check',
      reason: 'unsigned_local_copy',
      found: {},
    });
  });
  it('flags a verified campaign signature that omits the unsubscribe fields', async () => {
    const results = await checkMessage(
      { ...input, source: await signedMessage(undefined, baseHeaders), campaign: true },
      messageResolver(),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'dkim', status: 'pass', reason: 'signature_verified' }),
        expect.objectContaining({
          key: 'unsubscribe',
          status: 'fail',
          reason: 'headers_not_signed',
        }),
      ]),
    );
  });
  it.each([
    ['missing post field', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n', ''],
    ['HTTP link', 'https://example.com/unsubscribe', 'http://example.com/unsubscribe'],
    ['extra post argument', 'List-Unsubscribe=One-Click', 'List-Unsubscribe=One-Click&extra=yes'],
    [
      'duplicate post field',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click',
    ],
  ])('rejects signed unsubscribe metadata with %s', async (_name, before, after) => {
    const malformed = Buffer.from(campaignSource.toString().replace(before, after));
    const results = await checkMessage(
      { ...input, source: await signedMessage(malformed), campaign: true },
      messageResolver(),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        key: 'unsubscribe',
        status: 'fail',
        reason: 'invalid_headers',
      }),
    );
  });
  it('confirms DMARC using a locally verified aligned signature and the published policy', async () => {
    const results = await checkMessage(
      { ...input, source: await signedMessage(), campaign: true },
      messageResolver(),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'dkim', status: 'pass' }),
        expect.objectContaining({ key: 'dmarc', status: 'pass', reason: 'dkim_aligned' }),
        expect.objectContaining({ key: 'unsubscribe', status: 'pass', reason: 'headers_signed' }),
      ]),
    );
  });
  it.each([
    [
      'different Message-ID',
      source.toString().replace('<probe@example.com>', '<other@example.com>'),
    ],
    [
      'different author',
      source.toString().replace('Harbor <sender@example.com>', 'Harbor <other@example.com>'),
    ],
    ['multiple author fields', `From: attacker@example.net\r\n${source.toString()}`],
    ['multiple Message-ID fields', `Message-ID: <probe@example.com>\r\n${source.toString()}`],
  ])(
    'refuses a copy with %s instead of returning evidence for unrelated mail',
    async (_name, text) => {
      await expect(
        checkMessage({ ...input, source: Buffer.from(text) }, messageResolver()),
      ).rejects.toMatchObject({
        code: 'unexpected_message',
        message: 'Message evidence is unavailable (unexpected_message).',
      });
    },
  );
  it.each([
    [
      'message larger than 512KiB',
      Buffer.concat([source, Buffer.alloc(512 * 1024, 'x')]),
      'too_large',
    ],
    [
      'header block larger than 64KiB',
      Buffer.from(`X-Large: ${'x'.repeat(65 * 1024)}\r\n${source.toString()}`),
      'too_large',
    ],
    [
      'more than ten signatures',
      Buffer.from(`${'DKIM-Signature: invalid\r\n'.repeat(11)}${source.toString()}`),
      'too_many_signatures',
    ],
    ['no header boundary', Buffer.from('invalid message'), 'malformed_message'],
  ])('bounds untrusted input: %s', async (_name, oversized, code) => {
    const resolve = messageResolver();
    await expect(checkMessage({ ...input, source: oversized }, resolve)).rejects.toMatchObject({
      code,
    });
    expect(resolve.queries).toHaveLength(0);
  });
  it.each([' \t', '\r\n'])(
    'counts vendor-accepted field-name whitespace %j toward the signature bound',
    async (whitespace) => {
      const copy = Buffer.from(
        `${`DKIM-Signature${whitespace}: invalid\r\n`.repeat(11)}${source.toString()}`,
      );
      await expect(
        checkMessage({ ...input, source: copy }, messageResolver()),
      ).rejects.toMatchObject({ code: 'too_many_signatures' });
    },
  );
  it('does not turn copied Authentication-Results or Received claims into proof of TLS or DKIM', async () => {
    const copy = Buffer.from(
      `Authentication-Results: trusted.example; dkim=pass; spf=pass; dmarc=pass\r\nReceived: from smtp.example by mx.example with ESMTPS; Fri, 09 Oct 2026 00:00:00 +0000\r\n${source.toString()}`,
    );
    const results = await checkMessage({ ...input, source: copy }, messageResolver());
    expect(results).toHaveLength(4);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'dkim',
          status: 'could_not_check',
          reason: 'unsigned_local_copy',
        }),
        expect.objectContaining({
          key: 'dmarc',
          status: 'could_not_check',
          reason: 'spf_not_observed',
        }),
        expect.objectContaining({
          key: 'encryption',
          status: 'could_not_check',
          reason: 'receiving_hop_not_observed',
        }),
        expect.objectContaining({ key: 'unsubscribe', status: 'not_applicable' }),
      ]),
    );
  });
  it.each(['smtpTls', 'imapTls'] as const)(
    'fails encryption when the observed %s connection lacked verified TLS',
    async (connection) => {
      const results = await checkMessage({ ...input, [connection]: false }, messageResolver());
      expect(results).toContainEqual(
        expect.objectContaining({
          key: 'encryption',
          status: 'fail',
          reason: 'connection_not_encrypted',
        }),
      );
    },
  );
  it('does not combine two valid signatures to claim both unsubscribe fields were covered by one', async () => {
    const first = await signedMessage(campaignSource, [
      ...baseHeaders,
      unsubscribeHeaders[0] ?? '',
    ]);
    const both = await signedMessage(first, [...baseHeaders, unsubscribeHeaders[1] ?? '']);
    const results = await checkMessage(
      { ...input, source: both, campaign: true },
      messageResolver(),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ key: 'unsubscribe', status: 'fail', reason: 'headers_not_signed' }),
    );
  });
  it('does not authenticate appended unsigned content with a body-length-limited signature', async () => {
    const limited = await signedMessage(campaignSource, undefined, { maxBodyLength: 0 });
    const results = await checkMessage(
      { ...input, source: limited, campaign: true },
      messageResolver(),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ key: 'dkim', status: 'fail', reason: 'unsigned_body' }),
    );
    expect(results).not.toContainEqual(expect.objectContaining({ key: 'dmarc', status: 'pass' }));
    expect(results).not.toContainEqual(
      expect.objectContaining({ key: 'unsubscribe', status: 'pass' }),
    );
  });
  it('reports inability to check when the signing key DNS lookup times out', async () => {
    const results = await checkMessage(
      { ...input, source: await signedMessage() },
      messageResolver({
        'probe._domainkey.example.com': { error: 'ETIMEOUT' },
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ key: 'dkim', status: 'could_not_check', reason: 'dns_error' }),
    );
  });
  it('never accepts malformed flattened TXT answers as proof of a signature or policy', async () => {
    const resolve = messageResolver();
    const results = await checkMessage(
      { ...input, source: await signedMessage() },
      async (name, type) => {
        const answer = await resolve(name, type);
        return type === 'TXT' && Array.isArray(answer) ? answer.flat() : answer;
      },
    );
    expect(results).not.toContainEqual(expect.objectContaining({ key: 'dkim', status: 'pass' }));
    expect(results).not.toContainEqual(expect.objectContaining({ key: 'dmarc', status: 'pass' }));
  });
  it.each(['tampered_body', 'expired_signature', 'malformed_signature'] as const)(
    'refuses %s rather than trusting a signature header alone',
    async (kind) => {
      let copy: Buffer;
      if (kind === 'malformed_signature')
        copy = Buffer.from(`DKIM-Signature: invalid\r\n${source.toString()}`);
      else if (kind === 'expired_signature')
        copy = await signedMessage(campaignSource, undefined, {
          signTime: new Date('2020-01-01T00:00:00Z'),
          expires: new Date('2020-01-02T00:00:00Z'),
        });
      else
        copy = Buffer.from(
          (await signedMessage())
            .toString()
            .replace('This is a mailbox setup check.', 'The body was changed.'),
        );
      const results = await checkMessage({ ...input, source: copy }, messageResolver());
      expect(results).toContainEqual(
        expect.objectContaining({ key: 'dkim', status: 'fail', reason: 'signature_invalid' }),
      );
      expect(results).not.toContainEqual(expect.objectContaining({ key: 'dmarc', status: 'pass' }));
    },
  );
  it('can verify unaligned DKIM without claiming DMARC failed when public-hop SPF is unknown', async () => {
    const copy = await signedMessage(campaignSource, undefined, { signingDomain: 'example.net' });
    const results = await checkMessage({ ...input, source: copy }, messageResolver());
    expect(results).toContainEqual(expect.objectContaining({ key: 'dkim', status: 'pass' }));
    expect(results).toContainEqual(
      expect.objectContaining({
        key: 'dmarc',
        status: 'could_not_check',
        reason: 'spf_not_observed',
      }),
    );
  });
  it('requires a published DMARC policy even with a valid aligned DKIM signature', async () => {
    const results = await checkMessage(
      { ...input, source: await signedMessage() },
      messageResolver({
        '_dmarc.example.com': { error: 'ENOTFOUND' },
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ key: 'dmarc', status: 'fail', reason: 'no_valid_policy' }),
    );
  });
  it('keeps a DMARC DNS failure uncertain rather than calling the policy missing', async () => {
    const results = await checkMessage(
      { ...input, source: await signedMessage() },
      messageResolver({
        '_dmarc.example.com': { error: 'ETIMEOUT' },
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ key: 'dmarc', status: 'could_not_check', reason: 'dns_error' }),
    );
  });
});
