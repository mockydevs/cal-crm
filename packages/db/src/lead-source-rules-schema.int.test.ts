// Migration 0096 at the database's own level: crm.lead_source_rules, its policy, grants and
// limits, and the one read a lead's intake makes of it. What the CRM module does with the
// table is its own to prove (packages/modules/forms/src/lead-source-rules.int.test.ts).
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

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

const CONDITION = '[{"fact":"medium","op":"is","value":"form"}]';

interface Rule {
  position?: number;
  name?: string;
  conditions?: string;
  source?: string | null;
  tagIds?: string[];
  fieldWrites?: string;
}
const insert = (sql: Sql, rule: Rule = {}): Promise<{ id: string; revision: number }> =>
  sql.one<{ id: string; revision: number }>(
    `insert into crm.lead_source_rules
       (business_id, position, name, conditions, source_label, tag_ids, field_writes, created_by_kind)
     values (app.business_id(), $1, $2, $3::jsonb, $4, $5::uuid[], $6::jsonb, 'user')
     returning id, revision`,
    [
      rule.position ?? 1,
      rule.name ?? 'Rule',
      rule.conditions ?? CONDITION,
      rule.source === undefined ? 'Source' : rule.source,
      rule.tagIds ?? [],
      rule.fieldWrites ?? '[]',
    ],
  );

