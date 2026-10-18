import { setTimeout as wait } from 'node:timers/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Note } from '@repo/contracts';
import { emptyContactPanels } from './contact-panels';
import { inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

// The note editor's code arrives on demand (note-editor-loader.tsx). When it doesn't, the
// failure stays in the notes panel: the contact page and its notes remain, and a reload
// fetches the editor afresh. Against the built dashboard with the API stood in for.

const id = 'con_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
const saved: Note = {
  id: 'note_01m4bd188ff82s0add91b7pz63',
  recordId: id,
  body: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Confirm the garden venue.' }] },
    ],
  },
  text: 'Confirm the garden venue.',
  author: { kind: 'user', name: 'Dana Brooks', you: true },
  editedBy: null,
  editedAt: null,
  createdAt: at,
  updatedAt: at,
  revision: 'a'.repeat(64),
};

/** Maya's contact page, with one note Dana may change. */
async function contactWithANote(page: Page): Promise<void> {
  await signedIn(page);
  await emptyContactPanels(page);
  await page.route(`**/api/v1/contacts/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: ['maya@example.com'],
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
  await page.route(`**/api/v1/records/${id}/tags`, (route) =>
    route.fulfill({ json: { items: [], canManage: true } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  await page.route(/\/api\/v1\/records\/con_[^/]+\/notes(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { canManage: true, items: [saved], nextCursor: null } }),
  );
}

/** Fails the editor's first fetch, as a dropped connection or a deploy between loads does. */
async function editorFailsOnce(page: Page): Promise<{ requests: () => number }> {
  let requests = 0;
  await page.route(/\/assets\/note-editor-(?!controls-)[\w-]+\.js$/, (route) => {
    requests += 1;
    return requests === 1 ? route.abort('connectionreset') : route.continue();
  });
  return { requests: () => requests };
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const width of [1440, 360]) {
  test.describe(`${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('keeps saved notes accessible when the formatting controls download fails', async ({
      page,
    }) => {
      await contactWithANote(page);
      await page.route(/\/assets\/note-editor-controls-[\w-]+\.js$/, (route) =>
        route.abort('failed'),
      );
      await page.goto(inHarbor(`/contacts/${id}?view=notes`));
      const panel = page.getByRole('region', { name: 'Notes', exact: true });
      await panel.getByRole('button', { name: 'Add note', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText("The editor couldn't load.");
      await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Add note', exact: true })).toBeFocused();
      await expectNoAccessibilityViolations(page);
    });

    test('keeps the page and its notes when the editor fails to load, and loads it after a reload', async ({
      page,
    }) => {
      await contactWithANote(page);
      const editor = await editorFailsOnce(page);
      await page.goto(inHarbor(`/contacts/${id}?view=notes`));
      const panel = page.getByRole('region', { name: 'Notes', exact: true });

      await panel.getByRole('button', { name: 'Add note', exact: true }).click();

      await expect(panel.getByRole('alert')).toContainText("The editor couldn't load.");
      await expect(panel.getByRole('button', { name: 'Reload page', exact: true })).toBeFocused();
      await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
      await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toBeVisible();
      expect(editor.requests()).toBe(1);
      await expectNoAccessibilityViolations(page);

      // Cancel leaves the panel as it was, keyboard back on Add note.
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Add note', exact: true })).toBeFocused();

      await panel.getByRole('button', { name: 'Add note', exact: true }).click();
      await panel.getByRole('button', { name: 'Reload page', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
      await panel.getByRole('button', { name: 'Add note', exact: true }).click();

      await expect(panel.getByRole('textbox', { name: 'Note', exact: true })).toBeFocused();
      expect(editor.requests()).toBe(2);
    });

    test('puts the keyboard in the editor when its code takes a while to arrive', async ({
      page,
    }) => {
      await contactWithANote(page);
      // A slow connection: the editor's code arrives well after the panel said it was
      // loading. Whoever chose to write can type as soon as the editor is there.
      await page.route(/\/assets\/note-editor-[\w-]+\.js$/, async (route) => {
        await wait(600);
        await route.continue();
      });
      await page.goto(inHarbor(`/contacts/${id}?view=notes`));
      const panel = page.getByRole('region', { name: 'Notes', exact: true });

      await panel.getByRole('button', { name: 'Add note', exact: true }).click();
      await expect(panel.getByText('Loading editor…', { exact: true })).toBeVisible();

      const editor = panel.getByRole('textbox', { name: 'Note', exact: true });
      await expect(editor).toBeFocused();
      await page.keyboard.type('Ask about parking.');
      await expect(editor).toHaveText('Ask about parking.');
    });
  });
}
