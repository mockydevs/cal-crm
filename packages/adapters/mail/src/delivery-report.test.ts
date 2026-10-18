import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  classifyDelivery,
  parseFeedbackReport,
  DELIVERY_REPORT_LIMITS,
  parseDeliveryReport,
  type DeliveryReport,
} from './delivery-report.js';
import { INBOUND_LIMITS } from './inbound-message.js';

const OUTBOUND = '<crm-outbound.0199c0de-0000-7000-8000-000000000001@crm.invalid>';

// Fixtures are stored with LF; mail arrives with CRLF.
const fixture = (name: string) =>
  Buffer.from(
    readFileSync(new URL(`./fixtures/dsn/${name}.eml`, import.meta.url), 'utf8').replace(
      /\r?\n/g,
      '\r\n',
    ),
  );

async function report(source: Buffer): Promise<DeliveryReport> {
  const parsed = await parseDeliveryReport(source);
  if (parsed === null) throw new Error('Not read as a delivery report.');
  return parsed;
}

const MTA = 'Reporting-MTA: dns; mx.example.test';
const FAILED = ['Final-Recipient: rfc822; nobody@example.com', 'Action: failed', 'Status: 5.1.1'];
const RETURNED = ['Content-Type: text/rfc822-headers', '', `Message-ID: ${OUTBOUND}`, ''];

interface Parts {
  readonly type?: string;
  readonly status?: readonly string[];
  readonly returned?: readonly string[] | null;
  readonly extra?: readonly string[];
}

/** A report built from its parts: the status part's lines and the returned part's lines. */
const dsn = ({
  type = 'multipart/report; report-type=delivery-status; boundary="b"',
  status = [MTA, '', ...FAILED],
  returned = RETURNED,
  extra = [],
}: Parts = {}) =>
  Buffer.from(
    [
      'From: MAILER-DAEMON@mx.example.test',
      'To: inbox@example.test',
      'Message-ID: <report-1@mx.example.test>',
      `Content-Type: ${type}`,
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'Your message could not be delivered.',
      '--b',
      'Content-Type: message/delivery-status',
      '',
      ...status,
      '',
      ...(returned === null ? [] : ['--b', ...returned]),
      ...extra,
      '--b--',
      '',
    ].join('\r\n'),
  );

const recipients = async (source: Buffer) => (await report(source)).recipients;

