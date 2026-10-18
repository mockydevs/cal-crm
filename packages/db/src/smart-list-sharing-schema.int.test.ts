// The smart list sharing migration at the database's own level: a view shared with chosen
// people, each at a level, or with everyone at one; the widths its columns were dragged to;
// and who can see a view and its shares. What the CRM module does with these is its own
// to prove.
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
  /** The business, as its system. */
  readonly context: TenantContext;
  /** Acting as one person of the business, by their user id. */
  as(userId: string): TenantContext;
  readonly owner: string;
  readonly chosen: string;
  readonly other: string;
  /** Takes someone off the business's team. */
  remove(userId: string): Promise<void>;
  /** Puts someone on the business's team, through a new membership. */
  join(userId: string): Promise<void>;
}

async function scene(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context = { ...created.context, correlationId: randomUUID() };
  const [owner, chosen, other] = await Promise.all([
    database.fixtures.user(),
    database.fixtures.user(),
    database.fixtures.user(),
  ]);
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, 'business', 'member', 'Member', true) returning id`,
      [agency.id],
    ),
  );
  const join = async (userId: string) => {
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into tenancy.memberships (agency_id, business_id, role_id, user_id)
         values ($1, $2, $3, $4)`,
        [agency.id, created.id, role.id, userId],
      ),
    );
  };
  for (const userId of [owner.id, chosen.id, other.id]) await join(userId);
  return {
    context,
    as: (userId) => ({ ...context, actorKind: 'user', actorId: userId, userId }),
    owner: owner.id,
    chosen: chosen.id,
    other: other.id,
    remove: async (userId) => {
      await database.as('crm_owner', (sql) =>
        sql.query('delete from tenancy.memberships where user_id = $1 and business_id = $2', [
          userId,
          created.id,
        ]),
      );
    },
    join,
  };
}

/** Shares a view with someone by name, as its owner. */
async function shareWith(s: Scene, id: string, userId: string, access: string): Promise<void> {
  await database.withTenant(s.as(s.owner), (sql) =>
    sql.query(
      `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
       values (app.business_id(), $1, $2, $3)`,
      [id, userId, access],
    ),
  );
}

/** What the database refuses a statement with, or undefined when it takes it. */
const refusal = async (run: Promise<unknown>): Promise<string | undefined> =>
  run.then(
    () => undefined,
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );

