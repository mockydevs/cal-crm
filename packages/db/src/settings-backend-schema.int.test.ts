// Migration 0064 at the database's own level: the system mark on a field and what it
// protects, how a choice field is shown, the order of fields inside a folder, and what the migration does to fields an
// install already had. What the CRM module does with them is its own to prove.
import { randomUUID } from 'node:crypto';
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

const MIGRATION = '0064_settings_backend.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}
const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

interface Field {
  id: string;
  folder_id: string;
  position: number;
  is_system: boolean;
}
/** A contact field, made by a person or (a system field) by the system. */
const field = (sql: Sql, key: string, system = false): Promise<Field> =>
  sql.one<Field>(
    `insert into crm.field_definitions
       (business_id, object_type_id, key, label, value_type, created_by_kind, is_system)
     select app.business_id(), id, $1, $1, 'text', $2, $3 from crm.object_types
     where kind = 'contact'
     returning id, folder_id, position, is_system`,
    [key, system ? 'system' : 'user', system],
  );
const folder = (sql: Sql, name: string): Promise<{ id: string }> =>
  sql.one<{ id: string }>(
    `insert into crm.field_folders (business_id, object_type_id, name, created_by_kind)
     select app.business_id(), id, $1, 'user' from crm.object_types where kind = 'contact'
     returning id`,
    [name],
  );

