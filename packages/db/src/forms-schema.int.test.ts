// Migration 0049 (forms) at the database's own level: what it adds to forms.forms and
// forms.submissions, their grants and policies, the key lookup, and what it does to a form
// an install already had. What the module does with these tables is the forms package's
// to prove (packages/modules/forms).
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@repo/kernel';
import {
  startPostgres,
  testDatabase,
  type Postgres,
  type Sql,
  type TestDatabase,
} from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const TABLES = ['forms.forms', 'forms.submissions'];
const FORMS = '0049_forms.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const key = (): string => randomBytes(24).toString('base64url');
const digest = (): string => randomBytes(32).toString('hex');

async function business() {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  return { agency, business: created, context };
}
const draft = (sql: Sql, publicKey = key()): Promise<{ id: string }> =>
  sql.one<{ id: string }>(
    `insert into forms.forms (business_id, name, definition, public_key)
     values (app.business_id(), 'Enquiry', '{"fields": []}', $1) returning id`,
    [publicKey],
  );
const published = (sql: Sql, publicKey = key()): Promise<{ id: string }> =>
  sql.one<{ id: string }>(
    `insert into forms.forms (business_id, name, definition, status, public_key, allowed_origins,
                              published_definition, published_at)
     values (app.business_id(), 'Enquiry', '{"fields": []}', 'published', $1,
             '{https://www.example.com}', '{"fields": []}', now()) returning id`,
    [publicKey],
  );
const SUBMISSION = `
  insert into forms.submissions (business_id, form_id, contact_id, data, client_submission_id,
                                 request_digest, origin, contact_outcome)
  values (app.business_id(), $1, $2, '{"email": {"label": "Email", "value": "a@example.test"}}',
          $3, $4, 'https://www.example.com', $5)
  returning id`;
const submission = (
  sql: Sql,
  formId: string,
  contactId: string | null,
  clientSubmissionId: string = randomUUID(),
): Promise<{ id: string }> =>
  sql.one<{ id: string }>(SUBMISSION, [
    formId,
    contactId,
    clientSubmissionId,
    digest(),
    contactId === null ? 'unresolved' : 'created',
  ]);
const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

describe('the tables', () => {
  it('have forced row-level security, the tenant policy, and one restrictive delete rule', async () => {
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
    expect(rows).toEqual([
      {
        name: 'forms.forms',
        enabled: true,
        forced: true,
        policies: ['tenant_isolation PERMISSIVE ALL'],
      },
      {
        name: 'forms.submissions',
        enabled: true,
        forced: true,
        policies: [
          'submissions_delete_unattached_only RESTRICTIVE DELETE',
          'tenant_isolation PERMISSIVE ALL',
        ],
      },
    ]);
  });

  it('grant crm_app what it uses and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ table_name: string; grantee: string; privileges: string[] }>(
        `select table_name::text, grantee::text,
                array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'forms'
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1, 2 order by 1, 2`,
      ),
    );
    expect(grants).toEqual([
      // The day's counts of views and submissions (migration 0078): added to, never deleted.
      { table_name: 'daily_stats', grantee: 'crm_app', privileges: ['INSERT', 'SELECT', 'UPDATE'] },
      {
        table_name: 'forms',
        grantee: 'crm_app',
        privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      },
      // No UPDATE: a stored submission is never changed.
      { table_name: 'submissions', grantee: 'crm_app', privileges: ['DELETE', 'INSERT', 'SELECT'] },
    ]);
  });

  it('read as empty with no tenant context', async () => {
    const { context } = await business();
    await database.withTenant(context, async (sql) => {
      const form = await draft(sql);
      await submission(sql, form.id, null);
    });
    for (const table of TABLES)
      expect(await database.as('crm_app', (sql) => sql.query(`select 1 from ${table}`))).toEqual(
        [],
      );
  });
});

