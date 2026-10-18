// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Task } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TasksSearch } from './task-rules';
import { TasksPage } from './tasks';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ to, params, children }: { to: string; params: object; children: ReactNode }) => (
    <a href={`${to}#${Object.values(params).join('/')}`}>{children}</a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const at = '2026-10-08T12:00:00.000Z';
const dana = 'mem_01m4bd188ff82s0add91b7pz63';
const lee = 'mem_01m4bd188ff82s0add91b7pz64';
const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);

function taskOf(number: number, title: string, rest: Partial<Task> = {}): Task {
  return {
    id: `task_${String(number)}`,
    record: null,
    title,
    description: '',
    dueAt: null,
    assignee: null,
    completedAt: null,
    completedBy: null,
    createdAt: at,
    updatedAt: at,
    revision: revisionA,
    ...rest,
  };
}

const venue = taskOf(1, 'Confirm the venue', {
  description: 'Call the harbour office before noon.',
  record: { id: 'con_maya', name: 'Maya Thompson', trashed: false },
  assignee: { membershipId: dana, name: 'Dana Brooks', you: true },
  dueAt: '2026-10-09T06:30:00.000Z',
});
const quote = taskOf(2, 'Send the quote', {
  assignee: { membershipId: lee, name: 'Lee Park', you: false },
  completedAt: at,
  completedBy: { kind: 'user', name: 'Lee Park', you: false },
});
const team = {
  items: [
    { id: dana, name: 'Dana Brooks', you: true },
    { id: lee, name: 'Lee Park', you: false },
  ],
  nextCursor: null,
};

function stale(): ApiError {
  return new ApiError({
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: 'This task changed. Refresh it before saving, completing or deleting.',
  });
}

function serve(
  tasks: () => readonly Task[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
  canManage = true,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listTasks')
      return { canManage, items: tasks(), nextCursor: null, total: tasks().length };
    if (operation === 'listTaskAssignees') return team;
    return undefined;
  };
}

function Harness({ start }: { readonly start: TasksSearch }): ReactElement {
  const [search, setSearch] = useState(start);
  return <TasksPage search={search} onSearch={setSearch} />;
}

function show(start: TasksSearch = {}): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <Harness start={start} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

