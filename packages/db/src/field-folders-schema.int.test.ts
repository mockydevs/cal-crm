// Migration 0053 at the database's own level: field folders, a field's folder and
// placeholder, custom values and their folders; their grants and policies; and what the
// migration does to fields an install already had. What the CRM module does with these
// tables is its own to prove (packages/modules/crm).
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

const TABLES = ['crm.custom_value_folders', 'crm.custom_values', 'crm.field_folders'];
const MIGRATION = '0053_field_folders_custom_values.sql';
const SYSTEM_FOLDER = 'Additional Info';
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

interface Folder {
  id: string;
  name: string;
  is_system: boolean;
  position: number;
}
const objectType = (sql: Sql, kind: string): Promise<{ id: string }> =>
  sql.one<{ id: string }>('select id from crm.object_types where kind = $1', [kind]);
/** A custom object, made with its primary field as every custom object is (0128). */
async function venue(sql: Sql): Promise<{ id: string }> {
  const made = await sql.one<{ id: string; primary_field_id: string }>(
    `insert into crm.object_types
       (business_id, id, kind, key, singular_label, plural_label, primary_field_id)
     values (app.business_id(), uuidv7(), 'custom', 'venue', 'Venue', 'Venues', uuidv7())
     returning id, primary_field_id`,
  );
  await sql.query(
    `insert into crm.field_definitions
       (business_id, id, object_type_id, key, label, value_type, created_by_kind)
     values (app.business_id(), $1, $2, 'name', 'Venue name', 'text', 'user')`,
    [made.primary_field_id, made.id],
  );
  return { id: made.id };
}
const systemFolder = async (sql: Sql, kind: string): Promise<Folder> =>
  sql.one<Folder>(
    `select f.id, f.name, f.is_system, f.position from crm.field_folders f
     join crm.object_types o on o.id = f.object_type_id
     where o.kind = $1 and f.is_system`,
    [kind],
  );
const folder = async (sql: Sql, kind: string, name: string): Promise<{ id: string }> =>
  sql.one<{ id: string }>(
    `insert into crm.field_folders (business_id, object_type_id, name, created_by_kind)
     select app.business_id(), id, $2, 'user' from crm.object_types where kind = $1
     returning id`,
    [kind, name],
  );
const field = async (
  sql: Sql,
  kind: string,
  key: string,
  folderId: string | null = null,
): Promise<{ id: string; folder_id: string }> =>
  sql.one<{ id: string; folder_id: string }>(
    `insert into crm.field_definitions
       (business_id, object_type_id, key, label, value_type, created_by_kind, folder_id)
     select app.business_id(), id, $2, $2, 'text', 'user', $3 from crm.object_types where kind = $1
     returning id, folder_id`,
    [kind, key, folderId],
  );
const customValue = (
  sql: Sql,
  key: string,
  values: { name?: string; value?: string; folderId?: string | null } = {},
): Promise<{ id: string; value: string; folder_id: string | null }> =>
  sql.one<{ id: string; value: string; folder_id: string | null }>(
    `insert into crm.custom_values (business_id, key, name, value, folder_id, created_by_kind)
     values (app.business_id(), $1, $2, coalesce($3, ''), $4, 'user')
     returning id, value, folder_id`,
    [key, values.name ?? key, values.value ?? null, values.folderId ?? null],
  );
const valueFolder = (sql: Sql, name: string): Promise<{ id: string }> =>
  sql.one<{ id: string }>(
    `insert into crm.custom_value_folders (business_id, name, created_by_kind)
     values (app.business_id(), $1, 'user') returning id`,
    [name],
  );

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
    const tenantOnly = {
      enabled: true,
      forced: true,
      policies: ['tenant_isolation PERMISSIVE ALL'],
    };
    expect(rows).toEqual([
      { name: 'crm.custom_value_folders', ...tenantOnly },
      { name: 'crm.custom_values', ...tenantOnly },
      {
        name: 'crm.field_folders',
        enabled: true,
        forced: true,
        policies: [
          'field_folders_delete_own_only RESTRICTIVE DELETE',
          'tenant_isolation PERMISSIVE ALL',
        ],
      },
    ]);
  });

  it('give the application every verb, and the sign-in and worker roles nothing', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ grantee: string; granted: string }>(
        `select grantee, string_agg(distinct privilege_type, ',' order by privilege_type) as granted
         from information_schema.role_table_grants
         where table_schema = 'crm'
           and table_name in ('field_folders', 'custom_values', 'custom_value_folders')
           and grantee <> 'crm_owner'
         group by grantee order by grantee`,
      ),
    );
    expect(grants).toEqual([{ grantee: 'crm_app', granted: 'DELETE,INSERT,SELECT,UPDATE' }]);
  });
});

