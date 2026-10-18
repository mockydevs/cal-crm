// Deals in bulk for the board's and the dashboard's budget: written in one statement as
// crm_owner, as an import of history would write them.
import { toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';

export interface SeededPipeline {
  readonly pipelineId: string;
  readonly stageIds: readonly string[];
}

/**
 * Writes one pipeline of six stages and `count` deals into the business. Deal n is in stage
 * n mod 6; six in ten are open, two won and two lost; one in ten is in US dollars; it was
 * created 5 minutes before deal n - 1, so 100,000 of them span about 347 days, and a closed
 * one closed a minute after it was created. The database dates each status itself (0057).
 */
export async function seedDeals(
  database: TestDatabase,
  businessId: string,
  count: number,
): Promise<SeededPipeline> {
  const seeded = await database.as('crm_owner', async (sql) => {
    const pipeline = await sql.one<{ id: string }>(
      `insert into crm.pipelines (business_id, name) values ($1, 'Seeded sales') returning id`,
      [businessId],
    );
    const stages = await sql.query<{ id: string; position: number }>(
      `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
       select $1, $2, 'Stage ' || n, n from generate_series(0, 5) as n
       returning id, position`,
      [businessId, pipeline.id],
    );
    await sql.query(
      `with numbered as (
         select n, uuidv7() as id from generate_series(1, $3::int) as n
       ), stages as (
         select id, position from crm.pipeline_stages where business_id = $1 and pipeline_id = $2
       ), records as (
         insert into crm.records (business_id, id, kind, object_type_id)
         select $1, numbered.id, 'deal', types.id
         from numbered, crm.object_types types
         where types.business_id = $1 and types.kind = 'deal'
       )
       insert into crm.deals (business_id, id, name, pipeline_id, stage_id, status, amount,
                              currency, closed_at, created_by_kind, created_at)
       select $1, numbered.id, 'Deal ' || n, $2, stages.id,
              case when n % 10 < 6 then 'open' when n % 10 < 8 then 'won' else 'lost' end,
              (n % 1000) + 0.25,
              case when n % 10 = 3 then 'USD' else 'KES' end,
              case when n % 10 < 6 then null
                   else now() - n * interval '5 minutes' + interval '1 minute' end,
              'import', now() - n * interval '5 minutes'
       from numbered join stages on stages.position = n % 6`,
      [businessId, pipeline.id, count],
    );
    return { pipeline, stages };
  });
  await database.as('crm_owner', (sql) => sql.query('analyze crm.deals, crm.records'));
  return {
    pipelineId: toPublicId('pipeline', seeded.pipeline.id),
    stageIds: seeded.stages
      .toSorted((left, right) => left.position - right.position)
      .map((stage) => toPublicId('stage', stage.id)),
  };
}
