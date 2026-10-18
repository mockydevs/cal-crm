// Web chat on real Postgres: a visitor's chat from an allowed website becomes a conversation,
// and every safeguard of the public side holds in the database, not only in the transport.
// Beside it: what overlaps for real (locks, races) in webchat-locks.int.test.ts; the Inbox's
// triggers and its reply path in webchat-inbox.int.test.ts; the admin commands in
// webchat-widgets.int.test.ts.
import { randomUUID } from 'node:crypto';

import type { Services } from '@repo/commands';
import {
  publicWebchatConfig,
  publicWebchatSession,
  WEBCHAT_LIMITS,
  webchatSessionToken,
} from '@repo/contracts';
import { ValidationError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { newSessionToken, newWidgetKey } from './webchat-token.js';
import {
  message,
  ORIGIN,
  OTHER_ORIGIN,
  request,
  startWebchat,
  type WebchatWorld,
  type WidgetFixture,
} from '../test/webchat.js';
import { expireWebchatSessions } from './webchat-maintenance.js';
import type { PublicWebchatHandlers } from './webchat-public.js';

const ATTACK = '<img src=x onerror=alert(1)>\n<script>alert(1)</script> & "quotes"';

let world: WebchatWorld;
let database: TestDatabase;
let services: Services;
let handlers: PublicWebchatHandlers;
beforeAll(async () => {
  world = await startWebchat(inject('databaseServer'));
  ({ database, services, handlers } = world);
});
afterAll(async () => {
  await world.close();
});

type Fixture = WidgetFixture;
const fixture: WebchatWorld['fixture'] = (...values) => world.fixture(...values);
const started: WebchatWorld['started'] = (...values) => world.started(...values);
const sent: WebchatWorld['sent'] = (...values) => world.sent(...values);
const read: WebchatWorld['read'] = (...values) => world.read(...values);
const replied: WebchatWorld['replied'] = (...values) => world.replied(...values);
const conversationOf: WebchatWorld['conversationOf'] = (f) => world.conversationOf(f);

describe('the gate', () => {
  it('admits a listed website exactly, and answers with the stored origin', async () => {
    const f = await fixture();
    expect(f.admission).toEqual({
      agencyId: f.context.agencyId,
      businessId: f.business.id,
      widgetId: f.widgetId,
      origin: ORIGIN,
    });
    expect((await handlers.admit(f.key, OTHER_ORIGIN))?.origin).toBe(OTHER_ORIGIN);
  });

  it.each([
    ['another website', 'https://evil.test'],
    ['a host that starts with a listed one', 'https://example.com.evil.test'],
    ['user information hiding another host', 'https://example.com@evil.test'],
    ['a subdomain that is not listed', 'https://shop.example.com'],
    ['plain HTTP', 'http://example.com'],
    ['another port', 'https://example.com:8443'],
    ['a trailing slash', 'https://example.com/'],
    ['upper case', 'HTTPS://EXAMPLE.COM'],
    ['the opaque origin', 'null'],
    ['a wildcard', '*'],
    ['nothing', ''],
    ['no header', undefined],
    ['a repeated header', [ORIGIN, ORIGIN]],
  ])('refuses %s', async (_why, origin) => {
    const f = await fixture();
    expect(await handlers.admit(f.key, origin)).toBeUndefined();
  });

  it('refuses an unknown key and a malformed one', async () => {
    await fixture();
    expect(await handlers.admit(newWidgetKey(), ORIGIN)).toBeUndefined();
    for (const key of [
      '',
      'short',
      `${'a'.repeat(31)}'`,
      'a'.repeat(33),
      "' or 1=1 --".padEnd(32, 'a'),
    ])
      expect(await handlers.admit(key, ORIGIN)).toBeUndefined();
  });

  it('refuses a widget that is off, and one whose business is not active', async () => {
    const paused = await fixture();
    await paused.rows("update messaging.channel_accounts set status = 'paused' where id = $1", [
      paused.widgetId,
    ]);
    expect(await handlers.admit(paused.key, ORIGIN)).toBeUndefined();

    const suspended = await fixture();
    await database.as('crm_owner', (sql) =>
      sql.query("update tenancy.businesses set status = 'suspended' where id = $1", [
        suspended.business.id,
      ]),
    );
    expect(await handlers.admit(suspended.key, ORIGIN)).toBeUndefined();
  });

  it('refuses a widget with no website listed', async () => {
    const f = await fixture();
    await f.rows("update messaging.webchat_widgets set allowed_origins = '{}' where id = $1", [
      f.widgetId,
    ]);
    expect(await handlers.admit(f.key, ORIGIN)).toBeUndefined();
  });

  it('shows the widget what its form needs and nothing of its business', async () => {
    const f = await fixture({ marketingConsentWording: 'Email me news.' });
    const result = await handlers.config(f.admission);
    expect(result).toEqual({
      outcome: 'ok',
      config: {
        title: 'Chat with us',
        greeting: 'Hello.',
        emailRequired: true,
        marketingConsentWording: 'Email me news.',
        messageLength: WEBCHAT_LIMITS.messageLength,
      },
    });
    expect(
      publicWebchatConfig.safeParse(result.outcome === 'ok' ? result.config : null).success,
    ).toBe(true);
  });

  it('gives a widget saved without settings the defaults', async () => {
    const f = await fixture();
    await f.rows("update messaging.webchat_widgets set settings = '{}' where id = $1", [
      f.widgetId,
    ]);
    const result = await handlers.config(f.admission);
    expect(result).toMatchObject({
      outcome: 'ok',
      config: { emailRequired: true, marketingConsentWording: null },
    });
  });
});

describe('starting a session', () => {
  it('issues a random token once and stores only a digest of it', async () => {
    const f = await fixture();
    const result = await handlers.start(
      f.admission,
      { name: 'Maya Thompson', email: 'maya@example.test', marketingConsent: false },
      request(),
    );
    if (result.outcome !== 'ok') throw new Error(result.outcome);
    expect(publicWebchatSession.safeParse(result.session).success).toBe(true);
    const { token, expiresAt } = result.session;
    expect(webchatSessionToken.safeParse(token).success).toBe(true);
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(WEBCHAT_LIMITS.sessionDays - 0.01);
    expect(days).toBeLessThan(WEBCHAT_LIMITS.sessionDays + 0.01);

    const [row] = await f.rows<Record<string, unknown>>(
      'select to_jsonb(s) as row from messaging.webchat_sessions s',
    );
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(token);
    expect(stored).toMatch(/"token_digest": ?"[0-9a-f]{64}"/);
    expect(stored).toContain(ORIGIN);
    // And nowhere else: not in the audit log, not in the events.
    const elsewhere = await database.as('crm_owner', (sql) =>
      sql.query(
        `select 1 from audit.commands where input::text like '%' || $1 || '%'
         union all select 1 from events.events where payload::text like '%' || $1 || '%'`,
        [token],
      ),
    );
    expect(elsewhere).toEqual([]);
  });

  it('makes no contact and no conversation until there is a message', async () => {
    const f = await fixture();
    await started(f, { email: 'maya@example.test' });
    expect(await f.rows('select 1 from crm.contacts')).toEqual([]);
    expect(await f.rows('select 1 from messaging.conversations')).toEqual([]);
  });

  it('keeps no name, address, token or device address in the audit log', async () => {
    const f = await fixture();
    await started(f, { name: 'Maya Thompson', email: 'maya@example.test' });
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{
        input: unknown;
        ip: string | null;
        user_agent: string | null;
        actor_kind: string;
      }>(
        "select input, ip, user_agent, actor_kind from audit.commands where command = 'webchat.start_session' and business_id = $1",
        [f.business.id],
      ),
    );
    expect(audit).toEqual([
      {
        input: { widgetId: f.widgetId, origin: ORIGIN, email: true, marketingConsent: false },
        ip: null,
        user_agent: null,
        actor_kind: 'contact',
      },
    ]);
  });

  it('refuses a visitor without an email address when the widget requires one', async () => {
    const f = await fixture();
    expect(await handlers.start(f.admission, { marketingConsent: false }, request())).toEqual({
      outcome: 'invalid',
    });
    const optional = await fixture({ emailRequired: false });
    expect(
      (await handlers.start(optional.admission, { marketingConsent: false }, request())).outcome,
    ).toBe('ok');
  });

  it('refuses a tick the widget never offered, and one with no address to be for', async () => {
    const noBox = await fixture();
    expect(
      await handlers.start(
        noBox.admission,
        { email: 'maya@example.test', marketingConsent: true },
        request(),
      ),
    ).toEqual({ outcome: 'invalid' });
    const optional = await fixture({ emailRequired: false, marketingConsentWording: 'Email me.' });
    expect(await handlers.start(optional.admission, { marketingConsent: true }, request())).toEqual(
      { outcome: 'invalid' },
    );
    expect(await optional.rows('select 1 from messaging.webchat_sessions')).toEqual([]);
  });

  it('stops at the hourly limit of one widget, whoever asks, and starts again as sessions age', async () => {
    const f = await fixture();
    await f.rows(
      `insert into messaging.webchat_sessions (business_id, widget_id, token_digest, origin, expires_at)
       select app.business_id(), $1, encode(sha256(n::text::bytea), 'hex'), $2, now() + interval '30 days'
       from generate_series(1, $3::integer) n`,
      [f.widgetId, ORIGIN, WEBCHAT_LIMITS.sessionsPerHour - 1],
    );
    await started(f);
    const refused = await handlers.start(
      f.admission,
      { email: 'late@example.test', marketingConsent: false },
      request(),
    );
    expect(refused.outcome).toBe('limited');
    if (refused.outcome === 'limited') {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
    // Another widget of the same business is not affected.
    const other = await fixture({}, f.business);
    await started(other);
    await f.rows(
      "update messaging.webchat_sessions set created_at = created_at - interval '61 minutes', expires_at = expires_at - interval '61 minutes' where widget_id = $1",
      [f.widgetId],
    );
    await started(f);
  });

  it('stops at the daily limit too', async () => {
    const f = await fixture();
    await f.rows(
      `insert into messaging.webchat_sessions (business_id, widget_id, token_digest, origin, created_at, expires_at)
       select app.business_id(), $1, encode(sha256(n::text::bytea || 'day'), 'hex'), $2,
              now() - interval '2 hours', now() + interval '30 days'
       from generate_series(1, $3::integer) n`,
      [f.widgetId, ORIGIN, WEBCHAT_LIMITS.sessionsPerDay],
    );
    const refused = await handlers.start(
      f.admission,
      { email: 'late@example.test', marketingConsent: false },
      request(),
    );
    expect(refused.outcome).toBe('limited');
    if (refused.outcome === 'limited') expect(refused.retryAfterSeconds).toBeGreaterThan(3600);
  });

  it('removes expired sessions of the widget as new ones start, a bounded number at a time', async () => {
    const f = await fixture();
    await f.rows(
      `insert into messaging.webchat_sessions (business_id, widget_id, token_digest, origin, created_at, expires_at)
       select app.business_id(), $1, encode(sha256(n::text::bytea || 'old'), 'hex'), $2,
              now() - interval '40 days', now() - interval '10 days'
       from generate_series(1, 25) n`,
      [f.widgetId, ORIGIN],
    );
    await started(f);
    const [left] = await f.rows<{ expired: string; live: string }>(
      `select count(*) filter (where expires_at < now()) as expired,
              count(*) filter (where expires_at >= now()) as live
       from messaging.webchat_sessions`,
    );
    expect(left).toEqual({ expired: '5', live: '1' });
  });

  it('starts nothing for a widget turned off after the gate', async () => {
    const f = await fixture();
    await f.rows("update messaging.channel_accounts set status = 'paused' where id = $1", [
      f.widgetId,
    ]);
    expect(
      await handlers.start(
        f.admission,
        { email: 'a@example.test', marketingConsent: false },
        request(),
      ),
    ).toEqual({ outcome: 'unavailable' });
  });

  it('starts nothing for a website taken off the list after the gate', async () => {
    const f = await fixture();
    await f.rows('update messaging.webchat_widgets set allowed_origins = $2 where id = $1', [
      f.widgetId,
      [OTHER_ORIGIN],
    ]);
    expect(
      await handlers.start(
        f.admission,
        { email: 'a@example.test', marketingConsent: false },
        request(),
      ),
    ).toEqual({ outcome: 'unavailable' });
  });
});

describe('the first message', () => {
  it('says of the contact it makes that it came from a web chat, with an address or without', async () => {
    const f = await fixture();
    await sent(f, await started(f, { name: 'Maya Thompson', email: 'maya@example.test' }), 'Hi');
    // The same address again: this visitor becomes a contact without it.
    await sent(f, await started(f, { name: 'Someone Else', email: 'maya@example.test' }), 'Hi');
    expect(
      await f.rows('select created_by_kind, created_source from crm.contacts order by id'),
    ).toEqual([
      { created_by_kind: 'contact', created_source: 'webchat' },
      { created_by_kind: 'contact', created_source: 'webchat' },
    ]);
  });

  it('makes the contact and the conversation, and stores the text exactly, as text', async () => {
    const f = await fixture();
    const token = await started(f, { name: 'Maya Wanjiru Thompson', email: 'maya@example.test' });
    const stored = await sent(f, token, ATTACK);
    expect(stored).toMatchObject({ seq: 1, from: 'visitor', text: ATTACK });

    const [contact] = await f.rows<{ first_name: string; last_name: string; id: string }>(
      'select id, first_name, last_name from crm.contacts',
    );
    expect(contact).toMatchObject({ first_name: 'Maya', last_name: 'Wanjiru Thompson' });
    expect(
      await f.rows("select value_normalized from crm.contact_identities where kind = 'email'"),
    ).toEqual([{ value_normalized: 'maya@example.test' }]);
    expect(
      await f.rows(
        `select m.channel, m.direction, m.status, m.body_text, m.body_html, m.subject,
                m.channel_account_id, m.author_kind, m.author_id,
                c.contact_id, c.status as conversation, c.needs_reply, c.unread_count
         from messaging.messages m
         join messaging.conversations c on c.id = m.conversation_id`,
      ),
    ).toEqual([
      {
        channel: 'webchat',
        direction: 'inbound',
        status: 'received',
        body_text: ATTACK,
        body_html: null,
        subject: null,
        channel_account_id: f.widgetId,
        author_kind: 'contact',
        author_id: contact?.id,
        contact_id: contact?.id,
        conversation: 'open',
        needs_reply: true,
        unread_count: 1,
      },
    ]);
    // The details moved to the contact; the session keeps none.
    expect(
      await f.rows(
        `select visitor_name, visitor_email, marketing_consent, last_seq, inbound_count, contact_id,
                claimed_contact_id
         from messaging.webchat_sessions`,
      ),
    ).toEqual([
      {
        visitor_name: null,
        visitor_email: null,
        marketing_consent: false,
        last_seq: 1,
        inbound_count: 1,
        contact_id: contact?.id,
        claimed_contact_id: null,
      },
    ]);
  });

  it('reports the message on the contact timeline, with no text in the event or the audit log', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token, 'my private words');
    const logged = await database.as('crm_owner', (sql) =>
      sql.query<{ kind: string; body: string }>(
        `select 'event' as kind, type || ' ' || payload::text as body from events.events where business_id = $1
         union all
         select 'audit', command || ' ' || input::text || coalesce(ip::text, '') from audit.commands where business_id = $1`,
        [f.business.id],
      ),
    );
    expect(logged.some((row) => row.body.startsWith('message.received'))).toBe(true);
    expect(logged.some((row) => row.body.startsWith('webchat.send_message'))).toBe(true);
    for (const row of logged) {
      expect(row.body).not.toContain('my private words');
      expect(row.body).not.toContain(token);
    }
    expect(
      await f.rows("select 1 from crm.timeline_entries where event_type = 'message.received'"),
    ).toHaveLength(1);
  });

  it('never joins a contact that already has the address: the visitor is new, the address a claim', async () => {
    const f = await fixture();
    const known = await database.fixtures.contact(f.context, {
      firstName: 'Maya',
      lastName: 'Thompson',
      email: 'maya@example.test',
    });
    const before = await database.as('crm_owner', (sql) =>
      sql.query('select to_jsonb(c) as row from crm.contacts c where id = $1', [known.id]),
    );
    const token = await started(f, { name: 'Somebody Else', email: 'maya@example.test' });
    await sent(f, token, 'I am Maya, what did we agree?');
    // The stored contact is exactly as it was, and has no conversation because of this.
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query('select to_jsonb(c) as row from crm.contacts c where id = $1', [known.id]),
      ),
    ).toEqual(before);
    expect(
      await f.rows('select 1 from messaging.conversations where contact_id = $1', [known.id]),
    ).toEqual([]);
    // The visitor is a contact of their own, by the name they typed and without the address.
    const [visitor] = await f.rows<{ id: string; first_name: string; last_name: string }>(
      'select id, first_name, last_name from crm.contacts where id <> $1',
      [known.id],
    );
    expect(visitor).toMatchObject({ first_name: 'Somebody', last_name: 'Else' });
    expect(
      await f.rows('select contact_id from crm.contact_identities order by contact_id'),
    ).toEqual([{ contact_id: known.id }]);
    expect(await f.rows('select contact_id from messaging.conversations')).toEqual([
      { contact_id: visitor?.id },
    ]);
    // Who they said they were is kept for the team, as a claim.
    expect(
      await f.rows('select contact_id, claimed_contact_id from messaging.webchat_sessions'),
    ).toEqual([{ contact_id: visitor?.id, claimed_contact_id: known.id }]);
  });

  it('does the same when the holder of the address is in the trash', async () => {
    const f = await fixture();
    const trashed = await database.fixtures.contact(f.context, { email: 'gone@example.test' });
    await f.rows('update crm.contacts set deleted_at = now() where id = $1', [trashed.id]);
    const token = await started(f, { name: 'Maya', email: 'gone@example.test' });
    await sent(f, token);
    const contacts = await f.rows<{ id: string; first_name: string }>(
      'select id, first_name from crm.contacts where deleted_at is null',
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.first_name).toBe('Maya');
    expect(
      await f.rows('select 1 from crm.contact_identities where contact_id = $1', [contacts[0]?.id]),
    ).toEqual([]);
    expect(await f.rows('select claimed_contact_id from messaging.webchat_sessions')).toEqual([
      { claimed_contact_id: trashed.id },
    ]);
  });

  it('names a visitor who gave nothing, where the widget allows that', async () => {
    const f = await fixture({ emailRequired: false });
    const result = await handlers.start(f.admission, { marketingConsent: false }, request());
    if (result.outcome !== 'ok') throw new Error(result.outcome);
    await sent(f, result.session.token);
    expect(await f.rows('select first_name, last_name from crm.contacts')).toEqual([
      { first_name: 'Website visitor', last_name: null },
    ]);
  });

  it('stores a repeated request once and answers it the same', async () => {
    const f = await fixture();
    const token = await started(f);
    const input = message('Once');
    const first = await handlers.send(f.admission, token, input, request());
    const again = await handlers.send(f.admission, token, input, request());
    expect(again).toEqual(first);
    // The same id with other words is still the first message: nothing is overwritten.
    const other = await handlers.send(f.admission, token, { ...input, text: 'Twice' }, request());
    expect(other).toEqual(first);
    expect(await f.rows('select body_text from messaging.messages')).toEqual([
      { body_text: 'Once' },
    ]);
    expect(await f.rows('select inbound_count from messaging.webchat_sessions')).toEqual([
      { inbound_count: 1 },
    ]);
  });
});