describe('isolation between businesses', () => {
  it("hides one business's forms and submissions from another, and refuses writes across", async () => {
    const mine = await business();
    const theirs = await business();
    const made = await database.withTenant(mine.context, async (sql) => {
      const form = await published(sql);
      return { form, submission: await submission(sql, form.id, null) };
    });
    await database.withTenant(theirs.context, async (sql) => {
      expect(await sql.query('select 1 from forms.forms')).toEqual([]);
      expect(await sql.query('select 1 from forms.submissions')).toEqual([]);
      expect(
        await sql.query("update forms.forms set name = 'Taken' where id = $1 returning id", [
          made.form.id,
        ]),
      ).toEqual([]);
      expect(
        await sql.query('delete from forms.submissions where id = $1 returning id', [
          made.submission.id,
        ]),
      ).toEqual([]);
    });
    // A submission for another business's form has no form to belong to.
    await refused(
      database.withTenant(theirs.context, (sql) => submission(sql, made.form.id, null)),
      'submissions_business_id_form_id_fkey',
    );
    await expect(
      database.withTenant(theirs.context, (sql) =>
        sql.query(
          `insert into forms.submissions (business_id, form_id, data) values ($1, $2, '{}')`,
          [mine.business.id, made.form.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await database.withTenant(mine.context, async (sql) => {
      expect(await sql.query('select 1 from forms.forms')).toHaveLength(1);
      expect(await sql.query('select 1 from forms.submissions')).toHaveLength(1);
    });
  });
});

describe('a form', () => {
  it('is published exactly when it has a published definition and its time', async () => {
    const { context } = await business();
    const form = await database.withTenant(context, (sql) => draft(sql));
    const change = (set: string) =>
      database.withTenant(context, (sql) =>
        sql.query(`update forms.forms set ${set} where id = $1`, [form.id]),
      );
    await refused(change("status = 'published'"), 'forms_published_has_definition');
    await refused(
      change(`published_definition = '{"fields": []}', published_at = now()`),
      'forms_published_has_definition',
    );
    await refused(
      change(`status = 'published', published_definition = '{"fields": []}'`),
      'forms_published_at_with_definition',
    );
    await refused(
      change(`status = 'published', published_definition = '[]', published_at = now()`),
      'forms_published_definition_object',
    );
    await change(
      `status = 'published', published_definition = '{"fields": []}', published_at = now()`,
    );
    // Archiving or unpublishing must clear what was served.
    await refused(change("status = 'archived'"), 'forms_published_has_definition');
    await change("status = 'archived', published_definition = null, published_at = null");
  });

  it('lists at most 20 websites, and none that no request could match', async () => {
    const { context } = await business();
    const form = await database.withTenant(context, (sql) => draft(sql));
    const origins = (value: string, values: readonly unknown[] = []) =>
      database.withTenant(context, (sql) =>
        sql.query(`update forms.forms set allowed_origins = ${value} where id = $1`, [
          form.id,
          ...values,
        ]),
      );
    await origins(
      "array(select 'https://site-' || n || '.example.com' from generate_series(1, 20) n)",
    );
    await refused(
      origins("array(select 'https://site-' || n || '.example.com' from generate_series(1, 21) n)"),
      'forms_origins_bounded',
    );
    for (const bad of ["'{*}'", "'{null}'", "array['']", 'array[null]::text[]'])
      await refused(origins(bad), 'forms_origins_bounded');
  });

  it('refuses a definition no builder would write: too large, or not an object', async () => {
    const { context } = await business();
    const form = await database.withTenant(context, (sql) => draft(sql));
    const big = JSON.stringify({ fields: [], padding: 'x'.repeat(131_072) });
    await refused(
      database.withTenant(context, (sql) =>
        sql.query('update forms.forms set definition = $2::jsonb where id = $1', [form.id, big]),
      ),
      'forms_definition_bounded',
    );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `update forms.forms set status = 'published', published_at = now(),
             published_definition = $2::jsonb where id = $1`,
          [form.id, big],
        ),
      ),
      'forms_published_definition_bounded',
    );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(`update forms.forms set definition = '[]' where id = $1`, [form.id]),
      ),
      'forms_definition_object',
    );
  });
});

