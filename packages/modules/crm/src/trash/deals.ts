// Deals into the trash and back: as contacts and companies go. A deal in the trash leaves
// the board and can't be changed until it's restored.
import { defineCommand, requireBusiness, type CommandContext } from '@repo/commands';
import { dealIdInput, type Deal } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { readDeal } from '../deals/deals.js';

/** Moves the deal into or out of the trash, if it isn't there already, and says so. */
async function setTrashed(
  trx: DatabaseTransaction,
  id: string,
  command: CommandContext,
  trashed: boolean,
): Promise<Deal> {
  const businessId = requireBusiness(command.context);
  const uuid = parsePublicId('deal', id);
  if (uuid === undefined) throw new NotFoundError('Deal', id);
  const row = await trx
    .selectFrom('crm.deals')
    .select(['id', 'deleted_at'])
    .where('business_id', '=', businessId)
    .where('id', '=', uuid)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Deal', id);
  if ((row.deleted_at !== null) !== trashed) {
    await trx
      .updateTable('crm.deals')
      .set({ deleted_at: trashed ? sql<Date>`now()` : null })
      .where('business_id', '=', businessId)
      .where('id', '=', row.id)
      .execute();
    await command.emit({
      type: trashed ? 'deal.trashed' : 'deal.restored',
      subject: { kind: 'deal', id: row.id },
      records: [row.id],
    });
  }
  return readDeal(trx, command, id);
}

export const trashDealCommand = defineCommand({
  name: 'deal.trash',
  permission: 'deals.manage',
  input: dealIdInput,
  handle: (trx, input, command) => setTrashed(trx, input.id, command, true),
});

export const restoreDealCommand = defineCommand({
  name: 'deal.restore',
  permission: 'deals.manage',
  input: dealIdInput,
  handle: (trx, input, command) => setTrashed(trx, input.id, command, false),
});
