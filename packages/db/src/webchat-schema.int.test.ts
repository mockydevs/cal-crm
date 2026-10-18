// Migration 0047 (web chat) at the database's own level: isolation, constraints, grants and
// its one function. What the module does with these tables is the messaging package's to
// prove (webchat*.int.test.ts); what the migration does to rows an install already has is
// in webchat-upgrade.int.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const TABLES = ['messaging.webchat_sessions', 'messaging.webchat_session_messages'];

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const digest = (): string => randomBytes(32).toString('hex');
const key = (): string => randomBytes(24).toString('base64url');

/** A business with one web chat widget, as the admin command creates it. */
async function widget() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const id = await database.withTenant(context, async (sql) => {
    const channel = await sql.one<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name)
       values (app.business_id(), 'webchat', 'Main site') returning id`,
    );
    await sql.query(
      `insert into messaging.webchat_widgets (business_id, id, public_key, allowed_origins)
       values (app.business_id(), $1, $2, '{https://example.com}')`,
      [channel.id, key()],
    );
    return channel.id;
  });
  return { agency, business, context, widgetId: id };
}

const SESSION = `
  insert into messaging.webchat_sessions (business_id, widget_id, token_digest, origin, expires_at)
  values (app.business_id(), $1, $2, 'https://example.com', now() + interval '30 days')
  returning id`;

const session = (sql: Sql, widgetId: string, tokenDigest = digest()): Promise<{ id: string }> =>
  sql.one<{ id: string }>(SESSION, [widgetId, tokenDigest]);

/** A contact's conversation with one inbound web chat message. */
async function message(sql: Sql, contactId: string, widgetId: string) {
  const conversation = await sql.one<{ id: string }>(
    `insert into messaging.conversations (business_id, contact_id)
     values (app.business_id(), $1)
     on conflict (business_id, contact_id) do update set contact_id = excluded.contact_id
     returning id`,
    [contactId],
  );
  const stored = await sql.one<{ id: string }>(
    `insert into messaging.messages
       (business_id, conversation_id, channel, channel_account_id, direction, status,
        body_text, author_kind, author_id)
     values (app.business_id(), $1, 'webchat', $2, 'inbound', 'received', 'Hello', 'contact', $3)
     returning id`,
    [conversation.id, widgetId, contactId],
  );
  return { conversationId: conversation.id, messageId: stored.id };
}

const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

describe('the tables', () => {
  it('have forced row-level security with the one tenant policy', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.oid::regclass::text as name, c.relrowsecurity as enabled,
                c.relforcerowsecurity as forced,
                array(select p.polname::text from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c where c.oid = any($1::regclass[]) order by 1`,
        [TABLES],
      ),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({ enabled: true, forced: true, policies: ['tenant_isolation'] });
  });

  it('grant crm_app only what it uses, and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ table_name: string; grantee: string; privileges: string[] }>(
        `select table_name::text, grantee::text,
                array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'messaging'
           and table_name in ('webchat_sessions', 'webchat_session_messages')
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1, 2 order by 1, 2`,
      ),
    );
    expect(grants).toEqual([
      {
        table_name: 'webchat_session_messages',
        grantee: 'crm_app',
        privileges: ['INSERT', 'SELECT'],
      },
      {
        table_name: 'webchat_sessions',
        grantee: 'crm_app',
        privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      },
    ]);
  });

  it('read as empty with no tenant context', async () => {
    const { context, widgetId } = await widget();
    await database.withTenant(context, (sql) => session(sql, widgetId));
    for (const table of TABLES)
      expect(await database.as('crm_app', (sql) => sql.query(`select 1 from ${table}`))).toEqual(
        [],
      );
  });

  it('have no column that could hold a token or an address of a device', async () => {
    const columns = await database.as('crm_owner', (sql) =>
      sql.query<{ column_name: string }>(
        `select column_name::text from information_schema.columns
         where table_schema = 'messaging' and table_name = 'webchat_sessions' order by 1`,
      ),
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      'business_id',
      'claimed_contact_id',
      'consent_wording',
      'contact_id',
      'conversation_id',
      'created_at',
      'ended_at',
      'expires_at',
      'id',
      'inbound_count',
      'last_seq',
      'marketing_consent',
      'minute_count',
      'minute_started_at',
      'origin',
      'token_digest',
      'visitor_email',
      'visitor_name',
      'widget_id',
    ]);
  });
});

