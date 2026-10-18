// What the "Inbox day" test (tests/checkpoint-1c.spec.ts) uses to be the world outside the
// install: a contact's own mail program, a contact's phone, and Twilio. None of it is the
// product: the mail goes through the test run's GreenMail, and text messages through the
// local stand-in for Twilio (apps/server/test/fake-twilio.ts).
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

import pg from 'pg';

import {
  postTwilioWebhook,
  type FakeTwilioAccount,
  type FakeTwilioState,
} from '../apps/server/test/fake-twilio.js';
import { address, type InboxDayMailServer } from './servers.js';

/** Reads or writes the "Inbox day" install's database as crm_owner. */
export async function dayQuery<Row extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: address('inboxDayDatabase') });
  await client.connect();
  try {
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

// What comes back over HTTP is read field by field: this package has no schema library.
function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return Object.fromEntries(Object.entries(value));
}
function listOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a list.');
  const list: unknown[] = value;
  return list;
}
function textOf(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value;
}
function numberOf(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Expected a number.');
  return value;
}

export function mailServer(): InboxDayMailServer {
  const server = objectOf(JSON.parse(address('mailServer')));
  return {
    address: textOf(server['address']),
    smtpPort: numberOf(server['smtpPort']),
    imapPort: numberOf(server['imapPort']),
    plainSmtpPort: numberOf(server['plainSmtpPort']),
    username: textOf(server['username']),
    password: textOf(server['password']),
    apiUrl: textOf(server['apiUrl']),
  };
}

/**
 * Sends one plain-text email to the mail server, as another mail server would: SMTP on
 * its plain port, with no sign-in (RFC 5321). GreenMail delivers it to the recipient's
 * mailbox, making the mailbox if nobody has written to that address before.
 */
export async function sendMailFromOutside(mail: {
  readonly from: { readonly name: string; readonly address: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Without the angle brackets. */
  readonly messageId: string;
  /** The Message-ID this one answers, without the angle brackets. */
  readonly inReplyTo?: string;
}): Promise<void> {
  const server = mailServer();
  const socket = connect({ host: server.address, port: server.plainSmtpPort });
  socket.setEncoding('utf8');
  let buffered = '';
  const waiting: ((reply: string) => void)[] = [];
  const replies: string[] = [];
  const failure = new Promise<never>((_resolve, reject) => {
    socket.once('error', reject);
    socket.setTimeout(15_000, () => {
      reject(new Error('The mail server did not answer in time.'));
    });
  });
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    for (;;) {
      // A reply ends with a line whose code is followed by a space ("250-" continues).
      const lines = buffered.split('\r\n');
      const last = lines.findIndex((line) => /^\d{3} /.test(line));
      if (last < 0) return;
      const reply = lines.slice(0, last + 1).join('\n');
      buffered = lines.slice(last + 1).join('\r\n');
      const next = waiting.shift();
      if (next === undefined) replies.push(reply);
      else next(reply);
    }
  });
  const reply = (): Promise<string> => {
    const ready = replies.shift();
    return ready === undefined
      ? Promise.race([new Promise<string>((resolve) => waiting.push(resolve)), failure])
      : Promise.resolve(ready);
  };
  const expectCode = async (code: string): Promise<void> => {
    const answer = await reply();
    if (!answer.split('\n').at(-1)?.startsWith(`${code} `))
      throw new Error(`The mail server answered ${answer} where ${code} was expected.`);
  };
  const say = async (line: string, code: string): Promise<void> => {
    socket.write(`${line}\r\n`);
    await expectCode(code);
  };
  // Headers are made here, so a line break in a value would start a new header.
  for (const value of [mail.from.name, mail.from.address, mail.to, mail.subject, mail.messageId])
    if (/[\r\n]/.test(value)) throw new Error('A header value has a line break.');
  const body = mail.text
    .split(/\r?\n/)
    // A line that starts with a dot gets a second one (RFC 5321, 4.5.2).
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
  try {
    await expectCode('220');
    await say('EHLO mail.example.test', '250');
    await say(`MAIL FROM:<${mail.from.address}>`, '250');
    await say(`RCPT TO:<${mail.to}>`, '250');
    await say('DATA', '354');
    await say(
      [
        `From: ${mail.from.name} <${mail.from.address}>`,
        `To: <${mail.to}>`,
        `Subject: ${mail.subject}`,
        `Message-ID: <${mail.messageId}>`,
        ...(mail.inReplyTo === undefined
          ? []
          : [`In-Reply-To: <${mail.inReplyTo}>`, `References: <${mail.inReplyTo}>`]),
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        body,
        '.',
      ].join('\r\n'),
      '250',
    );
    await say('QUIT', '221');
  } finally {
    socket.destroy();
  }
}

