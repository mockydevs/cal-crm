import { createVault, newSecretsKey, parseSecretsKeys } from '@repo/module-vault';
import { expect, it } from 'vitest';
import { workerTasks } from './worker-tasks.js';

it('keeps ordinary automation tasks available without an opening vault', () => {
  const names = workerTasks().map(({ name }) => name);
  expect(names).toContain('automations.match_event');
  expect(names).toContain('automations.run_step');
  expect(names).not.toContain('automations.call_webhook');
});

it('registers webhook delivery exactly once with the real worker vault', async () => {
  const { secretsKey } = await newSecretsKey(1);
  const vault = await createVault(parseSecretsKeys(secretsKey));
  const names = workerTasks(vault).map(({ name }) => name);
  expect(names.filter((name) => name === 'automations.call_webhook')).toHaveLength(1);
  expect(new Set(names).size).toBe(names.length);
});

it('takes up imports once, with file storage or without it', () => {
  // Without storage the task is still there: it ends an import saying why.
  for (const names of [workerTasks(), workerTasks(undefined, undefined, { files: undefined })])
    expect(names.filter(({ name }) => name === 'imports.run')).toHaveLength(1);
});

it('runs the two notification jobs the database queues, once each, with or without a vault', async () => {
  const { secretsKey } = await newSecretsKey(1);
  const vault = await createVault(parseSecretsKeys(secretsKey));
  for (const tasks of [workerTasks(), workerTasks(vault)]) {
    const names = tasks.map(({ name }) => name);
    for (const name of ['notifications.from_event', 'notifications.task_due'])
      expect(names.filter((each) => each === name)).toHaveLength(1);
  }
});

it("removes a deleted file's bytes where the role has file storage, once", async () => {
  const { createFiles } = await import('@repo/module-files');
  const { localStorage } = await import('@repo/storage');
  const files = createFiles({
    storage: localStorage({ directory: 'unused-in-this-test' }),
    uploadDirectory: 'unused-in-this-test',
    maxBytes: 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
  const named = (tasks: ReturnType<typeof workerTasks>) =>
    tasks.filter(({ name }) => name === 'files.remove_bytes');
  expect(named(workerTasks(undefined, undefined, undefined, undefined, { files }))).toHaveLength(1);
  expect(named(workerTasks())).toHaveLength(0);
});
