// The duplicate contacts migration over an install that already has contacts: a database is
// migrated up to the migration before it, with its job queue, addresses are stored as the
// CRM stored them then, and the runner applies the migration as it does on an upgrade.
// - the match key is a plain column, so nothing is rewritten and the addresses there keep
//   no key until the worker fills them: one job per business that has any is queued;
// - an address written afterwards is keyed as it is written;
// - a new install, whose queue is made after the migrations, queues nothing.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import { Logger, runMigrations } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bootstrapFile, migrate, migrateDatabase } from './index.js';
import { workerPreset } from './migrate-database.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const DUPLICATES = '0123_contact_duplicates.sql';

let postgres: Postgres;
let earlier: string;
beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
  earlier = await mkdtemp(join(tmpdir(), 'crm-before-duplicates-'));
  for (const name of await readdir(migrationsDirectory))
    if (name < DUPLICATES) await cp(join(migrationsDirectory, name), join(earlier, name));
});
afterAll(async () => {
  await postgres.stop();
  await rm(earlier, { recursive: true, force: true });
});

it('leaves stored addresses unkeyed and queues one fill for each business that has any', async () => {
  const database = await postgres.createDatabase();
  const connectionString = postgres.url(database);
  const before = await migrate({ connectionString, directory: earlier });
  expect(before.applied).not.toContain(DUPLICATES);
  await runMigrations({
    connectionString,
    preset: workerPreset,
    logger: new Logger(() => () => undefined),
  });

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
    const business = (slug: string) =>
      one(
        `insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $2) returning id`,
        [agency, slug],
      );
    const withContacts = await business('with-contacts');
    const withNone = await business('with-none');
    const objectType = await one(
      `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
       values ($1, 'contact', 'contact', 'Contact', 'Contacts') returning id`,
      [withContacts],
    );
    const contact = await one(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         values ($1, 'contact', $2) returning id)
       insert into crm.contacts (business_id, id, first_name, created_by_kind)
       select $1, id, 'Jane', 'system' from record returning id`,
      [withContacts, objectType],
    );
    await owner.query(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
       values ($1, $2, 'email', 'Jane.Doe@gmail.com', 'jane.doe@gmail.com'),
              ($1, $2, 'phone', '+12125550142', '+12125550142')`,
      [withContacts, contact],
    );

    const after = await migrate({ connectionString, directory: migrationsDirectory });
    expect(after.applied).toContain(DUPLICATES);

    const { rows: stored } = await owner.query<{ match_key: string | null }>(
      'select match_key from crm.contact_identities where business_id = $1',
      [withContacts],
    );
    expect(stored).toEqual([{ match_key: null }, { match_key: null }]);
    const { rows: jobs } = await owner.query<{ key: string; payload: unknown }>(
      `select j.key, p.payload
       from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id = j.id
       where j.task_identifier = 'contacts.fill_match_keys' order by j.key`,
    );
    expect(jobs).toEqual([
      {
        key: `contact-match-keys:${withContacts}`,
        payload: {
          agencyId: agency,
          businessId: withContacts,
          correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
          causationId: null,
          data: {},
        },
      },
    ]);
    expect(jobs.map((job) => job.key)).not.toContain(`contact-match-keys:${withNone}`);

    const { rows: written } = await owner.query<{ match_key: string | null }>(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
       values ($1, $2, 'email', 'janedoe+news@googlemail.com', 'janedoe+news@googlemail.com')
       returning match_key`,
      [withContacts, contact],
    );
    expect(written).toEqual([{ match_key: 'janedoe@gmail.com' }]);
  } finally {
    await owner.end();
  }
});

it('queues nothing on a new install, whose queue is made after the migrations', async () => {
  const database = await postgres.createDatabase();
  const connectionString = postgres.url(database);
  const result = await migrateDatabase({ connectionString });
  expect(result.applied).toContain(DUPLICATES);
  const owner = new pg.Client({ connectionString });
  await owner.connect();
  try {
    const { rows } = await owner.query<{ count: string }>(
      `select count(*) from graphile_worker.jobs where task_identifier = 'contacts.fill_match_keys'`,
    );
    expect(rows).toEqual([{ count: '0' }]);
  } finally {
    await owner.end();
  }
});
