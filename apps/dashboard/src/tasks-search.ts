// What the tasks page's address may say. On its own, and with nothing imported, because
// the route checks its address before the page is fetched: everything in this file is part
// of what every visitor downloads first.

/** What the address keeps: only what differs from every task, newest first. */
export interface TasksSearch {
  readonly list?: 'today' | 'overdue' | 'upcoming';
  /** `mine`, `unassigned`, or the membership id of one person on the team. */
  readonly assignee?: string;
  readonly status?: 'open' | 'completed';
  /** Part of a title. */
  readonly q?: string;
  readonly sort?: 'title' | 'due';
  /** Kept only when it is not the way a column first sorts, which is upwards. */
  readonly direction?: 'desc';
  /** The first and last day of a range of due dates, each as YYYY-MM-DD. */
  readonly from?: string;
  readonly to?: string;
}

const day = /^\d{4}-\d\d-\d\d$/;
const who = /^(mine|unassigned|mem_[0-9a-z]{26})$/;

export function tasksSearchOf(search: Record<string, unknown>): TasksSearch {
  const { list, assignee, status, q, sort, direction, from, to } = search;
  const text = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  const sorted = sort === 'title' || sort === 'due';
  return {
    ...(list === 'today' || list === 'overdue' || list === 'upcoming' ? { list } : {}),
    ...(typeof assignee === 'string' && who.test(assignee) ? { assignee } : {}),
    ...(status === 'open' || status === 'completed' ? { status } : {}),
    ...(text === '' ? {} : { q: text }),
    ...(sorted ? { sort } : {}),
    ...(sorted && direction === 'desc' ? { direction } : {}),
    ...(typeof from === 'string' && day.test(from) ? { from } : {}),
    ...(typeof to === 'string' && day.test(to) ? { to } : {}),
  };
}