describe('field folders', () => {
  it('give every object type one system folder, made with it', async () => {
    const context = await business();
    const folders = await database.withTenant(context, (sql) =>
      sql.query<{ kind: string; name: string; is_system: boolean; created_by_kind: string }>(
        `select o.kind, f.name, f.is_system, f.created_by_kind
         from crm.field_folders f join crm.object_types o on o.id = f.object_type_id
         order by o.kind`,
      ),
    );
    expect(folders).toEqual(
      ['company', 'contact', 'deal'].map((kind) => ({
        kind,
        name: SYSTEM_FOLDER,
        is_system: true,
        created_by_kind: 'system',
      })),
    );
    // A custom object made later gets its own, in the transaction that makes it.
    const later = await database.withTenant(context, async (sql) => {
      const { id } = await venue(sql);
      return sql.query<{ name: string }>(
        'select name from crm.field_folders where object_type_id = $1 and is_system',
        [id],
      );
    });
    expect(later).toEqual([{ name: SYSTEM_FOLDER }]);
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.field_folders (business_id, object_type_id, name, is_system, created_by_kind)
           select app.business_id(), id, 'Second system folder', true, 'system'
           from crm.object_types where kind = 'contact'`,
        ),
      ),
      'field_folders_one_system_idx',
    );
  });

  it('put a field made without a folder in its object’s system folder, and keep a chosen one', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      const system = await systemFolder(sql, 'contact');
      expect((await field(sql, 'contact', 'no_folder')).folder_id).toBe(system.id);
      const own = await folder(sql, 'contact', 'Event details');
      expect((await field(sql, 'contact', 'chosen', own.id)).folder_id).toBe(own.id);
    });
  });

  it('refuse a folder of another object type, or of another business, for a field', async () => {
    const context = await business();
    const other = await business();
    const foreign = await database.withTenant(other, (sql) => folder(sql, 'contact', 'Theirs'));
    // The check waits for the end of the transaction, where both are refused.
    await refused(
      database.withTenant(context, async (sql) => {
        const dealFolder = await folder(sql, 'deal', 'Deal details');
        await field(sql, 'contact', 'misplaced', dealFolder.id);
      }),
      'field_definitions_folder_fkey',
    );
    await refused(
      database.withTenant(context, (sql) => field(sql, 'contact', 'foreign', foreign.id)),
      'field_definitions_folder_fkey',
    );
    // An object type that doesn't exist has no system folder to fall back on, and a field
    // is never stored without a folder.
    await expect(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.field_definitions
             (business_id, object_type_id, key, label, value_type, created_by_kind)
           values (app.business_id(), uuidv7(), 'nowhere', 'Nowhere', 'text', 'user')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '23502', column: 'folder_id' });
  });

  it('keep names unique within an object, ignoring case and outer spaces', async () => {
    const context = await business();
    await database.withTenant(context, (sql) => folder(sql, 'contact', 'Event details'));
    for (const name of ['event details', '  Event Details ', SYSTEM_FOLDER.toUpperCase()])
      await refused(
        database.withTenant(context, (sql) => folder(sql, 'contact', name)),
        'field_folders_name_unique_idx',
      );
    // The same name on another object is a different folder.
    await database.withTenant(context, (sql) => folder(sql, 'deal', 'Event details'));
    for (const name of ['   ', 'x'.repeat(81)])
      await refused(
        database.withTenant(context, (sql) => folder(sql, 'contact', name)),
        'field_folders_name_length',
      );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.field_folders (business_id, object_type_id, name, created_by_kind)
           select app.business_id(), id, 'By nobody', 'robot' from crm.object_types where kind = 'deal'`,
        ),
      ),
      'field_folders_created_by_kind_valid',
    );
  });

  it('never let a system folder be renamed or deleted, only moved in the order', async () => {
    const context = await business();
    const system = await database.withTenant(context, (sql) => systemFolder(sql, 'contact'));
    await refused(
      database.withTenant(context, (sql) =>
        sql.query("update crm.field_folders set name = 'Renamed' where id = $1", [system.id]),
      ),
      'field_folders_system_name_fixed',
    );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query('update crm.field_folders set is_system = false where id = $1', [system.id]),
      ),
      'field_folders_object_and_kind_fixed',
    );
    // The application's delete finds no row to delete: the policy hides it from deletes.
    const after = await database.withTenant(context, async (sql) => {
      await sql.query('delete from crm.field_folders where id = $1', [system.id]);
      await sql.query('update crm.field_folders set position = 7 where id = $1', [system.id]);
      return systemFolder(sql, 'contact');
    });
    expect(after).toEqual({ ...system, position: 7 });
  });

  it('keep a folder on its object, and let one the business made be renamed', async () => {
    const context = await business();
    const own = await database.withTenant(context, (sql) => folder(sql, 'contact', 'Old name'));
    await refused(
      database.withTenant(context, async (sql) => {
        const deal = await objectType(sql, 'deal');
        await sql.query('update crm.field_folders set object_type_id = $2 where id = $1', [
          own.id,
          deal.id,
        ]);
      }),
      'field_folders_object_and_kind_fixed',
    );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query('update crm.field_folders set is_system = true where id = $1', [own.id]),
      ),
      'field_folders_object_and_kind_fixed',
    );
    const renamed = await database.withTenant(context, async (sql) => {
      await sql.query("update crm.field_folders set name = 'New name' where id = $1", [own.id]);
      return sql.one<{ name: string }>('select name from crm.field_folders where id = $1', [
        own.id,
      ]);
    });
    expect(renamed.name).toBe('New name');
  });

  it('refuse to delete a folder that still has a field, and delete it once emptied', async () => {
    const context = await business();
    const { own, made } = await database.withTenant(context, async (sql) => {
      const created = await folder(sql, 'contact', 'Event details');
      return { own: created, made: await field(sql, 'contact', 'event_date', created.id) };
    });
    await refused(
      database.withTenant(context, (sql) =>
        sql.query('delete from crm.field_folders where id = $1', [own.id]),
      ),
      'field_definitions_folder_fkey',
    );
    const left = await database.withTenant(context, async (sql) => {
      const system = await systemFolder(sql, 'contact');
      await sql.query('update crm.field_definitions set folder_id = $2 where id = $1', [
        made.id,
        system.id,
      ]);
      await sql.query('delete from crm.field_folders where id = $1', [own.id]);
      return sql.query<{ id: string }>(
        `select f.id from crm.field_definitions f where f.id = $1 and f.folder_id = $2`,
        [made.id, system.id],
      );
    });
    expect(left).toEqual([{ id: made.id }]);
  });

  it('go, with their fields, when their object type goes', async () => {
    const context = await business();
    const custom = await database.withTenant(context, async (sql) => {
      const { id } = await venue(sql);
      const own = await sql.one<{ id: string }>(
        `insert into crm.field_folders (business_id, object_type_id, name, created_by_kind)
         values (app.business_id(), $1, 'Rooms', 'user') returning id`,
        [id],
      );
      await sql.query(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, value_type, created_by_kind, folder_id)
         values (app.business_id(), $1, 'capacity', 'Capacity', 'number', 'user', $2),
                (app.business_id(), $1, 'parking', 'Parking', 'boolean', 'user', null)`,
        [id, own.id],
      );
      return id;
    });
    // The owner, as removing a business does: both cascades run, in an order nobody chose.
    const left = await database.as('crm_owner', async (sql) => {
      await sql.query('delete from crm.object_types where id = $1', [custom]);
      return sql.one<{ folders: number; fields: number }>(
        `select (select count(*)::int from crm.field_folders where object_type_id = $1) as folders,
                (select count(*)::int from crm.field_definitions where object_type_id = $1) as fields`,
        [custom],
      );
    });
    expect(left).toEqual({ folders: 0, fields: 0 });
  });

  it('are invisible and unwritable from another business', async () => {
    const context = await business();
    const other = await business();
    const own = await database.withTenant(context, (sql) => folder(sql, 'contact', 'Ours'));
    const seen = await database.withTenant(other, async (sql) => {
      await sql.query("update crm.field_folders set name = 'Taken' where id = $1", [own.id]);
      await sql.query('delete from crm.field_folders where id = $1', [own.id]);
      return sql.query('select 1 from crm.field_folders where id = $1', [own.id]);
    });
    expect(seen).toEqual([]);
    await expect(
      database.withTenant(other, (sql) =>
        sql.query(
          `insert into crm.field_folders (business_id, object_type_id, name, created_by_kind)
           values ($1, uuidv7(), 'Planted', 'user')`,
          [context.businessId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const still = await database.withTenant(context, (sql) =>
      sql.one<{ name: string }>('select name from crm.field_folders where id = $1', [own.id]),
    );
    expect(still.name).toBe('Ours');
  });
});

describe('a field’s placeholder', () => {
  it('is empty unless given, and at most 200 characters', async () => {
    const context = await business();
    const made = await database.withTenant(context, async (sql) => {
      const { id } = await field(sql, 'contact', 'budget');
      return sql.one<{ placeholder: string }>(
        'select placeholder from crm.field_definitions where id = $1',
        [id],
      );
    });
    expect(made.placeholder).toBe('');
    await database.withTenant(context, (sql) =>
      sql.query('update crm.field_definitions set placeholder = $1', ['x'.repeat(200)]),
    );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query('update crm.field_definitions set placeholder = $1', ['x'.repeat(201)]),
      ),
      'field_definitions_placeholder_length',
    );
  });
});

describe('who made a field', () => {
  it('is a kind of actor the product knows, since it is read as the field’s source', async () => {
    const context = await business();
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.field_definitions
             (business_id, object_type_id, key, label, value_type, created_by_kind)
           select app.business_id(), id, 'by_nobody', 'By nobody', 'text', 'robot'
           from crm.object_types where kind = 'contact'`,
        ),
      ),
      'field_definitions_created_by_kind_valid',
    );
    const made = await database.withTenant(context, (sql) =>
      sql.query<{ created_by_kind: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, value_type, created_by_kind)
         select app.business_id(), o.id, kind.name, kind.name, 'text', kind.name
         from crm.object_types o,
              unnest(array['user', 'ai_agent', 'automation', 'api_key', 'system', 'contact',
                           'form', 'import']) as kind (name)
         where o.kind = 'contact'
         returning created_by_kind`,
      ),
    );
    expect(made).toHaveLength(8);
  });
});

describe('custom values', () => {
  it('have a key of lowercase letters, digits and underscores, unique in the business', async () => {
    const context = await business();
    const other = await business();
    await database.withTenant(context, (sql) => customValue(sql, 'sample_reel_url'));
    await refused(
      database.withTenant(context, (sql) =>
        customValue(sql, 'sample_reel_url', { name: 'Another name' }),
      ),
      'custom_values_key_unique',
    );
    // Another business has its own keys.
    await database.withTenant(other, (sql) => customValue(sql, 'sample_reel_url'));
    for (const key of ['Sample', '1st', 'has space', 'a-b', '', `a${'b'.repeat(63)}`])
      await refused(
        database.withTenant(context, (sql) => customValue(sql, key, { name: `Named ${key}` })),
        'custom_values_key_format',
      );
    await database.withTenant(context, (sql) =>
      customValue(sql, `a${'b'.repeat(62)}`, { name: 'Longest key' }),
    );
  });

  it('have a name unique in the business, ignoring case and outer spaces', async () => {
    const context = await business();
    await database.withTenant(context, (sql) => customValue(sql, 'hours', { name: 'Hours' }));
    for (const name of ['hours', '  HOURS '])
      await refused(
        database.withTenant(context, (sql) => customValue(sql, 'other', { name })),
        'custom_values_name_unique_idx',
      );
    for (const name of ['  ', 'x'.repeat(121)])
      await refused(
        database.withTenant(context, (sql) => customValue(sql, 'other', { name })),
        'custom_values_name_length',
      );
  });

  it('hold up to 5,000 characters of text, and nothing when none is given', async () => {
    const context = await business();
    const made = await database.withTenant(context, async (sql) => {
      const { id } = await sql.one<{ id: string }>(
        `insert into crm.custom_values (business_id, key, name, created_by_kind)
         values (app.business_id(), 'empty', 'Empty', 'user') returning id`,
      );
      return sql.one<{ value: string }>('select value from crm.custom_values where id = $1', [id]);
    });
    expect(made.value).toBe('');
    await database.withTenant(context, (sql) =>
      customValue(sql, 'long', { value: 'x'.repeat(5000) }),
    );
    await refused(
      database.withTenant(context, (sql) =>
        customValue(sql, 'too_long', { value: 'x'.repeat(5001) }),
      ),
      'custom_values_value_length',
    );
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.custom_values (business_id, key, name, created_by_kind)
           values (app.business_id(), 'by_nobody', 'By nobody', 'robot')`,
        ),
      ),
      'custom_values_created_by_kind_valid',
    );
  });

  it('keep their key for good, while the name, the value and the folder change', async () => {
    const context = await business();
    const made = await database.withTenant(context, (sql) => customValue(sql, 'hours'));
    await refused(
      database.withTenant(context, (sql) =>
        sql.query("update crm.custom_values set key = 'opening_hours' where id = $1", [made.id]),
      ),
      'custom_values_key_fixed',
    );
    const saved = await database.withTenant(context, async (sql) => {
      const { id: folderId } = await valueFolder(sql, 'Opening');
      await sql.query(
        `update crm.custom_values set name = 'Opening hours', value = '9 to 5', folder_id = $2
         where id = $1`,
        [made.id, folderId],
      );
      return sql.one<{ key: string; name: string; value: string; in_folder: boolean }>(
        `select key, name, value, folder_id = $2 as in_folder from crm.custom_values where id = $1`,
        [made.id, folderId],
      );
    });
    expect(saved).toEqual({
      key: 'hours',
      name: 'Opening hours',
      value: '9 to 5',
      in_folder: true,
    });
  });

  it('stay, in no folder, when their folder is deleted', async () => {
    const context = await business();
    const left = await database.withTenant(context, async (sql) => {
      const { id: folderId } = await valueFolder(sql, 'Links');
      const { id } = await customValue(sql, 'sample_reel_url', { value: 'https://x', folderId });
      await sql.query('delete from crm.custom_value_folders where id = $1', [folderId]);
      return sql.one<{ value: string; folder_id: string | null; business_id: string }>(
        'select value, folder_id, business_id from crm.custom_values where id = $1',
        [id],
      );
    });
    expect(left).toEqual({ value: 'https://x', folder_id: null, business_id: context.businessId });
  });

  it('take only a folder of their own business, and folder names are unique in it', async () => {
    const context = await business();
    const other = await business();
    const foreign = await database.withTenant(other, (sql) => valueFolder(sql, 'Theirs'));
    await refused(
      database.withTenant(context, (sql) => customValue(sql, 'planted', { folderId: foreign.id })),
      'custom_values_business_id_folder_id_fkey',
    );
    await database.withTenant(context, (sql) => valueFolder(sql, 'Links'));
    await refused(
      database.withTenant(context, (sql) => valueFolder(sql, ' links ')),
      'custom_value_folders_name_unique_idx',
    );
    // Another business may use the name.
    await database.withTenant(other, (sql) => valueFolder(sql, 'Links'));
    for (const name of [' ', 'x'.repeat(81)])
      await refused(
        database.withTenant(context, (sql) => valueFolder(sql, name)),
        'custom_value_folders_name_length',
      );
  });

  it('are invisible and unwritable from another business', async () => {
    const context = await business();
    const other = await business();
    const made = await database.withTenant(context, async (sql) => {
      const { id: folderId } = await valueFolder(sql, 'Links');
      return { folderId, ...(await customValue(sql, 'hours', { value: '9 to 5', folderId })) };
    });
    const seen = await database.withTenant(other, async (sql) => {
      await sql.query("update crm.custom_values set value = 'Taken' where id = $1", [made.id]);
      await sql.query('delete from crm.custom_values where id = $1', [made.id]);
      await sql.query('delete from crm.custom_value_folders where id = $1', [made.folderId]);
      return [
        ...(await sql.query('select 1 from crm.custom_values')),
        ...(await sql.query('select 1 from crm.custom_value_folders')),
      ];
    });
    expect(seen).toEqual([]);
    await expect(
      database.withTenant(other, (sql) =>
        sql.query(
          `insert into crm.custom_values (business_id, key, name, created_by_kind)
           values ($1, 'planted', 'Planted', 'user')`,
          [context.businessId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const still = await database.withTenant(context, (sql) =>
      sql.one<{ value: string; in_folder: boolean }>(
        'select value, folder_id = $2 as in_folder from crm.custom_values where id = $1',
        [made.id, made.folderId],
      ),
    );
    expect(still).toEqual({ value: '9 to 5', in_folder: true });
  });
});

describe('an install that already had fields', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-field-folders-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < MIGRATION) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every field as it was, each now in its object’s system folder', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(MIGRATION);
    // crm_owner, as an import or a repair would write: it is not held to a tenant.
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
                ($1, 'deal', 'deal', 'Deal', 'Deals'),
                ($1, 'company', 'company', 'Company', 'Companies')`,
        [owned?.id],
      );
      await owner.query(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, value_type, created_by_kind, archived_at)
         select o.business_id, o.id, f.key, f.label, 'text', 'user', f.archived_at
         from crm.object_types o
         join (values ('contact', 'event_date', 'Event date', null::timestamptz),
                      ('contact', 'old_venue', 'Old venue', now()),
                      ('deal', 'quote_total', 'Quote total', null)) as f (kind, key, label, archived_at)
           on f.kind = o.kind`,
      );
      const read = () =>
        rows<{ key: string; label: string; updated_at: Date; archived: boolean }>(
          `select key, label, updated_at, archived_at is not null as archived
           from crm.field_definitions order by key`,
        );
      const fieldsBefore = await read();
      expect(fieldsBefore).toHaveLength(3);

      const after = await migrate({ connectionString });
      expect(after.applied).toContain(MIGRATION);

      // Not an edit: no field's updated_at moved, and nothing else about it changed.
      expect(await read()).toEqual(fieldsBefore);
      const placed = await rows<{ key: string; folder: string; system: boolean; own: boolean }>(
        `select f.key, d.name as folder, d.is_system as system,
                d.object_type_id = f.object_type_id as own
         from crm.field_definitions f
         join crm.field_folders d on d.business_id = f.business_id and d.id = f.folder_id
         order by f.key`,
      );
      expect(placed).toEqual(
        ['event_date', 'old_venue', 'quote_total'].map((key) => ({
          key,
          folder: SYSTEM_FOLDER,
          system: true,
          own: true,
        })),
      );
      // Every object type has its system folder, the one without a field too.
      const folders = await rows<{ kind: string; folders: number }>(
        `select o.kind, count(d.id)::int as folders
         from crm.object_types o
         left join crm.field_folders d on d.object_type_id = o.id and d.is_system
         group by o.kind order by o.kind`,
      );
      expect(folders).toEqual([
        { kind: 'company', folders: 1 },
        { kind: 'contact', folders: 1 },
        { kind: 'deal', folders: 1 },
      ]);
      const placeholders = await rows<{ placeholder: string }>(
        'select distinct placeholder from crm.field_definitions',
      );
      expect(placeholders).toEqual([{ placeholder: '' }]);
    } finally {
      await owner.end();
    }
  });
});
