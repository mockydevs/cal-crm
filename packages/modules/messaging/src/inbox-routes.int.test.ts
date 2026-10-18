// The Inbox API's routes as the server runs them: a team's day in the inbox with every
// answer checked against the schema the API documents, each permission enforced, and
// nothing of another business ever shown. Real Postgres.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import {
  conversation,
  conversationComposer,
  conversationList,
  conversationThread,
  threadMessage,
  threadNote,
  type Permission,
} from '@repo/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxWorld } from '../test/inbox.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const key = () => randomUUID().replaceAll('-', '');

it('serves every operation of the inbox contract, once each', () => {
  expect(world.routes.map((route) => route.endpoint.operationId).sort()).toEqual(
    [
      'addConversationNote',
      'assignConversation',
      // Many conversations at once, from the list's selection.
      'bulkUpdateConversations',
      'getConversation',
      'getConversationComposer',
      // The Dashboard's email numbers are read here too (email-report.ts).
      'getEmailReport',
      'getInboxSummary',
      'listConversationAssignees',
      'listConversationMessages',
      'listConversations',
      'markConversationRead',
      'sendConversationReply',
      'setConversationStatus',
    ].sort(),
  );
  const paths = world.routes.map((route) => `${route.endpoint.method} ${route.endpoint.path}`);
  expect(new Set(paths).size).toBe(paths.length);
  // Every write names the command whose permission it needs.
  for (const route of world.routes)
    expect(route.command !== undefined, route.endpoint.operationId).toBe(
      route.endpoint.method !== 'get',
    );
});

