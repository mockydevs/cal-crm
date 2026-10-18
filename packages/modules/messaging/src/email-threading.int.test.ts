// A reply from the Inbox belongs to the thread it answers (RFC 5322 section 3.6.4): its
// In-Reply-To is the Message-ID of the mail it answers, its References that mail's
// References and then its Message-ID. Proven on a real mail server (GreenMail): mail is
// read over IMAP by the sync task, answered by the reply command, sent by the real SMTP
// adapter, and the headers are read from what the server delivered.
//
// Every receipt date here is fixed and outside 12:00 to 12:59 UTC: GreenMail 2.1.9
// answers an INTERNALDATE in that hour twelve hours early.
import { randomUUID } from 'node:crypto';

import { threadMessage } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { createMailboxConnector, REPLY_HEADER_LIMITS } from '@repo/mail';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { startGreenMail, type GreenMailServer } from '@repo/testing';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxWorld } from '../test/inbox.js';
import { createSyncMailboxTask } from './inbound.js';
import { queueOutboundMessage } from './outbound.js';
import { createSmtpDispatchTask } from './smtp-outbound.js';

let world: InboxWorld;
let vault: Vault;
let server: GreenMailServer;
let stopMail: (() => Promise<void>) | undefined;

beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  ({ server, stop: stopMail } = await startGreenMail());
});
afterAll(async () => {
  await stopMail?.();
  await world.close();
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

/** The hour of 1 October 2026, UTC, a message reached the team's mailbox. */
const receivedAt = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));

/** Puts a message in the team's inbox, as their mail server would on receiving it. */
async function deliver(source: string, at: Date): Promise<void> {
  await withImap(async (client) => {
    expect(await client.append('INBOX', Buffer.from(source), [], at)).not.toBe(false);
  });
}

const mail = (headers: Record<string, string>, body = 'Hello.') =>
  [
    ...Object.entries({ To: 'inbox@example.test', Subject: 'June 13', ...headers }).map(
      ([key, value]) => `${key}: ${value}`,
    ),
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');

const newId = (name: string) => `<${name}.${randomUUID()}@client.example.test>`;
const ourId = (messageId: string) => `<crm-outbound.${messageId}@crm.invalid>`;

const connector = () =>
  createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
    timeoutMs: 30_000,
  });

interface Delivered {
  /** The header block unfolded, one header a line. */
  readonly headers: readonly string[];
  header(name: string): string[];
}

// GreenMail 2.1.9's own API (its /greenmail-openapi.yml): GET /api/user lists the users
// with their "email", and GET /api/user/{emailOrId}/messages/{folderName} a mailbox, each
// message with its "mimeMessage".
async function deliveredTo(address: string): Promise<Delivered[]> {
  const users: unknown = await (await fetch(`${server.apiUrl}/api/user`)).json();
  if (!Array.isArray(users)) throw new Error('GreenMail listed no users.');
  const known = users.some(
    (user: unknown) =>
      typeof user === 'object' && user !== null && 'email' in user && user.email === address,
  );
  // Nothing was ever delivered to this address.
  if (!known) return [];
  const response = await fetch(
    `${server.apiUrl}/api/user/${encodeURIComponent(address)}/messages/INBOX`,
  );
  if (!response.ok) throw new Error(`GreenMail answered ${String(response.status)}.`);
  const messages: unknown = await response.json();
  if (!Array.isArray(messages)) throw new Error('GreenMail listed no messages.');
  return messages.map((message: unknown) => {
    if (typeof message !== 'object' || message === null || !('mimeMessage' in message))
      throw new Error('A GreenMail message has no source.');
    const raw = String(message.mimeMessage);
    const headers = raw
      .slice(0, raw.search(/\r?\n\r?\n/))
      .replace(/\r?\n[ \t]+/g, ' ')
      .split(/\r?\n/);
    return {
      headers,
      header: (name) =>
        headers
          .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
          .map((line) => line.slice(name.length + 1).trim()),
    };
  });
}