/** A private contact view of the scene's owner, written as the owner. */
async function view(s: Scene, values = ''): Promise<string> {
  const row = await database.withTenant(s.as(s.owner), (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.saved_views (business_id, object_type_id, owner_user_id, name)
       select app.business_id(), id, app.user_id(), $1 from crm.object_types where kind = 'contact'
       returning id`,
      [`View ${randomUUID()}`],
    ),
  );
  if (values !== '')
    await database.withTenant(s.as(s.owner), (sql) =>
      sql.query(`update crm.saved_views set ${values} where id = $1`, [row.id]),
    );
  return row.id;
}
const visible = (context: TenantContext) =>
  database.withTenant(context, (sql) =>
    sql.query<{ id: string }>('select id from crm.saved_views order by id'),
  );

describe('a view shared with people by name', () => {
  it('is seen by its owner and the people named, and by nobody else in or out of the business', async () => {
    const s = await scene();
    const id = await view(s);
    await database.withTenant(s.as(s.owner), async (sql) => {
      await sql.query(
        `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
         values (app.business_id(), $1, $2, 'view')`,
        [id, s.chosen],
      );
      await sql.query(`update crm.saved_views set visibility = 'selected' where id = $1`, [id]);
    });
    expect(await visible(s.as(s.owner))).toEqual([{ id }]);
    expect(await visible(s.as(s.chosen))).toEqual([{ id }]);
    expect(await visible(s.as(s.other))).toEqual([]);
    // The system and anyone acting for a person see a view shared with everyone only.
    expect(await visible(s.context)).toEqual([]);
    expect(
      await visible({ ...s.as(s.chosen), actorKind: 'api_key', actorId: randomUUID() }),
    ).toEqual([]);
    const elsewhere = await scene();
    expect(await visible(elsewhere.as(elsewhere.owner))).toEqual([]);
  });

  it('has shares only its viewers read, each person once at a known level, gone with the view', async () => {
    const s = await scene();
    const id = await view(s, `visibility = 'selected'`);
    const share = (userId: string, access: string) =>
      database.withTenant(s.as(s.owner), (sql) =>
        sql.query(
          `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
           values (app.business_id(), $1, $2, $3)`,
          [id, userId, access],
        ),
      );
    expect(await refusal(share(s.chosen, 'admin'))).toContain('saved_view_shares_access_valid');
    await share(s.chosen, 'edit');
    expect(await refusal(share(s.chosen, 'view'))).toContain('saved_view_shares_pkey');
    const shares = (userId: string) =>
      database.withTenant(s.as(userId), (sql) =>
        sql.query<{ access: string }>('select access from crm.saved_view_shares'),
      );
    expect(await shares(s.owner)).toEqual([{ access: 'edit' }]);
    expect(await shares(s.other)).toEqual([]);
    // Someone who can't see the view can't give themselves a share of it.
    expect(
      await refusal(
        database.withTenant(s.as(s.other), (sql) =>
          sql.query(
            `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
             values (app.business_id(), $1, app.user_id(), 'edit')`,
            [id],
          ),
        ),
      ),
    ).toContain('row-level security');
    await database.withTenant(s.as(s.owner), (sql) =>
      sql.query('delete from crm.saved_views where id = $1', [id]),
    );
    const [left] = await database.as('crm_owner', (sql) =>
      sql.query<{ count: number }>(
        'select count(*)::int as count from crm.saved_view_shares where view_id = $1',
        [id],
      ),
    );
    expect(left).toEqual({ count: 0 });
  });

  it('answers the share lookup only for the person acting, inside their business', async () => {
    const s = await scene();
    const id = await view(s);
    await database.withTenant(s.as(s.owner), (sql) =>
      sql.query(
        `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
         values (app.business_id(), $1, $2, 'edit')`,
        [id, s.chosen],
      ),
    );
    const lookup = (context: TenantContext, businessId: string) =>
      database.withTenant(context, (sql) =>
        sql.one<{ access: string | null }>(
          'select private.saved_view_share_access($1, $2) as access',
          [businessId, id],
        ),
      );
    const businessId = s.context.businessId ?? '';
    expect(await lookup(s.as(s.chosen), businessId)).toEqual({ access: 'edit' });
    expect(await lookup(s.as(s.other), businessId)).toEqual({ access: null });
    const elsewhere = await scene();
    expect(await lookup(elsewhere.as(s.chosen), businessId)).toEqual({ access: null });
  });

  it('is gone for someone taken off the team, and stays gone when they are invited back', async () => {
    const s = await scene();
    const id = await view(s, `visibility = 'selected'`);
    await shareWith(s, id, s.chosen, 'edit');
    expect(await visible(s.as(s.chosen))).toEqual([{ id }]);
    await s.remove(s.chosen);
    expect(await visible(s.as(s.chosen))).toEqual([]);
    await s.join(s.chosen);
    expect(await visible(s.as(s.chosen))).toEqual([]);
    // Shared with again, after their return, it counts.
    await database.withTenant(s.as(s.owner), (sql) =>
      sql.query('delete from crm.saved_view_shares where view_id = $1', [id]),
    );
    await shareWith(s, id, s.chosen, 'view');
    expect(await visible(s.as(s.chosen))).toEqual([{ id }]);
  });

  it('lets someone it is shared with to view read it, and change neither it nor its shares', async () => {
    const s = await scene();
    const id = await view(s, `visibility = 'selected'`);
    await shareWith(s, id, s.chosen, 'view');
    await shareWith(s, id, s.other, 'edit');
    const viewer = s.as(s.chosen);
    const rows = (statement: string) =>
      database.withTenant(viewer, (sql) => sql.query(statement, [id]));
    expect(
      await rows(`update crm.saved_views set name = 'Taken' where id = $1 returning id`),
    ).toEqual([]);
    expect(await rows('delete from crm.saved_views where id = $1 returning id')).toEqual([]);
    expect(
      await rows(
        `update crm.saved_view_shares set access = 'edit' where view_id = $1 returning user_id`,
      ),
    ).toEqual([]);
    expect(
      await rows('delete from crm.saved_view_shares where view_id = $1 returning user_id'),
    ).toEqual([]);
    expect(
      await refusal(
        database.withTenant(viewer, (sql) =>
          sql.query(
            `insert into crm.saved_view_shares (business_id, view_id, user_id, access)
             values (app.business_id(), $1, $2, 'view')`,
            [id, s.owner],
          ),
        ),
      ),
    ).toContain('row-level security');
    // The editor may change both.
    const editor = (statement: string) =>
      database.withTenant(s.as(s.other), (sql) => sql.query(statement, [id]));
    expect(
      await editor(`update crm.saved_views set name = 'Edited' where id = $1 returning id`),
    ).toHaveLength(1);
    expect(
      await editor(
        `update crm.saved_view_shares set access = 'edit'
         where view_id = $1 and access = 'view' returning user_id`,
      ),
    ).toHaveLength(1);
  });

  it('counts the lists a business shares, those a person cannot see too, in that business only', async () => {
    const s = await scene();
    const mine = await view(s);
    const theirs = await database.withTenant(s.as(s.other), (sql) =>
      sql.one<{ id: string }>(
        `insert into crm.saved_views (business_id, object_type_id, owner_user_id, name)
         select app.business_id(), id, app.user_id(), 'Theirs' from crm.object_types
         where kind = 'contact' returning id`,
      ),
    );
    await database.withTenant(s.as(s.other), (sql) =>
      sql.query(`update crm.saved_views set visibility = 'selected' where id = $1`, [theirs.id]),
    );
    const count = (context: TenantContext) =>
      database.withTenant(context, (sql) =>
        sql.one<{ count: number }>(
          `select private.shared_saved_view_count(object_type_id)::int as count
           from crm.saved_views where id = $1`,
          [mine],
        ),
      );
    expect(await visible(s.as(s.owner))).toEqual([{ id: mine }]);
    expect(await count(s.as(s.owner))).toEqual({ count: 1 });
    const elsewhere = await scene();
    expect(
      await database.withTenant(elsewhere.as(elsewhere.owner), (sql) =>
        sql.one<{ count: number }>(
          `select private.shared_saved_view_count(id)::int as count from crm.object_types
           where kind = 'contact'`,
        ),
      ),
    ).toEqual({ count: 0 });
  });
});

describe('a view shared with everyone', () => {
  it('has one level for all, and only such a view has one other than viewing', async () => {
    const s = await scene();
    const id = await view(s);
    const set = (values: string) =>
      database.withTenant(s.as(s.owner), (sql) =>
        sql.query(`update crm.saved_views set ${values} where id = $1`, [id]),
      );
    expect(await refusal(set(`shared_access = 'edit'`))).toContain(
      'saved_views_shared_access_for_everyone',
    );
    expect(await refusal(set(`visibility = 'shared', shared_access = 'own'`))).toContain(
      'saved_views_shared_access_valid',
    );
    expect(await refusal(set(`visibility = 'team'`))).toContain('saved_views_visibility_valid');
    await set(`visibility = 'shared', shared_access = 'edit'`);
    expect(await visible(s.as(s.other))).toEqual([{ id }]);
  });
});

describe("a view's column widths", () => {
  it('are an object or nothing', async () => {
    const s = await scene();
    const id = await view(s);
    const set = (widths: string | null) =>
      database.withTenant(s.as(s.owner), (sql) =>
        sql.one<{ column_widths: unknown }>(
          'update crm.saved_views set column_widths = $2::jsonb where id = $1 returning column_widths',
          [id, widths],
        ),
      );
    expect(await set('{"name": 240}')).toEqual({ column_widths: { name: 240 } });
    expect(await set(null)).toEqual({ column_widths: null });
    expect(await refusal(set('[240]'))).toContain('saved_views_column_widths_object');
  });
});
