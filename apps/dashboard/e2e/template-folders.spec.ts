// Responsive authoring against contract-parsed stand-ins; database semantics are
// covered by the messaging integration suite, not by this browser fixture.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import * as z from 'zod';
import {
  copyWorkflowEmailTemplate,
  createMessageTemplate,
  createMessageTemplateFolder,
  messageTemplateFolderList,
  moveMessageTemplate,
  removeMessageTemplateFolder,
  updateMessageTemplateFolder,
} from '@repo/contracts';
import { checksOf, openBuilder, world } from './automation-api';
import { harborSetup } from './automation-fixtures';
import { inHarbor, signedIn } from './session';
import { templateOf, templateServer } from './template-fixtures';

const parentId = 'tfld_01h455vb4pex5vsknk084sn02q';

/**
 * Goes to a place of the library: the left panel on a wide screen, the list that stands for
 * it on a phone (where a folder is named with the folders it is in).
 */
async function showPlace(page: Page, width: number, place: RegExp): Promise<void> {
  if (width >= 1024) {
    await page
      .getByRole('navigation', { name: 'Template folders' })
      .getByRole('button', { name: place })
      // A folder inside another comes right under it, before a later one of the same name.
      .first()
      .click();
    return;
  }
  const list = page.getByRole('combobox', { name: 'Template folders' });
  const label = await list.getByRole('option', { name: place }).first().textContent();
  await list.selectOption({ label: label ?? '' });
}

