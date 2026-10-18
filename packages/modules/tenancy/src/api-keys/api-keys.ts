// API keys: made in a business for an app, shown once, kept only as a hash. The
// auth module finds them when a request signs in with one.
import { createHash, randomBytes } from 'node:crypto';

import { defineCommand, type Command, type Grants } from '@repo/commands';
import {
  API_KEY_PREFIX_LENGTH,
  agencyApiKeyScopes,
  apiKeyReadGroups,
  apiKeyScopes,
  createApiKeyInput,
  revokeApiKey,
  type ApiKey,
  type CreatedApiKey,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { sql, type NotNull } from 'kysely';
import { readAgencyKeyGrants } from '../grants.js';

/** People's names, by id, as far as the reader may see them (the auth module's lookup). */
export type PeopleNames = (
  trx: DatabaseTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

const hashOf = (key: string) => createHash('sha256').update(key).digest();

const columns = [
  'id',
  'name',
  'key_prefix',
  'scopes',
  'created_at',
  'created_by_user_id',
  'last_used_at',
  'business_id',
  'read_only',
  'read_groups',
  'expires_at',
] as const;

interface ApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly key_prefix: string;
  readonly scopes: string[];
  readonly created_at: Date;
  readonly created_by_user_id: string | null;
  readonly last_used_at: Date | null;
  readonly business_id: string | null;
  readonly read_only: boolean;
  readonly read_groups: string[] | null;
  readonly expires_at: Date | null;
}

/** The names of the people who made these keys. */
async function makersOf(
  trx: DatabaseTransaction,
  rows: readonly ApiKeyRow[],
  people: PeopleNames,
): Promise<ReadonlyMap<string, string>> {
  const makers = rows.flatMap((row) => row.created_by_user_id ?? []);
  return makers.length === 0 ? new Map() : people(trx, makers);
}

function asApiKey(row: ApiKeyRow, makers: ReadonlyMap<string, string>): ApiKey {
  return {
    id: toPublicId('api_key', row.id),
    name: row.name,
    prefix: row.key_prefix,
    scopes: row.scopes,
    createdAt: row.created_at.toISOString(),
    createdBy:
      row.created_by_user_id === null ? null : (makers.get(row.created_by_user_id) ?? null),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    ...(row.business_id === null ||
    row.read_only ||
    row.read_groups !== null ||
    row.expires_at !== null
      ? {
          scope: row.business_id === null ? ('agency' as const) : ('business' as const),
          readOnly: row.read_only,
          readGroups:
            row.read_groups === null
              ? null
              : apiKeyReadGroups.filter((group) => row.read_groups?.includes(group)),
          expiresAt: row.expires_at?.toISOString() ?? null,
        }
      : {}),
  };
}

function requireKeyManager(context: TenantContext): void {
  if (context.actorKind === 'api_key')
    throw new ForbiddenError('Only a person or the system can manage API keys.');
}

export async function keyDelegationGrants(
  trx: DatabaseTransaction,
  context: TenantContext,
  permissions: Grants,
): Promise<Grants> {
  if (context.businessId !== undefined) return permissions;
  if (context.userId !== undefined) {
    const actual = await readAgencyKeyGrants(trx, context, context.userId);
    if (actual === undefined)
      throw new ForbiddenError('An agency role is required to create an agency key.');
    return actual;
  }
  if (context.actorKind === 'system' && permissions === 'all') return 'all';
  throw new ForbiddenError('An agency role is required to create an agency key.');
}

/**
 * Makes a key in the business: shown once, in what this returns, and kept only as its
 * hash and its start. A key gets only permissions its maker has.
 */
export function createApiKeyCommand(
  people: PeopleNames,
): Command<typeof createApiKeyInput, CreatedApiKey> {
  return defineCommand({
    name: 'api_key.create',
    permission: 'apps.manage',
    input: createApiKeyInput,
    async handle(trx, input, command) {
      const { context, permissions } = command;
      requireKeyManager(context);
      const businessId = context.businessId ?? null;
      const allowed = businessId === null ? agencyApiKeyScopes : apiKeyScopes;
      if (input.scopes.some((scope) => !allowed.includes(scope)))
        throw new ValidationError([
          {
            path: '/scopes',
            code: 'wrong_scope',
            message: 'Choose permissions available in this account scope.',
          },
        ]);
      const grants = await keyDelegationGrants(trx, context, permissions);
      if (grants !== 'all' && !grants.has('apps.manage'))
        throw new ForbiddenError('Your role no longer allows managing API keys.', 'apps.manage');
      const missing = grants === 'all' ? [] : input.scopes.filter((scope) => !grants.has(scope));
      if (missing.length > 0) {
        throw new ValidationError([
          {
            path: '/scopes',
            code: 'not_yours',
            message: `You can give a key only permissions you have, and you don't have ${missing.join(', ')}.`,
          },
        ]);
      }
      const key = `crm_live_${randomBytes(32).toString('hex')}`;
      const row = await trx
        .insertInto('tenancy.api_keys')
        .values({
          agency_id: context.agencyId,
          business_id: businessId,
          name: input.name,
          key_prefix: key.slice(0, API_KEY_PREFIX_LENGTH),
          key_hash: hashOf(key),
          scopes: [...input.scopes],
          read_only: input.readOnly ?? false,
          read_groups:
            input.readGroups === undefined || input.readGroups === null
              ? null
              : [...input.readGroups],
          expires_at:
            input.expiresAt === undefined || input.expiresAt === null
              ? null
              : new Date(input.expiresAt),
          created_by_user_id: context.userId ?? null,
        })
        .returning(columns)
        .$narrowType<{ key_prefix: NotNull }>()
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'api_key.created',
        subject: { kind: 'api_key', id: row.id },
        payload: { name: row.name, prefix: row.key_prefix, scopes: row.scopes },
      });
      return { ...asApiKey(row, await makersOf(trx, [row], people)), key };
    },
  });
}

