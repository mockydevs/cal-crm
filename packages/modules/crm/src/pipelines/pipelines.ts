import { createHash } from 'node:crypto';

import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  pipelineColorStyles,
  savePipelinesInput,
  type Pipeline,
  type PipelineConfiguration,
  type SavePipelinesInput,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';

/** A stored chance of winning (0 to 1) in whole percent, as the API gives it. */
export const percentOf = (stored: string | null): number | null =>
  stored === null ? null : Math.round(Number(stored) * 100);
/** A chance of winning in whole percent as it is stored: exact, to four places. */
export const storedProbability = (percent: number | null): string | null =>
  percent === null ? null : (percent / 100).toFixed(4);

/**
 * Every configuration writer takes this lock before reading its revision. The later read
 * runs at READ COMMITTED, so a waiting writer sees the committed winner.
 */
export async function lockConfiguration(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<string> {
  const businessId = requireBusiness(invocation.context);
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('id')
    .where('id', '=', businessId)
    .forUpdate()
    .executeTakeFirst();
  if (business === undefined)
    throw new NotFoundError('Business', toPublicId('business', businessId));
  return businessId;
}

/** Refuses a change made from a configuration someone has since changed. */
export function requireConfigurationRevision(
  current: PipelineConfiguration,
  revision: string,
): void {
  if (current.revision !== revision)
    throw new ConflictError(
      'Deal stages changed since you opened this page. Reload before saving.',
    );
}

export async function readPipelines(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<PipelineConfiguration> {
  const businessId = requireBusiness(invocation.context);
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('id')
    .where('id', '=', businessId)
    .forShare()
    .executeTakeFirst();
  if (business === undefined)
    throw new NotFoundError('Business', toPublicId('business', businessId));
  const rows = await trx
    .selectFrom('crm.pipelines')
    .selectAll()
    .where('business_id', '=', businessId)
    .orderBy('position')
    .orderBy('id')
    .execute();
  const stages = await trx
    .selectFrom('crm.pipeline_stages')
    .selectAll()
    .where('business_id', '=', businessId)
    .orderBy('position')
    .orderBy('id')
    .execute();
  const grouped = Map.groupBy(stages, (stage) => stage.pipeline_id);
  const items: Pipeline[] = rows.map((row) => {
    const own = grouped.get(row.id) ?? [];
    // A change to a stage is a change to its pipeline: the list's "Updated on".
    const updated = own.reduce(
      (latest, stage) => (stage.updated_at > latest ? stage.updated_at : latest),
      row.updated_at,
    );
    return {
      id: toPublicId('pipeline', row.id),
      name: row.name,
      description: row.description,
      archived: row.archived_at !== null,
      dealProbability: row.deal_probability,
      colorStyle: pipelineColorStyles.find((style) => style === row.color_style) ?? 'none',
      showInFunnel: row.show_in_funnel,
      showInPie: row.show_in_pie,
      updatedAt: updated.toISOString(),
      stages: own.map((stage) => ({
        id: toPublicId('stage', stage.id),
        name: stage.name,
        description: stage.description,
        archived: stage.archived_at !== null,
        probability: percentOf(stage.win_probability),
        color: stage.color,
        showInFunnel: stage.show_in_funnel,
        showInPie: stage.show_in_pie,
      })),
    };
  });
  return {
    items,
    revision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('pipelines.manage'),
  };
}

function validateIds(current: Pipeline[], items: SavePipelinesInput['items']): void {
  const existing = new Map(current.map((item) => [item.id, item]));
  const submitted = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.id !== undefined && !existing.has(item.id))
      throw new ValidationError([
        {
          path: '/items',
          code: 'unknown_id',
          message: 'A pipeline does not belong to this business.',
        },
      ]);
    const stageIds = new Set(existing.get(item.id ?? '')?.stages.map((stage) => stage.id));
    if (item.stages.some((stage) => stage.id !== undefined && !stageIds.has(stage.id)))
      throw new ValidationError([
        {
          path: '/items',
          code: 'unknown_id',
          message: 'A stage does not belong to this pipeline.',
        },
      ]);
  }
  for (const item of current) {
    const replacement = submitted.get(item.id);
    if (
      replacement === undefined ||
      item.stages.some((stage) => !replacement.stages.some((next) => next.id === stage.id))
    )
      throw new ValidationError([
        {
          path: '/items',
          code: 'archive_required',
          message: 'Archive existing pipelines and stages instead of removing them.',
        },
      ]);
  }
}
const duplicateName = () =>
  new ValidationError([
    {
      path: '/items',
      code: 'taken',
      message:
        'Active pipeline names must be unique; active stage names must be unique within their pipeline.',
    },
  ]);

type PipelineInput = SavePipelinesInput['items'][number];
type StageInput = PipelineInput['stages'][number];