describe('isolation between businesses', () => {
  it("hides one business's sessions and message lists from another", async () => {
    const mine = await widget();
    const theirs = await widget();
    const contact = await database.fixtures.contact(mine.context);
    const made = await database.withTenant(mine.context, async (sql) => {
      const created = await session(sql, mine.widgetId);
      const stored = await message(sql, contact.id, mine.widgetId);
      await sql.query(
        `insert into messaging.webchat_session_messages (business_id, session_id, seq, message_id)
         values (app.business_id(), $1, 1, $2)`,
        [created.id, stored.messageId],
      );
      return created;
    });
    await database.withTenant(theirs.context, async (sql) => {
      expect(await sql.query('select 1 from messaging.webchat_sessions')).toEqual([]);
      expect(await sql.query('select 1 from messaging.webchat_session_messages')).toEqual([]);
      expect(
        await sql.query(
          'update messaging.webchat_sessions set ended_at = now() where id = $1 returning id',
          [made.id],
        ),
      ).toEqual([]);
      expect(
        await sql.query('delete from messaging.webchat_sessions where id = $1 returning id', [
          made.id,
        ]),
      ).toEqual([]);
    });
    await database.withTenant(mine.context, async (sql) => {
      expect(await sql.query('select 1 from messaging.webchat_sessions')).toHaveLength(1);
      expect(await sql.query('select 1 from messaging.webchat_session_messages')).toHaveLength(1);
    });
  });

  it("refuses a session written under another business's id, or for its widget", async () => {
    const mine = await widget();
    const theirs = await widget();
    await expect(
      database.withTenant(mine.context, (sql) =>
        sql.query(
          `insert into messaging.webchat_sessions (business_id, widget_id, token_digest, origin, expires_at)
           values ($1, $2, $3, 'https://example.com', now() + interval '1 day')`,
          [theirs.business.id, theirs.widgetId, digest()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Its own business id with the other's widget: the foreign key carries the business.
    await refused(
      database.withTenant(mine.context, (sql) => session(sql, theirs.widgetId)),
      'webchat_sessions_business_id_widget_id_fkey',
    );
  });
});

describe('a session', () => {
  it('stores a digest of exactly 64 hex characters, once in the whole install', async () => {
    const one = await widget();
    const other = await widget();
    const taken = digest();
    await database.withTenant(one.context, (sql) => session(sql, one.widgetId, taken));
    for (const bad of ['', 'abc', taken.toUpperCase(), `${taken}0`, taken.slice(1), 'g'.repeat(64)])
      await refused(
        database.withTenant(one.context, (sql) => session(sql, one.widgetId, bad)),
        'webchat_sessions_digest_valid',
      );
    // Unique across businesses too, though a digest has its widget in it and never repeats.
    await refused(
      database.withTenant(other.context, (sql) => session(sql, other.widgetId, taken)),
      'webchat_sessions_digest_unique',
    );
  });

  it.each([
    ['an empty origin', "origin = ''", 'webchat_sessions_origin_length'],
    [
      'an origin past 255 characters',
      "origin = repeat('a', 256)",
      'webchat_sessions_origin_length',
    ],
    ['an empty name', "visitor_name = ''", 'webchat_sessions_name_length'],
    ['a name past 80 characters', "visitor_name = repeat('a', 81)", 'webchat_sessions_name_length'],
    [
      'an email past 320 characters',
      "visitor_email = repeat('a', 321)",
      'webchat_sessions_email_length',
    ],
    [
      'consent without an email',
      "marketing_consent = true, consent_wording = 'Email me.'",
      'webchat_sessions_consent_has_proof',
    ],
    [
      'consent without the wording',
      "marketing_consent = true, visitor_email = 'a@example.test'",
      'webchat_sessions_consent_has_proof',
    ],
    [
      'wording without consent',
      "consent_wording = 'Email me.'",
      'webchat_sessions_wording_only_with_consent',
    ],
    [
      'wording past 300 characters',
      "marketing_consent = true, visitor_email = 'a@example.test', consent_wording = repeat('a', 301)",
      'webchat_sessions_wording_length',
    ],
    ['a negative place', 'last_seq = -1', 'webchat_sessions_seq_nonnegative'],
    ['a negative count', 'inbound_count = -1', 'webchat_sessions_inbound_nonnegative'],
    ['a window with a count but no start', 'minute_count = 1', 'webchat_sessions_window_complete'],
    [
      'a window with a start but no count',
      'minute_started_at = now()',
      'webchat_sessions_window_complete',
    ],
    [
      'an end before its start',
      "expires_at = created_at - interval '1 second'",
      'webchat_sessions_expiry_after_start',
    ],
  ])('refuses %s', async (_why, change, constraint) => {
    const { context, widgetId } = await widget();
    const made = await database.withTenant(context, (sql) => session(sql, widgetId));
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(`update messaging.webchat_sessions set ${change} where id = $1`, [made.id]),
      ),
      constraint,
    );
  });

  it('takes consent with an email and the wording, and a full minute window', async () => {
    const { context, widgetId } = await widget();
    const made = await database.withTenant(context, (sql) => session(sql, widgetId));
    await database.withTenant(context, (sql) =>
      sql.query(
        `update messaging.webchat_sessions
         set visitor_name = 'Maya', visitor_email = 'maya@example.test', marketing_consent = true,
             consent_wording = 'Email me news.', minute_started_at = now(), minute_count = 1
         where id = $1`,
        [made.id],
      ),
    );
  });

  it('has a contact and a conversation together or neither, and no details once it has them', async () => {
    const { context, widgetId } = await widget();
    const contact = await database.fixtures.contact(context);
    const made = await database.withTenant(context, async (sql) => {
      const created = await session(sql, widgetId);
      const stored = await message(sql, contact.id, widgetId);
      return { ...created, ...stored };
    });
    const update = (change: string, values: readonly unknown[]) =>
      database.withTenant(context, (sql) =>
        sql.query(`update messaging.webchat_sessions set ${change} where id = $1`, [
          made.id,
          ...values,
        ]),
      );
    await refused(
      update('contact_id = $2', [contact.id]),
      'webchat_sessions_contact_with_conversation',
    );
    await refused(
      update('conversation_id = $2', [made.conversationId]),
      'webchat_sessions_contact_with_conversation',
    );
    await refused(
      update("contact_id = $2, conversation_id = $3, visitor_email = 'maya@example.test'", [
        contact.id,
        made.conversationId,
      ]),
      'webchat_sessions_details_until_contact',
    );
    await update('contact_id = $2, conversation_id = $3', [contact.id, made.conversationId]);
  });

  it('is the only session of its contact and of its conversation', async () => {
    const { context, widgetId } = await widget();
    const contact = await database.fixtures.contact(context);
    const other = await database.fixtures.contact(context);
    const made = await database.withTenant(context, async (sql) => {
      const first = await session(sql, widgetId);
      const second = await session(sql, widgetId);
      const mine = await message(sql, contact.id, widgetId);
      const theirs = await message(sql, other.id, widgetId);
      await sql.query(
        'update messaging.webchat_sessions set contact_id = $2, conversation_id = $3 where id = $1',
        [first.id, contact.id, mine.conversationId],
      );
      return { second: second.id, mine: mine.conversationId, theirs: theirs.conversationId };
    });
    const bind = (contactId: string, conversationId: string) =>
      database.withTenant(context, (sql) =>
        sql.query(
          'update messaging.webchat_sessions set contact_id = $2, conversation_id = $3 where id = $1',
          [made.second, contactId, conversationId],
        ),
      );
    // A second session can never be given the same contact, and so never their conversation:
    // whatever a visitor typed, the team's reply has one session it can reach.
    await refused(bind(contact.id, made.mine), 'webchat_sessions_contact_unique');
    await refused(bind(other.id, made.mine), 'webchat_sessions_conversation_unique');
    await bind(other.id, made.theirs);
  });

  it('may name the contact whose address the visitor typed: another contact, kept as a claim', async () => {
    const { context, widgetId } = await widget();
    const contact = await database.fixtures.contact(context);
    const claimed = await database.fixtures.contact(context);
    const made = await database.withTenant(context, async (sql) => {
      const created = await session(sql, widgetId);
      const stored = await message(sql, contact.id, widgetId);
      return { ...created, ...stored };
    });
    const update = (change: string, values: readonly unknown[]) =>
      database.withTenant(context, (sql) =>
        sql.query(`update messaging.webchat_sessions set ${change} where id = $1`, [
          made.id,
          ...values,
        ]),
      );
    // Not before the session has a contact of its own, and never that contact itself.
    await refused(
      update('claimed_contact_id = $2', [claimed.id]),
      'webchat_sessions_claim_needs_contact',
    );
    await refused(
      update('contact_id = $2, conversation_id = $3, claimed_contact_id = $2', [
        contact.id,
        made.conversationId,
      ]),
      'webchat_sessions_claim_is_another',
    );
    await update('contact_id = $2, conversation_id = $3, claimed_contact_id = $4', [
      contact.id,
      made.conversationId,
      claimed.id,
    ]);
    // The claimed contact is deleted for good: the claim goes, the session and its contact stay.
    await database.as('crm_owner', (sql) =>
      sql.query('delete from crm.records where id = $1', [claimed.id]),
    );
    expect(
      await database.withTenant(context, (sql) =>
        sql.query('select contact_id, claimed_contact_id from messaging.webchat_sessions'),
      ),
    ).toEqual([{ contact_id: contact.id, claimed_contact_id: null }]);
  });

  it('goes with its widget', async () => {
    const { context, widgetId } = await widget();
    await database.withTenant(context, async (sql) => {
      await session(sql, widgetId);
      await sql.query('delete from messaging.channel_accounts where id = $1', [widgetId]);
      expect(await sql.query('select 1 from messaging.webchat_sessions')).toEqual([]);
    });
  });
});

describe("a session's message list", () => {
  async function listed() {
    const made = await widget();
    const contact = await database.fixtures.contact(made.context);
    const ids = await database.withTenant(made.context, async (sql) => {
      const created = await session(sql, made.widgetId);
      const first = await message(sql, contact.id, made.widgetId);
      const second = await message(sql, contact.id, made.widgetId);
      await sql.query(
        `insert into messaging.webchat_session_messages
           (business_id, session_id, seq, message_id, client_message_id)
         values (app.business_id(), $1, 1, $2, $3)`,
        [created.id, first.messageId, randomUUID()],
      );
      return { sessionId: created.id, first: first.messageId, second: second.messageId };
    });
    return { ...made, ...ids };
  }
  const link = (
    context: TenantContext,
    values: readonly [sessionId: string, seq: number, messageId: string, clientId: string | null],
  ) =>
    database.withTenant(context, (sql) =>
      sql.query(
        `insert into messaging.webchat_session_messages
           (business_id, session_id, seq, message_id, client_message_id)
         values (app.business_id(), $1, $2, $3, $4)`,
        values,
      ),
    );

  it('gives each place once, each message once, and each widget-chosen id once', async () => {
    const made = await listed();
    await refused(
      link(made.context, [made.sessionId, 1, made.second, null]),
      'webchat_session_messages_pkey',
    );
    await refused(
      link(made.context, [made.sessionId, 2, made.first, null]),
      'webchat_session_messages_message_unique',
    );
    await refused(
      link(made.context, [made.sessionId, 0, made.second, null]),
      'webchat_session_messages_seq_positive',
    );
    const chosen = await database.withTenant(made.context, (sql) =>
      sql.one<{ id: string }>(
        'select client_message_id as id from messaging.webchat_session_messages where session_id = $1',
        [made.sessionId],
      ),
    );
    await refused(
      link(made.context, [made.sessionId, 2, made.second, chosen.id]),
      'webchat_session_messages_client_unique',
    );
    // The team's replies carry no such id, and any number of them may.
    await link(made.context, [made.sessionId, 2, made.second, null]);
  });

  it('can be added to but not changed or deleted by the app, and goes with its session', async () => {
    const made = await listed();
    for (const statement of [
      'update messaging.webchat_session_messages set seq = 9',
      'delete from messaging.webchat_session_messages',
    ])
      await expect(
        database.withTenant(made.context, (sql) => sql.query(statement)),
      ).rejects.toMatchObject({ code: '42501' });
    await database.withTenant(made.context, async (sql) => {
      await sql.query('delete from messaging.webchat_sessions where id = $1', [made.sessionId]);
      expect(await sql.query('select 1 from messaging.webchat_session_messages')).toEqual([]);
      // The messages themselves stay with the business.
      expect(await sql.query('select 1 from messaging.messages')).toHaveLength(2);
    });
  });
});

describe("a widget's list of websites", () => {
  it.each([
    ['a NULL entry', "array['https://example.com', null]"],
    ['an empty entry', "array['']"],
    ['the opaque origin', "array['null']"],
    ['a wildcard', "array['*']"],
    [
      'more than 20 entries',
      "array(select 'https://site-' || n || '.example.com' from generate_series(1, 21) n)",
    ],
  ])('refuses %s', async (_why, list) => {
    const { context, widgetId } = await widget();
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(`update messaging.webchat_widgets set allowed_origins = ${list} where id = $1`, [
          widgetId,
        ]),
      ),
      'webchat_widgets_origins_bounded',
    );
  });

  it('takes none, and 20', async () => {
    const { context, widgetId } = await widget();
    await database.withTenant(context, async (sql) => {
      await sql.query("update messaging.webchat_widgets set allowed_origins = '{}' where id = $1", [
        widgetId,
      ]);
      await sql.query(
        `update messaging.webchat_widgets
         set allowed_origins = array(select 'https://site-' || n || '.example.com' from generate_series(1, 20) n)
         where id = $1`,
        [widgetId],
      );
    });
  });

  it('still resolves a key to its business, as before', async () => {
    const made = await widget();
    const publicKey = await database.withTenant(made.context, (sql) =>
      sql.one<{ public_key: string }>(
        'select public_key from messaging.webchat_widgets where id = $1',
        [made.widgetId],
      ),
    );
    expect(
      await database.as('crm_app', (sql) =>
        sql.query(
          'select agency_id, business_id, widget_id from private.resolve_webchat_widget($1)',
          [publicKey.public_key],
        ),
      ),
    ).toEqual([
      { agency_id: made.agency.id, business_id: made.business.id, widget_id: made.widgetId },
    ]);
    expect(
      await database.as('crm_app', (sql) =>
        sql.query('select 1 from private.resolve_webchat_widget($1)', [key()]),
      ),
    ).toEqual([]);
  });
});

