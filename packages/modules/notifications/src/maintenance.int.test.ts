// Notifications end 30 days after they were read, or 90 days after they were made
// (migration 0056): the worker's hourly cleanup removes those, in every business.
import { randomUUID } from 'node:crypto';

import { withTenant } from '@repo/db';
import { expect, it } from 'vitest';

import { place, suite, toldIn, type Place } from '../test/fixtures.js';
import { deliver, expireNotifications } from './index.js';

const s = suite();

async function told(at: Place): Promise<string> {
  await withTenant(s.db, at.system, (trx) =>
    deliver(trx, at.system, {
      kind: 'ai.limit_reached',
      recipients: [at.owner.id],
      sourceKey: `test:${randomUUID()}`,
      cause: { kind: 'system', id: null },
      subject: { kind: 'ai_settings' },
    }),
  );
  const id = (await toldIn(s, at)).at(-1)?.id;
  if (id === undefined) throw new Error('Nothing was written.');
  return id;
}

/** Moves a notification back in time, as if it had been made that many days ago. */
const aged = (id: string, days: number) =>
  s.database.as('crm_owner', (sql) =>
    sql.query(
      `update notifications.notifications
       set created_at = created_at - make_interval(days => $2),
           expires_at = expires_at - make_interval(days => $2),
           read_at = read_at - make_interval(days => $2)
       where id = $1`,
      [id, days],
    ),
  );
const read = (at: Place, id: string) =>
  s.database.withTenant(at.owner.context, (sql) =>
    sql.query('update notifications.notifications set read_at = now() where id = $1', [id]),
  );

it('removes what was read 30 days ago and what nobody read in 90, in every business, and keeps the rest', async () => {
  const one = await place(s);
  const other = await place(s);
  // Read 31 days ago; made 91 days ago and never read.
  const readLongAgo = await told(one);
  await read(one, readLongAgo);
  await aged(readLongAgo, 31);
  const neverRead = await told(other);
  await aged(neverRead, 91);
  // Read 29 days ago; made 89 days ago and never read; made 89 days ago and read today.
  const readLately = await told(one);
  await read(one, readLately);
  await aged(readLately, 29);
  const stillWaiting = await told(other);
  await aged(stillWaiting, 89);
  const readToday = await told(other);
  await aged(readToday, 89);
  await read(other, readToday);
  const fresh = await told(one);

  expect(await expireNotifications(s.services)).toBe(2);

  const left = (at: Place) => toldIn(s, at).then((rows) => rows.map((row) => row.id));
  expect(await left(one)).toEqual([readLately, fresh]);
  expect(await left(other)).toEqual([stillWaiting, readToday]);
  // Nothing more to remove.
  expect(await expireNotifications(s.services)).toBe(0);
});
