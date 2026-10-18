// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Task } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskForm } from './task-panel';
import { RecurrenceMark } from './task-recurrence-mark';

interface Server {
  calls: { operation: string; input: unknown }[];
}
const server = vi.hoisted((): Server => ({ calls: [] }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve(
        endpoint.operationId === 'listTaskAssignees' ? { items: [], nextCursor: null } : {},
      );
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const wrap = (children: ReactNode) => (
  <I18nProvider i18n={i18n}>
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  </I18nProvider>
);

const seriesTask: Task = {
  id: 'task_01h455vb4pex5vsknk084sn02q',
  record: null,
  title: 'Weekly report',
  description: '',
  dueAt: '2026-10-19T13:00:00.000Z',
  assignee: null,
  completedAt: null,
  completedBy: null,
  createdAt: '2026-10-12T13:00:00.000Z',
  updatedAt: '2026-10-12T13:00:00.000Z',
  revision: 'a'.repeat(64),
  recurrence: {
    frequency: 'weekly',
    every: 1,
    ends: { type: 'never' },
    createIfOverdue: false,
    occurrence: 1,
    active: true,
    nextDueAt: '2026-10-26T13:00:00.000Z',
  },
};

function form(task: Task | undefined, onSaved = vi.fn(() => Promise.resolve())) {
  render(
    wrap(
      <TaskForm
        task={task}
        addedBefore={false}
        onCancel={vi.fn()}
        onSaved={onSaved}
        onLatest={vi.fn(() => Promise.resolve(undefined))}
        onReload={vi.fn()}
      />,
    ),
  );
  return onSaved;
}

const sent = (operation: string) =>
  server.calls.find((call) => call.operation === operation)?.input as
    { body: Record<string, unknown> } | undefined;

describe('the task panel’s Recurring Task section', () => {
  it('sends a new task with how it repeats, in GoHighLevel’s choices', async () => {
    const user = userEvent.setup();
    const saved = form(undefined);
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Weekly report');
    await user.type(screen.getByLabelText(/Due date and time/), '2026-10-19T09:00');
    await user.click(screen.getByRole('checkbox', { name: 'Recurring Task' }));
    const every = screen.getByRole('textbox', { name: 'Repeats every' });
    await user.clear(every);
    await user.type(every, '2');
    await user.click(screen.getByRole('combobox', { name: 'Unit' }));
    await user.click(await screen.findByRole('option', { name: 'Weeks' }));
    await user.click(screen.getByRole('radio', { name: 'After a set number of occurrences' }));
    const count = screen.getByRole('textbox', { name: 'Occurrences' });
    await user.clear(count);
    await user.type(count, '4');
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Create a new task even if the previous one is overdue',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(sent('createTask')?.body['recurrence']).toEqual({
      frequency: 'weekly',
      every: 2,
      ends: { type: 'after', occurrences: 4 },
      createIfOverdue: true,
    });
  });

  it('asks for a due date before a task can repeat, and for a whole number', async () => {
    const user = userEvent.setup();
    form(undefined);
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Undated');
    await user.click(screen.getByRole('checkbox', { name: 'Recurring Task' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give a recurring task a due date and time.')).toBeTruthy();
    expect(screen.getByLabelText(/Due date and time/).getAttribute('aria-invalid')).toBe('true');
    const every = screen.getByRole('textbox', { name: 'Repeats every' });
    await user.clear(every);
    await user.type(every, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use a whole number from 1 to 999.')).toBeTruthy();
    expect(sent('createTask')).toBeUndefined();
  });

  it('edits a task of a series alone, or the series, and stops it', async () => {
    const user = userEvent.setup();
    const saved = form(seriesTask);
    // This task only: how it repeats is not offered.
    expect(screen.getByRole('radio', { name: 'This task only' })).toHaveProperty('checked', true);
    expect(screen.queryByRole('checkbox', { name: 'Keep repeating' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'This and all future tasks' }));
    const keep = screen.getByRole('checkbox', { name: 'Keep repeating' });
    expect(keep).toHaveProperty('checked', true);
    await user.click(keep);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(sent('updateTask')?.body).toMatchObject({ applyTo: 'series', recurrence: null });
  });

  it('sends an edit of this task alone without the series', async () => {
    const user = userEvent.setup();
    const saved = form(seriesTask);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(sent('updateTask')?.body).not.toHaveProperty('applyTo');
    expect(sent('updateTask')?.body).not.toHaveProperty('recurrence');
  });
});

describe('an edit of the whole series', () => {
  it('sends no rule while the rule is as it was, so the schedule stays put', async () => {
    const user = userEvent.setup();
    const saved = form(seriesTask);
    await user.click(await screen.findByRole('radio', { name: 'This and all future tasks' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Weekly report, renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(sent('updateTask')?.body).toMatchObject({
      applyTo: 'series',
      title: 'Weekly report, renamed',
    });
    expect(sent('updateTask')?.body).not.toHaveProperty('recurrence');
  });

  it('sends the rule once it changed', async () => {
    const user = userEvent.setup();
    const saved = form(seriesTask);
    await user.click(await screen.findByRole('radio', { name: 'This and all future tasks' }));
    const every = screen.getByRole('textbox', { name: 'Repeats every' });
    await user.clear(every);
    await user.type(every, '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(sent('updateTask')?.body['recurrence']).toEqual({
      frequency: 'weekly',
      every: 2,
      ends: { type: 'never' },
      createIfOverdue: false,
    });
  });
});

describe('the recurrence mark', () => {
  it('says how a task repeats and when the next is due, or that the series ended', () => {
    const format = (date: Date) => date.toISOString().slice(0, 10);
    const recurrence = seriesTask.recurrence;
    if (recurrence === undefined) throw new Error('Expected a series task.');
    render(wrap(<RecurrenceMark recurrence={recurrence} format={format} />));
    expect(screen.getByText('Repeats every week. Next due 2026-10-26.')).toBeTruthy();
    cleanup();
    render(
      wrap(
        <RecurrenceMark
          recurrence={{ ...recurrence, every: 3, active: false, nextDueAt: null }}
          format={format}
        />,
      ),
    );
    expect(screen.getByText('Repeats every 3 weeks. The series has ended.')).toBeTruthy();
  });
});
