// The AI module's part in a contact merge (crm contacts/merge.ts): what the assistant
// remembers of the contact merged away is the contact kept's, and nothing it proposed for
// the merged contact can be applied to it afterwards.
//
// - Facts move. Two contacts' facts may say the same thing; the memory rules settle that on
//   the next extraction, as they do for any repeated fact.
// - The summary: the kept contact's stays; when it has none, the merged contact's is the
//   only one there is and moves. Nothing in the product rebuilds summaries yet, so neither
//   is thrown away for a rebuild that would never come.
// - Extractions move (those of a conversation that ended in the merge went with it).
// - An autonomy rule for the contact: the kept contact's own wins, else the merged one's
//   moves.
// - Proposals: a pending one about the merged contact, or naming it anywhere in what it
//   would run, expires (its input names a contact that is gone). A decided one stays with
//   the contact it was about: what a proposal is about never changes (0010's guard), and the
//   kept contact's timeline has its copy of what happened.
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import {
  countContactRows,
  moveContactRows,
  type ContactMergeParticipant,
  type MergeCounts,
} from '@repo/module-crm';

const plainRows = {
  facts: { table: 'ai.contact_facts', column: 'contact_id' },
  extractions: { table: 'ai.extractions', column: 'contact_id' },
} as const;

const counted = {
  ...plainRows,
  summaries: { table: 'ai.contact_summaries', column: 'contact_id' },
  autonomyRules: { table: 'ai.autonomy_rules', column: 'contact_id' },
} as const;

const affected = (result: { numUpdatedRows: bigint }): number => Number(result.numUpdatedRows);

async function mergeMemory(
  trx: DatabaseTransaction,
  command: CommandContext,
  move: { readonly from: string; readonly into: string },
): Promise<MergeCounts> {
  const businessId = requireBusiness(command.context);
  const { from, into } = move;
  const summaries = affected(
    await trx
      .updateTable('ai.contact_summaries')
      .set({ contact_id: into })
      .where('business_id', '=', businessId)
      .where('contact_id', '=', from)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('ai.contact_summaries as kept')
              .select('kept.contact_id')
              .where('kept.business_id', '=', businessId)
              .where('kept.contact_id', '=', into),
          ),
        ),
      )
      .executeTakeFirst(),
  );
  await trx
    .deleteFrom('ai.contact_summaries')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', from)
    .execute();
  await trx
    .deleteFrom('ai.autonomy_rules as merged')
    .where('merged.business_id', '=', businessId)
    .where('merged.contact_id', '=', from)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('ai.autonomy_rules as kept')
          .select('kept.id')
          .whereRef('kept.business_id', '=', 'merged.business_id')
          .whereRef('kept.agent', '=', 'merged.agent')
          .whereRef('kept.action', '=', 'merged.action')
          .where('kept.contact_id', '=', into),
      ),
    )
    .execute();
  const autonomyRules = affected(
    await trx
      .updateTable('ai.autonomy_rules')
      .set({ contact_id: into })
      .where('business_id', '=', businessId)
      .where('contact_id', '=', from)
      .executeTakeFirst(),
  );
  // Inputs keep contact ids as text: the public id as the API takes it, or the database id.
  // Neither can appear by chance: both are long and unique.
  const named = [toPublicId('contact', from), from];
  const proposalsExpired = affected(
    await trx
      .updateTable('ai.proposals')
      .set((eb) => ({
        status: 'expired',
        decided_at: eb.fn<Date>('now', []),
        decided_by_kind: 'system',
        decided_by_id: null,
      }))
      .where('business_id', '=', businessId)
      .where('status', '=', 'pending')
      .where((eb) =>
        eb.or([
          eb('record_id', '=', from),
          ...named.flatMap((name) => [
            eb(eb.cast('command', 'text'), 'like', `%${name}%`),
            eb(eb.cast('basis', 'text'), 'like', `%${name}%`),
          ]),
        ]),
      )
      .executeTakeFirst(),
  );
  return {
    summaries,
    autonomyRules,
    proposalsExpired,
    ...(await moveContactRows(trx, businessId, plainRows, move)),
  };
}

/** The AI module's part in a contact merge, wired by the server into crm's merge. */
export const aiContactMerge: ContactMergeParticipant = {
  name: 'ai',
  count: (trx, invocation, contactIds, atMost) =>
    countContactRows(trx, requireBusiness(invocation.context), counted, contactIds, atMost),
  merge: mergeMemory,
};
