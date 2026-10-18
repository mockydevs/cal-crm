import { expect, it } from 'vitest';
import {
  createTaskInput,
  updateTaskInput,
  completeTaskInput,
  deleteTaskInput,
  task,
  listTasks,
  listTaskAssignees,
  taskList,
  taskSorts,
  TASK_PAGE_SIZE,
  MAX_TASK_PAGE_SIZE,
} from './tasks.js';

it('accepts an assigned record task with an explicit timezone and refuses forged completion', () => {
  const input = {
    recordId: 'con_01h455vb4pex5vsknk084sn02q',
    title: '  Call Maya  ',
    description: 'Confirm the venue.',
    dueAt: '2026-10-09T09:00:00+03:00',
    assignee: 'me',
  };
  expect(createTaskInput.parse(input)).toEqual({ ...input, title: 'Call Maya' });
  expect(createTaskInput.safeParse({ ...input, completedAt: '2026-10-08T12:00:00Z' }).success).toBe(
    false,
  );
  expect(createTaskInput.safeParse({ ...input, createdById: 'someone-else' }).success).toBe(false);
  expect(createTaskInput.safeParse({ ...input, dueAt: '2026-10-09T09:00' }).success).toBe(false);
  expect(createTaskInput.safeParse({ ...input, title: ' ' }).success).toBe(false);
  expect(updateTaskInput.safeParse({ ...input, revision: 'stale' }).success).toBe(false);
});

it('edits task details without moving their record and completes only a matching revision', () => {
  const revision = 'a'.repeat(64);
  expect(
    updateTaskInput.parse({
      title: 'Call Maya',
      description: '',
      dueAt: null,
      assignee: null,
      revision,
    }),
  ).toEqual({
    title: 'Call Maya',
    description: '',
    dueAt: null,
    assignee: null,
    revision,
  });
  expect(updateTaskInput.safeParse({ title: 'Call Maya', revision, recordId: null }).success).toBe(
    false,
  );
  expect(completeTaskInput.parse({ completed: false, revision })).toEqual({
    completed: false,
    revision,
  });
  expect(
    completeTaskInput.safeParse({ completed: true, revision, completedById: 'forged' }).success,
  ).toBe(false);
  expect(listTasks.query.parse({})).toEqual({ scope: 'all', status: 'open', due: 'any' });
  expect(listTasks.query.parse({ scope: 'mine', due: 'overdue' })).toMatchObject({
    scope: 'mine',
    status: 'open',
    due: 'overdue',
  });
});

it('requires complete task edits and refuses unknown query filters', () => {
  const input = {
    title: 'Call Maya',
    description: '',
    dueAt: null,
    assignee: null,
    revision: 'a'.repeat(64),
  };
  for (const key of ['description', 'dueAt', 'assignee'] as const) {
    const { [key]: _omitted, ...incomplete } = input;
    expect(updateTaskInput.safeParse(incomplete).success).toBe(false);
  }
  expect(listTasks.query.safeParse({ sort: 'oldest' }).success).toBe(false);
  expect(listTaskAssignees.query.safeParse({ userId: 'arbitrary' }).success).toBe(false);
});

it('leaves a list request without the new filters exactly as it was', () => {
  expect(listTasks.query.parse({})).toEqual({ scope: 'all', status: 'open', due: 'any' });
  expect(listTasks.query.parse({ scope: 'unassigned', status: 'all' })).toEqual({
    scope: 'unassigned',
    status: 'all',
    due: 'any',
  });
});

it('reads a page size, due views, a due range, one assignee, a title search and an order', () => {
  const assignee = 'mem_01h455vb4pex5vsknk084sn02q';
  expect(
    listTasks.query.parse({
      due: 'today',
      dueFrom: '2026-10-11T00:00:00+03:00',
      dueBefore: '2026-10-12T00:00:00+03:00',
      assignee,
      q: '  call maya  ',
      sort: 'due',
      direction: 'desc',
      limit: '25',
    }),
  ).toEqual({
    scope: 'all',
    status: 'open',
    due: 'today',
    dueFrom: '2026-10-11T00:00:00+03:00',
    dueBefore: '2026-10-12T00:00:00+03:00',
    assignee,
    q: 'call maya',
    sort: 'due',
    direction: 'desc',
    limit: 25,
  });
  expect(listTasks.query.parse({ due: 'upcoming' }).due).toBe('upcoming');
  for (const sort of taskSorts) expect(listTasks.query.parse({ sort }).sort).toBe(sort);
  expect(taskSorts).toEqual(['created', 'due', 'title']);
  expect(listTasks.query.parse({ limit: String(MAX_TASK_PAGE_SIZE) }).limit).toBe(100);
  expect(TASK_PAGE_SIZE).toBe(50);
  expect(listTasks.query.parse({ q: 'a'.repeat(200) }).q).toHaveLength(200);
});

