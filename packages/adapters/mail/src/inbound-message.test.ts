import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { INBOUND_LIMITS, parseInboundMessage } from './inbound-message.js';

const mime = (headers: readonly string[], body = 'Hello there.') =>
  Buffer.from([...headers, '', body].join('\r\n'));

const plain = (extra: readonly string[] = [], body?: string) =>
  mime(
    [
      'From: "Ada Lovelace" <Ada@Example.TEST>',
      'To: inbox@example.test, "Second" <second@example.test>',
      'Subject: Question',
      'Date: Thu, 08 Oct 2026 09:30:00 +0000',
      'Message-ID: <reply-1@example.test>',
      ...extra,
    ],
    body,
  );

async function parsed(source: Buffer) {
  const result = await parseInboundMessage(source);
  if (result.outcome !== 'parsed') throw new Error(`Refused: ${result.reason}`);
  return result.message;
}

describe('an ordinary message', () => {
  it('reads the sender, recipients, subject, date and body', async () => {
    const source = plain();
    const message = await parsed(source);
    expect(message).toMatchObject({
      messageId: '<reply-1@example.test>',
      inReplyTo: [],
      references: [],
      sender: { kind: 'one', address: 'ada@example.test', name: 'Ada Lovelace' },
      to: [
        { address: 'inbox@example.test', name: '' },
        { address: 'second@example.test', name: 'Second' },
      ],
      cc: [],
      replyTo: [],
      subject: 'Question',
      headerDate: new Date('2026-10-08T09:30:00Z'),
      text: 'Hello there.',
      html: null,
      automated: false,
      deliveryReport: false,
      attachmentCount: 0,
      truncated: false,
    });
    expect(message.sourceSha256).toEqual(createHash('sha256').update(source).digest());
  });

  it('keeps an invalid Date out instead of inventing the current time', async () => {
    expect((await parsed(plain(['Date: not a date']))).headerDate).toBeNull();
    const undated = mime(['From: a@example.test', 'Message-ID: <u@example.test>']);
    expect((await parsed(undated)).headerDate).toBeNull();
  });

  it('keeps HTML as untrusted markup and reads text from it when there is no text part', async () => {
    const message = await parsed(
      mime(
        ['From: a@example.test', 'Content-Type: text/html; charset=utf-8'],
        '<p>Hi <b>there</b><script>alert(1)</script></p>',
      ),
    );
    expect(message.html).toBe('<p>Hi <b>there</b><script>alert(1)</script></p>');
    expect(message.text).toContain('Hi there');
  });

  it('counts attachments without inlining their bytes into the HTML', async () => {
    const message = await parsed(
      mime(
        ['From: a@example.test', 'Content-Type: multipart/related; boundary="b"'],
        [
          '--b',
          'Content-Type: text/html',
          '',
          '<img src="cid:logo@x">',
          '--b',
          'Content-Type: image/png',
          'Content-ID: <logo@x>',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from('png bytes').toString('base64'),
          '--b--',
        ].join('\r\n'),
      ),
    );
    expect(message.attachmentCount).toBe(1);
    expect(message.html).toBe('<img src="cid:logo@x">');
  });
});

describe('the sender, an untrusted claim', () => {
  it.each([
    [['To: inbox@example.test'], 'none'],
    [['From: a@example.test', 'From: b@example.test'], 'multiple'],
    [['From: a@example.test, b@example.test'], 'multiple'],
    [['From: Group: a@example.test;'], 'invalid'],
    [['From: not an address'], 'invalid'],
    [['From: <@example.test>'], 'invalid'],
  ] as const)('is unresolved for %j', async (headers, reason) => {
    expect((await parsed(mime(headers))).sender).toEqual({ kind: 'unresolved', reason });
  });
});

