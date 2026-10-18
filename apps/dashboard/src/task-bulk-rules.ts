// What a bulk action on the Tasks page works out around its one request: which of the rows
// shown are ticked, what the request says, and what the answer means for the page. A page
// of the list holds at most a hundred tasks, which is the most the server takes at a time
// (TASK_BULK_LIMIT), so a selection is always one request.
import type { BulkTasksInput, BulkTasksResult, Task } from '@repo/contracts';

/** What the reader chose in the bar or its dialog, before the ticked tasks are named. */
export type TaskBulkChoice =
  | { readonly action: 'complete' | 'reopen' | 'delete' }
  | { readonly action: 'assign'; readonly assignee: string | null }
  | { readonly action: 'set_due'; readonly dueAt: string | null };

/** Whether a row can be ticked: the reader may change tasks and its record is not in the trash. */
export function selectable(task: Task, canManage: boolean): boolean {
  return canManage && task.record?.trashed !== true;
}

/** The ticked tasks among the ones shown, in the order shown. */
export function selectionAmong(
  selected: ReadonlySet<string>,
  shown: readonly Task[],
  canManage: boolean,
): Task[] {
  return shown.filter((task) => selectable(task, canManage) && selected.has(task.id));
}

/** The selection with one task put in or taken out. */
export function toggled(selected: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(selected);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function bulkBodyOf(choice: TaskBulkChoice, tasks: readonly Task[]): BulkTasksInput {
  return { ...choice, ids: tasks.map((task) => task.id) };
}

export interface SkippedTask {
  readonly id: string;
  /** The title the list had for it when the action ran. */
  readonly title: string;
  /** Why, in the server's words. */
  readonly message: string;
}

/** What became of the ticked tasks, for the page to say and to keep ticked. */
export interface BulkOutcome {
  readonly action: BulkTasksResult['action'];
  readonly done: number;
  readonly unchanged: number;
  readonly skipped: readonly SkippedTask[];
}

export function outcomeOf(result: BulkTasksResult, tasks: readonly Task[]): BulkOutcome {
  return {
    action: result.action,
    done: result.done,
    unchanged: result.unchanged,
    skipped: result.results
      .filter((each) => each.outcome === 'skipped')
      .map((each) => ({
        id: each.id,
        title: tasks.find((task) => task.id === each.id)?.title ?? each.id,
        message: each.reason?.message ?? '',
      })),
  };
}
