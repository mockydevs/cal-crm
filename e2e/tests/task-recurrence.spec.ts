import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, me, notificationPreferences, task, taskList } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';

test.use(asClient('203.0.113.131'));

test('makes a contact’s task recurring, stops the series, and sets a reminder before tasks are due', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().slice(0, 8);
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((each) => each.slug === ours.slug);
  if (business === undefined) throw new Error('Expected the tasks business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: 'Recurring', lastName: suffix },
  });
  expect(created.status()).toBe(201);
  const savedContact = contact.parse(await created.json());

  // A recurring task from the contact's Tasks panel, in GoHighLevel's words.
  await page.goto(inOurs(`/contacts/${savedContact.id}?view=tasks`));
  const panel = page.getByRole('region', { name: 'Tasks', exact: true });
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  const title = `Weekly check-in ${suffix}`;
  await panel.getByRole('textbox', { name: 'Task title', exact: true }).fill(title);
  await panel.getByLabel('Due date', { exact: true }).fill('2099-01-05T09:00');
  await panel.getByRole('checkbox', { name: 'Recurring Task', exact: true }).check();
  await choose(panel.getByRole('combobox', { name: 'Unit', exact: true }), 'weekly');
  await panel
    .getByRole('radio', { name: 'After a set number of occurrences', exact: true })
    .check();
  await panel.getByRole('textbox', { name: 'Occurrences', exact: true }).fill('3');
  const saving = page.waitForResponse(
    (response) => response.url() === `${api}/tasks` && response.request().method() === 'POST',
  );
  await panel.getByRole('button', { name: 'Save task', exact: true }).click();
  const response = await saving;
  expect(response.status()).toBe(201);
  const saved = task.parse(await response.json());
  expect(saved.recurrence).toMatchObject({
    frequency: 'weekly',
    every: 1,
    ends: { type: 'after', occurrences: 3 },
    occurrence: 0,
    active: true,
  });
  // A week later on the business's wall clock.
  const dueAt = saved.dueAt ?? '';
  const next = saved.recurrence?.nextDueAt ?? '';
  expect(Math.abs(Date.parse(next) - Date.parse(dueAt) - 7 * 86_400_000)).toBeLessThanOrEqual(
    3_600_000,
  );
  await expect(panel.getByText('Repeats every week. Next due', { exact: false })).toBeAttached();

  // The series stopped from the task: it makes no more, and the task stays.
  await panel.getByRole('button', { name: 'Edit task', exact: true }).click();
  await panel.getByRole('radio', { name: 'This and all future tasks', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Keep repeating', exact: true }).uncheck();
  const editing = page.waitForResponse(
    (response) =>
      response.url() === `${api}/tasks/${saved.id}` && response.request().method() === 'PUT',
  );
  await panel.getByRole('button', { name: 'Save task', exact: true }).click();
  expect((await editing).status()).toBe(200);
  const listed = taskList.parse(
    await (
      await page.request.get(`${api}/tasks?recordId=${savedContact.id}&status=all`, { headers })
    ).json(),
  );
  expect(listed.items.find((each) => each.id === saved.id)?.recurrence).toMatchObject({
    active: false,
    nextDueAt: null,
  });
  await expect(panel.getByText('The series has ended.', { exact: false })).toBeAttached();

  // A reminder two hours before any task assigned to this person is due.
  await page.goto(inOurs('/settings/notifications'));
  await page.getByRole('textbox', { name: 'Remind me', exact: true }).fill('2');
  await choose(page.getByRole('combobox', { name: 'Unit', exact: true }), 'hours');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Your notification settings are saved.', { exact: true }),
  ).toBeVisible();
  const chosen = notificationPreferences.parse(
    await (await page.request.get(`${api}/notification-preferences`, { headers })).json(),
  );
  expect(chosen.items.find((item) => item.kind === 'task.reminder')).toEqual({
    kind: 'task.reminder',
    inApp: true,
    remindMinutes: 120,
  });
});
