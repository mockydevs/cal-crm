// What the Inbox lets an assistant propose and shows it of a conversation, against real
// Postgres: under "Ask first" an assistant can neither send nor change a conversation by
// itself; a reply applied from a proposal goes through the same reply command and the same
// pipeline; and an assistant is shown one conversation only.
import { randomUUID } from 'node:crypto';

import {
  ApprovalRequiredError,
  proposableOf,
  runCommand,
  type Invocation,
  type Proposable,
  type ProposalHooks,
  type UndoPlan,
} from '@repo/commands';
import { conversation, type AutonomyLevel } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ConflictError, toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxWorld } from '../test/inbox.js';
import { setConversationStatusCommand } from './inbox-commands.js';
import {
  createInboxProposables,
  readReplyContext,
  REPLY_CONTEXT_LIMITS,
} from './inbox-proposals.js';
import { sendConversationReplyCommand } from './inbox-reply.js';

let world: InboxWorld;
let proposables: readonly Proposable[];
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
  proposables = createInboxProposables(world.options);
});
afterAll(async () => {
  await world.close();
});

const key = () => randomUUID().replaceAll('-', '');
const kind = (name: string): Proposable => {
  const found = proposableOf(proposables, name);
  if (found === undefined) throw new Error(`No proposable of kind ${name}.`);
  return found;
};

/** A business with a contact who wrote in, and what a reply to them needs. */
async function conversationWith(values: { consent?: boolean } = {}) {
  const b = await inboxBusiness(world);
  const maya = await b.contact({ firstName: 'Maya', ...values });
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Is June 13 still open?', { subject: 'June 13' });
  const id = toPublicId('conversation', stored.conversationId);
  const replyInput = (changes: Record<string, unknown> = {}) => ({
    id,
    reply: {
      channel: 'email',
      accountId: box.publicId,
      to: maya.emailIdentity,
      text: 'Hi Maya, June 13 is open.',
      idempotencyKey: key(),
      ...changes,
    },
  });
  /** The inbox agent, with the permissions of someone who works the inbox. */
  const assistant: Invocation = {
    context: {
      agencyId: b.context.agencyId,
      ...(b.context.businessId === undefined ? {} : { businessId: b.context.businessId }),
      actorKind: 'ai_agent',
      correlationId: randomUUID(),
    },
    permissions: new Set(['conversations.reply', 'conversations.manage']),
    agent: 'inbox',
  };
  const setRule = (action: string, level: AutonomyLevel, contactId: string | null = null) =>
    b.query(
      `insert into ai.autonomy_rules (business_id, agent, action, contact_id, level)
       values (app.business_id(), 'inbox', $1, $2, $3)
       on conflict on constraint autonomy_rules_unique do update set level = excluded.level`,
      [action, contactId, level],
    );
  const outbound = () =>
    b.query<{ id: string; status: string; proposal_id: string | null; author_kind: string }>(
      `select id, status, proposal_id, author_kind from messaging.messages
       where direction = 'outbound' order by seq`,
    );
  const dispatches = () => b.query('select id from messaging.outbound_dispatch');
  /** A stored proposal for this conversation: a message names its proposal by a real row. */
  const proposal = async () => {
    const [row] = await b.query<{ id: string }>(
      `insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command, autonomy, revision)
       values (app.business_id(), 'inbox', 'reply', $1, 'Reply to Maya',
               '{"name": "conversation.reply", "input": {}}', 'ask', 'thread:1')
       returning id`,
      [stored.conversationId],
    );
    if (row === undefined) throw new Error('No proposal.');
    return { id: row.id, agent: 'inbox' as const };
  };
  const read = async () =>
    conversation.parse(await world.call('getConversation', b.as(), { params: { id } }));
  return {
    b,
    maya,
    box,
    stored,
    id,
    replyInput,
    assistant,
    setRule,
    outbound,
    dispatches,
    proposal,
    read,
  };
}

type Fixture = Awaited<ReturnType<typeof conversationWith>>;

/** Nothing left the business and nothing about the conversation changed. */
async function expectUntouched(f: Fixture, before: Awaited<ReturnType<Fixture['read']>>) {
  expect(await f.outbound()).toEqual([]);
  expect(await f.dispatches()).toEqual([]);
  expect(await f.b.queuedDeliveries()).toBe(0);
  expect(await f.b.events()).toEqual([]);
  expect(await f.read()).toEqual(before);
}

