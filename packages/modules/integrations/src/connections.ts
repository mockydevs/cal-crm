// Settings → Integrations, what the app does: lists every connection the business has, on
// this page or on a page of its own; starts a connection (the provider's consent address, or
// a pasted key sealed at once); changes a connection's options; queues a check; disconnects.
// The app seals credentials and never opens them: reading the account, checking it,
// refreshing tokens and revoking them are the worker's (worker.ts).
import { randomBytes } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Command,
  type CommandContext,
  type Grants,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  connectIntegration,
  connectIntegrationInput,
  disconnectIntegration,
  elsewhereIntegrations,
  getIntegration,
  INTEGRATION_LIMITS,
  integrationActivityQuery,
  integrationConnectionParams,
  integrationParams,
  listIntegrationActivity,
  listIntegrations,
  parseInput,
  testIntegrationConnection,
  updateIntegrationConnection,
  updateIntegrationConnectionInput,
  type IntegrationActivity,
  type IntegrationConnection,
  type IntegrationConnectStarted,
  type IntegrationEntry,
  type IntegrationErrorCode,
  type IntegrationReading,
  type Permission,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import type { SealingVault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { authorizationUrl } from './oauth.js';
import { providerReady, type IntegrationProvider } from './provider.js';
import {
  codeChallengeOf,
  codeVerifierOf,
  credentialsPurpose,
  readingOf,
  sha256,
  sha256Hex,
  stateOf,
  webhookToken,
  type SealedCredentials,
} from './rules.js';

/** A connection that lives on a page of its own, read by the module that keeps it. */
export interface ElsewhereSource {
  /** The catalogue's key (elsewhereIntegrations). */
  readonly key: string;
  /** Whether the install is set up for it at all. */
  readonly available: boolean;
  readonly read: (trx: DatabaseTransaction, businessId: string) => Promise<IntegrationReading>;
}

export interface IntegrationOptions {
  /** The providers this install's code can connect. */
  readonly providers: readonly IntegrationProvider[];
  /** The app's sealing vault; without one nothing can be connected here. */
  readonly vault: SealingVault | undefined;
  /** Where each provider sends the browser back: the address registered with it. */
  readonly redirectUri: (key: string) => string;
  /** The connections that live elsewhere and how to read each; one not given is not drawn. */
  readonly elsewhere: readonly ElsewhereSource[];
  /**
   * Where providers send their updates, where the install takes public requests: its public
   * address, and the secret capabilities are made with.
   */
  readonly webhooks: { readonly publicUrl: string; readonly secret: string } | undefined;
  /** People's names, as the reader may see them. */
  readonly people: (
    trx: DatabaseTransaction,
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
}

export const CHECK_TASK = 'integrations.check';
export const REVOKE_TASK = 'integrations.revoke';

/** Queues the worker's check of a connection, one waiting at a time. */
export async function queueIntegrationCheck(
  trx: DatabaseTransaction,
  connectionId: string,
): Promise<void> {
  await sql`select private.enqueue_integration_job(${CHECK_TASK}, ${JSON.stringify({ connectionId })}::jsonb, ${`integration-check:${connectionId}`}, null)`.execute(
    trx,
  );
}

const holds = (grants: Grants, permission: Permission): boolean =>
  grants === 'all' || grants.has(permission);

/** Connecting hands the business's account to this install: only a person may do it. */
function personOf(context: TenantContext): string {
  if (context.actorKind !== 'user' || context.userId === undefined)
    throw new ForbiddenError('Only a person can connect an integration.');
  return context.userId;
}

const unavailable = (name: string) =>
  new ValidationError([
    {
      path: '',
      code: 'integration_unavailable',
      message: `This install isn't set up to connect ${name}.`,
    },
  ]);

function providerOf(options: IntegrationOptions, key: string): IntegrationProvider {
  const provider = options.providers.find((each) => each.key === key);
  if (provider === undefined) throw new NotFoundError('Integration', key);
  return provider;
}

const columns = [
  'id',
  'provider',
  'account_label',
  'status',
  'error_code',
  'error_detail',
  'is_primary',
  'connected_by',
  'connected_at',
  'last_ok_at',
  'last_error_at',
  'settings',
  'revision',
  'secret_id',
  'webhook_digest',
] as const;

interface ConnectionRow {
  readonly id: string;
  readonly provider: string;
  readonly account_label: string | null;
  readonly status: string;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly is_primary: boolean;
  readonly connected_by: string | null;
  readonly connected_at: Date;
  readonly last_ok_at: Date | null;
  readonly last_error_at: Date | null;
  readonly settings: unknown;
  readonly revision: number;
  readonly secret_id: string | null;
  readonly webhook_digest: string | null;
}

/** A connection's webhook address, where it has one and the install takes public requests. */
function webhookUrlOf(options: IntegrationOptions, row: ConnectionRow): string | null {
  if (row.webhook_digest === null || options.webhooks === undefined) return null;
  const { publicUrl, secret } = options.webhooks;
  return `${publicUrl}/webhooks/integrations/${row.provider}/${webhookToken(secret, row.id)}`;
}

function viewOf(
  options: IntegrationOptions,
  row: ConnectionRow,
  names: ReadonlyMap<string, string>,
): IntegrationConnection {
  return {
    id: toPublicId('integration_connection', row.id),
    accountLabel: row.account_label,
    status: row.status as IntegrationConnection['status'],
    errorCode: row.error_code as IntegrationErrorCode | null,
    errorDetail: row.error_detail,
    primary: row.is_primary,
    connectedBy: row.connected_by === null ? null : (names.get(row.connected_by) ?? null),
    connectedAt: row.connected_at.toISOString(),
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
    settings: row.settings as Record<string, unknown>,
    webhookUrl: webhookUrlOf(options, row),
    revision: row.revision,
  };
}

/** The live connections of the business, primary first, then oldest first. */
async function liveRows(trx: DatabaseTransaction, businessId: string): Promise<ConnectionRow[]> {
  return trx
    .selectFrom('integrations.connections')
    .select(columns)
    .where('business_id', '=', businessId)
    .where('status', '<>', 'disconnected')
    .orderBy('is_primary', 'desc')
    .orderBy('connected_at')
    .orderBy('id')
    .execute();
}

async function viewsOf(
  options: IntegrationOptions,
  trx: DatabaseTransaction,
  rows: readonly ConnectionRow[],
): Promise<IntegrationConnection[]> {
  const people = [
    ...new Set(rows.flatMap((row) => (row.connected_by === null ? [] : [row.connected_by]))),
  ];
  const names = await options.people(trx, people);
  return rows.map((row) => viewOf(options, row, names));
}

/** One connection's view, with its connector's name. */
async function viewOne(
  options: IntegrationOptions,
  trx: DatabaseTransaction,
  row: ConnectionRow,
): Promise<IntegrationConnection> {
  const names = await options.people(trx, row.connected_by === null ? [] : [row.connected_by]);
  return viewOf(options, row, names);
}

function providerEntry(
  options: IntegrationOptions,
  provider: IntegrationProvider,
  connections: readonly IntegrationConnection[],
  canManage: boolean,
): IntegrationEntry {
  const reading = readingOf(
    connections.map((each) => ({ status: each.status, label: each.accountLabel })),
  );
  const available = options.vault !== undefined && providerReady(provider);
  return {
    key: provider.key,
    name: provider.name,
    description: provider.description,
    category: provider.category,
    auth: provider.auth,
    available,
    operatorGuide: provider.operatorGuide,
    multipleAccounts: provider.multipleAccounts,
    page: null,
    mayManage: canManage && available,
    state: stateOf(
      reading,
      connections.some((each) => each.status === 'connecting'),
    ),
    connected: reading.connected,
    attention: reading.attention,
    label: reading.label,
    connections: [...connections],
  };
}

async function elsewhereEntries(
  options: IntegrationOptions,
  trx: DatabaseTransaction,
  businessId: string,
  grants: Grants,
): Promise<IntegrationEntry[]> {
  const entries: IntegrationEntry[] = [];
  for (const integration of elsewhereIntegrations) {
    const source = options.elsewhere.find((each) => each.key === integration.key);
    if (source === undefined) continue;
    const reading = source.available
      ? await source.read(trx, businessId)
      : { connected: 0, attention: 0, label: null };
    entries.push({
      key: integration.key,
      name: integration.name,
      description: integration.description,
      category: integration.category,
      auth: 'elsewhere',
      available: source.available,
      operatorGuide: integration.operatorGuide,
      multipleAccounts: true,
      page: integration.page,
      mayManage: source.available && holds(grants, integration.permission),
      state: stateOf(reading),
      connected: reading.connected,
      attention: reading.attention,
      label: reading.label,
      connections: [],
    });
  }
  return entries;
}

async function readList(
  options: IntegrationOptions,
  services: Services,
  invocation: Invocation,
): Promise<{ entries: IntegrationEntry[]; canManage: boolean }> {
  const businessId = requireBusiness(invocation.context);
  const canManage = holds(invocation.permissions, 'integrations.manage');
  return withTenant(services.db, invocation.context, async (trx) => {
    const rows = await liveRows(trx, businessId);
    const views = await viewsOf(options, trx, rows);
    const own = options.providers.map((provider) =>
      providerEntry(
        options,
        provider,
        views.filter((_view, index) => rows[index]?.provider === provider.key),
        canManage,
      ),
    );
    const elsewhere = await elsewhereEntries(options, trx, businessId, invocation.permissions);
    return { entries: [...elsewhere, ...own], canManage };
  });
}

const activityColumns = ['connection_id', 'at', 'kind', 'error_code', 'detail'] as const;

function activityView(row: {
  connection_id: string;
  at: Date;
  kind: string;
  error_code: string | null;
  detail: string | null;
}): IntegrationActivity {
  return {
    connectionId: toPublicId('integration_connection', row.connection_id),
    at: row.at.toISOString(),
    kind: row.kind as IntegrationActivity['kind'],
    errorCode: row.error_code as IntegrationErrorCode | null,
    detail: row.detail,
  };
}

async function readOne(
  options: IntegrationOptions,
  services: Services,
  invocation: Invocation,
  key: string,
) {
  const list = await readList(options, services, invocation);
  const entry = list.entries.find((each) => each.key === key);
  if (entry === undefined) throw new NotFoundError('Integration', key);
  const businessId = requireBusiness(invocation.context);
  const ids = entry.connections
    .map((each) => parsePublicId('integration_connection', each.id))
    .filter((id): id is string => id !== undefined);
  const activity =
    ids.length === 0
      ? []
      : await withTenant(services.db, invocation.context, (trx) =>
          trx
            .selectFrom('integrations.activity')
            .select(activityColumns)
            .where('business_id', '=', businessId)
            .where('connection_id', 'in', ids)
            .orderBy('at', 'desc')
            .orderBy('id', 'desc')
            .limit(INTEGRATION_LIMITS.recentActivity)
            .execute(),
        );
  return { entry, activity: activity.map(activityView) };
}

/** A connection of the provider in the command's business, locked for the change. */
async function lockConnection(
  trx: DatabaseTransaction,
  businessId: string,
  provider: string,
  publicId: string,
): Promise<ConnectionRow> {
  const id = parsePublicId('integration_connection', publicId);
  const row =
    id === undefined
      ? undefined
      : await trx
          .selectFrom('integrations.connections')
          .select(columns)
          .where('business_id', '=', businessId)
          .where('id', '=', id)
          .where('provider', '=', provider)
          .where('status', '<>', 'disconnected')
          .forUpdate()
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Integration connection', publicId);
  return row;
}

async function addActivity(
  trx: DatabaseTransaction,
  businessId: string,
  connectionId: string,
  kind: IntegrationActivity['kind'],
  detail: string | null = null,
  errorCode: IntegrationErrorCode | null = null,
): Promise<void> {
  await trx
    .insertInto('integrations.activity')
    .values({
      business_id: businessId,
      connection_id: connectionId,
      kind,
      detail,
      error_code: errorCode,
    })
    .execute();
}

/** Whether the provider has a live primary account in the business already. */
async function hasPrimary(
  trx: DatabaseTransaction,
  businessId: string,
  provider: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('integrations.connections')
    .select('id')
    .where('business_id', '=', businessId)
    .where('provider', '=', provider)
    .where('is_primary', '=', true)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Keeps sealed credentials as a new connection, connecting until the worker has read the
 * account, and queues that reading. The first account of a provider is its primary one.
 */
async function keepConnection(
  options: IntegrationOptions,
  vault: SealingVault,
  trx: DatabaseTransaction,
  command: CommandContext,
  provider: IntegrationProvider,
  credentials: SealedCredentials,
  scopes: readonly string[],
): Promise<ConnectionRow> {
  const businessId = requireBusiness(command.context);
  const userId = personOf(command.context);
  const secretId = await vault.store(
    trx,
    { agencyId: command.context.agencyId, businessId, purpose: credentialsPurpose(provider.key) },
    JSON.stringify(credentials),
  );
  const primary = !(await hasPrimary(trx, businessId, provider.key));
  const row = await trx
    .insertInto('integrations.connections')
    .values({
      business_id: businessId,
      provider: provider.key,
      secret_id: secretId,
      scopes_granted: [...scopes],
      is_primary: primary,
      connected_by: userId,
    })
    .returning(columns)
    .executeTakeFirstOrThrow();
  // A provider that sends updates gets an address of this connection's own.
  const connection =
    provider.auth === 'oauth2' && provider.webhook !== undefined && options.webhooks !== undefined
      ? await trx
          .updateTable('integrations.connections')
          .set({ webhook_digest: sha256Hex(webhookToken(options.webhooks.secret, row.id)) })
          .where('business_id', '=', businessId)
          .where('id', '=', row.id)
          .returning(columns)
          .executeTakeFirstOrThrow()
      : row;
  await addActivity(trx, businessId, row.id, 'connected');
  await command.emit({
    type: 'integration.connected',
    subject: { kind: 'integration_connection', id: row.id },
    payload: { provider: provider.key },
  });
  await queueIntegrationCheck(trx, row.id);
  return connection;
}

const connectCommandInput = connectIntegrationInput.extend({ key: z.string() });

/**
 * Starts a connection. With the provider's sign-in: a single-use state for ten minutes, and
 * the consent address. With a key: the key sealed at once, and the connection checked.
 */
export function connectIntegrationCommand(
  options: IntegrationOptions,
): Command<typeof connectCommandInput, IntegrationConnectStarted> {
  return defineCommand({
    name: 'integration.connect',
    permission: 'integrations.manage',
    input: connectCommandInput,
    // The key itself is never kept in the audit log.
    audit: ({ key }) => ({ key }),
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const userId = personOf(command.context);
      const provider = providerOf(options, input.key);
      const { vault } = options;
      if (vault === undefined) throw unavailable(provider.name);
      if (provider.auth === 'api_key') {
        if (input.apiKey === undefined)
          throw new ValidationError([
            { path: '/apiKey', code: 'required', message: 'Paste the key.' },
          ]);
        const row = await keepConnection(
          options,
          vault,
          trx,
          command,
          provider,
          { kind: 'api_key', apiKey: input.apiKey },
          [],
        );
        const names = await options.people(trx, [userId]);
        return { authorizeUrl: null, connection: viewOf(options, row, names) };
      }
      if (input.apiKey !== undefined)
        throw new ValidationError([
          {
            path: '/apiKey',
            code: 'not_a_key_integration',
            message: `${provider.name} is connected by signing in to it, not with a key.`,
          },
        ]);
      // Until the operator sets its app up, an OAuth provider cannot be connected.
      const { client } = provider;
      if (client === undefined) throw unavailable(provider.name);
      const state = randomBytes(32).toString('base64url');
      const attempt = await trx
        .insertInto('integrations.connect_attempts')
        .values({
          business_id: businessId,
          provider: provider.key,
          user_id: userId,
          state_digest: sha256(state),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'integration.connect_started',
        subject: { kind: 'user', id: userId },
        payload: { provider: provider.key, attemptId: attempt.id },
      });
      return {
        authorizeUrl: authorizationUrl(
          provider.endpoints,
          { ...client, redirectUri: options.redirectUri(provider.key) },
          {
            state,
            scopes: provider.scopes,
            ...(provider.pkce
              ? { codeChallenge: codeChallengeOf(codeVerifierOf(client.clientSecret, state)) }
              : {}),
          },
        ),
        connection: null,
      };
    },
  });
}

const completeInput = z.strictObject({
  key: z.string(),
  attemptId: z.uuid(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  scopes: z.array(z.string()),
});

/**
 * Keeps what the provider gave at the callback, as the person who started it: the tokens
 * sealed at once, the attempt spent, the account's reading queued. The audit log keeps the
 * provider's key, never a token.
 */
export function completeIntegrationConnectCommand(
  options: IntegrationOptions,
): Command<typeof completeInput, { connectionId: string }> {
  return defineCommand({
    name: 'integration.complete_connect',
    permission: 'integrations.manage',
    input: completeInput,
    audit: ({ key }) => ({ key }),
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const provider = providerOf(options, input.key);
      const { vault } = options;
      if (vault === undefined) throw unavailable(provider.name);
      const row = await keepConnection(
        options,
        vault,
        trx,
        command,
        provider,
        {
          kind: 'oauth2',
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAt,
        },
        input.scopes,
      );
      await trx
        .deleteFrom('integrations.connect_attempts')
        .where('business_id', '=', businessId)
        .where('id', '=', input.attemptId)
        .execute();
      return { connectionId: row.id };
    },
  });
}

const updateInput = updateIntegrationConnectionInput.extend({
  key: z.string(),
  id: z.string(),
});

/** Makes a connection the primary one, or changes its options, at the revision it was read. */
export function updateIntegrationConnectionCommand(
  options: IntegrationOptions,
): Command<typeof updateInput, IntegrationConnection> {
  return defineCommand({
    name: 'integration.update',
    permission: 'integrations.manage',
    input: updateInput,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const provider = providerOf(options, input.key);
      const row = await lockConnection(trx, businessId, provider.key, input.id);
      if (row.revision !== input.revision)
        throw new ConflictError(
          'This connection changed since you opened it. Open it again to see what changed.',
        );
      // No provider has options of its own yet: anything given is refused, nothing is kept.
      if (input.settings !== undefined && Object.keys(input.settings).length > 0)
        throw new ValidationError([
          {
            path: '/settings',
            code: 'no_settings',
            message: `${provider.name} has no options to change.`,
          },
        ]);
      if (input.primary === true && !row.is_primary) {
        await trx
          .updateTable('integrations.connections')
          .set({ is_primary: false })
          .where('business_id', '=', businessId)
          .where('provider', '=', provider.key)
          .where('is_primary', '=', true)
          .execute();
      }
      const updated = await trx
        .updateTable('integrations.connections')
        .set({
          is_primary: input.primary === true ? true : row.is_primary,
          revision: row.revision + 1,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', row.id)
        .returning(columns)
        .executeTakeFirstOrThrow();
      await addActivity(
        trx,
        businessId,
        row.id,
        'settings_changed',
        input.primary === true ? 'Made the primary account.' : null,
      );
      await command.emit({
        type: 'integration.settings_changed',
        subject: { kind: 'integration_connection', id: row.id },
        payload: { provider: provider.key, primary: updated.is_primary },
      });
      return viewOne(options, trx, updated);
    },
  });
}

const connectionInput = z.strictObject({ key: z.string(), id: z.string() });

/** Queues a check of a connection now; its answer shows in the activity. */
export function testIntegrationConnectionCommand(
  options: IntegrationOptions,
): Command<typeof connectionInput, IntegrationConnection> {
  return defineCommand({
    name: 'integration.test',
    permission: 'integrations.manage',
    input: connectionInput,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const provider = providerOf(options, input.key);
      const row = await lockConnection(trx, businessId, provider.key, input.id);
      await queueIntegrationCheck(trx, row.id);
      await command.emit({
        type: 'integration.test_requested',
        subject: { kind: 'integration_connection', id: row.id },
        payload: { provider: provider.key },
      });
      return viewOne(options, trx, row);
    },
  });
}

/**
 * Marks a connection disconnected and queues revoking its credentials at the provider and
 * removing them from the vault. Another live account of the provider becomes primary.
 */
export function disconnectIntegrationCommand(
  options: IntegrationOptions,
): Command<typeof connectionInput, undefined> {
  return defineCommand({
    name: 'integration.disconnect',
    permission: 'integrations.manage',
    input: connectionInput,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const provider = providerOf(options, input.key);
      const row = await lockConnection(trx, businessId, provider.key, input.id);
      await trx
        .updateTable('integrations.connections')
        .set({
          status: 'disconnected',
          disconnected_reason: 'user',
          disconnected_at: sql<Date>`now()`,
          is_primary: false,
          error_code: null,
          error_detail: null,
          revision: row.revision + 1,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', row.id)
        .execute();
      if (row.is_primary) {
        await sql`update integrations.connections set is_primary = true
          where business_id = ${businessId} and id = (
            select id from integrations.connections
            where business_id = ${businessId} and provider = ${provider.key}
              and status <> 'disconnected'
            order by connected_at, id limit 1)`.execute(trx);
      }
      await addActivity(trx, businessId, row.id, 'disconnected');
      await command.emit({
        type: 'integration.disconnected',
        subject: { kind: 'integration_connection', id: row.id },
        payload: { provider: provider.key, reason: 'user' },
      });
      await sql`select private.enqueue_integration_job(${REVOKE_TASK}, ${JSON.stringify({ connectionId: row.id })}::jsonb, ${`integration-revoke:${row.id}`}, null)`.execute(
        trx,
      );
      return undefined;
    },
  });
}

async function readActivityPage(
  options: IntegrationOptions,
  services: Services,
  invocation: Invocation,
  params: z.output<typeof integrationConnectionParams>,
  query: z.output<typeof integrationActivityQuery>,
) {
  const businessId = requireBusiness(invocation.context);
  providerOf(options, params.provider);
  const id = parsePublicId('integration_connection', params.id);
  return withTenant(services.db, invocation.context, async (trx) => {
    const found =
      id === undefined
        ? undefined
        : await trx
            .selectFrom('integrations.connections')
            .select('id')
            .where('business_id', '=', businessId)
            .where('id', '=', id)
            .where('provider', '=', params.provider)
            .executeTakeFirst();
    if (found === undefined) throw new NotFoundError('Integration connection', params.id);
    let rows = trx
      .selectFrom('integrations.activity')
      .select(activityColumns)
      .where('business_id', '=', businessId)
      .where('connection_id', '=', found.id);
    if (query.before !== undefined) rows = rows.where('at', '<', new Date(query.before));
    const page = await rows
      .orderBy('at', 'desc')
      .orderBy('id', 'desc')
      .limit(INTEGRATION_LIMITS.activityPage + 1)
      .execute();
    const items = page.slice(0, INTEGRATION_LIMITS.activityPage);
    return {
      items: items.map(activityView),
      next:
        page.length > INTEGRATION_LIMITS.activityPage
          ? (items.at(-1)?.at.toISOString() ?? null)
          : null,
    };
  });
}

/** A connection's address, as the commands name it: its provider's key and its id. */
function connectionParams(params: unknown): { key: string; id: string } {
  const parsed = parseInput(integrationConnectionParams, params);
  return { key: parsed.provider, id: parsed.id };
}

/** Settings → Integrations. Reading is open to every member; changing needs the permission. */
export function createIntegrationRoutes(options: IntegrationOptions): readonly ApiRoute[] {
  const connect = connectIntegrationCommand(options);
  const update = updateIntegrationConnectionCommand(options);
  const test = testIntegrationConnectionCommand(options);
  const disconnect = disconnectIntegrationCommand(options);
  return [
    {
      endpoint: listIntegrations,
      run: ({ invocation }, services) => readList(options, services, invocation),
    },
    {
      endpoint: getIntegration,
      run: ({ invocation, params }, services) =>
        readOne(options, services, invocation, parseInput(integrationParams, params).provider),
    },
    {
      endpoint: connectIntegration,
      command: connect,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          connect,
          {
            ...parseInput(connectIntegrationInput, body ?? {}),
            key: parseInput(integrationParams, params).provider,
          },
          invocation,
        ),
    },
    {
      endpoint: updateIntegrationConnection,
      command: update,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          update,
          {
            ...parseInput(updateIntegrationConnectionInput, body),
            ...connectionParams(params),
          },
          invocation,
        ),
    },
    {
      endpoint: testIntegrationConnection,
      command: test,
      run: ({ invocation, params }, services) =>
        runCommand(services, test, connectionParams(params), invocation),
    },
    {
      endpoint: disconnectIntegration,
      command: disconnect,
      run: ({ invocation, params }, services) =>
        runCommand(services, disconnect, connectionParams(params), invocation),
    },
    {
      endpoint: listIntegrationActivity,
      run: ({ invocation, params, query }, services) =>
        readActivityPage(
          options,
          services,
          invocation,
          parseInput(integrationConnectionParams, params),
          parseInput(integrationActivityQuery, query),
        ),
    },
  ];
}