/** A business whose mailbox is the mail server's real account, and one contact. */
async function fixture() {
  const b = await inboxBusiness(world);
  const login = {
    host: 'localhost',
    port: server.imapPort,
    security: 'tls',
    username: server.username,
    password: server.password,
  };
  const settings = {
    name: 'Inbox',
    email: 'inbox@example.test',
    displayName: 'Harbor Lights',
    smtp: { ...login, port: server.smtpPort },
    imap: login,
  };
  const system: TenantContext = { ...b.context, actorKind: 'system', correlationId: randomUUID() };
  const mailboxId = await withTenant(world.db, system, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: b.agency.id, businessId: b.business.id, purpose: 'mailbox.credentials' },
      JSON.stringify(settings),
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: b.business.id, channel: 'email', name: settings.name })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        business_id: b.business.id,
        id: account.id,
        email_address: settings.email,
        display_name: settings.displayName,
        auth_method: 'password',
        smtp_host: 'localhost',
        smtp_port: server.smtpPort,
        smtp_security: 'tls',
        smtp_username: server.username,
        imap_host: 'localhost',
        imap_port: server.imapPort,
        imap_security: 'tls',
        imap_username: server.username,
        secret_id: secretId,
      })
      .execute();
    return account.id;
  });
  const invocation = () => ({
    context: { ...system, correlationId: randomUUID() },
    permissions: 'all' as const,
  });
  const syncTask = createSyncMailboxTask(vault, connector());
  const sync = () =>
    syncTask.run({ mailboxId }, { invocation: invocation(), services: world.services });
  // The first read only marks where the inbox ends: mail before connection isn't read.
  await sync();
  const dispatchTask = createSmtpDispatchTask(
    vault,
    connector(),
    world.db,
    'https://crm.example.test',
  );
  /** Runs a message's delivery job, with the real SMTP adapter unless another is given. */
  const dispatch = async (messageId: string, task = dispatchTask) => {
    // The mailbox paces its sends; here every earlier one is a minute old, so the pace
    // never decides what a test sees.
    await b.query(
      `update messaging.outbound_dispatch set reserved_at = reserved_at - interval '1 minute'
       where reserved_at is not null`,
    );
    await task.run({ messageId }, { invocation: invocation(), services: world.services });
  };

  const address = `maya-${randomUUID().slice(0, 8)}@example.test`;
  const maya = await b.contact({ firstName: 'Maya', email: address });
  const conversationId = async () => {
    const [row] = await b.query<{ id: string }>(
      'select id from messaging.conversations where contact_id = $1',
      [maya.id],
    );
    if (row === undefined) throw new Error('No conversation yet.');
    return row.id;
  };
  /** Sends a reply from the Inbox and returns the stored message's id. */
  const reply = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const sent = threadMessage.parse(
      await world.call('sendConversationReply', b.as(), {
        params: { id: toPublicId('conversation', await conversationId()) },
        body: {
          channel: 'email',
          accountId: toPublicId('channel_account', mailboxId),
          to: maya.emailIdentity,
          subject: 'Re: June 13',
          text: 'Hi Maya, June 13 is open.',
          idempotencyKey: randomUUID().replaceAll('-', ''),
          ...changes,
        },
      }),
    );
    const id = parsePublicId('message', sent.id);
    if (id === undefined) throw new Error('Not a message id.');
    return id;
  };
  /** How a message's place in its thread is stored. */
  const stored = async (messageId: string) => {
    const [row] = await b.query<{
      in_reply_to: string | null;
      email_references: string[];
      parent_message_id: string | null;
      status: string;
    }>(
      `select in_reply_to, email_references, parent_message_id, status
       from messaging.messages where id = $1`,
      [messageId],
    );
    if (row === undefined) throw new Error('No such message.');
    return row;
  };
  const inbound = async (messageId: string) => {
    const [row] = await b.query<{ id: string; parent_message_id: string | null }>(
      `select id, parent_message_id from messaging.messages
       where direction = 'inbound' and email_message_id = $1`,
      [messageId],
    );
    if (row === undefined) throw new Error('That mail was not stored.');
    return row;
  };
  return { b, mailboxId, sync, dispatch, address, maya, reply, stored, inbound, conversationId };
}

