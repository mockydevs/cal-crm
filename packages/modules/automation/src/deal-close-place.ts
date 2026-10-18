// A deal closing says where the deal stood: its pipeline and stage ride on deal.won and
// deal.lost (crm deals.ts and bulk.ts), which is what a "deal closed" trigger's pipeline
// filter reads. Events recorded before they carried it hold only the reason. For those the
// place is read from the deal as it is now: a closed deal is seldom moved, and a filter that
// could never pass (as it did not, until 2026-10-13) is worse than one that reads today's.
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';

type Payload = Readonly<Record<string, unknown>>;

export async function withDealClosePlace(
  trx: DatabaseTransaction,
  event: { readonly type: string; readonly subject_kind: string; readonly subject_id: string },
  payload: Payload,
): Promise<Payload> {
  if (
    (event.type !== 'deal.won' && event.type !== 'deal.lost') ||
    event.subject_kind !== 'deal' ||
    'pipelineId' in payload
  )
    return payload;
  const deal = await trx
    .selectFrom('crm.deals')
    .select(['pipeline_id', 'stage_id'])
    .where('id', '=', event.subject_id)
    .executeTakeFirst();
  return deal === undefined
    ? payload
    : {
        ...payload,
        pipelineId: toPublicId('pipeline', deal.pipeline_id),
        stageId: toPublicId('stage', deal.stage_id),
      };
}
