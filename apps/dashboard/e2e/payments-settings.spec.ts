// Payments → Settings: Reminder settings card browser spec.
// Tests add, edit, toggle and delete reminders at 1440px and 360px viewports.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  createInvoiceReminderInput,
  updateInvoiceReminderInput,
  type InvoiceReminder,
} from '@repo/contracts';
import { randomUUID } from 'node:crypto';
import { fakePaymentsApi } from './payments-fixtures';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`manages reminder settings (add, edit, toggle, delete) at ${String(width)}px`, async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width, height: 1000 });
    await fakePaymentsApi(page);

    let reminders: InvoiceReminder[] = [];
    await page.route(/\/api\/v1\/invoice-reminders(?:[/?]|$)/, async (route) => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const [, , , , id] = url.pathname.split('/');

      if (id === undefined) {
        if (method === 'GET') {
          return route.fulfill({
            status: 200,
            json: { items: reminders },
          });
        }
        if (method === 'POST') {
          const body = createInvoiceReminderInput.parse(request.postDataJSON());
          const made: InvoiceReminder = {
            id: randomUUID(),
            name: body.name,
            enabled: body.enabled,
            enabledSince: '2026-10-12T09:00:00.000Z',
            everyAmount: body.everyAmount,
            everyUnit: body.everyUnit,
            direction: body.direction,
            anchor: body.anchor,
            maxSends: body.maxSends,
            subject: body.subject,
            body: body.body,
            createdAt: '2026-10-12T09:00:00.000Z',
            updatedAt: '2026-10-12T09:00:00.000Z',
          };
          reminders = [...reminders, made];
          return route.fulfill({ status: 201, json: made });
        }
      }

      const existing = reminders.find((r) => r.id === id);
      if (existing === undefined) {
        return route.fulfill({ status: 404 });
      }

      if (method === 'PATCH') {
        const body = updateInvoiceReminderInput.parse(request.postDataJSON());
        if (body.updatedAt !== existing.updatedAt) {
          return route.fulfill({
            status: 409,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              detail: 'The invoice reminder changed since it was read.',
            }),
          });
        }
        const updated: InvoiceReminder = {
          ...existing,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.everyAmount !== undefined ? { everyAmount: body.everyAmount } : {}),
          ...(body.everyUnit !== undefined ? { everyUnit: body.everyUnit } : {}),
          ...(body.direction !== undefined ? { direction: body.direction } : {}),
          ...(body.anchor !== undefined ? { anchor: body.anchor } : {}),
          ...(body.maxSends !== undefined ? { maxSends: body.maxSends } : {}),
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          updatedAt: '2026-10-12T09:05:00.000Z',
        };
        reminders = reminders.map((r) => (r.id === id ? updated : r));
        return route.fulfill({ status: 200, json: updated });
      }

      if (method === 'DELETE') {
        reminders = reminders.filter((r) => r.id !== id);
        return route.fulfill({ status: 204 });
      }

      return route.fulfill({ status: 404 });
    });

    await page.goto(inHarbor('/payments/settings'));
    await expect(page.getByRole('heading', { level: 1, name: 'Payment settings' })).toBeVisible();

    const card = page.getByRole('region', { name: 'Reminder settings', exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText('No reminders yet.')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    // 1. ADD REMINDER
    await card.getByRole('button', { name: 'Add reminder', exact: true }).click();
    const addDialog = page.getByRole('dialog', { name: 'Add reminder', exact: true });
    await expect(addDialog).toBeVisible();

    await addDialog.getByLabel('Name', { exact: true }).fill('Due reminder');
    await addDialog
      .getByLabel('Email subject', { exact: true })
      .fill('Invoice {{invoice.number}} due');
    const message = addDialog.getByLabel('Message', { exact: true });
    await message.fill('Please pay at ');
    await addDialog.getByRole('button', { name: 'Insert invoice.url' }).click();
    await expect(message).toHaveValue('Please pay at {{invoice.url}}');

    await addDialog.getByLabel('Every', { exact: true }).fill('3');
    await choose(addDialog.getByRole('combobox', { name: 'Unit', exact: true }), 'days');
    await choose(addDialog.getByRole('combobox', { name: 'Direction', exact: true }), 'after');
    await choose(addDialog.getByRole('combobox', { name: 'Anchor date', exact: true }), 'due_date');
    await addDialog.getByLabel('Up to', { exact: true }).fill('3');

    await expectNoAccessibilityViolations(page);
    await addDialog.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect(addDialog).toBeHidden();

    await expect(card.getByText('Due reminder')).toBeVisible();
    await expect(card.getByText('Every 3 days after the due date, up to 3 times')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    // 2. EDIT REMINDER
    await card.getByRole('button', { name: 'Edit Due reminder', exact: true }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit reminder', exact: true });
    await expect(editDialog).toBeVisible();
    await editDialog.getByLabel('Name', { exact: true }).fill('Upcoming reminder');
    await choose(editDialog.getByRole('combobox', { name: 'Direction', exact: true }), 'before');
    await expect(editDialog.getByLabel('Up to', { exact: true })).toHaveCount(0);
    await editDialog.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect(editDialog).toBeHidden();

    await expect(card.getByText('Upcoming reminder')).toBeVisible();
    await expect(card.getByText('3 days before the due date')).toBeVisible();
    await expectNoAccessibilityViolations(page);

    // 3. TOGGLE REMINDER
    const toggle = card.getByRole('switch', { name: 'On: Upcoming reminder', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // 4. DELETE REMINDER
    await card.getByRole('button', { name: 'Delete Upcoming reminder', exact: true }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete reminder?', exact: true });
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toContainText('Delete "Upcoming reminder"? This cannot be undone.');
    await expectNoAccessibilityViolations(page);
    await deleteDialog.getByRole('button', { name: 'Delete for good', exact: true }).click();
    await expect(deleteDialog).toBeHidden();

    await expect(card.getByText('No reminders yet.')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);
  });
}
