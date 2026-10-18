import { mailbox, startMailpit, type Mailbox, type MailpitServer } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMailer, type Mailer } from './index.js';

let server: MailpitServer;
let stop: () => Promise<void>;
let mail: Mailbox;
let mailer: Mailer;

beforeAll(async () => {
  ({ server, stop } = await startMailpit());
  mail = mailbox(server);
  mailer = createMailer({ url: server.smtpUrl, from: 'Bluebird Digital <crm@bluebird.example>' });
});

afterAll(async () => {
  mailer.close();
  await stop();
});

beforeEach(() => mail.clear());

describe('createMailer', () => {
  it('delivers a message from the install, with its text and HTML', async () => {
    await mailer.send({
      to: 'dana@harborlights.example',
      subject: 'Sign in to Bluebird Digital',
      text: 'Open this link to sign in: https://crm.example.com/x',
      html: '<p>Open <a href="https://crm.example.com/x">this link</a> to sign in.</p>',
    });

    expect(await mail.messagesTo('dana@harborlights.example')).toEqual([
      {
        id: expect.any(String) as unknown,
        from: 'crm@bluebird.example',
        to: ['dana@harborlights.example'],
        subject: 'Sign in to Bluebird Digital',
        text: expect.stringContaining('https://crm.example.com/x') as unknown,
        html: expect.stringContaining('<a href="https://crm.example.com/x">') as unknown,
      },
    ]);
  });

  it('sends text alone when there is no HTML', async () => {
    await mailer.send({ to: 'sam@example.com', subject: 'Plain', text: 'Just text.' });

    const [message] = await mail.messagesTo('sam@example.com');
    expect(message?.text.trim()).toBe('Just text.');
    expect(message?.html).toBe('');
  });

  it('fails the send when the mail server can’t be reached', async () => {
    const unreachable = createMailer({ url: 'smtp://127.0.0.1:1', from: 'crm@bluebird.example' });
    try {
      await expect(
        unreachable.send({ to: 'dana@harborlights.example', subject: 'Lost', text: 'Lost' }),
      ).rejects.toThrow();
    } finally {
      unreachable.close();
    }
  });
});

describe("@repo/testing's Mailpit", () => {
  it('shows each person only their own mail, and clears it', async () => {
    await mailer.send({ to: 'one@example.com', subject: 'For one', text: '1' });
    await mailer.send({ to: 'two@example.com', subject: 'For two', text: '2' });

    expect((await mail.messagesTo('ONE@example.com')).map((each) => each.subject)).toEqual([
      'For one',
    ]);
    await mail.clear();
    expect(await mail.messagesTo('one@example.com')).toEqual([]);
  });

  it('says which request Mailpit refused', async () => {
    const elsewhere = mailbox({ ...server, apiUrl: `${server.apiUrl}/nowhere` });

    await expect(elsewhere.clear()).rejects.toThrow(/^Mailpit answered 4\d\d to \/messages\.$/);
  });
});
