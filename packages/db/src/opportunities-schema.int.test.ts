// Migration 0062 at the database's own level: a deal's followers, the name a deal list
// sorts by, the settings of a pipeline and its stages, a deal's own win probability, the
// opportunity settings of a business and the record of a bulk action. What the CRM module
// does with these is its own to prove.
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
  readonly pipeline: string;
  readonly stage: string;
  deal(name?: string): Promise<string>;
}

async function scene(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context = { ...created.context, correlationId: randomUUID() };
  const made = await database.withTenant(context, async (sql) => {
    const pipeline = await sql.one<{ id: string }>(
      "insert into crm.pipelines (business_id, name) values (app.business_id(), 'Sales') returning id",
    );
    const stage = await sql.one<{ id: string }>(
      `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
       values (app.business_id(), $1, 'New lead', 0) returning id`,
      [pipeline.id],
    );
    return { pipeline: pipeline.id, stage: stage.id };
  });
  return {
    context,
    ...made,
    deal: (name = 'Garden fence') =>
      database.withTenant(context, async (sql) => {
        const record = await sql.one<{ id: string }>(
          `insert into crm.records (business_id, kind, object_type_id)
           select app.business_id(), 'deal', id from crm.object_types where kind = 'deal'
           returning id`,
        );
        await sql.query(
          `insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, created_by_kind)
           values (app.business_id(), $1, $2, $3, $4, 'KES', 'user')`,
          [record.id, name, made.pipeline, made.stage],
        );
        return record.id;
      }),
  };
}

const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

