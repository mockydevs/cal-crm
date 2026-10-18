// Migration 0070 (sites) at the database's own level: its tables' policies and grants, and
// the rules they keep whatever the code does. What the sites module does with these tables
// is the module's to prove.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const TENANT_TABLES = [
  'sites.domains',
  'sites.folders',
  'sites.page_versions',
  'sites.pages',
  'sites.redirects',
  'sites.saved_sections',
  'sites.security_headers',
  'sites.sites',
  'sites.step_stats_daily',
  'sites.steps',
  'sites.template_favorites',
];

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

interface Tenant {
  readonly id: string;
  readonly agency: { readonly id: string };
  readonly context: TenantContext;
}

async function business(agencyId?: string): Promise<Tenant> {
  const agency = agencyId === undefined ? await database.fixtures.agency() : { id: agencyId };
  const created = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  return { agency, id: created.id, context };
}

const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};
const denied = async (work: Promise<unknown>): Promise<void> => {
  await expect(work).rejects.toMatchObject({ code: '42501' });
};

/** One statement in its own committed transaction, as the business. */
const one = <Row extends object>(b: Tenant, text: string, values: readonly unknown[] = []) =>
  database.withTenant(b.context, (sql: Sql) => sql.one<Row>(text, values));
const run = (b: Tenant, text: string, values: readonly unknown[] = []) =>
  database.withTenant(b.context, (sql: Sql) => sql.query(text, values));

const host = (): string => `${randomUUID().slice(0, 13)}.example.com`;
const domain = (b: Tenant, hostname = host()) =>
  one<{ id: string }>(
    b,
    `insert into sites.domains (business_id, hostname, created_by_kind)
     values (app.business_id(), $1, 'user') returning id`,
    [hostname],
  );
const site = (b: Tenant, values: Record<string, unknown> = {}) =>
  one<{ id: string }>(
    b,
    `insert into sites.sites (business_id, kind, name, folder_id, domain_id, path, created_by_kind)
     values (app.business_id(), $1, $2, $3, $4, $5, 'user') returning id`,
    [
      values['kind'] ?? 'funnel',
      values['name'] ?? `Site ${randomUUID()}`,
      values['folder'] ?? null,
      values['domain'] ?? null,
      values['path'] ?? '',
    ],
  );
const step = (b: Tenant, siteId: string, values: Record<string, unknown> = {}) =>
  one<{ id: string }>(
    b,
    `insert into sites.steps (business_id, site_id, name, path, position, created_by_kind)
     values (app.business_id(), $1, 'Landing', $2, $3, 'user') returning id`,
    [siteId, values['path'] ?? 'landing', values['position'] ?? 0],
  );
const page = (b: Tenant, stepId: string, siteId: string, kind: string, role = 'control') =>
  one<{ id: string }>(
    b,
    `insert into sites.pages (business_id, step_id, site_id, site_kind, role)
     values (app.business_id(), $1, $2, $3, $4) returning id`,
    [stepId, siteId, kind, role],
  );
const version = (b: Tenant, pageId: string, number: number, document: unknown, format = 1) =>
  run(
    b,
    `insert into sites.page_versions (business_id, page_id, number, format, document, created_by_kind)
     values (app.business_id(), $1, $2, $3, $4, 'user')`,
    [pageId, number, format, JSON.stringify(document)],
  );

