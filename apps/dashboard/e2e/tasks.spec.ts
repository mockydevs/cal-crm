import { choose, expectChoice } from './select';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  bulkTasksInput,
  createTaskInput,
  updateTaskInput,
  completeTaskInput,
  deleteTaskInput,
  type Task,
} from '@repo/contracts';
import { emptyContactPanels } from './contact-panels';
import { reachesRightGutter } from './lists';
import { configurationOf } from './tag-fixtures';
import { signedIn, inHarbor } from './session';

const recordId = 'con_01m4bd188ff82s0add91b7pz63';
const taskId = 'task_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';

async function contactTaskPage(page: Page): Promise<void> {
  await signedIn(page);
  await emptyContactPanels(page);
  await page.route(`**/api/v1/contacts/${recordId}`, (route) =>
    route.fulfill({
      json: {
        id: recordId,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: [],
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        canManage: true,
      },
    }),
  );
  await page.route(`**/api/v1/records/${recordId}/tags`, (route) =>
    route.fulfill({ json: { canManage: false, items: [] } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
}

// Contacts → Tasks, against a stand-in for the task endpoints that keeps what is changed
// and filters as the server does.
interface TasksApi {
  tasks: Task[];
  /** False for someone who may read tasks and not change them. */
  canManage: boolean;
  readonly reads: URLSearchParams[];
  readonly created: unknown[];
  /** Each bulk request, as it was sent. */
  readonly bulk: unknown[];
  /** Tasks a bulk request leaves alone, as changed by someone else meanwhile. */
  skipInBulk: string[];
}

const danaMember = { id: 'mem_01m4bd188ff82s0add91b7pz63', name: 'Dana Brooks', you: true };
const leeMember = { id: 'mem_01m4bd188ff82s0add91b7pz64', name: 'Lee Park', you: false };
const nextRevision = (revision: string): string =>
  (revision.startsWith('a') ? 'b' : 'c').repeat(64);

function pageTask(number: number, title: string, rest: Partial<Task> = {}): Task {
  return {
    id: `task_01m4bd188ff82s0add91b7p${String(number).padStart(3, '0')}`,
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

async function fakeTasksApi(page: Page, tasks: Task[]): Promise<TasksApi> {
  const api: TasksApi = {
    tasks,
    canManage: true,
    reads: [],
    created: [],
    bulk: [],
    skipInBulk: [],
  };
  const conflict = (route: Route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/problem+json',
      json: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'This task changed. Refresh it before saving, completing or deleting.',
      },
    });
  const assigneeOf = (value: string | null): Task['assignee'] =>
    value === null
      ? null
      : value === 'me'
        ? { membershipId: danaMember.id, name: danaMember.name, you: true }
        : { membershipId: leeMember.id, name: leeMember.name, you: false };
  await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [danaMember, leeMember], nextCursor: null } }),
  );
  await page.route(/\/api\/v1\/contacts\?(?:.*&)?q=/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: recordId,
            name: 'Maya Thompson',
            email: 'maya@example.com',
            phone: null,
            createdAt: at,
          },
        ],
        next: null,
        canManage: true,
      },
    }),
  );
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = createTaskInput.parse(request.postDataJSON());
      api.created.push(input);
      const made = pageTask(900 + api.created.length, input.title, {
        description: input.description,
        dueAt: input.dueAt,
        assignee: assigneeOf(input.assignee),
        record:
          input.recordId === null
            ? null
            : { id: input.recordId, name: 'Maya Thompson', trashed: false },
      });
      api.tasks = [made, ...api.tasks];
      return route.fulfill({ status: 201, json: made });
    }
    const query = new URL(request.url()).searchParams;
    if (query.has('recordId')) return route.fallback();
    api.reads.push(query);
    const scope = query.get('scope') ?? 'all';
    const status = query.get('status') ?? 'open';
    const due = query.get('due') ?? 'any';
    const dueFrom = query.get('dueFrom');
    const dueBefore = query.get('dueBefore');
    const assignee = query.get('assignee');
    const q = (query.get('q') ?? '').toLowerCase();
    // The business's day, for this stand-in: 8 October 2026.
    const matched = api.tasks.filter(
      (task) =>
        (scope === 'all' ||
          (scope === 'mine' ? task.assignee?.you === true : task.assignee === null)) &&
        (status === 'all' || (status === 'open') === (task.completedAt === null)) &&
        (due === 'any' ||
          (task.dueAt !== null &&
            (due === 'overdue'
              ? task.dueAt < '2026-10-08T00:00:00.000Z'
              : due === 'today'
                ? task.dueAt.startsWith('2026-10-08')
                : task.dueAt >= '2026-10-09T00:00:00.000Z'))) &&
        (dueFrom === null || (task.dueAt !== null && task.dueAt >= dueFrom)) &&
        (dueBefore === null || (task.dueAt !== null && task.dueAt < dueBefore)) &&
        (assignee === null || task.assignee?.membershipId === assignee) &&
        task.title.toLowerCase().includes(q),
    );
    const sort = query.get('sort');
    const way = query.get('direction') === 'desc' ? -1 : 1;
    const ordered =
      sort === 'title'
        ? matched.toSorted((one, other) => way * one.title.localeCompare(other.title))
        : sort === 'due'
          ? matched.toSorted((one, other) =>
              one.dueAt === null || other.dueAt === null
                ? Number(one.dueAt === null) - Number(other.dueAt === null)
                : way * one.dueAt.localeCompare(other.dueAt),
            )
          : matched;
    const limit = Number(query.get('limit') ?? '50');
    const start = ordered.findIndex((task) => task.id === query.get('after')) + 1;
    const items = ordered.slice(start, start + limit);
    return route.fulfill({
      json: {
        canManage: api.canManage,
        items,
        nextCursor: start + limit < ordered.length ? (items.at(-1)?.id ?? null) : null,
        total: ordered.length,
      },
    });
  });
  await page.route('**/api/v1/tasks/bulk', (route) => {
    const input = bulkTasksInput.parse(route.request().postDataJSON());
    api.bulk.push(input);
    const results = input.ids.map((id) => {
      const current = api.tasks.find((task) => task.id === id);
      if (current === undefined || api.skipInBulk.includes(id))
        return {
          id,
          outcome: 'skipped' as const,
          reason: {
            code: 'changed' as const,
            message: 'Someone else changed it just now. Try again.',
          },
        };
      const next: Task | undefined =
        input.action === 'delete'
          ? undefined
          : input.action === 'assign'
            ? { ...current, assignee: assigneeOf(input.assignee) }
            : input.action === 'set_due'
              ? { ...current, dueAt: input.dueAt }
              : {
                  ...current,
                  completedAt: input.action === 'complete' ? at : null,
                  completedBy:
                    input.action === 'complete'
                      ? { kind: 'user', name: 'Dana Brooks', you: true }
                      : null,
                };
      if (
        next?.completedAt === current.completedAt &&
        next.dueAt === current.dueAt &&
        next.assignee?.membershipId === current.assignee?.membershipId
      )
        return { id, outcome: 'unchanged' as const, reason: null };
      api.tasks =
        next === undefined
          ? api.tasks.filter((task) => task.id !== id)
          : api.tasks.map((task) =>
              task.id === id ? { ...next, revision: nextRevision(current.revision) } : task,
            );
      return { id, outcome: 'done' as const, reason: null };
    });
    const count = (outcome: string): number =>
      results.filter((each) => each.outcome === outcome).length;
    return route.fulfill({
      json: {
        action: input.action,
        results,
        done: count('done'),
        unchanged: count('unchanged'),
        skipped: count('skipped'),
      },
    });
  });
  await page.route(/\/api\/v1\/tasks\/task_[^/]+(?:\/completion)?$/, (route) => {
    const request = route.request();
    const [, id, completion] = /\/tasks\/(task_[^/]+)(\/completion)?$/.exec(request.url()) ?? [];
    const current = api.tasks.find((task) => task.id === id);
    if (current === undefined) return route.fulfill({ status: 404, json: {} });
    const replace = (next: Task) => {
      api.tasks = api.tasks.map((task) => (task.id === id ? next : task));
      return route.fulfill({ json: next });
    };
    if (completion !== undefined) {
      const input = completeTaskInput.parse(request.postDataJSON());
      if (input.revision !== current.revision) return conflict(route);
      return replace({
        ...current,
        completedAt: input.completed ? at : null,
        completedBy: input.completed ? { kind: 'user', name: 'Dana Brooks', you: true } : null,
        revision: nextRevision(current.revision),
      });
    }
    if (request.method() === 'DELETE') {
      const input = deleteTaskInput.parse(request.postDataJSON());
      if (input.revision !== current.revision) return conflict(route);
      api.tasks = api.tasks.filter((task) => task.id !== id);
      return route.fulfill({ status: 204 });
    }
    const input = updateTaskInput.parse(request.postDataJSON());
    if (input.revision !== current.revision) return conflict(route);
    return replace({
      ...current,
      title: input.title,
      description: input.description,
      dueAt: input.dueAt,
      assignee: assigneeOf(input.assignee),
      revision: nextRevision(current.revision),
    });
  });
  return api;
}

const tasksTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Tasks table', exact: true }).getByRole('table');
const taskRow = (page: Page, title: string): Locator =>
  tasksTable(page).getByRole('row').filter({ hasText: title });
// While a panel is open the page behind it is inert, so its notice is found by its markup.
const pageNotice = (page: Page): Locator => page.locator('main p.sr-only[role="status"]');

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const seededTasks = (): Task[] => [
  pageTask(1, 'Confirm the venue', {
    description: 'Call the harbour office before noon and ask about the loading bay.',
    record: { id: recordId, name: 'Maya Thompson', trashed: false },
    assignee: { membershipId: danaMember.id, name: danaMember.name, you: true },
    dueAt: '2026-10-07T09:00:00.000Z',
  }),
  pageTask(2, 'Send the quote', {
    assignee: { membershipId: leeMember.id, name: leeMember.name, you: false },
    completedAt: at,
    completedBy: { kind: 'user', name: 'Lee Park', you: false },
  }),
  pageTask(3, 'Order the flowers'),
];

for (const width of [1440, 360]) {
  test.describe(`${String(width)} px tasks page`, () => {
    test.use({ viewport: { width, height: 1000 }, timezoneId: 'Africa/Nairobi' });

    test('lists every task, filters as the server does and keeps the filters in the address', async ({
      page,
    }, testInfo) => {
      await signedIn(page);
      const api = await fakeTasksApi(page, seededTasks());
      await page.goto(inHarbor('/tasks'));
      await expect(
        page.getByRole('heading', { level: 1, name: 'Tasks', exact: true }),
      ).toBeVisible();
      await expect(page).toHaveTitle('Tasks · Harbor Lights Events');
      await expect(
        page
          .getByRole('navigation', { name: 'Contacts', exact: true })
          .getByRole('link', { name: 'Tasks', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(tasksTable(page).getByRole('columnheader')).toHaveText([
        'Status',
        'Title',
        'Description',
        'Associated record',
        'Assignee',
        'Due date (Africa/Nairobi)',
        'Actions',
      ]);
      const venue = taskRow(page, 'Confirm the venue');
      await expect(venue.getByRole('link', { name: 'Maya Thompson', exact: true })).toHaveAttribute(
        'href',
        inHarbor(`/contacts/${recordId}`),
      );
      await expect(venue.locator('time[datetime="2026-10-07T09:00:00.000Z"]')).toHaveText(
        /Oct 7, 2026, 12:00/,
      );
      await expect(venue.getByRole('cell').nth(4)).toHaveText('You');
      await expect(taskRow(page, 'Send the quote').getByRole('cell').nth(4)).toHaveText('Lee Park');
      await expect(taskRow(page, 'Order the flowers').getByRole('cell').nth(4)).toHaveText(
        'Unassigned',
      );
      await expect(
        taskRow(page, 'Send the quote').getByRole('button', {
          name: 'Reopen Send the quote',
          exact: true,
        }),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(api.reads.at(-1)?.toString()).toBe('scope=all&status=all&limit=20');
      await expect(page.getByText('3 Tasks', { exact: true })).toBeVisible();
      await expectNoAccessibilityViolations(page);

      // Overdue: what is past its due time and still open.
      const lists = page.getByRole('group', { name: 'Task lists', exact: true });
      await lists.getByRole('button', { name: 'Overdue', exact: true }).click();
      await expect(page).toHaveURL(/list=overdue/);
      await expect(tasksTable(page).getByRole('rowheader')).toHaveText(['Confirm the venue']);
      expect(api.reads.at(-1)?.toString()).toBe('scope=all&status=open&due=overdue&limit=20');
      await expect(page.getByText('1 Task', { exact: true })).toBeVisible();
      await expectChoice(page.getByRole('combobox', { name: 'Status', exact: true }), 'open');
      await lists.getByRole('button', { name: 'All', exact: true }).click();

      await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'completed');
      await expect(tasksTable(page).getByRole('rowheader')).toHaveText(['Send the quote']);
      await choose(page.getByRole('combobox', { name: 'Assignee', exact: true }), 'unassigned');
      await expect(page.getByText('No tasks match.', { exact: true })).toBeVisible();
      await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'all');
      await expect(tasksTable(page).getByRole('rowheader')).toHaveText(['Order the flowers']);
      await expect(page).toHaveURL(/assignee=unassigned/);
      await page.reload();
      await expectChoice(
        page.getByRole('combobox', { name: 'Assignee', exact: true }),
        'unassigned',
      );
      await expect(tasksTable(page).getByRole('rowheader')).toHaveText(['Order the flowers']);
      await expect(
        page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status'),
      ).toHaveText('1 - 1 of 1');
      await expectNoAccessibilityViolations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('tasks.png'), fullPage: true });
    });

    test('reads due today and upcoming, searches, sorts, names one person, a range and a page size', async ({
      page,
    }) => {
      await signedIn(page);
      const api = await fakeTasksApi(page, [
        ...seededTasks(),
        pageTask(4, 'Book the photographer', { dueAt: '2026-10-08T10:00:00.000Z' }),
        pageTask(5, 'Arrange the tasting', {
          dueAt: '2026-10-20T10:00:00.000Z',
          assignee: { membershipId: leeMember.id, name: leeMember.name, you: false },
        }),
      ]);
      const titles = tasksTable(page).getByRole('rowheader');
      const asked = (): string | undefined => api.reads.at(-1)?.toString();
      await page.goto(inHarbor('/tasks'));
      await expect(page.getByText('5 Tasks', { exact: true })).toBeVisible();
      const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
      await expect(pages.getByRole('status')).toHaveText('1 - 5 of 5');

      const lists = page.getByRole('group', { name: 'Task lists', exact: true });
      await expect(lists.getByRole('button')).toHaveText([
        'All',
        'Due today',
        'Overdue',
        'Upcoming',
      ]);
      await lists.getByRole('button', { name: 'Due today', exact: true }).click();
      await expect(titles).toHaveText(['Book the photographer']);
      expect(asked()).toBe('scope=all&status=open&due=today&limit=20');
      await expect(page.getByText('1 Task', { exact: true })).toBeVisible();
      await lists.getByRole('button', { name: 'Upcoming', exact: true }).click();
      await expect(titles).toHaveText(['Arrange the tasting']);
      expect(asked()).toBe('scope=all&status=open&due=upcoming&limit=20');
      await expect(page).toHaveURL(/list=upcoming/);
      await lists.getByRole('button', { name: 'All', exact: true }).click();
      await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'all');
      await expect(titles).toHaveCount(5);

      // The title search, asked of the server once typing pauses and kept in the address.
      const search = page.getByRole('searchbox', { name: 'Search for task title', exact: true });
      await search.fill('QUOTE');
      await expect(titles).toHaveText(['Send the quote']);
      expect(asked()).toBe('scope=all&status=all&q=QUOTE&limit=20');
      await expect(page).toHaveURL(/q=QUOTE/);
      await search.fill('');
      await expect(titles).toHaveCount(5);
      await expect(page).not.toHaveURL(/q=/);

      // The two headings that sort, on the server.
      const heading = (name: RegExp): Locator =>
        tasksTable(page).getByRole('columnheader', { name });
      await heading(/^Title/)
        .getByRole('button')
        .click();
      await expect(titles).toHaveText([
        'Arrange the tasting',
        'Book the photographer',
        'Confirm the venue',
        'Order the flowers',
        'Send the quote',
      ]);
      await expect(heading(/^Title/)).toHaveAttribute('aria-sort', 'ascending');
      expect(asked()).toBe('scope=all&status=all&sort=title&direction=asc&limit=20');
      await heading(/^Title/)
        .getByRole('button')
        .click();
      await expect(titles.first()).toHaveText('Send the quote');
      await expect(heading(/^Title/)).toHaveAttribute('aria-sort', 'descending');
      await expect(page).toHaveURL(/sort=title&direction=desc/);
      await heading(/^Due date/)
        .getByRole('button')
        .click();
      await expect(titles.nth(0)).toHaveText('Confirm the venue');
      await expect(titles.nth(1)).toHaveText('Book the photographer');
      await expect(titles.nth(2)).toHaveText('Arrange the tasting');
      expect(asked()).toBe('scope=all&status=all&sort=due&direction=asc&limit=20');
      await expect(heading(/^Title/)).toHaveAttribute('aria-sort', 'none');

      // One person on the team, by name; the choice and the order survive a reload.
      const assignee = page.getByRole('combobox', { name: 'Assignee', exact: true });
      await choose(assignee, leeMember.id);
      await expect(titles).toHaveText(['Arrange the tasting', 'Send the quote']);
      expect(asked()).toBe(
        `scope=all&status=all&assignee=${leeMember.id}&sort=due&direction=asc&limit=20`,
      );
      await expect(assignee).toContainText('Lee Park');
      await page.reload();
      await expectChoice(assignee, leeMember.id);
      await expect(assignee).toContainText('Lee Park');
      await expect(heading(/^Due date/)).toHaveAttribute('aria-sort', 'ascending');
      await expect(titles).toHaveText(['Arrange the tasting', 'Send the quote']);
      await choose(assignee, 'all');

      // A range of due days, in the reader's own time zone (Nairobi is three hours ahead).
      const range = page.getByRole('group', { name: 'Due date', exact: true });
      await range.getByLabel('Due from', { exact: true }).fill('2026-10-08');
      await range.getByLabel('Due to', { exact: true }).fill('2026-10-08');
      await expect(titles).toHaveText(['Book the photographer']);
      expect(api.reads.at(-1)?.get('dueFrom')).toBe('2026-10-07T21:00:00.000Z');
      expect(api.reads.at(-1)?.get('dueBefore')).toBe('2026-10-08T21:00:00.000Z');
      await expect(page).toHaveURL(/from=2026-10-08/);
      await expectNoAccessibilityViolations(page);
      await range.getByLabel('Due to', { exact: true }).fill('2026-10-01');
      await expect(page.getByRole('main').getByRole('alert')).toHaveText(
        'The range ends before it starts.',
      );
      await expect(tasksTable(page)).toHaveCount(0);
      await range.getByLabel('Due from', { exact: true }).fill('');
      await range.getByLabel('Due to', { exact: true }).fill('');
      await expect(titles).toHaveCount(5);

      // The page size, and the way to the next page in the same order.
      await choose(pages.getByRole('combobox', { name: 'Rows per page', exact: true }), '10');
      await expect.poll(() => api.reads.at(-1)?.get('limit')).toBe('10');
      api.tasks = [
        ...api.tasks,
        ...Array.from({ length: 8 }, (_, index) =>
          pageTask(20 + index, `Call guest ${String(index)}`),
        ),
      ];
      await page.reload();
      await choose(pages.getByRole('combobox', { name: 'Rows per page', exact: true }), '10');
      await expect(pages.getByRole('status')).toHaveText('1 - 10 of 13');
      await expect(page.getByText('13 Tasks', { exact: true })).toBeVisible();
      await pages.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(pages.getByRole('status')).toHaveText('11 - 13 of 13');
      expect(api.reads.at(-1)?.get('sort')).toBe('due');
      expect(api.reads.at(-1)?.get('after')).not.toBeNull();
      await expect(pages.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();

      await expectNoAccessibilityViolations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 360) {
        expect(
          (
            await heading(/^Title/)
              .getByRole('button')
              .boundingBox()
          )?.height,
        ).toBeGreaterThanOrEqual(44);
        expect((await search.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
    });

    test('adds two tasks in a row, completes, edits and deletes', async ({ page }) => {
      await signedIn(page);
      const api = await fakeTasksApi(page, seededTasks());
      await page.goto(inHarbor('/tasks'));
      const add = page.getByRole('button', { name: 'Add Task', exact: true });
      await add.click();
      const adding = page.getByRole('dialog', { name: 'New task', exact: true });
      const save = adding.getByRole('button', { name: 'Save', exact: true });
      const another = adding.getByRole('button', { name: 'Save and add another', exact: true });
      await expect(save).toBeDisabled();
      await expect(another).toBeDisabled();
      await adding.getByLabel('Title', { exact: true }).fill('Prepare the quote');
      await adding.getByLabel('Description', { exact: true }).fill('Two options, with delivery.');
      await adding
        .getByLabel('Due date and time (Africa/Nairobi)', { exact: true })
        .fill('2026-10-12T09:30');
      await expect(adding.getByText('UTC offset: GMT+3', { exact: true })).toBeVisible();
      await choose(adding.getByRole('combobox', { name: 'Assign to', exact: true }), leeMember.id);
      await adding.getByLabel('Contact', { exact: true }).fill('maya');
      await adding.getByRole('button', { name: /Maya Thompson/ }).click();
      await expect(
        adding.getByRole('button', { name: 'Remove Maya Thompson', exact: true }),
      ).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await another.click();
      await expect(
        adding.getByText('Task added. Add another, or close the panel.', { exact: true }),
      ).toBeVisible();
      expect(api.created).toEqual([
        {
          recordId,
          title: 'Prepare the quote',
          description: 'Two options, with delivery.',
          dueAt: '2026-10-12T06:30:00.000Z',
          assignee: leeMember.id,
        },
      ]);
      await expect(adding.getByLabel('Title', { exact: true })).toHaveValue('');
      await adding.getByLabel('Title', { exact: true }).fill('Book the van');
      await save.click();
      await expect(pageNotice(page)).toHaveText('Task added.');
      await expect(adding).toBeHidden();
      await expect(add).toBeFocused();
      expect(api.created[1]).toEqual({
        recordId: null,
        title: 'Book the van',
        description: '',
        dueAt: null,
        assignee: null,
      });
      const quote = taskRow(page, 'Prepare the quote');
      await expect(quote.getByRole('link', { name: 'Maya Thompson', exact: true })).toBeVisible();
      await expect(quote.getByRole('cell').nth(4)).toHaveText('Lee Park');

      // The round button completes and reopens.
      const van = taskRow(page, 'Book the van');
      await van.getByRole('button', { name: 'Complete Book the van', exact: true }).click();
      await expect(pageNotice(page)).toHaveText('Task completed.');
      const reopen = van.getByRole('button', { name: 'Reopen Book the van', exact: true });
      await expect(reopen).toHaveAttribute('aria-pressed', 'true');
      await reopen.click();
      await expect(pageNotice(page)).toHaveText('Task reopened.');

      // Someone else saved first: the draft is kept over their version.
      const edit = van.getByRole('button', { name: 'Edit Book the van', exact: true });
      await edit.click();
      const editing = page.getByRole('dialog', { name: 'Edit task', exact: true });
      await expect(
        editing.getByRole('button', { name: 'Save and add another', exact: true }),
      ).toHaveCount(0);
      await editing.getByLabel('Title', { exact: true }).fill('Book the big van');
      api.tasks = api.tasks.map((task) =>
        task.title === 'Book the van'
          ? { ...task, description: 'For Friday.', revision: 'd'.repeat(64) }
          : task,
      );
      await editing.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editing.getByRole('alert')).toHaveText(
        'This task changed. Refresh it before saving, completing or deleting.',
      );
      await expectNoAccessibilityViolations(page);
      await editing.getByRole('button', { name: 'Keep my draft', exact: true }).click();
      await expect(editing.getByRole('alert')).toHaveCount(0);
      await expect(editing.getByLabel('Title', { exact: true })).toHaveValue('Book the big van');
      await editing.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(pageNotice(page)).toHaveText('Task saved.');
      const renamed = taskRow(page, 'Book the big van');
      await expect(
        renamed.getByRole('button', { name: 'Edit Book the big van', exact: true }),
      ).toBeFocused();

      await renamed.getByRole('button', { name: 'Delete Book the big van', exact: true }).click();
      const deleting = page.getByRole('dialog', { name: 'Delete Book the big van?', exact: true });
      await expect(deleting).toContainText('The task is deleted for everyone.');
      await expectNoAccessibilityViolations(page);
      await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(pageNotice(page)).toHaveText('Task deleted.');
      await expect(renamed).toHaveCount(0);
      expect(api.tasks.map((task) => task.title)).not.toContain('Book the big van');

      if (width === 360)
        for (const button of await taskRow(page, 'Order the flowers').getByRole('button').all())
          expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await expectNoAccessibilityViolations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });

    test('runs each bulk action on the ticked tasks, and says what was skipped', async ({
      page,
    }) => {
      await signedIn(page);
      const api = await fakeTasksApi(page, seededTasks());
      const [venue, quote, flowers] = api.tasks.map((task) => task.id);
      if (venue === undefined || quote === undefined || flowers === undefined)
        throw new Error('Three tasks are seeded.');
      await page.goto(inHarbor('/tasks'));
      const tick = (title: string): Locator =>
        tasksTable(page).getByRole('checkbox', { name: `Select ${title}`, exact: true });
      const everyTick = tasksTable(page).getByRole('checkbox', {
        name: 'Select every task on this page',
        exact: true,
      });
      const bar = page.getByRole('group', { name: 'Bulk actions', exact: true });
      const result = page.getByRole('region', { name: 'Tasks', exact: true }).getByRole('status');
      await expect(taskRow(page, 'Confirm the venue')).toBeVisible();
      await expect(bar).toHaveCount(0);

      // Mark complete: one request for the ticked rows, and the ticks are let go.
      await tick('Confirm the venue').check();
      await tick('Order the flowers').check();
      await expect(bar.getByText('2 selected', { exact: true })).toBeVisible();
      await expect(bar.getByRole('button')).toHaveText([
        'Mark complete',
        'Reopen',
        'Assign',
        'Change due date',
        'Delete',
        'Clear selection',
      ]);
      await expectNoAccessibilityViolations(page);
      if (width === 360)
        expect((await tick('Order the flowers').locator('..').boundingBox())?.height).toBe(44);
      await bar.getByRole('button', { name: 'Mark complete', exact: true }).click();
      await expect(result.filter({ hasText: 'changed' })).toHaveText('2 tasks changed.');
      expect(api.bulk.at(-1)).toEqual({ action: 'complete', ids: [venue, flowers] });
      await expect(bar).toHaveCount(0);
      await expect(
        taskRow(page, 'Order the flowers').getByRole('button', {
          name: 'Reopen Order the flowers',
          exact: true,
        }),
      ).toBeVisible();

      // Reopen all three: one was changed by someone else, so it is skipped and stays ticked.
      await everyTick.check();
      await expect(bar.getByText('3 selected', { exact: true })).toBeVisible();
      api.skipInBulk = [flowers];
      await bar.getByRole('button', { name: 'Reopen', exact: true }).click();
      await expect(result.filter({ hasText: 'changed' })).toContainText(
        '2 tasks changed. 1 was skipped and is still ticked:',
      );
      await expect(
        page.getByRole('list', { name: 'Skipped tasks', exact: true }).getByRole('listitem'),
      ).toHaveText(['Order the flowers: Someone else changed it just now. Try again.']);
      expect(api.bulk.at(-1)).toEqual({ action: 'reopen', ids: [venue, quote, flowers] });
      await expect(tick('Order the flowers')).toBeChecked();
      await expect(tick('Confirm the venue')).not.toBeChecked();
      await expect(bar.getByText('1 selected', { exact: true })).toBeVisible();
      await expectNoAccessibilityViolations(page);
      api.skipInBulk = [];
      await bar.getByRole('button', { name: 'Clear selection', exact: true }).click();
      await expect(bar).toHaveCount(0);

      // Assign, with the people the Assignee chip lists.
      await tick('Confirm the venue').check();
      await tick('Order the flowers').check();
      await bar.getByRole('button', { name: 'Assign', exact: true }).click();
      const assigning = page.getByRole('dialog', { name: 'Assign tasks', exact: true });
      await expect(assigning).toContainText('2 tasks are selected.');
      await choose(
        assigning.getByRole('combobox', { name: 'Assign to', exact: true }),
        leeMember.id,
      );
      await expectNoAccessibilityViolations(page);
      await assigning.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(assigning).toBeHidden();
      await expect(result.filter({ hasText: 'changed' })).toHaveText('2 tasks changed.');
      expect(api.bulk.at(-1)).toEqual({
        action: 'assign',
        ids: [venue, flowers],
        assignee: leeMember.id,
      });
      await expect(taskRow(page, 'Order the flowers').getByRole('cell').nth(4)).toHaveText(
        'Lee Park',
      );

      // A due date and time for several at once, in the reader's time zone.
      await tick('Order the flowers').check();
      await bar.getByRole('button', { name: 'Change due date', exact: true }).click();
      const dating = page.getByRole('dialog', { name: 'Change due date', exact: true });
      await expect(dating.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
      await dating
        .getByLabel('Due date and time (Africa/Nairobi)', { exact: true })
        .fill('2026-10-12T09:30');
      await dating.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dating).toBeHidden();
      expect(api.bulk.at(-1)).toEqual({
        action: 'set_due',
        ids: [flowers],
        dueAt: '2026-10-12T06:30:00.000Z',
      });
      await expect(
        taskRow(page, 'Order the flowers').locator('time[datetime="2026-10-12T06:30:00.000Z"]'),
      ).toBeVisible();
      await tick('Order the flowers').check();
      await bar.getByRole('button', { name: 'Change due date', exact: true }).click();
      await dating.getByRole('checkbox', { name: 'Clear the due date instead' }).check();
      await dating.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dating).toBeHidden();
      expect(api.bulk.at(-1)).toEqual({ action: 'set_due', ids: [flowers], dueAt: null });

      // Delete asks first, and says it is for good.
      const sent = api.bulk.length;
      await tick('Send the quote').check();
      await tick('Order the flowers').check();
      await bar.getByRole('button', { name: 'Delete', exact: true }).click();
      const deleting = page.getByRole('dialog', { name: 'Delete 2 tasks?', exact: true });
      await expect(deleting).toContainText("This can't be undone");
      await expectNoAccessibilityViolations(page);
      expect(api.bulk).toHaveLength(sent);
      await deleting.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(deleting).toBeHidden();
      expect(api.bulk).toHaveLength(sent);
      await bar.getByRole('button', { name: 'Delete', exact: true }).click();
      await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(result.filter({ hasText: 'deleted' })).toHaveText('2 tasks deleted.');
      expect(api.bulk.at(-1)).toEqual({ action: 'delete', ids: [quote, flowers] });
      await expect(tasksTable(page).getByRole('rowheader')).toHaveText(['Confirm the venue']);
      await expect(page.getByText('1 Task', { exact: true })).toBeVisible();

      await expectNoAccessibilityViolations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });

    test('opens from the Dashboard on my tasks, and only reads without the permission', async ({
      page,
    }) => {
      await signedIn(page);
      const api = await fakeTasksApi(page, seededTasks());
      api.canManage = false;
      await page.goto(inHarbor('/'));
      const overduePanel = page.getByRole('region', { name: 'Overdue tasks', exact: true });
      await expect(overduePanel.getByText('Confirm the venue', { exact: true })).toBeVisible();
      await expect(
        overduePanel.getByRole('link', { name: 'Maya Thompson', exact: true }),
      ).toHaveAttribute('href', inHarbor(`/contacts/${recordId}`));
      await page.getByRole('link', { name: 'My tasks', exact: true }).click();
      await expect(page).toHaveURL(inHarbor('/tasks?assignee=mine'));
      await expectChoice(page.getByRole('combobox', { name: 'Assignee', exact: true }), 'mine');
      await expect(tasksTable(page).getByRole('rowheader')).toHaveText(['Confirm the venue']);
      await expect(
        page.getByText('You can read tasks. Changing them needs permission to manage tasks.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add Task', exact: true })).toHaveCount(0);
      // The headings still sort; no row has anything to press.
      await expect(tasksTable(page).locator('tbody').getByRole('button')).toHaveCount(0);
      await expectNoAccessibilityViolations(page);
    });
  });
}

