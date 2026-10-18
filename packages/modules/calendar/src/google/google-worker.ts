// What the worker does with a member's Google Calendar: reads busy time into
// the store slots read, answers a booking's fresh look, writes each appointment into the
// linked calendar, and revokes access when a connection ends. Only the worker opens a
// refresh token. No Google call is made inside a database transaction: each job reads what
// it needs, calls Google, then writes what came back, checking that the connection is still
// the one it read.
import { createHash, randomUUID } from 'node:crypto';

import {
  defineTask,
  requireBusiness,
  type AnyTask,
  type Services,
  type Task,
} from '@repo/commands';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';

import {
  deleteEvent,
  getEvent,
  insertEvent,
  listCalendars,
  patchEvent,
  queryFreeBusy,
  refreshAccessToken,
  revokeToken,
  type BusyInterval,
  type GoogleEventBody,
  type GoogleListedCalendar,
  type GoogleResult,
  type WrittenEvent,
} from './google-api.js';
import {
  appointmentMeetsOnGoogle,
  eventDescription,
  freeBusySpans,
  tokenCache,
  type TokenCache,
  googleEventId,
  GOOGLE_LOOKBACK_MS,
  horizonDays,
  nextRefreshDelayMs,
} from './google-busy-rules.js';
import {
  checkGoogleBusyReference,
  GOOGLE_REFRESH_TOKEN,
  markGoogleDisconnected,
  queueGoogleRefresh,
  refreshGoogleReference,
  revokeGoogleReference,
  syncGoogleEventReference,
  type GoogleConnectionOptions,
  type GoogleSettings,
} from './google-connections.js';

/** The person is told their Google Calendar stopped working (a notification of theirs). */
export type GoogleDisconnectedNotice = (
  trx: DatabaseTransaction,
  context: TenantContext,
  notice: { readonly userId: string; readonly connectionId: string },
) => Promise<void>;

export interface GoogleWorkerOptions {
  readonly google: GoogleSettings;
  /** The worker's vault, which opens secrets. */
  readonly vault: Vault;
  readonly members: GoogleConnectionOptions['members'];
  readonly notifyDisconnected: GoogleDisconnectedNotice;
  /** Random numbers for spreading refreshes: Math.random, or a test's fixed ones. */
  readonly random: () => number;
}

/** How often a pending Meet is looked at again, and how many times. */
const MEET_RETRY_MS = 15_000;
const MEET_ATTEMPTS = 5;

interface OpenConnection {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly secretId: string;
  readonly refreshToken: string;
  readonly writeCalendarId: string | null;
}

/** A connection still live, with its refresh token, or why it is not usable. */
async function openConnection(
  trx: DatabaseTransaction,
  vault: Vault,
  businessId: string,
  connectionId: string,
): Promise<OpenConnection | 'gone' | 'unreadable'> {
  const row = await trx
    .selectFrom('calendar.google_connections')
    .select(['id', 'user_id', 'status', 'secret_id', 'write_calendar_id'])
    .where('business_id', '=', businessId)
    .where('id', '=', connectionId)
    .executeTakeFirst();
  if (row === undefined || row.status === 'disconnected' || row.secret_id === null) return 'gone';
  let refreshToken: string;
  try {
    refreshToken = await vault.read(trx, row.secret_id, GOOGLE_REFRESH_TOKEN);
  } catch (error) {
    if (error instanceof SecretUnreadableError) return 'unreadable';
    throw error;
  }
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    secretId: row.secret_id,
    refreshToken,
    writeCalendarId: row.write_calendar_id,
  };
}

const systemContext = (agencyId: string, businessId: string): TenantContext => ({
  agencyId,
  businessId,
  actorKind: 'system',
  correlationId: randomUUID(),
});

/** The worker's Google tasks, and the sync of one appointment for whoever needs it now. */
export interface GoogleWorker {
  readonly tasks: readonly AnyTask[];
  readonly syncAppointment: (
    appointmentId: string,
    context: TenantContext,
    services: Services,
  ) => Promise<void>;
}