it('threads two round trips: each reply names the mail it answers and the whole thread before it', async () => {
  const f = await fixture();

  // She writes first.
  const first = newId('first');
  await deliver(mail({ From: `Maya <${f.address}>`, 'Message-ID': first }), receivedAt(8));
  await f.sync();

  // The team answers from the Inbox, and the mail server delivers it to her.
  const replyOne = await f.reply();
  await f.dispatch(replyOne);
  const [one, ...none] = await deliveredTo(f.address);
  expect(none).toEqual([]);
  expect(one?.header('Message-ID')).toEqual([ourId(replyOne)]);
  expect(one?.header('In-Reply-To')).toEqual([first]);
  expect(one?.header('References')).toEqual([first]);
  expect(one?.header('Subject')).toEqual(['Re: June 13']);
  expect(one?.header('From')).toEqual(['Harbor Lights <inbox@example.test>']);
  expect(await f.stored(replyOne)).toEqual({
    in_reply_to: first,
    email_references: [first],
    parent_message_id: (await f.inbound(first)).id,
    status: 'sent',
  });

  // Her mail program answers ours, as RFC 5322 has it: ours in In-Reply-To, the thread in
  // References. It lands in her conversation, under the reply it answers.
  const second = newId('second');
  await deliver(
    mail(
      {
        From: `Maya <${f.address}>`,
        Subject: 'Re: June 13',
        'Message-ID': second,
        'In-Reply-To': ourId(replyOne),
        References: `${first} ${ourId(replyOne)}`,
      },
      'Wonderful, please hold it for us.',
    ),
    receivedAt(9),
  );
  await f.sync();
  expect((await f.inbound(second)).parent_message_id).toBe(replyOne);

  // The second answer names her second mail, and the thread as her mail gave it.
  const replyTwo = await f.reply({ text: 'It is held for you.' });
  await f.dispatch(replyTwo);
  const [, two, ...more] = await deliveredTo(f.address);
  expect(more).toEqual([]);
  expect(two?.header('Message-ID')).toEqual([ourId(replyTwo)]);
  expect(two?.header('In-Reply-To')).toEqual([second]);
  expect(two?.header('References')).toEqual([`${first} ${ourId(replyOne)} ${second}`]);
  expect(await f.stored(replyTwo)).toEqual({
    in_reply_to: second,
    email_references: [first, ourId(replyOne), second],
    parent_message_id: (await f.inbound(second)).id,
    status: 'sent',
  });

  // The jobs run again: nothing more is sent, so nothing is threaded twice.
  await f.dispatch(replyOne);
  await f.dispatch(replyTwo);
  expect(await deliveredTo(f.address)).toHaveLength(2);

  // A stranger who learned our Message-ID can name it, and still lands in a conversation
  // of their own: the sender's address decides whose conversation it is, never a header.
  const forged = newId('forged');
  await deliver(
    mail({
      From: 'Mallory <mallory@elsewhere.example.test>',
      'Message-ID': forged,
      'In-Reply-To': ourId(replyTwo),
      References: `${first} ${ourId(replyOne)} ${second} ${ourId(replyTwo)}`,
    }),
    receivedAt(10),
  );
  await f.sync();
  const [stranger] = await f.b.query<{
    conversation_id: string;
    parent_message_id: string | null;
    from_address: string;
  }>(
    `select conversation_id, parent_message_id, from_address from messaging.messages
     where email_message_id = $1`,
    [forged],
  );
  expect(stranger).toEqual({
    conversation_id: expect.not.stringMatching(await f.conversationId()) as string,
    parent_message_id: null,
    from_address: 'mallory@elsewhere.example.test',
  });
  // And the next answer to Maya still names Maya's mail, not the stranger's.
  const replyThree = await f.reply({ text: 'See you on the 13th.' });
  expect((await f.stored(replyThree)).in_reply_to).toBe(second);
});

