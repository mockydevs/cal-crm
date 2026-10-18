import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { apiKeyList, tag } from '@repo/contracts';
import { address, asClient } from '../servers.js';
import { codeFor, emailTo, signInByLink, signOut } from '../signing-in.js';
import { choose } from '../select.js';
import { addUser } from '../users.js';

const password = 'four unrelated words for checkpoint';
const businessPath = '/b/checkpoint-events';
test.use(asClient('203.0.113.91'));

async function acceptInvitation(
  browser: Browser,
  email: string,
  name: string,
  ip: string,
): Promise<BrowserContext> {
  const context = await browser.newContext(asClient(ip));
  try {
    const invited = await context.newPage();
    await invited.goto((await emailTo(email)).link);
    await invited.getByLabel('Your name').fill(name);
    await invited.getByLabel('Password', { exact: true }).fill(password);
    await invited.getByRole('button', { name: 'Accept invitation' }).click();
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
test('a fresh install creates admins and business users, with two-factor sign-in and a scoped API key', async ({
  page,
  browser,
  playwright,
}) => {
  const app = address('freshApp');
  const setup = address('freshSetupLink');
  const adminEmail = 'first-admin@checkpoint.example';
  const staffEmail = 'staff@checkpoint.example';
  const clientEmail = 'client@checkpoint.example';
  await test.step('the printed one-time setup link creates the first admin', async () => {
    await page.goto(setup);
    await expect(page.getByRole('heading', { name: 'Create the first admin' })).toBeVisible();
    await page.getByLabel('Your name').fill('First admin');
    await page.getByLabel('Email', { exact: true }).fill(adminEmail);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create my account' }).click();
    await expect(page).toHaveURL(`${app}/agency`);
    await expect(page.getByText('No businesses yet')).toBeVisible();
    const stranger = await browser.newContext(asClient('203.0.113.92'));
    try {
      const other = await stranger.newPage();
      await other.goto(setup);
      await expect(
        other.getByRole('heading', { name: 'This setup link has run out' }),
      ).toBeVisible();
    } finally {
      await stranger.close();
    }
  });
  await test.step('the first admin creates a business with its local settings', async () => {
    await page.getByRole('button', { name: 'New business' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Checkpoint Events');
    await choose(page.getByLabel('Time zone'), 'Africa/Nairobi');
    await choose(page.getByLabel('Currency'), 'KES');
    await page.getByRole('button', { name: 'Create business', exact: true }).click();
    await expect(page).toHaveURL(`${app}${businessPath}`);
    await page.goto(`${app}${businessPath}/settings/business`);
    await expect(page.getByLabel('Time zone')).toHaveValue('Africa/Nairobi');
    await expect(page.getByLabel('Currency')).toHaveValue('KES');
  });
  await page.goto(`${app}/agency/settings/team`);
  await addUser(page, {
    email: staffEmail,
    firstName: 'Agency',
    lastName: 'Staff',
    role: 'Admin',
  });
  const staffContext = await acceptInvitation(browser, staffEmail, 'Agency staff', '203.0.113.93');
  try {
    const staff = staffContext.pages()[0];
    if (staff === undefined) throw new Error('The staff invitation opened no page.');
    await test.step('invited agency staff can enter the agency business and invite its users', async () => {
      // With only one business, the app opens it even for agency staff.
      await expect(staff).toHaveURL(`${app}${businessPath}`);
      await staff.goto(`${app}/agency`);
      await staff
        .getByRole('list', { name: 'Businesses' })
        .getByRole('link', { name: 'Checkpoint Events' })
        .click();
      await expect(staff).toHaveURL(`${app}${businessPath}`);
      await staff.goto(`${app}${businessPath}/settings/team`);
      await addUser(staff, { email: clientEmail, firstName: 'Business', lastName: 'User' });
    });
    const clientContext = await acceptInvitation(
      browser,
      clientEmail,
      'Business user',
      '203.0.113.94',
    );
    try {
      const client = clientContext.pages()[0];
      if (client === undefined) throw new Error('The business invitation opened no page.');
      await test.step('a business user works in their business with read-only profile settings', async () => {
        await expect(client).toHaveURL(`${app}${businessPath}`);
        await client.goto(`${app}${businessPath}/settings/business`);
        await expect(client.getByLabel('Name', { exact: true })).toHaveValue('Checkpoint Events');
        await expect(client.getByLabel('Name', { exact: true })).toBeDisabled();
        await expect(client.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
        await client.goto(`${app}/agency`);
        await expect(client).toHaveURL(`${app}${businessPath}`);
      });
    } finally {
      await clientContext.close();
    }
    await test.step('agency staff set up an authenticator and need its code on the next sign-in', async () => {
      await staff.goto(`${app}${businessPath}/settings/sign-in`);
      const section = staff.getByRole('region', { name: 'Two-factor sign-in' });
      await section.getByLabel('Your password').fill(password);
      await section.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
      const key = await section.getByTestId('set-up-key').textContent();
      if (key === null) throw new Error('No authenticator key was shown.');
      await section.getByLabel('The 6-digit code from the app').fill(codeFor(key));
      await section.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
      await expect(section.getByRole('list', { name: 'Recovery codes' })).toBeVisible();
      await section.getByRole('button', { name: "I've saved my recovery codes" }).click();
      await expect(section.getByText('On', { exact: true })).toBeVisible();
      await signOut(staff);
      await signInByLink(staff, staffEmail, 2);
      await expect(staff).toHaveURL(/\/sign-in\/two-factor/);
      await staff.getByLabel('Code', { exact: true }).fill(codeFor(key));
      await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(staff).toHaveURL(`${app}${businessPath}`);
    });
    await test.step('staff create a scoped key, use it without a session, and revoke it immediately', async () => {
      await staff.goto(`${app}${businessPath}/settings/apps`);
      await staff.getByRole('button', { name: 'New API key' }).click();
      await staff.getByLabel('Name', { exact: true }).fill('Checkpoint integration');
      await staff.getByRole('radio', { name: 'Custom access' }).check();
      await staff.getByRole('checkbox', { name: 'Tags', exact: true }).check();
      await staff.getByRole('checkbox', { name: 'API keys', exact: true }).check();
      await staff.getByRole('checkbox', { name: 'Manage tags' }).check();
      await staff.getByRole('checkbox', { name: 'Configure tags and creation rules' }).check();
      await staff.getByRole('button', { name: 'Create key', exact: true }).click();
      const shown = staff.getByRole('region', { name: 'Your new key' });
      const credential = await shown
        .getByRole('textbox', { name: 'Key', exact: true })
        .inputValue();
      // A separate request context carries no staff session: only the key can authorize it.
      const integration = await playwright.request.newContext({
        baseURL: app,
        extraHTTPHeaders: { Authorization: `Bearer ${credential}` },
      });
      try {
        const created = await integration.post('/api/v1/tags', {
          data: { name: 'Checkpoint verified' },
        });
        expect(created.status()).toBe(201);
        expect(tag.parse(await created.json()).name).toBe('Checkpoint verified');
        const denied = await integration.post('/api/v1/api-keys', {
          data: { name: 'Nested key', scopes: ['tags.manage'] },
        });
        expect(denied.status()).toBe(403);
        const keys = await integration.get('/api/v1/api-keys');
        expect(keys.status()).toBe(200);
        const listed = apiKeyList.parse(await keys.json());
        expect(listed.canManage).toBe(false);
        expect(listed.items.some((key) => key.name === 'Checkpoint integration')).toBe(true);
        expect(await keys.text()).not.toContain(credential);
        await shown.getByRole('button', { name: 'I’ve copied it' }).click();
        await staff.reload();
        await expect(staff.getByRole('region', { name: 'Your new key' })).toHaveCount(0);
        await staff.getByRole('button', { name: 'Revoke Checkpoint integration' }).click();
        await staff.getByRole('button', { name: 'Confirm revoke' }).click();
        await expect(staff.getByRole('status')).toHaveText(
          'Key revoked. Apps using it stop working now.',
        );
        expect((await integration.get('/api/v1/tags')).status()).toBe(401);
      } finally {
        await integration.dispose();
      }
    });
  } finally {
    await staffContext.close();
  }
});