/** A stage as it is saved: what the request says, and for the rest what it has, or the default. */
const stageValues = (stage: StageInput, held: Pipeline['stages'][number] | undefined) => ({
  name: stage.name,
  description: stage.description,
  archived: stage.archived,
  probability: stage.probability === undefined ? (held?.probability ?? null) : stage.probability,
  color: stage.color === undefined ? (held?.color ?? null) : stage.color,
  showInFunnel: stage.showInFunnel ?? held?.showInFunnel ?? true,
  showInPie: stage.showInPie ?? held?.showInPie ?? true,
});
/** The same for a pipeline, with its stages in the order they were sent. */
const pipelineValues = (item: PipelineInput, held: Pipeline | undefined) => ({
  name: item.name,
  description: item.description,
  archived: item.archived,
  dealProbability: item.dealProbability ?? held?.dealProbability ?? false,
  colorStyle: item.colorStyle ?? held?.colorStyle ?? 'none',
  showInFunnel: item.showInFunnel ?? held?.showInFunnel ?? true,
  showInPie: item.showInPie ?? held?.showInPie ?? true,
  stages: item.stages.map((stage) => ({
    id: stage.id,
    ...stageValues(
      stage,
      held?.stages.find((each) => each.id === stage.id),
    ),
  })),
});
/** What is compared to tell whether a save changes a pipeline: everything but the times. */
const comparable = (item: Pipeline) =>
  JSON.stringify(pipelineValues(item, item satisfies PipelineInput));

export const savePipelinesCommand = defineCommand({
  name: 'pipelines.save',
  permission: 'pipelines.manage',
  input: savePipelinesInput,
  async handle(trx, input, command): Promise<PipelineConfiguration> {
    const businessId = await lockConfiguration(trx, command);
    const current = await readPipelines(trx, command);
    requireConfigurationRevision(current, input.revision);
    validateIds(current.items, input.items);
    const held = new Map(current.items.map((item, position) => [item.id, { item, position }]));
    // A pipeline the save leaves as it is, in its place, is not written at all, so its
    // "updated on" stays what it was.
    const wanted = input.items.map((item, position) => {
      const before = held.get(item.id ?? '');
      const values = pipelineValues(item, before?.item);
      let changed = true;
      if (before !== undefined)
        changed =
          before.position !== position || comparable(before.item) !== JSON.stringify(values);
      return { id: item.id, position, values, changed };
    });
    const changing = wanted.flatMap((item) =>
      item.changed && item.id !== undefined ? [parsePublicId('pipeline', item.id) ?? ''] : [],
    );
    // Temporarily archive within this transaction to permit swapping live names. The
    // final unique indexes still validate the entire submitted configuration.
    const now = new Date();
    if (changing.length > 0) {
      await trx
        .updateTable('crm.pipelines')
        .set({ archived_at: now })
        .where('business_id', '=', businessId)
        .where('id', 'in', changing)
        .execute();
      await trx
        .updateTable('crm.pipeline_stages')
        .set({ archived_at: now })
        .where('business_id', '=', businessId)
        .where('pipeline_id', 'in', changing)
        .execute();
    }
    for (const { id, position, values, changed } of wanted) {
      if (!changed) continue;
      const stored = {
        name: values.name,
        description: values.description,
        position,
        archived_at: values.archived ? now : null,
        deal_probability: values.dealProbability,
        color_style: values.colorStyle,
        show_in_funnel: values.showInFunnel,
        show_in_pie: values.showInPie,
      };
      const row =
        id === undefined
          ? await trx
              .insertInto('crm.pipelines')
              .values({ business_id: businessId, ...stored })
              .returning('id')
              .executeTakeFirstOrThrow()
              .catch(explainUniqueViolation({ pipelines_name_unique_idx: duplicateName }))
          : await trx
              .updateTable('crm.pipelines')
              .set(stored)
              .where('business_id', '=', businessId)
              .where('id', '=', parsePublicId('pipeline', id) ?? '')
              .returning('id')
              .executeTakeFirstOrThrow()
              .catch(explainUniqueViolation({ pipelines_name_unique_idx: duplicateName }));
      for (const [stagePosition, stage] of values.stages.entries()) {
        const storedStage = {
          name: stage.name,
          description: stage.description,
          position: stagePosition,
          archived_at: stage.archived ? now : null,
          win_probability: storedProbability(stage.probability),
          color: stage.color,
          show_in_funnel: stage.showInFunnel,
          show_in_pie: stage.showInPie,
        };
        const duplicates = explainUniqueViolation({
          pipeline_stages_name_unique_idx: duplicateName,
        });
        if (stage.id === undefined)
          await trx
            .insertInto('crm.pipeline_stages')
            .values({ business_id: businessId, pipeline_id: row.id, ...storedStage })
            .execute()
            .catch(duplicates);
        else
          await trx
            .updateTable('crm.pipeline_stages')
            .set(storedStage)
            .where('business_id', '=', businessId)
            .where('pipeline_id', '=', row.id)
            .where('id', '=', parsePublicId('stage', stage.id) ?? '')
            .execute()
            .catch(duplicates);
      }
    }
    await command.emit({
      type: 'pipelines.updated',
      subject: { kind: 'business', id: businessId },
      payload: { pipelineCount: input.items.length },
    });
    return readPipelines(trx, command);
  },
});