describe('migration 0070: sites', () => {
  it('protects every table with forced row-level security and its policy', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; forced: boolean; policy: string }>(
        `select c.oid::regclass::text as name, c.relrowsecurity and c.relforcerowsecurity as forced,
                (select string_agg(p.polname, ',' order by p.polname) from pg_policy p
                 where p.polrelid = c.oid) as policy
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'sites' and c.relkind = 'r' order by 1`,
      ),
    );
    const byName = (left: { name: string }, right: { name: string }) =>
      left.name < right.name ? -1 : 1;
    expect([...rows].sort(byName)).toEqual(
      [
        ...TENANT_TABLES.map((name) => ({ name, forced: true, policy: 'tenant_isolation' })),
        { name: 'sites.templates', forced: true, policy: 'scoped_isolation' },
      ].sort(byName),
    );
  });

  it('gives the application no way to rewrite a page version or a favourite', async () => {
    const b = await business();
    const made = await site(b);
    const pageId = (await page(b, (await step(b, made.id)).id, made.id, 'funnel')).id;
    await version(b, pageId, 1, { format: 1 });
    await denied(run(b, `update sites.page_versions set number = 2`));
    await denied(run(b, `update sites.template_favorites set created_at = now()`));
  });

  it('refuses a variation on a website, and a second control on any step', async () => {
    const b = await business();
    const website = await site(b, { kind: 'website' });
    const home = await step(b, website.id);
    await page(b, home.id, website.id, 'website');
    await refused(
      page(b, home.id, website.id, 'website', 'variation'),
      'pages_variation_in_funnel_only',
    );
    // Saying the website is a funnel does not get past it: the kind is the site's own.
    await expect(page(b, home.id, website.id, 'funnel', 'variation')).rejects.toMatchObject({
      code: '23503',
    });
    const funnel = await site(b);
    const landing = await step(b, funnel.id);
    await page(b, landing.id, funnel.id, 'funnel');
    await page(b, landing.id, funnel.id, 'funnel', 'variation');
    await refused(page(b, landing.id, funnel.id, 'funnel'), 'pages_role_unique');
  });

  it('keeps a step path once per site, and a published version among the saved ones', async () => {
    const b = await business();
    const funnel = await site(b);
    const landing = await step(b, funnel.id, { path: 'offers/spring' });
    await refused(step(b, funnel.id, { path: 'offers/spring', position: 1 }), 'steps_path_unique');
    for (const path of ['Offers', '/offers', 'offers/', 'a//b', 'a b'])
      await refused(step(b, funnel.id, { path, position: 5 }), 'steps_path_valid');
    const made = await page(b, landing.id, funnel.id, 'funnel');
    await refused(
      run(b, `update sites.pages set published_version = 2, published_at = now() where id = $1`, [
        made.id,
      ]),
      'pages_published_version_valid',
    );
    await refused(
      run(b, `update sites.pages set published_version = 1 where id = $1`, [made.id]),
      'pages_published_complete',
    );
  });

  it('holds a page version to an object that names the format it is stored under', async () => {
    const b = await business();
    const funnel = await site(b);
    const made = await page(b, (await step(b, funnel.id)).id, funnel.id, 'funnel');
    await version(b, made.id, 1, { format: 1, mode: 'visual' });
    await refused(version(b, made.id, 1, { format: 1 }), 'page_versions_number_unique');
    await refused(version(b, made.id, 2, [1]), 'page_versions_document_valid');
    await refused(version(b, made.id, 2, { format: 'one' }), 'page_versions_document_valid');
    await refused(version(b, made.id, 2, { format: 2 }), 'page_versions_format_matches');
  });

  it('lets one business in the whole install hold a host name, and one site answer at an address', async () => {
    const a = await business();
    const b = await business();
    const hostname = host();
    const held = await domain(a, hostname);
    await refused(domain(b, hostname), 'domains_hostname_unique');
    for (const bad of ['Example.com', 'localhost', 'a..example.com', '-a.example.com'])
      await refused(domain(a, bad), 'domains_hostname_valid');
    await site(a, { domain: held.id, path: 'spring' });
    await refused(site(a, { domain: held.id, path: 'spring' }), 'sites_domain_path_unique');
    // Without a domain any number of sites may share a path.
    await site(a, { path: 'spring' });
    await site(a, { path: 'spring' });
    await refused(
      run(
        a,
        `insert into sites.redirects (business_id, domain_id, path, created_by_kind)
         values (app.business_id(), $1, '/old', 'user')`,
        [held.id],
      ),
      'redirects_one_target',
    );
  });

  it('refuses a response header the server must control, and a value with a line break', async () => {
    const b = await business();
    const made = await site(b);
    const header = (name: string, value: string) =>
      run(
        b,
        `insert into sites.security_headers (business_id, site_id, name, value)
         values (app.business_id(), $1, $2, $3)`,
        [made.id, name, value],
      );
    await header('Content-Security-Policy', "default-src 'self'");
    await refused(header('content-security-policy', 'x'), 'security_headers_name_unique');
    await refused(header('Set-Cookie', 'a=b'), 'security_headers_name_valid');
    await refused(header('X-Test', 'a\r\nSet-Cookie: b'), 'security_headers_value_valid');
  });

  it("shows an agency's template to each of its businesses, a business's own to it alone, and neither to another agency", async () => {
    const a = await business();
    const sibling = await business(a.agency.id);
    const stranger = await business();
    const template = (name: string, own: boolean) =>
      run(
        a,
        `insert into sites.templates (agency_id, business_id, kind, name, format, content, created_by_kind)
         values (app.agency_id(), $1, 'funnel', $2, 1, '{}', 'user')`,
        [own ? a.id : null, name],
      );
    await template('Shared by the agency', false);
    await template('Ours alone', true);
    const names = async (b: Tenant) =>
      (
        await database.withTenant(b.context, (sql) =>
          sql.query<{ name: string }>(`select name from sites.templates order by name`),
        )
      ).map((row) => row.name);
    expect(await names(a)).toEqual(['Ours alone', 'Shared by the agency']);
    expect(await names(sibling)).toEqual(['Shared by the agency']);
    expect(await names(stranger)).toEqual([]);
  });

  it('takes a deleted site with everything under it, and leaves its folder and domain', async () => {
    const b = await business();
    const held = await domain(b);
    const folder = await one<{ id: string }>(
      b,
      `insert into sites.folders (business_id, kind, name, created_by_kind)
       values (app.business_id(), 'funnel', 'Campaigns', 'user') returning id`,
    );
    const funnel = await site(b, { folder: folder.id, domain: held.id });
    const landing = await step(b, funnel.id);
    const made = await page(b, landing.id, funnel.id, 'funnel');
    await version(b, made.id, 1, { format: 1 });
    await run(
      b,
      `insert into sites.step_stats_daily (business_id, page_id, day, step_id, site_id, views)
       values (app.business_id(), $1, current_date, $2, $3, 3)`,
      [made.id, landing.id, funnel.id],
    );
    await run(b, `update sites.domains set default_step_id = $1 where id = $2`, [
      landing.id,
      held.id,
    ]);
    await run(b, `delete from sites.sites where id = $1`, [funnel.id]);
    const left = await one<{ steps: string; versions: string; stats: string }>(
      b,
      `select (select count(*) from sites.steps)::text as steps,
              (select count(*) from sites.page_versions)::text as versions,
              (select count(*) from sites.step_stats_daily)::text as stats`,
    );
    expect(left).toEqual({ steps: '0', versions: '0', stats: '0' });
    const kept = await one<{ default_step_id: string | null; folders: string }>(
      b,
      `select default_step_id, (select count(*) from sites.folders)::text as folders
       from sites.domains where id = $1`,
      [held.id],
    );
    expect(kept).toEqual({ default_step_id: null, folders: '1' });
  });
});