describe('threading headers', () => {
  it('reads every msg-id of In-Reply-To and References, in order', async () => {
    const message = await parsed(
      plain([
        'In-Reply-To: <parent@example.test> <other@example.test>',
        'References: <root@example.test>\r\n <parent@example.test> junk <bad>',
      ]),
    );
    expect(message.inReplyTo).toEqual(['<parent@example.test>', '<other@example.test>']);
    expect(message.references).toEqual(['<root@example.test>', '<parent@example.test>']);
  });

  it('keeps the newest references within the limit', async () => {
    const ids = Array.from(
      { length: INBOUND_LIMITS.references + 5 },
      (_, i) => `<r${String(i)}@x.test>`,
    );
    const message = await parsed(plain([`References: ${ids.join(' ')}`]));
    expect(message.references).toEqual(ids.slice(-INBOUND_LIMITS.references));
  });

  it('has no Message-ID when it is missing, malformed or given twice', async () => {
    expect((await parsed(mime(['From: a@example.test']))).messageId).toBeNull();
    expect(
      (await parsed(mime(['From: a@example.test', 'Message-ID: no-brackets']))).messageId,
    ).toBeNull();
    expect(
      (
        await parsed(
          mime(['From: a@example.test', 'Message-ID: <a@x.test>', 'Message-ID: <b@x.test>']),
        )
      ).messageId,
    ).toBeNull();
  });
});

describe('automated mail', () => {
  it.each([
    ['Auto-Submitted: auto-replied', true],
    ['Auto-Submitted: auto-generated; comment', true],
    ['Auto-Submitted: no', false],
    ['Precedence: bulk', true],
    ['Precedence: list', false],
  ])('marks %j as automated: %s', async (header, automated) => {
    expect((await parsed(plain([header]))).automated).toBe(automated);
  });

  it('recognizes a delivery status notification (RFC 3464)', async () => {
    const report = await parsed(
      mime(
        [
          'From: Mail Delivery System <mailer-daemon@example.test>',
          'Auto-Submitted: auto-replied',
          'Content-Type: multipart/report; report-type=delivery-status; boundary="r"',
        ],
        [
          '--r',
          'Content-Type: text/plain',
          '',
          'Delivery failed.',
          '--r',
          'Content-Type: message/delivery-status',
          '',
          'Reporting-MTA: dns; mx.example.test',
          '',
          'Final-Recipient: rfc822; gone@example.test',
          'Action: failed',
          'Status: 5.1.1',
          '--r--',
        ].join('\r\n'),
      ),
    );
    expect(report).toMatchObject({ deliveryReport: true, automated: true });
    const otherReport = await parsed(
      mime(
        [
          'From: a@example.test',
          'Content-Type: multipart/report; report-type=disposition-notification; boundary="r"',
        ],
        '--r--',
      ),
    );
    expect(otherReport.deliveryReport).toBe(false);
  });
});

describe('bounds', () => {
  it('cuts long text, drops HTML over the limit, and says so', async () => {
    const long = 'a'.repeat(INBOUND_LIMITS.textChars + 10);
    const message = await parsed(plain([], long));
    expect(message.text).toHaveLength(INBOUND_LIMITS.textChars);
    expect(message.truncated).toBe(true);

    const html = `<p>${'b'.repeat(INBOUND_LIMITS.htmlChars)}</p>`;
    const alternative = await parsed(
      mime(
        ['From: a@example.test', 'Content-Type: multipart/alternative; boundary="a"'],
        [
          '--a',
          'Content-Type: text/plain',
          '',
          'short',
          '--a',
          'Content-Type: text/html',
          '',
          html,
          '--a--',
        ].join('\r\n'),
      ),
    );
    expect(alternative).toMatchObject({ text: 'short', html: null, truncated: true });
  });

  it('refuses a source over the reader cap before parsing it', async () => {
    const source = Buffer.concat([
      plain(),
      Buffer.alloc(INBOUND_LIMITS.sourceBytes + 1 - plain().length, 'a'),
    ]);
    expect(source.length).toBe(INBOUND_LIMITS.sourceBytes + 1);
    expect(await parseInboundMessage(source)).toEqual({
      outcome: 'refused',
      reason: 'message_too_large',
      sourceSha256: createHash('sha256').update(source).digest(),
    });
  });

  it('refuses more attachments than it keeps count of', async () => {
    const part = (i: number) =>
      [
        '--m',
        'Content-Type: application/octet-stream',
        `Content-Disposition: attachment; filename="f${String(i)}"`,
        '',
        'x',
      ].join('\r\n');
    const build = (count: number) =>
      mime(
        ['From: a@example.test', 'Content-Type: multipart/mixed; boundary="m"'],
        [...Array.from({ length: count }, (_, i) => part(i)), '--m--'].join('\r\n'),
      );
    expect((await parsed(build(INBOUND_LIMITS.attachments))).attachmentCount).toBe(
      INBOUND_LIMITS.attachments,
    );
    expect(await parseInboundMessage(build(INBOUND_LIMITS.attachments + 1))).toMatchObject({
      outcome: 'refused',
      reason: 'too_many_attachments',
    });
  });

  it('refuses HTML-only mail too long to read as text', async () => {
    const html = `<p>${'c'.repeat(INBOUND_LIMITS.htmlChars)}</p>`;
    const result = await parseInboundMessage(
      mime(['From: a@example.test', 'Content-Type: text/html'], html),
    );
    expect(result).toMatchObject({ outcome: 'refused', reason: 'html_too_large' });
  });

  it('caps subject, names and the number of recipients', async () => {
    const many = Array.from(
      { length: INBOUND_LIMITS.addresses + 3 },
      (_, i) => `r${String(i)}@example.test`,
    );
    const message = await parsed(
      plain([`Cc: ${many.join(', ')}`, `Subject: ${'s'.repeat(INBOUND_LIMITS.subjectChars + 1)}`]),
    );
    expect(message.cc).toHaveLength(INBOUND_LIMITS.addresses);
    expect(message.subject).toHaveLength(INBOUND_LIMITS.subjectChars);
    expect(message.truncated).toBe(true);
  });
});

