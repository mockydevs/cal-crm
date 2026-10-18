import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createTask,
  createTaskInput,
  listTasks,
  listTaskAssignees,
  updateTask,
  updateTaskInput,
  completeTask,
  completeTaskInput,
  deleteTask,
  deleteTaskInput,
  bulkUpdateTasks,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { requireRecord } from '../records/access.js';
import {
  createTaskCommand,
  updateTaskCommand,
  completeTaskCommand,
  deleteTaskCommand,
  requireTask,
  readAssignees,
  type TaskOptions,
} from './tasks.js';
import { bulkTasksCommand } from './bulk.js';
import { readTasks } from './list.js';

export function taskRoutes(options: TaskOptions): readonly ApiRoute[] {
  const create = createTaskCommand(options);
  const update = updateTaskCommand(options);
  const complete = completeTaskCommand(options);
  const bulk = bulkTasksCommand(options);
  return [
    {
      endpoint: listTaskAssignees,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const parsed = parseInput(listTaskAssignees.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readAssignees(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listTaskAssignees>,
    {
      endpoint: createTask,
      command: create,
      async run({ invocation, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(createTaskInput, body);
        if (parsed.recordId !== null)
          await withTenant(services.db, invocation.context, (trx) =>
            requireRecord(trx, parsed.recordId ?? ''),
          );
        return runCommand(services, create, parsed, invocation);
      },
    } satisfies Route<typeof createTask>,
    {
      endpoint: listTasks,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const parsed = parseInput(listTasks.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readTasks(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listTasks>,
    {
      endpoint: updateTask,
      command: update,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(updateTask.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireTask(trx, parsed.id));
        return runCommand(
          services,
          update,
          { ...parseInput(updateTaskInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof updateTask>,
    {
      endpoint: completeTask,
      command: complete,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(completeTask.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireTask(trx, parsed.id));
        return runCommand(
          services,
          complete,
          { ...parseInput(completeTaskInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof completeTask>,
    {
      endpoint: deleteTask,
      command: deleteTaskCommand,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(deleteTask.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireTask(trx, parsed.id));
        return runCommand(
          services,
          deleteTaskCommand,
          { ...parseInput(deleteTaskInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof deleteTask>,
    {
      endpoint: bulkUpdateTasks,
      command: bulk,
      run({ invocation, body }, services) {
        requireBusiness(invocation.context);
        return runCommand(services, bulk, body, invocation);
      },
    } satisfies Route<typeof bulkUpdateTasks>,
  ];
}
