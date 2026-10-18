// Migration 0063 at the database's own level: a contact's date of birth, source and type,
// the index a list by last change reads, a smart list's column layout, and the record of a
// bulk action on contacts with what became of each contact. What the CRM module does with
// these is its own to prove.
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
  readonly contact: string;
}

async function scene(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context = { ...created.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context);
  return { context, contact: contact.id };
}

/** What the database refuses a statement with, or undefined when it takes it. */
const refusal = async (run: Promise<unknown>): Promise<string | undefined> =>
  run.then(
    () => undefined,
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );

describe("a contact's attributes", () => {
  it('are a date of birth, a source and a type, each empty until given', async () => {
    const s = await scene();
    const read = () =>
      database.withTenant(s.context, (sql) =>
        sql.one<{ born: string | null; source: string | null; contact_type: string | null }>(
          'select date_of_birth::text as born, source, contact_type from crm.contacts where id = $1',
          [s.contact],
        ),
      );
    expect(await read()).toEqual({ born: null, source: null, contact_type: null });
    await database.withTenant(s.context, (sql) =>
      sql.query(
        `update crm.contacts set date_of_birth = '1990-04-23', source = 'Trade fair',
                                 contact_type = 'customer' where id = $1`,
        [s.contact],
      ),
    );
    expect(await read()).toEqual({
      born: '1990-04-23',
      source: 'Trade fair',
      contact_type: 'customer',
    });
  });

  it.for([
    ["date_of_birth = '1849-12-31'", 'contacts_date_of_birth_sane'],
    ["source = ''", 'contacts_source_text'],
    ["source = ' padded '", 'contacts_source_text'],
    [`source = repeat('x', 201)`, 'contacts_source_text'],
    ["contact_type = 'Lead'", 'contacts_contact_type_format'],
    ["contact_type = ''", 'contacts_contact_type_format'],
  ] as const)('refuses %s', async ([assignment, constraint]) => {
    const s = await scene();
    const message = await refusal(
      database.withTenant(s.context, (sql) =>
        sql.query(`update crm.contacts set ${assignment} where id = $1`, [s.contact]),
      ),
    );
    expect(message).toContain(constraint);
  });

  it('holds a source of 200 characters and a type of any name the application offers', async () => {
    const s = await scene();
    await database.withTenant(s.context, (sql) =>
      sql.query(
        `update crm.contacts set source = repeat('x', 200), contact_type = 'trade_partner' where id = $1`,
        [s.contact],
      ),
    );
  });
});