describe('a session reads and writes only itself', () => {
  it('never shows one visitor another visitor, though both typed one address', async () => {
    const f = await fixture();
    const victim = await started(f, { email: 'shared@example.test' });
    await sent(f, victim, 'my order number is 1234');
    const theirs = await conversationOf(f);
    await replied(f, theirs, 'Thanks, we found order 1234.');
    // Someone else types the same address. They get a contact and a conversation of their
    // own, and nothing of the first visitor's: not the messages, not the replies.
    const impostor = await started(f, { email: 'shared@example.test' });
    expect((await read(f, impostor)).messages).toEqual([]);
    await sent(f, impostor, 'what did you tell me before?');
    const own = await conversationOf(f);
    expect(own).not.toBe(theirs);
    expect(await f.rows('select count(*)::int as n from messaging.conversations')).toEqual([
      { n: 2 },
    ]);
    // The team answers each where they wrote; neither answer crosses over.
    await replied(f, theirs, 'Your order ships on Monday.');
    await replied(f, own, 'Please tell us your order number.');
    expect((await read(f, impostor)).messages.map((each) => each.text)).toEqual([
      'what did you tell me before?',
      'Please tell us your order number.',
    ]);
    expect((await read(f, victim)).messages.map((each) => each.text)).toEqual([
      'my order number is 1234',
      'Thanks, we found order 1234.',
      'Your order ships on Monday.',
    ]);
    // The second visitor is marked as having claimed the first one's address.
    expect(
      await f.rows(
        `select (s.claimed_contact_id is not null) as claims
         from messaging.webchat_sessions s order by s.created_at, s.id`,
      ),
    ).toEqual([{ claims: false }, { claims: true }]);
  });

  it("never shows the conversation's other channels", async () => {
    const f = await fixture();
    const token = await started(f, { email: 'maya@example.test' });
    await sent(f, token, 'chat');
    const conversationId = await conversationOf(f);
    // A message of the same conversation and channel that belongs to no session of this
    // visitor: what an email, an SMS or a reply to someone else is, as far as a session goes.
    await f.rows(
      `insert into messaging.messages
         (business_id, conversation_id, channel, channel_account_id, direction, status, body_text, author_kind, idempotency_key)
       values (app.business_id(), $1, 'webchat', $2, 'outbound', 'sent', 'a reply to some other session', 'system', $3)`,
      [conversationId, f.widgetId, randomUUID()],
    );
    expect((await read(f, token)).messages.map((each) => each.text)).toEqual(['chat']);
  });

  it('gives a token nothing at another widget, in the same business or another', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token, 'mine');
    const sibling = await fixture({}, f.business);
    const stranger = await fixture();
    for (const other of [sibling, stranger]) {
      expect(await handlers.messages(other.admission, token, 0)).toEqual({
        outcome: 'session_invalid',
      });
      expect(await handlers.send(other.admission, token, message(), request())).toEqual({
        outcome: 'session_invalid',
      });
      expect(await handlers.end(other.admission, token, request())).toEqual({
        outcome: 'session_invalid',
      });
    }
    // A forged admission that names the right widget in the wrong business reads nothing:
    // row-level security has the last word.
    const forged = {
      ...f.admission,
      agencyId: stranger.admission.agencyId,
      businessId: stranger.business.id,
    };
    expect((await handlers.messages(forged, token, 0)).outcome).not.toBe('ok');
    expect((await read(f, token)).messages).toHaveLength(1);
  });

  it("gives a token nothing on another of the widget's own websites", async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token);
    const elsewhere = await handlers.admit(f.key, OTHER_ORIGIN);
    if (elsewhere === undefined) throw new Error('The second website was not admitted.');
    expect(await handlers.messages(elsewhere, token, 0)).toEqual({ outcome: 'session_invalid' });
    expect(await handlers.send(elsewhere, token, message(), request())).toEqual({
      outcome: 'session_invalid',
    });
  });

  it('gives nothing to a guessed, malformed or missing token, and to a digest used as one', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token);
    const [stored] = await f.rows<{ token_digest: string }>(
      'select token_digest from messaging.webchat_sessions',
    );
    for (const guess of [
      newSessionToken(),
      undefined,
      '',
      token.slice(1),
      `${token}A`,
      token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(),
      stored?.token_digest,
      "' or '1'='1",
    ]) {
      expect(await handlers.messages(f.admission, guess, 0)).toEqual({
        outcome: 'session_invalid',
      });
      expect(await handlers.send(f.admission, guess, message(), request())).toEqual({
        outcome: 'session_invalid',
      });
    }
    expect(await f.rows('select count(*) from messaging.messages')).toEqual([{ count: '1' }]);
  });

  it('stops answering at its expiry, and once the visitor ends it', async () => {
    const f = await fixture();
    const expired = await started(f);
    await sent(f, expired);
    await f.rows(
      "update messaging.webchat_sessions set created_at = now() - interval '31 days', expires_at = now() - interval '1 second'",
    );
    expect(await handlers.messages(f.admission, expired, 0)).toEqual({
      outcome: 'session_invalid',
    });
    expect(await handlers.send(f.admission, expired, message(), request())).toEqual({
      outcome: 'session_invalid',
    });

    const ended = await started(f, { name: 'Maya', email: 'maya@example.test' });
    expect(await handlers.end(f.admission, ended, request())).toEqual({ outcome: 'ok' });
    expect(await handlers.messages(f.admission, ended, 0)).toEqual({ outcome: 'session_invalid' });
    expect(await handlers.end(f.admission, ended, request())).toEqual({
      outcome: 'session_invalid',
    });
    // Ended before any message: the details it held are gone too.
    expect(
      await f.rows(
        'select visitor_name, visitor_email from messaging.webchat_sessions where ended_at is not null',
      ),
    ).toEqual([{ visitor_name: null, visitor_email: null }]);
  });

  it('stops answering while its widget is off, and answers again when it is back on', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token);
    await f.rows("update messaging.channel_accounts set status = 'paused' where id = $1", [
      f.widgetId,
    ]);
    expect(await handlers.messages(f.admission, token, 0)).toEqual({ outcome: 'unavailable' });
    expect(await handlers.send(f.admission, token, message(), request())).toEqual({
      outcome: 'unavailable',
    });
    await f.rows("update messaging.channel_accounts set status = 'active' where id = $1", [
      f.widgetId,
    ]);
    expect((await read(f, token)).messages).toHaveLength(1);
  });
});

