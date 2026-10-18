// Migration 0065 (snippets, trigger links, manual actions) at the database's own level: its
// tables' policies and grants, the rules they keep whatever the code does, the one function
// that crosses businesses, and the trigger that takes a manual action off the queue when
// its run ends. What the modules do with these tables is theirs to prove.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const TABLES = [
  'automation.manual_actions',
  'messaging.snippet_folders',
  'messaging.snippets',
  'messaging.trigger_link_clicks',
  'messaging.trigger_link_tokens',
  'messaging.trigger_links',
];

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business() {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  const contact = (await database.fixtures.contact(context)).id;
  return { agency, id: created.id, context, contact };
}

const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};
const denied = async (work: Promise<unknown>): Promise<void> => {
  await expect(work).rejects.toMatchObject({ code: '42501' });
};

const snippet = (sql: Sql, values: Record<string, unknown> = {}) =>
  sql.one<{ id: string }>(
    `insert into messaging.snippets (business_id, kind, name, subject, body, folder_id, created_by_kind)
     values (app.business_id(), $1, $2, $3, $4, $5, 'user') returning id`,
    [
      values['kind'] ?? 'text',
      values['name'] ?? `Snippet ${randomUUID()}`,
      values['subject'] ?? null,
      values['body'] ?? 'Hi',
      values['folder'] ?? null,
    ],
  );
const folder = (sql: Sql, name = `Folder ${randomUUID()}`) =>
  sql.one<{ id: string }>(
    `insert into messaging.snippet_folders (business_id, name, created_by_kind)
     values (app.business_id(), $1, 'user') returning id`,
    [name],
  );
const link = (sql: Sql, values: Record<string, unknown> = {}) =>
  sql.one<{ id: string }>(
    `insert into messaging.trigger_links (business_id, name, key, url, created_by_kind)
     values (app.business_id(), $1, $2, $3, 'user') returning id`,
    [
      values['name'] ?? `Link ${randomUUID()}`,
      values['key'] ?? `k_${randomUUID().replaceAll('-', '')}`,
      values['url'] ?? 'https://harbor.example/offer',
    ],
  );
const token = (sql: Sql, linkId: string, contactId: string, digest: string) =>
  sql.one<{ id: string }>(
    `insert into messaging.trigger_link_tokens (business_id, link_id, contact_id, digest)
     values (app.business_id(), $1, $2, $3) returning id`,
    [linkId, contactId, digest],
  );
const digest = (): string => randomUUID().replaceAll('-', '').repeat(2);

/** A run of a new automation for the contact, waiting, and optionally a call it left. */
async function run(sql: Sql, contactId: string) {
  const automation = await sql.one<{ id: string }>(
    `insert into automation.automations (business_id, name, draft, created_by_kind)
     values (app.business_id(), $1, '{}', 'system') returning id`,
    [`Automation ${randomUUID()}`],
  );
  const version = await sql.one<{ id: string }>(
    `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
     values (app.business_id(), $1, 1, '{}', 'system') returning id`,
    [automation.id],
  );
  const enrolment = await sql.one<{ id: string }>(
    `insert into automation.enrolments
       (business_id, automation_id, version_id, record_id, status, reentry_key, current_step, correlation_id)
     values (app.business_id(), $1, $2, $3, 'waiting', uuidv7(), 'call', uuidv7()) returning id`,
    [automation.id, version.id, contactId],
  );
  return { automation: automation.id, enrolment: enrolment.id };
}
const action = (
  sql: Sql,
  of: { automation: string; enrolment: string },
  contactId: string,
  set = '',
) =>
  sql.one<{ id: string }>(
    `insert into automation.manual_actions
       (business_id, automation_id, enrolment_id, step_key, contact_id, kind ${set === '' ? '' : ', status, closed_at, closed_by_kind'})
     values (app.business_id(), $1, $2, 'call', $3, 'call' ${set}) returning id`,
    [of.automation, of.enrolment, contactId],
  );

