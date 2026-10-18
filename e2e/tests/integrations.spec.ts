// Settings → Integrations on the whole product, on the "Verify day" install (global-setup.ts):
// the built server with its worker and the built dashboard over a migrated Postgres, with the
// stand-in OAuth provider (packages/modules/integrations/test/fake-provider.ts) registered as
// a provider the install can connect. Nothing of the product is stood in for: the browser
// goes to the stand-in's consent page and back to the callback, the app trades the code and
// seals the tokens, the worker opens them to read the account, and disconnecting revokes them
// at the stand-in and removes them from the vault. No request leaves this machine.
import { expect, test } from '@playwright/test';

import { address, asClient, integrationsDay } from '../servers.js';
import { checks, checksQuery as query, signInToChecks } from '../verify-day.js';

test.use(asClient('203.0.113.210'));

const page$ = (path = '') => checks(path, integrationsDay.business.slug);

test('Integrations: the stand-in connected through its consent page, confirmed by the worker, then disconnected and revoked', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInToChecks(page, integrationsDay.owner.email);
  await page.goto(page$('/settings/integrations'));
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();

  // The connections that live on pages of their own are drawn with their real state.
  const card = (name: string) => page.getByRole('article', { name, exact: true });
  await expect(card('Apps and API keys')).toBeVisible();
  const standIn = card('Stand-in');
  await expect(standIn).toBeVisible();

  // Connect: the stand-in's consent page, then Allow, then back to the CRM.
  await standIn.getByRole('button', { name: 'Connect Stand-in' }).click();
  await expect(page.getByRole('heading', { name: 'Allow access to Stand-in' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(address('integrationProvider'));
  await page.getByRole('link', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/settings\/integrations/);
  await expect(page.getByText('Stand-in is connected. Checking the account…')).toBeVisible();
  // The worker reads the account; the page asks again while it is being checked.
  await expect(standIn.getByText(integrationsDay.account.name)).toBeVisible({ timeout: 60_000 });

  // What the install keeps: a connected row, with only a sealed secret and no token in clear.
  const [kept] = await query<{ status: string; account_ref: string; ciphertext: string }>(
    `select c.status, c.account_ref, encode(s.ciphertext, 'escape') as ciphertext
     from integrations.connections c
     join tenancy.businesses b on b.id = c.business_id
     join vault.secrets s on s.id = c.secret_id and s.business_id = c.business_id
     where b.slug = $1 and c.provider = 'standin'`,
    [integrationsDay.business.slug],
  );
  expect(kept).toMatchObject({ status: 'connected', account_ref: integrationsDay.account.id });
  expect(kept?.ciphertext).not.toContain('accessToken');

  // Manage: the account, then Disconnect, which asks first.
  await standIn.getByRole('button', { name: 'Manage Stand-in' }).click();
  const panel = page.getByRole('dialog', { name: 'Manage Stand-in' });
  await expect(panel.getByText(integrationsDay.account.name).first()).toBeVisible();
  await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .or(page.getByRole('dialog', { name: /^Disconnect/ }))
    .getByRole('button', { name: 'Disconnect', exact: true })
    .click();

  // The worker revokes the token at the stand-in and removes the sealed secret.
  await expect
    .poll(
      async () =>
        (
          await query<{ status: string; secret_id: string | null }>(
            `select c.status, c.secret_id from integrations.connections c
             join tenancy.businesses b on b.id = c.business_id
             where b.slug = $1 and c.provider = 'standin'`,
            [integrationsDay.business.slug],
          )
        )[0],
      { timeout: 60_000 },
    )
    .toEqual({ status: 'disconnected', secret_id: null });
  const stats = (await (await fetch(`${address('integrationProvider')}/_stats`)).json()) as {
    revoked: { refresh: number };
  };
  expect(stats.revoked.refresh).toBeGreaterThanOrEqual(1);
});
