import { planFieldList } from '../fields/list-fields.js';
import { createHash } from 'node:crypto';
import {
  defineCommand,
  requireBusiness,
  type Invocation,
  type CommandContext,
} from '@repo/commands';
import {
  createDealInput,
  updateDealCommandInput,
  dealListExtrasOf,
  dealListQuery,
  dealSortDirection,
  deal,
  type Deal,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  parsePublicId,
  toPublicId,
} from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type * as z from 'zod';

import { writeDealContacts } from './contacts.js';
import { readDealExtras, type DealPeopleOptions } from './details.js';
import { dealsMatching } from './list-search.js';

const uuid = (id: string) => {
  const value = parsePublicId('deal', id);
  if (value === undefined) throw new NotFoundError('Deal', id);
  return value;
};
function rows(trx: DatabaseTransaction, invocation: Invocation) {
  return trx
    .selectFrom('crm.deals as d')
    .innerJoin('crm.pipelines as p', (join) =>
      join.onRef('p.business_id', '=', 'd.business_id').onRef('p.id', '=', 'd.pipeline_id'),
    )
    .innerJoin('crm.pipeline_stages as s', (join) =>
      join.onRef('s.business_id', '=', 'd.business_id').onRef('s.id', '=', 'd.stage_id'),
    )
    .selectAll('d')
    .select(['p.name as pipeline_name', 's.name as stage_name'])
    .select(sql<string | null>`d.expected_close_date::text`.as('close_date'))
    .select(sql<string>`d.updated_at::text`.as('version'))
    .where('d.business_id', '=', requireBusiness(invocation.context));
}
type Row = Awaited<ReturnType<ReturnType<typeof rows>['executeTakeFirstOrThrow']>>;
function present(row: Row, invocation: Invocation): Deal {
  const content = {
    id: toPublicId('deal', row.id),
    name: row.name,
    pipelineId: toPublicId('pipeline', row.pipeline_id),
    stageId: toPublicId('stage', row.stage_id),
    pipelineName: row.pipeline_name,
    stageName: row.stage_name,
    amount: row.amount,
    currency: row.currency,
    expectedCloseDate: row.close_date,
    status: row.status,
    outcomeReason: row.status === 'won' ? row.won_note : row.lost_note,
    closedAt: row.closed_at?.toISOString() ?? null,
    stageEnteredAt: row.stage_entered_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    trashedAt: row.deleted_at?.toISOString() ?? null,
  };
  return deal.parse({
    ...content,
    source: row.source,
    // Left out of what is hashed, as the source is.
    probability:
      row.win_probability === null ? null : Math.round(Number(row.win_probability) * 100),
    // The source is left out of what is hashed: a change to it moves updated_at, which is,
    // and a deal that has none keeps the revision its readers already hold.
    revision: createHash('sha256')
      .update(JSON.stringify([content, row.version]))
      .digest('hex'),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('deals.manage'),
  });
}
export async function readDeal(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<Deal> {
  const row = await rows(trx, invocation).where('d.id', '=', uuid(id)).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Deal', id);
  return present(row, invocation);
}
/**
 * What narrows the deals a list or a board shows: not in the trash, and its pipeline,
 * stage, status and field filter. The list's pages and the board's column headers
 * (summary.ts) both read through this, so a header counts exactly the cards its column
 * pages.
 */
export async function keptDeals(
  trx: DatabaseTransaction,
  businessId: string,
  query: Pick<z.output<typeof dealListQuery>, 'pipelineId' | 'stageId' | 'status' | 'q'> &
    Parameters<typeof planFieldList>[4],
): Promise<{
  readonly fields: Awaited<ReturnType<typeof planFieldList>>;
  readonly conditions: RawBuilder<SqlBool>;
}> {
  const fields = await planFieldList(trx, businessId, 'deal', 'd', query);
  const conditions: RawBuilder<SqlBool>[] = [sql`d.deleted_at is null`];
  if (fields.filter !== undefined) conditions.push(sql`(${fields.filter})`);
  if (query.pipelineId !== undefined)
    conditions.push(sql`d.pipeline_id = ${parsePublicId('pipeline', query.pipelineId) ?? ''}`);
  // One column of the board. A stage of another pipeline, or of another business, has none.
  if (query.stageId !== undefined)
    conditions.push(sql`d.stage_id = ${parsePublicId('stage', query.stageId) ?? ''}`);
  if (query.status !== 'all') conditions.push(sql`d.status = ${query.status}`);
  // The search: the list and the board's headers keep the same deals.
  if (query.q !== undefined && query.q !== '')
    conditions.push(await dealsMatching(trx, businessId, query.q));
  return { fields, conditions: sql.join(conditions, sql` and `) };
}
const afterUnknown = () =>
  new ValidationError([
    { path: '/after', code: 'unknown_deal', message: 'Start after a deal of this business.' },
  ]);

/** The column each built-in order reads, through its own index (migration 0062). */
const orderColumns = { updated: 'updated_at', name: 'sort_name', value: 'amount' } as const;

/**
 * A page in one of the built-in orders, by keyset: the place is read in SQL from the deal
 * the page starts after, so no precision is lost. Deals that tie are in the order of their
 * ids. By value, the deals without one come last whichever way the list runs: a second
 * read, in id order, since a keyset over both would have to read past the index's order.
 */
async function orderedPage(
  trx: DatabaseTransaction,
  businessId: string,
  kept: () => ReturnType<typeof rows>,
  sort: keyof typeof orderColumns,
  direction: 'asc' | 'desc',
  after: string | undefined,
  limit: number,
): Promise<Row[]> {
  let anchor: { id: string; valued: boolean } | undefined;
  if (after !== undefined) {
    const afterId = parsePublicId('deal', after);
    anchor =
      afterId === undefined
        ? undefined
        : await trx
            .selectFrom('crm.deals')
            .select(['id'])
            .select(sql<boolean>`amount is not null`.as('valued'))
            .where('business_id', '=', businessId)
            .where('id', '=', afterId)
            .executeTakeFirst();
    if (anchor === undefined) throw afterUnknown();
  }
  const column = sql.ref(`d.${orderColumns[sort]}`);
  const beyond = sql.raw(direction === 'asc' ? '>' : '<');
  const place = (anchorId: string) => sql<SqlBool>`(${column}, d.id) ${beyond} (
    select ${sql.ref(`a.${orderColumns[sort]}`)}, a.id from crm.deals a
    where a.business_id = ${businessId} and a.id = ${anchorId})`;
  const from = (start: { id: string } | undefined) =>
    start === undefined ? kept() : kept().where(place(start.id));
  if (sort !== 'value')
    return from(anchor)
      .orderBy(column, direction)
      .orderBy('d.id', direction)
      .limit(limit)
      .execute();

  const unvalued = (count: number, afterId?: string) =>
    (afterId === undefined ? kept() : kept().where('d.id', '>', afterId))
      .where('d.amount', 'is', null)
      .orderBy('d.id')
      .limit(count)
      .execute();
  if (anchor?.valued === false) return unvalued(limit, anchor.id);
  const valued = await from(anchor)
    .where('d.amount', 'is not', null)
    .orderBy(column, direction)
    .orderBy('d.id', direction)
    .limit(limit)
    .execute();
  if (valued.length === limit) return valued;
  return [...valued, ...(await unvalued(limit - valued.length))];
}
export async function listDeals(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof dealListQuery>,
  people?: DealPeopleOptions,
): Promise<{ items: Deal[]; next: string | null; canManage: boolean }> {
  const businessId = requireBusiness(invocation.context);
  const { fields, conditions } = await keptDeals(trx, businessId, query);
  const kept = () => rows(trx, invocation).where(conditions);
  const limit = query.limit + 1;
  const sort = query.sort ?? 'created';
  const direction = dealSortDirection(sort, query.direction);
  let page: Row[];
  if (fields.order !== undefined) {
    // By a custom field: the field's own keyset (list-fields.ts).
    const sorted = kept().$if(fields.sortId !== undefined, (qb) =>
      qb.leftJoin('crm.field_values as field_sort', (join) =>
        join
          .onRef('field_sort.business_id', '=', 'd.business_id')
          .onRef('field_sort.record_id', '=', 'd.id')
          .on('field_sort.field_id', '=', fields.sortId ?? ''),
      ),
    );
    page = await (fields.after === undefined ? sorted : sorted.where(fields.after))
      .orderBy(fields.order)
      .orderBy('d.id')
      .limit(limit)
      .execute();
  } else if (sort === 'created') {
    // Ids are made in the order of time (uuidv7), so the order of creation is the id's.
    page = await (
      query.after === undefined
        ? kept()
        : kept().where('d.id', direction === 'desc' ? '<' : '>', uuid(query.after))
    )
      .orderBy('d.id', direction)
      .limit(limit)
      .execute();
  } else {
    page = await orderedPage(trx, businessId, kept, sort, direction, query.after, limit);
  }
  const shown = page.slice(0, query.limit);
  // Read for this page's deals only, and only what the request names.
  const extras = await readDealExtras(
    trx,
    invocation,
    shown,
    dealListExtrasOf(query.include),
    people,
  );
  const items = shown.map((row) => ({ ...present(row, invocation), ...extras(row.id) }));
  return {
    items,
    next: page.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    canManage: invocation.permissions === 'all' || invocation.permissions.has('deals.manage'),
  };
}
async function lockBusiness(trx: DatabaseTransaction, invocation: Invocation) {
  const businessId = requireBusiness(invocation.context);
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('id')
    .where('id', '=', businessId)
    .forShare()
    .executeTakeFirst();
  if (business === undefined)
    throw new NotFoundError('Business', toPublicId('business', businessId));
  return businessId;
}
async function destination(
  trx: DatabaseTransaction,
  businessId: string,
  input: z.output<typeof createDealInput>,
) {
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
// Sample after locks; retain PostgreSQL precision for both sides of a history boundary.
async function instant(trx: DatabaseTransaction) {
  const row = await sql<{ at: string }>`select clock_timestamp()::text as at`.execute(trx);
  const first = row.rows[0];
  if (first === undefined) throw new Error('Database did not return a timestamp.');
  return sql<Date>`${first.at}::timestamptz`;
}
function values(input: z.output<typeof createDealInput> | z.output<typeof updateDealCommandInput>) {
  return {
    name: input.name,
    amount: input.amount,
    currency: input.currency,
    expected_close_date: input.expectedCloseDate,
    status: input.status,
    won_note: input.status === 'won' ? input.outcomeReason : null,
    lost_note: input.status === 'lost' ? input.outcomeReason : null,
    lost_reason_id: null,
    // Left out, a new deal has no source and an edited one keeps its own.
    ...(input.source === undefined ? {} : { source: input.source }),
    // The same for the deal's own chance of being won, stored from 0 to 1.
    ...(input.probability === undefined
      ? {}
      : {
          win_probability: input.probability === null ? null : (input.probability / 100).toFixed(4),
        }),
  };
}
async function enterStage(
  trx: DatabaseTransaction,
  command: CommandContext,
  id: string,
  stage: { pipeline_id: string; stage_id: string },
  at: Awaited<ReturnType<typeof instant>>,
) {
  await trx
    .insertInto('crm.deal_stage_history')
    .values({
      business_id: requireBusiness(command.context),
      deal_id: id,
      ...stage,
      entered_at: at,
      entered_by_kind: command.context.actorKind,
      entered_by_id: command.context.actorId ?? null,
    })
    .execute();
}
/**
 * A new deal belongs to whoever owns its primary contact, as GoHighLevel documents ("the
 * default owner will be the same as the contact owner"). The contact is held by the link
 * just written.
 */
async function inheritOwner(trx: DatabaseTransaction, command: CommandContext, dealId: string) {
  const businessId = requireBusiness(command.context);
  const contact = await trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.contacts as c', (join) =>
      join.onRef('c.business_id', '=', 'link.business_id').onRef('c.id', '=', 'link.to_record_id'),
    )
    .select('c.owner_user_id')
    .where('link.business_id', '=', businessId)
    .where('link.from_record_id', '=', dealId)
    .where('link.is_primary', '=', true)
    .executeTakeFirst();
  const owner = contact?.owner_user_id ?? null;
  if (owner === null) return;
  await trx
    .updateTable('crm.deals')
    .set({ owner_user_id: owner })
    .where('business_id', '=', businessId)
    .where('id', '=', dealId)
    .execute();
  await command.emit({
    type: 'deal.owner_assigned',
    subject: { kind: 'deal', id: dealId },
    records: [dealId],
    payload: { assignedUserId: owner },
  });
}
export const createDealCommand = defineCommand({
  name: 'deal.create',
  permission: 'deals.manage',
  input: createDealInput,
  async handle(trx, input, command): Promise<Deal> {
    const businessId = await lockBusiness(trx, command);
    const stage = await destination(trx, businessId, input);
    const type = await trx
      .selectFrom('crm.object_types')
      .select('id')
      .where('business_id', '=', businessId)
      .where('kind', '=', 'deal')
      .executeTakeFirstOrThrow();
    const record = await trx
      .insertInto('crm.records')
      .values({ business_id: businessId, kind: 'deal', object_type_id: type.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const at = await instant(trx);
    await trx
      .insertInto('crm.deals')
      .values({
        business_id: businessId,
        id: record.id,
        ...values(input),
        ...stage,
        stage_entered_at: at,
        closed_at: input.status === 'open' ? null : at,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .execute();
    await enterStage(trx, command, record.id, stage, at);
    await command.emit({
      type: 'deal.created',
      subject: { kind: 'deal', id: record.id },
      records: [record.id],
      payload: { ...input },
    });
    // The contacts the deal is with are linked with it, or the deal is not made.
    if (input.primaryContactId !== undefined || input.additionalContactIds !== undefined)
      await writeDealContacts(trx, command, record.id, {
        primaryContactId: input.primaryContactId ?? null,
        additionalContactIds: input.additionalContactIds ?? [],
      });
    if (input.primaryContactId !== undefined) await inheritOwner(trx, command, record.id);
    return readDeal(trx, command, toPublicId('deal', record.id));
  },
});
export const updateDealCommand = defineCommand({
  name: 'deal.update',
  permission: 'deals.manage',
  input: updateDealCommandInput,
  async handle(trx, input, command): Promise<Deal> {
    const businessId = await lockBusiness(trx, command);
    // Lock the deal alone. A joined locking query can lose a concurrently moved row
    // when PostgreSQL rechecks it against the statement's old stage join snapshot.
    const locked = await trx
      .selectFrom('crm.deals')
      .select('id')
      .where('business_id', '=', businessId)
      .where('id', '=', uuid(input.id))
      .forUpdate()
      .executeTakeFirst();
    if (locked === undefined) throw new NotFoundError('Deal', input.id);
    const row = await rows(trx, command).where('d.id', '=', locked.id).executeTakeFirstOrThrow();
    if (row.deleted_at !== null) throw new ConflictError('Restore this deal before editing it.');
    const current = present(row, command);
    if (current.revision !== input.revision)
      throw new ConflictError('This deal changed. Reload before saving.');
    const moved = current.stageId !== input.stageId || current.pipelineId !== input.pipelineId;
    const stage = moved
      ? await destination(trx, businessId, input)
      : { pipeline_id: row.pipeline_id, stage_id: row.stage_id };
    const at = await instant(trx);
    if (moved) {
      await trx
        .updateTable('crm.deal_stage_history')
        .set({ exited_at: at })
        .where('business_id', '=', businessId)
        .where('deal_id', '=', row.id)
        .where('exited_at', 'is', null)
        .execute();
      await enterStage(trx, command, row.id, stage, at);
    }
    await trx
      .updateTable('crm.deals')
      .set({
        ...values(input),
        ...stage,
        ...(moved ? { stage_entered_at: at, board_position: null } : {}),
        ...(current.status === input.status
          ? {}
          : { closed_at: input.status === 'open' ? null : at }),
      })
      .where('business_id', '=', businessId)
      .where('id', '=', row.id)
      .execute();
    const event = { subject: { kind: 'deal', id: row.id }, records: [row.id] };
    await command.emit({ ...event, type: 'deal.updated', payload: { ...input } });
    if (moved)
      await command.emit({
        ...event,
        type: 'deal.stage_changed',
        payload: {
          fromPipelineId: current.pipelineId,
          fromStageId: current.stageId,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
        },
      });
    if (current.status !== input.status)
      await command.emit({
        ...event,
        type: input.status === 'open' ? 'deal.reopened' : `deal.${input.status}`,
        // Where the deal stands as it closes, so a workflow's "deal closed" trigger can filter
        // by pipeline as "stage changed" does (the same keys, the same public ids).
        payload: {
          reason: input.outcomeReason,
          status: input.status,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          amount: input.amount,
          currency: input.currency,
        },
      });
    return readDeal(trx, command, input.id);
  },
});
