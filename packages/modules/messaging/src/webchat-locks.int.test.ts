// Web chat where two transactions really overlap: the lock order of every web chat writer, and
// what each lock is for.
//
// Each test holds one transaction open (WebchatWorld.open), starts the work that must wait,
// and goes on only when PostgreSQL itself reports the wait (pg_stat_activity, as postgres).
// So nothing here depends on timing: remove the lock a test is about and the wait never
// comes, or the row the test then asks for is not free, and the test fails. The one writer
// that needs the permission `webchat.manage`, a key replacement, has the same proof in
// webchat-widgets.int.test.ts.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import { createContactInput, WEBCHAT_LIMITS } from '@repo/contracts';
import { ConflictError, parsePublicId } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  message,
  ORIGIN,
  request,
  startWebchat,
  type OpenTransaction,
  type WebchatWorld,
  type WidgetFixture,
} from '../test/webchat.js';
import { expireWebchatSessions } from './webchat-maintenance.js';

let world: WebchatWorld;
beforeAll(async () => {
  world = await startWebchat(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

/** A widget with one chat under way: its session's token and its conversation. */
async function chatting(): Promise<{ f: WidgetFixture; token: string; conversationId: string }> {
  const f = await world.fixture();
  const token = await world.started(f);
  await world.sent(f, token, 'first');
  return { f, token, conversationId: await world.conversationOf(f) };
}

/** Holds the business as the outbound worker and the Inbox's reply do: FOR UPDATE. */
async function businessHeld(f: WidgetFixture): Promise<OpenTransaction> {
  const holder = await world.open(f.context);
  await holder.query('select 1 from tenancy.businesses where id = $1 for update', [f.business.id]);
  return holder;
}

const free = (holder: OpenTransaction, table: string, id: string): Promise<unknown> =>
  holder.query(`select 1 from ${table} where id = $1 for update nowait`, [id]);

describe('the business is taken first', () => {
  // The worker holds the business and then reaches a conversation. A writer that held the
  // conversation or a session and only then needed the business would deadlock with it. So
  // while the business is held, each writer must be waiting with nothing else in its hands.
  it("by a visitor's message, before its conversation and its session", async () => {
    const { f, token, conversationId } = await chatting();
    const holder = await businessHeld(f);
    const sending = world.sent(f, token, 'second');
    await world.lockWaits(1);
    await free(holder, 'messaging.conversations', conversationId);
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    await holder.release();
    expect(await sending).toMatchObject({ seq: 2, text: 'second' });
  });

  it("by the team's reply, before the conversation and the session", async () => {
    const { f, token, conversationId } = await chatting();
    const holder = await businessHeld(f);
    const replying = world.replied(f, conversationId, 'answer');
    await world.lockWaits(1);
    await free(holder, 'messaging.conversations', conversationId);
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    await holder.release();
    expect(await replying).toMatchObject({ outcome: 'sent' });
    expect((await world.read(f, token)).messages.map((each) => each.text)).toEqual([
      'first',
      'answer',
    ]);
  });

  it('by a visitor ending the chat, before the session', async () => {
    const { f, token } = await chatting();
    const holder = await businessHeld(f);
    const ending = world.handlers.end(f.admission, token, request());
    await world.lockWaits(1);
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    await holder.release();
    expect(await ending).toEqual({ outcome: 'ok' });
  });

  it('by a new session, before the widget', async () => {
    const f = await world.fixture();
    const holder = await businessHeld(f);
    const starting = world.started(f);
    await world.lockWaits(1);
    await free(holder, 'messaging.webchat_widgets', f.widgetId);
    await holder.release();
    expect(await starting).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

async function sessionId(f: WidgetFixture): Promise<string> {
  const [row] = await f.rows<{ id: string }>(
    'select id from messaging.webchat_sessions order by created_at desc, id desc limit 1',
  );
  if (row === undefined) throw new Error('No session.');
  return row.id;
}

describe('the conversation is taken before the session', () => {
  it("by a visitor's message, as the team's reply does", async () => {
    const { f, token, conversationId } = await chatting();
    const holder = await world.open(f.context);
    await free(holder, 'messaging.conversations', conversationId);
    const sending = world.sent(f, token, 'second');
    await world.lockWaits(1);
    // The message waits for the conversation and has not touched its session yet.
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    await holder.release();
    expect(await sending).toMatchObject({ seq: 2 });
  });
});

describe('what overlaps', () => {
  it('a message and a reply that meet in one session each get a place, with none lost', async () => {
    const { f, token, conversationId } = await chatting();
    const holder = await world.open(f.context);
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    // The message holds the conversation and waits for the session; the reply waits for
    // the conversation behind it.
    const sending = world.sent(f, token, 'from the visitor');
    await world.lockWaits(1);
    const replying = world.replied(f, conversationId, 'from the team');
    await world.lockWaits(2);
    await holder.release();
    expect(await sending).toMatchObject({ seq: 2 });
    expect(await replying).toMatchObject({ outcome: 'sent' });
    expect(
      (await world.read(f, token)).messages.map((each) => [each.seq, each.from, each.text]),
    ).toEqual([
      [1, 'visitor', 'first'],
      [2, 'visitor', 'from the visitor'],
      [3, 'team', 'from the team'],
    ]);
  });

  it('one message sent twice at once is stored once, and both requests get the same answer', async () => {
    const { f, token } = await chatting();
    const holder = await world.open(f.context);
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    const input = message('only once');
    const first = world.handlers.send(f.admission, token, input, request());
    await world.lockWaits(1);
    const second = world.handlers.send(f.admission, token, input, request());
    await world.lockWaits(2);
    await holder.release();
    const [one, other] = await Promise.all([first, second]);
    expect(one).toMatchObject({ outcome: 'ok', message: { seq: 2, text: 'only once' } });
    expect(other).toEqual(one);
    expect(
      await f.rows(
        "select count(*)::int as stored from messaging.messages where body_text = 'only once'",
      ),
    ).toEqual([{ stored: 1 }]);
    expect(await f.rows('select inbound_count from messaging.webchat_sessions')).toEqual([
      { inbound_count: 2 },
    ]);
  });

  it('two first messages of one session make one contact and one conversation', async () => {
    const f = await world.fixture();
    const token = await world.started(f, { name: 'Maya', email: 'maya@example.test' });
    const holder = await world.open(f.context);
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    // Neither has a conversation to take yet, so both wait for the session itself.
    const first = world.handlers.send(f.admission, token, message('one'), request());
    await world.lockWaits(1);
    const second = world.handlers.send(f.admission, token, message('two'), request());
    await world.lockWaits(2);
    await holder.release();
    const settled = await Promise.allSettled([first, second]);
    const stored = settled.filter((each) => each.status === 'fulfilled');
    const turnedBack = settled.filter((each) => each.status === 'rejected');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toMatchObject({ outcome: 'ok', message: { seq: 1 } });
    // The other found the session changed under it and is asked to send again (409).
    expect(turnedBack).toHaveLength(1);
    expect(turnedBack[0]?.reason).toBeInstanceOf(ConflictError);
    expect(await f.rows('select count(*)::int as contacts from crm.contacts')).toEqual([
      { contacts: 1 },
    ]);
    expect(
      await f.rows('select count(*)::int as conversations from messaging.conversations'),
    ).toEqual([{ conversations: 1 }]);
    expect(await f.rows('select count(*)::int as messages from messaging.messages')).toEqual([
      { messages: 1 },
    ]);
  });

  it('two sessions that start at the last free place of the hour: one starts', async () => {
    const f = await world.fixture();
    await f.rows(
      `insert into messaging.webchat_sessions (business_id, widget_id, token_digest, origin, expires_at)
       select app.business_id(), $1, encode(sha256(n::text::bytea), 'hex'), $2, now() + interval '30 days'
       from generate_series(1, $3::integer) n`,
      [f.widgetId, ORIGIN, WEBCHAT_LIMITS.sessionsPerHour - 1],
    );
    const holder = await world.open(f.context);
    await free(holder, 'messaging.webchat_widgets', f.widgetId);
    const start = () =>
      world.handlers.start(
        f.admission,
        { email: `${randomUUID()}@example.test`, marketingConsent: false },
        request(),
      );
    const first = start();
    await world.lockWaits(1);
    const second = start();
    await world.lockWaits(2);
    await holder.release();
    const outcomes = (await Promise.all([first, second])).map((each) => each.outcome);
    expect(outcomes.toSorted()).toEqual(['limited', 'ok']);
    expect(
      await f.rows('select count(*)::int as sessions from messaging.webchat_sessions'),
    ).toEqual([{ sessions: WEBCHAT_LIMITS.sessionsPerHour }]);
  });

  it('an address someone signed in is adding meanwhile stays theirs: the visitor is new without it', async () => {
    const f = await world.fixture({ marketingConsentWording: 'Email me news and offers.' });
    const token = await world.started(f, { email: 'maya@example.test', marketingConsent: true });
    // A person on the team adds a contact with the same address; their command has written
    // it and has not committed. It does not take the senders' lock the chat takes.
    let finish = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let written = (): void => undefined;
    const writing = new Promise<void>((resolve) => {
      written = resolve;
    });
    const add = defineCommand({
      name: 'test.contact.add',
      permission: 'contacts.manage',
      input: z.strictObject({ email: z.string() }),
      async handle(trx, input, command): Promise<string> {
        const made = await createContactCommand.handle(
          trx,
          createContactInput.parse({ firstName: 'Maya', emails: [input.email] }),
          command,
        );
        written();
        await gate;
        return made.id;
      },
    });
    const user = await world.database.fixtures.user();
    const adding = runCommand(
      world.services,
      add,
      { email: 'maya@example.test' },
      {
        context: {
          ...f.context,
          actorKind: 'user',
          actorId: user.id,
          userId: user.id,
          correlationId: randomUUID(),
        },
        permissions: 'all',
      },
    );
    await writing;
    const sending = world.sent(f, token, 'hello');
    // The chat sees no holder yet, tries the address, and waits on the unique index.
    await world.lockWaits(1);
    finish();
    const added = parsePublicId('contact', await adding);
    expect(await sending).toMatchObject({ seq: 1, text: 'hello' });
    // The address is the team's contact's; the visitor is another contact, with the claim.
    expect(
      await f.rows('select contact_id from crm.contact_identities where kind = $1', ['email']),
    ).toEqual([{ contact_id: added }]);
    expect(await f.rows('select count(*)::int as contacts from crm.contacts')).toEqual([
      { contacts: 2 },
    ]);
    const [session] = await f.rows<{ contact_id: string; claimed_contact_id: string }>(
      'select contact_id, claimed_contact_id from messaging.webchat_sessions',
    );
    expect(session?.claimed_contact_id).toBe(added);
    expect(session?.contact_id).not.toBe(added);
    // And the tick is for an address the visitor's contact does not hold: no consent.
    expect(await f.rows('select 1 from messaging.consents')).toEqual([]);
  });

  it('housekeeping passes over a session that is in use, and never waits for it', async () => {
    await expireWebchatSessions(world.services);
    const f = await world.fixture();
    await world.started(f);
    await world.started(f);
    await f.rows(
      `update messaging.webchat_sessions
       set created_at = now() - interval '31 days', expires_at = now() - interval '1 second'`,
    );
    const holder = await world.open(f.context);
    await free(holder, 'messaging.webchat_sessions', await sessionId(f));
    // It returns while the row is still held: the other expired session went, this one stayed.
    expect(await expireWebchatSessions(world.services)).toBe(1);
    await holder.release();
    expect(await expireWebchatSessions(world.services)).toBe(1);
    expect(await f.rows('select 1 from messaging.webchat_sessions')).toEqual([]);
  });
});