describe('fixture reports', () => {
  it('reads a failed delivery to an unknown user, with the returned message', async () => {
    expect(await report(fixture('failed-user-unknown'))).toEqual({
      reportingMta: { type: 'dns', name: 'mx.example.test' },
      originalMessageId: OUTBOUND,
      recipients: [
        {
          finalRecipient: 'nobody@example.com',
          originalRecipient: 'nobody@example.com',
          action: 'failed',
          reportedStatus: '5.1.1',
          status: '5.1.1',
          bounce: 'hard',
        },
      ],
    });
  });

  it('reads field names and values in any case, a status comment, and returned headers only', async () => {
    expect(await report(fixture('failed-headers-only'))).toMatchObject({
      originalMessageId: OUTBOUND,
      recipients: [
        {
          finalRecipient: 'nobody@example.com',
          originalRecipient: null,
          action: 'failed',
          status: '5.1.2',
          bounce: 'hard',
        },
      ],
    });
  });

  it('takes the exact status from the remote reply when the reported one is only its class', async () => {
    expect(await recipients(fixture('failed-class-only-status'))).toMatchObject([
      { action: 'failed', reportedStatus: '5.0.0', status: '5.1.1', bounce: 'hard' },
    ]);
  });

  it('keeps a refusal by policy soft: it blames the sender, not the address', async () => {
    expect(await recipients(fixture('failed-policy'))).toMatchObject([
      { finalRecipient: 'someone@example.com', status: '5.7.1', bounce: 'soft' },
    ]);
  });

  it('keeps a full mailbox soft', async () => {
    expect(await recipients(fixture('failed-mailbox-full'))).toMatchObject([
      { status: '5.2.2', bounce: 'soft' },
    ]);
  });

  it('reads a delivery abandoned after temporary failures as soft', async () => {
    expect(await recipients(fixture('failed-temporary'))).toMatchObject([
      { action: 'failed', status: '4.0.0', bounce: 'soft' },
    ]);
  });

  it("doesn't count a delay as a bounce: the server is still trying", async () => {
    expect(await report(fixture('delayed'))).toMatchObject({
      originalMessageId: OUTBOUND,
      recipients: [{ action: 'delayed', status: '4.0.0', bounce: null }],
    });
  });

  it("doesn't count a success as a bounce", async () => {
    expect(await recipients(fixture('delivered'))).toMatchObject([
      { action: 'delivered', status: '2.0.0', bounce: null },
    ]);
  });

  it('reads each recipient of one report on its own', async () => {
    expect(await recipients(fixture('multi-recipient'))).toMatchObject([
      // 5.0.0 and a reply without an enhanced code: only the class is known.
      { finalRecipient: 'first@example.com', action: 'failed', status: '5.0.0', bounce: 'soft' },
      { finalRecipient: 'second@example.org', action: 'delayed', bounce: null },
      { finalRecipient: 'third@example.com', action: 'failed', status: '5.1.1', bounce: 'hard' },
    ]);
  });

  it('has no message to link when the report returns none', async () => {
    expect(await report(fixture('no-returned-message'))).toMatchObject({
      originalMessageId: null,
      recipients: [{ status: '5.1.1', bounce: 'hard' }],
    });
  });

  it('reads a returned message marked inline', async () => {
    expect((await report(fixture('inline-returned-message'))).originalMessageId).toBe(OUTBOUND);
  });

  it('reads a report with bare line feeds the same', async () => {
    const source = Buffer.from(
      fixture('failed-user-unknown').toString('latin1').replace(/\r/g, ''),
    );
    expect(await report(source)).toEqual(await report(fixture('failed-user-unknown')));
  });

  it('returns no free text from the report', async () => {
    for (const name of ['failed-user-unknown', 'failed-policy', 'multi-recipient'])
      expect(JSON.stringify(await report(fixture(name)))).not.toMatch(
        /does not exist|blocked|registered|order|shop/i,
      );
  });
});

