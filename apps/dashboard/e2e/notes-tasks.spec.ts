import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createNoteInput, updateNoteInput, deleteNoteInput, type Note } from '@repo/contracts';
import { signedIn, inHarbor } from './session';
import { emptyCompanyLinks, emptyContactPanels, openContactSection } from './contact-panels';
import { configurationOf } from './tag-fixtures';

const id = 'con_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
type StoredNote = Note & { editedBy: Note['author'] | null; editedAt: string | null };

/**
 * Replaces the note editor's text as a person would (CI 37843697687). Tiptap puts the cursor
 * at the end as it mounts, then focuses; on focus, ProseMirror puts its own selection back for
 * 20 ms if the page's differs (prosemirror-view's focus handler). fill() selects at the page
 * level, so its text could land after the old text. Selecting with the editor's own Mod-a
 * (Tiptap's selectAll) changes ProseMirror's selection, which nothing puts back.
 */
async function replaceNoteText(page: Page, editor: Locator, text: string): Promise<void> {
  await expect(editor).toBeFocused();
  await editor.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

for (const width of [1440, 360]) {
  test.describe(String(width) + ' px', () => {
    test.use({ viewport: { width, height: 900 } });
    test('writes, searches, edits and deletes notes without losing a rejected or stale draft', async ({
      page,
    }) => {
      await signedIn(page);
      await emptyContactPanels(page);
      await page.route(`**/api/v1/contacts/${id}`, (route) =>
        route.fulfill({
          json: {
            id,
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
      await page.route(`**/api/v1/records/${id}/tags`, (route) =>
        route.fulfill({ json: { items: [], canManage: false } }),
      );
      await page.route('**/api/v1/tag-configuration', (route) =>
        route.fulfill({ json: configurationOf([]) }),
      );
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { canManage: false, items: [], nextCursor: null } }),
      );
      let notes: StoredNote[] = [];
      let reject = true;
      let conflict = true;
      await page.route(new RegExp(`/api/v1/records/${id}/notes/note_[^/?]+$`), async (route) => {
        const current = notes[0];
        if (current === undefined) throw new Error('The note must exist.');
        if (route.request().method() === 'DELETE') {
          expect(deleteNoteInput.parse(route.request().postDataJSON()).revision).toBe(
            current.revision,
          );
          notes = [];
          return route.fulfill({ status: 204 });
        }
        const input = updateNoteInput.parse(route.request().postDataJSON());
        expect(input.revision).toBe(current.revision);
        if (conflict) {
          conflict = false;
          notes = [
            {
              ...current,
              revision: 'b'.repeat(64),
              editedBy: { kind: 'user', name: 'Jordan Lee', you: false },
              editedAt: '2026-10-08T13:00:00.000Z',
              text: 'Use the indoor hall.',
              body: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'Use the indoor hall.' }] },
                ],
              },
            },
          ];
          return route.fulfill({
            status: 409,
            json: {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              detail: 'This note changed. Refresh it before saving or deleting.',
            },
          });
        }
        notes = [
          {
            ...current,
            body: input.body,
            text: 'My unsaved venue update.',
            revision: 'c'.repeat(64),
            editedBy: { kind: 'user', name: 'Dana Brooks', you: true },
            editedAt: '2026-10-08T14:00:00.000Z',
          },
        ];
        return route.fulfill({ json: notes[0] });
      });
      await page.route(new RegExp(`/api/v1/records/${id}/notes(?:\\?.*)?$`), async (route) => {
        if (route.request().method() === 'POST') {
          const input = createNoteInput.parse(route.request().postDataJSON());
          if (reject)
            return route.fulfill({
              status: 422,
              json: {
                type: 'about:blank',
                title: 'Validation failed',
                status: 422,
                errors: [
                  {
                    path: '/body',
                    code: 'invalid_note',
                    message: 'The note was not saved. Try again.',
                  },
                ],
              },
            });
          const saved: StoredNote = {
            id: 'note_01m4bd188ff82s0add91b7pz63',
            recordId: id,
            body: input.body,
            text: 'Confirm the garden venue.',
            author: { kind: 'user', name: 'Dana Brooks', you: true },
            editedBy: null,
            editedAt: null,
            createdAt: at,
            updatedAt: at,
            revision: 'a'.repeat(64),
          };
          notes = [saved];
          return route.fulfill({ status: 201, json: saved });
        }
        const query = new URL(route.request().url()).searchParams.get('q');
        return route.fulfill({
          json: {
            canManage: true,
            items: notes.filter((note) => query === null || note.text.includes(query)),
            nextCursor: null,
          },
        });
      });
      await page.goto(inHarbor(`/contacts/${id}?view=notes`));
      const panel = page.getByRole('region', { name: 'Notes', exact: true });
      await panel.getByRole('button', { name: 'Add note', exact: true }).click();
      const editor = panel.getByRole('textbox', { name: 'Note', exact: true });
      await expect(editor).toBeFocused();
      await panel.getByRole('button', { name: 'Bold', exact: true }).click();
      await expect(editor).toBeFocused();
      await page.keyboard.type('Confirm the garden venue.');
      await panel.getByRole('button', { name: 'Save note', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('The note was not saved. Try again.');
      await expect(editor).toContainText('Confirm the garden venue.');
      reject = false;
      await panel.getByRole('button', { name: 'Save note', exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toBeVisible();
      await expect(panel.getByRole('listitem').locator('strong')).toHaveText(
        'Confirm the garden venue.',
      );
      await expect(panel.getByRole('button', { name: 'Add note', exact: true })).toBeFocused();
      await page.reload();
      await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toBeVisible();
      await expect(panel.getByText('Added by You', { exact: true })).toBeVisible();
      await expect(panel.getByText(/^Edited by /)).toHaveCount(0);
      await panel.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('indoor');
      await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toHaveCount(0);
      await panel.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('garden');
      await expect(panel.getByText('Confirm the garden venue.', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Edit note', exact: true }).click();
      await replaceNoteText(page, editor, 'My unsaved venue update.');
      await panel.getByRole('button', { name: 'Save note', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('This note changed.');
      await expect(editor).toHaveText('My unsaved venue update.');
      await panel.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('');
      await panel.getByRole('button', { name: 'Refresh notes', exact: true }).click();
      await expect(panel.getByText('Use the indoor hall.', { exact: true })).toBeVisible();
      await expect(panel.getByText('Added by You', { exact: true })).toBeVisible();
      await expect(panel.getByText('Edited by Jordan Lee', { exact: true })).toBeVisible();
      await expect(editor).toHaveText('My unsaved venue update.');
      await panel.getByRole('button', { name: 'Keep my draft', exact: true }).click();
      await expect(editor).toHaveText('My unsaved venue update.');
      await panel.getByRole('button', { name: 'Save note', exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(panel.getByText('My unsaved venue update.', { exact: true })).toBeVisible();
      await expect(panel.getByText('Edited by You', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Edit note', exact: true }).click();
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Edit note', exact: true })).toBeFocused();
      await panel.getByRole('button', { name: 'Delete note', exact: true }).click();
      const keep = panel.getByRole('button', { name: 'Keep note', exact: true });
      await expect(keep).toBeFocused();
      await keep.click();
      const remove = panel.getByRole('button', { name: 'Delete note', exact: true });
      await expect(remove).toBeFocused();
      await remove.click();
      await panel.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
      await expect(panel.getByText('No notes yet.', { exact: true })).toBeVisible();
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze()
        ).violations,
      ).toEqual([]);
    });

    test('keeps an editable draft and its saved note visible while debounced search loads', async ({
      page,
    }) => {
      await signedIn(page);
      await emptyContactPanels(page);
      await page.route(`**/api/v1/contacts/${id}`, (route) =>
        route.fulfill({
          json: {
            id,
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
      await page.route(`**/api/v1/records/${id}/tags`, (route) =>
        route.fulfill({ json: { items: [], canManage: false } }),
      );
      await page.route('**/api/v1/tag-configuration', (route) =>
        route.fulfill({ json: configurationOf([]) }),
      );
      const saved: Note = {
        id: 'note_01m4bd188ff82s0add91b7pz63',
        recordId: id,
        body: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Confirm the garden.' }] },
          ],
        },
        text: 'Confirm the garden.',
        author: { kind: 'user', name: 'Dana Brooks', you: true },
        editedBy: null,
        editedAt: null,
        createdAt: at,
        updatedAt: at,
        revision: 'a'.repeat(64),
      };
      const searching = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      const queries: string[] = [];
      await page.route(new RegExp(`/api/v1/records/${id}/notes(?:\\?.*)?$`), async (route) => {
        const q = new URL(route.request().url()).searchParams.get('q') ?? '';
        if (q !== '') {
          queries.push(q);
          searching.resolve(undefined);
          await finish.promise;
        }
        return route.fulfill({ json: { canManage: true, items: [saved], nextCursor: null } });
      });
      try {
        await page.goto(inHarbor(`/contacts/${id}?view=notes`));
        const panel = page.getByRole('region', { name: 'Notes', exact: true });
        await panel.getByRole('button', { name: 'Edit note', exact: true }).click();
        const editor = panel.getByRole('textbox', { name: 'Note', exact: true });
        await replaceNoteText(page, editor, 'My venue draft.');
        const search = panel.getByRole('searchbox', { name: 'Search notes', exact: true });
        await search.fill('Co');
        await search.fill('Confirm');
        await searching.promise;
        await expect(panel.getByRole('button', { name: 'Save note', exact: true })).toBeEnabled();
        await expect(panel.getByText(saved.text, { exact: true })).toBeVisible();
        await expect(editor).toHaveText('My venue draft.');
        expect(queries).toEqual(['Confirm']);
        finish.resolve(undefined);
        await expect(panel.getByText('Searching notes…', { exact: true })).toHaveCount(0);
        await expect(editor).toHaveText('My venue draft.');
      } finally {
        finish.resolve(undefined);
      }
    });

    test('keeps read-only notes while retrying an older page and preserves keyboard focus', async ({
      page,
    }) => {
      await signedIn(page);
      await emptyContactPanels(page);
      await page.route(`**/api/v1/contacts/${id}`, (route) =>
        route.fulfill({
          json: {
            id,
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
            canManage: false,
          },
        }),
      );
      await page.route(`**/api/v1/records/${id}/tags`, (route) =>
        route.fulfill({
          json: {
            items: [],
            canManage: false,
          },
        }),
      );
      await page.route('**/api/v1/tag-configuration', (route) =>
        route.fulfill({ json: configurationOf([]) }),
      );
      const savedNote = (noteId: string, text: string): Note => ({
        id: noteId,
        recordId: id,
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        text,
        author: { kind: 'system', name: null, you: false },
        editedBy: null,
        editedAt: null,
        createdAt: at,
        updatedAt: at,
        revision: 'a'.repeat(64),
      });
      const recent = savedNote('note_01m4bd9fteedat3be9bqgx2047', 'Recent venue update.');
      const older = savedNote('note_01m4bd188ff82s0add91b7pz63', 'Older venue update.');
      let failOlder = true;
      await page.route(new RegExp(`/api/v1/records/${id}/notes(?:\\?.*)?$`), (route) => {
        const after = new URL(route.request().url()).searchParams.get('after');
        if (after !== null) {
          expect(after).toBe(recent.id);
          if (failOlder)
            return route.fulfill({
              status: 503,
              json: { type: 'about:blank', title: 'Unavailable', status: 503 },
            });
        }
        return route.fulfill({
          json: {
            canManage: false,
            items: after === null ? [recent] : [older],
            nextCursor: after === null ? recent.id : null,
          },
        });
      });
      await page.goto(inHarbor(`/contacts/${id}?view=notes`));
      const panel = page.getByRole('region', { name: 'Notes', exact: true });
      await expect(panel.getByText(recent.text, { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Add note', exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: 'Load older notes', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText("Older notes couldn't be loaded.", {
        timeout: 15000,
      });
      await expect(panel.getByText(recent.text, { exact: true })).toBeVisible();
      failOlder = false;
      await panel.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(panel.getByText(older.text, { exact: true })).toBeVisible();
      await expect(panel.getByRole('listitem').filter({ hasText: older.text })).toBeFocused();
      await expect(
        panel.getByRole('button', { name: 'Load older notes', exact: true }),
      ).toHaveCount(0);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze()
        ).violations,
      ).toEqual([]);
    });

    for (const kind of ['contact', 'company', 'deal'] as const) {
      test('shows notes and tasks read-only on trashed ' + kind + ' records', async ({ page }) => {
        await signedIn(page);
        const recordId =
          { contact: 'con_', company: 'com_', deal: 'deal_' }[kind] + '01m4bd188ff82s0add91b7pz63';
        const pipelineId = 'pipe_01m4bd188ff82s0add91b7pz63';
        const stageId = 'stage_01m4bd188ff82s0add91b7pz63';
        await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) => {
          expect(new URL(route.request().url()).searchParams.get('recordId')).toBe(recordId);
          return route.fulfill({
            json: {
              canManage: true,
              nextCursor: null,
              items: [
                {
                  id: 'task_01m4bd188ff82s0add91b7pz63',
                  record: { id: recordId, name: 'Garden booking', trashed: true },
                  title: 'Confirm venue access',
                  description: '',
                  dueAt: null,
                  assignee: null,
                  completedAt: null,
                  completedBy: null,
                  createdAt: at,
                  updatedAt: at,
                  revision: 'a'.repeat(64),
                },
                {
                  id: 'task_01m4bd188ff82s0add91b7pz64',
                  record: { id: recordId, name: 'Garden booking', trashed: true },
                  title: 'Send the floor plan',
                  description: '',
                  dueAt: null,
                  assignee: null,
                  completedAt: at,
                  completedBy: { kind: 'user', name: 'Dana Brooks', you: false },
                  createdAt: at,
                  updatedAt: at,
                  revision: 'b'.repeat(64),
                },
              ],
            },
          });
        });
        // Choosing an assignee needs the task form, which a read-only panel never opens.
        let assigneeReads = 0;
        await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) => {
          assigneeReads += 1;
          return route.fulfill({ json: { items: [], nextCursor: null } });
        });
        await page.route(`**/api/v1/records/${recordId}/fields`, (route) =>
          route.fulfill({ json: { items: [], canManage: false, canConfirm: false } }),
        );
        await page.route(`**/api/v1/records/${recordId}/activity**`, (route) =>
          route.fulfill({ json: { items: [], next: null } }),
        );
        await page.route(`**/api/v1/records/${recordId}/tags`, (route) =>
          route.fulfill({ json: { items: [], canManage: false } }),
        );
        await page.route('**/api/v1/tag-configuration', (route) =>
          route.fulfill({ json: configurationOf([]) }),
        );
        await page.route(`**/api/v1/records/${recordId}/notes**`, (route) =>
          route.fulfill({
            json: {
              canManage: true,
              nextCursor: null,
              items: [
                {
                  id: 'note_01m4bd188ff82s0add91b7pz63',
                  recordId,
                  body: {
                    type: 'doc',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Venue access confirmed.' }],
                      },
                    ],
                  },
                  text: 'Venue access confirmed.',
                  author: { kind: 'user', name: 'Dana Brooks', you: false },
                  editedBy: null,
                  editedAt: null,
                  createdAt: at,
                  updatedAt: at,
                  revision: 'a'.repeat(64),
                },
              ],
            },
          }),
        );
        if (kind === 'contact') {
          await emptyCompanyLinks(page);
          await page.route(`**/api/v1/contacts/${recordId}/memory`, (route) =>
            route.fulfill({ json: { summary: null } }),
          );
          await page.route(`**/api/v1/contacts/${recordId}`, (route) =>
            route.fulfill({
              json: {
                id: recordId,
                firstName: 'Garden',
                lastName: 'Studio',
                name: 'Garden Studio',
                emails: [],
                phones: [],
                timeZone: null,
                doNotContact: false,
                preferencesRevision: 'a'.repeat(64),
                createdAt: at,
                updatedAt: at,
                trashedAt: at,
                canManage: true,
              },
            }),
          );
          await page.goto(inHarbor(`/contacts/${recordId}?view=notes`));
        } else if (kind === 'company') {
          await page.route(`**/api/v1/companies/${recordId}`, (route) =>
            route.fulfill({
              json: {
                id: recordId,
                name: 'Garden Studio',
                domain: null,
                phone: null,
                trashedAt: at,
                createdAt: at,
                updatedAt: at,
                canManage: true,
              },
            }),
          );
          await page.goto(inHarbor(`/contacts/companies/${recordId}`));
        } else {
          const deal = {
            id: recordId,
            name: 'Garden booking',
            pipelineId,
            stageId,
            pipelineName: 'Bookings',
            stageName: 'Enquiry',
            amount: null,
            currency: 'KES',
            expectedCloseDate: null,
            status: 'open',
            outcomeReason: null,
            closedAt: null,
            stageEnteredAt: at,
            createdAt: at,
            updatedAt: at,
            trashedAt: at,
            revision: 'a'.repeat(64),
            canManage: true,
          };
          await page.route('**/api/v1/pipelines', (route) =>
            route.fulfill({
              json: {
                items: [
                  {
                    id: pipelineId,
                    name: 'Bookings',
                    description: '',
                    archived: false,
                    stages: [{ id: stageId, name: 'Enquiry', description: '', archived: false }],
                  },
                ],
                revision: 'b'.repeat(64),
                canManage: false,
              },
            }),
          );
          await page.route(/\/api\/v1\/deals(?:\?.*)?$/, (route) =>
            route.fulfill({ json: { items: [], next: null, canManage: true } }),
          );
          await page.route(`**/api/v1/deals/${recordId}`, (route) => route.fulfill({ json: deal }));
          await page.goto(inHarbor(`/deals?deal=${recordId}&section=notes`));
        }
        const panel = page.getByRole('region', { name: 'Notes', exact: true });
        await expect(panel.getByText('Venue access confirmed.', { exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Add note', exact: true })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Edit note', exact: true })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(
          0,
        );
        // A contact's page shows one panel at a time, and an opportunity's dialog one
        // section; a company's page shows both.
        if (kind === 'contact') await openContactSection(page, 'Tasks');
        if (kind === 'deal')
          await page
            .getByRole('navigation', { name: 'Opportunity sections' })
            .getByRole('button', { name: 'Tasks', exact: true })
            .click();
        const tasks = page.getByRole('region', { name: 'Tasks', exact: true });
        await expect(tasks.getByText('Confirm venue access', { exact: true })).toBeVisible();
        await expect(tasks.getByText('Send the floor plan', { exact: true })).toBeVisible();
        for (const name of ['Add task', 'Edit task', 'Delete task', 'Complete task', 'Reopen task'])
          await expect(tasks.getByRole('button', { name, exact: true })).toHaveCount(0);
        expect(
          (
            await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
              .analyze()
          ).violations,
        ).toEqual([]);
        expect(assigneeReads).toBe(0);
      });
    }
  });
}
