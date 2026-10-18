import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { detailOptions, team } from '../../test/contact-details.js';
import { addContactFollowersCommand, removeAllContactFollowersCommand } from './people.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const options = detailOptions();

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

it('removes stored followers including a departed member and preserves another contact', async () => {
  const t = await team(database);
  const first = await t.member('Dana');
  const departed = await t.member('Alex');
  const contact = await database.fixtures.contact(t.context);
  const other = await database.fixtures.contact(t.context);
  const id = toPublicId('contact', contact.id);
  await runCommand(
    services,
    addContactFollowersCommand(options),
    {
      id,
      followers: [first.membershipId, departed.membershipId],
    },
    t.system(),
  );
  await runCommand(
    services,
    addContactFollowersCommand(options),
    {
      id: toPublicId('contact', other.id),
      followers: [first.membershipId],
    },
    t.system(),
  );
  await t.remove(departed);
  const result = await runCommand(
    services,
    removeAllContactFollowersCommand(options),
    { id },
    t.system(),
  );
  expect(result.followers).toEqual([]);
  expect(
    await database.withTenant(t.context, (sql) =>
      sql.query('select contact_id,user_id from crm.contact_followers order by contact_id,user_id'),
    ),
  ).toEqual([{ contact_id: other.id, user_id: first.userId }]);
  expect(
    await database.withTenant(t.context, (sql) =>
      sql.query(
        `select payload from events.events where type='contact.follower_removed'
     order by recorded_at,id`,
      ),
    ),
  ).toEqual(
    [first.userId, departed.userId].toSorted().map((followerUserId) => ({
      payload: { followerUserId },
    })),
  );
  await runCommand(services, removeAllContactFollowersCommand(options), { id }, t.system());
  expect(
    await database.withTenant(t.context, (sql) =>
      sql.query("select id from events.events where type='contact.follower_removed'"),
    ),
  ).toHaveLength(2);
});

it('does not remove another business followers when given its contact id', async () => {
  const owner = await team(database);
  const outsider = await team(database);
  const member = await owner.member('Dana');
  const contact = await database.fixtures.contact(owner.context);
  const id = toPublicId('contact', contact.id);
  await runCommand(
    services,
    addContactFollowersCommand(options),
    {
      id,
      followers: [member.membershipId],
    },
    owner.system(),
  );
  await expect(
    runCommand(services, removeAllContactFollowersCommand(options), { id }, outsider.system()),
  ).rejects.toMatchObject({ name: 'NotFoundError' });
  expect(
    await database.withTenant(owner.context, (sql) =>
      sql.query('select user_id from crm.contact_followers where contact_id=$1', [
        parsePublicId('contact', id),
      ]),
    ),
  ).toEqual([{ user_id: member.userId }]);
});