it('threads our own messages together when we wrote first', async () => {
  const f = await fixture();
  // A message that answers nothing, such as a confirmation: it starts the thread.
  const opening = await withTenant(world.db, f.b.context, (trx) =>
    queueOutboundMessage(trx, f.b.context, {
      identityId: parsePublicId('contact_identity', f.maya.emailIdentity) ?? '',
      accountId: f.mailboxId,
      channel: 'email',
      purpose: 'transactional',
      lane: 'transactional',
      idempotencyKey: randomUUID(),
      subject: 'Your visit on June 13',
      text: 'See you then.',
    }),
  );
  await f.dispatch(opening);
  const [sent] = await deliveredTo(f.address);
  expect(sent?.header('Message-ID')).toEqual([ourId(opening)]);
  expect(sent?.header('In-Reply-To')).toEqual([]);
  expect(sent?.header('References')).toEqual([]);
  expect(await f.stored(opening)).toMatchObject({
    in_reply_to: null,
    email_references: [],
    parent_message_id: null,
  });

  // A follow-up from the Inbox answers our own last message.
  const followUp = await f.reply({ subject: 'Re: Your visit on June 13', text: 'One more thing.' });
  // A message that never left is nobody's parent: this one is refused by the mail server.
  const refused = await f.reply({ text: 'This one is refused.' });
  await f.dispatch(
    refused,
    createSmtpDispatchTask(
      vault,
      { submit: () => Promise.resolve({ outcome: 'rejected', temporary: false }) },
      world.db,
      'https://crm.example.test',
    ),
  );
  expect((await f.stored(refused)).status).toBe('failed');
  // Written while the follow-up was still waiting to be sent: it too answers the opening.
  expect(await f.stored(refused)).toMatchObject({
    in_reply_to: ourId(opening),
    parent_message_id: opening,
  });
  await f.dispatch(followUp);
  const [, second] = await deliveredTo(f.address);
  expect(second?.header('In-Reply-To')).toEqual([ourId(opening)]);
  expect(second?.header('References')).toEqual([ourId(opening)]);

  // The next one answers the follow-up, the newest that was sent, and keeps the thread.
  const third = await f.reply({ text: 'And another.' });
  await f.dispatch(third);
  const [, , last, ...more] = await deliveredTo(f.address);
  expect(more).toEqual([]);
  expect(last?.header('In-Reply-To')).toEqual([ourId(followUp)]);
  expect(last?.header('References')).toEqual([`${ourId(opening)} ${ourId(followUp)}`]);
  expect(await f.stored(third)).toEqual({
    in_reply_to: ourId(followUp),
    email_references: [ourId(opening), ourId(followUp)],
    parent_message_id: followUp,
    status: 'sent',
  });
});

