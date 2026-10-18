// One change applied to many deals at once, and the list of the bulk actions that were run.
// What each action does to a deal is what the single-deal command does: deal.assign_owner,
// deal.update for a move or a status, deal.trash. The same events are written, one for each
// deal that changed, so automations and timelines cannot tell a bulk change from the same
// change made one deal at a time.
//
// Every deal named is looked up under row-level security and held before anything is
// decided: a deal of another business is not there to be found, and a deal someone else is
// changing is changed after them, once. A request that changes nothing writes nothing.
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  bulkDealsInput,
  dealBulkActions,
  type BulkDealsInput,
  type BulkDealsResult,
  type DealBulkActionList,
  type dealBulkActionsQuery,
  type DealBulkSkipCode,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  actorKinds,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import type * as z from 'zod';

import { memberOf } from '../contacts/people.js';
import type { DealPeopleOptions } from './details.js';
import { followPrimaryContact, holdOwnerRules } from './owner-rules.js';

type Result = BulkDealsResult['results'][number];
type Outcome = Pick<Result, 'outcome' | 'reason'>;

const reasons: Record<DealBulkSkipCode, string> = {
  not_found: 'This deal was not found.',
  in_trash: 'This deal is in the trash. Restore it before changing it.',
};
const skipped = (code: DealBulkSkipCode): Outcome => ({
  outcome: 'skipped',
  reason: { code, message: reasons[code] },
});
const did = (changed: boolean): Outcome => ({
  outcome: changed ? 'done' : 'unchanged',
  reason: null,
});

/** A deal as this command needs it, held for the write. */
interface Held {
  readonly id: string;
  readonly pipeline_id: string;
  readonly stage_id: string;
  readonly status: string;
  readonly owner_user_id: string | null;
  readonly deleted_at: Date | null;
}

/** The active stage of an active pipeline a move names, or a refusal of the whole request. */
async function destination(
  trx: DatabaseTransaction,
  businessId: string,
  input: Extract<BulkDealsInput, { action: 'move' }>,
): Promise<{ pipeline_id: string; stage_id: string }> {
  const pipelineId = parsePublicId('pipeline', input.pipelineId) ?? '';
  const stageId = parsePublicId('stage', input.stageId) ?? '';
  const stage = await trx
    .selectFrom('crm.pipeline_stages as s')
    .innerJoin('crm.pipelines as p', (join) =>
      join.onRef('p.business_id', '=', 's.business_id').onRef('p.id', '=', 's.pipeline_id'),
    )
    .select('s.id')
    .where('s.business_id', '=', businessId)
    .where('s.pipeline_id', '=', pipelineId)
    .where('s.id', '=', stageId)
    .where('s.archived_at', 'is', null)
    .where('p.archived_at', 'is', null)
    .executeTakeFirst();
  if (stage === undefined)
    throw new ValidationError([
      {
        path: '/stageId',
        code: 'unavailable',
        message: 'Choose an active stage in this pipeline.',
      },
    ]);
  return { pipeline_id: pipelineId, stage_id: stageId };
}

/** One moment for every deal of the request, at PostgreSQL's precision. */
async function instant(trx: DatabaseTransaction) {
  const row = await sql<{ at: string }>`select clock_timestamp()::text as at`.execute(trx);
  const first = row.rows[0];
  if (first === undefined) throw new Error('Database did not return a timestamp.');
  return sql<Date>`${first.at}::timestamptz`;
}