it('refuses list filters that cannot be answered', () => {
  const assignee = 'mem_01h455vb4pex5vsknk084sn02q';
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { limit: '2.5' },
    { limit: 'many' },
    { due: 'tomorrow' },
    { dueFrom: '2026-10-11' },
    { dueBefore: '2026-10-11T00:00' },
    { dueFrom: '0000-01-01T00:00:00Z' },
    { assignee: 'me' },
    { assignee: 'con_01h455vb4pex5vsknk084sn02q' },
    { q: 'a'.repeat(201) },
    { sort: 'updated' },
    { direction: 'up' },
  ])
    expect(listTasks.query.safeParse(query).success, JSON.stringify(query)).toBe(false);
  // One way of naming whose tasks: scope, or one member.
  for (const scope of ['mine', 'unassigned']) {
    const refused = listTasks.query.safeParse({ scope, assignee });
    expect(refused.error?.issues.map((issue) => issue.path)).toEqual([['assignee']]);
  }
  expect(listTasks.query.safeParse({ scope: 'all', assignee }).success).toBe(true);
  // A range runs from its start up to, not including, its end.
  const from = '2026-10-11T00:00:00Z';
  for (const dueBefore of [from, '2026-10-10T23:59:59Z', '2026-10-11T02:00:00+03:00']) {
    const refused = listTasks.query.safeParse({ dueFrom: from, dueBefore });
    expect(refused.error?.issues.map((issue) => issue.path)).toEqual([['dueBefore']]);
  }
  expect(
    listTasks.query.safeParse({ dueFrom: from, dueBefore: '2026-10-11T00:00:00.001Z' }).success,
  ).toBe(true);
});

it('carries a total on a task list, and still reads a list without one', () => {
  expect(taskList.parse({ canManage: true, items: [], nextCursor: null, total: 0 }).total).toBe(0);
  expect(taskList.parse({ canManage: true, items: [], nextCursor: null }).total).toBeUndefined();
  for (const total of [-1, 1.5, '3'])
    expect(
      taskList.safeParse({ canManage: true, items: [], nextCursor: null, total }).success,
    ).toBe(false);
});

it('takes a recurrence on a new task, and this or the series on an edit or a deletion', () => {
  const revision = 'b'.repeat(64);
  expect(
    createTaskInput.parse({
      title: 'Weekly review',
      dueAt: '2026-10-19T09:00:00-04:00',
      recurrence: { frequency: 'weekly' },
    }).recurrence,
  ).toEqual({ frequency: 'weekly', every: 1, ends: { type: 'never' }, createIfOverdue: false });
  expect(createTaskInput.parse({ title: 'Once' })).not.toHaveProperty('recurrence');
  const edit = { title: 'Weekly review', description: '', dueAt: null, assignee: null, revision };
  expect(updateTaskInput.parse({ ...edit, applyTo: 'series', recurrence: null })).toMatchObject({
    applyTo: 'series',
    recurrence: null,
  });
  expect(updateTaskInput.parse(edit)).not.toHaveProperty('applyTo');
  expect(updateTaskInput.safeParse({ ...edit, applyTo: 'all' }).success).toBe(false);
  expect(deleteTaskInput.parse({ revision, applyTo: 'series' })).toEqual({
    revision,
    applyTo: 'series',
  });
  expect(deleteTaskInput.parse({ revision })).toEqual({ revision });
});

it('reads a task of a series with how it repeats, and a task without one as before', () => {
  const base = {
    id: 'task_01h455vb4pex5vsknk084sn02q',
    record: null,
    title: 'Weekly review',
    description: '',
    dueAt: '2026-10-19T13:00:00.000Z',
    assignee: null,
    completedAt: null,
    completedBy: null,
    createdAt: '2026-10-12T13:00:00.000Z',
    updatedAt: '2026-10-12T13:00:00.000Z',
    revision: 'c'.repeat(64),
  };
  expect(task.parse(base)).not.toHaveProperty('recurrence');
  const recurrence = {
    frequency: 'weekly',
    every: 1,
    ends: { type: 'after', occurrences: 4 },
    createIfOverdue: false,
    occurrence: 1,
    active: true,
    nextDueAt: '2026-10-26T13:00:00.000Z',
  };
  expect(task.parse({ ...base, recurrence }).recurrence).toEqual(recurrence);
  expect(task.safeParse({ ...base, recurrence: { ...recurrence, every: 0 } }).success).toBe(false);
});

it('refuses a recurring due date more than one repeat in the past, and nothing else old', () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const day = 86_400_000;
  const issue = (input: unknown, schema: typeof createTaskInput | typeof updateTaskInput) => {
    const parsed = schema.safeParse(input);
    return parsed.success ? undefined : parsed.error.issues.map((each) => each.path.join('/'));
  };
  const daily = { frequency: 'daily' } as const;
  expect(issue({ title: 'Old', dueAt: ago(2 * day), recurrence: daily }, createTaskInput)).toEqual([
    'dueAt',
  ]);
  expect(issue({ title: 'Recent', dueAt: ago(day / 2), recurrence: daily }, createTaskInput)).toBe(
    undefined,
  );
  expect(issue({ title: 'Once', dueAt: '0001-01-01T09:00:00Z' }, createTaskInput)).toBe(undefined);
  expect(
    issue(
      { title: 'Monthly', dueAt: ago(20 * day), recurrence: { frequency: 'monthly' } },
      createTaskInput,
    ),
  ).toBe(undefined);
  const edit = { title: 'Old', description: '', assignee: null, revision: 'd'.repeat(64) };
  expect(
    issue({ ...edit, dueAt: '0001-01-01T09:00:00Z', recurrence: daily }, updateTaskInput),
  ).toEqual(['dueAt']);
  // Stopping a series, or an edit without a rule, may keep an old due date.
  expect(
    issue({ ...edit, dueAt: ago(400 * day), applyTo: 'series', recurrence: null }, updateTaskInput),
  ).toBe(undefined);
});