/** A folder's own menu: in the panel, or beside the list on a phone once it is chosen. */
async function folderMenu(page: Page, width: number, name: string, item: string): Promise<void> {
  const scope =
    width >= 1024
      ? page.getByRole('navigation', { name: 'Template folders' })
      : page.getByRole('main');
  await scope.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
const childId = 'tfld_01h455vb4pex5vsknk084sn02r';
const siblingId = 'tfld_01h455vb4pex5vsknk084sn02s';

for (const width of [360, 1440]) {
  test(`moves a template without replacing its content at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const original = templateOf();
    const server = await templateServer(page, [original]);
    await page.route('**/api/v1/message-template-folders', (route) =>
      route.fulfill({
        json: messageTemplateFolderList.parse({
          canManage: true,
          items: [
            {
              id: parentId,
              parentId: null,
              name: 'Sales',
              revision: 1,
              templateCount: 0,
              createdAt: '2026-10-11T09:00:00Z',
              updatedAt: '2026-10-11T09:00:00Z',
            },
          ],
        }),
      }),
    );
    const moves: unknown[] = [];
    await page.route('**/api/v1/message-templates/*/folder', async (route) => {
      expect(route.request().method()).toBe('PUT');
      expect(new URL(route.request().url()).pathname).toBe(
        `/api/v1/message-templates/${original.id}/folder`,
      );
      const input = moveMessageTemplate.body.parse(route.request().postDataJSON());
      moves.push(input);
      await route.fulfill({ json: { ...original, revision: 'b'.repeat(64) } });
    });
    await page.goto(inHarbor('/marketing/emails/templates'));
    await page.getByRole('button', { name: 'Actions for Pricing guide', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Move to folder', exact: true });
    await expect(
      dialog.getByText("Moving keeps each template's content and its workflow links."),
    ).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Folder', exact: true }).selectOption(parentId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Move', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(moves).toEqual([{ revision: 'a'.repeat(64), folderId: parentId }]);
    expect(server.requests).toEqual([]);
    await page.getByRole('button', { name: 'Open Pricing guide', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Pricing guide', exact: true });
    await expect(editor.getByLabel('Subject', { exact: true })).toHaveValue(
      'Your guide, {{contact.firstName}}',
    );
    await expect(editor.getByLabel('Message', { exact: true })).toHaveValue(
      'Hi {{contact.firstName}},\nHere is our pricing guide.',
    );

    // The catalog stand-in exposes this same library asset after the move. The real
    // catalog/dispatch connection is separately covered by automation integration tests.
    const state = world({
      setup: {
        ...harborSetup,
        emailTemplates: [{ id: original.id, name: 'Pricing guide' }],
        mailboxes: [],
      },
    });
    await openBuilder(page, state, 'canvas');
    const copies: unknown[] = [];
    await page.route('**/api/v1/automations/*/draft/email-template-copy', async (route) => {
      expect(route.request().method()).toBe('POST');
      const input = copyWorkflowEmailTemplate.body.parse(route.request().postDataJSON());
      copies.push(input);
      expect(input.baseDraftVersion).toBe(3);
      expect(input.template).toBe(original.id);
      expect(input.revision).toBe('a'.repeat(64));
      const pending = input.document;
      if (pending === undefined) throw new Error('New action must include the pending draft.');
      const steps = z.record(z.string(), z.record(z.string(), z.unknown())).parse(pending['steps']);
      const target = steps[input.step];
      if (target === undefined) throw new Error('Copy target must be in the pending draft.');
      const current = state.automations[0];
      if (current === undefined) throw new Error('Workflow fixture is missing.');
      const draft = {
        ...pending,
        steps: {
          ...steps,
          [input.step]: {
            ...target,
            config: {
              mode: 'copy',
              source: { id: original.id, revision: original.revision },
              subject: original.subject,
              body: original.body,
            },
          },
        },
      };
      const saved = { ...current, draft, draftVersion: 4 };
      state.automations[0] = saved;
      await route.fulfill({
        json: { automation: saved, validation: checksOf(draft, state.setup) },
      });
    });
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Actions', exact: true })
      .getByRole('button', { name: /^Send email/ })
      .click();
    const email = page.getByRole('dialog', { name: 'Send email', exact: true });
    await email.getByRole('radio', { name: 'Select existing template', exact: true }).check();
    // The template is found in a list that can be searched.
    await email.getByRole('button', { name: /^Email template: / }).click();
    await page.getByRole('combobox', { name: 'Search by name or subject' }).fill('your guide');
    await page.getByRole('option', { name: /^Pricing guide/ }).click();
    await email.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(email).toHaveCount(0);
    expect(copies).toHaveLength(1);
    expect(state.automations[0]?.draft['steps']).toMatchObject({
      email_send: {
        type: 'email.send',
        config: {
          mode: 'copy',
          source: { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) },
          subject: 'Your guide, {{contact.firstName}}',
          body: 'Hi {{contact.firstName}},\nHere is our pricing guide.',
        },
      },
    });
    expect(state.writes.filter((write) => write.method === 'PUT')).toEqual([]);
    await page
      .locator('#automation-step-email_send')
      .getByRole('button', { name: /^Edit:/ })
      .click();
    const copiedEditor = page.getByRole('dialog', { name: 'Send email', exact: true });
    await copiedEditor
      .getByRole('textbox', { name: 'Subject', exact: true })
      .fill('Workflow-specific guide');
    // Saving as a new template is in the popup editor, opened from the email's preview.
    await copiedEditor.getByRole('button', { name: 'Edit the email', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Email', exact: true });
    await popup.getByRole('button', { name: 'Save as new template', exact: true }).click();
    const saving = popup.getByRole('form', { name: 'Save as new template', exact: true });
    await saving
      .getByRole('textbox', { name: 'New template name', exact: true })
      .fill('Workflow guide');
    await saving.getByRole('button', { name: 'Save template', exact: true }).click();
    await expect(
      popup.getByText('Saved “Workflow guide” as a new template. This email is unchanged.'),
    ).toBeVisible();
    await popup.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(popup).toBeHidden();
    expect(server.requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/message-templates',
        body: {
          name: 'Workflow guide',
          subject: 'Workflow-specific guide',
          content: {
            format: 'text',
            text: 'Hi {{contact.firstName}},\nHere is our pricing guide.',
          },
        },
      },
    ]);
    expect(server.templates.find((template) => template.name === 'Workflow guide')?.id).not.toBe(
      original.id,
    );
    expect(server.templates.find((template) => template.id === original.id)?.subject).toBe(
      'Your guide, {{contact.firstName}}',
    );
    await copiedEditor.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(copiedEditor).toHaveCount(0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => state.writes.filter((write) => write.method === 'PUT').length).toBe(1);
    expect(state.automations[0]?.draft['steps']).toMatchObject({
      email_send: {
        config: {
          mode: 'copy',
          source: { id: original.id, revision: 'a'.repeat(64) },
          subject: 'Workflow-specific guide',
        },
      },
    });
    await page.goto(inHarbor('/marketing/emails/templates'));
    await page.getByRole('button', { name: 'Open Workflow guide', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: 'Workflow guide', exact: true })
        .getByLabel('Subject', { exact: true }),
    ).toHaveValue('Workflow-specific guide');
  });

  test(`creates, renames, moves and removes a folder at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    await templateServer(page, []);
    const dates = { createdAt: '2026-10-11T09:00:00Z', updatedAt: '2026-10-11T09:00:00Z' };
    let folders = messageTemplateFolderList.parse({
      canManage: true,
      items: [
        { ...dates, id: parentId, parentId: null, name: 'Sales', revision: 1, templateCount: 0 },
      ],
    }).items;
    const changes: unknown[] = [];
    await page.route(/\/api\/v1\/message-template-folders(?:\/[^/?]+)?$/, async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          json: messageTemplateFolderList.parse({ canManage: true, items: folders }),
        });
        return;
      }
      if (request.method() === 'POST') {
        const input = createMessageTemplateFolder.body.parse(request.postDataJSON());
        changes.push({ method: 'POST', body: input });
        const saved = { ...dates, ...input, id: childId, revision: 1, templateCount: 0 };
        folders.push(saved);
        await route.fulfill({ status: 201, json: saved });
        return;
      }
      expect(new URL(request.url()).pathname).toBe(`/api/v1/message-template-folders/${childId}`);
      if (request.method() === 'PATCH') {
        const input = updateMessageTemplateFolder.body.parse(request.postDataJSON());
        changes.push({ method: 'PATCH', body: input });
        expect(input.revision).toBe(1);
        const saved = {
          ...dates,
          id: childId,
          parentId: input.parentId ?? null,
          name: input.name ?? 'Guides',
          revision: 2,
          templateCount: 0,
        };
        folders = folders.map((folder) => (folder.id === childId ? saved : folder));
        await route.fulfill({ json: saved });
        return;
      }
      expect(request.method()).toBe('DELETE');
      const input = removeMessageTemplateFolder.body.parse(request.postDataJSON());
      changes.push({ method: 'DELETE', body: input });
      folders = folders.filter((folder) => folder.id !== childId);
      await route.fulfill({ status: 204 });
    });
    await page.goto(inHarbor('/marketing/emails/templates'));
    await showPlace(page, width, /^Sales/);
    // New template → Folder makes one inside the folder showing.
    await page.getByRole('button', { name: 'New template', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Folder/ }).click();
    let dialog = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await dialog.getByLabel('Folder name').fill('Guides');
    await expect(dialog.getByLabel('Parent folder')).toHaveValue(parentId);
    await dialog.getByRole('button', { name: 'Save folder' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`folder=${childId}`));
    await folderMenu(page, width, 'Guides', 'Rename or move folder');
    dialog = page.getByRole('dialog', { name: 'Rename or move folder' });
    await expect(
      dialog
        .getByLabel('Parent folder')
        .getByRole('option', { name: 'Sales / Guides', exact: true }),
    ).toHaveCount(0);
    await dialog.getByLabel('Folder name').fill('Resources');
    await dialog.getByLabel('Parent folder').selectOption('root');
    await dialog.getByRole('button', { name: 'Save folder' }).click();
    await expect(dialog).toHaveCount(0);
    await folderMenu(page, width, 'Resources', 'Delete folder');
    dialog = page.getByRole('dialog', { name: 'Delete folder', exact: true });
    await expect(dialog.getByText(/No templates are deleted\./)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Delete folder', exact: true }).click();
    // Its parent shows next: the top of the library.
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(/folder=/);
    expect(changes).toEqual([
      { method: 'POST', body: { name: 'Guides', parentId } },
      { method: 'PATCH', body: { revision: 1, name: 'Resources', parentId: null } },
      { method: 'DELETE', body: { revision: 2 } },
    ]);
  });

  test(`creates in a nested folder with keyboard navigation at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const server = await templateServer(page, []);
    const dates = { createdAt: '2026-10-11T09:00:00Z', updatedAt: '2026-10-11T09:00:00Z' };
    await page.route('**/api/v1/message-template-folders', (route) =>
      route.fulfill({
        json: messageTemplateFolderList.parse({
          canManage: true,
          items: [
            {
              ...dates,
              id: parentId,
              parentId: null,
              name: 'Sales',
              revision: 1,
              templateCount: 0,
            },
            { ...dates, id: childId, parentId, name: 'Guides', revision: 1, templateCount: 0 },
            {
              ...dates,
              id: siblingId,
              parentId: null,
              name: 'Guides',
              revision: 1,
              templateCount: 0,
            },
          ],
        }),
      }),
    );
    const creates: unknown[] = [];
    await page.route('**/api/v1/message-templates', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const input = createMessageTemplate.body.parse(route.request().postDataJSON());
      creates.push(input);
      const saved = templateOf({
        name: input.name,
        subject: input.subject,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      server.templates.push(saved);
      await route.fulfill({ status: 201, json: saved });
    });
    await page.goto(inHarbor('/marketing/emails/templates'));
    // Folders nest in the panel; on a phone each is named with the folders it is in.
    await showPlace(page, width, width >= 1024 ? /^Guides/ : /^Sales \/ Guides/);
    await expect(page).toHaveURL(new RegExp(`folder=${childId}`));
    await page.getByRole('button', { name: 'New template', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: /^Plain text/ }).focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('region', { name: 'New template', exact: true });
    await editor.getByLabel('Name', { exact: true }).fill('Requested guide');
    await editor.getByLabel('Subject', { exact: true }).fill('Your guide');
    await editor.getByLabel('Message', { exact: true }).fill('Here is the guide you requested.');
    await editor.getByRole('button', { name: 'Create template' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('region', { name: 'Requested guide', exact: true }).getByRole('status'),
    ).toHaveText('Template saved.');
    expect(creates).toEqual([
      {
        name: 'Requested guide',
        subject: 'Your guide',
        body: 'Here is the guide you requested.',
        folderId: childId,
      },
    ]);
    expect(server.requests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
}
