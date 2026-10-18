import type { DatabaseTransaction } from '@repo/db';
import { listCalendarSenders, parseInput, type CalendarSenderChoices } from '@repo/contracts';
import { requireBusiness } from '@repo/commands';
import { NotFoundError, parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import * as z from 'zod';

function eligibleSenders(trx: DatabaseTransaction, context: TenantContext) {
  return trx
    .selectFrom('messaging.channel_accounts as a')
    .innerJoin('messaging.mailboxes as m', (join) =>
      join.onRef('m.business_id', '=', 'a.business_id').onRef('m.id', '=', 'a.id'),
    )
    .where('a.business_id', '=', requireBusiness(context))
    .where('a.channel', '=', 'email')
    .where('a.status', '=', 'active')
    .where('m.use_for_conversations', '=', true);
}

export async function readCalendarSenderChoices(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: { readonly after?: string | undefined; readonly limit: number },
): Promise<CalendarSenderChoices> {
  const { after, limit } = parseInput(listCalendarSenders.query, input);
  let query = eligibleSenders(trx, context)
    .select(['a.id', 'a.name', 'm.email_address'])
    .orderBy('a.id');
  if (after !== undefined) {
    const id = parsePublicId('mailbox', after);
    if (id === undefined) throw new NotFoundError('Calendar sender', 'unavailable');
    query = query.where('a.id', '>', id);
  }
  const found = await query.limit(limit + 1).execute();
  const rows = found.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      id: toPublicId('mailbox', row.id),
      name: row.name,
      email: row.email_address,
    })),
    nextCursor: found.length > limit && last !== undefined ? toPublicId('mailbox', last.id) : null,
  };
}

export async function readEligibleCalendarSenders(
  trx: DatabaseTransaction,
  context: TenantContext,
  accountIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const ids = parseInput(z.array(z.uuid()).max(50), accountIds);
  if (ids.length === 0) return new Set();
  const rows = await eligibleSenders(trx, context)
    .select('a.id')
    .where('a.id', 'in', ids)
    .execute();
  return new Set(rows.map((row) => row.id));
}

/** Call after the owning booking command locks its active business. No credentials return. */
export async function resolveCalendarSender(
  trx: DatabaseTransaction,
  context: TenantContext,
  mailboxId: string,
): Promise<string> {
  const id = parsePublicId('mailbox', mailboxId);
  if (id === undefined) throw new NotFoundError('Calendar sender', 'unavailable');
  const row = await eligibleSenders(trx, context)
    .select('a.id')
    .where('a.id', '=', id)
    .forShare(['a', 'm'])
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Calendar sender', 'unavailable');
  return row.id;
}