describe('the tables', () => {
  it('have forced row-level security and the tenant policy alone', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.oid::regclass::text as name, c.relrowsecurity as enabled,
                c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = n.nspname and p.tablename = c.relname
                      order by 1) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.oid = any($1::regclass[]) order by 1`,
        [TABLES],
      ),
    );
    // Compared by name here: the database's own order of names is its collation's.
    const byName = (left: { name: string }, right: { name: string }) =>
      left.name < right.name ? -1 : 1;
    expect([...rows].sort(byName)).toEqual(
      TABLES.map((name) => ({
        name,
        enabled: true,
        forced: true,
        policies: ['tenant_isolation PERMISSIVE ALL'],
      })).sort(byName),
    );
  });

  it('grant crm_app what it uses and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; grantee: string; privileges: string[] }>(
        `select table_schema || '.' || table_name as name, grantee::text,
                array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema || '.' || table_name = any($1)
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1, 2 order by 1, 2`,
        [TABLES],
      ),
    );
    const all = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
    expect([...grants].sort((left, right) => (left.name < right.name ? -1 : 1))).toEqual([
      // No DELETE: what became of an action stays.
      {
        name: 'automation.manual_actions',
        grantee: 'crm_app',
        privileges: ['INSERT', 'SELECT', 'UPDATE'],
      },
      { name: 'messaging.snippet_folders', grantee: 'crm_app', privileges: all },
      { name: 'messaging.snippets', grantee: 'crm_app', privileges: all },
      // Append-only, both: a click and a token are written once.
      {
        name: 'messaging.trigger_link_clicks',
        grantee: 'crm_app',
        privileges: ['INSERT', 'SELECT'],
      },
      {
        name: 'messaging.trigger_link_tokens',
        grantee: 'crm_app',
        privileges: ['INSERT', 'SELECT'],
      },
      { name: 'messaging.trigger_links', grantee: 'crm_app', privileges: all },
    ]);
  });

  it('show a business only its own rows, and nothing with no tenant context', async () => {
    const a = await business();
    const b = await business();
    await database.withTenant(a.context, async (sql) => {
      const made = await link(sql);
      const issued = await token(sql, made.id, a.contact, digest());
      await sql.query(
        `insert into messaging.trigger_link_clicks (business_id, link_id, contact_id, token_id)
         values (app.business_id(), $1, $2, $3)`,
        [made.id, a.contact, issued.id],
      );
      await snippet(sql, { folder: (await folder(sql)).id });
      await action(sql, await run(sql, a.contact), a.contact);
    });
    const counts = (sql: Sql) =>
      Promise.all(
        TABLES.map(async (table) =>
          Number((await sql.one<{ n: string }>(`select count(*) as n from ${table}`)).n),
        ),
      );
    expect(await database.withTenant(a.context, counts)).toEqual(TABLES.map(() => 1));
    expect(await database.withTenant(b.context, counts)).toEqual(TABLES.map(() => 0));
    expect(await database.as('crm_app', counts)).toEqual(TABLES.map(() => 0));
    // And a row cannot be written into another business.
    await expect(
      database.withTenant(b.context, (sql) =>
        sql.query(
          `insert into messaging.snippets (business_id, kind, name, body, created_by_kind)
           values ($1, 'text', 'Theirs', 'Hi', 'user')`,
          [a.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('a snippet', () => {
  it('has a subject exactly when it is an email, on one line', async () => {
    const { context } = await business();
    await database.withTenant(context, (sql) => snippet(sql, { kind: 'email', subject: 'Hello' }));
    const tryOne = (values: Record<string, unknown>) =>
      database.withTenant(context, (sql) => snippet(sql, values));
    await refused(tryOne({ kind: 'email' }), 'snippets_subject_by_kind');
    await refused(tryOne({ kind: 'text', subject: 'Hello' }), 'snippets_subject_by_kind');
    await refused(tryOne({ kind: 'email', subject: 'A\nB' }), 'snippets_subject_valid');
    await refused(tryOne({ kind: 'email', subject: '' }), 'snippets_subject_valid');
    await refused(tryOne({ kind: 'whatsapp' }), 'snippets_kind_valid');
  });

  it('fits one text message when it is a text, and has a body and a name', async () => {
    const { context } = await business();
    const tryOne = (values: Record<string, unknown>) =>
      database.withTenant(context, (sql) => snippet(sql, values));
    await tryOne({ body: 'x'.repeat(1600) });
    await tryOne({ kind: 'email', subject: 'S', body: 'x'.repeat(1601) });
    await refused(tryOne({ body: 'x'.repeat(1601) }), 'snippets_text_length');
    await refused(tryOne({ body: '' }), 'snippets_body_length');
    await refused(tryOne({ name: '   ' }), 'snippets_name_length');
  });

  it('has a name no other snippet of its business has, whatever its capitals', async () => {
    const a = await business();
    const b = await business();
    await database.withTenant(a.context, (sql) => snippet(sql, { name: 'Running late' }));
    await refused(
      database.withTenant(a.context, (sql) => snippet(sql, { name: ' running LATE ' })),
      'snippets_name_unique',
    );
    await database.withTenant(b.context, (sql) => snippet(sql, { name: 'Running late' }));
  });

  it('stays, in no folder, when its folder is deleted; and takes only a folder of its business', async () => {
    const a = await business();
    const b = await business();
    const made = await database.withTenant(a.context, async (sql) => {
      const home = await folder(sql);
      const inside = await snippet(sql, { folder: home.id });
      await sql.query(`delete from messaging.snippet_folders where id = $1`, [home.id]);
      return sql.one<{ folder_id: string | null; business_id: string }>(
        `select folder_id, business_id from messaging.snippets where id = $1`,
        [inside.id],
      );
    });
    // Only the folder is cleared: the business stays.
    expect(made).toEqual({ folder_id: null, business_id: a.id });
    const theirs = await database.withTenant(b.context, (sql) => folder(sql));
    await expect(
      database.withTenant(a.context, (sql) => snippet(sql, { folder: theirs.id })),
    ).rejects.toMatchObject({ code: '23503' });
    await refused(
      database.withTenant(a.context, async (sql) => {
        await folder(sql, 'Follow-ups');
        await folder(sql, 'follow-ups ');
      }),
      'snippet_folders_name_unique',
    );
  });
});

describe('a trigger link', () => {
  it('keeps its key, and goes only to a web address', async () => {
    const { context } = await business();
    const made = await database.withTenant(context, (sql) => link(sql, { key: 'offer' }));
    const set = (column: string, value: string) =>
      database.withTenant(context, (sql) =>
        sql.query(`update messaging.trigger_links set ${column} = $2 where id = $1`, [
          made.id,
          value,
        ]),
      );
    await refused(set('key', 'other'), 'trigger_links_key_fixed');
    await set('url', 'http://harbor.example/plain');
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//harbor.example',
      '/offer',
      'https://harbor.example/a b',
      'https://harbor.example/\n',
      ' https://harbor.example/',
      '',
      `https://harbor.example/${'a'.repeat(2000)}`,
    ])
      await refused(set('url', url), 'trigger_links_url_valid');
    const tryOne = (values: Record<string, unknown>) =>
      database.withTenant(context, (sql) => link(sql, values));
    await refused(tryOne({ key: 'Offer' }), 'trigger_links_key_format');
    await refused(tryOne({ key: 'offer' }), 'trigger_links_key_unique');
    await refused(tryOne({ name: '  ' }), 'trigger_links_name_length');
  });

  it('holds tokens by a digest no other token has, and neither they nor clicks are changed', async () => {
    const a = await business();
    const b = await business();
    const same = digest();
    const made = await database.withTenant(a.context, async (sql) => {
      const of = await link(sql);
      const issued = await token(sql, of.id, a.contact, same);
      await sql.query(
        `insert into messaging.trigger_link_clicks (business_id, link_id, contact_id, token_id)
         values (app.business_id(), $1, $2, $3)`,
        [of.id, a.contact, issued.id],
      );
      return of;
    });
    // Unique across every business: a digest names one token on the whole install.
    await refused(
      database.withTenant(b.context, async (sql) =>
        token(sql, (await link(sql)).id, b.contact, same),
      ),
      'trigger_link_tokens_digest_idx',
    );
    await refused(
      database.withTenant(a.context, (sql) => token(sql, made.id, a.contact, 'not-a-digest')),
      'trigger_link_tokens_digest_valid',
    );
    const asApp = (text: string) => database.withTenant(a.context, (sql) => sql.query(text));
    await denied(asApp(`update messaging.trigger_link_tokens set digest = repeat('0', 64)`));
    await denied(asApp(`delete from messaging.trigger_link_tokens`));
    await denied(asApp(`update messaging.trigger_link_clicks set clicked_at = now()`));
    await denied(asApp(`delete from messaging.trigger_link_clicks`));
    // Deleting the link takes both with it.
    await asApp(`delete from messaging.trigger_links`);
    const left = await database.as('crm_owner', (sql) =>
      sql.one<{ tokens: string; clicks: string }>(
        `select (select count(*) from messaging.trigger_link_tokens where business_id = $1) as tokens,
                (select count(*) from messaging.trigger_link_clicks where business_id = $1) as clicks`,
        [a.id],
      ),
    );
    expect(left).toEqual({ tokens: '0', clicks: '0' });
  });

  it('is found from a digest alone by the scope function, which only crm_app may call', async () => {
    const a = await business();
    const mine = digest();
    const made = await database.withTenant(a.context, async (sql) => {
      const of = await link(sql, { url: 'https://harbor.example/mine' });
      return { link: of.id, token: (await token(sql, of.id, a.contact, mine)).id };
    });
    // With no tenant context at all, as the public endpoint calls it.
    const found = await database.as('crm_app', (sql) =>
      sql.query(`select * from private.trigger_link_scope($1)`, [mine]),
    );
    expect(found).toEqual([
      {
        agency_id: a.agency.id,
        business_id: a.id,
        token_id: made.token,
        link_id: made.link,
        contact_id: a.contact,
        url: 'https://harbor.example/mine',
      },
    ]);
    expect(
      await database.as('crm_app', (sql) =>
        sql.query(`select * from private.trigger_link_scope($1)`, [digest()]),
      ),
    ).toEqual([]);
    const callers = await database.as('crm_owner', (sql) =>
      sql.query<{ role: string; may: boolean }>(
        `select r as role, has_function_privilege(r, 'private.trigger_link_scope(text)', 'execute') as may
         from unnest(array['crm_app', 'crm_auth', 'crm_worker', 'public']) r order by 1`,
      ),
    );
    expect(callers.filter((caller) => caller.may).map((caller) => caller.role)).toEqual([
      'crm_app',
    ]);
  });
});