test.describe('the tasks page at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await signedIn(page);
    await fakeTasksApi(page, seededTasks());
    await page.goto(inHarbor('/tasks'));
    await expect(taskRow(page, 'Confirm the venue')).toBeVisible();
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Tasks', exact: true })),
    ).toBe(true);
  });
});

for (const width of [1440, 360]) {
  test.describe(`${String(width)} px task panels`, () => {
    test.use({ viewport: { width, height: 900 }, timezoneId: 'Africa/Nairobi' });
    test('retains an open draft as read-only when its task is gone', async ({ page }) => {
      await contactTaskPage(page);
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      let gone = false;
      let failRefresh = false;
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
        failRefresh
          ? route.fulfill({
              status: 503,
              json: { type: 'about:blank', title: 'Unavailable', status: 503 },
            })
          : route.fulfill({
              json: {
                canManage: true,
                nextCursor: null,
                items: gone
                  ? []
                  : [
                      {
                        id: taskId,
                        record: { id: recordId, name: 'Maya Thompson', trashed: false },
                        title: 'Before it goes',
                        description: '',
                        dueAt: null,
                        assignee: { membershipId: null, name: 'Dana Brooks', you: true },
                        completedAt: null,
                        completedBy: null,
                        createdAt: at,
                        updatedAt: at,
                        revision: 'a'.repeat(64),
                      },
                    ],
              },
            }),
      );
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Edit task', exact: true }).click();
      const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
      await title.fill('Keep this unsaved draft');
      failRefresh = true;
      await panel.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText("Tasks couldn't be loaded.", {
        timeout: 15000,
      });
      await expect(panel.getByRole('button', { name: 'Refresh tasks', exact: true })).toBeFocused();
      await expect(title).toHaveValue('Keep this unsaved draft');
      failRefresh = false;
      gone = true;
      await panel.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
      await expect(title).toHaveValue('Keep this unsaved draft');
      await expect(
        panel.getByText('Tasks are read-only here. Your draft is still here.', { exact: true }),
      ).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Edit task', exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Add task', exact: true })).toBeEnabled();
    });
    for (const action of ['complete', 'delete'] as const) {
      for (const status of [403, 500]) {
        test(`recovers keyboard focus after ${String(status)} on ${action}`, async ({ page }) => {
          await contactTaskPage(page);
          let canManage = true;
          const task: Task = {
            id: taskId,
            record: { id: recordId, name: 'Maya Thompson', trashed: false },
            title: 'Keep this task',
            description: '',
            dueAt: null,
            assignee: null,
            completedAt: null,
            completedBy: null,
            createdAt: at,
            updatedAt: at,
            revision: 'a'.repeat(64),
          };
          await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
            route.fulfill({ json: { canManage, items: [task], nextCursor: null } }),
          );
          await page.route(
            `**/api/v1/tasks/${taskId}${action === 'complete' ? '/completion' : ''}`,
            (route) => {
              canManage = status !== 403;
              return route.fulfill({
                status,
                json: { type: 'about:blank', title: 'Action rejected', status },
              });
            },
          );
          await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
          const panel = page.getByRole('region', { name: 'Tasks', exact: true });
          if (action === 'complete')
            await panel.getByRole('button', { name: 'Complete task', exact: true }).click();
          else {
            await panel.getByRole('button', { name: 'Delete task', exact: true }).click();
            await panel.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
          }
          await expect(panel.getByRole('alert')).toContainText('Action rejected');
          await expect(panel.getByText('Keep this task', { exact: true }).first()).toBeVisible();
          if (status === 403)
            await expect(panel.getByRole('button', { name: 'Edit task', exact: true })).toHaveCount(
              0,
            );
          await expect(
            panel.getByRole('button', {
              name:
                action === 'delete'
                  ? 'Keep task'
                  : status === 403
                    ? 'Refresh tasks'
                    : 'Complete task',
              exact: true,
            }),
          ).toBeFocused();
        });
      }
    }
    test('removes a rejected assignee and requires an explicit replacement', async ({ page }) => {
      await contactTaskPage(page);
      const jordan = 'mem_01m4bd188ff82s0add91b7pz62';
      let removed = false;
      let items: Task[] = [];
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
        route.fulfill({
          json: {
            items: removed ? [] : [{ id: jordan, name: 'Jordan Lee', you: false }],
            nextCursor: null,
          },
        }),
      );
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({ json: { canManage: true, items, nextCursor: null } });
        const input = createTaskInput.parse(route.request().postDataJSON());
        if (!removed) {
          expect(input.assignee).toBe(jordan);
          removed = true;
          return route.fulfill({
            status: 422,
            json: {
              type: 'about:blank',
              title: 'Validation failed',
              status: 422,
              errors: [
                {
                  path: '/assignee',
                  code: 'unavailable_assignee',
                  message:
                    'Choose someone on this business or agency team, or leave the task unassigned.',
                },
              ],
            },
          });
        }
        expect(input.assignee).toBeNull();
        items = [
          {
            id: taskId,
            record: { id: recordId, name: 'Maya Thompson', trashed: false },
            title: input.title,
            description: input.description,
            dueAt: null,
            assignee: null,
            completedAt: null,
            completedBy: null,
            createdAt: at,
            updatedAt: at,
            revision: 'a'.repeat(64),
          },
        ];
        return route.fulfill({ status: 201, json: items[0] });
      });
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Add task', exact: true }).click();
      const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
      await title.fill('Keep the draft after removal');
      const assignee = panel.getByRole('combobox', { name: 'Assigned to', exact: true });
      await choose(assignee, jordan);
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText(
        'Choose someone on this business or agency team',
      );
      await expectChoice(assignee, 'unavailable');
      await expect(assignee.getByRole('option', { name: 'Jordan Lee', exact: true })).toHaveCount(
        0,
      );
      await expect(title).toHaveValue('Keep the draft after removal');
      await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
      await choose(assignee, '');
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(title).toBeHidden();
      await expect(panel.getByText('Keep the draft after removal', { exact: true })).toBeVisible();
    });
    test('recovers when the assignee paging anchor has left the team', async ({ page }) => {
      await contactTaskPage(page);
      const first = 'mem_01m4bd188ff82s0add91b7pz61';
      const jordan = 'mem_01m4bd188ff82s0add91b7pz62';
      let missing = false;
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) => {
        if (new URL(route.request().url()).searchParams.has('after')) {
          missing = true;
          return route.fulfill({
            status: 422,
            json: {
              type: 'about:blank',
              title: 'Validation failed',
              status: 422,
              errors: [
                {
                  path: '/after',
                  code: 'unknown_member',
                  message: 'Start after someone in this business or agency team.',
                },
              ],
            },
          });
        }
        return route.fulfill({
          json: missing
            ? { items: [{ id: jordan, name: 'Jordan Lee', you: false }], nextCursor: null }
            : { items: [{ id: first, name: 'Dana Brooks', you: true }], nextCursor: first },
        });
      });
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { canManage: true, items: [], nextCursor: null } }),
      );
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Add task', exact: true }).click();
      const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
      await title.fill('Keep the task while reloading people');
      await panel.getByRole('button', { name: 'Load more people', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText("People couldn't be loaded.", {
        timeout: 15000,
      });
      await panel.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(panel.getByRole('alert')).toHaveCount(0, { timeout: 15000 });
      await choose(panel.getByRole('combobox', { name: 'Assigned to', exact: true }), jordan);
      await expect(title).toHaveValue('Keep the task while reloading people');
      await expect(
        panel.getByRole('button', { name: 'Load more people', exact: true }),
      ).toHaveCount(0);
    });
    test('blocks a partial due date without clearing the saved due date', async ({ page }) => {
      await contactTaskPage(page);
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      const current: Task = {
        id: taskId,
        record: { id: recordId, name: 'Maya Thompson', trashed: false },
        title: 'Keep the due date',
        description: '',
        dueAt: '2026-10-09T11:30:14.125Z',
        assignee: null,
        completedAt: null,
        completedBy: null,
        createdAt: at,
        updatedAt: at,
        revision: 'a'.repeat(64),
      };
      let writes = 0;
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { canManage: true, items: [current], nextCursor: null } }),
      );
      await page.route(`**/api/v1/tasks/${taskId}`, (route) => {
        writes += 1;
        return route.fulfill({ json: current });
      });
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Edit task', exact: true }).click();
      const due = panel.getByLabel('Due date', { exact: true });
      await due.focus();
      await due.press('Backspace');
      expect(await due.evaluate((input: HTMLInputElement) => input.validity.badInput)).toBe(true);
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(due).toBeFocused();
      await expect(panel.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(
        'Keep the due date',
      );
      expect(writes).toBe(0);
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.locator('time[datetime="2026-10-09T11:30:14.125Z"]')).toBeVisible();
    });
    test('requires an explicit choice for an unavailable assignee and keeps a revoked draft', async ({
      page,
    }) => {
      await contactTaskPage(page);
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      let canManage = true;
      let denied = false;
      let current: Task = {
        id: taskId,
        record: { id: recordId, name: 'Maya Thompson', trashed: false },
        title: 'Keep the original assignment',
        description: '',
        dueAt: null,
        assignee: { membershipId: null, name: null, you: false },
        completedAt: null,
        completedBy: null,
        createdAt: at,
        updatedAt: at,
        revision: 'a'.repeat(64),
      };
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { canManage, items: [current], nextCursor: null } }),
      );
      await page.route(`**/api/v1/tasks/${taskId}`, (route) => {
        if (!denied) {
          denied = true;
          canManage = false;
          return route.fulfill({
            status: 403,
            json: { type: 'about:blank', title: 'Forbidden', status: 403 },
          });
        }
        const input = updateTaskInput.parse(route.request().postDataJSON());
        expect(input.assignee).toBeNull();
        expect(input.title).toBe('Preserve my draft');
        current = { ...current, title: input.title, assignee: null, revision: 'b'.repeat(64) };
        return route.fulfill({ json: current });
      });
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Edit task', exact: true }).click();
      const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
      await title.fill('Preserve my draft');
      await expectChoice(
        panel.getByRole('combobox', { name: 'Assigned to', exact: true }),
        'unavailable',
      );
      await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
      await choose(panel.getByRole('combobox', { name: 'Assigned to', exact: true }), '');
      canManage = false;
      await panel.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
      await expect(
        panel.getByText('Tasks are read-only here. Your draft is still here.', { exact: true }),
      ).toBeVisible();
      await expect(title).toHaveValue('Preserve my draft');
      await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
      canManage = true;
      await panel.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeEnabled();
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(
        panel.getByText('Tasks are read-only here. Your draft is still here.', { exact: true }),
      ).toBeVisible();
      await expect(title).toHaveValue('Preserve my draft');
      await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
      await expect(panel.getByRole('button', { name: 'Refresh tasks', exact: true })).toBeFocused();
      canManage = true;
      await panel.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Save task', exact: true })).toBeEnabled();
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(title).toBeHidden();
      await expect(panel.getByText('Unassigned', { exact: true })).toBeVisible();
    });
    test('retries an older page without clearing the current list or a draft', async ({ page }) => {
      await contactTaskPage(page);
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      const first: Task = {
        id: taskId,
        record: { id: recordId, name: 'Maya Thompson', trashed: false },
        title: 'Current task',
        description: '',
        dueAt: null,
        assignee: null,
        completedAt: null,
        completedBy: null,
        createdAt: at,
        updatedAt: at,
        revision: 'a'.repeat(64),
      };
      let retry = false;
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) => {
        const after = new URL(route.request().url()).searchParams.get('after');
        if (after === null)
          return route.fulfill({ json: { canManage: true, items: [first], nextCursor: taskId } });
        expect(after).toBe(taskId);
        return retry
          ? route.fulfill({
              json: {
                canManage: true,
                items: [{ ...first, id: 'task_01m4bd188ff82s0add91b7pz64', title: 'Older task' }],
                nextCursor: null,
              },
            })
          : route.fulfill({
              status: 503,
              json: { type: 'about:blank', title: 'Unavailable', status: 503 },
            });
      });
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Add task', exact: true }).click();
      const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
      await title.fill('Keep this draft');
      await panel.getByRole('button', { name: 'Load older tasks', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText("Tasks couldn't be loaded.", {
        timeout: 15000,
      });
      await expect(panel.getByText('Current task', { exact: true })).toBeVisible();
      await expect(title).toHaveValue('Keep this draft');
      retry = true;
      await panel.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(panel.getByText('Older task', { exact: true })).toBeVisible();
      await expect(title).toHaveValue('Keep this draft');
      await expect(panel.getByRole('listitem').filter({ hasText: 'Older task' })).toBeFocused();
    });
    test.describe('daylight saving time', () => {
      test.use({ timezoneId: 'America/New_York' });
      test('distinguishes repeated wall times and preserves the stored occurrence', async ({
        page,
      }) => {
        await contactTaskPage(page);
        await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
          route.fulfill({ json: { items: [], nextCursor: null } }),
        );
        let task: Task = {
          id: taskId,
          record: { id: recordId, name: 'Maya Thompson', trashed: false },
          title: 'After the clocks return',
          description: '',
          dueAt: '2026-11-01T06:30:00.000Z',
          assignee: null,
          completedAt: null,
          completedBy: null,
          createdAt: at,
          updatedAt: at,
          revision: 'a'.repeat(64),
        };
        await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
          route.fulfill({ json: { canManage: true, items: [task], nextCursor: null } }),
        );
        await page.route(`**/api/v1/tasks/${taskId}`, (route) => {
          const input = updateTaskInput.parse(route.request().postDataJSON());
          expect(input.dueAt).toBe('2026-11-01T06:30:00.000Z');
          task = { ...task, title: input.title, revision: 'b'.repeat(64) };
          return route.fulfill({ json: task });
        });
        await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
        const panel = page.getByRole('region', { name: 'Tasks', exact: true });
        await expect(panel.locator('time')).toContainText('GMT-5');
        await panel.getByRole('button', { name: 'Edit task', exact: true }).click();
        await expect(panel.getByText('UTC offset: GMT-5', { exact: true })).toBeVisible();
        await panel
          .getByRole('textbox', { name: 'Task title', exact: true })
          .fill('Keep the second occurrence');
        await panel.getByRole('button', { name: 'Save task', exact: true }).click();
        await expect(panel.getByRole('textbox', { name: 'Task title', exact: true })).toBeHidden();
        await panel.getByRole('button', { name: 'Add task', exact: true }).click();
        await panel.getByLabel('Due date', { exact: true }).fill('2026-11-01T01:30');
        await expect(panel.getByText('UTC offset: GMT-4', { exact: true })).toBeVisible();
      });
      test('keeps a draft when the chosen wall time does not exist', async ({ page }) => {
        await contactTaskPage(page);
        await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
          route.fulfill({ json: { items: [], nextCursor: null } }),
        );
        let items: Task[] = [];
        await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) => {
          if (route.request().method() === 'POST') {
            const input = createTaskInput.parse(route.request().postDataJSON());
            expect(input.dueAt).toBe('2026-03-08T07:30:00.000Z');
            items = [
              {
                id: taskId,
                record: { id: recordId, name: 'Maya Thompson', trashed: false },
                title: input.title,
                description: input.description,
                dueAt: input.dueAt,
                assignee: null,
                completedAt: null,
                completedBy: null,
                createdAt: at,
                updatedAt: at,
                revision: 'a'.repeat(64),
              },
            ];
            return route.fulfill({ status: 201, json: items[0] });
          }
          return route.fulfill({ json: { canManage: true, items, nextCursor: null } });
        });
        await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
        const panel = page.getByRole('region', { name: 'Tasks', exact: true });
        await panel.getByRole('button', { name: 'Add task', exact: true }).click();
        const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
        const due = panel.getByLabel('Due date', { exact: true });
        await title.fill('Call after the clocks change');
        await due.fill('2026-03-08T02:30');
        await panel.getByRole('button', { name: 'Save task', exact: true }).click();
        await expect(panel.getByRole('alert')).toContainText(
          "This time doesn't exist in America/New_York.",
        );
        await expect(title).toHaveValue('Call after the clocks change');
        await expect(due).toHaveValue('2026-03-08T02:30');
        await expect(due).toBeFocused();
        await due.fill('2026-03-08T03:30');
        await panel.getByRole('button', { name: 'Save task', exact: true }).click();
        await expect(title).toBeHidden();
        await expect(panel.locator('time[datetime="2026-03-08T07:30:00.000Z"]')).toBeVisible();
      });
    });
    test('adds an assigned record task and preserves a rejected draft', async ({ page }) => {
      await contactTaskPage(page);
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      let reject = true;
      let items: Task[] = [];
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, async (route) => {
        if (route.request().method() === 'POST') {
          const input = createTaskInput.parse(route.request().postDataJSON());
          expect(input).toEqual({
            recordId,
            title: 'Confirm the venue',
            description: 'Call Maya after lunch.',
            dueAt: null,
            assignee: 'me',
          });
          if (reject) {
            reject = false;
            return route.fulfill({
              status: 422,
              json: {
                type: 'about:blank',
                title: 'Validation failed',
                status: 422,
                errors: [
                  { path: '/assignee', code: 'unavailable', message: 'Choose a person again.' },
                ],
              },
            });
          }
          items = [
            {
              id: taskId,
              record: { id: recordId, name: 'Maya Thompson', trashed: false },
              title: input.title,
              description: input.description,
              dueAt: input.dueAt,
              assignee: { membershipId: null, name: 'Dana Brooks', you: true },
              completedAt: null,
              completedBy: null,
              createdAt: at,
              updatedAt: at,
              revision: 'a'.repeat(64),
            },
          ];
          return route.fulfill({ status: 201, json: items[0] });
        }
        expect(new URL(route.request().url()).searchParams.get('recordId')).toBe(recordId);
        return route.fulfill({ json: { canManage: true, items, nextCursor: null } });
      });
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Add task', exact: true }).click();
      const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
      await expect(title).toBeFocused();
      await title.fill('Confirm the venue');
      await panel
        .getByRole('textbox', { name: 'Description', exact: true })
        .fill('Call Maya after lunch.');
      await choose(panel.getByRole('combobox', { name: 'Assigned to', exact: true }), 'me');
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('Choose a person again.');
      await expect(title).toHaveValue('Confirm the venue');
      await expect(panel.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(
        'Call Maya after lunch.',
      );
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(title).toBeHidden();
      await expect(panel.getByText('Confirm the venue', { exact: true })).toBeVisible();
      await expect(panel.getByText('Assigned to You', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Add task', exact: true })).toBeFocused();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });

    test('sets a due time in the displayed timezone and assigns someone from the next page', async ({
      page,
    }) => {
      await contactTaskPage(page);
      const first = 'mem_01m4bd188ff82s0add91b7pz61';
      const jordan = 'mem_01m4bd188ff82s0add91b7pz62';
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) => {
        const after = new URL(route.request().url()).searchParams.get('after');
        return route.fulfill({
          json:
            after === null
              ? { items: [{ id: first, name: 'Dana Brooks', you: true }], nextCursor: first }
              : { items: [{ id: jordan, name: 'Jordan Lee', you: false }], nextCursor: null },
        });
      });
      let items: Task[] = [];
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) => {
        if (route.request().method() === 'POST') {
          expect(createTaskInput.parse(route.request().postDataJSON())).toEqual({
            recordId,
            title: 'Call Maya',
            description: '',
            dueAt: '2026-10-09T11:30:00.000Z',
            assignee: jordan,
          });
          items = [
            {
              id: taskId,
              record: { id: recordId, name: 'Maya Thompson', trashed: false },
              title: 'Call Maya',
              description: '',
              dueAt: '2026-10-09T11:30:00.000Z',
              assignee: { membershipId: jordan, name: 'Jordan Lee', you: false },
              completedAt: null,
              completedBy: null,
              createdAt: at,
              updatedAt: at,
              revision: 'a'.repeat(64),
            },
          ];
          return route.fulfill({ status: 201, json: items[0] });
        }
        return route.fulfill({ json: { canManage: true, items, nextCursor: null } });
      });
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await panel.getByRole('button', { name: 'Add task', exact: true }).click();
      await panel.getByRole('textbox', { name: 'Task title', exact: true }).fill('Call Maya');
      await expect(panel.getByText('Times use Africa/Nairobi.', { exact: true })).toBeVisible();
      await expect(panel.getByLabel('Due date', { exact: true })).toBeVisible();
      await panel.getByLabel('Due date', { exact: true }).fill('2026-10-09T14:30');
      await panel.getByRole('button', { name: 'Load more people', exact: true }).click();
      await expect(panel.getByRole('combobox', { name: 'Assigned to', exact: true })).toBeFocused();
      await choose(panel.getByRole('combobox', { name: 'Assigned to', exact: true }), jordan);
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(panel.getByRole('textbox', { name: 'Task title', exact: true })).toBeHidden();
      await expect(panel.getByText('Assigned to Jordan Lee', { exact: true })).toBeVisible();
      await expect(panel.locator('time[datetime="2026-10-09T11:30:00.000Z"]')).toBeVisible();
    });
    test('reviews a stale edit without losing its draft, then completes, reopens and deletes the task', async ({
      page,
    }) => {
      await contactTaskPage(page);
      const jordan = 'mem_01m4bd188ff82s0add91b7pz62';
      await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
        route.fulfill({
          json: { items: [], nextCursor: null },
        }),
      );
      let current: Task = {
        id: taskId,
        record: { id: recordId, name: 'Maya Thompson', trashed: false },
        title: 'Call Maya',
        description: 'Ask about the venue.',
        dueAt: '2026-10-09T11:30:14.125Z',
        assignee: { membershipId: jordan, name: 'Jordan Lee', you: false },
        completedAt: null,
        completedBy: null,
        createdAt: at,
        updatedAt: at,
        revision: 'a'.repeat(64),
      };
      let exists = true;
      let conflict = true;
      let deleteConflict = true;
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
        route.fulfill({
          json: { canManage: true, items: exists ? [current] : [], nextCursor: null },
        }),
      );
      await page.route(`**/api/v1/tasks/${taskId}`, (route) => {
        if (route.request().method() === 'DELETE') {
          expect(deleteTaskInput.parse(route.request().postDataJSON()).revision).toBe(
            current.revision,
          );
          if (deleteConflict) {
            deleteConflict = false;
            current = {
              ...current,
              title: 'Updated task before deletion',
              revision: 'f'.repeat(64),
            };
            return route.fulfill({
              status: 409,
              json: {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                detail: 'This task changed. Refresh it before saving, completing or deleting.',
              },
            });
          }
          exists = false;
          return route.fulfill({ status: 204 });
        }
        const input = updateTaskInput.parse(route.request().postDataJSON());
        expect(input).toEqual({
          title: 'Call Maya tomorrow',
          description: 'Keep my draft.',
          dueAt: '2026-10-09T11:30:14.125Z',
          assignee: jordan,
          revision: current.revision,
        });
        if (conflict) {
          conflict = false;
          current = {
            ...current,
            title: 'Call after three',
            description: 'A newer saved note.',
            assignee: null,
            revision: 'b'.repeat(64),
          };
          return route.fulfill({
            status: 409,
            json: {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              detail: 'This task changed. Refresh it before saving, completing or deleting.',
            },
          });
        }
        current = {
          ...current,
          title: input.title,
          description: input.description,
          revision: 'c'.repeat(64),
        };
        return route.fulfill({ json: current });
      });
      await page.route(`**/api/v1/tasks/${taskId}/completion`, (route) => {
        const input = completeTaskInput.parse(route.request().postDataJSON());
        expect(input.revision).toBe(current.revision);
        current = {
          ...current,
          completedAt: input.completed ? at : null,
          completedBy: input.completed ? { kind: 'user', name: 'Dana Brooks', you: true } : null,
          revision: (input.completed ? 'd' : 'e').repeat(64),
        };
        return route.fulfill({ json: current });
      });
      await page.goto(inHarbor(`/contacts/${recordId}?view=tasks`));
      const panel = page.getByRole('region', { name: 'Tasks', exact: true });
      await expect(panel.getByRole('button', { name: 'Edit task', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Edit task', exact: true }).click();
      const title = panel.getByRole('textbox', { name: 'Task title', exact: true });
      const description = panel.getByRole('textbox', { name: 'Description', exact: true });
      await expect(title).toBeFocused();
      await title.fill('Call Maya tomorrow');
      await description.fill('Keep my draft.');
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('This task changed.');
      await expect(title).toBeFocused();
      await panel.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
      await expect(panel.getByText('Call after three', { exact: true })).toBeVisible();
      await expect(title).toHaveValue('Call Maya tomorrow');
      await expect(description).toHaveValue('Keep my draft.');
      await panel.getByRole('button', { name: 'Keep my draft', exact: true }).click();
      await expect(title).toBeFocused();
      await expectChoice(panel.getByRole('combobox', { name: 'Assigned to', exact: true }), jordan);
      await panel.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(title).toBeHidden();
      await expect(panel.getByRole('button', { name: 'Edit task', exact: true })).toBeFocused();
      await panel.getByRole('button', { name: 'Complete task', exact: true }).click();
      await expect(panel.getByText('Completed by You', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Reopen task', exact: true }).click();
      await expect(panel.getByText('Completed by You', { exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: 'Delete task', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Keep task', exact: true })).toBeFocused();
      await panel.getByRole('button', { name: 'Keep task', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Delete task', exact: true })).toBeFocused();
      await panel.getByRole('button', { name: 'Delete task', exact: true }).click();
      await panel.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('This task changed.');
      await panel.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
      await expect(
        panel.getByText('Updated task before deletion', { exact: true }).first(),
      ).toBeVisible();
      await expect(
        panel.getByRole('button', { name: 'Confirm deletion', exact: true }),
      ).toBeDisabled();
      await panel.getByRole('button', { name: 'Review deletion', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Keep task', exact: true })).toBeFocused();
      await panel.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
      await expect(panel.getByText('Updated task before deletion', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('Call Maya tomorrow', { exact: true })).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Add task', exact: true })).toBeFocused();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  });
}
