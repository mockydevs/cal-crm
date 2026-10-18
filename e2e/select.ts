import { expect, type Locator } from '@playwright/test';

/**
 * Chooses one option of the dashboard's Select (packages/ui): a button that opens a themed
 * listbox, not a native <select>, so Playwright's selectOption can't drive it. The option
 * is named by its value, as a form would send it, or by the label people read. Exactly one
 * option must match, and the list must close on the choice.
 */
export async function choose(
  control: Locator,
  choice: string | { readonly label: string },
): Promise<void> {
  await control.click();
  const list = control.page().getByRole('listbox');
  await expect(list).toBeVisible();
  const option =
    typeof choice === 'string'
      ? list.locator(`[role="option"][data-value=${JSON.stringify(choice)}]`)
      : list.getByRole('option', { name: choice.label, exact: true });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(list).toBeHidden();
}

/**
 * Checks how many of a Select's options have this label. The options exist only while the
 * list is open, so it opens the list, counts, and closes it again with Escape.
 */
export async function expectOffered(control: Locator, label: string, count: number): Promise<void> {
  await control.click();
  const page = control.page();
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  await expect(list.getByRole('option', { name: label, exact: true })).toHaveCount(count);
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
}

/** Checks which option a closed Select shows as chosen, by its value. */
export async function expectChosen(control: Locator, value: string): Promise<void> {
  await expect(control.locator('[data-slot="select-value"]')).toHaveAttribute('data-value', value);
}
