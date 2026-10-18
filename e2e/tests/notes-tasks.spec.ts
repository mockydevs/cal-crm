import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, me, note, recordNotes, recordActivity, task, taskList } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';

test.use(asClient('203.0.113.128'));

test('carries an assigned record task through the Dashboard, the Tasks page and its completed history', async ({
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
    data: { firstName: 'Tasks', lastName: suffix },
  });
  expect(created.status()).toBe(201);
  const savedContact = contact.parse(await created.json());
  await page.goto(inOurs(`/contacts/${savedContact.id}?view=tasks`));
  const panel = page.getByRole('region', { name: 'Tasks', exact: true });
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  await panel
    .getByRole('textbox', { name: 'Task title', exact: true })
    .fill(`Confirm venue ${suffix}`);
  await panel.getByRole('textbox', { name: 'Description', exact: true }).fill('Call before lunch.');
  await panel.getByLabel('Due date', { exact: true }).fill('2001-01-01T12:00');
  await choose(panel.getByRole('combobox', { name: 'Assigned to', exact: true }), 'me');
  const saving = page.waitForResponse(
    (response) => response.url() === `${api}/tasks` && response.request().method() === 'POST',
  );
  await panel.getByRole('button', { name: 'Save task', exact: true }).click();
  const response = await saving;
  expect(response.status()).toBe(201);
  const saved = task.parse(await response.json());
  expect(saved.assignee).toMatchObject({ you: true, name: profile.user.name });
  expect(saved.record).toEqual({ id: savedContact.id, name: savedContact.name, trashed: false });
  await expect(panel.getByText(`Confirm venue ${suffix}`, { exact: true })).toBeVisible();
  await page.goto(inOurs('/'));
  const overdue = page.getByRole('region', { name: 'Overdue tasks', exact: true });
  await expect(overdue.getByText(`Confirm venue ${suffix}`, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'My tasks', exact: true }).click();
  // The Tasks page, opened on what is assigned to this person, done or not.
  const title = `Confirm venue ${suffix}`;
  const status = page.getByRole('combobox', { name: 'Status', exact: true });
  const row = page
    .getByRole('region', { name: 'Tasks table', exact: true })
    .getByRole('row')
    .filter({ hasText: title });
  await row.getByRole('button', { name: `Complete ${title}`, exact: true }).click();
  const reopen = row.getByRole('button', { name: `Reopen ${title}`, exact: true });
  await expect(reopen).toHaveAttribute('aria-pressed', 'true');
  await choose(status, 'completed');
  await expect(reopen).toBeVisible();
  await page.reload();
  await reopen.click();
  await expect(row).toHaveCount(0);
  await choose(status, 'open');
  await row.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await editing.getByLabel('Description', { exact: true }).fill('Venue has changed.');
  await editing.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.getByText('Venue has changed.', { exact: true })).toBeVisible();
  const mine = taskList.parse(
    await (await page.request.get(`${api}/tasks?scope=mine&status=open`, { headers })).json(),
  );
  const edited = mine.items.find((each) => each.id === saved.id);
  expect(edited?.dueAt).toBe(saved.dueAt);
  expect(edited?.assignee).toEqual(saved.assignee);
  expect(edited?.description).toBe('Venue has changed.');
  await row.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  const deleting = page.waitForResponse(
    (response) =>
      response.url() === `${api}/tasks/${saved.id}` && response.request().method() === 'DELETE',
  );
  await page
    .getByRole('dialog', { name: `Delete ${title}?`, exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  expect((await deleting).status()).toBe(204);
  await expect(page.getByRole('status').filter({ hasText: /^Task deleted\.$/ })).toHaveText(
    'Task deleted.',
  );
  await expect(row).toHaveCount(0);
  const remaining = taskList.parse(
    await (
      await page.request.get(`${api}/tasks?recordId=${savedContact.id}&status=all`, { headers })
    ).json(),
  );
  expect(remaining.items).toEqual([]);
  const activity = recordActivity.parse(
    await (
      await page.request.get(`${api}/records/${savedContact.id}/activity`, { headers })
    ).json(),
  );
  const events = activity.items.filter((each) => each.type.startsWith('task.'));
  expect(events.map((each) => each.type)).toEqual([
    'task.deleted',
    'task.updated',
    'task.reopened',
    'task.completed',
    'task.created',
  ]);
  for (const event of events) {
    expect(event.actor).toMatchObject({ kind: 'user', you: true, name: profile.user.name });
    expect(event.subject).toEqual({ kind: 'task', id: saved.id });
    expect(event.payload).toEqual({ recordId: savedContact.id });
  }
});

