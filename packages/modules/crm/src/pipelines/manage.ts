// One pipeline moved, copied or deleted by itself, as the Pipelines page's row menu does.
// Each is made from the configuration's revision, under the lock every configuration writer
// takes, so it never overwrites a change it has not seen.
import { defineCommand, requireBusiness } from '@repo/commands';
import {
  deletePipelineCommandInput,
  duplicatePipelineCommandInput,
  movePipelineCommandInput,
  type Pipeline,
  type PipelineConfiguration,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';

import {
  lockConfiguration,
  readPipelines,
  requireConfigurationRevision,
  storedProbability,
} from './pipelines.js';

/** The longest name a pipeline has (crm.pipelines.pipelines_name_length). */
const NAME_MAX = 80;
/** The most pipelines a business has, as a whole save allows. */
const MAX_PIPELINES = 100;

/** The pipeline a request names, in the configuration just read under the lock. */
function found(current: PipelineConfiguration, id: string): { item: Pipeline; index: number } {
  const index = current.items.findIndex((item) => item.id === id);
  const item = current.items[index];
  if (item === undefined) throw new NotFoundError('Pipeline', id);
  return { item, index };
}

/** Writes each pipeline's place as its index in this order. Only a place that differs is written. */
async function reposition(
  trx: DatabaseTransaction,
  businessId: string,
  order: readonly string[],
): Promise<void> {
  const stored = await trx
    .selectFrom('crm.pipelines')
    .select(['id', 'position'])
    .where('business_id', '=', businessId)
    .execute();
  const places = new Map(stored.map((row) => [row.id, row.position]));
  for (const [position, id] of order.entries()) {
    const pipelineId = parsePublicId('pipeline', id) ?? '';
    if (places.get(pipelineId) === position) continue;
    await trx
      .updateTable('crm.pipelines')
      .set({ position })
      .where('business_id', '=', businessId)
      .where('id', '=', pipelineId)
      .execute();
  }
}

export const movePipelineCommand = defineCommand({
  name: 'pipeline.move',
  permission: 'pipelines.manage',
  input: movePipelineCommandInput,
  async handle(trx, input, command): Promise<PipelineConfiguration> {
    const businessId = await lockConfiguration(trx, command);
    const current = await readPipelines(trx, command);
    const { index } = found(current, input.id);
    requireConfigurationRevision(current, input.revision);
    const before = current.items.map((item) => item.id);
    const after = before.filter((id) => id !== input.id);
    const to = Math.min(input.position, before.length) - 1;
    after.splice(to, 0, input.id);
    if (to === index) return current;
    await reposition(trx, businessId, after);
    await command.emit({
      type: 'pipeline.moved',
      subject: { kind: 'business', id: businessId },
      payload: { pipelineId: input.id, from: index + 1, to: to + 1 },
    });
    return readPipelines(trx, command);
  },
});

/** The name with "(copy)", then "(copy 2)" and on, cut so that it fits, and not taken. */
function copyName(name: string, taken: ReadonlySet<string>): string {
  for (let number = 1; number <= MAX_PIPELINES + 1; number += 1) {
    const suffix = number === 1 ? ' (copy)' : ` (copy ${String(number)})`;
    const candidate = `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new ConflictError('Give the copy a name of its own.');
}

export const duplicatePipelineCommand = defineCommand({
  name: 'pipeline.duplicate',
  permission: 'pipelines.manage',
  input: duplicatePipelineCommandInput,
  async handle(trx, input, command): Promise<PipelineConfiguration> {
    const businessId = await lockConfiguration(trx, command);
    const current = await readPipelines(trx, command);
    const { item, index } = found(current, input.id);
    requireConfigurationRevision(current, input.revision);
    if (current.items.length >= MAX_PIPELINES)
      throw new ValidationError([
        {
          path: '/id',
          code: 'too_many_pipelines',
          message: `A business has at most ${String(MAX_PIPELINES)} pipelines.`,
        },
      ]);
    const taken = new Set(
      current.items.filter((each) => !each.archived).map((each) => each.name.trim().toLowerCase()),
    );
    const copy = await trx
      .insertInto('crm.pipelines')
      .values({
        business_id: businessId,
        name: input.name ?? copyName(item.name, taken),
        description: item.description,
        // Placed by reposition below; past the end until then.
        position: current.items.length,
        deal_probability: item.dealProbability ?? false,
        color_style: item.colorStyle ?? 'none',
        show_in_funnel: item.showInFunnel ?? true,
        show_in_pie: item.showInPie ?? true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(
        explainUniqueViolation({
          pipelines_name_unique_idx: () =>
            new ValidationError([
              { path: '/name', code: 'taken', message: 'Another pipeline has this name.' },
            ]),
        }),
      );
    // The stages in use, in their order. Archived ones stay with the pipeline they were of.
    const stages = item.stages.filter((stage) => !stage.archived);
    if (stages.length > 0)
      await trx
        .insertInto('crm.pipeline_stages')
        .values(
          stages.map((stage, position) => ({
            business_id: businessId,
            pipeline_id: copy.id,
            name: stage.name,
            description: stage.description,
            position,
            win_probability: storedProbability(stage.probability ?? null),
            color: stage.color ?? null,
            show_in_funnel: stage.showInFunnel ?? true,
            show_in_pie: stage.showInPie ?? true,
          })),
        )
        .execute();
    const made = await readPipelines(trx, command);
    const copied = made.items.find((each) => parsePublicId('pipeline', each.id) === copy.id);
    if (copied === undefined) throw new Error('The copy was not read back.');
    const before = made.items.map((each) => each.id);
    const after = before.filter((id) => id !== copied.id);
    after.splice(index + 1, 0, copied.id);
    await reposition(trx, businessId, after);
    await command.emit({
      type: 'pipeline.duplicated',
      subject: { kind: 'business', id: businessId },
      payload: { pipelineId: copied.id, fromPipelineId: input.id, stageCount: stages.length },
    });
    return readPipelines(trx, command);
  },
});

export const deletePipelineCommand = defineCommand({
  name: 'pipeline.delete',
  permission: 'pipelines.manage',
  input: deletePipelineCommandInput,
  async handle(trx, input, command): Promise<PipelineConfiguration> {
    const businessId = await lockConfiguration(trx, command);
    const current = await readPipelines(trx, command);
    found(current, input.id);
    requireConfigurationRevision(current, input.revision);
    const pipelineId = parsePublicId('pipeline', input.id) ?? '';
    // Creating a deal holds the business's row for share, so none arrives while this runs.
    // A deal in the trash is still a deal, and a deal that passed through keeps its history.
    const held = await trx
      .selectFrom('crm.deals')
      .select('id')
      .where('business_id', '=', businessId)
      .where('pipeline_id', '=', pipelineId)
      .limit(1)
      .executeTakeFirst();
    const passed = await trx
      .selectFrom('crm.deal_stage_history')
      .select('id')
      .where('business_id', '=', businessId)
      .where('pipeline_id', '=', pipelineId)
      .limit(1)
      .executeTakeFirst();
    if (held !== undefined || passed !== undefined)
      throw new ConflictError(
        'This pipeline holds deals, or deals passed through it. Archive it instead of deleting it.',
      );
    // Its stages go with it (pipeline_stages_business_id_pipeline_id_fkey cascades).
    await trx
      .deleteFrom('crm.pipelines')
      .where('business_id', '=', businessId)
      .where('id', '=', pipelineId)
      .execute();
    await reposition(
      trx,
      businessId,
      current.items.map((item) => item.id).filter((id) => id !== input.id),
    );
    await command.emit({
      type: 'pipeline.deleted',
      subject: { kind: 'business', id: requireBusiness(command.context) },
      payload: { pipelineId: input.id },
    });
    return readPipelines(trx, command);
  },
});
