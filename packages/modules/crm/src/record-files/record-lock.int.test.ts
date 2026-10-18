// How a command that changes a record's fields or files holds the record, against a
// migrated Postgres as crm_app. The Inbox's reply stores rows whose foreign keys take the
// contact FOR KEY SHARE while it holds the business row; a lock that blocked them would
// wait against such a writer in the opposite order (40P01). So the record's lock leaves
// foreign keys free, and still makes a second change to the record wait.
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { team } from '../../test/contact-details.js';
import { requireRecord } from '../records/access.js';

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

/** Whether another session gets the row with this lock now, without waiting. */
const takes = (table: string, id: string, lock: 'for key share' | 'for no key update') =>
  database.as('crm_owner', async (sql) => {
    await sql.query("set local lock_timeout = '200ms'");
    return sql.query(`select id from ${table} where id = $1 ${lock}`, [id]).then(
      () => true,
      (error: unknown) => {
        if ((error as { code?: string }).code !== '55P03') throw error;
        return false;
      },
    );
  });

it('leaves a held contact free for foreign keys, and makes another change wait', async () => {
  const t = await team(database);
  const contact = await database.fixtures.contact(t.context);
  await withTenant(db, t.context, async (trx) => {
    await requireRecord(trx, toPublicId('contact', contact.id), true);
    for (const table of ['crm.contacts', 'crm.records']) {
      expect(await takes(table, contact.id, 'for key share'), table).toBe(true);
      expect(await takes(table, contact.id, 'for no key update'), table).toBe(false);
    }
  });
});
