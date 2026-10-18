import { createHash } from 'node:crypto';
import { defineProposable, type Proposable } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';
import { readPipelines, requireConfigurationRevision, savePipelinesCommand } from './pipelines.js';

async function fingerprint(trx: DatabaseTransaction): Promise<string> {
  const pipelines = await trx
    .selectFrom('crm.pipelines')
    .selectAll()
    .where('business_id', '=', sql<string>`app.business_id()`)
    .orderBy('id')
    .execute();
  const stages = await trx
    .selectFrom('crm.pipeline_stages')
    .selectAll()
    .where('business_id', '=', sql<string>`app.business_id()`)
    .orderBy('id')
    .execute();
  return createHash('sha256')
    .update(JSON.stringify([pipelines, stages]))
    .digest('hex');
}

export function createPipelineProposables(): readonly Proposable[] {
  return [
    defineProposable({
      kind: 'pipeline_save',
      command: savePipelinesCommand,
      action: 'publish',
      agents: ['copilot'],
      subject: () => Promise.resolve({}),
      revision: fingerprint,
      async present(trx, input, invocation) {
        requireConfigurationRevision(await readPipelines(trx, invocation), input.revision);
        return {
          kind: 'crm_change',
          operationId: 'savePipelines',
          name: 'Pipelines and stages',
          details: { pipelineCount: input.items.length, pipelines: input.items },
        };
      },
      capture: () => Promise.resolve(undefined),
      result: (output) => ({
        pipelines: output.items.map((item) => ({ id: item.id, name: item.name })),
        revision: output.revision,
      }),
      undo: () => ({ impossible: 'live_configuration' }),
    }),
  ];
}