export function bulkDealsCommand(
  options: DealPeopleOptions,
): Command<typeof bulkDealsInput, BulkDealsResult> {
  return defineCommand({
    name: 'deal.bulk',
    permission: 'deals.manage',
    input: bulkDealsInput,
    // The action and the deals, and never a reason given for an outcome.
    audit: (input) => ({ action: input.action, ids: input.ids }),
    async handle(trx, input, command): Promise<BulkDealsResult> {
      const businessId = requireBusiness(command.context);
      // In turn with the owner changes that write on linked records (owner-rules.ts).
      const rules = await holdOwnerRules(trx, businessId);
      // As deal.update does: the pipelines stay as they are until this commits.
      const business = await trx
        .selectFrom('tenancy.businesses')
        .select('id')
        .where('id', '=', businessId)
        .forShare()
        .executeTakeFirst();
      if (business === undefined)
        throw new NotFoundError('Business', toPublicId('business', businessId));

      const wanted = input.ids.map((publicId) => ({
        publicId,
        id: parsePublicId('deal', publicId),
      }));
      const ids = wanted.flatMap((item) => (item.id === undefined ? [] : [item.id]));
      // Held in id order, so two bulk requests over the same deals never wait on each other.
      const held = new Map<string, Held>(
        (
          await trx
            .selectFrom('crm.deals')
            .select(['id', 'pipeline_id', 'stage_id', 'status', 'owner_user_id', 'deleted_at'])
            .where('business_id', '=', businessId)
            .where('id', 'in', ids)
            .orderBy('id')
            .forUpdate()
            .execute()
        ).map((row) => [row.id, row]),
      );

      const outcomes = new Map<string, Outcome>();
      const live = [...held.values()].filter((row) => {
        if (row.deleted_at === null) return true;
        // A deal in the trash is already where trash puts it, and takes no other change.
        outcomes.set(row.id, input.action === 'trash' ? did(false) : skipped('in_trash'));
        return false;
      });
      const event = (row: Held, type: string, payload: Record<string, unknown> = {}) =>
        command.emit({ type, subject: { kind: 'deal', id: row.id }, records: [row.id], payload });
      const write = (row: Held, values: Record<string, unknown>) =>
        trx
          .updateTable('crm.deals')
          .set(values)
          .where('business_id', '=', businessId)
          .where('id', '=', row.id)
          .execute();

      if (input.action === 'assign_owner') {
        const owner =
          input.owner === null
            ? null
            : await memberOf(options, trx, command, input.owner, '/owner');
        for (const row of live) {
          const change = row.owner_user_id !== owner;
          if (change) {
            await write(row, { owner_user_id: owner });
            await event(
              row,
              owner === null ? 'deal.owner_unassigned' : 'deal.owner_assigned',
              owner === null ? {} : { assignedUserId: owner },
            );
            if (owner !== null && rules.dealOwnerFollowsContact)
              await followPrimaryContact(
                trx,
                command,
                options.assignees.memberships,
                row.id,
                owner,
              );
          }
          outcomes.set(row.id, did(change));
        }
      } else if (input.action === 'move') {
        const stage = await destination(trx, businessId, input);
        const at = await instant(trx);
        for (const row of live) {
          const change = row.stage_id !== stage.stage_id || row.pipeline_id !== stage.pipeline_id;
          if (change) {
            await trx
              .updateTable('crm.deal_stage_history')
              .set({ exited_at: at })
              .where('business_id', '=', businessId)
              .where('deal_id', '=', row.id)
              .where('exited_at', 'is', null)
              .execute();
            await trx
              .insertInto('crm.deal_stage_history')
              .values({
                business_id: businessId,
                deal_id: row.id,
                ...stage,
                entered_at: at,
                entered_by_kind: command.context.actorKind,
                entered_by_id: command.context.actorId ?? null,
              })
              .execute();
            await write(row, { ...stage, stage_entered_at: at, board_position: null });
            await event(row, 'deal.stage_changed', {
              fromPipelineId: toPublicId('pipeline', row.pipeline_id),
              fromStageId: toPublicId('stage', row.stage_id),
              pipelineId: input.pipelineId,
              stageId: input.stageId,
            });
          }
          outcomes.set(row.id, did(change));
        }
      } else if (input.action === 'set_status') {
        const at = await instant(trx);
        for (const row of live) {
          const change = row.status !== input.status;
          if (change) {
            await write(row, {
              status: input.status,
              won_note: input.status === 'won' ? input.outcomeReason : null,
              lost_note: input.status === 'lost' ? input.outcomeReason : null,
              lost_reason_id: null,
              closed_at: input.status === 'open' ? null : at,
            });
            // As one deal's close says it (deals.ts): where the deal stands as it closes.
            await event(row, input.status === 'open' ? 'deal.reopened' : `deal.${input.status}`, {
              reason: input.outcomeReason,
              status: input.status,
              pipelineId: toPublicId('pipeline', row.pipeline_id),
              stageId: toPublicId('stage', row.stage_id),
            });
          }
          outcomes.set(row.id, did(change));
        }
      } else {
        for (const row of live) {
          await write(row, { deleted_at: sql<Date>`now()` });
          await event(row, 'deal.trashed');
          outcomes.set(row.id, did(true));
        }
      }

      const results = wanted.map((item): Result => {
        const outcome =
          (item.id === undefined ? undefined : outcomes.get(item.id)) ?? skipped('not_found');
        return { id: item.publicId, ...outcome };
      });
      const count = (outcome: Result['outcome']) =>
        results.filter((result) => result.outcome === outcome).length;
      const done = count('done');
      return {
        action: input.action,
        results,
        done,
        unchanged: count('unchanged'),
        skipped: count('skipped'),
        bulkActionId:
          done === 0 ? null : await record(trx, command, input.action, results.length, count),
      };
    },
  });
}