describe('what counts as a delivery report', () => {
  it('reads the built report the other cases vary', async () => {
    expect(await report(dsn())).toEqual({
      reportingMta: { type: 'dns', name: 'mx.example.test' },
      originalMessageId: OUTBOUND,
      recipients: [
        {
          finalRecipient: 'nobody@example.com',
          originalRecipient: null,
          action: 'failed',
          reportedStatus: '5.1.1',
          status: '5.1.1',
          bounce: 'hard',
        },
      ],
    });
  });

  it('links a returned reply by its own Message-ID, not by the thread it names', async () => {
    // A reply from the Inbox names its parent and its thread, and one of those can be
    // another message of ours. Only the Message-ID line says which message came back.
    const earlier = '<crm-outbound.0199c0de-0000-7000-8000-00000000000e@crm.invalid>';
    const references = Array.from(
      { length: 20 },
      (_, index) => `<thread-${String(index)}@mail.example.test>`,
    );
    const returned = [
      'Content-Type: text/rfc822-headers',
      '',
      `In-Reply-To: ${earlier}`,
      // Folded, as the mail adapter's library writes a long References.
      `References: ${references.slice(0, 10).join(' ')}`,
      ` ${references.slice(10).join(' ')}`,
      ` ${earlier}`,
      `Message-ID: ${OUTBOUND}`,
      'Subject: Re: June 13',
      '',
    ];
    expect((await report(dsn({ returned }))).originalMessageId).toBe(OUTBOUND);
  });

  it('refuses anything that is not a multipart/report of delivery status', async () => {
    const plain = Buffer.from(
      ['From: a@example.test', 'Subject: Hello', '', 'Status: 5.1.1', ''].join('\r\n'),
    );
    expect(await parseDeliveryReport(plain)).toBeNull();
    for (const type of [
      'multipart/mixed; boundary="b"',
      'multipart/report; boundary="b"',
      'multipart/report; report-type=disposition-notification; boundary="b"',
    ])
      expect(await parseDeliveryReport(dsn({ type }))).toBeNull();
  });

  it('refuses a report forwarded inside an ordinary message', async () => {
    const forwarded = Buffer.concat([
      Buffer.from(
        [
          'From: a@example.test',
          'Content-Type: multipart/mixed; boundary="outer"',
          '',
          '--outer',
          'Content-Type: message/rfc822',
          '',
          '',
        ].join('\r\n'),
      ),
      dsn(),
      Buffer.from('\r\n--outer--\r\n'),
    ]);
    expect(await parseDeliveryReport(forwarded)).toBeNull();
  });

  it('refuses a source over the inbound size limit', async () => {
    const source = Buffer.concat([dsn(), Buffer.alloc(INBOUND_LIMITS.sourceBytes, 0x20)]);
    expect(await parseDeliveryReport(source)).toBeNull();
  });

  it('refuses a report with two status parts, or with the status out of place', async () => {
    const second = ['--b', 'Content-Type: message/delivery-status', '', MTA, '', ...FAILED, ''];
    expect(await parseDeliveryReport(dsn({ extra: second }))).toBeNull();
    // The status must be the second part; here it is the third.
    const late = Buffer.from(
      [
        'From: MAILER-DAEMON@mx.example.test',
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain',
        '',
        'Not delivered.',
        '--b',
        ...RETURNED,
        '--b',
        'Content-Type: message/delivery-status',
        '',
        MTA,
        '',
        ...FAILED,
        '',
        '--b--',
        '',
      ].join('\r\n'),
    );
    expect(await parseDeliveryReport(late)).toBeNull();
  });

  it('reads the status as the second part when the first is itself multipart', async () => {
    const source = Buffer.from(
      [
        'From: MAILER-DAEMON@mx.example.test',
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
        '',
        '--b',
        'Content-Type: multipart/alternative; boundary="a"',
        '',
        '--a',
        'Content-Type: text/plain',
        '',
        'Not delivered.',
        '--a',
        'Content-Type: text/html',
        '',
        '<p>Not delivered.</p>',
        '--a--',
        '--b',
        'Content-Type: message/delivery-status',
        '',
        MTA,
        '',
        ...FAILED,
        '',
        '--b',
        ...RETURNED,
        '--b--',
        '',
      ].join('\r\n'),
    );
    expect(await report(source)).toMatchObject({
      originalMessageId: OUTBOUND,
      recipients: [{ bounce: 'hard' }],
    });
  });
});