test('saves, searches, edits and deletes a note with trusted authors and readable activity', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().slice(0, 8);
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((each) => each.slug === ours.slug);
  if (business === undefined) throw new Error('Expected the notes business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: 'Notes', lastName: suffix },
  });
  expect(created.status()).toBe(201);
  const savedContact = contact.parse(await created.json());
  const notesUrl = `${api}/records/${savedContact.id}/notes`;
  await page.goto(inOurs(`/contacts/${savedContact.id}?view=notes`));
  const panel = page.getByRole('region', { name: 'Notes', exact: true });
  await panel.getByRole('button', { name: 'Add note', exact: true }).click();
  const editor = panel.getByRole('textbox', { name: 'Note', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Confirm the garden venue.');
  const savedResponse = page.waitForResponse(
    (response) => response.url() === notesUrl && response.request().method() === 'POST',
  );
  await panel.getByRole('button', { name: 'Save note', exact: true }).click();
  const response = await savedResponse;
  expect(response.status()).toBe(201);
  const saved = note.parse(await response.json());
  expect(saved.author).toMatchObject({ kind: 'user', you: true });
  expect(saved.author.name).toBe(profile.user.name);
  expect(saved.editedBy).toBeNull();
  await expect(panel.getByText('Added by You', { exact: true })).toBeVisible();
  // The contact's activity is another panel: look there, and come back to the notes.
  const rail = page.getByRole('navigation', { name: 'Contact panels', exact: true });
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  const seeInActivity = async (text: string): Promise<void> => {
    await rail.getByRole('link', { name: 'Activity', exact: true }).click();
    await expect(activity.getByText(text, { exact: true })).toBeVisible();
    await rail.getByRole('link', { name: 'Notes', exact: true }).click();
  };
  await seeInActivity('Note added');
  await page.reload();
  await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toBeVisible();
  await panel.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('garden');
  await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Edit note', exact: true }).click();
  await expect(editor).toBeFocused();
  await editor.press('ControlOrMeta+a');
  await page.keyboard.insertText('Book the indoor hall.');
  await expect(editor).toHaveText('Book the indoor hall.');
  await panel.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('');
  await panel.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(panel.getByText('Book the indoor hall.', { exact: true })).toBeVisible();
  await expect(panel.getByText('Edited by You', { exact: true })).toBeVisible();
  await seeInActivity('Note updated');
  const edited = recordNotes.parse(await (await page.request.get(notesUrl, { headers })).json())
    .items[0];
  expect(edited?.author).toEqual(saved.author);
  expect(edited?.editedBy).toEqual(saved.author);
  expect(edited?.editedAt).not.toBeNull();
  expect(edited?.revision).not.toBe(saved.revision);
  await panel.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Keep note', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(panel.getByText('No notes yet.', { exact: true })).toBeVisible();
  await seeInActivity('Note deleted');
  const events = recordActivity
    .parse(
      await (
        await page.request.get(`${api}/records/${savedContact.id}/activity`, { headers })
      ).json(),
    )
    .items.filter((entry) => entry.type.startsWith('note.'));
  expect(events.map((entry) => entry.type)).toEqual([
    'note.deleted',
    'note.updated',
    'note.created',
  ]);
  for (const event of events) {
    expect(event.subject).toEqual({ kind: 'note', id: saved.id });
    expect(event.actor).toEqual(saved.author);
    expect(event.payload).toEqual({ recordId: savedContact.id });
  }
});
