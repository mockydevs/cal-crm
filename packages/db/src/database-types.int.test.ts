// The Kysely types in database.gen.ts come from the migrated schema. A migration that
// changes the schema fails here until the types are regenerated and reviewed:
//   pnpm --filter @repo/db types
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const run = promisify(execFile);
const codegen = join(
  dirname(createRequire(import.meta.url).resolve('kysely-codegen/package.json')),
  'dist/cli/bin.js',
);

// What kysely-codegen calls the types of the columns Postgres computes. A computed column
// of any other type stops the generation, so its override gets written on purpose.
const typeNames: Record<string, string> = { text: 'string', tsvector: 'string' };

// The migration runner's record and Graphile Worker's queue aren't the application's data,
// and crm_app can't reach either.
const skippedSchemas = ['util', 'graphile_worker'];

let database: TestDatabase;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

/**
 * Stored generated columns, as kysely-codegen overrides: readable, never written. Read
 * from pg_attribute, so a new one can't be missed.
 */
async function computedColumnOverrides(): Promise<Record<string, string>> {
  const columns = await database.as('crm_owner', (sql) =>
    sql.query<{ name: string; type: string; nullable: boolean }>(
      `select n.nspname || '.' || c.relname || '.' || a.attname as name,
              format_type(a.atttypid, a.atttypmod) as type,
              not a.attnotnull as nullable
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       where a.attgenerated = 's' and c.relkind in ('r', 'p') and not c.relispartition
         and n.nspname::text <> all($1::text[])
       order by 1`,
      [skippedSchemas],
    ),
  );
  const generated = Object.fromEntries(
    columns.map(({ name, type, nullable }) => {
      const typeName = typeNames[type];
      if (typeName === undefined) {
        throw new Error(`${name} is computed as ${type}: add how kysely-codegen names it.`);
      }
      return [name, `ColumnType<${typeName}${nullable ? ' | null' : ''}, never, never>`];
    }),
  );
  // Migration 0040 derives these columns in a BEFORE trigger because elapsed-time
  // timestamp arithmetic cannot be a stored generated expression. Callers still may
  // only read them, just as with the generated columns above.
  return {
    ...generated,
    'calendar.appointments.occupied_starts_at': 'ColumnType<Date, never, never>',
    'calendar.appointments.occupied_ends_at': 'ColumnType<Date, never, never>',
  };
}

describe('the database types', () => {
  it('match the migrated schema', async () => {
    const overrides = await computedColumnOverrides();

    const { stdout } = await run(process.execPath, [
      codegen,
      '--dialect=postgres',
      `--url=${database.url('crm_owner')}`,
      `--exclude-pattern={${skippedSchemas.join(',')}}.*`,
      `--overrides=${JSON.stringify({ columns: overrides })}`,
      '--print',
      '--log-level=error',
    ]);

    await expect(stdout).toMatchFileSnapshot('./database.gen.ts');
  });

  it('make every column Postgres computes read-only', async () => {
    const overrides = await computedColumnOverrides();

    expect(Object.keys(overrides)).toHaveLength(31);
    // The name the catalogue is ordered and searched by, and the code no two products of a
    // business share, whatever its capitals (0079).
    expect(overrides['commerce.products.name_normalized']).toBe(
      'ColumnType<string | null, never, never>',
    );
    expect(overrides['commerce.products.sku_normalized']).toBe(
      'ColumnType<string | null, never, never>',
    );
    // The names sites, their folders, saved sections and templates are ordered by, and a
    // security header's name without its case (0070).
    expect(overrides['sites.sites.name_normalized']).toBe(
      'ColumnType<string | null, never, never>',
    );
    expect(overrides['messaging.template_folders.name_normalized']).toBe(
      'ColumnType<string | null, never, never>',
    );
    // The names snippets, their folders and trigger links are unique and ordered by (0065).
    expect(overrides['messaging.snippets.name_normalized']).toBe(
      'ColumnType<string | null, never, never>',
    );
    // The name a deal list sorts by (0062).
    expect(overrides['crm.deals.sort_name']).toBe('ColumnType<string | null, never, never>');
    expect(overrides['messaging.templates.name_normalized']).toBe(
      'ColumnType<string | null, never, never>',
    );
    expect(overrides['messaging.mailbox_connection_attempts.email_normalized']).toBe(
      'ColumnType<string | null, never, never>',
    );
    expect(overrides['crm.contacts.display_name']).toBe('ColumnType<string | null, never, never>');
    expect(overrides['crm.contacts.sort_name']).toBe('ColumnType<string | null, never, never>');
    expect(overrides['crm.deals.search']).toBe('ColumnType<string | null, never, never>');
    expect(overrides['tenancy.memberships.scope']).toBe('ColumnType<string, never, never>');
  });

  it('makes trigger-derived appointment occupancy readable but never caller writable', async () => {
    const overrides = await computedColumnOverrides();
    for (const column of ['occupied_starts_at', 'occupied_ends_at']) {
      expect(overrides[`calendar.appointments.${column}`]).toBe('ColumnType<Date, never, never>');
    }
  });
});