describe('the status part', () => {
  it('needs exactly one Reporting-MTA with a type and a name', async () => {
    for (const status of [
      ['X-Other: 1', '', ...FAILED],
      [MTA, MTA, '', ...FAILED],
      ['Reporting-MTA: mx.example.test', '', ...FAILED],
      ['Reporting-MTA: dns;', '', ...FAILED],
      [`Reporting-MTA: dns; ${'m'.repeat(DELIVERY_REPORT_LIMITS.mtaNameChars + 1)}`, '', ...FAILED],
    ])
      expect(await parseDeliveryReport(dsn({ status }))).toBeNull();
  });

  it('refuses a body with a line that is neither a field nor a continuation', async () => {
    expect(
      await parseDeliveryReport(dsn({ status: [MTA, '', 'not a field', ...FAILED] })),
    ).toBeNull();
    expect(await parseDeliveryReport(dsn({ status: [MTA, '', ' Status: 5.1.1'] }))).toBeNull();
  });

  it('joins continuation lines', async () => {
    const status = [
      MTA,
      '',
      'Final-Recipient: rfc822;',
      '\tnobody@example.com',
      'Action:',
      ' failed',
      'Status: 5.0.0',
      'Diagnostic-Code: smtp;',
      ' 550-5.1.1 no such user',
    ];
    expect(await recipients(dsn({ status }))).toMatchObject([
      { finalRecipient: 'nobody@example.com', status: '5.1.1', bounce: 'hard' },
    ]);
  });

  it('leaves out a group that repeats or lacks a field, and keeps the others', async () => {
    const good = ['Final-Recipient: rfc822; other@example.com', 'Action: failed', 'Status: 5.2.2'];
    const [final = '', action = '', status = ''] = FAILED;
    for (const group of [
      [...FAILED, 'Final-Recipient: rfc822; victim@example.com'],
      [...FAILED, 'Action: delivered'],
      [...FAILED, 'Status: 2.0.0'],
      [...FAILED, 'Diagnostic-Code: smtp; 550 5.1.1 a', 'Diagnostic-Code: smtp; 250 2.0.0 b'],
      [
        ...FAILED,
        'Original-Recipient: rfc822; a@example.com',
        'Original-Recipient: rfc822; b@example.com',
      ],
      [action, status],
      [final, status],
      [final, action],
    ])
      expect(await recipients(dsn({ status: [MTA, '', ...group, '', ...good] }))).toMatchObject([
        { finalRecipient: 'other@example.com', bounce: 'soft' },
      ]);
  });

  it('leaves out a group with a status or an action it cannot read', async () => {
    const [final = ''] = FAILED;
    for (const status of [
      '5.1',
      '5.01.1',
      '5.1.1111',
      '3.1.1',
      '5 .1.1',
      '5.1.1 extra',
      '5.1.1 (a) (b)',
    ])
      expect(
        await recipients(dsn({ status: [MTA, '', final, 'Action: failed', `Status: ${status}`] })),
      ).toEqual([]);
    for (const action of ['bounced', 'failed delivered', ''])
      expect(
        await recipients(dsn({ status: [MTA, '', final, `Action: ${action}`, 'Status: 5.1.1'] })),
      ).toEqual([]);
  });

  it('reads a failed action with a success status as no bounce', async () => {
    const [final = ''] = FAILED;
    expect(
      await recipients(dsn({ status: [MTA, '', final, 'Action: failed', 'Status: 2.1.5'] })),
    ).toMatchObject([{ action: 'failed', status: '2.1.5', bounce: null }]);
  });

  it('never lets a diagnostic change a status unless it only refines the same class', async () => {
    const [final = ''] = FAILED;
    const read = async (status: string, diagnostic: string) =>
      (
        await recipients(
          dsn({
            status: [
              MTA,
              '',
              final,
              'Action: failed',
              `Status: ${status}`,
              `Diagnostic-Code: ${diagnostic}`,
            ],
          }),
        )
      ).map((each) => [each.status, each.bounce]);
    expect(await read('5.0.0', 'smtp; 550 5.1.1 no such user')).toEqual([['5.1.1', 'hard']]);
    expect(await read('5.0.0', 'SMTP; 550-5.1.1')).toEqual([['5.1.1', 'hard']]);
    expect(await read('5.0.0', 'smtp; 550 5.7.1 blocked')).toEqual([['5.7.1', 'soft']]);
    // A specific status is never replaced.
    expect(await read('5.2.2', 'smtp; 550 5.1.1 no such user')).toEqual([['5.2.2', 'soft']]);
    // Another class, in the status or within the reply itself.
    expect(await read('4.0.0', 'smtp; 550 5.1.1 no such user')).toEqual([['4.0.0', 'soft']]);
    // The status stays; a permanent failure whose words say the address is dead is hard.
    expect(await read('5.0.0', 'smtp; 450 5.1.1 no such user')).toEqual([['5.0.0', 'hard']]);
    expect(await read('5.0.0', 'smtp; 550 4.1.1 no such user')).toEqual([['5.0.0', 'hard']]);
    // Not an SMTP reply with an enhanced code at its start.
    expect(await read('5.0.0', 'x-unix; 550 5.1.1 no such user')).toEqual([['5.0.0', 'hard']]);
    expect(await read('5.0.0', 'smtp; 550 5.1.1x')).toEqual([['5.0.0', 'soft']]);
    expect(await read('5.0.0', 'smtp; said 550 5.1.1')).toEqual([['5.0.0', 'soft']]);
    expect(await read('5.0.0', 'smtp; 550 user unknown')).toEqual([['5.0.0', 'hard']]);
    expect(await read('5.0.0', '550 5.1.1 no type')).toEqual([['5.0.0', 'soft']]);
  });

  it('keeps only rfc822 addresses a contact could hold', async () => {
    for (const value of [
      'unknown; nobody',
      'utf-8; nobody@example.com',
      'rfc822; <nobody@example.com>',
      'rfc822; nobody',
      'rfc822; a@example.com, b@example.com',
      'rfc822; nobody@example.com (comment)',
      `rfc822; ${'a'.repeat(320)}@example.com`,
      'nobody@example.com',
    ])
      expect(
        await recipients(
          dsn({
            status: [
              MTA,
              '',
              `Final-Recipient: ${value}`,
              `Original-Recipient: ${value}`,
              'Action: failed',
              'Status: 5.1.1',
            ],
          }),
        ),
      ).toMatchObject([{ finalRecipient: null, originalRecipient: null, bounce: 'hard' }]);
  });

  it('refuses a status part or a recipient count over the limits', async () => {
    const group = (index: number) => [
      '',
      `Final-Recipient: rfc822; user${String(index)}@example.com`,
      'Action: failed',
      'Status: 5.1.1',
    ];
    const groups = (count: number) =>
      Array.from({ length: count }, (_, index) => group(index)).flat();
    const { recipients: limit, statusBytes } = DELIVERY_REPORT_LIMITS;
    expect(await recipients(dsn({ status: [MTA, ...groups(limit)] }))).toHaveLength(limit);
    expect(await parseDeliveryReport(dsn({ status: [MTA, ...groups(limit + 1)] }))).toBeNull();
    const padded = [MTA, `X-Padding: ${'x'.repeat(statusBytes)}`, '', ...FAILED];
    expect(await parseDeliveryReport(dsn({ status: padded }))).toBeNull();
  });
});