async function rowOf(title: string): Promise<HTMLElement> {
  const row = (await screen.findByRole('rowheader', { name: title })).closest('tr');
  if (row === null) throw new Error('No row.');
  return row;
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('the Tasks page', () => {
  it('lists every task with its record, who has it, when it is due and whether it is done', async () => {
    serve(() => [venue, quote]);
    show();
    const row = await rowOf('Confirm the venue');
    expect(inputOf('listTasks')).toEqual({ query: { scope: 'all', status: 'all', limit: 20 } });
    expect(within(row).getByText('Call the harbour office before noon.')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Maya Thompson' }).getAttribute('href')).toContain(
      'con_maya',
    );
    expect(within(row).getByText('You')).toBeTruthy();
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-09T06:30:00.000Z');
    expect(within(row).getByRole('button', { name: 'Complete Confirm the venue' })).toHaveProperty(
      'ariaPressed',
      'false',
    );
    const done = await rowOf('Send the quote');
    expect(within(done).getByText('Lee Park')).toBeTruthy();
    expect(within(done).getByRole('button', { name: 'Reopen Send the quote' })).toHaveProperty(
      'ariaPressed',
      'true',
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Tasks');
  });

  it('asks the server for the list each tab and chip names', async () => {
    serve(() => [venue]);
    const user = show();
    await rowOf('Confirm the venue');
    await user.click(screen.getByRole('button', { name: 'Overdue' }));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'open', due: 'overdue', limit: 20 },
      });
    });
    expect(screen.getByRole('button', { name: 'Overdue' })).toHaveProperty('ariaPressed', 'true');
    await choose(user, screen.getByRole('combobox', { name: 'Assignee' }), 'Assigned to me');
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'mine', status: 'open', due: 'overdue', limit: 20 },
      });
    });
    await user.click(screen.getByRole('button', { name: 'All' }));
    await choose(user, screen.getByRole('combobox', { name: 'Status' }), 'Completed');
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'mine', status: 'completed', limit: 20 },
      });
    });
  });

  it('says so when a list is empty, in the words of the list asked for', async () => {
    serve(() => []);
    const user = show();
    expect(await screen.findByText('No tasks yet.')).toBeTruthy();
    expect(screen.getByText('0 Tasks')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Due today' }));
    expect(await screen.findByText('No tasks due today.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Overdue' }));
    expect(await screen.findByText('No overdue tasks.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Upcoming' }));
    expect(await screen.findByText('No upcoming tasks.')).toBeTruthy();
    await choose(user, screen.getByRole('combobox', { name: 'Assignee' }), 'Unassigned');
    expect(await screen.findByText('No tasks match.')).toBeTruthy();
  });

  it('shows how many tasks match, and pages at the size chosen', async () => {
    serve(
      () => [venue, quote],
      (operation) =>
        operation === 'listTasks'
          ? { canManage: true, items: [venue, quote], nextCursor: 'task_2', total: 41 }
          : undefined,
    );
    const user = show();
    await rowOf('Confirm the venue');
    expect(screen.getByText('41 Tasks')).toBeTruthy();
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('status').textContent).toBe('1 - 2 of 41');
    await choose(user, within(pages).getByRole('combobox', { name: 'Rows per page' }), '50');
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({ query: { scope: 'all', status: 'all', limit: 50 } });
    });
    await user.click(within(pages).getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'all', limit: 50, after: 'task_2' },
      });
    });
  });

  it('says one task in the singular', async () => {
    serve(() => [venue]);
    show();
    await rowOf('Confirm the venue');
    expect(screen.getByText('1 Task')).toBeTruthy();
  });

  it('asks for the tasks due today and the upcoming ones, still open', async () => {
    serve(() => [venue]);
    const user = show();
    await rowOf('Confirm the venue');
    await user.click(screen.getByRole('button', { name: 'Due today' }));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'open', due: 'today', limit: 20 },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Upcoming' }));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'open', due: 'upcoming', limit: 20 },
      });
    });
    expect(screen.getByRole('button', { name: 'Upcoming' })).toHaveProperty('ariaPressed', 'true');
  });

  it('searches titles on the server once typing pauses', async () => {
    serve(() => [venue]);
    const user = show();
    await rowOf('Confirm the venue');
    await user.type(screen.getByRole('searchbox', { name: 'Search for task title' }), 'venue');
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'all', q: 'venue', limit: 20 },
      });
    });
    // Not once for every key.
    expect(
      server.calls.filter(
        (call) =>
          call.operation === 'listTasks' &&
          (call.input as { query: { q?: string } }).query.q !== undefined,
      ),
    ).toHaveLength(1);
  });

  it('opens on the title an address carries', async () => {
    serve(() => [venue]);
    show({ q: 'venue' });
    await rowOf('Confirm the venue');
    expect(screen.getByRole('searchbox', { name: 'Search for task title' })).toHaveProperty(
      'value',
      'venue',
    );
    expect(inputOf('listTasks')).toEqual({
      query: { scope: 'all', status: 'all', q: 'venue', limit: 20 },
    });
  });

  it('sorts by title and by due date on the server: upwards, downwards, then as it was', async () => {
    serve(() => [venue]);
    const user = show();
    await rowOf('Confirm the venue');
    const heading = (name: RegExp): HTMLElement => screen.getByRole('columnheader', { name });
    expect(heading(/^Title/).getAttribute('aria-sort')).toBe('none');
    await user.click(within(heading(/^Title/)).getByRole('button'));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'all', sort: 'title', direction: 'asc', limit: 20 },
      });
    });
    expect(heading(/^Title/).getAttribute('aria-sort')).toBe('ascending');
    await user.click(within(heading(/^Title/)).getByRole('button'));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'all', sort: 'title', direction: 'desc', limit: 20 },
      });
    });
    expect(heading(/^Title/).getAttribute('aria-sort')).toBe('descending');
    await user.click(within(heading(/^Due date/)).getByRole('button'));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'all', sort: 'due', direction: 'asc', limit: 20 },
      });
    });
    expect(heading(/^Title/).getAttribute('aria-sort')).toBe('none');
    await user.click(within(heading(/^Due date/)).getByRole('button'));
    await user.click(within(heading(/^Due date/)).getByRole('button'));
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({ query: { scope: 'all', status: 'all', limit: 20 } });
    });
  });

  it('lists the tasks of one person on the team, by name', async () => {
    serve(() => [quote]);
    const user = show();
    await rowOf('Send the quote');
    await choose(user, screen.getByRole('combobox', { name: 'Assignee' }), 'Lee Park');
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: { scope: 'all', status: 'all', assignee: lee, limit: 20 },
      });
    });
    // The signed-in person is "Assigned to me", not a second entry by name.
    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
    expect(screen.queryByRole('option', { name: 'Dana Brooks' })).toBeNull();
  });

  it('asks for a range of due days, and not at all for one that runs backwards', async () => {
    serve(() => [venue]);
    show();
    await rowOf('Confirm the venue');
    const range = screen.getByRole('group', { name: 'Due date' });
    fireEvent.change(within(range).getByLabelText('Due from'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(range).getByLabelText('Due to'), { target: { value: '2026-10-31' } });
    await waitFor(() => {
      expect(inputOf('listTasks')).toEqual({
        query: {
          scope: 'all',
          status: 'all',
          dueFrom: new Date(2026, 9, 1).toISOString(),
          dueBefore: new Date(2026, 10, 1).toISOString(),
          limit: 20,
        },
      });
    });
    const asked = server.calls.length;
    fireEvent.change(within(range).getByLabelText('Due to'), { target: { value: '2026-09-01' } });
    expect((await screen.findByRole('alert')).textContent).toBe('The range ends before it starts.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(server.calls).toHaveLength(asked);
  });

  it('walks the pages with the cursor alone when a server gives no total', async () => {
    const second = taskOf(3, 'Order the flowers');
    serve(
      () => [venue],
      (operation, input) => {
        if (operation !== 'listTasks') return undefined;
        const { query } = input as { query: { after?: string } };
        return query.after === 'task_1'
          ? { canManage: true, items: [second], nextCursor: null }
          : { canManage: true, items: [venue], nextCursor: 'task_1' };
      },
    );
    const user = show();
    await rowOf('Confirm the venue');
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('status').textContent).toBe('Page 1');
    expect(within(pages).getByRole('button', { name: 'Previous page' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(pages).getByRole('button', { name: 'Next page' }));
    await rowOf('Order the flowers');
    expect(inputOf('listTasks')).toEqual({
      query: { scope: 'all', status: 'all', limit: 20, after: 'task_1' },
    });
    expect(within(pages).getByRole('status').textContent).toBe('Page 2');
    expect(within(pages).getByRole('button', { name: 'Next page' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(pages).getByRole('button', { name: 'Previous page' }));
    await rowOf('Confirm the venue');
  });

  it('completes and reopens a task from its round button, with the revision it read', async () => {
    let tasks = [venue];
    serve(
      () => tasks,
      (operation, input) => {
        if (operation !== 'completeTask') return undefined;
        const { body } = input as { body: { completed: boolean } };
        tasks = [{ ...venue, completedAt: body.completed ? at : null, revision: revisionB }];
        return tasks[0];
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Complete Confirm the venue' }));
    expect(await screen.findByText('Task completed.')).toBeTruthy();
    expect(inputOf('completeTask')).toEqual({
      params: { id: 'task_1' },
      body: { completed: true, revision: revisionA },
    });
    await user.click(await screen.findByRole('button', { name: 'Reopen Confirm the venue' }));
    expect(await screen.findByText('Task reopened.')).toBeTruthy();
    expect(inputOf('completeTask')).toEqual({
      params: { id: 'task_1' },
      body: { completed: false, revision: revisionB },
    });
  });

  it('shows the list as it is now when a task changed before it could be completed', async () => {
    let tasks = [venue];
    serve(
      () => tasks,
      (operation) => {
        if (operation !== 'completeTask') return undefined;
        tasks = [{ ...venue, title: 'Confirm the venue and the caterer', revision: revisionB }];
        throw stale();
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Complete Confirm the venue' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This task changed. Refresh it before saving, completing or deleting.',
    );
    expect(await rowOf('Confirm the venue and the caterer')).toBeTruthy();
  });

  it('adds a task for a contact, then offers the empty form again', async () => {
    const tasks: Task[] = [];
    serve(
      () => tasks,
      (operation, input) => {
        if (operation === 'listContacts')
          return {
            items: [
              { id: 'con_maya', name: 'Maya Thompson', email: 'maya@example.com', phone: null },
            ],
            next: null,
          };
        if (operation !== 'createTask') return undefined;
        const { body } = input as { body: { title: string } };
        const made = taskOf(tasks.length + 5, body.title);
        tasks.push(made);
        return made;
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Add Task' }));
    const panel = await screen.findByRole('dialog', { name: 'New task' });
    const save = await within(panel).findByRole('button', { name: 'Save' });
    const another = within(panel).getByRole('button', { name: 'Save and add another' });
    expect(save).toHaveProperty('disabled', true);
    expect(another).toHaveProperty('disabled', true);
    await user.type(within(panel).getByLabelText('Title'), 'Prepare the quote');
    await user.type(within(panel).getByLabelText('Description'), 'Two options.');
    fireEvent.change(within(panel).getByLabelText(/^Due date and time/), {
      target: { value: '2026-10-12T09:30' },
    });
    await choose(user, within(panel).getByRole('combobox', { name: 'Assign to' }), 'Lee Park');
    await user.type(within(panel).getByLabelText('Contact'), 'maya');
    await user.click(await within(panel).findByRole('button', { name: /Maya Thompson/ }));
    expect(inputOf('listContacts')).toEqual({ query: { q: 'maya', limit: 6 } });
    expect(within(panel).getByRole('button', { name: 'Remove Maya Thompson' })).toBeTruthy();
    await user.click(another);
    await waitFor(() => {
      expect(inputOf('createTask')).toEqual({
        body: {
          title: 'Prepare the quote',
          description: 'Two options.',
          dueAt: new Date('2026-10-12T09:30').toISOString(),
          assignee: lee,
          recordId: 'con_maya',
        },
      });
    });
    expect(
      await within(panel).findByText('Task added. Add another, or close the panel.'),
    ).toBeTruthy();
    const title = within(panel).getByLabelText('Title');
    expect(title).toHaveProperty('value', '');
    await user.type(title, 'Book the van');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Task added.')).toBeTruthy();
    expect(inputOf('createTask')).toEqual({
      body: {
        title: 'Book the van',
        description: '',
        dueAt: null,
        assignee: null,
        recordId: null,
      },
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull();
    });
    expect(await rowOf('Book the van')).toBeTruthy();
  });

  it('keeps a draft over a newer saved version, or gives it up for that version', async () => {
    let tasks = [venue];
    let refuse = true;
    serve(
      () => tasks,
      (operation) => {
        if (operation !== 'updateTask') return undefined;
        if (refuse) {
          refuse = false;
          tasks = [{ ...venue, title: 'Confirm the venue by Friday', revision: revisionB }];
          throw stale();
        }
        return tasks[0];
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Edit Confirm the venue' }));
    const panel = await screen.findByRole('dialog', { name: 'Edit task' });
    const title = await within(panel).findByLabelText('Title');
    expect(within(panel).queryByRole('button', { name: 'Save and add another' })).toBeNull();
    expect(within(panel).getByText('Maya Thompson')).toBeTruthy();
    expect(within(panel).queryByLabelText('Contact')).toBeNull();
    await user.clear(title);
    await user.type(title, 'Confirm the venue today');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(
      'This task changed. Refresh it before saving, completing or deleting.',
    );
    expect(inputOf('updateTask')).toEqual({
      params: { id: 'task_1' },
      body: {
        title: 'Confirm the venue today',
        description: 'Call the harbour office before noon.',
        dueAt: '2026-10-09T06:30:00.000Z',
        assignee: 'me',
        revision: revisionA,
      },
    });
    expect(within(panel).getByRole('button', { name: 'Reload saved version' })).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Keep my draft' }));
    await waitFor(() => {
      expect(within(panel).queryByRole('alert')).toBeNull();
    });
    expect(title).toHaveProperty('value', 'Confirm the venue today');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Task saved.')).toBeTruthy();
    expect(inputOf('updateTask')).toMatchObject({
      body: { title: 'Confirm the venue today', revision: revisionB },
    });
  });

  it('loads the saved version into the panel when the draft is given up', async () => {
    let tasks = [venue];
    serve(
      () => tasks,
      (operation) => {
        if (operation !== 'updateTask') return undefined;
        tasks = [{ ...venue, title: 'Confirm the venue by Friday', revision: revisionB }];
        throw stale();
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Edit Confirm the venue' }));
    const panel = await screen.findByRole('dialog', { name: 'Edit task' });
    await user.type(await within(panel).findByLabelText('Title'), ' today');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await user.click(await within(panel).findByRole('button', { name: 'Reload saved version' }));
    await waitFor(() => {
      expect(within(panel).getByLabelText('Title')).toHaveProperty(
        'value',
        'Confirm the venue by Friday',
      );
    });
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('sends a refused task again when Save is pressed without changing the field', async () => {
    let refuse = true;
    serve(
      () => [venue],
      (operation) => {
        if (operation !== 'updateTask') return undefined;
        if (!refuse) return venue;
        refuse = false;
        throw new ApiError({
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          errors: [{ path: '/title', code: 'invalid', message: 'Use a shorter title.' }],
        });
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Edit Confirm the venue' }));
    const panel = await screen.findByRole('dialog', { name: 'Edit task' });
    const save = await within(panel).findByRole('button', { name: 'Save' });
    await user.click(save);
    expect(await within(panel).findByText('Use a shorter title.')).toBeTruthy();
    expect(within(panel).getByLabelText('Title').getAttribute('aria-invalid')).toBe('true');
    // The server may answer differently now: the same title is asked about anew.
    await user.click(save);
    expect(await screen.findByText('Task saved.')).toBeTruthy();
    expect(server.calls.filter((call) => call.operation === 'updateTask')).toHaveLength(2);
  });

  it('takes a refusal off a field as soon as the field changes', async () => {
    serve(
      () => [venue],
      (operation) => {
        if (operation !== 'updateTask') return undefined;
        throw new ApiError({
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          errors: [
            { path: '/title', code: 'invalid', message: 'Use a shorter title.' },
            { path: '/description', code: 'invalid', message: 'Say less.' },
          ],
        });
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Edit Confirm the venue' }));
    const panel = await screen.findByRole('dialog', { name: 'Edit task' });
    await user.click(await within(panel).findByRole('button', { name: 'Save' }));
    expect(await within(panel).findByText('Use a shorter title.')).toBeTruthy();
    expect(within(panel).getByText('Say less.')).toBeTruthy();
    await user.type(within(panel).getByLabelText('Title'), '!');
    expect(within(panel).queryByText('Use a shorter title.')).toBeNull();
    expect(within(panel).getByText('Say less.')).toBeTruthy();
  });

  it('says under the field when the person chosen has left the team', async () => {
    serve(
      () => [venue],
      (operation) => {
        if (operation !== 'updateTask') return undefined;
        throw new ApiError({
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          errors: [
            {
              path: '/assignee',
              code: 'unavailable_assignee',
              message: 'Choose someone on this business or agency team.',
            },
          ],
        });
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Edit Confirm the venue' }));
    const panel = await screen.findByRole('dialog', { name: 'Edit task' });
    const assignee = await within(panel).findByRole('combobox', { name: 'Assign to' });
    await choose(user, assignee, 'Lee Park');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(
      'Choose someone on this business or agency team.',
    );
    await choose(user, assignee, 'Unassigned');
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('asks before deleting, and again when the task changed meanwhile', async () => {
    let tasks = [venue, quote];
    let refuse = true;
    serve(
      () => tasks,
      (operation) => {
        if (operation !== 'deleteTask') return undefined;
        if (refuse) {
          refuse = false;
          tasks = [{ ...venue, title: 'Confirm the venue by Friday', revision: revisionB }, quote];
          throw stale();
        }
        tasks = [quote];
        return null;
      },
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Delete Confirm the venue' }));
    const asking = await screen.findByRole('dialog', { name: 'Delete Confirm the venue?' });
    await user.click(within(asking).getByRole('button', { name: 'Delete' }));
    const again = await screen.findByRole('dialog', {
      name: 'Delete Confirm the venue by Friday?',
    });
    expect(within(again).getByRole('alert').textContent).toBe(
      'Someone changed this task. Check its name above, then delete it again.',
    );
    expect(inputOf('deleteTask')).toEqual({
      params: { id: 'task_1' },
      body: { revision: revisionA },
    });
    await user.click(within(again).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Task deleted.')).toBeTruthy();
    expect(inputOf('deleteTask')).toEqual({
      params: { id: 'task_1' },
      body: { revision: revisionB },
    });
    await waitFor(() => {
      expect(screen.queryByRole('rowheader', { name: /Confirm the venue/ })).toBeNull();
    });
  });

  it('ticks tasks and marks them complete in one request, then lets go of the ticks', async () => {
    const flowers = taskOf(3, 'Order the flowers');
    let tasks = [venue, flowers];
    serve(
      () => tasks,
      (operation) => {
        if (operation !== 'bulkUpdateTasks') return undefined;
        tasks = tasks.map((each) => ({ ...each, completedAt: at, revision: revisionB }));
        return {
          action: 'complete',
          results: [
            { id: 'task_1', outcome: 'done', reason: null },
            { id: 'task_3', outcome: 'done', reason: null },
          ],
          done: 2,
          unchanged: 0,
          skipped: 0,
        };
      },
    );
    const user = show();
    await rowOf('Confirm the venue');
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select every task on this page' }));
    const bar = screen.getByRole('group', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select Order the flowers' })).toHaveProperty(
      'checked',
      true,
    );
    await user.click(within(bar).getByRole('button', { name: 'Mark complete' }));
    expect(await screen.findByText('2 tasks changed.')).toBeTruthy();
    expect(inputOf('bulkUpdateTasks')).toEqual({
      body: { action: 'complete', ids: ['task_1', 'task_3'] },
    });
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Reopen Order the flowers' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('2 tasks changed.')).toBeNull();
  });

  it('says what was skipped and why, and keeps those rows ticked', async () => {
    const flowers = taskOf(3, 'Order the flowers');
    serve(
      () => [venue, quote, flowers],
      (operation) =>
        operation === 'bulkUpdateTasks'
          ? {
              action: 'reopen',
              results: [
                { id: 'task_2', outcome: 'done', reason: null },
                { id: 'task_1', outcome: 'unchanged', reason: null },
                {
                  id: 'task_3',
                  outcome: 'skipped',
                  reason: { code: 'changed', message: 'Someone else changed it just now.' },
                },
              ],
              done: 1,
              unchanged: 1,
              skipped: 1,
            }
          : undefined,
    );
    const user = show();
    await rowOf('Confirm the venue');
    await user.click(screen.getByRole('checkbox', { name: 'Select Send the quote' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Confirm the venue' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Order the flowers' }));
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(
      await screen.findByText(
        '1 task changed. 1 was already as asked. 1 was skipped and is still ticked:',
      ),
    ).toBeTruthy();
    // In the order the list shows them, whatever the order they were ticked in.
    expect(inputOf('bulkUpdateTasks')).toEqual({
      body: { action: 'reopen', ids: ['task_1', 'task_2', 'task_3'] },
    });
    const skipped = screen.getByRole('list', { name: 'Skipped tasks' });
    expect(within(skipped).getByRole('listitem').textContent).toBe(
      'Order the flowers: Someone else changed it just now.',
    );
    expect(screen.getByRole('checkbox', { name: 'Select Order the flowers' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByRole('checkbox', { name: 'Select Confirm the venue' })).toHaveProperty(
      'checked',
      false,
    );
    expect(
      within(screen.getByRole('group', { name: 'Bulk actions' })).getByText('1 selected'),
    ).toBeTruthy();
  });

  it('assigns the ticked tasks to someone on the team, and says when that person has left', async () => {
    let refuse = true;
    serve(
      () => [venue, quote],
      (operation) => {
        if (operation !== 'bulkUpdateTasks') return undefined;
        if (refuse) {
          refuse = false;
          throw new ApiError({
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            errors: [
              {
                path: '/assignee',
                code: 'unavailable_assignee',
                message: 'Choose someone on this business or agency team.',
              },
            ],
          });
        }
        return {
          action: 'assign',
          results: [{ id: 'task_1', outcome: 'done', reason: null }],
          done: 1,
          unchanged: 0,
          skipped: 0,
        };
      },
    );
    const user = show();
    await rowOf('Confirm the venue');
    await user.click(screen.getByRole('checkbox', { name: 'Select Confirm the venue' }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign tasks' });
    expect(within(dialog).getByText('1 task is selected.')).toBeTruthy();
    await choose(user, within(dialog).getByRole('combobox', { name: 'Assign to' }), 'Lee Park');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Choose someone on this business or agency team.',
    );
    expect(inputOf('bulkUpdateTasks')).toEqual({
      body: { action: 'assign', ids: ['task_1'], assignee: lee },
    });
    await choose(user, within(dialog).getByRole('combobox', { name: 'Assign to' }), 'Me');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('1 task changed.')).toBeTruthy();
    expect(inputOf('bulkUpdateTasks')).toEqual({
      body: { action: 'assign', ids: ['task_1'], assignee: 'me' },
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Assign tasks' })).toBeNull();
    });
  });

  it('gives the ticked tasks a due time, or takes it away', async () => {
    serve(
      () => [venue, quote],
      (operation) =>
        operation === 'bulkUpdateTasks'
          ? {
              action: 'set_due',
              results: [{ id: 'task_2', outcome: 'done', reason: null }],
              done: 1,
              unchanged: 0,
              skipped: 0,
            }
          : undefined,
    );
    const user = show();
    await rowOf('Send the quote');
    await user.click(screen.getByRole('checkbox', { name: 'Select Send the quote' }));
    await user.click(screen.getByRole('button', { name: 'Change due date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change due date' });
    const apply = within(dialog).getByRole('button', { name: 'Apply' });
    expect(apply).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText(/^Due date and time/), {
      target: { value: '2026-10-12T09:30' },
    });
    await user.click(apply);
    expect(await screen.findByText('1 task changed.')).toBeTruthy();
    expect(inputOf('bulkUpdateTasks')).toEqual({
      body: {
        action: 'set_due',
        ids: ['task_2'],
        dueAt: new Date('2026-10-12T09:30').toISOString(),
      },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Select Send the quote' }));
    await user.click(screen.getByRole('button', { name: 'Change due date' }));
    const again = await screen.findByRole('dialog', { name: 'Change due date' });
    await user.click(within(again).getByRole('checkbox', { name: 'Clear the due date instead' }));
    await user.click(within(again).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(inputOf('bulkUpdateTasks')).toEqual({
        body: { action: 'set_due', ids: ['task_2'], dueAt: null },
      });
    });
  });

  it('deletes the ticked tasks only after saying it is for good', async () => {
    let tasks = [venue, quote];
    serve(
      () => tasks,
      (operation) => {
        if (operation !== 'bulkUpdateTasks') return undefined;
        tasks = [];
        return {
          action: 'delete',
          results: [
            { id: 'task_1', outcome: 'done', reason: null },
            { id: 'task_2', outcome: 'done', reason: null },
          ],
          done: 2,
          unchanged: 0,
          skipped: 0,
        };
      },
    );
    const user = show();
    await rowOf('Confirm the venue');
    await user.click(screen.getByRole('checkbox', { name: 'Select every task on this page' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Bulk actions' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const asking = await screen.findByRole('dialog', { name: 'Delete 2 tasks?' });
    expect(asking.textContent).toContain("This can't be undone");
    expect(server.calls.some((call) => call.operation === 'bulkUpdateTasks')).toBe(false);
    await user.click(within(asking).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('2 tasks deleted.')).toBeTruthy();
    expect(inputOf('bulkUpdateTasks')).toEqual({
      body: { action: 'delete', ids: ['task_1', 'task_2'] },
    });
    expect(await screen.findByText('No tasks yet.')).toBeTruthy();
  });

  it('says why a bulk action did not run at all', async () => {
    serve(
      () => [venue],
      (operation) => {
        if (operation !== 'bulkUpdateTasks') return undefined;
        throw new ApiError({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'You need permission to manage tasks.',
        });
      },
    );
    const user = show();
    await rowOf('Confirm the venue');
    await user.click(screen.getByRole('checkbox', { name: 'Select Confirm the venue' }));
    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You need permission to manage tasks.',
    );
  });

  it('only reads for someone who may not manage tasks', async () => {
    serve(() => [venue, quote], undefined, false);
    show();
    const row = await rowOf('Confirm the venue');
    expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(within(row).getByText('Open')).toBeTruthy();
    expect(within(await rowOf('Send the quote')).getByText('Completed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Task' })).toBeNull();
    expect(
      screen.getByText('You can read tasks. Changing them needs permission to manage tasks.'),
    ).toBeTruthy();
  });
});
