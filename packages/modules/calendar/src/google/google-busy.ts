// A member's Google busy time as slots and bookings read it: from the busy store the worker
// keeps, never from Google on a page view.
import { setTimeout as sleep } from 'node:timers/promises';

import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { sql } from 'kysely';

import { GOOGLE_FRESH_MS, googleBusyIn, type Interval } from './google-busy-rules.js';

export interface BusyPeriodOut {
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * What each connected member's Google calendars make busy between two instants, by user.
 * Members without a working connection are absent: their checks are the CRM's own. The
 * CRM's own copies are left out, and time no reading of the last 15 minutes covers is busy.
 */
export async function readGoogleBusy(
  trx: DatabaseTransaction,
  businessId: string,
  userIds: readonly string[],
  window: { readonly from: Date; readonly to: Date },
  now: Date = new Date(),
): Promise<ReadonlyMap<string, readonly BusyPeriodOut[]>> {
  if (userIds.length === 0) return new Map();
  const connections = await trx
    .selectFrom('calendar.google_connections')
    .select(['id', 'user_id'])
    .where('business_id', '=', businessId)
    .where('user_id', 'in', [...new Set(userIds)])
    .where('status', '=', 'connected')
    .execute();
  if (connections.length === 0) return new Map();
  const ids = connections.map((connection) => connection.id);
  const busy = await trx
    .selectFrom('calendar.google_busy')
    .select(['connection_id', 'starts_at', 'ends_at'])
    .where('business_id', '=', businessId)
    .where('connection_id', 'in', ids)
    .where('ends_at', '>', window.from)
    .where('starts_at', '<', window.to)
    .execute();
  const known = await trx
    .selectFrom('calendar.google_busy_windows')
    .select(['connection_id', 'starts_at', 'ends_at'])
    .where('business_id', '=', businessId)
    .where('connection_id', 'in', ids)
    .where('ends_at', '>', window.from)
    .where('starts_at', '<', window.to)
    .where('checked_at', '>=', new Date(now.getTime() - GOOGLE_FRESH_MS))
    .execute();
  const own = await trx
    .selectFrom('calendar.google_event_syncs')
    .select(['connection_id', 'written_starts_at', 'written_ends_at'])
    .where('business_id', '=', businessId)
    .where('connection_id', 'in', ids)
    .where('state', '=', 'written')
    .where('written_ends_at', '>', window.from)
    .where('written_starts_at', '<', window.to)
    .execute();
  const range: Interval = { start: window.from.getTime(), end: window.to.getTime() };
  const of = (rows: readonly { connection_id: string; starts_at: Date; ends_at: Date }[]) =>
    Map.groupBy(
      rows.map((row) => ({
        connection: row.connection_id,
        start: row.starts_at.getTime(),
        end: row.ends_at.getTime(),
      })),
      (row) => row.connection,
    );
  const busyBy = of(busy);
  const knownBy = of(known);
  const ownBy = of(
    own.flatMap((row) =>
      row.written_starts_at === null || row.written_ends_at === null
        ? []
        : [
            {
              connection_id: row.connection_id,
              starts_at: row.written_starts_at,
              ends_at: row.written_ends_at,
            },
          ],
    ),
  );
  return new Map(
    connections.map((connection) => [
      connection.user_id,
      googleBusyIn(
        range,
        busyBy.get(connection.id) ?? [],
        ownBy.get(connection.id) ?? [],
        knownBy.get(connection.id) ?? [],
      ).map((interval) => ({
        startsAt: new Date(interval.start).toISOString(),
        endsAt: new Date(interval.end).toISOString(),
      })),
    ]),
  );
}

/** How long a booking waits for the worker's fresh look at its slot. */
export const FRESH_CHECK_WAIT_MS = 3000;
const POLL_MS = 100;

/**
 * What a fresh look reads around the time a booking or a move asks for: from a day before
 * to two days after, so the slot's whole day is covered in any zone, buffers included.
 */
export function freshRangeAround(startsAt: string): { readonly from: Date; readonly to: Date } {
  const asked = Date.parse(startsAt);
  return { from: new Date(asked - 86_400_000), to: new Date(asked + 2 * 86_400_000) };
}

/**
 * Asks the worker to read Google again for each connected member of a calendar over a
 * range, and waits up to `waitMs` for the answers. It never throws for Google: whatever
 * comes back, or doesn't, the booking then decides from the busy store under its own locks,
 * where time not read recently is busy.
 */
export async function freshenGoogleBusy(
  db: Database,
  context: TenantContext,
  calendarId: string,
  range: { readonly from: Date; readonly to: Date },
  waitMs = FRESH_CHECK_WAIT_MS,
): Promise<'fresh' | 'not_needed' | 'timed_out'> {
  const businessId = context.businessId;
  if (businessId === undefined) return 'not_needed';
  const checks = await withTenant(db, context, async (trx) => {
    const connections = await trx
      .selectFrom('calendar.google_connections as c')
      .innerJoin('calendar.calendar_members as m', (join) =>
        join.onRef('m.business_id', '=', 'c.business_id').onRef('m.user_id', '=', 'c.user_id'),
      )
      .select('c.id')
      .where('c.business_id', '=', businessId)
      .where('m.calendar_id', '=', calendarId)
      .where('c.status', '=', 'connected')
      .execute();
    const ids: string[] = [];
    for (const connection of connections) {
      const check = await trx
        .insertInto('calendar.google_busy_checks')
        .values({
          business_id: businessId,
          connection_id: connection.id,
          starts_at: range.from,
          ends_at: range.to,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await sql`select private.enqueue_google_job('calendar.google.check_busy', ${JSON.stringify({ checkId: check.id })}::jsonb, null, null)`.execute(
        trx,
      );
      ids.push(check.id);
    }
    return ids;
  });
  if (checks.length === 0) return 'not_needed';
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const open = await withTenant(db, context, (trx) =>
      trx
        .selectFrom('calendar.google_busy_checks')
        .select((eb) => eb.fn.countAll<string>().as('open'))
        .where('business_id', '=', businessId)
        .where('id', 'in', checks)
        .where('finished_at', 'is', null)
        .executeTakeFirstOrThrow(),
    );
    if (Number(open.open) === 0) return 'fresh';
  }
  return 'timed_out';
}
