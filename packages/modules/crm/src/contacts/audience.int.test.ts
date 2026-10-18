// Contacts as an audience: what every, a smart list, tags and a filter come to, read by the
// contact list's own planner against a migrated Postgres under row-level security.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { contactAudienceTest, fixContactAudience, type ContactAudience } from './audience.js';

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

async function world() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const other = await database.fixtures.user();
  const context = {
    ...business.context,
    actorKind: 'user' as const,
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  const invocation: Invocation = { context, permissions: 'all' };
  const ada = await database.fixtures.contact(context, { firstName: 'Ada' });
  const grace = await database.fixtures.contact(context, { firstName: 'Grace' });
  const old = await database.fixtures.contact(context, { firstName: 'Old' });
  const made = await withTenant(db, context, async (trx) => {
    const tag = async (name: string) =>
      (
        await trx
          .insertInto('crm.tags')
          .values({ business_id: business.id, name, created_by_kind: 'user' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const vip = await tag('VIP');
    const news = await tag('Newsletter');
    await trx
      .insertInto('crm.record_tags')
      .values(
        [
          [ada.id, vip],
          [ada.id, news],
          [grace.id, news],
          [old.id, vip],
        ].map(([record, tagId]) => ({
          business_id: business.id,
          record_id: record ?? '',
          tag_id: tagId ?? '',
          source_kind: 'user',
        })),
      )
      .execute();
    await sql`update crm.contacts set created_at = now() - interval '20 days' where id = ${old.id}`.execute(
      trx,
    );
    const type = async (kind: string) =>
      (
        await trx
          .selectFrom('crm.object_types')
          .select('id')
          .where('kind', '=', kind)
          .executeTakeFirstOrThrow()
      ).id;
    const view = async (name: string, filters: object, owner = user.id, objectType = 'contact') =>
      toPublicId(
        'saved_view',
        (
          await trx
            .insertInto('crm.saved_views')
            .values({
              business_id: business.id,
              object_type_id: await type(objectType),
              name,
              owner_user_id: owner,
              filters: JSON.stringify(filters),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
      );
    return {
      vip: toPublicId('tag', vip),
      news: toPublicId('tag', news),
      week: await view('This week', { added: 'week', sort: 'name', direction: 'desc' }),
      month: await view('This month', { added: 'month', q: 'Old' }),
      plain: await view('Everyone', {}),
      deals: await view('Deals', {}, user.id, 'deal'),
    };
  });
  // A private view of someone else is written as them: only its owner may make one.
  const theirs = await withTenant(
    db,
    { ...context, actorId: other.id, userId: other.id },
    async (trx) =>
      toPublicId(
        'saved_view',
        (
          await trx
            .insertInto('crm.saved_views')
            .values({
              business_id: business.id,
              object_type_id: (
                await trx
                  .selectFrom('crm.object_types')
                  .select('id')
                  .where('kind', '=', 'contact')
                  .executeTakeFirstOrThrow()
              ).id,
              name: 'Private',
              owner_user_id: other.id,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
      ),
  );
  const names = (audience: ContactAudience): Promise<string[]> =>
    withTenant(db, context, async (trx) => {
      const test = await contactAudienceTest(
        trx,
        invocation,
        await fixContactAudience(trx, audience),
      );
      const { rows } = await sql<{ first_name: string }>`
        select c.first_name from crm.contacts c where ${test} order by c.first_name
      `.execute(trx);
      return rows.map((row) => row.first_name);
    });
  return { context, invocation, ...made, theirs, names };
}

it('reads everyone, tags, a filter and a smart list as the contact list would', async () => {
  const w = await world();
  expect(await w.names({ kind: 'all' })).toEqual(['Ada', 'Grace', 'Old']);
  expect(await w.names({ kind: 'tags', tagIds: [w.vip], match: 'any' })).toEqual(['Ada', 'Old']);
  expect(await w.names({ kind: 'tags', tagIds: [w.vip, w.news], match: 'any' })).toEqual([
    'Ada',
    'Grace',
    'Old',
  ]);
  expect(await w.names({ kind: 'tags', tagIds: [w.vip, w.news], match: 'all' })).toEqual(['Ada']);
  expect(
    await w.names({
      kind: 'filter',
      filter: {
        match: 'all',
        groups: [
          { match: 'all', conditions: [{ field: 'firstName', operator: 'is', value: 'Grace' }] },
        ],
      },
    }),
  ).toEqual(['Grace']);
  // A smart list is its search and filters as they are now; how it is sorted says nothing
  // of who is in it, and "added this week" becomes a date.
  expect(await w.names({ kind: 'smart_list', viewId: w.plain })).toEqual(['Ada', 'Grace', 'Old']);
  expect(await w.names({ kind: 'smart_list', viewId: w.week })).toEqual(['Ada', 'Grace']);
  expect(await w.names({ kind: 'smart_list', viewId: w.month })).toEqual(['Old']);
  const fixed = await withTenant(db, w.context, (trx) =>
    fixContactAudience(trx, { kind: 'smart_list', viewId: w.month }),
  );
  expect(Object.keys(fixed).sort()).toEqual(['createdFrom', 'q']);
});

it('refuses a list that is not there to read, and a tag the business does not have', async () => {
  const w = await world();
  for (const viewId of [w.deals, w.theirs, toPublicId('saved_view', randomUUIDv7())])
    await expect(w.names({ kind: 'smart_list', viewId })).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    w.names({ kind: 'tags', tagIds: [toPublicId('tag', randomUUIDv7())], match: 'any' }),
  ).rejects.toBeInstanceOf(ValidationError);
});

/** Any UUIDv7, for an id that names nothing. */
function randomUUIDv7(): string {
  const hex = randomUUID().replaceAll('-', '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
