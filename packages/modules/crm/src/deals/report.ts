// The numbers of the Dashboard's opportunity widgets for one pipeline over a range of
// dates. One pass over the pipeline's deals dated in the range, read from an index on the
// pipeline and that date (0057), grouped by stage, status and currency; the widgets are
// worked out from those groups (report-rules.ts). Nothing is stored: rollups for trends and
// longer histories are separate.
import { requireBusiness, type Invocation } from '@repo/commands';
import type { OpportunityReport, opportunityReportQuery } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { opportunityWidgets, type DealGroup } from './report-rules.js';

const dealStatus = z.enum(['open', 'won', 'lost']);

export async function readOpportunityReport(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof opportunityReportQuery>,
): Promise<OpportunityReport> {
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

  // Each date has its own index (deals_status_changed_idx, deals_created_idx): the range is
  // read from it, and deals outside the range are never touched.
  const dated = query.dateProperty === 'created' ? sql`d.created_at` : sql`d.status_changed_at`;
  // The range's ends go to PostgreSQL as written: a JavaScript Date would cut them to the
  // millisecond, and a deal dated inside that millisecond would fall on the wrong side.
  // The sums stay PostgreSQL's exact decimals, as text: a JavaScript number would round them.
  const { rows } = await sql<{
    stage_id: string;
    status: string;
    currency: string;
    count: number;
    amount: string;
  }>`
    select d.stage_id, d.status, d.currency, count(*)::integer as count,
           coalesce(sum(d.amount), 0)::numeric(38, 4)::text as amount
    from crm.deals d
    where d.business_id = ${businessId} and d.pipeline_id = ${pipeline.id}
      and d.deleted_at is null
      and ${dated} >= ${query.from}::timestamptz and ${dated} < ${query.to}::timestamptz
    group by d.stage_id, d.status, d.currency
  `.execute(trx);

  const groups: DealGroup[] = rows.map((row) => ({
    stageId: toPublicId('stage', row.stage_id),
    // The table's own constraint allows nothing else (deals_status_valid).
    status: dealStatus.parse(row.status),
    currency: row.currency,
    count: row.count,
    amount: row.amount,
  }));
  return {
    pipelineId: query.pipelineId,
    from: query.from,
    to: query.to,
    dateProperty: query.dateProperty,
    ...opportunityWidgets(
      stages.map((stage) => ({
        id: toPublicId('stage', stage.id),
        name: stage.name,
        archived: stage.archived_at !== null,
      })),
      groups,
    ),
  };
}
