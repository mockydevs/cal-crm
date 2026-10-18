// Recurring tasks and task reminders, against a stand-in for the API: the task panel's
// Recurring Task section in GoHighLevel's words, the repeat mark and next due in the list,
// editing this task or the series, deleting the series' upcoming tasks, and Settings → My
// Notifications with the reminder time.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  createTaskInput,
  deleteTaskInput,
  notificationKinds,
  updateNotificationPreferencesInput,
  updateTaskInput,
  type Task,
} from '@repo/contracts';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

const at = '2026-10-08T12:00:00.000Z';

const weekly: Task = {
  id: 'task_01m4bd188ff82s0add91b7p101',
  record: null,
  title: 'Weekly report',
  description: '',
  dueAt: '2026-10-12T06:00:00.000Z',
  assignee: null,
  completedAt: null,
  completedBy: null,
  createdAt: at,
  updatedAt: at,
  revision: 'a'.repeat(64),
  recurrence: {
    frequency: 'weekly',
    every: 1,
    ends: { type: 'never' },
    createIfOverdue: false,
    occurrence: 2,
    active: true,
    nextDueAt: '2026-10-19T06:00:00.000Z',
  },
};

interface Api {
  tasks: Task[];
  readonly created: unknown[];
  readonly updated: unknown[];
  readonly deleted: unknown[];
}

async function fakeApi(page: Page, tasks: Task[]): Promise<Api> {
  const api: Api = { tasks, created: [], updated: [], deleted: [] };
  await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = createTaskInput.parse(request.postDataJSON());
      api.created.push(input);
      const made: Task = {
        ...weekly,
        id: `task_01m4bd188ff82s0add91b7p${String(200 + api.created.length)}`,
        title: input.title,
        dueAt: input.dueAt,
        recurrence:
          input.recurrence === undefined
            ? undefined
            : {
                frequency: input.recurrence.frequency,
                every: input.recurrence.every,
                ends: input.recurrence.ends,
                createIfOverdue: input.recurrence.createIfOverdue,
                occurrence: 0,
                active: true,
                nextDueAt: '2026-10-29T06:00:00.000Z',
              },
      };
      api.tasks = [made, ...api.tasks];
      return route.fulfill({ status: 201, json: made });
    }
    return route.fulfill({
      json: { canManage: true, items: api.tasks, nextCursor: null, total: api.tasks.length },
    });
  });
  await page.route(/\/api\/v1\/tasks\/task_[^/]+$/, (route) => {
    const request = route.request();
    const id = /\/tasks\/(task_[^/]+)$/.exec(request.url())?.[1];
    const current = api.tasks.find((task) => task.id === id);
    if (current === undefined) return route.fulfill({ status: 404, json: {} });
    if (request.method() === 'DELETE') {
      api.deleted.push(deleteTaskInput.parse(request.postDataJSON()));
      api.tasks = api.tasks.filter((task) => task.id !== id);
      return route.fulfill({ status: 204 });
    }
    const input = updateTaskInput.parse(request.postDataJSON());
    api.updated.push(input);
    const next: Task = {
      ...current,
      title: input.title,
      revision: 'b'.repeat(64),
      ...(input.recurrence === null && current.recurrence !== undefined
        ? { recurrence: { ...current.recurrence, active: false, nextDueAt: null } }
        : {}),
    };
    api.tasks = api.tasks.map((task) => (task.id === id ? next : task));
    return route.fulfill({ json: next });
  });
  return api;
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.use({ timezoneId: 'Africa/Nairobi' });

