import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { updateBusinessProfileInput, type BusinessProfile } from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';

const profile = (): BusinessProfile => ({
  id: harbor.id,
  name: harbor.name,
  timezone: 'UTC',
  locale: 'en',
  currency: 'USD',
  address: null,
  logoFileId: null,
  canManage: true,
});
for (const width of [390, 1280]) {
  test(`business profile saves settings and is accessible at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    let current = profile();
    await page.route('**/api/v1/business-profile', async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      if (route.request().method() === 'PUT')
        current = {
          ...current,
          ...updateBusinessProfileInput.parse(route.request().postDataJSON()),
        };
      await route.fulfill({ json: current });
    });
    await page.goto(inHarbor('/settings'));
    await expect(
      page.getByRole('heading', { name: 'Business Profile', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Harbor revised');
    await page.getByLabel('Time zone', { exact: true }).fill('Moon/Base');
    await page.getByLabel('Currency', { exact: true }).fill('ZZZ');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByLabel('Time zone', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.getByLabel('Currency', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.getByText("This isn't a time zone, such as America/New_York.")).toBeVisible();
    await expect(page.getByText("This isn't a currency code, such as USD.")).toBeVisible();
    await page.getByLabel('Time zone', { exact: true }).fill('Africa/Nairobi');
    await page.getByLabel('Currency', { exact: true }).fill('KES');
    await page.getByLabel('Locale', { exact: true }).fill('en-KE');
    await page.getByLabel('Street address').fill('12 Market Road');
    await page.getByLabel('Country code').fill('KE');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Business profile saved.');
    expect(current).toMatchObject({
      name: 'Harbor revised',
      timezone: 'Africa/Nairobi',
      currency: 'KES',
      locale: 'en-KE',
      address: { line1: '12 Market Road', country: 'KE' },
    });
    await page.reload();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Harbor revised');
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
    await page.screenshot({ path: testInfo.outputPath('business-profile.png'), fullPage: true });
  });
}
test('a viewer sees the profile without change controls', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/v1/business-profile', (route) =>
    route.fulfill({ json: { ...profile(), canManage: false } }),
  );
  await page.goto(inHarbor('/settings/business'));
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await expect(
    page.getByText('Only someone with permission can change this business profile.'),
  ).toBeVisible();
});