/**
 * Revokes a key of the business. Its next request fails. An installed app's key isn't one
 * of these: uninstalling the app revokes it.
 */
export const revokeApiKeyCommand = defineCommand({
  name: 'api_key.revoke',
  permission: 'apps.manage',
  input: revokeApiKey.params,
  async handle(trx, input, command) {
    requireKeyManager(command.context);
    const businessId = command.context.businessId;
    const row = await trx
      .updateTable('tenancy.api_keys')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', parsePublicId('api_key', input.id) ?? '')
      .where('business_id', businessId === undefined ? 'is' : '=', businessId ?? null)
      .where('marketplace_install_id', 'is', null)
      .where('revoked_at', 'is', null)
      .returning(['id', 'name', 'key_prefix'])
      .executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundError('API key', input.id);
    }
    await command.emit({
      type: 'api_key.revoked',
      subject: { kind: 'api_key', id: row.id },
      payload: { name: row.name, prefix: row.key_prefix },
    });
    return undefined;
  },
});

/** The business's keys that still work, newest first; installed apps' keys aren't listed. */
export async function readApiKeys(
  trx: DatabaseTransaction,
  businessId: string | undefined,
  people: PeopleNames,
): Promise<ApiKey[]> {
  // Exactly the business's: row-level security also shows the agency's own keys here.
  const rows = await trx
    .selectFrom('tenancy.api_keys')
    .select(columns)
    .where('business_id', businessId === undefined ? 'is' : '=', businessId ?? null)
    .where('marketplace_install_id', 'is', null)
    .where('revoked_at', 'is', null)
    .$narrowType<{ key_prefix: NotNull }>()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const makers = await makersOf(trx, rows, people);
  return rows.map((row) => asApiKey(row, makers));
}

/** Keys' names, by id, revoked ones too: how activity names a key that acted. */
export async function readApiKeyNames(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await trx
    .selectFrom('tenancy.api_keys')
    .select(['id', 'name'])
    .where('id', '=', sql<string>`any(${[...ids]}::uuid[])`)
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}