describe('a manual action', () => {
  it('is pending exactly while it is open, and a run has one open action at most', async () => {
    const { context, contact } = await business();
    await database.withTenant(context, async (sql) => {
      const of = await run(sql, contact);
      await action(sql, of, contact);
      // A closed one beside it is fine.
      await action(sql, of, contact, `, 'completed', now(), 'user'`);
    });
    const tryOne = (set: string, twice = false) =>
      database.withTenant(context, async (sql) => {
        const of = await run(sql, contact);
        await action(sql, of, contact, set);
        if (twice) await action(sql, of, contact, set);
      });
    await refused(tryOne('', true), 'manual_actions_one_open_idx');
    await refused(tryOne(`, 'pending', now(), 'user'`), 'manual_actions_closed_complete');
    await refused(tryOne(`, 'completed', null, null`), 'manual_actions_closed_complete');
    await refused(tryOne(`, 'skipped', now(), null`), 'manual_actions_closed_complete');
    await refused(tryOne(`, 'done', now(), 'user'`), 'manual_actions_status_valid');
    await refused(tryOne(`, 'skipped', now(), 'robot'`), 'manual_actions_closed_by_kind_valid');
    await denied(
      database.withTenant(context, (sql) => sql.query(`delete from automation.manual_actions`)),
    );
  });

  it('leaves the queue when its run ends, whatever ends it, and only then', async () => {
    const { context, contact } = await business();
    const statusAfter = (change: string) =>
      database.withTenant(context, async (sql) => {
        const of = await run(sql, contact);
        const made = await action(sql, of, contact);
        const closed = await action(sql, await run(sql, contact), contact);
        await sql.query(`update automation.enrolments set ${change} where id = $1`, [of.enrolment]);
        const rows = await sql.query<{ id: string; status: string; closed_by_kind: string | null }>(
          `select id, status, closed_by_kind from automation.manual_actions
           where id = any($1::uuid[])`,
          [[made.id, closed.id]],
        );
        return {
          mine: rows.find((row) => row.id === made.id),
          // Another run's action is never touched.
          other: rows.find((row) => row.id === closed.id)?.status,
        };
      });
    for (const ended of ['cancelled', 'exited', 'failed', 'completed'])
      expect(await statusAfter(`status = '${ended}', finished_at = now()`), ended).toMatchObject({
        mine: { status: 'cancelled', closed_by_kind: 'system' },
        other: 'pending',
      });
    // Still going: running again, or waiting with new state.
    expect(await statusAfter(`status = 'running'`)).toMatchObject({ mine: { status: 'pending' } });
    expect(await statusAfter(`state = '{"sequence": 2}'`)).toMatchObject({
      mine: { status: 'pending' },
    });
  });
});