describe("the receiving server's verdict on the From address (RFC 8601)", () => {
  const verdict = async (...results: string[]) =>
    (await parsed(plain(results.map((value) => `Authentication-Results: ${value}`))))
      .senderAuthentication;

  it('is fail when DMARC failed for the From domain', async () => {
    expect(
      await verdict(
        'mx.google.com; spf=fail (google.com: domain of x@example.test does not designate) smtp.mailfrom=x@example.test; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=example.test',
      ),
    ).toBe('fail');
    expect(await verdict('mx.example.net; DMARC=FAIL header.from="Example.TEST"')).toBe('fail');
  });

  it('is fail with no DMARC result when SPF failed and no DKIM of the domain passed', async () => {
    expect(await verdict('mx.example.net; spf=fail smtp.mailfrom=ada@example.test')).toBe('fail');
    expect(
      await verdict(
        'mx.example.net; spf=fail smtp.mailfrom=ada@example.test; dkim=pass header.d=example.test',
      ),
    ).toBe('unknown');
    expect(
      await verdict(
        'mx.example.net; spf=fail smtp.mailfrom=ada@example.test; dkim=pass header.i=@other.example',
      ),
    ).toBe('fail');
  });

  it('reads only the topmost field, the mailbox server’s own', async () => {
    // A forged field below the receiver's never decides.
    expect(
      await verdict(
        'mx.example.net; dmarc=pass header.from=example.test',
        'evil.example; dmarc=fail header.from=example.test',
      ),
    ).toBe('pass');
  });

  it('is unknown without a verdict about the From domain', async () => {
    expect(await verdict('mx.example.net; dmarc=fail header.from=other.example')).toBe('unknown');
    expect(await verdict('mx.example.net; dmarc=none header.from=example.test')).toBe('unknown');
    expect(await verdict('mx.example.net; none')).toBe('unknown');
    expect(await verdict('mx.example.net; spf=softfail smtp.mailfrom=example.test')).toBe(
      'unknown',
    );
    expect((await parsed(plain())).senderAuthentication).toBe('unknown');
  });

  it('marks a feedback report', async () => {
    const report = await parsed(
      mime(
        [
          'From: <fbl@feedback.example>',
          'MIME-Version: 1.0',
          'Content-Type: multipart/report; report-type=feedback-report; boundary="b"',
        ],
        '--b\r\nContent-Type: text/plain\r\n\r\nReport\r\n--b--',
      ),
    );
    expect(report.feedbackReport).toBe(true);
    expect((await parsed(plain())).feedbackReport).toBe(false);
  });
});