export function createGoogleWorker(options: GoogleWorkerOptions): GoogleWorker {
  const { google, vault } = options;
  const { random } = options;
  const tokens: TokenCache = tokenCache();

  /** Ends a connection Google no longer accepts, and tells its member, once. */
  async function expire(services: Services, context: TenantContext, connection: OpenConnection) {
    const businessId = requireBusiness(context);
    tokens.forget(connection.secretId);
    await withTenant(services.db, context, async (trx) => {
      const current = await trx
        .selectFrom('calendar.google_connections')
        .select(['status', 'secret_id'])
        .where('business_id', '=', businessId)
        .where('id', '=', connection.id)
        .forUpdate()
        .executeTakeFirst();
      // A reconnection meanwhile has a new token, which is not the one refused.
      if (current?.status === 'disconnected' || current?.secret_id !== connection.secretId) return;
      await markGoogleDisconnected(trx, businessId, connection.id, 'expired_or_revoked');
      await options.notifyDisconnected(trx, context, {
        userId: connection.userId,
        connectionId: connection.id,
      });
      await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
    });
  }

  /** An access token, or why there is none: refused for good, or Google is unreachable. */
  async function accessFor(
    services: Services,
    context: TenantContext,
    connection: OpenConnection,
  ): Promise<{ readonly token: string } | 'expired' | 'unavailable'> {
    const held = tokens.get(connection.secretId);
    if (held !== undefined) return { token: held };
    const refreshed = await refreshAccessToken(
      google.transport,
      google.client,
      connection.refreshToken,
    );
    if (refreshed.outcome === 'invalid_grant') {
      await expire(services, context, connection);
      return 'expired';
    }
    if (refreshed.outcome === 'unavailable') return 'unavailable';
    tokens.set(connection.secretId, refreshed.accessToken, refreshed.expiresInSeconds);
    return { token: refreshed.accessToken };
  }

  /**
   * A call with the connection's access token. A 401 means the token went stale early: it
   * is refreshed once and the call made again.
   */
  async function withAccess<T>(
    services: Services,
    context: TenantContext,
    connection: OpenConnection,
    call: (accessToken: string) => Promise<GoogleResult<T>>,
  ): Promise<GoogleResult<T> | 'expired'> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const access = await accessFor(services, context, connection);
      if (access === 'expired') return 'expired';
      if (access === 'unavailable') return { ok: false, failure: 'retry' };
      const result = await call(access.token);
      if (result.ok || result.failure !== 'unauthorized') return result;
      tokens.forget(connection.secretId);
    }
    return { ok: false, failure: 'retry' };
  }

  /** Records that Google could not be read; the sweep tries again in a minute. */
  async function recordFailure(services: Services, context: TenantContext, connectionId: string) {
    const businessId = requireBusiness(context);
    await withTenant(services.db, context, async (trx) => {
      await trx
        .updateTable('calendar.google_connections')
        .set({
          busy_failed_at: sql<Date>`now()`,
          next_refresh_at: sql<Date>`now() + interval '1 minute'`,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', connectionId)
        .where('status', '<>', 'disconnected')
        .execute();
      await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
    });
  }

  /** The member's busy time over spans of at most one request each. */
  async function readBusy(
    services: Services,
    context: TenantContext,
    connection: OpenConnection,
    calendarIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<BusyInterval[] | 'expired' | 'failed'> {
    const busy: BusyInterval[] = [];
    for (const span of freeBusySpans({ start: from.getTime(), end: to.getTime() })) {
      const result = await withAccess(services, context, connection, (access) =>
        queryFreeBusy(
          google.transport,
          access,
          calendarIds,
          new Date(span.start),
          new Date(span.end),
        ),
      );
      if (result === 'expired') return 'expired';
      if (!result.ok) return 'failed';
      busy.push(...result.value);
    }
    return busy;
  }

  const refresh: Task<typeof refreshGoogleReference.data> = defineTask({
    ...refreshGoogleReference,
    async run({ connectionId, readCalendars }, { invocation, services }) {
      const { context } = invocation;
      const businessId = requireBusiness(context);
      const prepared = await withTenant(services.db, context, async (trx) => {
        const connection = await openConnection(trx, vault, businessId, connectionId);
        if (connection === 'gone') return null;
        if (connection === 'unreadable') {
          await markGoogleDisconnected(trx, businessId, connectionId, 'expired_or_revoked');
          return null;
        }
        // Someone who left the business is not checked or written for any more.
        const members = await options.members.memberships(trx, context, [connection.userId]);
        if (!members.has(connection.userId)) {
          await markGoogleDisconnected(trx, businessId, connectionId, 'membership_ended');
          return null;
        }
        const stored = await trx
          .selectFrom('calendar.google_calendars')
          .select(['calendar_id', 'check_conflicts'])
          .where('business_id', '=', businessId)
          .where('connection_id', '=', connectionId)
          .execute();
        const windows = await trx
          .selectFrom('calendar.calendars as c')
          .innerJoin('calendar.calendar_members as m', (join) =>
            join.onRef('m.business_id', '=', 'c.business_id').onRef('m.calendar_id', '=', 'c.id'),
          )
          .select('c.max_days_ahead')
          .where('c.business_id', '=', businessId)
          .where('m.user_id', '=', connection.userId)
          .execute();
        return {
          connection,
          stored,
          horizon: horizonDays(windows.map((window) => window.max_days_ahead)),
        };
      });
      if (prepared === null) return;
      const { connection } = prepared;
      const firstRead = connection.status === 'connecting';

      let listed: GoogleListedCalendar[] | undefined;
      if (readCalendars || firstRead) {
        const result = await withAccess(services, context, connection, (access) =>
          listCalendars(google.transport, access),
        );
        if (result === 'expired') return;
        if (!result.ok) {
          await recordFailure(services, context, connectionId);
          return;
        }
        listed = result.value;
      }
      // Which calendars are checked: as chosen; on the first reading, the primary one.
      const chosen = new Map(prepared.stored.map((row) => [row.calendar_id, row.check_conflicts]));
      const calendars =
        listed?.map((calendar, position) => ({
          ...calendar,
          position,
          check: chosen.get(calendar.id) ?? (prepared.stored.length === 0 && calendar.primary),
        })) ?? [];
      const conflictIds = (
        listed === undefined
          ? prepared.stored.filter((row) => row.check_conflicts).map((row) => row.calendar_id)
          : calendars.filter((calendar) => calendar.check).map((calendar) => calendar.id)
      ).slice(0, 50);

      const now = Date.now();
      const from = new Date(now - GOOGLE_LOOKBACK_MS);
      const to = new Date(now + prepared.horizon * 86_400_000);
      const busy = await readBusy(services, context, connection, conflictIds, from, to);
      if (busy === 'expired') return;
      if (busy === 'failed') {
        await recordFailure(services, context, connectionId);
        return;
      }

      await withTenant(services.db, context, async (trx) => {
        const current = await trx
          .selectFrom('calendar.google_connections')
          .select(['status', 'secret_id', 'write_calendar_id'])
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .forUpdate()
          .executeTakeFirst();
        // Disconnected, or connected again with another token, while Google answered.
        if (current?.status === 'disconnected' || current?.secret_id !== connection.secretId)
          return;
        if (listed !== undefined) {
          await trx
            .deleteFrom('calendar.google_calendars')
            .where('business_id', '=', businessId)
            .where('connection_id', '=', connectionId)
            .execute();
          if (calendars.length > 0)
            await trx
              .insertInto('calendar.google_calendars')
              .values(
                calendars.map((calendar) => ({
                  business_id: businessId,
                  connection_id: connectionId,
                  calendar_id: calendar.id,
                  name: calendar.name,
                  is_primary: calendar.primary,
                  access_role: calendar.accessRole,
                  check_conflicts: calendar.check,
                  position: calendar.position,
                })),
              )
              .execute();
        }
        // The linked calendar: on the first reading, the primary one where it can be
        // written to; one that has gone from the list links nothing.
        const writable = (id: string) =>
          calendars.some(
            (calendar) =>
              calendar.id === id &&
              (calendar.accessRole === 'owner' || calendar.accessRole === 'writer'),
          );
        let linked = current.write_calendar_id;
        if (listed !== undefined) {
          if (linked !== null && !writable(linked)) linked = null;
          if (firstRead && linked === null)
            linked =
              calendars.find((calendar) => calendar.primary && writable(calendar.id))?.id ?? null;
        }
        await trx
          .deleteFrom('calendar.google_busy')
          .where('business_id', '=', businessId)
          .where('connection_id', '=', connectionId)
          .execute();
        await trx
          .deleteFrom('calendar.google_busy_windows')
          .where('business_id', '=', businessId)
          .where('connection_id', '=', connectionId)
          .execute();
        if (busy.length > 0)
          await trx
            .insertInto('calendar.google_busy')
            .values(
              busy.map((interval) => ({
                business_id: businessId,
                connection_id: connectionId,
                starts_at: interval.startsAt,
                ends_at: interval.endsAt,
              })),
            )
            .execute();
        await trx
          .insertInto('calendar.google_busy_windows')
          .values({
            business_id: businessId,
            connection_id: connectionId,
            starts_at: from,
            ends_at: to,
          })
          .execute();
        await trx
          .updateTable('calendar.google_connections')
          .set({
            status: 'connected',
            write_calendar_id: linked,
            busy_checked_at: sql<Date>`now()`,
            busy_failed_at: null,
            next_refresh_at: new Date(Date.now() + nextRefreshDelayMs(random())),
          })
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .execute();
        // A newly connected member's coming appointments go into their calendar too.
        if (firstRead || linked !== current.write_calendar_id)
          await queueComingAppointments(trx, businessId, connection.userId);
        await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
      });
    },
  });

  const check: Task<typeof checkGoogleBusyReference.data> = defineTask({
    ...checkGoogleBusyReference,
    async run({ checkId }, { invocation, services }) {
      const { context } = invocation;
      const businessId = requireBusiness(context);
      const finish = (outcome: 'ok' | 'failed') =>
        withTenant(services.db, context, async (trx) => {
          await trx
            .updateTable('calendar.google_busy_checks')
            .set({ finished_at: sql<Date>`now()`, outcome })
            .where('business_id', '=', businessId)
            .where('id', '=', checkId)
            .where('finished_at', 'is', null)
            .execute();
        });
      const prepared = await withTenant(services.db, context, async (trx) => {
        const row = await trx
          .selectFrom('calendar.google_busy_checks')
          .select(['connection_id', 'starts_at', 'ends_at', 'finished_at'])
          .where('business_id', '=', businessId)
          .where('id', '=', checkId)
          .executeTakeFirst();
        if (row?.finished_at !== null) return null;
        const connection = await openConnection(trx, vault, businessId, row.connection_id);
        if (typeof connection === 'string' || connection.status !== 'connected')
          return { row, connection: undefined, calendarIds: [] };
        const calendars = await trx
          .selectFrom('calendar.google_calendars')
          .select('calendar_id')
          .where('business_id', '=', businessId)
          .where('connection_id', '=', row.connection_id)
          .where('check_conflicts', '=', true)
          .execute();
        return { row, connection, calendarIds: calendars.map((calendar) => calendar.calendar_id) };
      });
      if (prepared === null) return;
      const { row, connection } = prepared;
      if (connection === undefined) {
        await finish('failed');
        return;
      }
      const busy = await readBusy(
        services,
        context,
        connection,
        prepared.calendarIds,
        row.starts_at,
        row.ends_at,
      );
      if (typeof busy === 'string') {
        await finish('failed');
        return;
      }
      // What Google says now adds to what is known: busy time read earlier stays until the
      // next full reading replaces it, which can only keep more time away, never less.
      await withTenant(services.db, context, async (trx) => {
        const current = await trx
          .selectFrom('calendar.google_connections')
          .select(['status', 'secret_id'])
          .where('business_id', '=', businessId)
          .where('id', '=', connection.id)
          .forUpdate()
          .executeTakeFirst();
        const live = current?.status === 'connected' && current.secret_id === connection.secretId;
        if (live && busy.length > 0)
          await trx
            .insertInto('calendar.google_busy')
            .values(
              busy.map((interval) => ({
                business_id: businessId,
                connection_id: connection.id,
                starts_at: interval.startsAt,
                ends_at: interval.endsAt,
              })),
            )
            .execute();
        if (live)
          await trx
            .insertInto('calendar.google_busy_windows')
            .values({
              business_id: businessId,
              connection_id: connection.id,
              starts_at: row.starts_at,
              ends_at: row.ends_at,
            })
            .execute();
        await trx
          .updateTable('calendar.google_busy_checks')
          .set({ finished_at: sql<Date>`now()`, outcome: live ? 'ok' : 'failed' })
          .where('business_id', '=', businessId)
          .where('id', '=', checkId)
          .where('finished_at', 'is', null)
          .execute();
      });
    },
  });

  const revoke: Task<typeof revokeGoogleReference.data> = defineTask({
    ...revokeGoogleReference,
    async run({ connectionId }, { invocation, services }) {
      const { context } = invocation;
      const businessId = requireBusiness(context);
      const prepared = await withTenant(services.db, context, async (trx) => {
        const row = await trx
          .selectFrom('calendar.google_connections')
          .select(['status', 'secret_id', 'google_sub', 'disconnected_reason'])
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .executeTakeFirst();
        if (row?.status !== 'disconnected' || row.secret_id === null) return null;
        let token: string | null = null;
        try {
          token = await vault.read(trx, row.secret_id, GOOGLE_REFRESH_TOKEN);
        } catch (error) {
          if (!(error instanceof SecretUnreadableError)) throw error;
        }
        const { rows } = await sql<{ in_use: boolean }>`
          select private.google_account_in_use(${row.google_sub}, ${connectionId}::uuid) as in_use
        `.execute(trx);
        return {
          secretId: row.secret_id,
          // An expired token has nothing left to revoke; one another connection of the
          // same account still uses must not be revoked under it.
          token:
            row.disconnected_reason === 'expired_or_revoked' || rows[0]?.in_use === true
              ? null
              : token,
        };
      });
      if (prepared === null) return;
      tokens.forget(prepared.secretId);
      if (prepared.token !== null && !(await revokeToken(google.transport, prepared.token)))
        throw new Error('Google did not confirm the revocation; it is tried again.');
      await withTenant(services.db, context, async (trx) => {
        const updated = await trx
          .updateTable('calendar.google_connections')
          .set({ secret_id: null })
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .where('status', '=', 'disconnected')
          .where('secret_id', '=', prepared.secretId)
          .returning('id')
          .executeTakeFirst();
        if (updated !== undefined) await vault.remove(trx, prepared.secretId);
      });
    },
  });

  const sync: Task<typeof syncGoogleEventReference.data> = defineTask({
    ...syncGoogleEventReference,
    run: (data, job) => syncAppointment(data.appointmentId, job.invocation.context, job.services),
  });

  /** Writes one appointment into Google as it is now: inserted, moved or deleted. */
  async function syncAppointment(
    appointmentId: string,
    context: TenantContext,
    services: Services,
  ): Promise<void> {
    const businessId = requireBusiness(context);
    const plan = await withTenant(services.db, context, async (trx) => {
      const written = await trx
        .selectFrom('calendar.google_event_syncs')
        .selectAll()
        .where('business_id', '=', businessId)
        .where('appointment_id', '=', appointmentId)
        .executeTakeFirst();
      const desired = await desiredEvent(trx, businessId, appointmentId);
      const open = async (connectionId: string | undefined) => {
        if (connectionId === undefined) return undefined;
        const connection = await openConnection(trx, vault, businessId, connectionId);
        return typeof connection === 'string' ? undefined : connection;
      };
      return {
        written: written?.state === 'written' ? written : undefined,
        generation: written?.generation ?? 0,
        desired,
        current: await open(written?.state === 'written' ? written.connection_id : undefined),
        target: await open(desired?.connectionId),
      };
    });
    const { written, desired, current, target } = plan;
    let generation = plan.generation;

    // Gone from where it was: cancelled, deleted, or now someone else's or elsewhere.
    const moved =
      written !== undefined &&
      (written.connection_id !== desired?.connectionId ||
        written.google_calendar_id !== desired.calendarId);
    if (written !== undefined && moved) {
      if (current !== undefined) {
        const removed = await withAccess(services, context, current, (access) =>
          deleteEvent(google.transport, access, written.google_calendar_id, written.event_id),
        );
        if (removed !== 'expired' && !removed.ok && removed.failure === 'retry')
          throw new Error('Google did not answer the event deletion; it is tried again.');
      }
      await withTenant(services.db, context, (trx) =>
        trx
          .updateTable('calendar.google_event_syncs')
          .set({
            state: 'deleted',
            fingerprint: null,
            written_starts_at: null,
            written_ends_at: null,
            meet_url: null,
            meet_attempts: 0,
          })
          .where('business_id', '=', businessId)
          .where('appointment_id', '=', appointmentId)
          .execute(),
      );
    }
    if (desired === undefined || target === undefined) return;

    const fingerprint = createHash('sha256')
      .update(JSON.stringify([desired.body, desired.meet, desired.calendarId]))
      .digest('hex');
    const same = written !== undefined && !moved;
    const unchanged = same && written.fingerprint === fingerprint;
    if (unchanged && (!desired.meet || written.meet_url !== null)) return;

    let eventId = same ? written.event_id : googleEventId(appointmentId, generation + 1);
    if (!same) generation += 1;
    const body: GoogleEventBody = desired.body;
    const meet = desired.meet && (written?.meet_url ?? null) === null;
    let result: GoogleResult<WrittenEvent> | 'expired';
    if (same) {
      result = await withAccess(services, context, target, (access) =>
        unchanged
          ? // Only the Meet is still to come: read the event for its link.
            getEvent(google.transport, access, desired.calendarId, eventId)
          : patchEvent(google.transport, access, desired.calendarId, eventId, body, meet),
      );
      if (
        result !== 'expired' &&
        !result.ok &&
        (result.failure === 'not_found' || result.failure === 'gone')
      ) {
        // Deleted in Google: a new event, under the next id.
        generation += 1;
        eventId = googleEventId(appointmentId, generation);
        result = await withAccess(services, context, target, (access) =>
          insertEvent(google.transport, access, desired.calendarId, eventId, body, meet),
        );
      }
    } else {
      result = await withAccess(services, context, target, (access) =>
        insertEvent(google.transport, access, desired.calendarId, eventId, body, meet),
      );
      // An earlier try landed and the answer was lost: the event is ours, so it is patched.
      if (result !== 'expired' && !result.ok && result.failure === 'duplicate')
        result = await withAccess(services, context, target, (access) =>
          patchEvent(google.transport, access, desired.calendarId, eventId, body, meet),
        );
    }
    if (result === 'expired') return;
    if (!result.ok) {
      if (result.failure === 'retry' || result.failure === 'unauthorized')
        throw new Error('Google did not answer the event write; it is tried again.');
      await withTenant(services.db, context, (trx) =>
        trx
          .insertInto('calendar.google_event_syncs')
          .values({
            business_id: businessId,
            appointment_id: appointmentId,
            connection_id: target.id,
            google_calendar_id: desired.calendarId,
            event_id: eventId,
            generation: Math.max(1, generation),
            state: 'deleted',
            rejected_at: sql<Date>`now()`,
          })
          .onConflict((conflict) =>
            conflict.columns(['business_id', 'appointment_id']).doUpdateSet({
              rejected_at: sql<Date>`now()`,
              generation: Math.max(1, generation),
            }),
          )
          .execute(),
      );
      return;
    }
    const event = result.value;
    const meetUrl = event.meetUrl ?? written?.meet_url ?? null;
    const meetAttempts = event.meetPending ? (written?.meet_attempts ?? 0) + 1 : 0;
    await withTenant(services.db, context, async (trx) => {
      // The fingerprint of what Google now shows: with a Meet, its link is the location.
      const shown =
        desired.meet && meetUrl !== null
          ? createHash('sha256')
              .update(
                JSON.stringify([
                  { ...desired.body, location: meetUrl },
                  desired.meet,
                  desired.calendarId,
                ]),
              )
              .digest('hex')
          : fingerprint;
      const values = {
        connection_id: target.id,
        google_calendar_id: desired.calendarId,
        event_id: eventId,
        generation: Math.max(1, generation),
        state: 'written',
        fingerprint: shown,
        written_starts_at: body.startsAt,
        written_ends_at: body.endsAt,
        meet_url: meetUrl,
        meet_attempts: Math.min(meetAttempts, 100),
        rejected_at: null,
      } as const;
      await trx
        .insertInto('calendar.google_event_syncs')
        .values({ business_id: businessId, appointment_id: appointmentId, ...values })
        .onConflict((conflict) =>
          conflict.columns(['business_id', 'appointment_id']).doUpdateSet(values),
        )
        .execute();
      // The Meet's link becomes the appointment's place, for its page and its reminders.
      if (desired.meet && meetUrl !== null && desired.location !== meetUrl)
        await trx
          .updateTable('calendar.appointments')
          .set({ location: meetUrl })
          .where('business_id', '=', businessId)
          .where('id', '=', appointmentId)
          .execute();
      // Google is still making the Meet: look again shortly, a few times.
      if (event.meetPending && meetAttempts < MEET_ATTEMPTS)
        await sql`select private.enqueue_google_job(${syncGoogleEventReference.name}, ${JSON.stringify({ appointmentId })}::jsonb, ${`calendar-google-meet:${appointmentId}`}, now() + ${`${String(MEET_RETRY_MS)} milliseconds`}::interval)`.execute(
          trx,
        );
    });
  }

  return {
    tasks: [refresh, check, revoke, sync],
    syncAppointment,
  };
}

/**
 * What should be in Google for an appointment: an active one of a member whose Google is
 * connected with a linked calendar. Undefined for anything else.
 */
async function desiredEvent(
  trx: DatabaseTransaction,
  businessId: string,
  appointmentId: string,
): Promise<
  | {
      readonly connectionId: string;
      readonly calendarId: string;
      readonly body: GoogleEventBody;
      readonly meet: boolean;
      readonly location: string | null;
    }
  | undefined
> {
  const appointment = await trx
    .selectFrom('calendar.appointments as a')
    .innerJoin('calendar.calendars as c', (join) =>
      join.onRef('c.business_id', '=', 'a.business_id').onRef('c.id', '=', 'a.calendar_id'),
    )
    .select([
      'a.id',
      'a.status',
      'a.title',
      'a.location',
      'a.starts_at',
      'a.ends_at',
      'a.assigned_user_id',
      'a.calendar_id',
      'a.contact_id',
      'c.name as calendar_name',
      'c.timezone',
    ])
    .where('a.business_id', '=', businessId)
    .where('a.id', '=', appointmentId)
    .executeTakeFirst();
  if (appointment === undefined || !['booked', 'confirmed'].includes(appointment.status))
    return undefined;
  const userId = appointment.assigned_user_id;
  if (userId === null) return undefined;
  const connection = await trx
    .selectFrom('calendar.google_connections')
    .select(['id', 'write_calendar_id'])
    .where('business_id', '=', businessId)
    .where('user_id', '=', userId)
    .where('status', '=', 'connected')
    .executeTakeFirst();
  const calendarId = connection?.write_calendar_id ?? null;
  if (connection === undefined || calendarId === null) return undefined;
  const member = await trx
    .selectFrom('calendar.calendar_members')
    .select('locations')
    .where('business_id', '=', businessId)
    .where('calendar_id', '=', appointment.calendar_id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const written = await trx
    .selectFrom('calendar.google_event_syncs')
    .select('meet_url')
    .where('business_id', '=', businessId)
    .where('appointment_id', '=', appointment.id)
    .executeTakeFirst();
  const contact = await trx
    .selectFrom('crm.contacts')
    .select(['first_name', 'last_name'])
    .where('business_id', '=', businessId)
    .where('id', '=', appointment.contact_id)
    .executeTakeFirst();
  const identities = await trx
    .selectFrom('crm.contact_identities')
    .select(['kind', 'value'])
    .where('business_id', '=', businessId)
    .where('contact_id', '=', appointment.contact_id)
    .where('kind', 'in', ['email', 'phone'])
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .execute();
  const description = eventDescription(appointment.calendar_name, contact, identities);
  return {
    connectionId: connection.id,
    calendarId,
    meet: appointmentMeetsOnGoogle(
      member?.locations,
      appointment.location,
      written?.meet_url ?? null,
    ),
    location: appointment.location,
    body: {
      summary: appointment.title,
      description,
      location: appointment.location,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at,
      timeZone: appointment.timezone,
      appointmentId: appointment.id,
    },
  };
}

/** Queues the sync of a member's appointments still to come, at most 500, soonest first. */
export async function queueComingAppointments(
  trx: DatabaseTransaction,
  businessId: string,
  userId: string,
): Promise<void> {
  const coming = await trx
    .selectFrom('calendar.appointments')
    .select('id')
    .where('business_id', '=', businessId)
    .where('assigned_user_id', '=', userId)
    .where('status', 'in', ['booked', 'confirmed'])
    .where('ends_at', '>', new Date())
    .orderBy('starts_at')
    .limit(500)
    .execute();
  for (const appointment of coming)
    await sql`select private.enqueue_google_job(${syncGoogleEventReference.name}, ${JSON.stringify({ appointmentId: appointment.id })}::jsonb, ${`calendar-google-event:${appointment.id}`}, null)`.execute(
      trx,
    );
}

/**
 * The sweep, every minute: a refresh queued for each connection that is due, and old
 * attempts and answered checks removed. Gives how many refreshes it queued.
 */
export async function scheduleGoogleRefreshes(services: Services): Promise<number> {
  await sql`select private.expire_google_scratch()`.execute(services.db);
  const { rows } = await sql<{ agency_id: string; business_id: string; connection_id: string }>`
    select * from private.due_google_refreshes(1000)
  `.execute(services.db);
  for (const row of rows)
    await withTenant(services.db, systemContext(row.agency_id, row.business_id), async (trx) => {
      // Not due again until this refresh has had its time; the job sets the real next one.
      await trx
        .updateTable('calendar.google_connections')
        .set({ next_refresh_at: sql<Date>`now() + interval '5 minutes'` })
        .where('business_id', '=', row.business_id)
        .where('id', '=', row.connection_id)
        .execute();
      await queueGoogleRefresh(trx, row.connection_id, false);
    });
  return rows.length;
}