/** Keeps what a bulk action did, for the list of them. */
async function record(
  trx: DatabaseTransaction,
  command: CommandContext,
  action: BulkDealsInput['action'],
  requested: number,
  count: (outcome: Result['outcome']) => number,
): Promise<string> {
  const row = await trx
    .insertInto('crm.bulk_actions')
    .values({
      business_id: requireBusiness(command.context),
      object_kind: 'deal',
      action,
      requested_count: requested,
      done_count: count('done'),
      unchanged_count: count('unchanged'),
      skipped_count: count('skipped'),
      actor_kind: command.context.actorKind,
      actor_id: command.context.actorId ?? null,
      // The moment the action ended; it began with the transaction.
      completed_at: sql<Date>`clock_timestamp()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return toPublicId('bulk_action', row.id);
}

/** A page of the business's bulk actions on deals, newest first. */
export async function readDealBulkActions(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof dealBulkActionsQuery>,
  options: DealPeopleOptions,
): Promise<DealBulkActionList> {
  const businessId = requireBusiness(invocation.context);
  let selection = trx
    .selectFrom('crm.bulk_actions')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('object_kind', '=', 'deal');
  if (query.action !== undefined) selection = selection.where('action', '=', query.action);
  if (query.after !== undefined)
    selection = selection.where('id', '<', parsePublicId('bulk_action', query.after) ?? '');
  const rows = await selection
    .orderBy('id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const page = rows.slice(0, query.limit);
  // Each kind of actor is named by the module that owns it, in one read for the page.
  const names = new Map<string, string>();
  for (const kind of actorKinds) {
    const ids = [
      ...new Set(
        page.flatMap((row) =>
          row.actor_kind === kind && row.actor_id !== null ? [row.actor_id] : [],
        ),
      ),
    ];
    const found = ids.length === 0 ? undefined : await options.actorNames[kind]?.(trx, ids);
    for (const [id, name] of found ?? []) names.set(`${kind}:${id}`, name);
  }
  const { context } = invocation;
  return {
    items: page.map((row) => {
      const kind = actorKinds.find((each) => each === row.actor_kind) ?? 'system';
      return {
        id: toPublicId('bulk_action', row.id),
        // The table takes what this command writes, and nothing else writes it.
        action: dealBulkActions.find((action) => action === row.action) ?? 'trash',
        requested: row.requested_count,
        done: row.done_count,
        unchanged: row.unchanged_count,
        skipped: row.skipped_count,
        actor: {
          kind,
          name: names.get(`${kind}:${row.actor_id ?? ''}`) ?? null,
          you: kind === 'user' && context.actorKind === 'user' && row.actor_id === context.userId,
        },
        createdAt: row.created_at.toISOString(),
        completedAt: row.completed_at.toISOString(),
      };
    }),
    next: rows.length > query.limit ? toPublicId('bulk_action', page.at(-1)?.id ?? '') : null,
  };
}