it('never lets what a sender wrote in their headers become a header of ours', async () => {
  const f = await fixture();
  const kept = newId('kept');
  const parent = newId('parent');
  const tooLong = `<${'a'.repeat(REPLY_HEADER_LIMITS.msgIdChars)}@client.example.test>`;
  // Each of these is read and stored as it came (the inbound reader is lenient, so mail
  // still threads coming in). None of them is a msg-id of today's syntax.
  await deliver(
    mail({
      From: f.address,
      'Message-ID': parent,
      References: `${kept} <"quoted"@client.example.test> <com(ment)@client.example.test> <é@client.example.test> <semi;colon@client.example.test> ${tooLong}`,
    }),
    receivedAt(8),
  );
  await f.sync();
  const [received] = await f.b.query<{ email_references: string[] }>(
    'select email_references from messaging.messages where email_message_id = $1',
    [parent],
  );
  expect(received?.email_references).toHaveLength(6);

  const safe = await f.reply();
  await f.dispatch(safe);
  const [one] = await deliveredTo(f.address);
  expect(one?.header('In-Reply-To')).toEqual([parent]);
  expect(one?.header('References')).toEqual([`${kept} ${parent}`]);
  expect(await f.stored(safe)).toMatchObject({
    in_reply_to: parent,
    email_references: [kept, parent],
  });

  // Whatever reaches the stored row by any other road is held to the same rule. A later
  // mail of hers, whose stored Message-ID and References carry line breaks and headers:
  const later = newId('later');
  await deliver(mail({ From: f.address, 'Message-ID': later }), receivedAt(9));
  await f.sync();
  await f.b.query(
    `update messaging.messages
     set email_message_id = $2, email_references = $3
     where email_message_id = $1`,
    [
      later,
      `${later}\r\nBcc: victim@example.test\r\nX-Injected: 1`,
      [kept, `${parent}\r\nX-Injected: 2`, '<a@b>\n\nA body of their own', 'not an id'],
    ],
  );
  const guarded = await f.reply({ text: 'Still only ours.' });
  expect(await f.stored(guarded)).toMatchObject({ in_reply_to: null, email_references: [kept] });
  await f.dispatch(guarded);
  const [, two] = await deliveredTo(f.address);
  expect(two?.header('In-Reply-To')).toEqual([]);
  expect(two?.header('References')).toEqual([kept]);
  expect(two?.header('Bcc')).toEqual([]);
  expect(two?.header('X-Injected')).toEqual([]);
  expect(two?.headers.join('\n')).not.toMatch(/victim@example\.test|A body of their own/);
  expect(await deliveredTo('victim@example.test')).toEqual([]);

  // And a row changed after the reply was written is checked once more on its way out.
  const tampered = await f.reply({ text: 'Checked at the door as well.' });
  await f.b.query(
    'update messaging.messages set in_reply_to = $2, email_references = $3 where id = $1',
    [tampered, `${kept}\r\nX-Injected: 3`, [`${kept}\r\nX-Injected: 4`, kept]],
  );
  await f.dispatch(tampered);
  const [, , three] = await deliveredTo(f.address);
  expect(three?.header('In-Reply-To')).toEqual([]);
  expect(three?.header('References')).toEqual([kept]);
  expect(three?.header('X-Injected')).toEqual([]);
});

it('keeps a long thread within one header line: the first id and the newest stay', async () => {
  const f = await fixture();
  const thread = Array.from({ length: 40 }, (_, index) => newId(`t${String(index)}`));
  const parent = newId('parent');
  await deliver(
    mail({ From: f.address, 'Message-ID': parent, References: thread.join(' ') }),
    receivedAt(8),
  );
  await f.sync();
  const answer = await f.reply();
  await f.dispatch(answer);
  const [one] = await deliveredTo(f.address);
  const [references] = one?.header('References') ?? [];
  const ids = (references ?? '').split(' ');
  expect(`References: ${references ?? ''}`.length).toBeLessThanOrEqual(
    REPLY_HEADER_LIMITS.headerChars,
  );
  expect(ids.length).toBeLessThan(41);
  expect(ids[0]).toBe(thread[0]);
  expect(ids.slice(1)).toEqual([...thread, parent].slice(-(ids.length - 1)));
  expect(one?.header('In-Reply-To')).toEqual([parent]);
  expect((await f.stored(answer)).email_references).toEqual(ids);
});