test('makes a recurring task with GoHighLevel’s choices, and marks it in the list', async ({
  page,
}) => {
  await signedIn(page);
  const api = await fakeApi(page, [weekly]);
  await page.goto(inHarbor('/tasks'));
  const row = page.getByRole('row').filter({ hasText: 'Weekly report' });
  await expect(row.getByText('Repeats every week. Next due', { exact: false })).toBeAttached();
  await page.getByRole('button', { name: 'Add Task', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'New task', exact: true });
  await adding.getByLabel('Title', { exact: true }).fill('Water the plants');
  await adding
    .getByLabel('Due date and time (Africa/Nairobi)', { exact: true })
    .fill('2026-10-15T09:00');
  await adding.getByRole('checkbox', { name: 'Recurring Task', exact: true }).check();
  await adding.getByRole('textbox', { name: 'Repeats every', exact: true }).fill('2');
  await choose(adding.getByRole('combobox', { name: 'Unit', exact: true }), 'weekly');
  await adding.getByRole('radio', { name: 'Custom Date', exact: true }).check();
  await adding.getByLabel('End date', { exact: true }).fill('2026-12-31');
  await adding
    .getByRole('checkbox', {
      name: 'Create a new task even if the previous one is overdue',
      exact: true,
    })
    .check();
  await expectNoAccessibilityViolations(page);
  await adding.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(adding).toBeHidden();
  expect(api.created).toEqual([
    {
      recordId: null,
      title: 'Water the plants',
      description: '',
      dueAt: '2026-10-15T06:00:00.000Z',
      assignee: null,
      recurrence: {
        frequency: 'weekly',
        every: 2,
        ends: { type: 'on', date: '2026-12-31' },
        createIfOverdue: true,
      },
    },
  ]);
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Water the plants' })
      .getByText('Repeats every 2 weeks. Next due', { exact: false }),
  ).toBeAttached();
});

test('edits this task alone, or the series, and stops it', async ({ page }) => {
  await signedIn(page);
  const api = await fakeApi(page, [weekly]);
  await page.goto(inHarbor('/tasks'));
  await page.getByRole('button', { name: 'Edit Weekly report', exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(editing.getByRole('radio', { name: 'This task only', exact: true })).toBeChecked();
  await expect(editing.getByRole('checkbox', { name: 'Keep repeating', exact: true })).toHaveCount(
    0,
  );
  await editing.getByRole('radio', { name: 'This and all future tasks', exact: true }).check();
  await editing.getByRole('checkbox', { name: 'Keep repeating', exact: true }).uncheck();
  await expectNoAccessibilityViolations(page);
  await editing.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editing).toBeHidden();
  expect(api.updated).toEqual([
    {
      title: 'Weekly report',
      description: '',
      dueAt: '2026-10-12T06:00:00.000Z',
      assignee: null,
      revision: 'a'.repeat(64),
      applyTo: 'series',
      recurrence: null,
    },
  ]);
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Weekly report' })
      .getByText('The series has ended.', { exact: false }),
  ).toBeAttached();
});

test('deletes a task of a series alone, or with its upcoming tasks', async ({ page }) => {
  await signedIn(page);
  const api = await fakeApi(page, [weekly]);
  await page.goto(inHarbor('/tasks'));
  await page.getByRole('button', { name: 'Delete Weekly report', exact: true }).click();
  const asking = page.getByRole('dialog', { name: 'Delete Weekly report?', exact: true });
  await asking
    .getByRole('checkbox', { name: 'Also delete all upcoming tasks in this series', exact: true })
    .check();
  await expectNoAccessibilityViolations(page);
  await asking.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(asking).toBeHidden();
  expect(api.deleted).toEqual([{ revision: 'a'.repeat(64), applyTo: 'series' }]);
});

test('chooses how long before a task is due to be reminded, in My Notifications', async ({
  page,
}) => {
  await signedIn(page);
  const saved: unknown[] = [];
  let remindMinutes: number | null = null;
  const preferences = () => ({
    items: notificationKinds.map((kind) =>
      kind === 'task.reminder' ? { kind, inApp: true, remindMinutes } : { kind, inApp: true },
    ),
  });
  await page.route('**/api/v1/notification-preferences', (route) => {
    if (route.request().method() === 'PUT') {
      const input = updateNotificationPreferencesInput.parse(route.request().postDataJSON());
      saved.push(input);
      remindMinutes =
        input.items.find((item) => item.kind === 'task.reminder')?.remindMinutes ?? null;
    }
    return route.fulfill({ json: preferences() });
  });
  await page.goto(inHarbor('/settings/notifications'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'My Notifications', exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Remind me', exact: true }).fill('2');
  await choose(page.getByRole('combobox', { name: 'Unit', exact: true }), 'hours');
  await expectNoAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Your notification settings are saved.', { exact: true }),
  ).toBeVisible();
  expect(saved).toHaveLength(1);
  expect(remindMinutes).toBe(120);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Remind me', exact: true })).toHaveValue('2');
});