describe('migration 0085: a site’s public key', () => {
  const keyOf = (b: Tenant, id: string) =>
    one<{ public_key: string }>(b, `select public_key from sites.sites where id = $1`, [id]);
  const resolve = (role: 'crm_app' | 'crm_auth' | 'crm_worker', key: string) =>
    database.as(role, (sql) =>
      sql.query<{ agency_id: string; business_id: string; site_id: string }>(
        `select agency_id, business_id, site_id from private.resolve_site($1)`,
        [key],
      ),
    );

  it('gives every site a random key of its own, in the one shape an address takes', async () => {
    const b = await business();
    const first = await keyOf(b, (await site(b)).id);
    const second = await keyOf(b, (await site(b)).id);
    expect(first.public_key).toMatch(/^[a-z0-9]{32}$/);
    expect(second.public_key).toMatch(/^[a-z0-9]{32}$/);
    expect(first.public_key).not.toBe(second.public_key);
    const made = await site(b);
    for (const bad of [
      'short',
      'UPPERCASEUPPERCASEUPPERCASE',
      `${'a'.repeat(31)}/`,
      'a'.repeat(65),
    ])
      await refused(
        run(b, `update sites.sites set public_key = $1 where id = $2`, [bad, made.id]),
        'sites_public_key_format',
      );
    // No two sites of the install share a key, in one business or across two.
    const other = await business();
    const theirs = await site(other);
    await refused(
      run(other, `update sites.sites set public_key = $1 where id = $2`, [
        first.public_key,
        theirs.id,
      ]),
      'sites_public_key_unique',
    );
  });

  it('finds a site’s business by its key before any tenant is known, for the application alone', async () => {
    const b = await business();
    const made = await site(b);
    const { public_key: key } = await keyOf(b, made.id);
    expect(await resolve('crm_app', key)).toEqual([
      { agency_id: b.agency.id, business_id: b.id, site_id: made.id },
    ]);
    // A key that names nothing, and text that is not a key at all, find nothing.
    expect(await resolve('crm_app', key.replace(/.$/, key.endsWith('0') ? '1' : '0'))).toEqual([]);
    expect(await resolve('crm_app', `${key}' or '1'='1`)).toEqual([]);
    expect(await resolve('crm_app', '')).toEqual([]);
    for (const role of ['crm_auth', 'crm_worker'] as const) await denied(resolve(role, key));
    // Without the function, the application sees no site until it is in the business.
    expect(
      await database.as('crm_app', (sql) =>
        sql.query(`select id from sites.sites where public_key = $1`, [key]),
      ),
    ).toEqual([]);
  });

  it('finds nothing for a site whose business is not active, or that was deleted', async () => {
    const b = await business();
    const made = await site(b);
    const { public_key: key } = await keyOf(b, made.id);
    await database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [b.id]),
    );
    expect(await resolve('crm_app', key)).toEqual([]);
    await database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'active' where id = $1`, [b.id]),
    );
    expect(await resolve('crm_app', key)).toHaveLength(1);
    await run(b, `delete from sites.sites where id = $1`, [made.id]);
    expect(await resolve('crm_app', key)).toEqual([]);
  });
});

describe('migration 0089: what a published page is made from, in one statement', () => {
  const stateOf = (
    role: 'crm_app' | 'crm_auth' | 'crm_worker',
    key: string,
    sections: string[] = [],
    forms: string[] = [],
  ) =>
    database.as(role, (sql) =>
      sql.query<{ agency_id: string; business_id: string; site_id: string; state: string }>(
        `select agency_id, business_id, site_id, state
         from private.site_page_state($1, $2::uuid[], $3::uuid[])`,
        [key, sections, forms],
      ),
    );
  const keyOf = async (b: Tenant, id: string): Promise<string> =>
    (await one<{ public_key: string }>(b, `select public_key from sites.sites where id = $1`, [id]))
      .public_key;
  const asOwner = (text: string, values: unknown[] = []) =>
    database.as('crm_owner', (sql) => sql.query<{ id: string }>(text, values));
  const newKey = () => randomUUID().replaceAll('-', '');

  it('names the site’s business and gives one value for an active business’s key, to crm_app alone', async () => {
    const b = await business();
    const made = await site(b);
    const key = await keyOf(b, made.id);
    const [found, ...more] = await stateOf('crm_app', key);
    expect(more).toEqual([]);
    expect(found).toMatchObject({ agency_id: b.agency.id, business_id: b.id, site_id: made.id });
    expect(JSON.parse(found?.state ?? '')).toEqual(['funnel', null, [], [], [], []]);
    // The same again: nothing changed, so the text is the same text.
    expect((await stateOf('crm_app', key))[0]?.state).toBe(found?.state);
    for (const role of ['crm_auth', 'crm_worker'] as const) await denied(stateOf(role, key));
    // No row for a key that names nothing, is not a key, or whose business is off.
    for (const other of ['a'.repeat(32), 'short', `${key}/`, key.toUpperCase()])
      expect(await stateOf('crm_app', other)).toEqual([]);
    await asOwner(`update tenancy.businesses set status = 'suspended' where id = $1`, [b.id]);
    expect(await stateOf('crm_app', key)).toEqual([]);
    const shape = await database.as('crm_owner', (sql) =>
      sql.one<{ definer: boolean; volatility: string; settings: string[]; open: boolean }>(
        `select p.prosecdef as definer, p.provolatile::text as volatility,
                array(select unnest(p.proconfig))::text[] as settings,
                p.proacl is null
                  or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as open
         from pg_proc p
         where p.oid = 'private.site_page_state(text, uuid[], uuid[])'::regprocedure`,
      ),
    );
    expect(shape).toEqual({
      definer: true,
      volatility: 's',
      settings: ['search_path=""'],
      open: false,
    });
  });

  it('changes with everything a page is made from, and with nothing else', async () => {
    const b = await business();
    const made = await site(b);
    const key = await keyOf(b, made.id);
    const first = await step(b, made.id, { path: 'landing', position: 0 });
    const control = await page(b, first.id, made.id, 'funnel');
    await run(
      b,
      `insert into sites.page_versions (business_id, page_id, number, format, document, created_by_kind)
       values (app.business_id(), $1, 1, 1, '{"format": 1}', 'user')`,
      [control.id],
    );
    const section = await one<{ id: string }>(
      b,
      `insert into sites.saved_sections (business_id, site_id, name, format, document, created_by_kind)
       values (app.business_id(), null, 'Footer', 1, '{"id": "f"}', 'user') returning id`,
    );
    const form = await one<{ id: string }>(
      b,
      `insert into forms.forms (business_id, name, definition, public_key)
       values (app.business_id(), 'Sign up', '{"fields": []}', $1) returning id`,
      [newKey()],
    );
    const read = async () =>
      (await stateOf('crm_app', key, [section.id], [form.id]))[0]?.state ?? 'no row';
    let last = await read();
    /** Makes a change and says whether the state is another text afterwards. */
    const changes = async (text: string, values: unknown[] = []): Promise<boolean> => {
      await asOwner(text, values);
      const next = await read();
      const changed = next !== last;
      last = next;
      return changed;
    };
    const where = [b.id, made.id];

    // Each of these is read by the renderer, so each must change the state.
    const readByTheRenderer: [string, unknown[]][] = [
      [
        `update sites.pages set published_version = 1, published_at = now() where id = $1`,
        [control.id],
      ],
      [`update sites.steps set name = 'Renamed' where id = $1`, [first.id]],
      [`update sites.steps set path = 'moved' where id = $1`, [first.id]],
      [`update sites.steps set position = 7 where id = $1`, [first.id]],
      [
        `with made as (
           insert into sites.steps (business_id, site_id, name, path, position, created_by_kind)
           values ($1, $2, 'Thanks', 'thanks', 8, 'user') returning business_id, id, site_id)
         insert into sites.pages (business_id, step_id, site_id, site_kind, role)
         select business_id, id, site_id, 'funnel', 'control' from made`,
        where,
      ],
      [
        `update sites.sites set favicon_url = 'https://img.example/i.png'
         where business_id = $1 and id = $2`,
        where,
      ],
      [
        `insert into sites.security_headers (business_id, site_id, name, value)
         values ($1, $2, 'Referrer-Policy', 'no-referrer')`,
        where,
      ],
      [
        `update sites.security_headers set value = 'origin' where business_id = $1 and site_id = $2`,
        where,
      ],
      [`update sites.saved_sections set document = '{"id": "g"}' where id = $1`, [section.id]],
      // Written again as it was: still a change, as far as anyone can tell without reading
      // it, and a page rendered once more for nothing costs little.
      [`update sites.saved_sections set name = 'Footer' where id = $1`, [section.id]],
      [
        `update forms.forms set status = 'published', published_definition = definition,
                published_at = now() where id = $1`,
        [form.id],
      ],
      [`update forms.forms set public_key = $2 where id = $1`, [form.id, newKey()]],
      [
        `update forms.forms set status = 'archived', published_definition = null,
                published_at = null where id = $1`,
        [form.id],
      ],
      [`delete from sites.saved_sections where id = $1`, [section.id]],
    ];
    for (const [text, values] of readByTheRenderer)
      expect(await changes(text, values), text).toBe(true);

    // None of these is on a page: an archived form is already left out, and a site's name,
    // its tracking code, a newer saved version and another site are not rendered.
    const onNoPage: [string, unknown[]][] = [
      [`delete from forms.forms where id = $1`, [form.id]],
      [
        `update sites.sites set name = 'Another name', head_code = '<!-- x -->'
         where business_id = $1 and id = $2`,
        where,
      ],
      [
        `insert into sites.page_versions (business_id, page_id, number, format, document, created_by_kind)
         values ($1, $2, 2, 1, '{"format": 1}', 'user')`,
        [b.id, control.id],
      ],
      [`update sites.pages set current_version = 2 where id = $1`, [control.id]],
      [
        `insert into sites.sites (business_id, kind, name, created_by_kind)
         values ($1, 'website', 'A second site', 'user')`,
        [b.id],
      ],
    ];
    for (const [text, values] of onNoPage) expect(await changes(text, values), text).toBe(false);
  });

  it('reads only the sections and forms of the key’s own business, whatever ids are asked about', async () => {
    const mine = await business();
    const theirs = await business();
    const made = await site(mine);
    const key = await keyOf(mine, made.id);
    const elsewhere = await site(mine);
    const insertSection = (b: Tenant, siteId: string | null) =>
      one<{ id: string }>(
        b,
        `insert into sites.saved_sections (business_id, site_id, name, format, document, created_by_kind)
         values (app.business_id(), $1, $2, 1, '{"id": "s"}', 'user') returning id`,
        [siteId, `Section ${randomUUID()}`],
      );
    const shared = await insertSection(mine, null);
    const own = await insertSection(mine, made.id);
    const otherSite = await insertSection(mine, elsewhere.id);
    const foreign = await insertSection(theirs, null);
    const foreignForm = await one<{ id: string }>(
      theirs,
      `insert into forms.forms (business_id, name, definition, public_key)
       values (app.business_id(), 'Theirs', '{"fields": []}', $1) returning id`,
      [newKey()],
    );
    const [found] = await stateOf(
      'crm_app',
      key,
      [shared.id, own.id, otherSite.id, foreign.id, randomUUID()],
      [foreignForm.id, randomUUID()],
    );
    const [, , , sections, forms] = JSON.parse(found?.state ?? '[]') as unknown[][];
    // The business's own shared section and this site's own: not another site's, and
    // nothing at all of another business.
    expect((sections ?? []).map((each) => (each as unknown[])[0]).sort()).toEqual(
      [shared.id, own.id].sort(),
    );
    expect(forms).toEqual([]);
    expect(found?.state).not.toContain(foreign.id);
    expect(found?.state).not.toContain(foreignForm.id);
  });
});

describe('migration 0090: a page’s working draft, and what a page is made from besides', () => {
  const keyOf = async (b: Tenant, id: string): Promise<string> =>
    (await one<{ public_key: string }>(b, `select public_key from sites.sites where id = $1`, [id]))
      .public_key;
  const asOwner = <Row extends object = { id: string }>(text: string, values: unknown[] = []) =>
    database.as('crm_owner', (sql) => sql.query<Row>(text, values));
  const draftOf = (b: Tenant, pageId: string, number: number, text = 'draft') =>
    run(
      b,
      `insert into sites.page_versions
         (business_id, page_id, number, format, document, created_by_kind, draft)
       values (app.business_id(), $1, $2, 1, $3, 'user', true)`,
      [pageId, number, JSON.stringify({ format: 1, text })],
    );
  const madePage = async (b: Tenant) => {
    const made = await site(b);
    const first = await step(b, made.id);
    const control = await page(b, first.id, made.id, 'funnel');
    await version(b, control.id, 1, { format: 1, text: 'kept' });
    return { site: made, page: control };
  };

  it('keeps every version there was as a kept one, written when it was created', async () => {
    const b = await business();
    const { page: control } = await madePage(b);
    const row = await one<{ draft: boolean; name: string | null; same: boolean }>(
      b,
      `select draft, name, updated_at >= created_at as same from sites.page_versions
       where page_id = $1`,
      [control.id],
    );
    expect(row).toEqual({ draft: false, name: null, same: true });
  });

  it('lets the application rewrite a working draft, and only its content, its name and its being open', async () => {
    const b = await business();
    const { page: control } = await madePage(b);
    await run(b, `update sites.pages set current_version = 2 where id = $1`, [control.id]);
    await draftOf(b, control.id, 2);
    const before = await one<{ updated_at: Date }>(
      b,
      `select updated_at from sites.page_versions where page_id = $1 and number = 2`,
      [control.id],
    );
    await run(
      b,
      `update sites.page_versions set document = '{"format": 1, "text": "again"}'
       where page_id = $1 and number = 2`,
      [control.id],
    );
    const after = await one<{ text: string; updated_at: Date; draft: boolean }>(
      b,
      `select document ->> 'text' as text, updated_at, draft from sites.page_versions
       where page_id = $1 and number = 2`,
      [control.id],
    );
    expect(after).toMatchObject({ text: 'again', draft: true });
    // The moment of the write is the table's own doing.
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    // Nothing else is the application's to change: no grant on any other column.
    for (const change of [
      'number = 3',
      'created_at = now()',
      `created_by_kind = 'system'`,
      'restored_from = 1',
      'updated_at = now()',
      'page_id = page_id',
    ])
      await denied(
        run(b, `update sites.page_versions set ${change} where page_id = $1 and number = 2`, [
          control.id,
        ]),
      );
    // A draft has no name; kept, it may take one, and then it is closed for good.
    await refused(
      run(b, `update sites.page_versions set name = 'Draft' where page_id = $1 and number = 2`, [
        control.id,
      ]),
      'page_versions_draft_unnamed',
    );
    await run(
      b,
      `update sites.page_versions set draft = false, name = 'Before the launch'
       where page_id = $1 and number = 2`,
      [control.id],
    );
    for (const name of [' padded ', '', 'n'.repeat(121)])
      await refused(
        run(
          b,
          `insert into sites.page_versions
             (business_id, page_id, number, format, document, created_by_kind, name)
           values (app.business_id(), $1, 9, 1, '{"format": 1}', 'user', $2)`,
          [control.id, name],
        ),
        'page_versions_name_valid',
      );
  });

  it('never lets a kept version be rewritten or opened again, by the application or the owner', async () => {
    const b = await business();
    const { page: control } = await madePage(b);
    for (const change of [
      `document = '{"format": 1, "text": "changed"}'`,
      `name = 'Renamed'`,
      'draft = true',
      'format = 1',
    ]) {
      await refused(
        run(b, `update sites.page_versions set ${change} where page_id = $1 and number = 1`, [
          control.id,
        ]),
        'page_versions_kept_immutable',
      );
      await refused(
        asOwner(`update sites.page_versions set ${change} where page_id = $1 and number = 1`, [
          control.id,
        ]),
        'page_versions_kept_immutable',
      );
    }
    // Even the owner changes nothing of a draft but what a draft is for.
    await run(b, `update sites.pages set current_version = 2 where id = $1`, [control.id]);
    await draftOf(b, control.id, 2);
    for (const change of ['number = 5', 'created_at = now()', `created_by_kind = 'system'`])
      await refused(
        asOwner(`update sites.page_versions set ${change} where page_id = $1 and number = 2`, [
          control.id,
        ]),
        'page_versions_identity_immutable',
      );
    expect(
      await one<{ text: string }>(
        b,
        `select document ->> 'text' as text from sites.page_versions
         where page_id = $1 and number = 1`,
        [control.id],
      ),
    ).toEqual({ text: 'kept' });
  });

  it('refuses to publish a working draft: what visitors are shown is a kept version', async () => {
    const b = await business();
    const { page: control } = await madePage(b);
    await run(b, `update sites.pages set current_version = 2 where id = $1`, [control.id]);
    await draftOf(b, control.id, 2);
    const publish = (number: number) =>
      run(b, `update sites.pages set published_version = $2, published_at = now() where id = $1`, [
        control.id,
        number,
      ]);
    await refused(publish(2), 'pages_published_version_kept');
    await publish(1);
    // Kept first, in the same transaction, it goes live.
    await database.withTenant(b.context, async (sql: Sql) => {
      await sql.query(
        `update sites.page_versions set draft = false where page_id = $1 and number = 2`,
        [control.id],
      );
      await sql.query(`update sites.pages set published_version = 2 where id = $1`, [control.id]);
    });
    // And from then on it is as closed as any kept version.
    await refused(
      run(
        b,
        `update sites.page_versions set document = '{"format": 1}' where page_id = $1 and number = 2`,
        [control.id],
      ),
      'page_versions_kept_immutable',
    );
    // Another page's draft of the same number is nothing to this page.
    const { page: other } = await madePage(b);
    await run(b, `update sites.pages set current_version = 2 where id = $1`, [other.id]);
    await draftOf(b, other.id, 2);
    await run(b, `update sites.pages set published_version = 2 where id = $1`, [control.id]);
  });

  it('adds a page’s calendars and the business’s custom values to what a page is made from', async () => {
    const b = await business();
    const made = await site(b);
    const key = await keyOf(b, made.id);
    const calendar = await one<{ id: string }>(
      b,
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug, is_active)
       values (app.business_id(), 'Intro', 'personal', 'UTC', 'intro', true) returning id`,
    );
    const stateOf = async (calendars: string[] = [calendar.id]) =>
      (
        await database.as('crm_app', (sql) =>
          sql.query<{ business_id: string; state: string }>(
            `select business_id, state
             from private.site_page_state($1, '{}'::uuid[], '{}'::uuid[], $2::uuid[])`,
            [key, calendars],
          ),
        )
      )[0];
    const first = await stateOf();
    expect(first?.business_id).toBe(b.id);
    const [inner, calendars, values] = JSON.parse(first?.state ?? '[]') as [
      unknown[],
      unknown[][],
      unknown[][],
    ];
    // The state of 0089, whole, then the two new parts.
    expect(inner).toEqual(['funnel', null, [], [], [], []]);
    expect(calendars).toHaveLength(1);
    // Not bookable: it has nobody to book and no mailbox, exactly as its booking page says.
    expect(calendars[0]?.[0]).toBe(calendar.id);
    expect(calendars[0]?.slice(3)).toEqual(['intro', false]);
    expect(values).toEqual([]);

    let last = first?.state;
    const changes = async (text: string, params: unknown[] = []): Promise<boolean> => {
      await asOwner(text, params);
      const next = (await stateOf())?.state;
      const changed = next !== last;
      last = next;
      return changed;
    };
    expect(
      await changes(`update calendar.calendars set booking_slug = 'moved' where id = $1`, [
        calendar.id,
      ]),
    ).toBe(true);
    expect(
      await changes(`update tenancy.businesses set slug = $2 where id = $1`, [
        b.id,
        `b-${randomUUID().slice(0, 8)}`,
      ]),
    ).toBe(true);
    expect(
      await changes(
        `insert into crm.custom_values (business_id, key, name, value, created_by_kind)
         values ($1, 'phone', 'Phone', '555-0100', 'user')`,
        [b.id],
      ),
    ).toBe(true);
    expect(
      await changes(`update crm.custom_values set value = '555-0199' where business_id = $1`, [
        b.id,
      ]),
    ).toBe(true);
    // A value with nothing in it fills in nothing: one that is added empty changes no page.
    expect(
      await changes(
        `insert into crm.custom_values (business_id, key, name, value, created_by_kind)
         values ($1, 'hours', 'Hours', '   ', 'user')`,
        [b.id],
      ),
    ).toBe(false);
    expect(
      await changes(`update calendar.calendars set name = 'Renamed' where id = $1`, [calendar.id]),
    ).toBe(false);
    // Another business's calendar and values are never part of this site's state.
    const theirs = await business();
    const foreign = await one<{ id: string }>(
      theirs,
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       values (app.business_id(), 'Theirs', 'personal', 'UTC', 'theirs') returning id`,
    );
    await asOwner(
      `insert into crm.custom_values (business_id, key, name, value, created_by_kind)
       values ($1, 'secret', 'Secret', 'not yours', 'user')`,
      [theirs.id],
    );
    const mixed = await stateOf([calendar.id, foreign.id, randomUUID()]);
    expect(mixed?.state).not.toContain(foreign.id);
    expect(mixed?.state).not.toContain('secret');
    expect(mixed?.state).toBe(last);
    // To crm_app alone, and nothing for a business that is off.
    for (const role of ['crm_auth', 'crm_worker'] as const)
      await denied(
        database.as(role, (sql) =>
          sql.query(
            `select state from private.site_page_state($1, '{}'::uuid[], '{}'::uuid[], '{}'::uuid[])`,
            [key],
          ),
        ),
      );
    await asOwner(`update tenancy.businesses set status = 'suspended' where id = $1`, [b.id]);
    expect(await stateOf()).toBeUndefined();
  });

  it('reads a business’s own calendars as links, with the names their address is made of', async () => {
    const b = await business();
    const theirs = await business();
    const insert = (who: Tenant, slug: string) =>
      one<{ id: string }>(
        who,
        `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
         values (app.business_id(), 'Intro', 'personal', 'UTC', $1) returning id`,
        [slug],
      );
    const mine = await insert(b, 'intro');
    const foreign = await insert(theirs, 'theirs');
    const names = (
      await asOwner<{ agency: string; business: string }>(
        `select g.slug as agency, b.slug as business
         from tenancy.businesses b join tenancy.agencies g on g.id = b.agency_id where b.id = $1`,
        [b.id],
      )
    )[0];
    const links = (who: Tenant) =>
      database.withTenant(who.context, (sql: Sql) =>
        sql.query(`select * from private.site_calendar_links($1::uuid[]) order by calendar_id`, [
          [mine.id, foreign.id, randomUUID()],
        ]),
      );
    expect(await links(b)).toEqual([
      {
        calendar_id: mine.id,
        agency_slug: names?.agency,
        business_slug: names?.business,
        calendar_slug: 'intro',
        bookable: false,
      },
    ]);
    // Each business sees its own and nothing of the other's, whatever ids it names.
    expect(
      (await links(theirs)).map((row) => (row as { calendar_id: string }).calendar_id),
    ).toEqual([foreign.id]);
    // With no business in the context there is nothing to read.
    expect(
      await database.as('crm_app', (sql) =>
        sql.query(`select * from private.site_calendar_links($1::uuid[])`, [[mine.id]]),
      ),
    ).toEqual([]);
    for (const role of ['crm_auth', 'crm_worker'] as const)
      await denied(
        database.as(role, (sql) =>
          sql.query(`select * from private.site_calendar_links('{}'::uuid[])`),
        ),
      );
  });

  it('keeps how a site’s visitors arrived unless told otherwise, and makes it part of a page’s state (0093)', async () => {
    const b = await business();
    const made = await site(b);
    const key = await keyOf(b, made.id);
    const settingOf = async () =>
      (
        await one<{ keep_arrival: string }>(
          b,
          'select keep_arrival from sites.sites where id = $1',
          [made.id],
        )
      ).keep_arrival;
    const stateOf = async () =>
      (
        await database.as('crm_app', (sql) =>
          sql.query<{ state: string }>(
            `select state from private.site_page_state($1, '{}'::uuid[], '{}'::uuid[], '{}'::uuid[])`,
            [key],
          ),
        )
      )[0]?.state ?? '';
    // What a site starts with, and what one from before the column reads as.
    expect(await settingOf()).toBe('unless_opted_out');
    const first = await stateOf();
    // The state of 0090, whole, then the setting.
    expect(JSON.parse(first)).toEqual([
      ['funnel', null, [], [], [], []],
      [],
      [],
      'unless_opted_out',
    ]);
    for (const value of ['always', 'never', 'unless_opted_out'] as const) {
      await run(b, 'update sites.sites set keep_arrival = $2 where id = $1', [made.id, value]);
      expect(await settingOf()).toBe(value);
      expect((JSON.parse(await stateOf()) as unknown[])[3]).toBe(value);
    }
    expect(await stateOf()).toBe(first);
    await run(b, `update sites.sites set keep_arrival = 'never' where id = $1`, [made.id]);
    expect(await stateOf()).not.toBe(first);
    for (const bad of ['', 'on', 'ALWAYS', 'sometimes'])
      await refused(
        run(b, 'update sites.sites set keep_arrival = $2 where id = $1', [made.id, bad]),
        'sites_keep_arrival_valid',
      );
    await expect(
      run(b, 'update sites.sites set keep_arrival = null where id = $1', [made.id]),
    ).rejects.toMatchObject({ code: '23502' });
  });
});