it('answers the latest mail from the address written to, and follows RFC 5322 for a parent without ids', async () => {
  const f = await fixture();
  // Her other address, which the contact also holds.
  const other = `maya-home-${randomUUID().slice(0, 8)}@example.test`;
  await f.b.query(
    `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
     values (app.business_id(), $1, 'email', $2, $2)`,
    [f.maya.id, other],
  );
  const [otherIdentity] = await f.b.query<{ id: string }>(
    'select id from crm.contact_identities where value_normalized = $1',
    [other],
  );
  const fromWork = newId('work');
  const earlier = newId('earlier');
  const fromHome = newId('home');
  await deliver(
    mail({ From: f.address, 'Message-ID': fromWork, 'In-Reply-To': earlier }),
    receivedAt(8),
  );
  await deliver(mail({ From: other, 'Message-ID': fromHome }), receivedAt(9));
  await f.sync();

  // A parent with no References and one id in In-Reply-To: that id, then its own.
  const toWork = await f.reply();
  expect(await f.stored(toWork)).toMatchObject({
    in_reply_to: fromWork,
    email_references: [earlier, fromWork],
    parent_message_id: (await f.inbound(fromWork)).id,
  });
  // Her other address is answered with the mail that came from it: a Message-ID means
  // nothing to a mailbox that never held the message.
  const toHome = await f.reply({
    to: toPublicId('contact_identity', otherIdentity?.id ?? ''),
  });
  expect(await f.stored(toHome)).toMatchObject({
    in_reply_to: fromHome,
    email_references: [fromHome],
    parent_message_id: (await f.inbound(fromHome)).id,
  });

  // More than one id in In-Reply-To and no References: only the parent's own id.
  const twoParents = newId('two-parents');
  await deliver(
    mail({ From: f.address, 'Message-ID': twoParents, 'In-Reply-To': `${earlier} ${fromWork}` }),
    receivedAt(10),
  );
  await f.sync();
  expect(await f.stored(await f.reply())).toMatchObject({
    in_reply_to: twoParents,
    email_references: [twoParents],
  });

  // Her latest mail has no Message-ID at all: the answer names no parent, and keeps the
  // thread her mail gave.
  await deliver(
    mail({ From: f.address, References: `${earlier} ${fromWork}` }, 'No Message-ID here.'),
    receivedAt(11),
  );
  await f.sync();
  const [unnamed] = await f.b.query<{ id: string }>(
    `select id from messaging.messages
     where direction = 'inbound' and email_message_id is null and from_address = $1`,
    [f.address],
  );
  expect(await f.stored(await f.reply())).toMatchObject({
    in_reply_to: null,
    email_references: [earlier, fromWork],
    parent_message_id: unnamed?.id,
  });
});

it('keeps a reply sent again the same message, in the thread it was written in', async () => {
  const f = await fixture();
  const first = newId('first');
  await deliver(mail({ From: f.address, 'Message-ID': first }), receivedAt(8));
  await f.sync();
  const idempotencyKey = randomUUID().replaceAll('-', '');
  const written = await f.reply({ idempotencyKey });
  // She writes again before the same request is repeated.
  const newer = newId('newer');
  await deliver(mail({ From: f.address, 'Message-ID': newer }), receivedAt(9));
  await f.sync();
  expect(await f.reply({ idempotencyKey })).toBe(written);
  expect(await f.stored(written)).toMatchObject({
    in_reply_to: first,
    email_references: [first],
  });
  // A text message is in no email thread.
  const phone = '+254700000077';
  await f.b.query(
    `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
     values (app.business_id(), $1, 'phone', $2, $2)`,
    [f.maya.id, phone],
  );
  const [phoneIdentity] = await f.b.query<{ id: string }>(
    'select id from crm.contact_identities where value_normalized = $1',
    [phone],
  );
  const sms = await f.b.smsAccount();
  const text = await withTenant(world.db, f.b.context, (trx) =>
    queueOutboundMessage(trx, f.b.context, {
      identityId: phoneIdentity?.id ?? '',
      accountId: sms.id,
      channel: 'sms',
      purpose: 'transactional',
      lane: 'reply',
      idempotencyKey: randomUUID(),
      text: 'By text.',
    }),
  );
  expect(await f.stored(text)).toMatchObject({
    in_reply_to: null,
    email_references: [],
    parent_message_id: null,
  });
});