describe('a submission', () => {
  it('is stored once for each id the embed chose, in each form', async () => {
    const { context } = await business();
    const forms = await database.withTenant(context, async (sql) => [
      await published(sql),
      await published(sql),
    ]);
    const [first, second] = forms;
    if (first === undefined || second === undefined) throw new Error('Two forms were made.');
    const chosen = randomUUID();
    await database.withTenant(context, (sql) => submission(sql, first.id, null, chosen));
    await refused(
      database.withTenant(context, (sql) => submission(sql, first.id, null, chosen)),
      'submissions_request_unique',
    );
    // The same id on another form is another submission.
    await database.withTenant(context, (sql) => submission(sql, second.id, null, chosen));
  });

  it('keeps its request id and digest together, and a well-formed digest', async () => {
    const { context } = await business();
    const form = await database.withTenant(context, (sql) => published(sql));
    const insert = (columns: string, values: string, parameters: readonly unknown[] = []) =>
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into forms.submissions (business_id, form_id, data${columns})
           values (app.business_id(), $1, '{}'${values})`,
          [form.id, ...parameters],
        ),
      );
    await refused(
      insert(', client_submission_id', ', $2', [randomUUID()]),
      'submissions_request_paired',
    );
    await refused(insert(', request_digest', ', $2', [digest()]), 'submissions_request_paired');
    await refused(
      insert(', client_submission_id, request_digest', ', $2, $3', [randomUUID(), 'not-a-digest']),
      'submissions_digest_valid',
    );
    // A row from before 0049 has neither, and still fits.
    await insert('', '');
  });

  it('says what happened to its contact, and has none only when it was not attached', async () => {
    const { context } = await business();
    const contact = await database.fixtures.contact(context);
    const form = await database.withTenant(context, (sql) => published(sql));
    const insert = (contactId: string | null, outcome: string) =>
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into forms.submissions (business_id, form_id, contact_id, data, contact_outcome)
           values (app.business_id(), $1, $2, '{}', $3)`,
          [form.id, contactId, outcome],
        ),
      );
    await insert(contact.id, 'created');
    await insert(contact.id, 'updated');
    await insert(null, 'unresolved');
    await refused(insert(null, 'created'), 'submissions_outcome_matches_contact');
    await refused(insert(contact.id, 'unresolved'), 'submissions_outcome_matches_contact');
    await refused(insert(contact.id, 'merged'), 'submissions_contact_outcome_valid');
  });

  it('bounds everything a public request can fill', async () => {
    const { context } = await business();
    const form = await database.withTenant(context, (sql) => published(sql));
    const insert = (column: string, value: unknown, cast = '') =>
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into forms.submissions (business_id, form_id, data, ${column})
           values (app.business_id(), $1, '{}', $2${cast})`,
          [form.id, value],
        ),
      );
    await refused(insert('origin', 'x'.repeat(256)), 'submissions_origin_length');
    await refused(insert('origin', ''), 'submissions_origin_length');
    await refused(
      insert('page_url', `https://e.test/${'x'.repeat(2000)}`),
      'submissions_page_url_length',
    );
    await refused(insert('user_agent', 'x'.repeat(501)), 'submissions_user_agent_length');
    await refused(
      insert('consent', JSON.stringify({ padding: 'x'.repeat(16_384) }), '::jsonb'),
      'submissions_consent_bounded',
    );
    await refused(
      insert('utm', JSON.stringify({ padding: 'x'.repeat(4096) }), '::jsonb'),
      'submissions_utm_bounded',
    );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into forms.submissions (business_id, form_id, data)
           values (app.business_id(), $1, $2::jsonb)`,
          [form.id, JSON.stringify({ padding: 'x'.repeat(262_144) })],
        ),
      ),
      'submissions_data_bounded',
    );
  });

  it('cannot be changed, and can be deleted by the application only while it has no contact', async () => {
    const { context } = await business();
    const contact = await database.fixtures.contact(context);
    const made = await database.withTenant(context, async (sql) => {
      const form = await published(sql);
      return {
        attached: await submission(sql, form.id, contact.id),
        unattached: await submission(sql, form.id, null),
      };
    });
    await expect(
      database.withTenant(context, (sql) =>
        sql.query("update forms.submissions set data = '{}' where id = $1", [made.attached.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await database.withTenant(context, async (sql) => {
      // The restrictive policy hides the attached row from DELETE: nothing is removed.
      expect(
        await sql.query('delete from forms.submissions where id = $1 returning id', [
          made.attached.id,
        ]),
      ).toEqual([]);
      expect(await sql.query('delete from forms.submissions returning id')).toEqual([
        { id: made.unattached.id },
      ]);
      expect(await sql.query('select id from forms.submissions')).toEqual([
        { id: made.attached.id },
      ]);
    });
  });

  it('is erased with its contact, and with its form', async () => {
    const { context } = await business();
    const contact = await database.fixtures.contact(context);
    const made = await database.withTenant(context, async (sql) => {
      const kept = await published(sql);
      const removed = await published(sql);
      await submission(sql, kept.id, contact.id);
      await submission(sql, removed.id, null);
      return { kept, removed };
    });
    await database.withTenant(context, (sql) =>
      sql.query('delete from forms.forms where id = $1', [made.removed.id]),
    );
    expect(
      await database.withTenant(context, (sql) =>
        sql.query('select form_id from forms.submissions'),
      ),
    ).toEqual([{ form_id: made.kept.id }]);
    // Erasing a person is the owner's act (the trash purge runs it); the cascade is 0008's.
    await database.as('crm_owner', (sql) =>
      sql.query('delete from crm.records where id = $1', [contact.id]),
    );
    expect(
      await database.withTenant(context, (sql) => sql.query('select 1 from forms.submissions')),
    ).toEqual([]);
  });
});

describe('private.resolve_form', () => {
  const resolve = (publicKey: string) =>
    database.as('crm_app', (sql) =>
      sql.query<{ agency_id: string; business_id: string; form_id: string }>(
        'select * from private.resolve_form($1)',
        [publicKey],
      ),
    );

  it('names only a published form of an active business, by its exact key', async () => {
    const { agency, business: owner, context } = await business();
    const publicKey = key();
    const form = await database.withTenant(context, (sql) => published(sql, publicKey));
    const scope = [{ agency_id: agency.id, business_id: owner.id, form_id: form.id }];
    expect(await resolve(publicKey)).toEqual(scope);
    for (const other of [key(), `${publicKey}x`, publicKey.slice(1), '', 'a b', '%'])
      expect(await resolve(other)).toEqual([]);

    await database.as('crm_owner', (sql) =>
      sql.query("update tenancy.businesses set status = 'suspended' where id = $1", [owner.id]),
    );
    expect(await resolve(publicKey)).toEqual([]);
    await database.as('crm_owner', (sql) =>
      sql.query("update tenancy.businesses set status = 'active' where id = $1", [owner.id]),
    );
    expect(await resolve(publicKey)).toEqual(scope);

    for (const status of ['draft', 'archived']) {
      await database.withTenant(context, (sql) =>
        sql.query(
          'update forms.forms set status = $2, published_definition = null, published_at = null where id = $1',
          [form.id, status],
        ),
      );
      expect(await resolve(publicKey)).toEqual([]);
    }
  });

  it('is run by crm_app alone, with a pinned search path', async () => {
    const [row] = await database.as('crm_owner', (sql) =>
      sql.query<{ definer: boolean; config: string[]; app: boolean; open: boolean }>(
        `select p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('crm_app', p.oid, 'execute') as app,
                has_function_privilege('public', p.oid, 'execute') as open
         from pg_proc p where p.oid = 'private.resolve_form(text)'::regprocedure`,
      ),
    );
    expect(row).toEqual({ definer: true, config: ['search_path=""'], app: true, open: false });
    for (const role of ['crm_auth', 'crm_worker'] as const)
      await expect(
        database.as(role, (sql) => sql.query("select * from private.resolve_form('x')")),
      ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('an install that already had forms', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-forms-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < FORMS) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every form and submission, and a published form goes on serving what it had', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(FORMS);
    // crm_owner, as an import or a repair would write: it is not held to a tenant.
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    try {
      const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
        const { rows } = await owner.query<{ id: string }>(text, [...values]);
        const [row] = rows;
        if (row === undefined) throw new Error(`No row: ${text}`);
        return row.id;
      };
      const agency = await one(
        "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
      );
      const owned = await one(
        "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
        [agency],
      );
      const form = (status: string, definition: string) =>
        one(
          `insert into forms.forms (business_id, name, definition, status, public_key)
           values ($1, $2, $3::jsonb, $2, $4) returning id`,
          [owned, status, definition, `pk_upgrade_form_${status.padEnd(8, '0')}`],
        );
      const live = await form('published', '{"fields": [{"key": "email"}]}');
      const unfinished = await form('draft', '{"fields": []}');
      const old = await form('archived', '{"fields": []}');
      const submitted = await one(
        `insert into forms.submissions (business_id, form_id, data, ip, user_agent)
         values ($1, $2, '{"email": "kept@example.test"}', '203.0.113.9', 'Browser') returning id`,
        [owned, live],
      );

      const upgrade = await migrate({ connectionString });
      expect(upgrade.applied).toContain(FORMS);

      const forms = await owner.query<{
        id: string;
        status: string;
        served: unknown;
        dated: boolean;
        origins: string[];
      }>(
        `select id, status, published_definition as served, published_at is not null as dated,
                allowed_origins as origins
         from forms.forms order by created_at, id`,
      );
      expect(forms.rows).toEqual([
        {
          id: live,
          status: 'published',
          served: { fields: [{ key: 'email' }] },
          dated: true,
          origins: [],
        },
        { id: unfinished, status: 'draft', served: null, dated: false, origins: [] },
        { id: old, status: 'archived', served: null, dated: false, origins: [] },
      ]);
      const submissions = await owner.query(
        `select id, data, host(ip) as ip, user_agent, client_submission_id, request_digest, origin,
                page_url, contact_outcome
         from forms.submissions`,
      );
      expect(submissions.rows).toEqual([
        {
          id: submitted,
          data: { email: 'kept@example.test' },
          ip: '203.0.113.9',
          user_agent: 'Browser',
          client_submission_id: null,
          request_digest: null,
          origin: null,
          page_url: null,
          contact_outcome: null,
        },
      ]);
      const resolved = await owner.query(
        "select form_id from private.resolve_form('pk_upgrade_form_published')",
      );
      expect(resolved.rows).toEqual([{ form_id: live }]);
    } finally {
      await owner.end();
    }
  });
});
