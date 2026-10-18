import type { BulkTasksResult, Task } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { bulkBodyOf, outcomeOf, selectable, selectionAmong, toggled } from './task-bulk-rules';

const at = '2026-10-08T12:00:00.000Z';
function taskOf(id: string, title: string, rest: Partial<Task> = {}): Task {
  return {
    id,
    record: null,
    title,
    description: '',
    dueAt: null,
    assignee: null,
    completedAt: null,
    completedBy: null,
    createdAt: at,
    updatedAt: at,
    revision: 'a'.repeat(64),
    ...rest,
  };
}

const venue = taskOf('task_1', 'Confirm the venue');
const quote = taskOf('task_2', 'Send the quote');
const binned = taskOf('task_3', 'Call back', {
  record: { id: 'con_1', name: 'Maya Thompson', trashed: true },
});

describe('the ticked rows of the tasks page', () => {
  it('holds only tasks the reader may change, whose record is not in the trash', () => {
    expect(selectable(venue, true)).toBe(true);
    expect(selectable(venue, false)).toBe(false);
    expect(selectable(binned, true)).toBe(false);
    const all = new Set(['task_1', 'task_2', 'task_3', 'task_gone']);
    expect(selectionAmong(all, [quote, venue, binned], true)).toEqual([quote, venue]);
    expect(selectionAmong(all, [quote, venue], false)).toEqual([]);
    expect(selectionAmong(new Set(['task_2']), [venue, quote], true)).toEqual([quote]);
  });

  it('puts one task in or takes it out without touching the set it was given', () => {
    const before = new Set(['task_1']);
    expect([...toggled(before, 'task_2', true)]).toEqual(['task_1', 'task_2']);
    expect([...toggled(before, 'task_1', false)]).toEqual([]);
    expect([...before]).toEqual(['task_1']);
  });
});

describe('a bulk request on tasks', () => {
  it('names the ticked tasks with what was chosen', () => {
    expect(bulkBodyOf({ action: 'complete' }, [venue, quote])).toEqual({
      action: 'complete',
      ids: ['task_1', 'task_2'],
    });
    expect(bulkBodyOf({ action: 'assign', assignee: null }, [venue])).toEqual({
      action: 'assign',
      assignee: null,
      ids: ['task_1'],
    });
    expect(bulkBodyOf({ action: 'set_due', dueAt: at }, [quote])).toEqual({
      action: 'set_due',
      dueAt: at,
      ids: ['task_2'],
    });
  });

  it('reads the answer: how many changed, and each skipped task by title with its reason', () => {
    const result: BulkTasksResult = {
      action: 'delete',
      results: [
        { id: 'task_1', outcome: 'done', reason: null },
        { id: 'task_2', outcome: 'unchanged', reason: null },
        {
          id: 'task_3',
          outcome: 'skipped',
          reason: { code: 'record_in_trash', message: 'Its contact is in the trash.' },
        },
        {
          id: 'task_9',
          outcome: 'skipped',
          reason: { code: 'not_found', message: 'It no longer exists.' },
        },
      ],
      done: 1,
      unchanged: 1,
      skipped: 2,
    };
    expect(outcomeOf(result, [venue, quote, binned])).toEqual({
      action: 'delete',
      done: 1,
      unchanged: 1,
      skipped: [
        { id: 'task_3', title: 'Call back', message: 'Its contact is in the trash.' },
        { id: 'task_9', title: 'task_9', message: 'It no longer exists.' },
      ],
    });
  });
});
