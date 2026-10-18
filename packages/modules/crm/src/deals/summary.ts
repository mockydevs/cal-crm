// What the board's column headers show: how many deals each stage of a pipeline holds and
// what they add up to, counted by the server over the same filters the cards are paged with
// (keptDeals), so a header never disagrees with its column.
import { requireBusiness, type Invocation } from '@repo/commands';
import type { DealStageSummary, dealStageSummaryQuery } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import type * as z from 'zod';

import { keptDeals } from './deals.js';

type Totals = DealStageSummary['totals'];

/** Sums by currency, in the order of their codes. Different currencies are never added. */
function totalsOf(rows: readonly { currency: string; amount: string }[]): Totals {
  return rows
    .map(({ currency, amount }) => ({ currency, amount }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

export async function readDealStageSummary(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof dealStageSummaryQuery>,
): Promise<DealStageSummary> {
  const businessId = requireBusiness(invocation.context);
  const pipelineId = parsePublicId('pipeline', query.pipelineId);
  // Loaded under row-level security first: another business's pipeline is not one to count.
  const stages =
    pipelineId === undefined
      ? []
      : await trx
          .selectFrom('crm.pipeline_stages')
          .select(['id', 'name', 'archived_at'])
          .where('business_id', '=', businessId)
          .where('pipeline_id', '=', pipelineId)
          .orderBy('position')
          .orderBy('id')
          .execute();
  const pipeline =
    pipelineId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.pipelines')
          .select('id')
          .where('business_id', '=', businessId)
          .where('id', '=', pipelineId)
          .executeTakeFirst();
  if (pipeline === undefined)
    throw new ValidationError([
      {
        path: '/pipelineId',
        code: 'unknown_pipeline',
        message: 'Choose a pipeline in this business.',
      },
    ]);

  const { conditions } = await keptDeals(trx, businessId, query);
  // One pass over the pipeline's deals the filters keep. The sums stay PostgreSQL's exact
  // decimals, as text: a JavaScript number would round them.
  const { rows } = await sql<{
    stage_id: string | null;
    currency: string;
    count: number;
    amount: string;
  }>`
    select d.stage_id, d.currency, count(*)::integer as count,
           coalesce(sum(d.amount), 0)::numeric(38, 4)::text as amount
    from crm.deals d
    where d.business_id = ${businessId} and ${conditions}
    group by grouping sets ((d.stage_id, d.currency), (d.currency))
  `.execute(trx);

  const whole = rows.filter((row) => row.stage_id === null);
  const byStage = Map.groupBy(
    rows.filter((row) => row.stage_id !== null),
    (row) => row.stage_id,
  );
  const count = (of: readonly { count: number }[]) =>
    of.reduce((total, row) => total + row.count, 0);
  return {
    pipelineId: query.pipelineId,
    count: count(whole),
    totals: totalsOf(whole),
    stages: stages.flatMap((stage) => {
      const held = byStage.get(stage.id) ?? [];
      // An archived stage is a column only while a deal is still in it.
      if (stage.archived_at !== null && held.length === 0) return [];
      return [
        {
          stageId: toPublicId('stage', stage.id),
          name: stage.name,
          archived: stage.archived_at !== null,
          count: count(held),
          totals: totalsOf(held),
        },
      ];
    }),
  };
}
