import { randomUUID } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ForbiddenError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { sql } from 'kysely';
import { readTaskAssigneeMemberships, readTaskAssignees, resolveTaskAssignee } from './index.js';

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

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const context: TenantContext = {
    ...business.context,
    actorKind: 'user',
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  const membership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `with role as (insert into tenancy.roles (agency_id, scope, key, name)
      values ($1, 'business', 'member', 'Member') returning id)
     insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
     select $1, $2, $3, id from role returning id`,
      [agency.id, business.id, user.id],
    ),
  );
  return { agency, business, user, context, membershipId: toPublicId('membership', membership.id) };
}

it('resolves a visible membership or the signed-in person, and refuses foreign or machine self assignments', async () => {
  const ours = await fixture();
  const theirs = await fixture();
  const resolve = (selection: string | null, context = ours.context) =>
    withTenant(db, context, (trx) => resolveTaskAssignee(trx, context, selection));
  expect(await resolve(ours.membershipId)).toBe(ours.user.id);
  expect(await resolve('me')).toBe(ours.user.id);
  expect(await resolve(null)).toBeNull();
  await expect(resolve(theirs.membershipId)).rejects.toBeInstanceOf(ValidationError);
  await expect(resolve(ours.user.id)).rejects.toBeInstanceOf(ValidationError);
  await expect(
    resolve('me', { ...ours.context, actorKind: 'api_key', actorId: randomUUID() }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const { businessId: _businessId, ...agencyContext } = ours.context;
  await expect(resolve(null, agencyContext)).rejects.toBeInstanceOf(ValidationError);
});

it('pages eligible people once each, prefers their business membership, and hides sibling businesses', async () => {
  const ours = await fixture();
  const sibling = await database.fixtures.business(ours.agency.id);
  const agencyPerson = await database.fixtures.user();
  const siblingPerson = await database.fixtures.user();
  const agencyMemberships = await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name)
       values ($1, 'agency', 'member', 'Agency member') returning id`,
      [ours.agency.id],
    );
    return sql.query<{ id: string; user_id: string }>(
      `insert into tenancy.memberships (agency_id, user_id, role_id)
       values ($1, $2, $4), ($1, $3, $4) returning id, user_id`,
      [ours.agency.id, ours.user.id, agencyPerson.id, role.id],
    );
  });
  const extra = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `with people as (
       insert into auth.users (email, name)
       select 'task-' || gen_random_uuid()::text || '-' || n || '@example.test', 'Person ' || n
       from generate_series(1,49) n returning id)
     insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
     select $1, $2, people.id, r.id from people, tenancy.roles r
     where r.agency_id = $1 and r.scope = 'business' returning id`,
      [ours.agency.id, ours.business.id],
    ),
  );
  const [hidden] = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
     select $1, $2, $3, r.id from tenancy.roles r
     where r.agency_id = $1 and r.scope = 'business' returning id`,
      [ours.agency.id, sibling.id, siblingPerson.id],
    ),
  );
  if (hidden === undefined) throw new Error('Expected the sibling membership.');
  const read = (after?: string) =>
    withTenant(db, ours.context, (trx) => readTaskAssignees(trx, ours.context, after));
  const first = await read();
  expect(first.items).toHaveLength(50);
  if (first.nextCursor === null) throw new Error('Expected the second page.');
  const second = await read(first.nextCursor);
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  const all = [...first.items, ...second.items];
  const agencyOnly = agencyMemberships.find((row) => row.user_id === agencyPerson.id);
  if (agencyOnly === undefined) throw new Error('Expected the agency-only membership.');
  expect(new Set(all.map((person) => person.id))).toEqual(
    new Set([
      ours.membershipId,
      toPublicId('membership', agencyOnly.id),
      ...extra.map((row) => toPublicId('membership', row.id)),
    ]),
  );
  expect(new Set(all.map((person) => person.userId)).size).toBe(51);
  await expect(read(toPublicId('membership', hidden.id))).rejects.toBeInstanceOf(ValidationError);
  await expect(
    withTenant(db, ours.context, (trx) =>
      resolveTaskAssignee(trx, ours.context, toPublicId('membership', hidden.id)),
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(
    await withTenant(db, ours.context, (trx) =>
      resolveTaskAssignee(trx, ours.context, toPublicId('membership', agencyOnly.id)),
    ),
  ).toBe(agencyPerson.id);
});

it('holds an assignment against concurrent membership removal until its transaction finishes', async () => {
  const ours = await fixture();
  const selected = Promise.withResolvers<string | null>();
  const finish = Promise.withResolvers<undefined>();
  const deleting = Promise.withResolvers<number>();
  const assigning = withTenant(db, ours.context, async (trx) => {
    try {
      selected.resolve(await resolveTaskAssignee(trx, ours.context, ours.membershipId));
      await finish.promise;
    } catch (error) {
      selected.reject(error);
      throw error;
    }
  });
  let removing: Promise<number> | undefined;
  const state = { removed: false };
  try {
    expect(await selected.promise).toBe(ours.user.id);
    removing = withTenant(db, ours.context, async (trx) => {
      const {
        rows: [session],
      } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
      if (session === undefined) throw new Error('Expected the removal session.');
      deleting.resolve(session.pid);
      const removed = await trx
        .deleteFrom('tenancy.memberships')
        .where('id', '=', parsePublicId('membership', ours.membershipId) ?? '')
        .returning('id')
        .execute();
      return removed.length;
    });
    void removing.then(
      () => {
        state.removed = true;
      },
      () => {
        state.removed = true;
      },
    );
    const pid = await deleting.promise;
    await expect
      .poll(async () => {
        const [waiting] = await database.as('crm_owner', (connection) =>
          connection.query<{ blocked: boolean }>(
            'select cardinality(pg_blocking_pids($1)) > 0 as blocked',
            [pid],
          ),
        );
        return waiting?.blocked === true ? 'waiting' : state.removed ? 'removed' : 'starting';
      })
      .toBe('waiting');
  } finally {
    finish.resolve(undefined);
    await Promise.allSettled([assigning, removing]);
  }
  expect(await removing).toBe(1);
  await expect(
    withTenant(db, ours.context, (trx) =>
      resolveTaskAssignee(trx, ours.context, ours.membershipId),
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});

it("maps stored assignees to the membership they'd be assigned through now, business first", async () => {
  const ours = await fixture();
  const foreign = await fixture();
  const sibling = await database.fixtures.business(ours.agency.id);
  const [agencyPerson, removedPerson, siblingPerson] = [
    await database.fixtures.user(),
    await database.fixtures.user(),
    await database.fixtures.user(),
  ];
  const memberships = await database.as('crm_owner', async (sql) => {
    const agencyRole = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name)
       values ($1, 'agency', 'member', 'Agency member') returning id`,
      [ours.agency.id],
    );
    // Ours is also on the agency team; the agency person only there.
    const agency = await sql.query<{ id: string; user_id: string }>(
      `insert into tenancy.memberships (agency_id, user_id, role_id)
       values ($1, $2, $4), ($1, $3, $4) returning id, user_id`,
      [ours.agency.id, ours.user.id, agencyPerson.id, agencyRole.id],
    );
    const businessRole = await sql.one<{ id: string }>(
      `select id from tenancy.roles where agency_id = $1 and scope = 'business' limit 1`,
      [ours.agency.id],
    );
    // Removed since a task was assigned to them; and someone only in a sibling business.
    const removed = await sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
       values ($1, $2, $3, $4) returning id`,
      [ours.agency.id, ours.business.id, removedPerson.id, businessRole.id],
    );
    await sql.query(`delete from tenancy.memberships where id = $1`, [removed.id]);
    await sql.query(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
       values ($1, $2, $3, $4)`,
      [ours.agency.id, sibling.id, siblingPerson.id, businessRole.id],
    );
    return agency;
  });
  const agencyOnly = memberships.find((row) => row.user_id === agencyPerson.id);
  if (agencyOnly === undefined) throw new Error('Expected the agency-only membership.');
  const read = (userIds: readonly string[], context = ours.context) =>
    withTenant(db, context, (trx) => readTaskAssigneeMemberships(trx, context, userIds));

  const found = await read([
    ours.user.id,
    agencyPerson.id,
    ours.user.id,
    removedPerson.id,
    siblingPerson.id,
    foreign.user.id,
    randomUUID(),
    agencyPerson.id,
  ]);

  // One entry a person: ours through the business, not the agency; nobody else.
  expect([...found.entries()].sort()).toEqual(
    [
      [ours.user.id, ours.membershipId],
      [agencyPerson.id, toPublicId('membership', agencyOnly.id)],
    ].sort(),
  );
  // In their own business the foreign person is found, and ours isn't.
  expect([...(await read([foreign.user.id, ours.user.id], foreign.context)).entries()]).toEqual([
    [foreign.user.id, foreign.membershipId],
  ]);
});

it('gives no one for no ids, and still needs a business', async () => {
  const ours = await fixture();
  const read = (userIds: readonly string[], context: TenantContext) =>
    withTenant(db, context, (trx) => readTaskAssigneeMemberships(trx, context, userIds));

  expect((await read([], ours.context)).size).toBe(0);
  const { businessId: _businessId, ...agencyContext } = ours.context;
  await expect(read([], agencyContext)).rejects.toBeInstanceOf(ValidationError);
  await expect(read([ours.user.id], agencyContext)).rejects.toBeInstanceOf(ValidationError);
});
