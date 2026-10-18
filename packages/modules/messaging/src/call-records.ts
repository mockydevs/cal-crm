// Reading the call ledger: a page of the business's calls, newest first, and one call with
// its legs. Members are named by their membership in this business, and only while they are
// on its team; provider credentials never appear here.
import type { Call, CallDetail, CallList, ListCallsQuery } from '@repo/contracts';
import { call, callDetail, callList, listCallsQuery } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  NotFoundError,
  parsePublicId,
  toPublicId,
  type PublicIdKind,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';

/** The membership a user has in the context's business now, as a SQL scalar. */
const membershipOf = (userId: ReturnType<typeof sql.ref>) =>
  sql<string | null>`(select m.id from tenancy.memberships m
    join auth.users u on u.id=m.user_id
    where m.business_id=app.business_id() and m.user_id=${userId} and u.disabled_at is null
    limit 1)`;

const callColumns = (trx: DatabaseTransaction) =>
  trx
    .selectFrom('messaging.calls as c')
    .select([
      'c.id',
      'c.direction',
      'c.state',
      'c.outcome',
      'c.failure_code',
      'c.phone_number_id',
      'c.local_e164',
      'c.remote_e164',
      'c.contact_id',
      'c.contact_identity_id',
      'c.needs_reconciliation',
      'c.hangup_requested_at',
      'c.created_at',
      'c.connected_at',
      'c.ended_at',
      membershipOf(sql.ref('c.user_id')).as('membership_id'),
    ]);

type CallRow = Awaited<ReturnType<ReturnType<typeof callColumns>['executeTakeFirstOrThrow']>>;

/**
 * The UUID a public id names. Contracts validate ids before they arrive here, so a miss
 * means a value that names nothing in this business: not found.
 */
export function uuidOf(kind: PublicIdKind, value: string): string {
  const id = parsePublicId(kind, value);
  if (id === undefined) throw new NotFoundError(kind.replaceAll('_', ' '), value);
  return id;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toCall(row: CallRow): Call {
  return call.parse({
    id: toPublicId('call', row.id),
    direction: row.direction,
    state: row.state,
    outcome: row.outcome,
    failure: row.failure_code,
    phoneNumberId:
      row.phone_number_id === null ? null : toPublicId('phone_number', row.phone_number_id),
    localNumber: row.local_e164,
    remoteNumber: row.remote_e164,
    contactId: row.contact_id === null ? null : toPublicId('contact', row.contact_id),
    contactIdentityId:
      row.contact_identity_id === null
        ? null
        : toPublicId('contact_identity', row.contact_identity_id),
    membershipId: row.membership_id === null ? null : toPublicId('membership', row.membership_id),
    needsReconciliation: row.needs_reconciliation,
    hangUpRequested: row.hangup_requested_at !== null,
    createdAt: row.created_at.toISOString(),
    connectedAt: iso(row.connected_at),
    endedAt: iso(row.ended_at),
  });
}

/** One call as the API shows it, by its stored id; the caller knows it exists. */
export async function readCallRecord(trx: DatabaseTransaction, id: string): Promise<Call> {
  return toCall(await callColumns(trx).where('c.id', '=', id).executeTakeFirstOrThrow());
}

export async function listCallRecords(
  trx: DatabaseTransaction,
  _context: TenantContext,
  query: ListCallsQuery,
): Promise<CallList> {
  const { after, limit, contactId, direction } = listCallsQuery.parse(query);
  let rows = callColumns(trx);
  if (after !== undefined) rows = rows.where('c.id', '<', uuidOf('call', after));
  if (contactId !== undefined) rows = rows.where('c.contact_id', '=', uuidOf('contact', contactId));
  if (direction !== undefined) rows = rows.where('c.direction', '=', direction);
  const found = await rows
    .orderBy('c.id', 'desc')
    .limit(limit + 1)
    .execute();
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return callList.parse({
    items: page.map(toCall),
    nextCursor: found.length > limit && last !== undefined ? toPublicId('call', last.id) : null,
  });
}

export async function readCallDetail(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<CallDetail> {
  const row = await callColumns(trx)
    .where('c.id', '=', uuidOf('call', publicId))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('call', publicId);
  const legs = await trx
    .selectFrom('messaging.call_legs as l')
    .select([
      'l.id',
      'l.parent_leg_id',
      'l.party',
      'l.status',
      'l.provider_direction',
      'l.provider_call_sid',
      'l.duration_seconds',
      'l.conflict_at',
      'l.answered_at',
      'l.ended_at',
      membershipOf(sql.ref('l.user_id')).as('membership_id'),
    ])
    .where('l.call_id', '=', row.id)
    .orderBy('l.id')
    .limit(100)
    .execute();
  return callDetail.parse({
    ...toCall(row),
    legs: legs.map((leg) => ({
      id: toPublicId('call_leg', leg.id),
      parentId: leg.parent_leg_id === null ? null : toPublicId('call_leg', leg.parent_leg_id),
      party: leg.party,
      membershipId: leg.membership_id === null ? null : toPublicId('membership', leg.membership_id),
      status: leg.status,
      providerDirection: leg.provider_direction,
      providerCallId: leg.provider_call_sid,
      durationSeconds: leg.duration_seconds,
      conflict: leg.conflict_at !== null,
      answeredAt: iso(leg.answered_at),
      endedAt: iso(leg.ended_at),
    })),
  });
}
