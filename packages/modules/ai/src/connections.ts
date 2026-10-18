// Settings → AI models: the providers a business or its agency has connected.
//
// A key is written once and never read back here. The app's vault can only seal: it stores
// the key for the purpose `ai.provider_key`, the row keeps the id of the sealed secret and
// the key's last four characters, and only the worker's gateway opens it. So "Test" is a
// row the app writes and a job the worker runs (connection-tests.ts).
//
// A connection is managed where it is owned: a business's own in that business, the
// agency's at the agency. A business sees its agency's connections, because its calls may
// use them, but not their address, their key's ending or who added them.
import { defineCommand, type Command, type CommandContext } from '@repo/commands';
import {
  connectAiProviderInput,
  removeAiConnection,
  updateAiConnectionCommandInput,
  type AiConnection,
  type AiConnectionSaved,
  type AiProviderKey,
  type AiTestOutcome,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';

import { checkBaseUrl, type LocalServer, type ServerUrlProblem } from './addresses.js';
import {
  columns,
  connectionHere,
  ownConnection,
  visibleConnections,
  type ConnectionRow,
} from './connection-rows.js';
import { startTest } from './connection-tests.js';
import { AI_KEY_PURPOSE } from './gateway.js';

/** The part of the app's vault Settings needs: sealing a key, and destroying one. */
export interface SecretSealer {
  store(
    trx: DatabaseTransaction,
    owner: {
      readonly agencyId: string;
      readonly businessId: string | null;
      readonly purpose: string;
    },
    plaintext: string,
  ): Promise<string>;
  remove(trx: DatabaseTransaction, secretId: string): Promise<void>;
}

/** People's names, by id, as far as the reader may see them (the auth module's lookup). */
export type PeopleNames = (
  trx: DatabaseTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

export interface ConnectionOptions {
  readonly vault: SecretSealer;
  /** AI_LOCAL_SERVERS: the model servers of the install's own. Never shown. */
  readonly localServers: readonly LocalServer[];
  readonly now: () => Date;
}

const PROVIDERS: readonly AiProviderKey[] = ['anthropic', 'openai', 'openai_compatible'];
export const isConnectable = (provider: string): provider is AiProviderKey =>
  (PROVIDERS as readonly string[]).includes(provider);

/** As the row's own check has it: four of the characters a key is written in. */
const LAST4 = /^[A-Za-z0-9_-]{4}$/;
/** The last four characters of a key, to tell keys apart; nothing for a key too odd or short. */
function last4(apiKey: string): string | null {
  const end = apiKey.slice(-4);
  // A short key would be shown nearly whole.
  return apiKey.length >= 12 && LAST4.test(end) ? end : null;
}

/** What a refused address is told, in the server's words for a program or a log. */
const ADDRESS_PROBLEMS: Readonly<Record<ServerUrlProblem, string>> = {
  not_a_url: 'This is not a web address. It should look like https://models.example.com/v1.',
  not_https:
    'This install may call an address that starts with https://, or a model server that whoever runs the install has listed.',
  has_credentials:
    'Leave the user name and password out of the address. A key goes in its own field.',
  port_not_allowed:
    'This install may call the standard https port, or a model server that whoever runs the install has listed.',
  has_query: 'Leave out everything after the path: no ? and no #.',
};
const OPERATOR_STEP =
  'For a model server of your own, ask whoever runs this install to add its host and port to AI_LOCAL_SERVERS, then save the address again with the same host and port.';

/**
 * The address as it is stored, or the refusal. Which servers the operator listed is never
 * said: the answer is the same sentence whatever the list holds.
 */
function checkedAddress(value: string, localServers: readonly LocalServer[]): string {
  const checked = checkBaseUrl(value, localServers);
  if (checked.ok) return checked.url.href.replace(/\/+$/, '');
  const operator = checked.reason === 'not_https' || checked.reason === 'port_not_allowed';
  throw new ValidationError([
    {
      path: '/baseUrl',
      code: `address_${checked.reason}`,
      message: ADDRESS_PROBLEMS[checked.reason],
      ...(operator ? { suggestion: OPERATOR_STEP } : {}),
    },
  ]);
}

const refused = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

/** The scheme, host and port of an address someone typed, for the audit log: never more. */
function originOf(value: string | undefined): string | null {
  if (value === undefined || !URL.canParse(value)) return null;
  const { origin } = new URL(value);
  return origin === 'null' ? null : origin;
}

function asConnection(
  row: ConnectionRow,
  context: TenantContext,
  names: ReadonlyMap<string, string>,
): AiConnection | undefined {
  if (!isConnectable(row.provider)) return undefined;
  // Managed where it is owned; elsewhere only what choosing a model needs.
  const mine = row.business_id === (context.businessId ?? null);
  return {
    id: toPublicId('ai_connection', row.id),
    provider: row.provider,
    owner: row.business_id === null ? 'agency' : 'business',
    canManage: mine,
    hasKey: row.secret_id !== null,
    keyLast4: mine ? row.key_last4 : null,
    baseUrl: mine ? row.base_url : null,
    model: row.default_model,
    status: row.status === 'working' || row.status === 'failing' ? row.status : 'untested',
    lastTest:
      row.last_tested_at === null || row.last_test_outcome === null
        ? null
        : {
            // The column's check keeps it to the outcomes the contract lists.
            outcome: row.last_test_outcome as AiTestOutcome,
            at: row.last_tested_at.toISOString(),
            latencyMs: row.last_test_latency_ms,
          },
    addedBy: mine && row.created_by_id !== null ? (names.get(row.created_by_id) ?? null) : null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * In a business: its own connections, then its agency's. At the agency: the agency's.
 * Row-level security alone would show the agency every business's.
 */
export async function readAiConnections(
  trx: DatabaseTransaction,
  context: TenantContext,
  people: PeopleNames,
): Promise<AiConnection[]> {
  const rows = await visibleConnections(trx, context);
  const mine = rows.filter((row) => row.business_id === (context.businessId ?? null));
  const adders = mine.flatMap((row) => row.created_by_id ?? []);
  const names = adders.length === 0 ? new Map<string, string>() : await people(trx, adders);
  return [...mine, ...rows.filter((row) => !mine.includes(row))].flatMap(
    (row) => asConnection(row, context, names) ?? [],
  );
}

async function saved(
  trx: DatabaseTransaction,
  command: CommandContext,
  row: ConnectionRow,
  people: PeopleNames,
  now: () => Date,
): Promise<AiConnectionSaved> {
  const { context } = command;
  const names =
    row.created_by_id === null ? new Map<string, string>() : await people(trx, [row.created_by_id]);
  const connection = asConnection(row, context, names);
  if (connection === undefined)
    throw new Error('A saved connection has a provider nobody can use.');
  return { connection, test: await startTest(trx, command, row.id, now) };
}

const ALREADY = 'This provider is already connected here. Replace its key instead.';

export function createConnectionCommands(
  options: ConnectionOptions,
  people: PeopleNames,
): {
  readonly connect: Command<typeof connectAiProviderInput, AiConnectionSaved>;
  readonly update: Command<typeof updateAiConnectionCommandInput, AiConnectionSaved>;
  readonly remove: Command<typeof removeAiConnection.params, undefined>;
} {
  const { vault, localServers, now } = options;

  const connect = defineCommand({
    name: 'ai.connect_provider',
    permission: 'ai.manage',
    input: connectAiProviderInput,
    // Never the key; of an address, the origin only, since a refused one is recorded too.
    audit: (input) => ({
      provider: input.provider,
      ...('model' in input ? { model: input.model } : {}),
      ...('baseUrl' in input ? { address: originOf(input.baseUrl) } : {}),
    }),
    async handle(trx, input, command): Promise<AiConnectionSaved> {
      const { context } = command;
      const businessId = context.businessId ?? null;
      const baseUrl =
        input.provider === 'openai_compatible' ? checkedAddress(input.baseUrl, localServers) : null;
      const existing = await connectionHere(trx, context, input.provider);
      if (existing !== undefined) throw new ConflictError(ALREADY);
      const secretId =
        input.apiKey === undefined
          ? null
          : await vault.store(
              trx,
              { agencyId: context.agencyId, businessId, purpose: AI_KEY_PURPOSE },
              input.apiKey,
            );
      const row = await trx
        .insertInto('ai.provider_keys')
        .values({
          agency_id: context.agencyId,
          business_id: businessId,
          provider: input.provider,
          base_url: baseUrl,
          default_model: 'model' in input ? input.model : null,
          secret_id: secretId,
          key_last4: input.apiKey === undefined ? null : last4(input.apiKey),
          created_by_id: context.userId ?? null,
        })
        .returning(columns)
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({ provider_keys_label_unique: () => new ConflictError(ALREADY) }),
        );
      await command.emit({
        type: 'ai_connection.connected',
        subject: { kind: 'ai_connection', id: row.id },
        payload: { provider: input.provider, owner: businessId === null ? 'agency' : 'business' },
      });
      return saved(trx, command, row, people, now);
    },
  });

  const update = defineCommand({
    name: 'ai.update_connection',
    permission: 'ai.manage',
    input: updateAiConnectionCommandInput,
    audit: ({ id, changes }) => ({
      id,
      key: changes.apiKey === undefined ? 'kept' : changes.apiKey === null ? 'removed' : 'replaced',
      ...(changes.model === undefined ? {} : { model: changes.model }),
      ...(changes.baseUrl === undefined ? {} : { address: originOf(changes.baseUrl) }),
    }),
    async handle(trx, { id, changes }, command): Promise<AiConnectionSaved> {
      const { context } = command;
      const row = await ownConnection(trx, context, id);
      const own = row.provider === 'openai_compatible';
      if (changes.baseUrl !== undefined && !own)
        throw refused(
          '/baseUrl',
          'not_for_provider',
          'Only a model server of your own has an address. This provider’s is fixed.',
        );
      if (changes.apiKey === null && !own)
        throw refused('/apiKey', 'key_required', 'This provider needs a key.');
      if (changes.model !== undefined && row.provider === 'anthropic')
        throw refused(
          '/model',
          'not_for_provider',
          'Claude’s models are chosen for each job, not on the connection.',
        );
      const baseUrl =
        changes.baseUrl === undefined
          ? row.base_url
          : checkedAddress(changes.baseUrl, localServers);
      const secretId =
        changes.apiKey === undefined
          ? row.secret_id
          : changes.apiKey === null
            ? null
            : await vault.store(
                trx,
                {
                  agencyId: context.agencyId,
                  businessId: row.business_id,
                  purpose: AI_KEY_PURPOSE,
                },
                changes.apiKey,
              );
      const next = await trx
        .updateTable('ai.provider_keys')
        .set({
          base_url: baseUrl,
          default_model: changes.model ?? row.default_model,
          secret_id: secretId,
          key_last4:
            changes.apiKey === undefined
              ? row.key_last4
              : changes.apiKey === null
                ? null
                : last4(changes.apiKey),
          // What was known of the old key, address or model says nothing of the new.
          status: 'untested',
          last_tested_at: null,
          last_test_latency_ms: null,
          last_test_outcome: null,
        })
        .where('id', '=', row.id)
        .returning(columns)
        .executeTakeFirstOrThrow();
      // The row no longer names the old key, so it can go.
      if (changes.apiKey !== undefined && row.secret_id !== null)
        await vault.remove(trx, row.secret_id);
      await command.emit({
        type: 'ai_connection.updated',
        subject: { kind: 'ai_connection', id: row.id },
        payload: {
          provider: row.provider,
          changed: [
            ...(changes.apiKey === undefined ? [] : ['key']),
            ...(changes.baseUrl === undefined ? [] : ['address']),
            ...(changes.model === undefined ? [] : ['model']),
          ],
        },
      });
      return saved(trx, command, next, people, now);
    },
  });

  const remove = defineCommand({
    name: 'ai.remove_connection',
    permission: 'ai.manage',
    input: removeAiConnection.params,
    async handle(trx, { id }, command): Promise<undefined> {
      const row = await ownConnection(trx, command.context, id);
      // Its tests go with it; then nothing names the key, and the key is destroyed.
      await trx.deleteFrom('ai.provider_keys').where('id', '=', row.id).execute();
      if (row.secret_id !== null) await vault.remove(trx, row.secret_id);
      await command.emit({
        type: 'ai_connection.removed',
        subject: { kind: 'ai_connection', id: row.id },
        payload: {
          provider: row.provider,
          owner: row.business_id === null ? 'agency' : 'business',
        },
      });
      return undefined;
    },
  });

  return { connect, update, remove };
}
