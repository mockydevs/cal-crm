// A message submitted with a file, over strict TLS to a real SMTP server: the file arrives
// as an attachment with its name and type, and nothing but the bytes handed over can be
// attached.
import { mailbox, startTlsMailpit, type TlsMailpitServer } from '@repo/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createMailboxConnector, type MailServerLogin } from './index.js';

let mail: TlsMailpitServer;
let stop: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ server: mail, stop } = await startTlsMailpit());
});
afterAll(async () => {
  await stop?.();
});

const PDF = Buffer.from('%PDF-1.3\n% a fixture, not a document\n%%EOF\n');
const from = { address: 'billing@example.test', name: 'Billing' };

function connection() {
  const connector = createMailboxConnector({
    ca: mail.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([mail.address]),
  });
  const login: MailServerLogin = {
    host: 'localhost',
    port: mail.smtpPort,
    security: 'tls',
    username: mail.username,
    password: mail.password,
  };
  return { connector, login };
}

const rawOf = async (recipient: string): Promise<string> => {
  const [caught] = await mailbox(mail).messagesTo(recipient);
  if (caught === undefined) throw new Error(`Nothing was sent to ${recipient}.`);
  return (await fetch(`${mail.apiUrl}/api/v1/message/${caught.id}/raw`)).text();
};

it('sends a file with a message as an attachment, with its name, type and bytes', async () => {
  const { connector, login } = connection();
  expect(
    await connector.submit(login, from, {
      messageId: '<crm-outbound.attached@crm.invalid>',
      to: 'attached@example.test',
      subject: 'Invoice INV-0007',
      text: 'Here is invoice INV-0007.',
      attachments: [
        { filename: 'INV-0007.pdf', contentType: 'application/pdf', content: PDF },
        {
          filename: 'notes.txt',
          contentType: 'text/plain',
          content: new TextEncoder().encode('Thank you.'),
        },
      ],
    }),
  ).toEqual({ outcome: 'accepted', messageId: '<crm-outbound.attached@crm.invalid>' });
  const raw = await rawOf('attached@example.test');
  expect(raw).toMatch(/Content-Type: multipart\/mixed/);
  expect(raw).toMatch(/Content-Type: application\/pdf; name="?INV-0007\.pdf"?/);
  expect(raw).toMatch(/Content-Disposition: attachment; filename="?INV-0007\.pdf"?/);
  expect(raw).toContain(PDF.toString('base64'));
  expect(raw).toMatch(/Content-Disposition: attachment; filename="?notes\.txt"?/);
  expect(raw).toContain('Here is invoice INV-0007.');
});

it('sends a message with no files, or an empty list of them, as plain text', async () => {
  const { connector, login } = connection();
  await connector.submit(login, from, {
    messageId: '<crm-outbound.bare@crm.invalid>',
    to: 'bare@example.test',
    subject: 'Plain',
    text: 'Body',
    attachments: [],
  });
  const raw = await rawOf('bare@example.test');
  expect(raw).not.toMatch(/multipart\/mixed/);
  expect(raw).not.toMatch(/Content-Disposition: attachment/);
});

it('attaches nothing a caller names by path or address instead of handing over', async () => {
  const { connector, login } = connection();
  // A runtime caller may carry fields the typed port has none of: a path on the server's
  // disk, or an address to fetch. Neither is read.
  const hostile = {
    messageId: '<crm-outbound.hostile-file@crm.invalid>',
    to: 'hostile-file@example.test',
    subject: 'Hostile',
    text: 'Body',
    attachments: [
      {
        filename: 'passwd.txt',
        contentType: 'text/plain',
        content: new TextEncoder().encode('only this'),
        path: '/etc/passwd',
        href: 'https://attacker.example.test/secret',
      },
    ],
  };
  expect(await connector.submit(login, from, hostile)).toEqual({
    outcome: 'accepted',
    messageId: '<crm-outbound.hostile-file@crm.invalid>',
  });
  const raw = await rawOf('hostile-file@example.test');
  expect(raw).toContain(Buffer.from('only this').toString('base64'));
  expect(raw).not.toContain('root:');
});

it('sends a calendar invite as a text/calendar part whose method is the invite’s (RFC 6047 2.4)', async () => {
  const { connector, login } = connection();
  const content = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Open CRM//Booking//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:fixture@crm.example.test',
    'DTSTAMP:20261014T180000Z',
    'DTSTART:20261103T150000Z',
    'DTEND:20261103T160000Z',
    'SUMMARY:Consultation',
    'ORGANIZER:mailto:billing@example.test',
    'ATTENDEE:mailto:invited@example.test',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  expect(
    await connector.submit(login, from, {
      messageId: '<crm-outbound.invite@crm.invalid>',
      to: 'invited@example.test',
      subject: 'Your appointment is booked',
      text: 'Your appointment is booked.',
      calendarInvite: { method: 'REQUEST', content },
    }),
  ).toEqual({ outcome: 'accepted', messageId: '<crm-outbound.invite@crm.invalid>' });
  const raw = await rawOf('invited@example.test');
  expect(raw).toMatch(/Content-Type: multipart\/alternative/);
  expect(raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REQUEST/);
  expect(raw).toMatch(/Content-Type: application\/ics; name="?invite\.ics"?/);
  expect(raw).toContain('Your appointment is booked.');
});