describe('a system field', () => {
  it('is what no field is unless the system made it so', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      expect((await field(sql, 'plain')).is_system).toBe(false);
      expect((await field(sql, 'built_in', true)).is_system).toBe(true);
    });
    // A person, an import or an API key cannot make one.
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.field_definitions
             (business_id, object_type_id, key, label, value_type, created_by_kind, is_system)
           select app.business_id(), id, 'forged', 'Forged', 'text', 'user', true
           from crm.object_types where kind = 'contact'`,
        ),
      ),
      'field_definitions_system_made_by_system',
    );
  });

  it('never becomes an ordinary field, and no ordinary field becomes one', async () => {
    const context = await business();
    const made = await database.withTenant(context, async (sql) => ({
      system: await field(sql, 'built_in', true),
      plain: await field(sql, 'plain'),
    }));
    for (const [id, to] of [
      [made.system.id, false],
      [made.plain.id, true],
    ] as const) {
      await refused(
        database.withTenant(context, (sql) =>
          sql.query('update crm.field_definitions set is_system = $2 where id = $1', [id, to]),
        ),
        'field_definitions_system_fixed',
      );
      // The table's owner is held to it too: it is a trigger, not a policy.
      await refused(
        database.as('crm_owner', (sql) =>
          sql.query('update crm.field_definitions set is_system = $2 where id = $1', [id, to]),
        ),
        'field_definitions_system_fixed',
      );
    }
  });

  it('can be moved to another folder and reordered, and nothing else about it changes', async () => {
    const context = await business();
    const made = await database.withTenant(context, async (sql) => ({
      system: await field(sql, 'built_in', true),
      other: await folder(sql, 'Moved here'),
    }));
    const moved = await database.withTenant(context, (sql) =>
      sql.one<Field>(
        `update crm.field_definitions set folder_id = $2, position = 4 where id = $1
         returning id, folder_id, position, is_system`,
        [made.system.id, made.other.id],
      ),
    );
    expect(moved).toEqual({
      id: made.system.id,
      folder_id: made.other.id,
      position: 4,
      is_system: true,
    });

    const changes: readonly (readonly [string, unknown])[] = [
      ['label', 'Renamed'],
      ['description', 'Explained again'],
      ['placeholder', 'Type here'],
      ['archived_at', new Date()],
      ['ai_overwrite', 'allow'],
      ['ai_fill_sources', ['forms']],
      ['key', 'another_key'],
      ['created_by_kind', 'user'],
    ];
    for (const [column, value] of changes) {
      await refused(
        database.withTenant(context, (sql) =>
          sql.query(`update crm.field_definitions set ${column} = $2 where id = $1`, [
            made.system.id,
            value,
          ]),
        ),
        'field_definitions_system_field_fixed',
      );
    }
    // An ordinary field takes every one of those changes that its own rules allow.
    const plain = await database.withTenant(context, (sql) => field(sql, 'plain'));
    await database.withTenant(context, (sql) =>
      sql.query(
        `update crm.field_definitions set label = 'Renamed', placeholder = 'Type here',
           archived_at = now() where id = $1`,
        [plain.id],
      ),
    );
  });

  it('is never deleted by the application, and still goes with its object type', async () => {
    const context = await business();
    const made = await database.withTenant(context, async (sql) => {
      // A custom object is made with its primary field (0128): here, the system field.
      const { id: objectTypeId, primary_field_id: capacityId } = await sql.one<{
        id: string;
        primary_field_id: string;
      }>(
        `insert into crm.object_types
           (business_id, id, kind, key, singular_label, plural_label, primary_field_id)
         values (app.business_id(), uuidv7(), 'custom', 'venue', 'Venue', 'Venues', uuidv7())
         returning id, primary_field_id`,
      );
      await sql.query(
        `insert into crm.field_definitions
           (business_id, id, object_type_id, key, label, value_type, created_by_kind, is_system)
         values (app.business_id(), $1, $2, 'capacity', 'Capacity', 'number', 'system', true)`,
        [capacityId, objectTypeId],
      );
      return {
        objectTypeId,
        system: await field(sql, 'built_in', true),
        plain: await field(sql, 'plain'),
      };
    });
    const deleted = await database.withTenant(context, (sql) =>
      sql.query<{ id: string }>(
        'delete from crm.field_definitions where id = any($1::uuid[]) returning id',
        [[made.system.id, made.plain.id]],
      ),
    );
    // The policy hides the system field from the delete: only the ordinary one goes.
    expect(deleted).toEqual([{ id: made.plain.id }]);

    const left = await database.as('crm_owner', async (sql) => {
      await sql.query('delete from crm.object_types where id = $1', [made.objectTypeId]);
      return sql.one<{ fields: number }>(
        'select count(*)::int as fields from crm.field_definitions where object_type_id = $1',
        [made.objectTypeId],
      );
    });
    expect(left).toEqual({ fields: 0 });
  });

  it('has the delete rule as a restrictive policy beside the tenant policy', async () => {
    const policies = await database.as('crm_owner', (sql) =>
      sql.query<{ policy: string }>(
        `select format('%s %s %s', policyname, permissive, cmd) as policy from pg_policies
         where schemaname = 'crm' and tablename = 'field_definitions' order by 1`,
      ),
    );
    expect(policies.map(({ policy }) => policy)).toEqual([
      'field_definitions_delete_own_only RESTRICTIVE DELETE',
      'tenant_isolation PERMISSIVE ALL',
    ]);
  });
});

describe('how a choice field is shown', () => {
  const choice = (sql: Sql, key: string, valueType: string, display: string | null) =>
    sql.one<{ id: string; choice_display: string | null }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, value_type, options, created_by_kind, choice_display)
       select app.business_id(), id, $1, $1, $2, $3::jsonb, 'user', $4 from crm.object_types
       where kind = 'contact'
       returning id, choice_display`,
      [
        key,
        valueType,
        valueType === 'text'
          ? '[]'
          : '[{"key":"opt_a","label":"A","description":"","archived":false}]',
        display,
      ],
    );

  it('is a dropdown unless said, radio buttons for one choice, checkboxes for several', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      expect((await choice(sql, 'plain_one', 'single_choice', null)).choice_display).toBeNull();
      expect((await choice(sql, 'radio', 'single_choice', 'radio')).choice_display).toBe('radio');
      expect((await choice(sql, 'boxes', 'multi_choice', 'checkbox')).choice_display).toBe(
        'checkbox',
      );
    });
    for (const [key, valueType, display] of [
      ['wrong_one', 'single_choice', 'checkbox'],
      ['wrong_many', 'multi_choice', 'radio'],
      ['not_a_choice', 'text', 'radio'],
      ['unknown', 'single_choice', 'slider'],
      // The usual control is stored as nothing, never as a word.
      ['spelled_out', 'single_choice', 'dropdown'],
    ] as const)
      await refused(
        database.withTenant(context, (sql) => choice(sql, key, valueType, display)),
        'field_definitions_choice_display_valid',
      );
  });

  it('never changes once the field is made, whoever asks', async () => {
    const context = await business();
    const made = await database.withTenant(context, async (sql) => ({
      radio: await choice(sql, 'radio', 'single_choice', 'radio'),
      plain: await choice(sql, 'plain_one', 'single_choice', null),
    }));
    for (const [id, to] of [
      [made.radio.id, null],
      [made.plain.id, 'radio'],
    ] as const) {
      await refused(
        database.withTenant(context, (sql) =>
          sql.query('update crm.field_definitions set choice_display = $2 where id = $1', [id, to]),
        ),
        'field_definitions_choice_display_fixed',
      );
      await refused(
        database.as('crm_owner', (sql) =>
          sql.query('update crm.field_definitions set choice_display = $2 where id = $1', [id, to]),
        ),
        'field_definitions_choice_display_fixed',
      );
    }
    // Everything else about a radio field is still edited.
    await database.withTenant(context, (sql) =>
      sql.query("update crm.field_definitions set label = 'Renamed' where id = $1", [
        made.radio.id,
      ]),
    );
  });
});