describe('private.expire_webchat_sessions', () => {
  const expired = (sql: Sql, widgetId: string, age: string): Promise<{ id: string }> =>
    sql.one<{ id: string }>(
      `insert into messaging.webchat_sessions
         (business_id, widget_id, token_digest, origin, visitor_name, visitor_email, created_at, expires_at)
       values (app.business_id(), $1, $2, 'https://example.com', 'Maya', 'maya@example.test',
               now() - interval '40 days', now() - $3::interval)
       returning id`,
      [widgetId, digest(), age],
    );
  const expire = async (limit: number): Promise<number> => {
    const row = await database.as('crm_app', (sql) =>
      sql.one<{ deleted: number }>('select private.expire_webchat_sessions($1) as deleted', [
        limit,
      ]),
    );
    return row.deleted;
  };
  const left = (context: TenantContext): Promise<{ id: string }[]> =>
    database.withTenant(context, (sql) =>
      sql.query<{ id: string }>('select id from messaging.webchat_sessions order by expires_at'),
    );

  it('is for crm_app alone, and pins its search path', async () => {
    const [found] = await database.as('crm_owner', (sql) =>
      sql.query<{ definer: boolean; config: string[] | null; public: boolean; roles: string[] }>(
        `select p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('public', p.oid, 'execute') as public,
                array(select r.rolname::text from pg_roles r
                      where r.rolname in ('crm_app', 'crm_auth', 'crm_worker')
                        and has_function_privilege(r.oid, p.oid, 'execute') order by 1) as roles
         from pg_proc p
         where p.oid = 'private.expire_webchat_sessions(integer)'::regprocedure`,
      ),
    );
    expect(found).toEqual({
      definer: true,
      config: ['search_path=""'],
      public: false,
      roles: ['crm_app'],
    });
  });

  it('removes expired sessions of every business, oldest first, and leaves the live ones', async () => {
    // What earlier tests in this file left expired goes first, so the counts below are exact.
    await expire(10_000);
    const one = await widget();
    const other = await widget();
    await database.withTenant(one.context, (sql) => expired(sql, one.widgetId, '3 days'));
    const newer = await database.withTenant(other.context, (sql) =>
      expired(sql, other.widgetId, '1 second'),
    );
    const live = await database.withTenant(one.context, (sql) => session(sql, one.widgetId));
    // Called with no tenant context at all: the function is the one way across businesses.
    expect(await expire(1)).toBe(1);
    expect(await left(one.context)).toEqual([{ id: live.id }]);
    expect(await left(other.context)).toEqual([{ id: newer.id }]);
    expect(await expire(10_000)).toBe(1);
    expect(await expire(10_000)).toBe(0);
    expect(await left(one.context)).toEqual([{ id: live.id }]);
    expect(await left(other.context)).toEqual([]);
  });

  it('takes at least one and at most 10,000, whatever it is asked for', async () => {
    await expire(10_000);
    const { context, widgetId } = await widget();
    await database.withTenant(context, async (sql) => {
      await expired(sql, widgetId, '2 days');
      await expired(sql, widgetId, '1 day');
    });
    expect(await expire(0)).toBe(1);
    expect(await expire(-5)).toBe(1);
    expect(await expire(2_000_000_000)).toBe(0);
  });

  it('keeps a session that became a chat, however long ago it expired', async () => {
    await expire(10_000);
    const { context, widgetId } = await widget();
    const contact = await database.fixtures.contact(context);
    await database.withTenant(context, async (sql) => {
      const created = await expired(sql, widgetId, '1 day');
      const stored = await message(sql, contact.id, widgetId);
      await sql.query(
        `insert into messaging.webchat_session_messages (business_id, session_id, seq, message_id)
         values (app.business_id(), $1, 1, $2)`,
        [created.id, stored.messageId],
      );
      // The first message: the details go, the contact and the conversation come.
      await sql.query(
        `update messaging.webchat_sessions
         set visitor_name = null, visitor_email = null, contact_id = $2, conversation_id = $3
         where id = $1`,
        [created.id, contact.id, stored.conversationId],
      );
    });
    expect(await expire(10)).toBe(0);
    await database.withTenant(context, async (sql) => {
      expect(await sql.query('select 1 from messaging.webchat_sessions')).toHaveLength(1);
      expect(await sql.query('select 1 from messaging.webchat_session_messages')).toHaveLength(1);
    });
  });

  it('passes over a session another transaction holds, and never waits for it', async () => {
    await expire(10_000);
    const { context, widgetId } = await widget();
    const held = await database.withTenant(context, (sql) => expired(sql, widgetId, '1 day'));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database.withTenant(context, async (sql) => {
      await sql.query('select 1 from messaging.webchat_sessions where id = $1 for update', [
        held.id,
      ]);
      locked();
      await gate;
    });
    await holding;
    // It returns while the row is still held. Without SKIP LOCKED this call would wait for
    // the holder, which waits for this call: the test would stop here.
    expect(await expire(10)).toBe(0);
    release();
    await holder;
    expect(await expire(10)).toBe(1);
  });
});

