// The rows of ai.provider_keys a request may see and change (connections.ts,
// connection-tests.ts). Row-level security shows the agency every business's rows, and a
// business its agency's: who may use a row, and who may change it, is decided here.
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, NotFoundError, parsePublicId, type TenantContext } from '@repo/kernel';

export const columns = [
  'id',
  'business_id',
  'provider',
  'base_url',
  'default_model',
  'secret_id',
  'key_last4',
  'status',
  'last_tested_at',
  'last_test_latency_ms',
  'last_test_outcome',
  'created_by_id',
  'created_at',
] as const;

export interface ConnectionRow {
  readonly id: string;
  readonly business_id: string | null;
  readonly provider: string;
  readonly base_url: string | null;
  readonly default_model: string | null;
  readonly secret_id: string | null;
  readonly key_last4: string | null;
  readonly status: string;
  readonly last_tested_at: Date | null;
  readonly last_test_latency_ms: number | null;
  readonly last_test_outcome: string | null;
  readonly created_by_id: string | null;
  readonly created_at: Date;
}

/** The connections a request may use, whoever owns them. */
function visible(trx: DatabaseTransaction, context: TenantContext) {
  const { businessId } = context;
  return trx
    .selectFrom('ai.provider_keys')
    .select(columns)
    .where('agency_id', '=', context.agencyId)
    .where((eb) =>
      businessId === undefined
        ? eb('business_id', 'is', null)
        : eb.or([eb('business_id', 'is', null), eb('business_id', '=', businessId)]),
    );
}

/** Every connection a request may use, oldest first. */
export function visibleConnections(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<ConnectionRow[]> {
  return visible(trx, context).orderBy('created_at').orderBy('id').execute();
}

/** The connection of a provider in the very place the request works, if there is one. */
export function connectionHere(
  trx: DatabaseTransaction,
  context: TenantContext,
  provider: string,
): Promise<ConnectionRow | undefined> {
  const { businessId } = context;
  return visible(trx, context)
    .where('provider', '=', provider)
    .where((eb) =>
      businessId === undefined ? eb('business_id', 'is', null) : eb('business_id', '=', businessId),
    )
    .executeTakeFirst();
}

/** A connection the request may use, by its public id, or a 404. */
export async function visibleConnection(
  trx: DatabaseTransaction,
  context: TenantContext,
  publicId: string,
): Promise<ConnectionRow> {
  const id = parsePublicId('ai_connection', publicId);
  const row =
    id === undefined
      ? undefined
      : await visible(trx, context).where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('AI connection', publicId);
  return row;
}

/** A connection the request may change, locked, or the reason it may not. */
export async function ownConnection(
  trx: DatabaseTransaction,
  context: TenantContext,
  publicId: string,
): Promise<ConnectionRow> {
  const id = parsePublicId('ai_connection', publicId);
  const row =
    id === undefined
      ? undefined
      : await visible(trx, context).where('id', '=', id).forUpdate().executeTakeFirst();
  if (row === undefined) throw new NotFoundError('AI connection', publicId);
  if (row.business_id !== (context.businessId ?? null))
    throw new ForbiddenError(
      'This connection is the agency’s. It is changed in the agency’s own settings.',
    );
  return row;
}
