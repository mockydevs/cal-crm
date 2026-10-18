import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { seedBusinessDefaults } from '../index.js';

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

/** A new business with nothing in it yet, as business.create makes it. */
async function bareBusiness(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const atAgency: TenantContext = {
    agencyId: agency.id,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  const suffix = randomUUID().slice(0, 8);
  const { id } = await database.withTenant(atAgency, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $3) returning id',
      [agency.id, `Business ${suffix}`, `business-${suffix}`],
    ),
  );
  return { ...atAgency, businessId: id };
}

const seed = (context: TenantContext) =>
  withTenant(db, context, (trx) => seedBusinessDefaults(trx, context.businessId ?? ''));

const read = <Row extends object>(context: TenantContext, text: string) =>
  database.withTenant(context, (sql) => sql.query<Row>(text));

describe('what every business starts with', () => {
  it('has contacts, companies and deals', async () => {
    const business = await bareBusiness();

    await seed(business);

    expect(
      await read(
        business,
        'select kind, key, singular_label, plural_label from crm.object_types order by key',
      ),
    ).toEqual([
      { kind: 'company', key: 'company', singular_label: 'Company', plural_label: 'Companies' },
      { kind: 'contact', key: 'contact', singular_label: 'Contact', plural_label: 'Contacts' },
      { kind: 'deal', key: 'deal', singular_label: 'Deal', plural_label: 'Deals' },
    ]);
  });

  it('links a deal to its contacts and company, and a contact to their company, each with a primary', async () => {
    const business = await bareBusiness();

    await seed(business);

    expect(
      await read(
        business,
        `select l.key, f.key as from_type, t.key as to_type, l.label, l.reverse_label, l.allows_primary,
                l.is_system, l.from_limit, l.to_limit
         from crm.link_types l
         join crm.object_types f on f.id = l.from_object_type_id
         join crm.object_types t on t.id = l.to_object_type_id
         order by l.key`,
      ),
    ).toEqual([
      {
        key: 'contact_company',
        from_type: 'contact',
        to_type: 'company',
        label: 'Company',
        reverse_label: 'Person',
        allows_primary: true,
        // The product's own: only their labels change, and nothing limits them.
        is_system: true,
        from_limit: null,
        to_limit: null,
      },
      {
        key: 'deal_company',
        from_type: 'deal',
        to_type: 'company',
        label: 'Company',
        reverse_label: 'Deal',
        allows_primary: true,
        is_system: true,
        from_limit: null,
        to_limit: null,
      },
      {
        key: 'deal_contact',
        from_type: 'deal',
        to_type: 'contact',
        label: 'Contact',
        reverse_label: 'Deal',
        allows_primary: true,
        is_system: true,
        from_limit: null,
        to_limit: null,
      },
    ]);
  });

  it('has a sales pipeline, its stages in order, each saying when a deal belongs there', async () => {
    const business = await bareBusiness();

    await seed(business);

    expect(await read(business, 'select name, position from crm.pipelines')).toEqual([
      { name: 'Sales', position: 0 },
    ]);
    const stages = await read<{
      name: string;
      position: number;
      win_probability: string;
      description: string;
    }>(
      business,
      'select name, position, win_probability, description from crm.pipeline_stages order by position',
    );
    expect(
      stages.map(({ name, position, win_probability }) => [name, position, win_probability]),
    ).toEqual([
      ['New lead', 0, '0.1000'],
      ['Contacted', 1, '0.2000'],
      ['Proposal sent', 2, '0.5000'],
      ['Negotiating', 3, '0.7500'],
    ]);
    for (const stage of stages) expect(stage.description).not.toBe('');
  });

  it("has the CRM's settings, at their defaults", async () => {
    const business = await bareBusiness();

    await seed(business);

    expect(
      await read(
        business,
        'select tag_creation, suggest_similar_tags, trash_retention_days from crm.settings',
      ),
    ).toEqual([{ tag_creation: 'admins', suggest_similar_tags: true, trash_retention_days: 30 }]);
  });

  it('touches only the business it seeds', async () => {
    const first = await bareBusiness();
    const second = await bareBusiness();

    await seed(first);

    expect(await read(second, 'select id from crm.object_types')).toEqual([]);
    expect(await read(second, 'select business_id from crm.settings')).toEqual([]);
  });
});
