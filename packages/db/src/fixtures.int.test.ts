import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let database: TestDatabase;
const agenciesMadeHere: string[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

async function agency(values?: { name: string }) {
  const made = await database.fixtures.agency(values);
  agenciesMadeHere.push(made.id);
  return made;
}

describe('fixtures', () => {
  it('create agencies, businesses, users and contacts that read back as created', async () => {
    const bluebird = await agency({ name: 'Bluebird Digital' });
    const business = await database.fixtures.business(bluebird.id, { name: 'Harbor Lights' });
    const user = await database.fixtures.user({ name: 'Dana Brooks' });
    const contact = await database.fixtures.contact(business.context, {
      firstName: 'Ravi',
      lastName: 'Shah',
      email: 'Ravi@Example.com',
    });

    const [row] = await database.withTenant(business.context, (sql) =>
      sql.query<{ display_name: string; email: string; business: string; agency: string }>(
        `select c.display_name, i.value_normalized as email, b.name as business, a.name as agency
         from crm.contacts c
         join crm.contact_identities i on i.business_id = c.business_id and i.contact_id = c.id
         join tenancy.businesses b on b.id = c.business_id
         join tenancy.agencies a on a.id = b.agency_id
         where c.id = $1`,
        [contact.id],
      ),
    );
    const [person] = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string }>('select name from auth.users where id = $1', [user.id]),
    );

    expect(row).toEqual({
      display_name: 'Ravi Shah',
      email: 'ravi@example.com',
      business: 'Harbor Lights',
      agency: 'Bluebird Digital',
    });
    expect(person).toEqual({ name: 'Dana Brooks' });
  });

  it('give each business the built-in object types', async () => {
    const business = await database.fixtures.business((await agency()).id);

    const kinds = await database.withTenant(business.context, (sql) =>
      sql.query<{ kind: string }>('select kind from crm.object_types order by kind'),
    );

    expect(kinds.map((row) => row.kind)).toEqual(['company', 'contact', 'deal']);
  });

  it('pick unique defaults, so a test can make as many as it needs', async () => {
    const { id } = await agency();

    const [first, second] = await Promise.all([
      database.fixtures.business(id),
      database.fixtures.business(id),
    ]);
    const [ada, grace] = await Promise.all([database.fixtures.user(), database.fixtures.user()]);

    expect(first.id).not.toBe(second.id);
    expect(ada.email).not.toBe(grace.email);
  });
});

describe('a test database', () => {
  it("holds only this file's rows, though other files run at the same time", async () => {
    await agency();

    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>('select id from tenancy.agencies'),
    );

    expect(rows.map((row) => row.id).sort()).toEqual([...agenciesMadeHere].sort());
  });
});