it('takes a team through a day in the inbox', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact({ firstName: 'Maya', lastName: 'Thompson' });
  const box = await b.mailbox({ address: 'hello@harborlights.test' });
  const first = await b.receive(maya, box.id, 'Is June 13 still open?', { subject: 'June 13' });
  const params = { id: toPublicId('conversation', first.conversationId) };

  expect(await world.call('getInboxSummary', me)).toEqual({
    unreadConversations: 1,
    unreadMessages: 1,
    needsReply: 1,
  });
  const list = conversationList.parse(await world.call('listConversations', me));
  expect(list).toMatchObject({
    canManage: true,
    canReply: true,
    nextCursor: null,
    items: [
      {
        id: params.id,
        contact: { id: maya.publicId, name: 'Maya Thompson', trashed: false },
        status: 'open',
        snoozedUntil: null,
        assignee: null,
        needsReply: true,
        unreadCount: 1,
        lastMessage: {
          preview: 'Is June 13 still open?',
          direction: 'inbound',
          channel: 'email',
          status: 'received',
        },
        canManage: true,
        canReply: true,
      },
    ],
  });
  // Who it can be given to: the people tenancy's port lists, with names.
  const sam = await world.member(b.business.id, 'Sam Lee');
  expect(await world.call('listConversationAssignees', me)).toEqual({
    items: [{ id: sam.membershipId, name: 'Sam Lee', you: false }],
    nextCursor: null,
  });
  expect(await world.call('getConversation', me, { params })).toEqual(list.items[0]);

  const thread = conversationThread.parse(
    await world.call('listConversationMessages', me, { params }),
  );
  expect(thread.nextCursor).toBeNull();
  expect(thread.items).toMatchObject([
    {
      kind: 'message',
      id: toPublicId('message', first.messageId),
      direction: 'inbound',
      channel: 'email',
      account: { id: box.publicId, address: 'hello@harborlights.test' },
      author: { kind: 'contact', name: 'Maya Thompson', you: false },
      status: 'received',
      problem: null,
      held: null,
      subject: 'June 13',
      text: 'Is June 13 still open?',
      textTruncated: false,
      from: maya.email,
      attachments: [],
    },
  ]);

  expect(
    conversationComposer.parse(await world.call('getConversationComposer', me, { params })),
  ).toEqual({
    canReply: true,
    channels: [
      {
        channel: 'email',
        available: true,
        unavailable: null,
        accounts: [{ id: box.publicId, name: box.address, address: box.address }],
        recipients: [{ id: maya.emailIdentity, address: maya.email, primary: true }],
      },
      {
        channel: 'sms',
        available: false,
        unavailable: {
          code: 'channel_unavailable',
          message: "Text messages can't be sent: this install isn't set up to deliver them.",
        },
        accounts: [],
        recipients: [],
      },
      {
        channel: 'webchat',
        available: false,
        unavailable: {
          code: 'no_recipient',
          message: 'This contact has not written through web chat.',
        },
        accounts: [],
        recipients: [],
      },
    ],
    suggestedSubject: 'Re: June 13',
    suggestedChannel: 'email',
  });

  const mine = conversation.parse(
    await world.call('assignConversation', me, {
      params,
      body: { assignee: 'me', revision: list.items[0]?.revision },
    }),
  );
  expect(mine.assignee).toMatchObject({ name: 'Dana Brooks', you: true });
  // The view the assignment was made from is now stale.
  await expect(
    world.call('setConversationStatus', me, {
      params,
      body: { status: 'closed', revision: list.items[0]?.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    world.call('assignConversation', me, {
      params,
      body: { assignee: null, revision: list.items[0]?.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await world.call('getConversation', me, { params })).toEqual(mine);

  const note = threadNote.parse(
    await world.call('addConversationNote', me, {
      params,
      body: { text: '  She prefers texts. Ask about video too.  ', idempotencyKey: key() },
    }),
  );
  expect(note).toMatchObject({
    kind: 'note',
    text: 'She prefers texts. Ask about video too.',
    author: { kind: 'user', name: 'Dana Brooks', you: true },
  });
  // A note is not an answer, and reading is its own act.
  expect(await world.call('getConversation', me, { params })).toMatchObject({
    needsReply: true,
    unreadCount: 1,
    lastMessage: { preview: 'Is June 13 still open?' },
  });
  expect(
    await world.call('markConversationRead', me, { params, body: { through: note.id } }),
  ).toMatchObject({ unreadCount: 0, needsReply: true });

  const sent = threadMessage.parse(
    await world.call('sendConversationReply', me, {
      params,
      body: {
        channel: 'email',
        accountId: box.publicId,
        to: maya.emailIdentity,
        subject: 'Re: June 13',
        text: 'Hi Maya, June 13 is open.',
        idempotencyKey: key(),
      },
    }),
  );
  expect(sent).toMatchObject({
    kind: 'message',
    direction: 'outbound',
    channel: 'email',
    status: 'queued',
    problem: null,
    held: null,
    to: [maya.email],
    author: { kind: 'user', name: 'Dana Brooks', you: true },
    account: { id: box.publicId },
  });
  expect(await world.call('getInboxSummary', me)).toEqual({
    unreadConversations: 0,
    unreadMessages: 0,
    needsReply: 0,
  });
  expect(await b.dispatch(parsePublicId('message', sent.id) ?? '')).toBe(1);
  const after = conversationThread.parse(
    await world.call('listConversationMessages', me, { params }),
  );
  expect(
    after.items.map((item) => [item.kind, item.kind === 'message' ? item.status : null]),
  ).toEqual([
    ['message', 'sent'],
    ['note', null],
    ['message', 'received'],
  ]);

  const snoozed = conversation.parse(
    await world.call('setConversationStatus', me, {
      params,
      body: { status: 'snoozed', until: future(), revision: mine.revision },
    }),
  );
  expect(snoozed).toMatchObject({ status: 'snoozed', needsReply: false });
  expect(snoozed.snoozedUntil).not.toBeNull();
  expect(await world.call('listConversations', me)).toMatchObject({ items: [] });
  expect(await world.call('listConversations', me, { query: { status: 'snoozed' } })).toMatchObject(
    { items: [{ id: params.id }] },
  );
  const closed = conversation.parse(
    await world.call('setConversationStatus', me, {
      params,
      body: { status: 'closed', revision: snoozed.revision },
    }),
  );
  expect(closed).toMatchObject({ status: 'closed', snoozedUntil: null });
  expect(
    await world.call('setConversationStatus', me, {
      params,
      body: { status: 'open', revision: closed.revision },
    }),
  ).toMatchObject({ status: 'open' });
  // Leaving it unassigned again.
  const reopened = conversation.parse(await world.call('getConversation', me, { params }));
  expect(
    await world.call('assignConversation', me, {
      params,
      body: { assignee: null, revision: reopened.revision },
    }),
  ).toMatchObject({ assignee: null });

  // What happened is on record, without the words of the note or the reply.
  const events = await b.events();
  expect(events.map((event) => event.type)).toEqual([
    'conversation.assigned',
    'conversation.note_added',
    'conversation.read',
    'message.submitted',
    'conversation.snoozed',
    'conversation.closed',
    'conversation.opened',
    'conversation.unassigned',
  ]);
  // An assignment says who the conversation was given to, for whoever is told of it
  // later (the notifications job); taking it away again names nobody.
  expect(events.find((event) => event.type === 'conversation.assigned')?.payload).toEqual({
    contactId: maya.publicId,
    assignedUserId: me.context.userId,
  });
  expect(events.find((event) => event.type === 'conversation.unassigned')?.payload).toEqual({
    contactId: maya.publicId,
  });
  const audit = await b.audit();
  expect(audit.map((row) => row.command)).toContain('conversation.reply');
  for (const recorded of [JSON.stringify(events), JSON.stringify(audit)]) {
    expect(recorded).not.toContain('prefers texts');
    expect(recorded).not.toContain('June 13 is open');
    expect(recorded).not.toContain(maya.email);
  }
});

it('lets any member read, and keeps each change to its permission', async () => {
  const b = await inboxBusiness(world);
  const maya = await b.contact();
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Hello');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const as = (...permissions: Permission[]): Invocation => b.as(new Set(permissions));
  const member = as();
  const current = conversation.parse(await world.call('getConversation', member, { params }));

  for (const [operationId, request] of [
    ['getInboxSummary', {}],
    ['listConversationAssignees', {}],
    ['listConversations', {}],
    ['getConversation', { params }],
    ['listConversationMessages', { params }],
    ['getConversationComposer', { params }],
  ] as const)
    await expect(world.call(operationId, member, request), operationId).resolves.toBeDefined();
  // What a reader may not do is said, so the screen can leave the controls out.
  expect(await world.call('listConversations', member)).toMatchObject({
    canManage: false,
    canReply: false,
  });
  expect(await world.call('getConversationComposer', member, { params })).toMatchObject({
    canReply: false,
  });
  expect(current).toMatchObject({ canManage: false, canReply: false });
  expect(await world.call('getConversation', as('conversations.reply'), { params })).toMatchObject({
    canManage: false,
    canReply: true,
  });

  const manage = { permission: 'conversations.manage' };
  const reply = { permission: 'conversations.reply' };
  const replyBody = {
    channel: 'email',
    accountId: box.publicId,
    to: maya.emailIdentity,
    text: 'Hi',
    idempotencyKey: key(),
  };
  const writes = [
    [
      'assignConversation',
      { params, body: { assignee: 'me', revision: current.revision } },
      manage,
    ],
    [
      'setConversationStatus',
      { params, body: { status: 'closed', revision: current.revision } },
      manage,
    ],
    [
      'markConversationRead',
      { params, body: { through: toPublicId('message', stored.messageId) } },
      manage,
    ],
    ['addConversationNote', { params, body: { text: 'A note', idempotencyKey: key() } }, manage],
    ['sendConversationReply', { params, body: replyBody }, reply],
  ] as const;
  for (const [operationId, request, needs] of writes) {
    const refused = world.call(operationId, member, request);
    await expect(refused, operationId).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refused, operationId).rejects.toMatchObject(needs);
  }
  // Managing conversations doesn't allow sending, and sending doesn't allow managing.
  await expect(
    world.call('sendConversationReply', as('conversations.manage'), { params, body: replyBody }),
  ).rejects.toMatchObject(reply);
  for (const [operationId, request, needs] of writes.filter(
    ([operationId]) =>
      operationId !== 'sendConversationReply' && operationId !== 'markConversationRead',
  ))
    await expect(
      world.call(operationId, as('conversations.reply'), request),
      operationId,
    ).rejects.toMatchObject(needs);
  // Nothing a refused caller tried was saved or sent.
  expect(await world.call('getConversation', member, { params })).toEqual(current);
  expect(await b.events()).toEqual([]);
  // Read state is the team's: whoever manages or replies may move it, a reader may not.
  const read = { params, body: { through: toPublicId('message', stored.messageId) } };
  await expect(
    world.call('markConversationRead', as('conversations.reply'), read),
  ).resolves.toMatchObject({ unreadCount: 0 });
  await expect(
    world.call('markConversationRead', as('conversations.manage'), read),
  ).resolves.toMatchObject({ unreadCount: 0 });
  expect(
    conversationThread.parse(await world.call('listConversationMessages', member, { params }))
      .items,
  ).toHaveLength(1);
  expect(await b.queuedDeliveries()).toBe(0);

  // Each permission is enough for its own work.
  await expect(
    world.call('addConversationNote', as('conversations.manage'), {
      params,
      body: { text: 'A note', idempotencyKey: key() },
    }),
  ).resolves.toMatchObject({ kind: 'note' });
  await expect(
    world.call('sendConversationReply', as('conversations.reply'), { params, body: replyBody }),
  ).resolves.toMatchObject({ kind: 'message', status: 'queued' });
  expect(await b.queuedDeliveries()).toBe(1);
});

it("never shows or changes another business's conversations", async () => {
  const ours = await inboxBusiness(world);
  const theirs = await inboxBusiness(world);
  const secret = await theirs.contact({
    firstName: 'Confidential',
    lastName: 'Client',
    email: 'confidential.client@elsewhere.test',
  });
  const theirBox = await theirs.mailbox({ address: 'private@elsewhere.test' });
  const stored = await theirs.receive(secret, theirBox.id, 'Our secret plans');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const theirConversation = conversation.parse(
    await world.call('getConversation', theirs.as(), { params }),
  );
  const us = ours.as();

  expect(await world.call('listConversations', us, { query: { status: 'all' } })).toMatchObject({
    items: [],
    nextCursor: null,
  });
  expect(
    await world.call('listConversations', us, { query: { contactId: secret.publicId } }),
  ).toMatchObject({ items: [] });
  expect(await world.call('getInboxSummary', us)).toEqual({
    unreadConversations: 0,
    unreadMessages: 0,
    needsReply: 0,
  });

  const attempts = [
    ['getConversation', { params }],
    ['listConversationMessages', { params }],
    ['getConversationComposer', { params }],
    [
      'assignConversation',
      { params, body: { assignee: 'me', revision: theirConversation.revision } },
    ],
    [
      'setConversationStatus',
      { params, body: { status: 'closed', revision: theirConversation.revision } },
    ],
    [
      'markConversationRead',
      { params, body: { through: toPublicId('message', stored.messageId) } },
    ],
    ['addConversationNote', { params, body: { text: 'Seen', idempotencyKey: key() } }],
    [
      'sendConversationReply',
      {
        params,
        body: {
          channel: 'email',
          accountId: theirBox.publicId,
          to: secret.emailIdentity,
          text: 'Hello',
          idempotencyKey: key(),
        },
      },
    ],
  ] as const;
  for (const [operationId, request] of attempts) {
    const refused = world.call(operationId, us, request).catch((error: unknown) => error);
    const error = await refused;
    expect(error, operationId).toBeInstanceOf(NotFoundError);
    // The answer names the id that was asked for and nothing else.
    const said = JSON.stringify([error, error instanceof Error ? error.message : '']);
    for (const theirWords of ['Confidential', 'elsewhere.test', 'secret plans'])
      expect(said, operationId).not.toContain(theirWords);
  }

  // In a conversation of our own, their account and their contact's address read as ones
  // that don't fit, exactly as a wrong choice of our own would.
  const maya = await ours.contact();
  const ourBox = await ours.mailbox();
  const mine = await ours.receive(maya, ourBox.id, 'Hello');
  const ourParams = { id: toPublicId('conversation', mine.conversationId) };
  const send = (changes: Record<string, unknown>) =>
    world
      .call('sendConversationReply', us, {
        params: ourParams,
        body: {
          channel: 'email',
          accountId: ourBox.publicId,
          to: maya.emailIdentity,
          text: 'Hello',
          idempotencyKey: key(),
          ...changes,
        },
      })
      .catch((error: unknown) => error);
  const theirAccount = await send({ accountId: theirBox.publicId });
  expect(theirAccount).toBeInstanceOf(ValidationError);
  expect(theirAccount).toMatchObject({
    issues: [{ path: '/accountId', code: 'account_channel_mismatch' }],
  });
  const theirAddress = await send({ to: secret.emailIdentity });
  expect(theirAddress).toMatchObject({
    issues: [{ path: '/to', code: 'recipient_not_in_conversation' }],
  });
  for (const error of [theirAccount, theirAddress])
    expect(JSON.stringify(error)).not.toContain('elsewhere.test');
  await expect(
    world.call('markConversationRead', us, {
      params: ourParams,
      body: { through: toPublicId('message', stored.messageId) },
    }),
  ).rejects.toMatchObject({ issues: [{ path: '/through', code: 'unknown_message' }] });

  // Nothing of theirs changed, and nothing was queued in either business.
  expect(await world.call('getConversation', theirs.as(), { params })).toEqual(theirConversation);
  expect(
    conversationThread.parse(await world.call('listConversationMessages', theirs.as(), { params }))
      .items,
  ).toHaveLength(1);
  expect(await ours.queuedDeliveries()).toBe(0);
  expect(await theirs.queuedDeliveries()).toBe(0);
});

it('needs a business, and says plainly what is wrong with a request', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Hello');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const current = conversation.parse(await world.call('getConversation', me, { params }));

  const { businessId: _none, ...agencyOnly } = b.context;
  for (const operationId of ['listConversations', 'getInboxSummary'])
    await expect(
      world.call(operationId, { context: agencyOnly, permissions: 'all' }),
      operationId,
    ).rejects.toMatchObject({ issues: [{ code: 'business_required' }] });

  const issue = (code: string, path: string) => ({ issues: [{ path, code }] });
  await expect(
    world.call('listConversations', me, { query: { after: 'bm90LWEtY3Vyc29y' } }),
  ).rejects.toMatchObject(issue('unknown_cursor', '/after'));
  await expect(
    world.call('listConversationMessages', me, { params, query: { before: 'bm90LWEtY3Vyc29y' } }),
  ).rejects.toMatchObject(issue('unknown_cursor', '/before'));
  await expect(
    world.call('listConversations', me, { query: { sort: 'oldest' } }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    world.call('setConversationStatus', me, {
      params,
      body: {
        status: 'snoozed',
        until: new Date(Date.now() - 60_000).toISOString(),
        revision: current.revision,
      },
    }),
  ).rejects.toMatchObject(issue('not_in_future', '/until'));
  await expect(
    world.call('assignConversation', me, {
      params,
      body: {
        assignee: toPublicId('membership', stored.messageId),
        revision: current.revision,
      },
    }),
  ).rejects.toMatchObject(issue('unavailable_assignee', '/assignee'));
  await expect(
    world.call('addConversationNote', me, { params, body: { text: '   ', idempotencyKey: key() } }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    world.call('getConversation', me, { params: { id: maya.publicId } }),
  ).rejects.toBeInstanceOf(ValidationError);
  // A well-formed id of nothing is not found, and a body is never read before that.
  await expect(
    world.call('addConversationNote', me, {
      params: { id: toPublicId('conversation', stored.messageId) },
      body: { nonsense: true },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await world.call('getConversation', me, { params })).toEqual(current);
});

it('changes and records nothing when asked for what is already so', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Hello');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const current = conversation.parse(await world.call('getConversation', me, { params }));

  // Unassigned already, and open already.
  expect(
    await world.call('assignConversation', me, {
      params,
      body: { assignee: null, revision: current.revision },
    }),
  ).toEqual(current);
  expect(
    await world.call('setConversationStatus', me, {
      params,
      body: { status: 'open', revision: current.revision },
    }),
  ).toEqual(current);
  expect(await b.events()).toEqual([]);

  // Snoozed until a time, then asked for the same time again.
  const until = future();
  const snoozed = conversation.parse(
    await world.call('setConversationStatus', me, {
      params,
      body: { status: 'snoozed', until, revision: current.revision },
    }),
  );
  expect(
    await world.call('setConversationStatus', me, {
      params,
      body: { status: 'snoozed', until, revision: snoozed.revision },
    }),
  ).toEqual(snoozed);
  // Read through the same message twice: the second moves nothing.
  const read = { params, body: { through: toPublicId('message', stored.messageId) } };
  await world.call('markConversationRead', me, read);
  await world.call('markConversationRead', me, read);
  expect((await b.events()).map((event) => event.type)).toEqual([
    'conversation.snoozed',
    'conversation.read',
  ]);
});
