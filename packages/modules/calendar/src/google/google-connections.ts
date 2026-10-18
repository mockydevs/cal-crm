// Connecting a team member's Google Calendar: what the app does. The app seals the
// refresh token the moment Google gives it, and never opens one: reading calendars and busy
// time, writing events and revoking access are the worker's (google-worker.ts).
import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Command,
  type CommandContext,
  type Invocation,
  type Services,
  type TaskReference,
} from '@repo/commands';
import {
  chooseGoogleCalendars,
  chooseGoogleCalendarsInput,
  connectGoogle,
  disconnectGoogle,
  getGoogleConnections,
  googleRoleWrites,
  parseInput,
  refreshGoogleCalendars,
  type GoogleAccessRole,
  type GoogleConnectOutcome,
  type GoogleConnection,
  type GoogleConnections,
  type GoogleTeamConnection,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError, NotFoundError, ValidationError, type TenantContext } from '@repo/kernel';
import type { SealingVault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import {
  authorizationUrl,
  exchangeCode,
  GOOGLE_REQUIRED_SCOPES,
  revokeToken,
  type GoogleClient,
  type GoogleTransport,
} from './google-api.js';

/** The vault purpose of a member's refresh token. */
export const GOOGLE_REFRESH_TOKEN = 'calendar.google.refresh_token';

/** What the install connects Google with: absent when its OAuth client is not set. */
export interface GoogleSettings {
  readonly client: GoogleClient;
  readonly transport: GoogleTransport;
}

export interface GoogleConnectionOptions {
  readonly google: GoogleSettings | undefined;
  /** The app's sealing vault; without one nothing can be connected. */
  readonly vault: SealingVault | undefined;
  readonly members: {
    readonly memberships: (
      trx: DatabaseTransaction,
      context: TenantContext,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
}

export const refreshGoogleReference = {
  name: 'calendar.google.refresh_busy',
  data: z.strictObject({ connectionId: z.uuid(), readCalendars: z.boolean().default(false) }),
} satisfies TaskReference<z.ZodType>;
export const revokeGoogleReference = {
  name: 'calendar.google.revoke',
  data: z.strictObject({ connectionId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;
export const checkGoogleBusyReference = {
  name: 'calendar.google.check_busy',
  data: z.strictObject({ checkId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;
export const syncGoogleEventReference = {
  name: 'calendar.google.sync_appointment',
  data: z.strictObject({ appointmentId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/**
 * Queues the worker's reading of a connection, one waiting at a time. The job key is the
 * connection's, so a refresh asked for while one waits is the same refresh.
 */
export async function queueGoogleRefresh(
  trx: DatabaseTransaction,
  connectionId: string,
  readCalendars: boolean,
): Promise<void> {
  await sql`select private.enqueue_google_job(${refreshGoogleReference.name}, ${JSON.stringify({ connectionId, readCalendars })}::jsonb, ${`calendar-google-refresh:${connectionId}`}, null)`.execute(
    trx,
  );
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * The PKCE verifier of an attempt, made from its state with the client secret, so nothing
 * more is stored and nobody without the secret can finish the exchange. 43 characters of
 * base64url, the shortest RFC 7636 allows.
 */
export function codeVerifierOf(client: GoogleClient, state: string): string {
  return createHmac('sha256', client.clientSecret).update(`pkce:${state}`).digest('base64url');
}

const codeChallengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/** Changing a connection is the person's own: an API key or the system has none. */
function personOf(context: TenantContext): string {
  if (context.actorKind !== 'user' || context.userId === undefined)
    throw new ForbiddenError('Only a person can connect their own Google Calendar.');
  return context.userId;
}

const unavailable = () =>
  new ValidationError([
    {
      path: '',
      code: 'google_unavailable',
      message: 'This install is not set up to connect Google Calendar.',
    },
  ]);

interface ConnectionRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
  readonly disconnected_reason: string | null;
  readonly google_email: string;
  readonly write_calendar_id: string | null;
  readonly busy_checked_at: Date | null;
  readonly busy_failed_at: Date | null;
  readonly connected_at: Date;
}

const connectionColumns = [
  'id',
  'user_id',
  'status',
  'disconnected_reason',
  'google_email',
  'write_calendar_id',
  'busy_checked_at',
  'busy_failed_at',
  'connected_at',
] as const;

async function connectionOf(
  trx: DatabaseTransaction,
  businessId: string,
  userId: string,
  lock = false,
): Promise<ConnectionRow | undefined> {
  const query = trx
    .selectFrom('calendar.google_connections')
    .select(connectionColumns)
    .where('business_id', '=', businessId)
    .where('user_id', '=', userId);
  return (lock ? query.forUpdate() : query).executeTakeFirst();
}

const failing = (row: Pick<ConnectionRow, 'busy_checked_at' | 'busy_failed_at'>): boolean =>
  row.busy_failed_at !== null &&
  (row.busy_checked_at === null || row.busy_failed_at > row.busy_checked_at);

async function viewOf(
  trx: DatabaseTransaction,
  businessId: string,
  row: ConnectionRow,
): Promise<GoogleConnection> {
  const calendars = await trx
    .selectFrom('calendar.google_calendars')
    .select(['calendar_id', 'name', 'is_primary', 'access_role', 'check_conflicts'])
    .where('business_id', '=', businessId)
    .where('connection_id', '=', row.id)
    .orderBy('position')
    .execute();
  return {
    status: row.status as GoogleConnection['status'],
    disconnectedReason: row.disconnected_reason as GoogleConnection['disconnectedReason'],
    email: row.google_email,
    linkedCalendarId: row.write_calendar_id,
    calendars: calendars.map((calendar) => ({
      id: calendar.calendar_id,
      name: calendar.name,
      primary: calendar.is_primary,
      accessRole: calendar.access_role as GoogleAccessRole,
      checkConflicts: calendar.check_conflicts,
    })),
    busyCheckedAt: row.busy_checked_at?.toISOString() ?? null,
    busyFailing: failing(row),
    connectedAt: row.connected_at.toISOString(),
  };
}

async function readConnections(
  options: GoogleConnectionOptions,
  services: Services,
  invocation: Invocation,
): Promise<GoogleConnections> {
  const businessId = requireBusiness(invocation.context);
  // The team's statuses are for those who set up calendars, and for those who book on
  // them: whoever books for a colleague is told when that colleague's Google isn't checked.
  const { permissions } = invocation;
  const manages =
    permissions === 'all' ||
    permissions.has('calendars.manage') ||
    permissions.has('appointments.manage');
  return withTenant(services.db, invocation.context, async (trx) => {
    const userId = invocation.context.userId;
    const own =
      userId === undefined || invocation.context.actorKind !== 'user'
        ? undefined
        : await connectionOf(trx, businessId, userId);
    let team: GoogleTeamConnection[] | null = null;
    if (manages) {
      const rows = await trx
        .selectFrom('calendar.google_connections')
        .select(['user_id', 'status', 'disconnected_reason', 'busy_checked_at', 'busy_failed_at'])
        .where('business_id', '=', businessId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      const memberships = await options.members.memberships(
        trx,
        invocation.context,
        rows.map((row) => row.user_id),
      );
      team = rows.flatMap((row) => {
        const membershipId = memberships.get(row.user_id);
        return membershipId === undefined
          ? []
          : [
              {
                membershipId,
                status: row.status as GoogleTeamConnection['status'],
                disconnectedReason:
                  row.disconnected_reason as GoogleTeamConnection['disconnectedReason'],
                busyCheckedAt: row.busy_checked_at?.toISOString() ?? null,
                busyFailing: failing(row),
              },
            ];
      });
    }
    return {
      available: options.google !== undefined && options.vault !== undefined,
      mine: own === undefined ? null : await viewOf(trx, businessId, own),
      team,
    };
  });
}

/** Starts a connection: a single-use state for ten minutes, and Google's consent page. */
export function connectGoogleCommand(
  options: GoogleConnectionOptions,
): Command<z.ZodObject, { authorizationUrl: string }> {
  return defineCommand({
    name: 'calendar.google.connect',
    permission: 'appointments.manage',
    input: z.strictObject({}),
    async handle(trx, _input, command) {
      const businessId = requireBusiness(command.context);
      const userId = personOf(command.context);
      const { google } = options;
      if (google === undefined || options.vault === undefined) throw unavailable();
      const state = randomBytes(32).toString('base64url');
      const attempt = await trx
        .insertInto('calendar.google_connect_attempts')
        .values({ business_id: businessId, user_id: userId, state_digest: sha256(state) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'calendar.google.connect_started',
        subject: { kind: 'user', id: userId },
        payload: { attemptId: attempt.id },
      });
      return {
        authorizationUrl: authorizationUrl(google.client, {
          state,
          codeChallenge: codeChallengeOf(codeVerifierOf(google.client, state)),
        }),
      };
    },
  });
}

const completeInput = z.strictObject({
  attemptId: z.uuid(),
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(320),
  refreshToken: z.string().min(1),
});

/**
 * Keeps what Google gave, as the person: the refresh token sealed at once, the account,
 * and a reading of the calendars queued. The same account keeps its choices; another one
 * starts over. The audit log keeps the account's address, never the token.
 */
export function completeGoogleConnectCommand(
  options: GoogleConnectionOptions,
): Command<typeof completeInput, { connectionId: string }> {
  return defineCommand({
    name: 'calendar.google.complete_connect',
    permission: 'appointments.manage',
    input: completeInput,
    audit: ({ email }) => ({ email }),
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const userId = personOf(command.context);
      const { vault } = options;
      if (vault === undefined) throw unavailable();
      const existing = await connectionOf(trx, businessId, userId, true);
      const previous =
        existing === undefined
          ? undefined
          : await trx
              .selectFrom('calendar.google_connections')
              .select(['google_sub', 'secret_id'])
              .where('business_id', '=', businessId)
              .where('id', '=', existing.id)
              .executeTakeFirstOrThrow();
      const secretId = await vault.store(
        trx,
        { agencyId: command.context.agencyId, businessId, purpose: GOOGLE_REFRESH_TOKEN },
        input.refreshToken,
      );
      const values = {
        status: 'connecting',
        disconnected_reason: null,
        google_sub: input.sub,
        google_email: input.email,
        secret_id: secretId,
        busy_checked_at: null,
        busy_failed_at: null,
        next_refresh_at: sql<Date>`now()`,
        connected_at: sql<Date>`now()`,
        disconnected_at: null,
      } as const;
      let connectionId: string;
      if (existing === undefined) {
        const made = await trx
          .insertInto('calendar.google_connections')
          .values({ business_id: businessId, user_id: userId, ...values })
          .returning('id')
          .executeTakeFirstOrThrow();
        connectionId = made.id;
      } else {
        connectionId = existing.id;
        const sameAccount = previous?.google_sub === input.sub;
        await trx
          .updateTable('calendar.google_connections')
          .set({ ...values, ...(sameAccount ? {} : { write_calendar_id: null }) })
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .execute();
        // Busy time read for an old token is no longer known to be current.
        await clearBusy(trx, businessId, connectionId);
        if (!sameAccount) {
          // Another account: its calendars and the events written into the old one are
          // not this connection's any more.
          await trx
            .deleteFrom('calendar.google_calendars')
            .where('business_id', '=', businessId)
            .where('connection_id', '=', connectionId)
            .execute();
          await trx
            .deleteFrom('calendar.google_event_syncs')
            .where('business_id', '=', businessId)
            .where('connection_id', '=', connectionId)
            .execute();
        }
        if (previous !== undefined && previous.secret_id !== null)
          await vault.remove(trx, previous.secret_id);
      }
      await trx
        .deleteFrom('calendar.google_connect_attempts')
        .where('business_id', '=', businessId)
        .where('id', '=', input.attemptId)
        .execute();
      await command.emit({
        type: 'calendar.google.connected',
        subject: { kind: 'user', id: userId },
        payload: { connectionId },
      });
      await queueGoogleRefresh(trx, connectionId, true);
      return { connectionId };
    },
  });
}

async function clearBusy(
  trx: DatabaseTransaction,
  businessId: string,
  connectionId: string,
): Promise<void> {
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
}

async function requireOwn(
  trx: DatabaseTransaction,
  command: CommandContext,
): Promise<{ businessId: string; row: ConnectionRow }> {
  const businessId = requireBusiness(command.context);
  const userId = personOf(command.context);
  const row = await connectionOf(trx, businessId, userId, true);
  if (row === undefined || row.status === 'disconnected')
    throw new NotFoundError('Google Calendar connection', 'yours');
  return { businessId, row };
}

const chooseInput = chooseGoogleCalendarsInput;

/**
 * Which calendar appointments are written into, and which keep bookings away. The linked
 * calendar must be one the member may write to. The busy time is read again at once.
 */
export function chooseGoogleCalendarsCommand(): Command<typeof chooseInput, GoogleConnection> {
  return defineCommand({
    name: 'calendar.google.choose_calendars',
    permission: 'appointments.manage',
    input: chooseInput,
    async handle(trx, input, command) {
      const { businessId, row } = await requireOwn(trx, command);
      const calendars = await trx
        .selectFrom('calendar.google_calendars')
        .select(['calendar_id', 'access_role'])
        .where('business_id', '=', businessId)
        .where('connection_id', '=', row.id)
        .execute();
      const known = new Map(calendars.map((calendar) => [calendar.calendar_id, calendar]));
      const unknown = input.conflictCalendarIds.findIndex((id) => !known.has(id));
      if (unknown !== -1)
        throw new ValidationError([
          {
            path: `/conflictCalendarIds/${String(unknown)}`,
            code: 'unknown_calendar',
            message: 'Choose one of your Google calendars.',
          },
        ]);
      if (input.linkedCalendarId !== null) {
        const linked = known.get(input.linkedCalendarId);
        if (linked === undefined || !googleRoleWrites(linked.access_role as GoogleAccessRole))
          throw new ValidationError([
            {
              path: '/linkedCalendarId',
              code: 'not_writable',
              message: 'Choose a calendar you can add events to.',
            },
          ]);
      }
      await trx
        .updateTable('calendar.google_calendars')
        .set({
          check_conflicts: sql<boolean>`calendar_id = any(${[...input.conflictCalendarIds]}::text[])`,
        })
        .where('business_id', '=', businessId)
        .where('connection_id', '=', row.id)
        .execute();
      await trx
        .updateTable('calendar.google_connections')
        .set({ write_calendar_id: input.linkedCalendarId })
        .where('business_id', '=', businessId)
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'calendar.google.calendars_chosen',
        subject: { kind: 'user', id: row.user_id },
        payload: {
          linked: input.linkedCalendarId !== null,
          conflicts: input.conflictCalendarIds.length,
        },
      });
      await queueGoogleRefresh(trx, row.id, false);
      return viewOf(trx, businessId, { ...row, write_calendar_id: input.linkedCalendarId });
    },
  });
}

/** Reads the member's calendar list and busy time again, in the worker. */
export function refreshGoogleCommand(): Command<z.ZodObject, GoogleConnection> {
  return defineCommand({
    name: 'calendar.google.refresh',
    permission: 'appointments.manage',
    input: z.strictObject({}),
    async handle(trx, _input, command) {
      const { businessId, row } = await requireOwn(trx, command);
      await queueGoogleRefresh(trx, row.id, true);
      await command.emit({
        type: 'calendar.google.refresh_requested',
        subject: { kind: 'user', id: row.user_id },
      });
      return viewOf(trx, businessId, row);
    },
  });
}

/**
 * Marks a connection disconnected for a reason, drops what was read from it, and queues
 * revoking the token at Google and removing it from the vault. Events already written stay
 * in the member's Google calendar and are no longer followed.
 */
export async function markGoogleDisconnected(
  trx: DatabaseTransaction,
  businessId: string,
  connectionId: string,
  reason: 'member' | 'expired_or_revoked' | 'membership_ended',
): Promise<void> {
  await trx
    .updateTable('calendar.google_connections')
    .set({
      status: 'disconnected',
      disconnected_reason: reason,
      disconnected_at: sql<Date>`now()`,
    })
    .where('business_id', '=', businessId)
    .where('id', '=', connectionId)
    .execute();
  await clearBusy(trx, businessId, connectionId);
  await trx
    .deleteFrom('calendar.google_event_syncs')
    .where('business_id', '=', businessId)
    .where('connection_id', '=', connectionId)
    .execute();
  await sql`select private.enqueue_google_job(${revokeGoogleReference.name}, ${JSON.stringify({ connectionId })}::jsonb, ${`calendar-google-revoke:${connectionId}`}, null)`.execute(
    trx,
  );
}

export function disconnectGoogleCommand(): Command<z.ZodObject, undefined> {
  return defineCommand({
    name: 'calendar.google.disconnect',
    permission: 'appointments.manage',
    input: z.strictObject({}),
    async handle(trx, _input, command) {
      const { businessId, row } = await requireOwn(trx, command);
      await markGoogleDisconnected(trx, businessId, row.id, 'member');
      await command.emit({
        type: 'calendar.google.disconnected',
        subject: { kind: 'user', id: row.user_id },
        payload: { reason: 'member' },
      });
      return undefined;
    },
  });
}

/** Settings → Calendars → Connections. Every route but the read needs Google configured. */
export function createGoogleCalendarRoutes(options: GoogleConnectionOptions): readonly ApiRoute[] {
  const read: ApiRoute = {
    endpoint: getGoogleConnections,
    run: ({ invocation }, services) => readConnections(options, services, invocation),
  };
  if (options.google === undefined || options.vault === undefined) return [read];
  const connect = connectGoogleCommand(options);
  const choose = chooseGoogleCalendarsCommand();
  const refresh = refreshGoogleCommand();
  const disconnect = disconnectGoogleCommand();
  return [
    read,
    {
      endpoint: connectGoogle,
      command: connect,
      run: ({ invocation }, services) => runCommand(services, connect, {}, invocation),
    },
    {
      endpoint: chooseGoogleCalendars,
      command: choose,
      run: ({ invocation, body }, services) =>
        runCommand(services, choose, parseInput(chooseGoogleCalendarsInput, body), invocation),
    },
    {
      endpoint: refreshGoogleCalendars,
      command: refresh,
      run: ({ invocation }, services) => runCommand(services, refresh, {}, invocation),
    },
    {
      endpoint: disconnectGoogle,
      command: disconnect,
      run: ({ invocation }, services) => runCommand(services, disconnect, {}, invocation),
    },
  ];
}

/** What Google's redirect brought back to the callback address. */
export interface GoogleCallback {
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly error: string | undefined;
}

/** The person signed in where the callback arrived, and what they may do in a business. */
export interface CallbackPerson {
  readonly userId: string;
  /** Their grants in the attempt's business, or undefined when they are not in it now. */
  readonly grantsIn: (businessId: string) => Promise<Invocation['permissions'] | undefined>;
}

export interface CallbackResult {
  readonly outcome: GoogleConnectOutcome;
  /** The Connections page of the attempt's business, when the attempt was the person's. */
  readonly path: string | undefined;
}

/**
 * Finishes a connection where Google sent the browser back. The attempt is spent before the
 * code is exchanged, so a state works once. A state that is someone else's is not spent: it
 * may still be theirs to use.
 */
export async function completeGoogleConnect(
  options: GoogleConnectionOptions,
  services: Services,
  callback: GoogleCallback,
  person: CallbackPerson,
  correlationId: string,
): Promise<CallbackResult> {
  const { google } = options;
  if (google === undefined || options.vault === undefined)
    return { outcome: 'failed', path: undefined };
  if (callback.state === undefined || callback.state.length > 200)
    return { outcome: 'expired', path: undefined };
  const state = callback.state;
  const { rows } = await sql<{
    agency_id: string;
    business_id: string;
    user_id: string;
    attempt_id: string;
  }>`select * from private.find_google_connect_attempt(${sha256(state)})`.execute(services.db);
  const attempt = rows[0];
  if (attempt === undefined) return { outcome: 'expired', path: undefined };
  if (attempt.user_id !== person.userId) return { outcome: 'failed', path: undefined };
  const businessId = attempt.business_id;
  const grants = await person.grantsIn(businessId);
  if (grants === undefined) return { outcome: 'failed', path: undefined };
  const invocation: Invocation = {
    context: {
      agencyId: attempt.agency_id,
      businessId,
      userId: person.userId,
      actorKind: 'user',
      actorId: person.userId,
      correlationId,
    },
    permissions: grants,
  };
  const spent = await withTenant(services.db, invocation.context, async (trx) => {
    const removed = await trx
      .deleteFrom('calendar.google_connect_attempts')
      .where('business_id', '=', businessId)
      .where('id', '=', attempt.attempt_id)
      .where('user_id', '=', person.userId)
      .returning('id')
      .executeTakeFirst();
    const business = await trx
      .selectFrom('tenancy.businesses')
      .select('slug')
      .where('id', '=', businessId)
      .executeTakeFirstOrThrow();
    return {
      removed: removed !== undefined,
      path: `/b/${encodeURIComponent(business.slug)}/settings/calendars/connections`,
    };
  });
  const { path } = spent;
  if (!spent.removed) return { outcome: 'expired', path };
  if (callback.error !== undefined || callback.code === undefined)
    return { outcome: 'denied', path };
  const exchanged = await exchangeCode(
    google.transport,
    google.client,
    callback.code,
    codeVerifierOf(google.client, state),
  );
  if (!exchanged.ok) return { outcome: 'failed', path };
  const tokens = exchanged.value;
  if (!GOOGLE_REQUIRED_SCOPES.every((scope) => tokens.scopes.has(scope))) {
    // Not kept: without every box, the CRM could neither check nor write.
    await revokeToken(google.transport, tokens.refreshToken);
    return { outcome: 'scopes_missing', path };
  }
  try {
    await runCommand(
      services,
      completeGoogleConnectCommand(options),
      {
        attemptId: attempt.attempt_id,
        sub: tokens.account.sub,
        email: tokens.account.email,
        refreshToken: tokens.refreshToken,
      },
      invocation,
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      await revokeToken(google.transport, tokens.refreshToken);
      return { outcome: 'failed', path };
    }
    throw error;
  }
  return { outcome: 'connected', path };
}
