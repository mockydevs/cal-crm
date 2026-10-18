import { createHash } from 'node:crypto';
import { defineProposable, type Proposable } from '@repo/commands';
import type { Deal } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { readPipelines } from '../pipelines/pipelines.js';
import { readDeal, updateDealCommand } from './deals.js';

/** What an edit sets, in the order a card lists the changes. */
const EDITABLE = [
  'name',
  'pipelineId',
  'stageId',
  'amount',
  'currency',
  'expectedCloseDate',
  'status',
  'outcomeReason',
  'source',
  'probability',
] as const;

/** The deal as it is saved: anyone changing it since makes the proposal stale. */
async function fingerprint(trx: DatabaseTransaction, id: string): Promise<string> {
  const uuid = parsePublicId('deal', id);
  if (uuid === undefined) throw new NotFoundError('Deal', id);
  const row = await trx
    .selectFrom('crm.deals')
    .selectAll()
    .where('business_id', '=', sql<string>`app.business_id()`)
    .where('id', '=', uuid)
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Deal', id);
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

const editOf = (before: Deal) =>
  Object.fromEntries(EDITABLE.map((key) => [key, before[key] ?? null]));

/** What the deal holds before the edit, as an edit would set it: what undoing it sets back. */
async function savedEdit(trx: DatabaseTransaction, id: string): Promise<Record<string, unknown>> {
  const uuid = parsePublicId('deal', id);
  if (uuid === undefined) throw new NotFoundError('Deal', id);
  const row = await trx
    .selectFrom('crm.deals')
    .select([
      'name',
      'pipeline_id',
      'stage_id',
      'amount',
      'currency',
      'status',
      'won_note',
      'lost_note',
      'source',
      'win_probability',
    ])
    .select(sql<string | null>`expected_close_date::text`.as('close_date'))
    .where('business_id', '=', sql<string>`app.business_id()`)
    .where('id', '=', uuid)
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Deal', id);
  return {
    name: row.name,
    pipelineId: toPublicId('pipeline', row.pipeline_id),
    stageId: toPublicId('stage', row.stage_id),
    amount: row.amount,
    currency: row.currency,
    expectedCloseDate: row.close_date,
    status: row.status,
    outcomeReason: row.status === 'won' ? row.won_note : row.lost_note,
    source: row.source,
    probability:
      row.win_probability === null ? null : Math.round(Number(row.win_probability) * 100),
  };
}

export function createDealProposables(): readonly Proposable[] {
  return [
    defineProposable({
      kind: 'deal_update',
      command: updateDealCommand,
      // A deal's stage or outcome is live: workflows start on it. The in-app assistant
      // proposes it, and a person applies it, as it does every live change.
      action: 'publish',
      agents: ['copilot'],
      // The deal is a record of its own: the card is about it.
      subject: (_trx, input) => {
        const recordId = parsePublicId('deal', input.id);
        return Promise.resolve(recordId === undefined ? {} : { recordId });
      },
      revision: (trx, input) => fingerprint(trx, input.id),
      async present(trx, input, invocation) {
        const before = await readDeal(trx, invocation, input.id);
        if (before.revision !== input.revision)
          throw new ConflictError('This deal changed. Read it again before proposing changes.');
        const pipeline = (await readPipelines(trx, invocation)).items.find(
          (each) => each.id === input.pipelineId,
        );
        const stage = pipeline?.stages.find((each) => each.id === input.stageId);
        if (pipeline === undefined || stage === undefined)
          throw new NotFoundError('Stage', input.stageId);
        const was = editOf(before);
        // Only what the edit changes: left out, the source and probability stay as they are.
        const changes = Object.fromEntries(
          EDITABLE.flatMap((key) =>
            input[key] === undefined || input[key] === was[key]
              ? []
              : [[key, { from: was[key], to: input[key] }]],
          ),
        );
        return {
          kind: 'crm_change',
          operationId: 'updateDeal',
          name: before.name,
          moved: before.stageId !== input.stageId || before.pipelineId !== input.pipelineId,
          stageName: stage.name,
          details: {
            deal: before.name,
            pipeline: pipeline.name,
            stage: stage.name,
            fromStage: before.stageName,
            changes,
          },
        };
      },
      capture: (trx, input) => savedEdit(trx, input.id),
      result: (output) => ({ dealId: output.id, stageName: output.stageName }),
      // Back to the deal as it was, made on the deal as the command left it: if someone
      // changes it again first, the command refuses the undo.
      undo: (before, output) => ({
        kind: 'deal_update',
        input: { ...before, id: output.id, revision: output.revision },
      }),
    }),
  ];
}
