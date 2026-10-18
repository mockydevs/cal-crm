import { performance } from 'node:perf_hooks';

import { actorKinds } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let database: TestDatabase;
let readyInMilliseconds: number;

beforeAll(async () => {
  const started = performance.now();
  database = await testDatabase(inject('databaseServer'));
  readyInMilliseconds = performance.now() - started;
});

afterAll(async () => {
  await database.close();
});

describe('a test file', () => {
  it('gets a migrated database of its own in under 2 seconds', () => {
    process.stdout.write(`database ready in ${String(Math.round(readyInMilliseconds))} ms\n`);
    expect(readyInMilliseconds).toBeLessThan(2000);
  });
});

describe('row-level security', () => {
  it('shows each business only its own contacts', async () => {
    const agency = await database.fixtures.agency();
    const harbor = await database.fixtures.business(agency.id);
    const bakery = await database.fixtures.business(agency.id);
    await database.fixtures.contact(harbor.context, { firstName: 'Dana' });
    await database.fixtures.contact(bakery.context, { firstName: 'Ravi' });

    const seenByHarbor = await database.withTenant(harbor.context, (sql) =>
      sql.query<{ first_name: string }>('select first_name from crm.contacts'),
    );

    expect(seenByHarbor).toEqual([{ first_name: 'Dana' }]);
  });

  it('shows nothing when no tenant context is set', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    await database.fixtures.contact(business.context, { firstName: 'Dana' });

    const seenWithoutContext = await database.as('crm_app', (sql) =>
      sql.query('select * from crm.contacts'),
    );

    expect(seenWithoutContext).toEqual([]);
  });

  it('refuses to write a row for another business', async () => {
    const agency = await database.fixtures.agency();
    const harbor = await database.fixtures.business(agency.id);
    const bakery = await database.fixtures.business(agency.id);

    const smuggle = database.withTenant(harbor.context, (sql) =>
      sql.query(
        "insert into crm.tags (business_id, name, created_by_kind) values ($1, 'Smuggled', 'user')",
        [bakery.id],
      ),
    );

    await expect(smuggle).rejects.toThrow('new row violates row-level security policy');
  });
});

describe('the tenant context', () => {
  // Events, a note's last editor (0026) and whoever completes a task (0027).
  it.each([
    'events_actor_kind_valid',
    'notes_edited_by_kind_valid',
    'tasks_completed_by_kind_valid',
  ])('names the same actor kinds as %s allows', async (name) => {
    const [constraint] = await database.as('crm_owner', (sql) =>
      sql.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint where conname = $1`,
        [name],
      ),
    );

    const allowed = [...(constraint?.definition ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect(allowed).toEqual([...actorKinds]);
  });
});