describe("a field's place in its folder", () => {
  it('is never below zero', async () => {
    const context = await business();
    const made = await database.withTenant(context, (sql) => field(sql, 'plain'));
    await refused(
      database.withTenant(context, (sql) =>
        sql.query('update crm.field_definitions set position = -1 where id = $1', [made.id]),
      ),
      'field_definitions_position_not_negative',
    );
  });
});

describe('an install that already had fields', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-settings-backend-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < MIGRATION) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every field as it was, none a system field, each placed in its folder by when it was made', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(MIGRATION);
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    try {
      const rows = async <Row extends object>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<Row[]> => (await owner.query<Row>(text, [...values])).rows;
      const [agency] = await rows<{ id: string }>(
        "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
      );
      const [owned] = await rows<{ id: string }>(
        "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
        [agency?.id],
      );
      await owner.query(
        `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
         values ($1, 'contact', 'contact', 'Contact', 'Contacts'),
                ($1, 'deal', 'deal', 'Deal', 'Deals')`,
        [owned?.id],
      );
      const [quote] = await rows<{ id: string }>(
        `insert into crm.field_folders (business_id, object_type_id, name, created_by_kind)
         select business_id, id, 'Quote', 'user' from crm.object_types where kind = 'contact'
         returning id`,
      );
      // Made at known moments, out of key order, so the place can only come from the moment.
      await owner.query(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, value_type, created_by_kind, folder_id,
            archived_at, created_at)
         select o.business_id, o.id, f.key, f.key, 'text', f.maker,
                case when f.quoted then $1::uuid end, f.archived_at, f.created_at
         from crm.object_types o
         join (values
           ('contact', 'zeta', 'user', false, null::timestamptz, '2026-01-01T00:00:00Z'::timestamptz),
           ('contact', 'alpha', 'system', false, null, '2026-01-02T00:00:00Z'),
           ('contact', 'gone', 'user', false, now(), '2026-01-03T00:00:00Z'),
           ('contact', 'width', 'user', true, null, '2026-01-05T00:00:00Z'),
           ('contact', 'height', 'user', true, null, '2026-01-04T00:00:00Z'),
           ('deal', 'total', 'import', false, null, '2026-01-06T00:00:00Z')
         ) as f (kind, key, maker, quoted, archived_at, created_at) on f.kind = o.kind`,
        [quote?.id],
      );
      const read = () =>
        rows<{ key: string; label: string; updated_at: Date; archived: boolean }>(
          `select key, label, updated_at, archived_at is not null as archived
           from crm.field_definitions order by key`,
        );
      const fieldsBefore = await read();
      expect(fieldsBefore).toHaveLength(6);

      const after = await migrate({ connectionString });
      expect(after.applied).toContain(MIGRATION);

      // Not an edit: no field's updated_at moved, and nothing else about it changed.
      expect(await read()).toEqual(fieldsBefore);
      expect(
        await rows('select 1 from crm.field_definitions where choice_display is not null'),
      ).toEqual([]);
      const placed = await rows<{
        key: string;
        quoted: boolean;
        position: number;
        system: boolean;
      }>(
        `select f.key, f.folder_id = $1 as quoted, f.position, f.is_system as system
         from crm.field_definitions f
         join crm.object_types o on o.id = f.object_type_id
         order by o.kind, quoted, f.position`,
        [quote?.id],
      );
      expect(placed).toEqual([
        // The contact's system folder, the archived field keeping its place among them.
        { key: 'zeta', quoted: false, position: 0, system: false },
        // Made by the system before the mark existed: it is not turned into a system field.
        { key: 'alpha', quoted: false, position: 1, system: false },
        { key: 'gone', quoted: false, position: 2, system: false },
        // The folder the account made, numbered on its own.
        { key: 'height', quoted: true, position: 0, system: false },
        { key: 'width', quoted: true, position: 1, system: false },
        // Another object's folder starts again from 0.
        { key: 'total', quoted: false, position: 0, system: false },
      ]);
    } finally {
      await owner.end();
    }
  });
});