describe('the returned message', () => {
  const idOf = async (returned: readonly string[]) =>
    (await report(dsn({ returned }))).originalMessageId;

  it('reads a folded Message-ID, in any case', async () => {
    expect(
      await idOf(['Content-Type: text/rfc822-headers', '', 'MESSAGE-ID:', ` ${OUTBOUND}`, '']),
    ).toBe(OUTBOUND);
    expect(
      await idOf(['Content-Type: message/rfc822', '', `Message-Id: ${OUTBOUND}`, '', 'Body']),
    ).toBe(OUTBOUND);
  });

  it('gives no link for a repeated, malformed or missing Message-ID', async () => {
    const headers = (...lines: string[]) => ['Content-Type: text/rfc822-headers', '', ...lines, ''];
    expect(
      await idOf(headers(`Message-ID: ${OUTBOUND}`, 'Message-ID: <other@example.test>')),
    ).toBeNull();
    expect(await idOf(headers(`Message-ID: ${OUTBOUND} ${OUTBOUND}`))).toBeNull();
    expect(await idOf(headers('Message-ID: crm-outbound@crm.invalid'))).toBeNull();
    expect(await idOf(headers('Subject: Your order'))).toBeNull();
    expect(await idOf(headers(`X-Message-ID: ${OUTBOUND}`))).toBeNull();
  });

  it('reads only the header block, never the body', async () => {
    expect(
      await idOf([
        'Content-Type: message/rfc822',
        '',
        'Subject: Hi',
        '',
        `Message-ID: ${OUTBOUND}`,
      ]),
    ).toBeNull();
  });

  it('gives no link when the third part is not a returned message', async () => {
    expect(await idOf(['Content-Type: text/plain', '', `Message-ID: ${OUTBOUND}`, ''])).toBeNull();
    expect(
      await idOf(['Content-Type: application/octet-stream', '', `Message-ID: ${OUTBOUND}`, '']),
    ).toBeNull();
    // A returned message further down isn't the report's third part.
    const fourth = dsn({
      returned: ['Content-Type: text/plain', '', 'Hello.'],
      extra: ['--b', ...RETURNED],
    });
    expect((await report(fourth)).originalMessageId).toBeNull();
  });

  it('gives no link when the header block is over the limit', async () => {
    const padding = `X-Padding: ${'x'.repeat(900)}`;
    const lines = Array.from(
      { length: DELIVERY_REPORT_LIMITS.headerBytes / 900 + 1 },
      () => padding,
    );
    const type = 'Content-Type: text/rfc822-headers';
    const id = `Message-ID: ${OUTBOUND}`;
    // Wherever the Message-ID is: a block that isn't read whole isn't trusted in part.
    expect(await idOf([type, '', ...lines, id, ''])).toBeNull();
    expect(await idOf([type, '', id, ...lines, ''])).toBeNull();
    expect(await idOf([type, '', id, ...lines.slice(0, 10), ''])).toBe(OUTBOUND);
  });

  it('does not read a report nested in the returned message', async () => {
    const nested = dsn({
      status: [
        MTA,
        '',
        'Final-Recipient: rfc822; victim@example.com',
        'Action: failed',
        'Status: 5.1.1',
      ],
    })
      .toString('latin1')
      .replaceAll('"b"', '"n"')
      .replaceAll('--b', '--n')
      .split('\r\n');
    const parsed = await report(dsn({ returned: ['Content-Type: message/rfc822', '', ...nested] }));
    expect(parsed.recipients.map((each) => each.finalRecipient)).toEqual(['nobody@example.com']);
    // The returned message is the nested report itself, with its own Message-ID.
    expect(parsed.originalMessageId).toBe('<report-1@mx.example.test>');
  });
});

