import { choose, expectChoice } from './select';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  createTagInput,
  createTagGroupInput,
  updateTagInput,
  updateTagGroupInput,
  updateTagRulesInput,
  type TagConfiguration,
} from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

const at = '2026-10-08T12:00:00.000Z';
const tagId = 'tag_01m4bd188ff82s0add91b7pz63';
const newTagId = 'tag_01m4bd9fteedat3be9bqgx2047';
const groupId = 'tgrp_01m4bdmgqwfgatd5ch0pqddfxm';
async function managedApi(page: Page, writable = true) {
  const current: TagConfiguration = configurationOf([
    {
      id: tagId,
      name: 'Hot lead',
      description: 'Asked for a quote.',
      createdAt: at,
      updatedAt: at,
    },
  ]);
  current.canManage = writable;
  current.canCreate = writable;
  const controls = { current, created: [] as unknown[], conflict: false };
  let revision = 10;
  const nextRevision = () => (++revision).toString(16).padStart(64, '0');
  await page.route(
    /\/api\/v1\/(?:tag-configuration|tag-groups|tag-rules|tags)(?:\/[^/?]+)?$/,
    async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path.endsWith('/tag-configuration')) return route.fulfill({ json: current });
      if (path.endsWith('/tags') && method === 'GET') {
        return route.fulfill({ json: { items: current.items } });
      }
      if (path.endsWith('/tag-rules')) {
        current.rules = {
          ...updateTagRulesInput.parse(route.request().postDataJSON()),
          revision: nextRevision(),
        };
        return route.fulfill({ json: current.rules });
      }
      if (path.endsWith('/tag-groups')) {
        const group = {
          ...createTagGroupInput.parse(route.request().postDataJSON()),
          id: groupId,
          revision: nextRevision(),
        };
        current.groups.push(group);
        return route.fulfill({ status: 201, json: group });
      }
      if (path.includes('/tag-groups/')) {
        const group = {
          ...updateTagGroupInput.parse(route.request().postDataJSON()),
          id: groupId,
          revision: nextRevision(),
        };
        current.groups[0] = group;
        return route.fulfill({ json: group });
      }
      if (method === 'POST') {
        const input = createTagInput.parse(route.request().postDataJSON());
        controls.created.push(input);
        const item = {
          ...input,
          groupId: input.groupId ?? null,
          id: newTagId,
          revision: nextRevision(),
          createdAt: at,
          updatedAt: at,
        };
        current.items.push(item);
        return route.fulfill({ status: 201, json: item });
      }
      if (controls.conflict) {
        controls.conflict = false;
        const old = current.items[0];
        if (old === undefined) throw new Error('Missing tag.');
        current.items[0] = {
          ...old,
          description: 'Changed by someone else.',
          revision: nextRevision(),
        };
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'This tag changed. Reload the saved version before editing again.',
          },
        });
      }
      const input = updateTagInput.parse(route.request().postDataJSON());
      const index = current.items.findIndex((item) => path.endsWith(item.id));
      const old = current.items[index];
      if (old === undefined) throw new Error('Missing tag.');
      const item = { ...old, ...input, revision: nextRevision() };
      current.items[index] = item;
      return route.fulfill({ json: item });
    },
  );
  return controls;
}

