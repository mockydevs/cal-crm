// Migration 0068 at the database's own level: a company's email address, website, postal
// address and description, each empty until given and each held in one form. What the CRM
// module does with these is its own to prove.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

interface Scene {
  readonly context: TenantContext;
  readonly company: string;
}

async function scene(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context = { ...created.context, correlationId: randomUUID() };
  const company = await database.withTenant(context, async (sql) => {
    const record = await sql.one<{ id: string }>(
      `insert into crm.records (business_id, kind, object_type_id)
       select app.business_id(), 'company', id from crm.object_types where kind = 'company'
       returning id`,
    );
    await sql.query(
      `insert into crm.companies (business_id, id, name, created_by_kind)
       values (app.business_id(), $1, 'Acme Events', 'system')`,
      [record.id],
    );
    return record.id;
  });
  return { context, company };
}

/** What the database refuses a statement with, or undefined when it takes it. */
const refusal = async (run: Promise<unknown>): Promise<string | undefined> =>
  run.then(
    () => undefined,
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );

const columns =
  'email, website, address_line, city, state, postal_code, country, description' as const;

describe("a company's details", () => {
  it('are an email address, a website, an address and a description, each empty until given', async () => {
    const s = await scene();
    const read = () =>
      database.withTenant(s.context, (sql) =>
        sql.one<Record<string, string | null>>(
          `select ${columns} from crm.companies where id = $1`,
          [s.company],
        ),
      );
    expect(await read()).toEqual({
      email: null,
      website: null,
      address_line: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
      description: null,
    });
    const given = {
      email: 'hello@acme.example',
      website: 'www.acme.example/about',
      address_line: '12 Riverside Drive',
      city: 'Nairobi',
      state: 'Nairobi County',
      postal_code: '00100',
      country: 'KE',
      description: 'Plans weddings.\nAnd conferences.',
    };
    await database.withTenant(s.context, (sql) =>
      sql.query(
        `update crm.companies set email = $2, website = $3, address_line = $4, city = $5,
                state = $6, postal_code = $7, country = $8, description = $9 where id = $1`,
        [s.company, ...Object.values(given)],
      ),
    );
    expect(await read()).toEqual(given);
  });

  it.for([
    ["email = 'Hello@acme.example'", 'companies_email_format'],
    ["email = 'hello'", 'companies_email_format'],
    ["email = 'hello @acme.example'", 'companies_email_format'],
    ["email = ''", 'companies_email_format'],
    [`email = repeat('a', 308) || '@acme.example'`, 'companies_email_format'],
    ["website = ''", 'companies_website_text'],
    ["website = ' www.acme.example'", 'companies_website_text'],
    [`website = repeat('w', 2001)`, 'companies_website_text'],
    ["address_line = ''", 'companies_address_line_text'],
    ["address_line = '12 Riverside Drive '", 'companies_address_line_text'],
    [`address_line = repeat('a', 201)`, 'companies_address_line_text'],
    ["city = ''", 'companies_city_text'],
    ["city = ' Nairobi'", 'companies_city_text'],
    [`city = repeat('c', 201)`, 'companies_city_text'],
    ["state = ''", 'companies_state_text'],
    ["state = 'Coast '", 'companies_state_text'],
    [`state = repeat('s', 201)`, 'companies_state_text'],
    ["postal_code = ''", 'companies_postal_code_text'],
    ["postal_code = ' 00100'", 'companies_postal_code_text'],
    [`postal_code = repeat('9', 33)`, 'companies_postal_code_text'],
    ["country = 'ke'", 'companies_country_format'],
    ["country = 'KEN'", 'companies_country_format'],
    ["country = ''", 'companies_country_format'],
    ["description = ''", 'companies_description_text'],
    ["description = 'Plans weddings. '", 'companies_description_text'],
    [`description = repeat('d', 5001)`, 'companies_description_text'],
  ] as const)('refuses %s', async ([assignment, constraint]) => {
    const s = await scene();
    const message = await refusal(
      database.withTenant(s.context, (sql) =>
        sql.query(`update crm.companies set ${assignment} where id = $1`, [s.company]),
      ),
    );
    expect(message).toContain(constraint);
  });

  it('holds each at its longest', async () => {
    const s = await scene();
    await database.withTenant(s.context, (sql) =>
      sql.query(
        `update crm.companies set email = repeat('a', 307) || '@acme.example',
                website = repeat('w', 2000), address_line = repeat('a', 200),
                city = repeat('c', 200), state = repeat('s', 200),
                postal_code = repeat('9', 32), description = repeat('d', 5000) where id = $1`,
        [s.company],
      ),
    );
  });

  it("are not another business's to read", async () => {
    const mine = await scene();
    const theirs = await scene();
    await database.withTenant(mine.context, (sql) =>
      sql.query(`update crm.companies set email = 'hello@acme.example' where id = $1`, [
        mine.company,
      ]),
    );
    const seen = await database.withTenant(theirs.context, (sql) =>
      sql.query<{ email: string | null }>('select email from crm.companies'),
    );
    expect(seen).toEqual([{ email: null }]);
  });
});
