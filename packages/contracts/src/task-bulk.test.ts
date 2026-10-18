import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  bulkTasksInput,
  bulkTasksResult,
  bulkUpdateTasks,
  TASK_BULK_LIMIT,
  taskBulkActions,
  taskBulkEndpoints,
  taskBulkSkipCodes,
} from './task-bulk.js';
import { MAX_TASK_PAGE_SIZE } from './tasks.js';

const uuid = (n: number) => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`;
const task = (n: number) => toPublicId('task', uuid(n));
const ids = [task(1), task(2)];

describe('a bulk action on tasks', () => {
  it('takes 1 to 100 tasks, each once: a whole page of the list fits one request', () => {
    expect(TASK_BULK_LIMIT).toBe(100);
    expect(TASK_BULK_LIMIT).toBeGreaterThanOrEqual(MAX_TASK_PAGE_SIZE);
    const many = Array.from({ length: TASK_BULK_LIMIT + 1 }, (_, n) => task(n));
    const remove = (named: string[]) => bulkTasksInput.safeParse({ action: 'delete', ids: named });
    expect(remove(many.slice(0, TASK_BULK_LIMIT)).success).toBe(true);
    expect(remove(many).success).toBe(false);
    expect(remove([]).success).toBe(false);
    expect(remove([task(1), task(1)]).success).toBe(false);
    expect(remove([toPublicId('contact', uuid(1))]).success).toBe(false);
  });

  it('is one of five actions, each with what it needs and nothing else', () => {
    expect(taskBulkActions).toEqual(['complete', 'reopen', 'assign', 'set_due', 'delete']);
    const membership = toPublicId('membership', uuid(5));
    for (const valid of [
      { action: 'complete', ids },
      { action: 'reopen', ids },
      { action: 'assign', ids, assignee: membership },
      { action: 'assign', ids, assignee: 'me' },
      { action: 'assign', ids, assignee: null },
      { action: 'set_due', ids, dueAt: '2026-10-12T09:00:00+03:00' },
      { action: 'set_due', ids, dueAt: null },
      { action: 'delete', ids },
    ])
      expect(bulkTasksInput.safeParse(valid).success, JSON.stringify(valid)).toBe(true);
    for (const wrong of [
      { action: 'complete', ids, completed: true },
      { action: 'reopen', ids, assignee: 'me' },
      { action: 'assign', ids },
      { action: 'assign', ids, assignee: 'someone' },
      { action: 'assign', ids, assignee: toPublicId('contact', uuid(5)) },
      { action: 'set_due', ids },
      { action: 'set_due', ids, dueAt: '2026-10-12' },
      { action: 'set_due', ids, dueAt: '2026-10-12T09:00:00' },
      { action: 'set_due', ids, dueAt: '0000-01-01T00:00:00Z' },
      { action: 'delete', ids, revision: 'a'.repeat(64) },
      { action: 'trash', ids },
      { action: 'complete' },
      { ids },
    ])
      expect(bulkTasksInput.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
  });

  it('answers what became of each task, with a reason for one left as it was', () => {
    expect(taskBulkSkipCodes).toEqual([
      'not_found',
      'record_in_trash',
      'changed',
      'assignee_unavailable',
    ]);
    const answer = {
      action: 'complete',
      results: [
        { id: task(1), outcome: 'done', reason: null },
        { id: task(2), outcome: 'unchanged', reason: null },
        { id: task(3), outcome: 'skipped', reason: { code: 'not_found', message: 'Not found.' } },
      ],
      done: 1,
      unchanged: 1,
      skipped: 1,
    };
    expect(bulkTasksResult.parse(answer).results).toHaveLength(3);
    for (const wrong of [
      { ...answer, results: [{ id: task(1), outcome: 'failed', reason: null }] },
      {
        ...answer,
        results: [{ id: task(1), outcome: 'skipped', reason: { code: 'in_trash', message: '' } }],
      },
      { ...answer, action: 'trash' },
      { ...answer, done: -1 },
    ])
      expect(bulkTasksResult.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
  });

  it('is one endpoint of the API, beside the single-task ones', () => {
    expect(taskBulkEndpoints).toEqual([bulkUpdateTasks]);
    expect(bulkUpdateTasks).toMatchObject({
      operationId: 'bulkUpdateTasks',
      method: 'post',
      path: '/tasks/bulk',
      group: 'Tasks',
    });
    expect(bulkUpdateTasks.response.status).toBe(200);
    expect(endpoints).toContain(bulkUpdateTasks);
  });
});
