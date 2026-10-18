// The task list: one record's tasks or the business's, kept by assignment, status, due date
// and title, in one of three orders, a page at a time, with how many match.
//
// Paging is by keyset. The cursor is the last task of the page before: its place in the
// order is read in SQL from that task, so no precision is lost and nothing about the order
// is in the cursor itself. A task that was completed, reassigned or renamed since is still
// a place to read on from; only the rows after it need to match the filters.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  TASK_PAGE_SIZE,
  taskSortDirection,
  type listTasks,
  type TaskList,
  type TaskSort,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type * as z from 'zod';
import { containing } from '../custom-values/custom-values.js';
import { requireRecord } from '../records/access.js';
import { present, version, type TaskOptions, type TaskRow } from './tasks.js';

type Query = z.output<typeof listTasks.query>;

/**
 * Where the business's calendar day starts, today or `days` on, in its own time zone
 * (tenancy.businesses.timezone, UTC unless the business chose one). Worked out on the
 * local clock, so a day that is 23 or 25 hours long still ends at its own midnight.
 */
function dayStart(businessId: string, days: 0 | 1): RawBuilder<Date> {
  const zone = sql`(select b.timezone from tenancy.businesses b where b.id = ${businessId})`;
  return sql<Date>`((date_trunc('day', now() at time zone ${zone})
    + ${sql.raw(String(days))} * interval '1 day') at time zone ${zone})`;
}

/** What each order compares, on the list's own rows and on the task a page starts after. */
const orderOf: Record<TaskSort, (alias?: 'a') => RawBuilder<unknown>> = {
  created: (alias) => sql.ref(alias === undefined ? 'created_at' : 'a.created_at'),
  due: (alias) => sql.ref(alias === undefined ? 'due_at' : 'a.due_at'),
  // Without regard to case, as a reader expects a list of titles to run.
  title: (alias) => sql`lower(${sql.ref(alias === undefined ? 'title' : 'a.title')})`,
};

async function conditionsOf(
  trx: DatabaseTransaction,
  invocation: Invocation,
  businessId: string,
  query: Query,
  recordId: string | undefined,
  options: TaskOptions,
): Promise<RawBuilder<SqlBool>[]> {
  const kept: RawBuilder<SqlBool>[] = [];
  if (query.scope === 'unassigned') kept.push(sql`assignee_user_id is null`);
  if (query.scope === 'mine')
    kept.push(
      invocation.context.actorKind === 'user' && invocation.context.userId !== undefined
        ? sql`assignee_user_id = ${invocation.context.userId}`
        : sql`false`,
    );
  if (query.assignee !== undefined) {
    // The same lookup an assignment makes: someone off the team is refused, not answered
    // with an empty list.
    const userId = await options.assignees.resolve(trx, invocation.context, query.assignee);
    kept.push(sql`assignee_user_id = ${userId}`);
  }
  if (query.due === 'overdue') kept.push(sql`due_at < now()`);
  if (query.due === 'today')
    kept.push(sql`(due_at >= ${dayStart(businessId, 0)} and due_at < ${dayStart(businessId, 1)})`);
  if (query.due === 'upcoming') kept.push(sql`due_at >= ${dayStart(businessId, 1)}`);
  // Compared in PostgreSQL: a Date would drop anything finer than a millisecond.
  if (query.dueFrom !== undefined) kept.push(sql`due_at >= ${query.dueFrom}::timestamptz`);
  if (query.dueBefore !== undefined) kept.push(sql`due_at < ${query.dueBefore}::timestamptz`);
  if (query.status === 'open') kept.push(sql`completed_at is null`);
  if (query.status === 'completed') kept.push(sql`completed_at is not null`);
  if (query.q !== undefined && query.q !== '') kept.push(sql`title ilike ${containing(query.q)}`);
  kept.push(
    recordId === undefined
      ? sql`(record_id is null or
      exists (select 1 from crm.contacts c where c.business_id = crm.tasks.business_id
        and c.id = crm.tasks.record_id and c.deleted_at is null) or
      exists (select 1 from crm.companies c where c.business_id = crm.tasks.business_id
        and c.id = crm.tasks.record_id and c.deleted_at is null) or
      exists (select 1 from crm.deals d where d.business_id = crm.tasks.business_id
        and d.id = crm.tasks.record_id and d.deleted_at is null))`
      : sql`record_id = ${recordId}`,
  );
  return kept;
}

/** The task a page starts after: one of this business and, for a record's list, this record. */
async function anchorOf(trx: DatabaseTransaction, after: string, recordId: string | undefined) {
  const id = parsePublicId('task', after);
  let anchors = trx
    .selectFrom('crm.tasks')
    .select('id')
    .select(sql<boolean>`due_at is not null`.as('dated'))
    .where('id', '=', id ?? '');
  if (recordId !== undefined) anchors = anchors.where('record_id', '=', recordId);
  const anchor = id === undefined ? undefined : await anchors.executeTakeFirst();
  if (anchor === undefined)
    throw new ValidationError([
      { path: '/after', code: 'unknown_task', message: 'Start after a task in this list.' },
    ]);
  return anchor;
}

export async function readTasks(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: Query,
  options: TaskOptions,
): Promise<TaskList> {
  const businessId = requireBusiness(invocation.context);
  const record =
    query.recordId === undefined ? undefined : await requireRecord(trx, query.recordId);
  const conditions = await conditionsOf(trx, invocation, businessId, query, record?.id, options);
  const kept = () => trx.selectFrom('crm.tasks').where((eb) => eb.and(conditions));
  const rows = () => kept().selectAll().select(version);
  const anchor =
    query.after === undefined ? undefined : await anchorOf(trx, query.after, record?.id);

  const sort = query.sort ?? 'created';
  const direction = taskSortDirection(sort, query.direction);
  const size = query.limit ?? TASK_PAGE_SIZE;
  const beyond = direction === 'asc' ? '>' : '<';
  const ordered = (start: { id: string } | undefined) =>
    (start === undefined
      ? rows()
      : rows().where(
          sql<SqlBool>`(${orderOf[sort]()}, id) ${sql.raw(beyond)} (
            select ${orderOf[sort]('a')}, a.id from crm.tasks a
            where a.business_id = ${businessId} and a.id = ${start.id})`,
        )
    )
      .orderBy(orderOf[sort](), direction)
      .orderBy('id', direction);
  // By due date, the tasks without one come last whichever way the list runs: a second
  // read in id order, begun when the dated tasks run out.
  const undated = (count: number, afterId?: string) =>
    (afterId === undefined ? rows() : rows().where('id', beyond, afterId))
      .where('due_at', 'is', null)
      .orderBy('id', direction)
      .limit(count)
      .execute();
  let found: TaskRow[];
  if (sort !== 'due')
    found = await ordered(anchor)
      .limit(size + 1)
      .execute();
  else if (anchor?.dated === false) found = await undated(size + 1, anchor.id);
  else {
    found = await ordered(anchor)
      .where('due_at', 'is not', null)
      .limit(size + 1)
      .execute();
    if (found.length <= size) found = [...found, ...(await undated(size + 1 - found.length))];
  }

  const { total } = await kept()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  const page = found.slice(0, size);
  const last = page.at(-1);
  return {
    canManage:
      !record?.trashed &&
      (invocation.permissions === 'all' || invocation.permissions.has('tasks.manage')),
    items: await present(trx, invocation, page, options),
    nextCursor: found.length > size && last !== undefined ? toPublicId('task', last.id) : null,
    total: Number(total),
  };
}