describe('crm.lead_source_rules', () => {
  it('has forced row-level security with the tenant policy, and every verb for the application only', async () => {
    const [table] = await database.as('crm_owner', (sql) =>
      sql.query<{ enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = 'crm' and p.tablename = 'lead_source_rules'
                      order by 1) as policies
         from pg_class c where c.oid = 'crm.lead_source_rules'::regclass`,
      ),
    );
    expect(table).toEqual({
      enabled: true,
      forced: true,
      policies: ['tenant_isolation PERMISSIVE ALL'],
    });
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ grantee: string; verbs: string[] }>(
        `select grantee, array_agg(privilege_type::text order by privilege_type) as verbs
         from information_schema.role_table_grants
         where table_schema = 'crm' and table_name = 'lead_source_rules'
           and grantee like 'crm\\_%' and grantee <> 'crm_owner'
         group by grantee order by grantee`,
      ),
    );
    expect(grants).toEqual([
      { grantee: 'crm_app', verbs: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
    ]);
  });

  it('shows a business its own rules and no other’s', async () => {
    const mine = await business();
    const theirs = await business();
    await database.withTenant(mine, (sql) => insert(sql));
    const count = (context: TenantContext) =>
      database.withTenant(context, (sql) =>
        sql.one<{ n: string }>('select count(*) as n from crm.lead_source_rules'),
      );
    expect(await count(mine)).toEqual({ n: '1' });
    expect(await count(theirs)).toEqual({ n: '0' });
    // Nor may one business write a rule into another.
    await expect(
      database.withTenant(theirs, (sql) =>
        sql.query(
          `insert into crm.lead_source_rules
             (business_id, position, name, conditions, source_label, created_by_kind)
           values ($1, 2, 'Planted', $2::jsonb, 'S', 'user')`,
          [mine.businessId, CONDITION],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('holds the limits: fifty places, five conditions, five tags, three fields, and a rule that does something', async () => {
    const context = await business();
    const attempt = (rule: Rule) => database.withTenant(context, (sql) => insert(sql, rule));
    await refused(attempt({ position: 0 }), 'lead_source_rules_position_valid');
    await refused(attempt({ position: 51 }), 'lead_source_rules_position_valid');
    await refused(attempt({ name: '  ' }), 'lead_source_rules_name_valid');
    await refused(attempt({ name: 'x'.repeat(81) }), 'lead_source_rules_name_valid');
    await refused(attempt({ name: 'two\nlines' }), 'lead_source_rules_name_valid');
    await refused(attempt({ conditions: '[]' }), 'lead_source_rules_conditions_valid');
    await refused(attempt({ conditions: '{}' }), 'lead_source_rules_conditions_valid');
    await refused(
      attempt({ conditions: `[${Array.from({ length: 6 }, () => '{}').join(',')}]` }),
      'lead_source_rules_conditions_valid',
    );
    await refused(attempt({ source: 'x'.repeat(201) }), 'lead_source_rules_source_label_valid');
    await refused(attempt({ source: ' ' }), 'lead_source_rules_source_label_valid');
    await refused(
      attempt({ tagIds: Array.from({ length: 6 }, () => randomUUID()) }),
      'lead_source_rules_tag_ids_valid',
    );
    await refused(
      attempt({ fieldWrites: `[${Array.from({ length: 4 }, () => '{}').join(',')}]` }),
      'lead_source_rules_field_writes_valid',
    );
    await refused(attempt({ source: null }), 'lead_source_rules_acts');
    // A rule that only adds a tag, or only fills a field, is a rule.
    await attempt({ position: 1, source: null, tagIds: [randomUUID()] });
    await attempt({ position: 2, source: null, fieldWrites: '[{"fieldId":"x","value":"y"}]' });
    await attempt({ position: 50 });
  });

  it('keeps one rule a place, and lets one statement move them all', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      const first = await insert(sql, { position: 1, name: 'a' });
      const second = await insert(sql, { position: 2, name: 'b' });
      const third = await insert(sql, { position: 3, name: 'c' });
      // Checked when the statement ends: a swap of every place in one statement passes.
      await sql.query(
        `update crm.lead_source_rules r set position = m.position
         from unnest($1::uuid[]) with ordinality as m(id, position) where r.id = m.id`,
        [[third.id, first.id, second.id]],
      );
      expect(
        await sql.query<{ name: string }>(
          'select name from crm.lead_source_rules order by position',
        ),
      ).toEqual([{ name: 'c' }, { name: 'a' }, { name: 'b' }]);
    });
    await refused(
      database.withTenant(context, (sql) => insert(sql, { position: 2 })),
      'lead_source_rules_position_unique',
    );
  });

  it('keeps a rule in its business, and moves updated_at with a change', async () => {
    const context = await business();
    const other = await business();
    const made = await database.withTenant(context, (sql) => insert(sql));
    await refused(
      database.as('crm_owner', (sql) =>
        sql.query('update crm.lead_source_rules set business_id = $1 where id = $2', [
          other.businessId,
          made.id,
        ]),
      ),
      'lead_source_rules_business_fixed',
    );
    const [row] = await database.withTenant(context, (sql) =>
      sql.query<{ moved: boolean }>(
        `update crm.lead_source_rules set name = 'Renamed' where id = $1
         returning updated_at >= created_at as moved`,
        [made.id],
      ),
    );
    expect(row).toEqual({ moved: true });
  });

  it('is read for a lead by its order index: a business’s rules, switched on, in order', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      for (let position = 1; position <= 50; position += 1)
        await insert(sql, { position, name: `Rule ${String(position)}` });
      // The planner would scan fifty rows either way; with that scan priced out, the plan
      // shows the index can answer the intake's one read in the order it wants, with no sort.
      await sql.query('set local enable_seqscan = off');
      await sql.query('set local enable_bitmapscan = off');
      const plan = await sql.query<{ 'QUERY PLAN': string }>(
        `explain (costs off)
         select id, position, name, conditions, source_label, tag_ids, field_writes
         from crm.lead_source_rules
         where business_id = app.business_id() and enabled
         order by position limit 50`,
      );
      const text = plan.map((line) => line['QUERY PLAN']).join('\n');
      expect(text).toContain('Index Scan using lead_source_rules_position_unique');
      expect(text).not.toContain('Sort');
    });
  });

  it('goes with its business', async () => {
    const context = await business();
    await database.withTenant(context, (sql) => insert(sql));
    await database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.businesses where id = $1', [context.businessId]),
    );
    const left = await database.as('crm_owner', (sql) =>
      sql.one<{ n: string }>(
        'select count(*) as n from crm.lead_source_rules where business_id = $1',
        [context.businessId],
      ),
    );
    expect(left).toEqual({ n: '0' });
  });
});