describe('an assistant under "Ask first"', () => {
  const reply = () => sendConversationReplyCommand(world.options);
  const setStatus = () => setConversationStatusCommand(world.options);

  it.each([
    ['with no rule at all', undefined],
    ['at suggest', 'suggest'],
    ['at ask', 'ask'],
  ] as const)(
    'cannot send a reply %s: no message, no dispatch row, no job',
    async (_name, level) => {
      const f = await conversationWith();
      if (level !== undefined) await f.setRule('send_message', level);
      const before = await f.read();
      const attempt = runCommand(world.services, reply(), f.replyInput(), f.assistant);
      await expect(attempt).rejects.toBeInstanceOf(ApprovalRequiredError);
      await expect(attempt).rejects.toMatchObject({ reason: 'approval_required' });
      await expectUntouched(f, before);
      expect(await f.b.audit()).toMatchObject([
        { command: 'conversation.reply', outcome: 'denied' },
      ]);
    },
  );

  it.each([
    ['with no rule at all', undefined],
    ['at suggest', 'suggest'],
    ['at ask', 'ask'],
  ] as const)('cannot close a conversation %s: nothing changes', async (_name, level) => {
    const f = await conversationWith();
    if (level !== undefined) await f.setRule('update_conversation', level);
    const before = await f.read();
    await expect(
      runCommand(
        world.services,
        setStatus(),
        { id: f.id, change: { status: 'closed', revision: before.revision } },
        f.assistant,
      ),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expectUntouched(f, before);
  });

  it('is not let through for sending by a rule about another kind of action, or the reverse', async () => {
    const f = await conversationWith();
    await f.setRule('update_conversation', 'act');
    const before = await f.read();
    await expect(
      runCommand(world.services, reply(), f.replyInput(), f.assistant),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expectUntouched(f, before);

    const g = await conversationWith();
    await g.setRule('send_message', 'act');
    const open = await g.read();
    await expect(
      runCommand(
        world.services,
        setStatus(),
        { id: g.id, change: { status: 'closed', revision: open.revision } },
        g.assistant,
      ),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expectUntouched(g, open);
  });

  it('is held for one contact by that contact’s own rule, while the business lets it act', async () => {
    const f = await conversationWith();
    await f.setRule('send_message', 'act');
    await f.setRule('send_message', 'ask', f.maya.id);
    const before = await f.read();
    await expect(
      runCommand(world.services, reply(), f.replyInput(), f.assistant),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expectUntouched(f, before);
  });

  it('sends by itself only at act, through the pipeline, as the assistant', async () => {
    const f = await conversationWith();
    await f.setRule('send_message', 'act');
    const sent = await runCommand(world.services, reply(), f.replyInput(), f.assistant);
    expect(sent).toMatchObject({ status: 'queued', author: { kind: 'ai_agent', name: null } });
    expect(await f.outbound()).toMatchObject([
      { status: 'queued', author_kind: 'ai_agent', proposal_id: null },
    ]);
    expect(await f.dispatches()).toHaveLength(1);
    expect(await f.b.queuedDeliveries()).toBe(1);
  });

  it('is still refused by the pipeline what a person would be refused, at act', async () => {
    const f = await conversationWith({ consent: false });
    // They wrote from another address, so answering this one needs consent.
    await f.b.query(
      "update messaging.messages set from_address = 'someone-else@example.test' where direction = 'inbound'",
    );
    await f.setRule('send_message', 'act');
    const sent = await runCommand(world.services, reply(), f.replyInput(), f.assistant);
    // The pipeline's own refusal: stored as failed, never queued for delivery.
    expect(sent).toMatchObject({ status: 'failed', problem: { code: 'consent_required' } });
    expect(await f.b.queuedDeliveries()).toBe(0);
  });
});

const hooks = (changes: Partial<ProposalHooks> = {}): ProposalHooks => ({
  proposal: { id: randomUUID(), agent: 'inbox' },
  begin: () => Promise.resolve('run'),
  finish: () => Promise.resolve(),
  ...changes,
});

describe('a proposed reply', () => {
  it('names the action a rule is about, the command it runs and who may propose it', () => {
    expect(kind('reply')).toMatchObject({
      kind: 'reply',
      commandName: 'conversation.reply',
      permission: 'conversations.reply',
      action: 'send_message',
      agents: ['inbox'],
      changeable: true,
    });
  });

  it('is about its conversation and that conversation’s contact', async () => {
    const f = await conversationWith();
    expect(
      await withTenant(world.db, f.b.context, (trx) => kind('reply').subject(trx, f.replyInput())),
    ).toEqual({ conversationId: f.stored.conversationId, contactId: f.maya.id });
  });

  it('is made on the thread: a message either way moves the fingerprint, a note does not', async () => {
    const f = await conversationWith();
    const revision = () =>
      withTenant(world.db, f.b.context, (trx) => kind('reply').revision(trx, f.replyInput()));
    const first = await revision();
    expect(first).toMatch(/^thread:\d+$/);
    await world.call('addConversationNote', f.b.as(), {
      params: { id: f.id },
      body: { text: 'She called earlier.', idempotencyKey: key() },
    });
    expect(await revision()).toBe(first);
    await f.b.receive(f.maya, f.box.id, 'Also, do you do video?');
    const second = await revision();
    expect(second).not.toBe(first);
    await world.call('sendConversationReply', f.b.as(), {
      params: { id: f.id },
      body: f.replyInput().reply,
    });
    expect(await revision()).not.toBe(second);
  });

  it('shows where it would go and what it would say', async () => {
    const f = await conversationWith();
    const input = f.replyInput({ subject: 'Re: June 13' });
    expect(
      await withTenant(world.db, f.b.context, (trx) => kind('reply').present(trx, input, f.b.as())),
    ).toEqual({
      kind: 'reply',
      channel: 'email',
      accountId: f.box.publicId,
      to: f.maya.emailIdentity,
      subject: 'Re: June 13',
      text: 'Hi Maya, June 13 is open.',
    });
  });

  it('can be changed in everything the composer chooses, and keeps its own retry key', async () => {
    const f = await conversationWith();
    const input = f.replyInput();
    expect(
      kind('reply').change(input, {
        channel: 'email',
        accountId: f.box.publicId,
        to: f.maya.emailIdentity,
        text: 'My own words.',
        idempotencyKey: 'another-key-000000000000000000',
      }),
    ).toEqual({
      id: f.id,
      reply: {
        channel: 'email',
        accountId: f.box.publicId,
        to: f.maya.emailIdentity,
        text: 'My own words.',
        idempotencyKey: input.reply.idempotencyKey,
      },
    });
  });

  it('applied by a person, goes through the pipeline once and names its proposal on the message', async () => {
    const f = await conversationWith();
    const input = f.replyInput();
    const proposal = await f.proposal();
    let done: Parameters<ProposalHooks['finish']>[1] | undefined;
    const finish: ProposalHooks['finish'] = (_trx, outcome) => {
      done = outcome;
      return Promise.resolve();
    };
    expect(
      await kind('reply').run(world.services, input, f.b.as(), hooks({ proposal, finish })),
    ).toBe(true);
    const [message] = await f.outbound();
    expect(message).toMatchObject({
      status: 'queued',
      author_kind: 'user',
      proposal_id: proposal.id,
    });
    expect(done).toMatchObject({
      result: { messageId: toPublicId('message', message?.id ?? '') },
      // It is on its way: a sent message cannot be unsent.
      undo: { impossible: 'message_sent' },
    });
    expect(await f.dispatches()).toHaveLength(1);
    expect(await f.b.queuedDeliveries()).toBe(1);
    // The same proposal again is the same message: the reply command's own retry key.
    await kind('reply').run(world.services, input, f.b.as(), hooks({ proposal }));
    expect(await f.outbound()).toHaveLength(1);
    expect(await f.b.queuedDeliveries()).toBe(1);
    // A person's own reply names no proposal.
    await world.call('sendConversationReply', f.b.as(), {
      params: { id: f.id },
      body: f.replyInput().reply,
    });
    expect((await f.outbound()).map((each) => each.proposal_id)).toEqual([proposal.id, null]);
  });

  it('says plainly that a reply the pipeline refused was never sent', async () => {
    const f = await conversationWith({ consent: false });
    // They wrote from another address, so answering this one needs consent.
    await f.b.query(
      "update messaging.messages set from_address = 'someone-else@example.test' where direction = 'inbound'",
    );
    let undo: UndoPlan | undefined;
    await kind('reply').run(
      world.services,
      f.replyInput(),
      f.b.as(),
      hooks({
        proposal: await f.proposal(),
        finish: (_trx, outcome) => {
          undo = outcome.undo;
          return Promise.resolve();
        },
      }),
    );
    expect(await f.outbound()).toMatchObject([{ status: 'failed' }]);
    expect(undo).toEqual({ impossible: 'not_sent' });
    expect(await f.b.queuedDeliveries()).toBe(0);
  });

  it('is refused for a person as the reply command refuses them', async () => {
    const f = await conversationWith();
    const other = await conversationWith();
    // Without the permission to reply.
    await expect(
      kind('reply').run(
        world.services,
        f.replyInput(),
        f.b.as(new Set(['conversations.manage'])),
        hooks(),
      ),
    ).rejects.toMatchObject({ permission: 'conversations.reply' });
    // To an address of another contact, and from another business's mailbox.
    await expect(
      kind('reply').run(
        world.services,
        f.replyInput({ to: other.maya.emailIdentity }),
        f.b.as(),
        hooks(),
      ),
    ).rejects.toMatchObject({ issues: [{ code: 'recipient_not_in_conversation' }] });
    await expect(
      kind('reply').run(
        world.services,
        f.replyInput({ accountId: other.box.publicId }),
        f.b.as(),
        hooks(),
      ),
    ).rejects.toMatchObject({ issues: [{ path: '/accountId' }] });
    // With a line break in the subject, or no text.
    await expect(
      kind('reply').run(
        world.services,
        f.replyInput({ subject: 'Hi\r\nBcc: x@example.test' }),
        f.b.as(),
        hooks(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kind('reply').run(world.services, f.replyInput({ text: '   ' }), f.b.as(), hooks()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await f.outbound()).toEqual([]);
    expect(await f.dispatches()).toEqual([]);
  });
});

describe('a proposed change of status', () => {
  it('names the action a rule is about and the command it runs, and allows no change', () => {
    expect(kind('conversation_status')).toMatchObject({
      commandName: 'conversation.set_status',
      permission: 'conversations.manage',
      action: 'update_conversation',
      agents: ['inbox'],
      changeable: false,
    });
  });

  it('shows the status it would leave and the one it would set, and is made on the conversation’s revision', async () => {
    const f = await conversationWith();
    const { revision } = await f.read();
    const input = { id: f.id, change: { status: 'closed', revision } };
    await withTenant(world.db, f.b.context, async (trx) => {
      expect(await kind('conversation_status').present(trx, input, f.b.as())).toEqual({
        kind: 'conversation_status',
        from: 'open',
        to: 'closed',
        until: null,
      });
      expect(await kind('conversation_status').revision(trx, input)).toBe(revision);
      expect(await kind('conversation_status').subject(trx, input)).toEqual({
        conversationId: f.stored.conversationId,
        contactId: f.maya.id,
      });
    });
    const until = '2999-01-01T09:00:00+03:00';
    expect(
      await withTenant(world.db, f.b.context, (trx) =>
        kind('conversation_status').present(
          trx,
          { id: f.id, change: { status: 'snoozed', until, revision } },
          f.b.as(),
        ),
      ),
    ).toEqual({
      kind: 'conversation_status',
      from: 'open',
      to: 'snoozed',
      until: '2999-01-01T06:00:00.000Z',
    });
  });

  /** Applies a status proposal as a person, and gives the way back it worked out. */
  const apply = async (f: Fixture, change: Record<string, unknown>): Promise<UndoPlan> => {
    let undo: UndoPlan | undefined;
    await kind('conversation_status').run(
      world.services,
      { id: f.id, change },
      f.b.as(),
      hooks({
        finish: (_trx, outcome) => {
          undo = outcome.undo;
          return Promise.resolve();
        },
      }),
    );
    if (undo === undefined) throw new Error('No way back was worked out.');
    return undo;
  };
  const inputOf = (plan: UndoPlan): unknown => {
    if ('impossible' in plan) throw new Error(`Nothing can undo it: ${plan.impossible}`);
    expect(plan.kind).toBe('conversation_status');
    return plan.input;
  };

  it('closes an open conversation, and its way back opens it again', async () => {
    const f = await conversationWith();
    const before = await f.read();
    const undo = await apply(f, { status: 'closed', revision: before.revision });
    const closed = await f.read();
    expect(closed.status).toBe('closed');
    expect(inputOf(undo)).toEqual({
      id: f.id,
      change: { status: 'open', revision: closed.revision },
    });
    await kind('conversation_status').run(world.services, inputOf(undo), f.b.as(), hooks());
    expect(await f.read()).toMatchObject({ status: 'open', revision: before.revision });
  });

  it('opens a snoozed conversation, and its way back snoozes it until the same time', async () => {
    const f = await conversationWith();
    const until = '2999-01-01T06:00:00.000Z';
    await world.call('setConversationStatus', f.b.as(), {
      params: { id: f.id },
      body: { status: 'snoozed', until, revision: (await f.read()).revision },
    });
    const snoozed = await f.read();
    const undo = await apply(f, { status: 'open', revision: snoozed.revision });
    expect((await f.read()).status).toBe('open');
    await kind('conversation_status').run(world.services, inputOf(undo), f.b.as(), hooks());
    expect(await f.read()).toMatchObject({
      status: 'snoozed',
      snoozedUntil: until,
      revision: snoozed.revision,
    });
  });

  it('reopens a closed conversation, and its way back closes it again', async () => {
    const f = await conversationWith();
    await world.call('setConversationStatus', f.b.as(), {
      params: { id: f.id },
      body: { status: 'closed', revision: (await f.read()).revision },
    });
    const closed = await f.read();
    const undo = await apply(f, { status: 'open', revision: closed.revision });
    await kind('conversation_status').run(world.services, inputOf(undo), f.b.as(), hooks());
    expect(await f.read()).toMatchObject({ status: 'closed', revision: closed.revision });
  });

  it('is refused as stale once a person has changed the conversation, and so is its way back', async () => {
    const f = await conversationWith();
    const before = await f.read();
    const dana = await world.member(f.b.business.id, 'Dana Brooks');
    await world.call('assignConversation', f.b.as(), {
      params: { id: f.id },
      body: { assignee: dana.membershipId, revision: before.revision },
    });
    await expect(
      kind('conversation_status').run(
        world.services,
        { id: f.id, change: { status: 'closed', revision: before.revision } },
        f.b.as(),
        hooks(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await f.read()).status).toBe('open');

    // Applied on the conversation as it now is, then changed again by a person: the way
    // back was worked out for a conversation that has since moved on.
    const undo = await apply(f, { status: 'closed', revision: (await f.read()).revision });
    await world.call('assignConversation', f.b.as(), {
      params: { id: f.id },
      body: { assignee: null, revision: (await f.read()).revision },
    });
    await expect(
      kind('conversation_status').run(world.services, inputOf(undo), f.b.as(), hooks()),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await f.read()).status).toBe('closed');
  });

  it('needs the right to manage conversations, to apply and to undo', async () => {
    const f = await conversationWith();
    const { revision } = await f.read();
    await expect(
      kind('conversation_status').run(
        world.services,
        { id: f.id, change: { status: 'closed', revision } },
        f.b.as(new Set(['conversations.reply'])),
        hooks(),
      ),
    ).rejects.toMatchObject({ permission: 'conversations.manage' });
    expect((await f.read()).status).toBe('open');
  });
});

describe('what an assistant is shown of a conversation', () => {
  const context = (f: Fixture, conversationId = f.stored.conversationId) =>
    withTenant(world.db, f.b.context, (trx) =>
      readReplyContext(trx, f.b.as(), conversationId, world.options),
    );

  it('is the one conversation: its contact, its messages oldest first, and where a reply would go', async () => {
    const f = await conversationWith();
    await f.b.query('update crm.contacts set locale = $2 where id = $1', [f.maya.id, 'sw']);
    await world.call('sendConversationReply', f.b.as(), {
      params: { id: f.id },
      body: f.replyInput({ subject: 'Re: June 13' }).reply,
    });
    await f.b.receive(f.maya, f.box.id, 'Lovely. And video?', { subject: 'Re: June 13' });
    const read = await context(f);
    const [business] = await f.b.query<{ name: string }>('select name from tenancy.businesses');
    expect(business?.name).toMatch(/^Business /);
    expect(read).toMatchObject({
      conversationId: f.stored.conversationId,
      contactId: f.maya.id,
      contactFirstName: 'Maya',
      contactLocale: 'sw',
      businessName: business?.name,
      businessLocale: 'en',
      state: 'needs_reply',
      reply: {
        channel: 'email',
        accountId: f.box.publicId,
        to: f.maya.emailIdentity,
        subject: 'Re: June 13',
      },
    });
    expect(
      read?.messages.map(({ from, channel, subject, text }) => ({ from, channel, subject, text })),
    ).toEqual([
      { from: 'contact', channel: 'email', subject: 'June 13', text: 'Is June 13 still open?' },
      {
        from: 'business',
        channel: 'email',
        subject: 'Re: June 13',
        text: 'Hi Maya, June 13 is open.',
      },
      { from: 'contact', channel: 'email', subject: 'Re: June 13', text: 'Lovely. And video?' },
    ]);
    expect(read?.revision).toMatch(/^thread:\d+$/);
  });

  it('never holds an internal note, another conversation’s message or another business’s', async () => {
    const f = await conversationWith();
    await world.call('addConversationNote', f.b.as(), {
      params: { id: f.id },
      body: { text: 'INTERNAL: she haggles, quote high.', idempotencyKey: key() },
    });
    // Another contact of the same business, and another business altogether.
    const daniel = await f.b.contact({ firstName: 'Daniel', email: 'daniel@secret.example.test' });
    const theirs = await f.b.receive(daniel, f.box.id, 'SECRET-OF-DANIEL: my card ends 4471.');
    const other = await conversationWith();
    await other.b.receive(other.maya, other.box.id, 'SECRET-OF-ANOTHER-BUSINESS');

    const read = await context(f);
    const everything = JSON.stringify(read);
    expect(read?.messages).toHaveLength(1);
    for (const never of [
      'INTERNAL',
      'SECRET-OF-DANIEL',
      'daniel@secret',
      'SECRET-OF-ANOTHER-BUSINESS',
      'Daniel',
    ])
      expect(everything).not.toContain(never);

    // Daniel's conversation is read on its own, and holds none of Maya's.
    expect(JSON.stringify(await context(f, theirs.conversationId))).not.toContain('June 13');
    // Another business's conversation is not there to be read at all.
    expect(await context(f, other.stored.conversationId)).toBeUndefined();
    expect(await context(f, randomUUID())).toBeUndefined();
  });

  it('holds only the newest messages, and only the start of a long one', async () => {
    const f = await conversationWith();
    for (let index = 0; index < REPLY_CONTEXT_LIMITS.messages + 2; index += 1)
      await f.b.receive(f.maya, f.box.id, `Message ${String(index)}`);
    await f.b.receive(f.maya, f.box.id, `${'long '.repeat(1000)}THE-END`);
    const read = await context(f);
    expect(read?.messages).toHaveLength(REPLY_CONTEXT_LIMITS.messages);
    expect(read?.messages[0]?.text).toBe('Message 3');
    const last = read?.messages.at(-1)?.text ?? '';
    expect(last).toHaveLength(REPLY_CONTEXT_LIMITS.messageLength);
    expect(last).not.toContain('THE-END');
  });

  it('says when there is nothing to answer: the business wrote last, or a machine did', async () => {
    const f = await conversationWith();
    await world.call('sendConversationReply', f.b.as(), {
      params: { id: f.id },
      body: f.replyInput().reply,
    });
    expect((await context(f))?.state).toBe('answered');
    await f.b.receive(f.maya, f.box.id, 'I am out of the office.', { automated: true });
    expect((await context(f))?.state).toBe('automated');
    await f.b.receive(f.maya, f.box.id, 'Back now. Is the 14th free too?');
    expect((await context(f))?.state).toBe('needs_reply');
  });

  it('says when no reply could be sent: do not contact, the trash, or no channel', async () => {
    const dnc = await conversationWith();
    await dnc.b.query('update crm.contacts set do_not_contact = true where id = $1', [dnc.maya.id]);
    expect(await context(dnc)).toMatchObject({ state: 'cannot_reply' });

    const trashed = await conversationWith();
    await trashed.b.query('update crm.contacts set deleted_at = now() where id = $1', [
      trashed.maya.id,
    ]);
    expect(await context(trashed)).toMatchObject({ state: 'cannot_reply', reply: null });

    const paused = await conversationWith();
    await paused.b.query(`update messaging.channel_accounts set status = 'paused'`);
    expect(await context(paused)).toMatchObject({ state: 'cannot_reply', reply: null });
  });

  it('answers through the mailbox the contact wrote to, to the address they wrote from', async () => {
    const f = await conversationWith();
    const second = await f.b.mailbox({ address: 'bookings@example.test' });
    await f.b.query(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
       values (app.business_id(), $1, 'email', 'maya.work@example.test', 'maya.work@example.test', false)`,
      [f.maya.id],
    );
    await f.b.receive({ id: f.maya.id, email: 'maya.work@example.test' }, second.id, 'From work.');
    const read = await context(f);
    const [work] = await f.b.query<{ id: string }>(
      `select id from crm.contact_identities where value_normalized = 'maya.work@example.test'`,
    );
    expect(read?.reply).toMatchObject({
      channel: 'email',
      accountId: second.publicId,
      to: toPublicId('contact_identity', work?.id ?? ''),
    });
  });
});