// GreenMail 2.1.9 lists a mailbox as an array of messages with "subject" and "mimeMessage"
// among their fields, and its users with "email" (its own /greenmail-openapi.yml:
// GET /api/user and GET /api/user/{emailOrId}/messages/{folderName}).
export interface DeliveredMail {
  readonly subject: string;
  /** The whole message as the mail server holds it, headers first. */
  readonly raw: string;
}

/** The mail the server holds for this address: what was delivered to them, oldest first. */
export async function mailDeliveredTo(recipient: string): Promise<DeliveredMail[]> {
  const server = mailServer();
  const users = listOf(await (await fetch(`${server.apiUrl}/api/user`)).json()).map((user) =>
    textOf(objectOf(user)['email']).toLowerCase(),
  );
  // Nobody has written to this address yet.
  if (!users.includes(recipient.toLowerCase())) return [];
  const response = await fetch(
    `${server.apiUrl}/api/user/${encodeURIComponent(recipient)}/messages/INBOX`,
  );
  if (!response.ok) throw new Error(`GreenMail answered ${String(response.status)}.`);
  return listOf(await response.json()).map((each) => {
    const message = objectOf(each);
    return { subject: textOf(message['subject']), raw: textOf(message['mimeMessage']) };
  });
}

function accountOf(value: unknown): FakeTwilioAccount {
  const account = objectOf(value);
  return {
    accountSid: textOf(account['accountSid']),
    authToken: textOf(account['authToken']),
    numberSid: textOf(account['numberSid']),
    number: textOf(account['number']),
  };
}
const requestOf = (value: unknown): { method: string; path: string } => {
  const request = objectOf(value);
  return { method: textOf(request['method']), path: textOf(request['path']) };
};
function stateOf(value: unknown): FakeTwilioState {
  const state = objectOf(value);
  return {
    reads: listOf(state['reads']).map(requestOf),
    unexpected: listOf(state['unexpected']).map(requestOf),
    messages: listOf(state['messages']).map((each) => {
      const message = objectOf(each);
      const sid = message['sid'];
      return {
        accountSid: textOf(message['accountSid']),
        sid: sid === null ? null : textOf(sid),
        contentType: textOf(message['contentType']),
        authorization: textOf(message['authorization']),
        form: listOf(message['form']).map((pair): readonly [string, string] => {
          const [name, content] = listOf(pair);
          return [textOf(name), textOf(content)];
        }),
        answered: numberOf(message['answered']),
      };
    }),
  };
}

/** The stand-in for Twilio, from the test's process. */
export const twilio = {
  /** A new made-up account with one number, whose credentials the stand-in accepts. */
  async newAccount(): Promise<FakeTwilioAccount> {
    const response = await fetch(`${address('twilio')}/__fake/accounts`, { method: 'POST' });
    return accountOf(await response.json());
  },
  /** Every request the stand-in has received. */
  async state(): Promise<FakeTwilioState> {
    return stateOf(await (await fetch(`${address('twilio')}/__fake/state`)).json());
  },
  /** The next CreateMessage gets no readable answer, as when something in between fails. */
  async failNextCreateUnreadably(): Promise<void> {
    const response = await fetch(`${address('twilio')}/__fake/next-create`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'unreadable', status: 502 }),
    });
    if (response.status !== 204) throw new Error('The stand-in did not take the instruction.');
  },
  /**
   * Posts a webhook as Twilio does: signed for the public URL it was given, delivered to
   * the server itself (Twilio would go through the public address; the signature is the
   * same either way, since it covers the public URL).
   */
  async post(
    account: FakeTwilioAccount,
    url: string,
    params: Readonly<Record<string, string>>,
  ): Promise<void> {
    const answer = await postTwilioWebhook({
      url,
      deliverTo: address('inboxDayDirect'),
      authToken: account.authToken,
      params,
    });
    if (answer.status !== 200 || answer.body !== '<Response/>')
      throw new Error(`The webhook was answered ${String(answer.status)}: ${answer.body}`);
  },
  newMessageSid: (): string => `SM${randomBytes(16).toString('hex')}`,
};