for (const width of [360, 1440]) {
  test(`groups, describes and edits tags and rules at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await signedIn(page);
    const api = await managedApi(page);
    await page.goto(inHarbor('/settings/tags'));
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    const group = page.getByRole('region', { name: 'New tag group' });
    await expect(group.getByLabel('Name', { exact: true })).toBeFocused();
    await group.getByLabel('Name', { exact: true }).fill('Audience');
    await group.getByLabel('What it means').fill('Customer segments.');
    await group.getByRole('button', { name: 'Create group' }).click();
    await page.getByRole('button', { name: 'Edit group Audience' }).click();
    await page
      .getByRole('region', { name: 'Edit tag group' })
      .getByLabel('What it means')
      .fill('The customers we serve.');
    await page.getByRole('button', { name: 'Save group' }).click();

    await page.getByRole('button', { name: 'New tag', exact: true }).click();
    const editor = page.getByRole('region', { name: 'New tag', exact: true });
    await editor.getByLabel('Name', { exact: true }).fill('Hot laed');
    await expect(page.getByRole('button', { name: 'Use existing Hot lead' })).toBeVisible();
    await editor.getByLabel('Name', { exact: true }).fill('Hot_lead');
    await page.getByRole('button', { name: 'Use existing Hot lead' }).click();
    expect(api.created).toEqual([]);
    await expect(page.getByRole('button', { name: 'New tag', exact: true })).toBeFocused();

    await page.getByRole('button', { name: 'New tag', exact: true }).click();
    await editor.getByLabel('Name', { exact: true }).fill('VIP');
    await editor.getByLabel('What it means').fill('Returning customers.');
    await choose(editor.getByLabel('Group', { exact: true }), groupId);
    await editor.getByRole('button', { name: 'Create tag' }).click();
    await page.getByRole('button', { name: 'Edit tag VIP' }).click();
    const edit = page.getByRole('region', { name: 'Edit tag', exact: true });
    await edit.getByLabel('Name', { exact: true }).fill('Returning VIP');
    await choose(edit.getByLabel('Group', { exact: true }), '');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Edit tag Returning VIP' })).toBeVisible();

    const rules = page.getByRole('region', { name: 'Tag rules' });
    await choose(rules.getByLabel('Who can create new tags'), 'everyone');
    await rules.getByRole('switch').uncheck();
    await rules.getByRole('button', { name: 'Save rules' }).click();
    await expect(page.getByRole('status')).toContainText('Tag rules saved.');
    expect(api.current.rules).toMatchObject({ creation: 'everyone', suggestSimilar: false });
    expect(api.current.groups[0]?.description).toBe('The customers we serve.');
    expect(api.current.items[1]).toMatchObject({ name: 'Returning VIP', groupId: null });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('tag-management.png'), fullPage: true });
    await page.getByRole('button', { name: 'New tag', exact: true }).click();
    await editor.getByLabel('Name', { exact: true }).fill('Hot_lead');
    await expect(page.getByText('Similar tags', { exact: true })).toBeHidden();
  });
}

test('a viewer can read definitions and rules without write controls', async ({ page }) => {
  await signedIn(page);
  await managedApi(page, false);
  await page.goto(inHarbor('/settings/tags'));
  await expect(page.getByRole('cell', { name: 'Asked for a quote.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New tag', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'New group', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: /Edit tag/ })).toBeHidden();
  await expect(page.getByLabel('Who can create new tags')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save rules' })).toBeHidden();
});

test('a late group save cannot close the tag draft opened after it', async ({ page }) => {
  await signedIn(page);
  const api = await managedApi(page);
  let release: () => void = () => {
    throw new Error('No pending group write.');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/tag-groups', async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto(inHarbor('/settings/tags'));
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Audience');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByRole('button', { name: 'New tag', exact: true }).click();
  const editor = page.getByRole('region', { name: 'New tag', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('My next draft');
  release();
  await expect.poll(() => api.current.groups.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Edit group Audience' })).toBeVisible();
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('My next draft');
});

test('keeps a tag-rule draft across background refreshes and reports a stale save', async ({
  page,
}) => {
  await signedIn(page);
  const api = await managedApi(page);
  await page.goto(inHarbor('/settings/tags'));
  const rules = page.getByRole('region', { name: 'Tag rules' });
  await choose(rules.getByLabel('Who can create new tags'), 'everyone');
  api.current.rules = { creation: 'admins', suggestSimilar: false, revision: 'b'.repeat(64) };
  const refreshed = page.waitForResponse('**/api/v1/tag-configuration');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await refreshed;
  await expectChoice(rules.getByLabel('Who can create new tags'), 'everyone');
  await expect(rules.getByRole('switch')).toBeChecked();
  await page.route('**/api/v1/tag-rules', (route) =>
    route.fulfill({
      status: 409,
      json: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'The tag rules changed. Reload the saved version before editing again.',
      },
    }),
  );
  await rules.getByRole('button', { name: 'Save rules' }).click();
  await expect(rules.getByRole('alert')).toContainText('The tag rules changed.');
  await expectChoice(rules.getByLabel('Who can create new tags'), 'everyone');
  await rules.getByRole('button', { name: 'Reload saved version' }).click();
  await expectChoice(rules.getByLabel('Who can create new tags'), 'admins');
  await expect(rules.getByRole('switch')).not.toBeChecked();
  await expect(rules.getByLabel('Who can create new tags')).toBeFocused();
});

test('preserves a stale draft and reloads only when the editor requests the saved version', async ({
  page,
}) => {
  await signedIn(page);
  const api = await managedApi(page);
  await page.goto(inHarbor('/settings/tags'));
  await page.getByRole('button', { name: 'Edit tag Hot lead' }).click();
  const editor = page.getByRole('region', { name: 'Edit tag', exact: true });
  await editor.getByLabel('What it means').fill('My unsaved draft.');
  api.conflict = true;
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('alert')).toContainText('This tag changed.');
  await expect(editor.getByLabel('What it means')).toHaveValue('My unsaved draft.');
  await editor.getByRole('button', { name: 'Reload saved version' }).click();
  await expect(editor.getByLabel('What it means')).toHaveValue('Changed by someone else.');
  await expect(editor.getByLabel('Name', { exact: true })).toBeFocused();
});

test('reload waits for a delayed saved version after an edit conflict', async ({ page }) => {
  await signedIn(page);
  const api = await managedApi(page);
  await page.goto(inHarbor('/settings/tags'));
  await page.getByRole('button', { name: 'Edit tag Hot lead' }).click();
  const editor = page.getByRole('region', { name: 'Edit tag', exact: true });
  await editor.getByLabel('What it means').fill('My unsaved draft.');
  let release: () => void = () => {
    throw new Error('No held refresh.');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/tag-configuration', async (route) => {
    await held;
    await route.fallback();
  });
  api.conflict = true;
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await editor.getByRole('button', { name: 'Reload saved version' }).click();
  release();
  await expect(editor.getByLabel('What it means')).toHaveValue('Changed by someone else.');
  await expect(editor.getByLabel('Name', { exact: true })).toBeFocused();
});
