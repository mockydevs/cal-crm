// What the tasks page works out before it draws: what its address is as a question to the
// server, how a tab, a chip or a heading changes the address, and a due time as a wall time
// and back. What the address may say is in tasks-search.ts, which the route reads first.
import { tasksSearchOf, type TasksSearch } from './tasks-search';

export { tasksSearchOf, type TasksSearch };

export type TaskListTab = 'all' | 'today' | 'overdue' | 'upcoming';
export type TaskStatusChoice = 'all' | 'open' | 'completed';
export type TaskSortColumn = 'title' | 'due';

const day = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The start of a day chosen in a date field, where the reader is; `addDays` later. */
function startOfDay(value: string | undefined, addDays = 0): Date | undefined {
  const match = value === undefined ? null : day.exec(value);
  if (match === null) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Whether a range of due dates ends before it starts, which the server refuses. */
export function rangeBackwards(search: TasksSearch): boolean {
  const from = startOfDay(search.from);
  const to = startOfDay(search.to);
  return from !== undefined && to !== undefined && to.getTime() < from.getTime();
}

/** The question the list asks the server: `listTasks` filters and orders on exactly these. */
export interface TaskListQuery {
  readonly scope: 'all' | 'mine' | 'unassigned';
  readonly status: TaskStatusChoice;
  readonly due?: 'today' | 'overdue' | 'upcoming';
  readonly dueFrom?: string;
  readonly dueBefore?: string;
  readonly assignee?: string;
  readonly q?: string;
  readonly sort?: TaskSortColumn;
  readonly direction?: 'asc' | 'desc';
  readonly limit: number;
  readonly after?: string;
}

/**
 * The list takes tasks due at or after `dueFrom` and before `dueBefore`, so the last day
 * chosen is included by asking for the day after it. A cursor is only good in the order it
 * was given in, so the order goes with every page.
 */
export function listQueryOf(
  search: TasksSearch,
  page: { readonly limit: number; readonly after: string | undefined },
): TaskListQuery {
  const from = startOfDay(search.from);
  const before = startOfDay(search.to, 1);
  const scoped = search.assignee === 'mine' || search.assignee === 'unassigned';
  return {
    scope: search.assignee === 'mine' || search.assignee === 'unassigned' ? search.assignee : 'all',
    status: search.status ?? 'all',
    ...(search.list === undefined ? {} : { due: search.list }),
    ...(from === undefined ? {} : { dueFrom: from.toISOString() }),
    ...(before === undefined ? {} : { dueBefore: before.toISOString() }),
    ...(search.assignee === undefined || scoped ? {} : { assignee: search.assignee }),
    ...(search.q === undefined ? {} : { q: search.q }),
    ...(search.sort === undefined
      ? {}
      : { sort: search.sort, direction: search.direction ?? ('asc' as const) }),
    limit: page.limit,
    ...(page.after === undefined ? {} : { after: page.after }),
  };
}

/**
 * A dated list opens on the tasks still open: a task done is no longer due work. The
 * Status chip can still ask for the others afterwards.
 */
export function withList(search: TasksSearch, list: TaskListTab): TasksSearch {
  return tasksSearchOf(
    list === 'all' ? { ...search, list: undefined } : { ...search, list, status: 'open' },
  );
}

export function withAssignee(search: TasksSearch, assignee: string): TasksSearch {
  return tasksSearchOf({ ...search, assignee });
}

export function withStatus(search: TasksSearch, status: string): TasksSearch {
  return tasksSearchOf({ ...search, status });
}

export function withTitle(search: TasksSearch, q: string): TasksSearch {
  return tasksSearchOf({ ...search, q });
}

export function withRange(
  search: TasksSearch,
  range: { readonly from?: string; readonly to?: string },
): TasksSearch {
  return tasksSearchOf({ ...search, ...range });
}

/** How a column is sorted now, in the words `aria-sort` takes. */
export function sortOf(
  search: TasksSearch,
  column: TaskSortColumn,
): 'ascending' | 'descending' | 'none' {
  if (search.sort !== column) return 'none';
  return search.direction === 'desc' ? 'descending' : 'ascending';
}

/** A press on a column's heading: upwards, then downwards, then newest first again. */
export function withSort(search: TasksSearch, column: TaskSortColumn): TasksSearch {
  const now = sortOf(search, column);
  return tasksSearchOf({
    ...search,
    sort: now === 'descending' ? undefined : column,
    direction: now === 'ascending' ? 'desc' : undefined,
  });
}

/** An instant as the wall time of this machine, in the form a date-and-time input holds. */
export function localTime(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  const part = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${part(date.getFullYear(), 4)}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}.${part(date.getMilliseconds(), 3)}`;
}

/** The offset from UTC a moment has here, such as "GMT+3", in the reader's language. */
export function utcOffset(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .filter((part) => part.type === 'timeZoneName')
    .map((part) => part.value)
    .join('');
}

/**
 * The instant a wall time of this machine is, or nothing when there is no such time: not a
 * date and time at all, or an hour the clocks skip when daylight saving starts.
 */
export function dueInstant(wall: string): string | undefined {
  const instant = new Date(wall);
  const asUtc = new Date(`${wall}Z`);
  if (
    !wall.includes('T') ||
    !Number.isFinite(instant.getTime()) ||
    !Number.isFinite(asUtc.getTime()) ||
    localTime(instant.toISOString()) !== asUtc.toISOString().slice(0, -1)
  )
    return undefined;
  return instant.toISOString();
}