describe("a deal's followers", () => {
  it('are people, each once, added by a known kind of actor, never edited, and go with the deal', async () => {
    const s = await scene();
    const deal = await s.deal();
    const user = await database.fixtures.user();
    const follow = (kind = 'user') =>
      database.withTenant(s.context, (sql) =>
        sql.query(
          `insert into crm.deal_followers (business_id, deal_id, user_id, added_by_kind)
           values (app.business_id(), $1, $2, $3)`,
          [deal, user.id, kind],
        ),
      );
    await refused(follow('robot'), 'deal_followers_added_by_kind_valid');
    await follow();
    await refused(follow(), 'deal_followers_pkey');
    await expect(
      database.withTenant(s.context, (sql) =>
        sql.query(`update crm.deal_followers set added_by_kind = 'system' where deal_id = $1`, [
          deal,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const count = () =>
      database.as('crm_owner', async (sql) => {
        const rows = await sql.query('select 1 from crm.deal_followers where deal_id = $1', [deal]);
        return rows.length;
      });
    expect(await count()).toBe(1);
    // Purging the deal goes through the registry, and takes its followers with it.
    await database.withTenant(s.context, (sql) =>
      sql.query('delete from crm.records where id = $1', [deal]),
    );
    expect(await count()).toBe(0);
  });

  it("can't name another business's deal, and are not read from another business", async () => {
    const s = await scene();
    const other = await scene();
    const theirs = await other.deal();
    const user = await database.fixtures.user();
    await refused(
      database.withTenant(s.context, (sql) =>
        sql.query(
          `insert into crm.deal_followers (business_id, deal_id, user_id, added_by_kind)
           values (app.business_id(), $1, $2, 'user')`,
          [theirs, user.id],
        ),
      ),
      'deal_followers_business_id_deal_id_fkey',
    );
    await database.withTenant(other.context, (sql) =>
      sql.query(
        `insert into crm.deal_followers (business_id, deal_id, user_id, added_by_kind)
         values (app.business_id(), $1, $2, 'user')`,
        [theirs, user.id],
      ),
    );
    const seen = await database.withTenant(s.context, (sql) =>
      sql.query('select 1 from crm.deal_followers'),
    );
    expect(seen).toEqual([]);
  });
});

describe('a deal', () => {
  it('sorts by its name in lower case, kept by the database', async () => {
    const s = await scene();
    const deal = await s.deal('Élan Vital FENCE');
    const read = () =>
      database.withTenant(s.context, (sql) =>
        sql.one<{ sort_name: string }>('select sort_name from crm.deals where id = $1', [deal]),
      );
    expect((await read()).sort_name).toBe('élan vital fence');
    await database.withTenant(s.context, (sql) =>
      sql.query(`update crm.deals set name = 'Barn' where id = $1`, [deal]),
    );
    expect((await read()).sort_name).toBe('barn');
  });

  it('has the indexes the list orders by, each without the trash', async () => {
    const indexes = await database.as('crm_owner', (sql) =>
      sql.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where schemaname = 'crm' and indexname in
           ('deals_name_idx', 'deals_amount_idx', 'deals_updated_idx')
         order by indexname`,
      ),
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      'deals_amount_idx',
      'deals_name_idx',
      'deals_updated_idx',
    ]);
    expect(indexes.map((index) => index.indexdef.replace(/^.*USING btree /, ''))).toEqual([
      '(business_id, amount, id) WHERE (deleted_at IS NULL)',
      '(business_id, sort_name, id) WHERE (deleted_at IS NULL)',
      '(business_id, updated_at, id) WHERE (deleted_at IS NULL)',
    ]);
  });

  it('carries a win probability of its own from 0 to 1, or none', async () => {
    const s = await scene();
    const deal = await s.deal();
    const set = (value: string | null) =>
      database.withTenant(s.context, (sql) =>
        sql.query('update crm.deals set win_probability = $2 where id = $1', [deal, value]),
      );
    await set('0');
    await set('1');
    await set('0.3725');
    await set(null);
    await refused(set('1.0001'), 'deals_win_probability_range');
    await refused(set('-0.1'), 'deals_win_probability_range');
  });
});

describe('a pipeline and its stages', () => {
  it('start with stage probabilities, no colours, and shown in both charts', async () => {
    const s = await scene();
    const pipeline = await database.withTenant(s.context, (sql) =>
      sql.one(
        `select deal_probability, color_style, show_in_funnel, show_in_pie
         from crm.pipelines where id = $1`,
        [s.pipeline],
      ),
    );
    expect(pipeline).toEqual({
      deal_probability: false,
      color_style: 'none',
      show_in_funnel: true,
      show_in_pie: true,
    });
    const stage = await database.withTenant(s.context, (sql) =>
      sql.one('select color, show_in_funnel, show_in_pie from crm.pipeline_stages where id = $1', [
        s.stage,
      ]),
    );
    expect(stage).toEqual({ color: null, show_in_funnel: true, show_in_pie: true });
  });

  it('take one of three colour styles, and a colour as six lower-case hex digits', async () => {
    const s = await scene();
    const style = (value: string) =>
      database.withTenant(s.context, (sql) =>
        sql.query('update crm.pipelines set color_style = $2 where id = $1', [s.pipeline, value]),
      );
    await style('dot');
    await style('tint');
    await style('none');
    await refused(style('rainbow'), 'pipelines_color_style_valid');
    const color = (value: string | null) =>
      database.withTenant(s.context, (sql) =>
        sql.query('update crm.pipeline_stages set color = $2 where id = $1', [s.stage, value]),
      );
    await color('#12b76a');
    await color(null);
    for (const wrong of ['#12B76A', '12b76a', '#12b76', 'green', '#12b76a; drop'])
      await refused(color(wrong), 'pipeline_stages_color_format');
  });
});

describe('the opportunity settings of a business', () => {
  it('start as deals and contacts behaved before them: owners apart, nobody made a follower', async () => {
    const s = await scene();
    const settings = await database.withTenant(s.context, async (sql) => {
      await sql.query(
        'insert into crm.settings (business_id) values (app.business_id()) on conflict do nothing',
      );
      return sql.one(
        `select deal_owner_differs, deal_owner_follows_contact, contact_owner_follows_deal
         from crm.settings`,
      );
    });
    expect(settings).toEqual({
      deal_owner_differs: true,
      deal_owner_follows_contact: false,
      contact_owner_follows_deal: false,
    });
  });
});

describe('the record of a bulk action', () => {
  const insert = (s: Scene, values: Record<string, unknown> = {}) => {
    const row = {
      object_kind: 'deal',
      action: 'set_status',
      requested_count: 3,
      done_count: 1,
      unchanged_count: 1,
      skipped_count: 1,
      actor_kind: 'user',
      ...values,
    };
    return database.withTenant(s.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into crm.bulk_actions (business_id, object_kind, action, requested_count,
           done_count, unchanged_count, skipped_count, actor_kind)
         values (app.business_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          row.object_kind,
          row.action,
          row.requested_count,
          row.done_count,
          row.unchanged_count,
          row.skipped_count,
          row.actor_kind,
        ],
      ),
    );
  };

  it('gives every record named one outcome, for 1 to 100 records of a known kind', async () => {
    const s = await scene();
    await insert(s);
    await refused(insert(s, { done_count: 2 }), 'bulk_actions_counts_add_up');
    await refused(
      insert(s, { done_count: -1, unchanged_count: 3 }),
      'bulk_actions_counts_nonnegative',
    );
    await refused(insert(s, { requested_count: 101, done_count: 99 }), 'bulk_actions_bounded');
    await refused(
      insert(s, { requested_count: 0, done_count: 0, unchanged_count: 0, skipped_count: 0 }),
      'bulk_actions_bounded',
    );
    await refused(insert(s, { object_kind: 'contact' }), 'bulk_actions_object_kind_valid');
    await refused(insert(s, { action: 'Drop Table' }), 'bulk_actions_action_format');
    await refused(insert(s, { actor_kind: 'robot' }), 'bulk_actions_actor_kind_valid');
  });

  it("is written once and never changed, and is its own business's alone", async () => {
    const s = await scene();
    const other = await scene();
    const { id } = await insert(s);
    for (const change of [
      'update crm.bulk_actions set done_count = 0, unchanged_count = 2 where id = $1',
      'delete from crm.bulk_actions where id = $1',
    ])
      await expect(
        database.withTenant(s.context, (sql) => sql.query(change, [id])),
      ).rejects.toMatchObject({ code: '42501' });
    const seen = await database.withTenant(other.context, (sql) =>
      sql.query('select 1 from crm.bulk_actions'),
    );
    expect(seen).toEqual([]);
  });
});