describe('limits of a session', () => {
  it('takes ten messages in a minute and refuses the eleventh until the minute is over', async () => {
    const f = await fixture();
    const token = await started(f);
    for (let index = 0; index < WEBCHAT_LIMITS.messagesPerMinute; index += 1)
      await sent(f, token, `message ${String(index)}`);
    const refused = await handlers.send(f.admission, token, message('one too many'), request());
    expect(refused.outcome).toBe('limited');
    if (refused.outcome === 'limited') {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    expect(await f.rows('select count(*) from messaging.messages')).toEqual([{ count: '10' }]);
    await f.rows(
      "update messaging.webchat_sessions set minute_started_at = minute_started_at - interval '61 seconds'",
    );
    expect((await sent(f, token, 'after the minute')).seq).toBe(11);
  });

  it('refuses every message once the session has had its share', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token);
    await f.rows('update messaging.webchat_sessions set inbound_count = $1', [
      WEBCHAT_LIMITS.messagesPerSession,
    ]);
    expect(await handlers.send(f.admission, token, message(), request())).toEqual({
      outcome: 'session_full',
    });
    // It can still be read.
    expect((await read(f, token)).messages).toHaveLength(1);
  });

  it('numbers the messages of both sides in one line, in the order they were stored', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token, 'first');
    const conversationId = await conversationOf(f);
    await replied(f, conversationId, 'second');
    await sent(f, token, 'third');
    await replied(f, conversationId, 'fourth');
    const page = await read(f, token);
    expect(page.messages.map((each) => [each.seq, each.from, each.text])).toEqual([
      [1, 'visitor', 'first'],
      [2, 'team', 'second'],
      [3, 'visitor', 'third'],
      [4, 'team', 'fourth'],
    ]);
    expect(await f.rows('select last_seq, inbound_count from messaging.webchat_sessions')).toEqual([
      { last_seq: 4, inbound_count: 2 },
    ]);
  });

  it('reads a long chat a page at a time, and brings a place past the end back to it', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token, 'first');
    const conversationId = await conversationOf(f);
    for (let index = 0; index < WEBCHAT_LIMITS.pageSize + 4; index += 1)
      await replied(f, conversationId, `reply ${String(index)}`);
    const first = await read(f, token);
    expect(first.messages).toHaveLength(WEBCHAT_LIMITS.pageSize);
    expect(first).toMatchObject({ cursor: WEBCHAT_LIMITS.pageSize, more: true });
    const rest = await read(f, token, first.cursor);
    expect(rest.messages.map((each) => each.seq)).toEqual([51, 52, 53, 54, 55]);
    expect(rest).toMatchObject({ cursor: 55, more: false });
    expect(await read(f, token, 55)).toEqual({ messages: [], cursor: 55, more: false });
    expect(await read(f, token, 2_000_000)).toEqual({ messages: [], cursor: 55, more: false });
  });
});

