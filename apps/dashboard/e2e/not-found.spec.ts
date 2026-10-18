import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { inHarbor, signedIn } from './session';

for (const width of [1440, 360]) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('says what was asked for and offers the ways on', async ({ page }) => {
      await signedIn(page);
      await page.goto(inHarbor('/no-such-page'));

      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
      const card = page.getByRole('region', { name: 'Page not found', exact: true });
      await expect(
        card.getByRole('heading', { level: 2, name: "There's nothing at this address" }),
      ).toBeVisible();
      // The address that led nowhere is shown, so a mistyped link can be seen for what it is.
      await expect(card.getByText(inHarbor('/no-such-page'), { exact: true })).toBeVisible();
      await expect(
        card.getByRole('link', { name: 'Go to the start page', exact: true }),
      ).toHaveAttribute('href', '/');
      await expect(card.getByRole('button', { name: 'Go back', exact: true })).toBeVisible();

      // Nothing runs off the side of a phone.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: `reports/not-found/not-found-${String(width)}.png` });
    });
  });
}

test('goes back to the page it was reached from', async ({ page }) => {
  await signedIn(page);
  await page.goto(inHarbor('/contacts'));
  await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
  await page.goto(inHarbor('/no-such-page'));
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL(inHarbor('/contacts'));
});