describe('classifying a result', () => {
  it('is hard only for a failed delivery to a bad address', () => {
    for (const status of ['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10', '5.2.1'])
      expect(classifyDelivery('failed', status)).toBe('hard');
  });

  it("is hard when a permanent failure's own words say the address is dead (RFC 3463 class 5)", () => {
    for (const [status, words] of [
      ['5.0.0', 'smtp; 550 5.0.0 <a@example.com>... User unknown'],
      ['5.4.1', 'smtp; 550 5.4.1 Recipient address rejected: Access denied'],
      ['5.0.0', 'smtp; 550 RecipientNotFound'],
      [
        '5.2.0',
        'smtp; 550 5.2.0 The email account that you tried to reach is disabled. account disabled',
      ],
      ['5.5.0', 'smtp; 550 5.5.0 Requested action not taken: mailbox does not exist'],
    ] as const)
      expect(classifyDelivery('failed', status, words)).toBe('hard');
    // A policy refusal, a temporary failure or a full mailbox never is, whatever it says.
    for (const [status, words] of [
      ['5.7.1', 'smtp; 550 5.7.1 user unknown or message refused as spam'],
      ['4.0.0', 'smtp; 450 user unknown, try later'],
      ['5.2.2', 'smtp; 552 5.2.2 mailbox full'],
      ['5.0.0', 'smtp; 550 5.0.0 message rejected'],
    ] as const)
      expect(classifyDelivery('failed', status, words)).toBe('soft');
  });

  it('is soft for every other failure', () => {
    for (const status of [
      '5.0.0',
      '5.1.0',
      '5.1.4',
      '5.1.7',
      '5.1.8',
      '5.2.0',
      '5.2.2',
      '5.3.4',
      '5.4.4',
      '5.7.0',
      '5.7.1',
      '5.7.26',
      '4.0.0',
      '4.1.1',
      '4.2.2',
      '4.4.7',
    ])
      expect(classifyDelivery('failed', status)).toBe('soft');
  });

  it('is no bounce for a delay, a success, or a status that is not one', () => {
    for (const action of ['delayed', 'delivered', 'relayed', 'expanded'] as const)
      for (const status of ['5.1.1', '4.0.0', '2.0.0'])
        expect(classifyDelivery(action, status)).toBeNull();
    for (const status of ['2.0.0', '2.1.5', '3.1.1', '5.1', '05.1.1', '5.1.1 ', ''])
      expect(classifyDelivery('failed', status)).toBeNull();
  });
});

