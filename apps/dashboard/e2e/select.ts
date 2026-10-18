import { expect, type Locator } from '@playwright/test';

/** Interact with the visible themed popup, including toggled multiple selections. */
export async function choose(control: Locator, value: string | readonly string[]): Promise<void> {
  await control.click();
  const page = control.page();
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const values = typeof value === 'string' ? [value] : value;
  if (typeof value !== 'string') {
    const selected = await list.getByRole('option', { selected: true }).all();
    for (const option of selected) {
      const current = await option.getAttribute('data-value');
      if (current !== null && !values.includes(current)) await option.click();
    }
  }
  for (const next of values) {
    const choices = await list.getByRole('option').all();
    const found: Locator[] = [];
    for (const choice of choices)
      if ((await choice.getAttribute('data-value')) === next) found.push(choice);
    expect(found).toHaveLength(1);
    const chosen = found[0];
    if (chosen === undefined) throw new Error('Choice not found');
    if (typeof value === 'string' || (await chosen.getAttribute('aria-selected')) !== 'true')
      await chosen.click();
  }
  if (typeof value !== 'string') await page.keyboard.press('Escape');
}

export async function expectChoice(
  control: Locator,
  value: string | readonly string[],
): Promise<void> {
  await expect(control.locator('[data-slot="select-value"]')).toHaveAttribute(
    'data-value',
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