describe('the list by last change', () => {
  it('has an index over contacts not in the trash, by business, change and id', async () => {
    const [index] = await database.as('crm_owner', (sql) =>
      sql.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'crm' and indexname = 'contacts_updated_idx'`,
      ),
    );
    expect(index?.indexdef).toContain('(business_id, updated_at DESC, id DESC)');
    expect(index?.indexdef).toContain('WHERE (deleted_at IS NULL)');
  });
});

describe("a smart list's column layout", () => {
  it('is a list or nothing', async () => {
    const s = await scene();
    const user = await database.fixtures.user();
    const insert = (layout: string | null) =>
      // As the person who saves it: a view is its owner's to write.
      database.withTenant(
        { ...s.context, actorKind: 'user', actorId: user.id, userId: user.id },
        (sql) =>
          sql.one<{ column_layout: unknown }>(
            `insert into crm.saved_views (business_id, object_type_id, owner_user_id, name, column_layout)
           select app.business_id(), id, $1, $2, $3::jsonb from crm.object_types where kind = 'contact'
           returning column_layout`,
            [user.id, `View ${randomUUID()}`, layout],
          ),
      );
    expect(await insert(null)).toEqual({ column_layout: null });
    expect(await insert('["name", "fld_x"]')).toEqual({ column_layout: ['name', 'fld_x'] });
    expect(await refusal(insert('{"name": true}'))).toContain('saved_views_column_layout_array');
  });
});

describe('a bulk action on contacts', () => {
  const start = (s: Scene, values: Record<string, unknown> = {}) => {
    const row = { action: 'add_tags', requested_count: 2, actor_kind: 'user', ...values };
    const columns = Object.keys(row);
    return database.withTenant(s.context, (sql) =>
      sql.one<{ id: string; status: string; done_count: number; finished_at: Date | null }>(
        `insert into crm.contact_bulk_actions (business_id, ${columns.join(', ')})
         values (app.business_id(), ${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})
         returning id, status, done_count, finished_at`,
        Object.values(row),
      ),
    );
  };

  it('starts queued, with nothing done and no end', async () => {
    const s = await scene();
    expect(await start(s)).toMatchObject({ status: 'queued', done_count: 0, finished_at: null });
  });

  it('adds contacts to a workflow as one of its kinds (migration 0097)', async () => {
    const s = await scene();
    expect(
      await start(s, { action: 'add_to_workflow', parameters: '{"workflowId": "x"}' }),
    ).toMatchObject({ status: 'queued' });
  });

  it('exports, sends, sets do not disturb and adds opportunities as kinds of its own (migration 0118)', async () => {
    const s = await scene();
    for (const action of ['export', 'send_email', 'send_sms', 'set_dnd', 'add_opportunity'])
      expect(await start(s, { action })).toMatchObject({ status: 'queued' });
    // A drip, and an export that failed with why.
    expect(
      await start(s, {
        action: 'send_sms',
        content: '{"message": "Hi"}',
        drip_batch_size: 100,
        drip_interval_seconds: 3600,
        window_end: 100,
        next_run_at: new Date(),
      }),
    ).toMatchObject({ status: 'queued' });
    expect(
      await start(s, {
        action: 'export',
        status: 'failed',
        failure: 'file_too_large',
        finished_at: new Date(),
        done_count: 2,
      }),
    ).toMatchObject({ status: 'failed' });
  });

  it.for([
    [{ action: 'merge' }, 'contact_bulk_actions_action_valid'],
    [{ status: 'paused' }, 'contact_bulk_actions_status_valid'],
    [{ content: '[]' }, 'contact_bulk_actions_content_object'],
    [{ drip_batch_size: 100 }, 'contact_bulk_actions_drip_whole'],
    [{ drip_batch_size: 0, drip_interval_seconds: 60 }, 'contact_bulk_actions_drip_batch_bounded'],
    [
      { drip_batch_size: 1, drip_interval_seconds: 59 },
      'contact_bulk_actions_drip_interval_bounded',
    ],
    [{ window_end: 0 }, 'contact_bulk_actions_window_positive'],
    [{ failure: 'file_too_large' }, 'contact_bulk_actions_failure_when_failed'],
    [{ status: 'failed', finished_at: new Date() }, 'contact_bulk_actions_failure_when_failed'],
    [
      { failure: 'Too Large', status: 'failed', finished_at: new Date() },
      'contact_bulk_actions_failure_format',
    ],
    [{ file_id: '0198de17-876e-7000-aac7-9bc8ac229001' }, 'contact_bulk_actions_file_fkey'],
    [{ requested_count: 0 }, 'contact_bulk_actions_requested_bounded'],
    [{ requested_count: 100_001 }, 'contact_bulk_actions_requested_bounded'],
    [{ done_count: -1 }, 'contact_bulk_actions_counts_nonnegative'],
    // More outcomes than contacts.
    [{ done_count: 2, skipped_count: 1 }, 'contact_bulk_actions_counts_within'],
    // Completed with a contact still without an outcome.
    [
      { status: 'completed', done_count: 1, finished_at: new Date() },
      'contact_bulk_actions_completed_whole',
    ],
    // Ended without a time, and a time without an end.
    [{ status: 'cancelled' }, 'contact_bulk_actions_finished_when_ended'],
    [{ finished_at: new Date() }, 'contact_bulk_actions_finished_when_ended'],
    [{ name: '' }, 'contact_bulk_actions_name_text'],
    [{ name: ' padded' }, 'contact_bulk_actions_name_text'],
    [{ parameters: '[]' }, 'contact_bulk_actions_parameters_object'],
    [{ actor_kind: 'robot' }, 'contact_bulk_actions_actor_kind_valid'],
  ] as const)('refuses %o', async ([values, constraint]) => {
    const s = await scene();
    expect(await refusal(start(s, values))).toContain(constraint);
  });

  it('takes a request key once in a business, and again in another', async () => {
    const s = await scene();
    const other = await scene();
    const key = randomUUID();
    await start(s, { request_key: key });
    expect(await refusal(start(s, { request_key: key }))).toContain(
      'contact_bulk_actions_request_idx',
    );
    await start(other, { request_key: key });
    // Without a key, any number.
    await start(s);
    await start(s);
  });

  it('names each contact once, with an outcome and a reason only for a skip', async () => {
    const s = await scene();
    const action = await start(s);
    const item = (
      position: number,
      contact: string,
      outcome: string | null,
      reason: string | null,
    ) =>
      database.withTenant(s.context, (sql) =>
        sql.query(
          `insert into crm.contact_bulk_action_items
             (business_id, bulk_action_id, position, contact_id, outcome, reason)
           values (app.business_id(), $1, $2, $3, $4, $5)`,
          [action.id, position, contact, outcome, reason],
        ),
      );
    await item(1, s.contact, null, null);
    expect(await refusal(item(2, s.contact, null, null))).toContain(
      'contact_bulk_action_items_contact_once',
    );
    expect(await refusal(item(1, randomUUID(), null, null))).toContain(
      'contact_bulk_action_items_pkey',
    );
    expect(await refusal(item(0, randomUUID(), null, null))).toContain(
      'contact_bulk_action_items_position_positive',
    );
    expect(await refusal(item(2, randomUUID(), 'failed', null))).toContain(
      'contact_bulk_action_items_outcome_valid',
    );
    expect(await refusal(item(2, randomUUID(), 'skipped', null))).toContain(
      'contact_bulk_action_items_reason_for_skipped',
    );
    expect(await refusal(item(2, randomUUID(), 'done', 'in_trash'))).toContain(
      'contact_bulk_action_items_reason_for_skipped',
    );
    expect(await refusal(item(2, randomUUID(), 'skipped', 'Not Found'))).toContain(
      'contact_bulk_action_items_reason_format',
    );
    // A contact that does not exist keeps its line: an id is all it is.
    await item(2, randomUUID(), 'skipped', 'not_found');
    await item(3, randomUUID(), 'done', null);
  });

  it('is its own business’s alone, and goes with it', async () => {
    const s = await scene();
    const other = await scene();
    const action = await start(s);
    await database.withTenant(s.context, (sql) =>
      sql.query(
        `insert into crm.contact_bulk_action_items (business_id, bulk_action_id, position, contact_id)
         values (app.business_id(), $1, 1, $2)`,
        [action.id, s.contact],
      ),
    );
    const seen = (context: TenantContext) =>
      database.withTenant(context, (sql) =>
        sql.one<{ actions: number; items: number }>(
          `select (select count(*)::int from crm.contact_bulk_actions) as actions,
                  (select count(*)::int from crm.contact_bulk_action_items) as items`,
        ),
      );
    expect(await seen(s.context)).toEqual({ actions: 1, items: 1 });
    expect(await seen(other.context)).toEqual({ actions: 0, items: 0 });
    // Another business can neither write an item of it nor change it.
    expect(
      await refusal(
        database.withTenant(other.context, (sql) =>
          sql.query(
            `insert into crm.contact_bulk_action_items (business_id, bulk_action_id, position, contact_id)
             values (app.business_id(), $1, 2, $2)`,
            [action.id, other.contact],
          ),
        ),
      ),
    ).toBeDefined();
    await database.withTenant(other.context, (sql) =>
      sql.query(`update crm.contact_bulk_actions set cancel_requested_at = now() where id = $1`, [
        action.id,
      ]),
    );
    const [row] = await database.as('crm_owner', (sql) =>
      sql.query<{ cancel_requested_at: Date | null }>(
        'select cancel_requested_at from crm.contact_bulk_actions where id = $1',
        [action.id],
      ),
    );
    expect(row).toEqual({ cancel_requested_at: null });
    // The application may not delete a line of the history.
    expect(
      await refusal(
        database.withTenant(s.context, (sql) =>
          sql.query('delete from crm.contact_bulk_actions where id = $1', [action.id]),
        ),
      ),
    ).toContain('permission denied');
  });
});