describe('marketing consent', () => {
  const consents = (f: Fixture) =>
    f.rows<{
      channel: string;
      purpose: string;
      status: string;
      source: string;
      proof: object;
      recorded_by_kind: string;
    }>(
      'select channel, purpose, status, source, proof, recorded_by_kind from messaging.consents order by recorded_at',
    );

  it('is not given by chatting, or by giving an email address', async () => {
    const f = await fixture({ marketingConsentWording: 'Email me news and offers.' });
    const token = await started(f, { email: 'maya@example.test', marketingConsent: false });
    await sent(f, token);
    expect(await consents(f)).toEqual([]);
  });

  it('is recorded when the visitor ticked the box, with the words, the widget and the website', async () => {
    const f = await fixture({ marketingConsentWording: 'Email me news and offers.' });
    const token = await started(f, { email: 'maya@example.test', marketingConsent: true });
    // Nothing yet: there is no contact to consent until the first message.
    expect(await consents(f)).toEqual([]);
    await sent(f, token);
    expect(await consents(f)).toEqual([
      {
        channel: 'email',
        purpose: 'marketing',
        status: 'granted',
        source: 'form',
        proof: { wording: 'Email me news and offers.', widgetId: f.widgetId, pageUrl: ORIGIN },
        recorded_by_kind: 'contact',
      },
    ]);
    // Once: later messages record nothing more.
    await sent(f, token, 'second');
    expect(await consents(f)).toHaveLength(1);
  });

  it('keeps the words the visitor saw, though the widget changed them before the first message', async () => {
    const f = await fixture({ marketingConsentWording: 'Email me news and offers.' });
    const token = await started(f, { email: 'maya@example.test', marketingConsent: true });
    await f.rows(
      `update messaging.webchat_widgets set settings = settings || '{"marketingConsentWording":"Something else entirely."}' where id = $1`,
      [f.widgetId],
    );
    await sent(f, token);
    expect((await consents(f))[0]?.proof).toMatchObject({ wording: 'Email me news and offers.' });
  });

  it("never touches a stored contact's consent: a typed address is not its owner's word", async () => {
    const f = await fixture({ marketingConsentWording: 'Email me news and offers.' });
    const withdrawn = await database.fixtures.contact(f.context, { email: 'maya@example.test' });
    const silent = await database.fixtures.contact(f.context, { email: 'sam@example.test' });
    await f.rows(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, proof, recorded_by_kind, recorded_by_id)
       values (app.business_id(), $1, 'email', 'marketing', 'withdrawn', 'unsubscribe_link', '{}', 'contact', $1)`,
      [withdrawn.id],
    );
    // Neither a withdrawal is undone, nor is consent given for someone who never gave any.
    for (const email of ['maya@example.test', 'sam@example.test']) {
      const token = await started(f, { email, marketingConsent: true });
      await sent(f, token);
    }
    expect(
      await f.rows('select contact_id, status from messaging.consents order by recorded_at'),
    ).toEqual([{ contact_id: withdrawn.id, status: 'withdrawn' }]);
    expect(
      await f.rows('select 1 from messaging.consents where contact_id = $1', [silent.id]),
    ).toEqual([]);
  });

  it('records none for an address the contact does not hold', async () => {
    const f = await fixture({ marketingConsentWording: 'Email me news and offers.' });
    const trashed = await database.fixtures.contact(f.context, { email: 'gone@example.test' });
    await f.rows('update crm.contacts set deleted_at = now() where id = $1', [trashed.id]);
    const token = await started(f, { email: 'gone@example.test', marketingConsent: true });
    await sent(f, token);
    expect(await consents(f)).toEqual([]);
  });
});

describe("the team's reply", () => {
  it('reaches the visitor of that conversation, as text, and no other', async () => {
    const f = await fixture();
    const older = await started(f, { email: 'maya@example.test' });
    await sent(f, older, 'from my phone');
    const newer = await started(f, { email: 'maya@example.test' });
    await sent(f, newer, 'from my laptop');
    const conversationId = await conversationOf(f);
    const result = await replied(f, conversationId, ATTACK);
    expect(result.outcome).toBe('sent');
    expect((await read(f, newer)).messages.map((each) => [each.from, each.text])).toEqual([
      ['visitor', 'from my laptop'],
      ['team', ATTACK],
    ]);
    expect((await read(f, older)).messages).toHaveLength(1);
    expect(
      await f.rows(
        "select m.channel, m.direction, m.status, m.body_html, m.author_kind, c.needs_reply from messaging.messages m join messaging.conversations c on c.id = m.conversation_id where m.direction = 'outbound'",
      ),
    ).toEqual([
      {
        channel: 'webchat',
        direction: 'outbound',
        status: 'sent',
        body_html: null,
        author_kind: 'user',
        needs_reply: false,
      },
    ]);
  });

  it('goes to nobody once the visitor has left, though another visitor typed the same address', async () => {
    const f = await fixture();
    const first = await started(f, { email: 'shared@example.test' });
    await sent(f, first, 'first person');
    const second = await started(f, { email: 'shared@example.test' });
    await sent(f, second, 'second person');
    const conversationId = await conversationOf(f);
    expect(await handlers.end(f.admission, second, request())).toEqual({ outcome: 'ok' });
    // The answer to the second person is not handed to the first.
    expect(await replied(f, conversationId, 'For the second person only.')).toEqual({
      outcome: 'no_session',
      reason: 'visitor_left',
    });
    expect((await read(f, first)).messages.map((each) => each.text)).toEqual(['first person']);
    expect(await f.rows("select 1 from messaging.messages where direction = 'outbound'")).toEqual(
      [],
    );
    // The same when it expired instead.
    const third = await started(f, { email: 'shared@example.test' });
    await sent(f, third, 'third person');
    const thirdConversation = await conversationOf(f);
    await f.rows(
      `update messaging.webchat_sessions
       set created_at = now() - interval '31 days', expires_at = now() - interval '1 second'
       where conversation_id = $1`,
      [thirdConversation],
    );
    expect(await replied(f, thirdConversation, 'For the third person only.')).toEqual({
      outcome: 'no_session',
      reason: 'visitor_left',
    });
    expect((await read(f, first)).messages).toHaveLength(1);
  });

  it('is stored once when the request is repeated', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token);
    const conversationId = await conversationOf(f);
    const key = randomUUID();
    const first = await replied(f, conversationId, 'Hello', key);
    expect(await replied(f, conversationId, 'Hello', key)).toEqual(first);
    expect((await read(f, token)).messages).toHaveLength(2);
  });

  it('says why there is nobody to answer: the widget is off, the visitor left, or nobody chatted', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token);
    const conversationId = await conversationOf(f);
    await f.rows("update messaging.channel_accounts set status = 'paused' where id = $1", [
      f.widgetId,
    ]);
    expect(await replied(f, conversationId, 'Hello')).toEqual({
      outcome: 'no_session',
      reason: 'widget_off',
    });
    await f.rows("update messaging.channel_accounts set status = 'active' where id = $1", [
      f.widgetId,
    ]);
    await handlers.end(f.admission, token, request());
    expect(await replied(f, conversationId, 'Hello')).toEqual({
      outcome: 'no_session',
      reason: 'visitor_left',
    });
    expect(await replied(f, randomUUID(), 'Hello')).toEqual({
      outcome: 'no_session',
      reason: 'no_chat',
    });
    // A conversation that is not a chat at all.
    const emailed = await database.fixtures.contact(f.context, { email: 'post@example.test' });
    const [other] = await f.rows<{ id: string }>(
      'insert into messaging.conversations (business_id, contact_id) values (app.business_id(), $1) returning id',
      [emailed.id],
    );
    expect(await replied(f, other?.id ?? '', 'Hello')).toEqual({
      outcome: 'no_session',
      reason: 'no_chat',
    });
    expect(await f.rows("select 1 from messaging.messages where direction = 'outbound'")).toEqual(
      [],
    );
  });

  it('is held to the bounds of a visitor message, so it always fits what the widget reads', async () => {
    const f = await fixture();
    const token = await started(f);
    await sent(f, token);
    const conversationId = await conversationOf(f);
    for (const text of ['', '  ', 'a'.repeat(WEBCHAT_LIMITS.messageLength + 1), 'nul\u0000'])
      await expect(replied(f, conversationId, text)).rejects.toBeInstanceOf(ValidationError);
    await replied(f, conversationId, 'a'.repeat(WEBCHAT_LIMITS.messageLength));
    expect((await read(f, token)).messages).toHaveLength(2);
  });
});

describe('housekeeping', () => {
  it('removes expired sessions that never became a chat, in every business, with the details they held', async () => {
    // What earlier tests in this file left expired goes first, so the count below is exact.
    await expireWebchatSessions(services);
    const one = await fixture();
    const other = await fixture();
    const live = await started(one, { name: 'Maya', email: 'maya@example.test' });
    const chatted = await started(one, { email: 'kept@example.test' });
    await sent(one, chatted, 'kept with the conversation');
    await started(one, { name: 'Gone', email: 'gone@example.test' });
    await started(other, { name: 'Gone too', email: 'gone-too@example.test' });
    // The chat and the two abandoned forms are past their expiry; the first is not.
    for (const f of [one, other])
      await f.rows(
        `update messaging.webchat_sessions
         set created_at = now() - interval '31 days', expires_at = now() - interval '1 second'
         where visitor_email is distinct from 'maya@example.test'`,
      );
    expect(await expireWebchatSessions(services)).toBe(2);
    expect(await expireWebchatSessions(services)).toBe(0);
    // Left: the live form, and the chat. The chat holds no details; it stays because it is
    // what says its conversation came through web chat.
    expect(
      await one.rows(
        'select visitor_name, visitor_email, (contact_id is not null) as chat from messaging.webchat_sessions order by created_at, id',
      ),
    ).toEqual([
      { visitor_name: null, visitor_email: null, chat: true },
      { visitor_name: 'Maya', visitor_email: 'maya@example.test', chat: false },
    ]);
    expect(await other.rows('select 1 from messaging.webchat_sessions')).toEqual([]);
    expect(await one.rows('select 1 from messaging.webchat_session_messages')).toHaveLength(1);
    expect(await one.rows('select body_text from messaging.messages')).toEqual([
      { body_text: 'kept with the conversation' },
    ]);
    // The live session still answers; the expired chat is kept and answers nobody.
    expect((await read(one, live)).messages).toEqual([]);
    expect(await handlers.messages(one.admission, chatted, 0)).toEqual({
      outcome: 'session_invalid',
    });
  });
});