describe('beside the Inbox (0046)', () => {
  it('numbers a chat message in its conversation, apart from its place in the session', async () => {
    const { context, widgetId } = await widget();
    const contact = await database.fixtures.contact(context);
    await database.withTenant(context, async (sql) => {
      const created = await session(sql, widgetId);
      const first = await message(sql, contact.id, widgetId);
      // A message of the same conversation that is no part of this session.
      await message(sql, contact.id, widgetId);
      const third = await message(sql, contact.id, widgetId);
      for (const [index, stored] of [first, third].entries())
        await sql.query(
          `insert into messaging.webchat_session_messages (business_id, session_id, seq, message_id)
           values (app.business_id(), $1, $2, $3)`,
          [created.id, index + 1, stored.messageId],
        );
      expect(
        await sql.query(
          `select m.seq as conversation_seq, l.seq as session_seq
           from messaging.messages m
           left join messaging.webchat_session_messages l on l.message_id = m.id
           order by m.seq`,
        ),
      ).toEqual([
        { conversation_seq: '1', session_seq: 1 },
        { conversation_seq: '2', session_seq: null },
        { conversation_seq: '3', session_seq: 2 },
      ]);
      expect(
        await sql.query(
          'select message_seq, unread_count, needs_reply from messaging.conversations',
        ),
      ).toEqual([{ message_seq: '3', unread_count: 3, needs_reply: true }]);
    });
  });
});
