// Migration 0072: the cursors of triggers the clock fires, and the list of automations the
// worker sweeps for them.
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

type Business = Awaited<ReturnType<TestDatabase['fixtures']['business']>>;

/** An automation with one published version that subscribes to the given event types. */
async function automation(
  business: Business,
  status: 'active' | 'paused' | 'archived',
  eventTypes: readonly string[],
): Promise<{ id: string; versionId: string }> {
  return database.withTenant(business.context, async (sql) => {
    const { id } = await sql.one<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values ($1, 'Reminder', '{}', 'system') returning id`,
      [business.id],
    );
    const { id: versionId } = await sql.one<{ id: string }>(
      `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
       values ($1, $2, 1, '{}', 'system') returning id`,
      [business.id, id],
    );
    for (const eventType of eventTypes)
      await sql.query(
        `insert into automation.trigger_subscriptions (business_id, automation_id, version_id, event_type)
         values ($1, $2, $3, $4)`,
        [business.id, id, versionId, eventType],
      );
    await sql.query(
      `update automation.automations
       set published_version_id = $2, status = $3,
           archived_at = case when $3 = 'archived' then now() end
       where id = $1`,
      [id, versionId, status],
    );
    return { id, versionId };
  });
}

const listed = (after: string | null, limit: number) =>
  database.as('crm_app', (sql) =>
    sql.query<{ agency_id: string; business_id: string; automation_id: string }>(
      'select * from private.automations_with_timers($1, $2)',
      [after, limit],
    ),
  );

it('keeps a cursor inside its business, and removes it with its automation', async () => {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  const reminder = await automation(first, 'active', ['date.reached']);
  await database.withTenant(first.context, (sql) =>
    sql.query(
      `insert into automation.trigger_cursors (business_id, automation_id, trigger_id, swept_through)
       values ($1, $2, 'birthday', '2026-10-11T05:00:00Z')`,
      [first.id, reminder.id],
    ),
  );
  expect(
    await database.withTenant(second.context, (sql) =>
      sql.query('select trigger_id from automation.trigger_cursors'),
    ),
  ).toEqual([]);
  // Another business cannot keep a cursor for an automation that is not its own.
  await expect(
    database.as('crm_owner', (sql) =>
      sql.query(
        `insert into automation.trigger_cursors (business_id, automation_id, trigger_id, swept_through)
         values ($1, $2, 'birthday', now())`,
        [second.id, reminder.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await database.withTenant(first.context, (sql) =>
    sql.query(
      `update automation.trigger_cursors set swept_through = '2026-10-11T05:01:00Z'
       where automation_id = $1 and trigger_id = 'birthday'`,
      [reminder.id],
    ),
  );
  await database.as('crm_owner', (sql) =>
    sql.query('delete from automation.automations where id = $1', [reminder.id]),
  );
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query('select trigger_id from automation.trigger_cursors where automation_id = $1', [
        reminder.id,
      ]),
    ),
  ).toEqual([]);
});

it('keeps one cursor per trigger, named, and lets the app move only its time', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const reminder = await automation(business, 'active', ['date.reached']);
  const insert = (triggerId: string) =>
    database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into automation.trigger_cursors (business_id, automation_id, trigger_id, swept_through)
         values ($1, $2, $3, now())`,
        [business.id, reminder.id, triggerId],
      ),
    );
  await insert('birthday');
  await expect(insert('birthday')).rejects.toMatchObject({ code: '23505' });
  await expect(insert('')).rejects.toMatchObject({ code: '23514' });
  await expect(insert('x'.repeat(65))).rejects.toMatchObject({ code: '23514' });
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query(`update automation.trigger_cursors set trigger_id = 'other'`),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('keeps one firing per contact and occurrence, inside its business, and never changes it', async () => {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  const reminder = await automation(first, 'active', ['date.reached']);
  const contact = '0198f3c0-0000-7000-8000-000000000001';
  const fire = (occurrence: string) =>
    database.withTenant(first.context, (sql) =>
      sql.query<{ occurrence: string }>(
        `insert into automation.trigger_firings
           (business_id, automation_id, trigger_id, record_id, occurrence)
         values ($1, $2, 'birthday', $3, $4::date)
         on conflict do nothing
         returning occurrence::text`,
        [first.id, reminder.id, contact, occurrence],
      ),
    );
  expect(await fire('2026-10-20')).toEqual([{ occurrence: '2026-10-20' }]);
  // The same occurrence again is the row already there; next year's is its own.
  expect(await fire('2026-10-20')).toEqual([]);
  expect(await fire('2027-10-20')).toEqual([{ occurrence: '2027-10-20' }]);
  expect(
    await database.withTenant(second.context, (sql) =>
      sql.query('select occurrence from automation.trigger_firings'),
    ),
  ).toEqual([]);
  await expect(
    database.withTenant(first.context, (sql) =>
      sql.query(`update automation.trigger_firings set occurrence = '2026-10-21'`),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await database.as('crm_owner', (sql) =>
    sql.query('delete from automation.automations where id = $1', [reminder.id]),
  );
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query('select occurrence from automation.trigger_firings where automation_id = $1', [
        reminder.id,
      ]),
    ),
  ).toEqual([]);
});

it('lists the automations to sweep: published with a date trigger, running or paused', async () => {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  const running = await automation(first, 'active', ['date.reached', 'tag.assigned']);
  const paused = await automation(second, 'paused', ['date.reached']);
  const deleted = await automation(first, 'archived', ['date.reached']);
  const byEvent = await automation(first, 'active', ['contact.created']);
  // A version that was replaced: its subscription is not the published one's.
  const replaced = await automation(first, 'active', ['date.reached']);
  await database.withTenant(first.context, async (sql) => {
    const { id } = await sql.one<{ id: string }>(
      `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
       values ($1, $2, 2, '{}', 'system') returning id`,
      [first.id, replaced.id],
    );
    await sql.query('update automation.automations set published_version_id = $2 where id = $1', [
      replaced.id,
      id,
    ]);
  });

  const mine = new Set([running.id, paused.id, deleted.id, byEvent.id, replaced.id]);
  const rows = (await listed(null, 1000)).filter((row) => mine.has(row.automation_id));
  expect(rows).toEqual(
    [
      { agency_id: agency.id, business_id: first.id, automation_id: running.id },
      { agency_id: agency.id, business_id: second.id, automation_id: paused.id },
    ].toSorted((left, right) => left.automation_id.localeCompare(right.automation_id)),
  );
  // A page at a time, in id order, after the last one read.
  const [firstId = '', secondId = ''] = rows.map((row) => row.automation_id);
  expect((await listed(firstId, 1000)).map((row) => row.automation_id)).not.toContain(firstId);
  expect((await listed(firstId, 1000)).filter((row) => mine.has(row.automation_id))).toMatchObject([
    { automation_id: secondId },
  ]);
});

it('lists nothing for a business that is not active', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const reminder = await automation(business, 'active', ['date.reached']);
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [business.id]),
  );
  expect((await listed(null, 1000)).map((row) => row.automation_id)).not.toContain(reminder.id);
});
