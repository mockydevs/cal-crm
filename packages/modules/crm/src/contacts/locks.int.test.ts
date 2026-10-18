// How a contact command holds the contact's row, against a migrated Postgres as crm_app. A
// writer that holds the business row (the Inbox's reply, the outbound worker) stores rows
// whose foreign keys take the contact FOR KEY SHARE, and a contact command writes an event
// whose foreign key takes the business FOR KEY SHARE. If the contact's lock blocked that
// foreign key, the two would wait for each other in opposite orders (40P01). So the lock
// must leave foreign keys free, and still make two changes to one contact wait.
import { withTenant, type Database, connectDatabase } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { team } from '../../test/contact-details.js';
import { lockContact } from './contacts.js';
import { lockLiveContact } from './details.js';

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

/** Whether another session gets the contact's row with this lock now, without waiting. */
const takes = (contactId: string, lock: 'for key share' | 'for no key update') =>
  database.as('crm_owner', async (sql) => {
    await sql.query("set local lock_timeout = '200ms'");
    return sql.query(`select id from crm.contacts where id = $1 ${lock}`, [contactId]).then(
      () => true,
      (error: unknown) => {
        if ((error as { code?: string }).code !== '55P03') throw error;
        return false;
      },
    );
  });

it.each([
  ['lockLiveContact', lockLiveContact],
  ['lockContact', lockContact],
] as const)(
  '%s leaves the contact free for foreign keys, and makes another change wait',
  async (_name, lock) => {
    const t = await team(database);
    const contact = await database.fixtures.contact(t.context);
    await withTenant(db, t.context, async (trx) => {
      await lock(trx, t.businessId, toPublicId('contact', contact.id));
      expect(await takes(contact.id, 'for key share')).toBe(true);
      expect(await takes(contact.id, 'for no key update')).toBe(false);
    });
  },
);
