// A calendar's assignment setting: a booking makes its host the contact's owner
// through the owner command, or leaves an owner in place.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, defineCommand, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { detailOptions, team, type Gate } from '../../test/contact-details.js';
import { assignOwnerFromBooking } from './booking-owner.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const gate: Gate = { whenResolving: () => Promise.resolve() };
const assign = assignOwnerFromBooking(detailOptions(gate));

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

/** As the booking command calls it: inside a command acting as the contact. */
const booked = defineCommand({
  name: 'test.booking.assign_owner',
  permission: 'calendars.manage',
  input: z.strictObject({
    contactId: z.uuid(),
    membershipId: z.string(),
    keepExisting: z.boolean(),
  }),
  handle: (trx, input, command) => assign(trx, input, command),
});

it('makes the host the owner, or keeps an owner the contact has when asked to', async () => {
  const t = await team(database);
  const host = await t.member('Hana Host');
  const other = await t.member('Omar Other');
  const contact = await database.fixtures.contact(t.context);
  const run = (membershipId: string, keepExisting: boolean) =>
    runCommand(
      services,
      booked,
      { contactId: contact.id, membershipId, keepExisting },
      {
        context: { ...t.context, actorKind: 'contact', correlationId: randomUUID() },
        permissions: new Set(['calendars.manage']),
      },
    );
  const owner = () =>
    database.withTenant(t.context, (sql) =>
      sql.one<{ owner_user_id: string | null }>(
        'select owner_user_id from crm.contacts where id = $1',
        [contact.id],
      ),
    );
  await run(host.membershipId, true);
  expect((await owner()).owner_user_id).toBe(host.userId);
  // Skip if owned: another host's booking leaves the owner as it is.
  await run(other.membershipId, true);
  expect((await owner()).owner_user_id).toBe(host.userId);
  // Otherwise the latest booking's host becomes the owner, reported once.
  await run(other.membershipId, false);
  expect((await owner()).owner_user_id).toBe(other.userId);
  expect(parsePublicId('membership', other.membershipId)).toBeDefined();
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query<{ type: string }>(
        "select type from events.events where business_id = $1 and type = 'contact.owner_assigned'",
        [t.businessId],
      ),
    ),
  ).toHaveLength(2);
});