describe('parseFeedbackReport (RFC 5965)', () => {
  const arf = (
    parts: {
      readonly reportType?: string;
      readonly feedback?: readonly string[];
      readonly returnedType?: string;
      readonly returned?: readonly string[];
    } = {},
  ) =>
    Buffer.from(
      [
        'From: <staff@feedback.example>',
        'To: <fbl@crm.example>',
        'Subject: FW: Earn money',
        'MIME-Version: 1.0',
        `Content-Type: multipart/report; report-type=${parts.reportType ?? 'feedback-report'}; boundary="arf"`,
        '',
        '--arf',
        'Content-Type: text/plain; charset="US-ASCII"',
        '',
        'This is an email abuse report for an email message received from IP 192.0.2.1.',
        '',
        '--arf',
        'Content-Type: message/feedback-report',
        '',
        ...(parts.feedback ?? [
          'Feedback-Type: abuse',
          'User-Agent: SomeGenerator/1.0',
          'Version: 1',
        ]),
        '',
        '--arf',
        `Content-Type: ${parts.returnedType ?? 'message/rfc822'}`,
        'Content-Disposition: inline',
        '',
        ...(parts.returned ?? [
          'From: <shop@crm.example>',
          'To: <customer@example.com>',
          'Message-ID: <crm-outbound.0190f5a8-0000-7000-8000-000000000001@crm.invalid>',
          'Subject: Sale',
          '',
          'Buy now.',
        ]),
        '--arf--',
        '',
      ].join('\r\n'),
    );

  it('reads the feedback type and the reported message id', async () => {
    expect(await parseFeedbackReport(arf())).toEqual({
      feedbackType: 'abuse',
      originalMessageId: '<crm-outbound.0190f5a8-0000-7000-8000-000000000001@crm.invalid>',
    });
    expect(
      await parseFeedbackReport(
        arf({
          returnedType: 'text/rfc822-headers',
          feedback: ['Feedback-Type: ABUSE', 'Version: 1'],
        }),
      ),
    ).toEqual({
      feedbackType: 'abuse',
      originalMessageId: '<crm-outbound.0190f5a8-0000-7000-8000-000000000001@crm.invalid>',
    });
  });

  it('reads nothing it cannot be certain of', async () => {
    expect(await parseFeedbackReport(arf({ reportType: 'delivery-status' }))).toBeNull();
    expect(await parseFeedbackReport(arf({ feedback: ['Version: 1'] }))).toBeNull();
    expect(
      await parseFeedbackReport(
        arf({ feedback: ['Feedback-Type: abuse', 'Feedback-Type: fraud'] }),
      ),
    ).toBeNull();
    expect(await parseFeedbackReport(Buffer.from('not mail at all'))).toBeNull();
    expect(await parseFeedbackReport(Buffer.alloc(6 * 1024 * 1024))).toBeNull();
    expect(
      await parseFeedbackReport(
        arf({ returnedType: 'text/plain', returned: ['Message-ID: <a@b>'] }),
      ),
    ).toEqual({ feedbackType: 'abuse', originalMessageId: null });
  });
});
