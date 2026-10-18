// Settings → AI models on the whole product, on an install of its own (global-setup.ts,
// "Model day"): the built server with its worker and the built dashboard over a migrated
// Postgres. Nothing of the product is stood in for: the app seals the key with the vault's
// public half, the worker opens it and makes the call through the gateway, its adapter and
// its transport.
//
// The world outside is local. Claude is a stand-in on this machine
// (apps/server/test/fake-claude.ts), which the install's worker is told about in code
// (OutsideWorld), and the model server "of the install's own" is another
// (packages/modules/ai/test/fake-openai.ts), which the operator listed in AI_LOCAL_SERVERS
// as an operator would. No request leaves this machine, and no real provider is called.
//
// The business's providers stay connected, so this file is not written to be repeated
// against the same servers.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { modelQuery as query, models, newStaff, newTeamMember } from '../model-day.js';
import { address, asClient, modelDay } from '../servers.js';
import { signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.180'));

const KEY = modelDay.claudeKey;
const WRONG_KEY = 'sk-ant-fixture-model-day-not-the-key';
const serverLog = fileURLToPath(new URL('../test-results/servers/model-day.log', import.meta.url));

const providers = (page: Page) => page.getByRole('region', { name: 'Providers' });
const calls = (page: Page) => page.getByRole('region', { name: 'Recent calls' });

interface CallRow {
  job: string;
  provider: string;
  model: string;
  key_source: string;
  status: string;
  error_code: string | null;
  cost_estimate: string | null;
}
const recorded = () =>
  query<CallRow>(
    `select r.job, r.provider, r.model, r.key_source, r.status, r.error_code, r.cost_estimate
     from ai.requests r join tenancy.businesses b on b.id = r.business_id
     where b.slug = $1 order by r.started_at, r.id`,
    [modelDay.business.slug],
  );

test('a business connects its providers, tests them, and sees each call with its cost', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const person = await newTeamMember();
  await page.goto(`${address('modelDay')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(models('/settings'));
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'AI models' })
    .click();
  await expect(page.getByRole('heading', { name: 'AI Models', exact: true })).toBeVisible();
  await expect(calls(page).getByText('No calls yet.', { exact: false })).toBeVisible();

  // 1. Claude, with the wrong key first: the worker's one call is refused, and the page
  //    says what that means and what to do.
  await providers(page).getByRole('button', { name: 'Add Anthropic key' }).click();
  await providers(page).getByLabel('Anthropic API key').fill(WRONG_KEY);
  await providers(page).getByRole('button', { name: 'Save and test' }).click();
  await expect(providers(page).getByRole('alert')).toHaveText(
    "The provider didn't accept this key. Check that the whole key was copied and that it hasn't been revoked, then replace it.",
    { timeout: 30_000 },
  );
  await expect(providers(page).getByText('Not working', { exact: true })).toBeVisible();

  //    The right key: the test answers, with how long the provider took and what it cost.
  await providers(page).getByRole('button', { name: 'Replace Anthropic key' }).click();
  await providers(page).getByLabel('New Anthropic API key').fill(KEY);
  await providers(page).getByRole('button', { name: 'Save and test' }).click();
  await expect(providers(page).getByText(/Working · answered in \d+\.\d seconds/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(providers(page).getByText(/This test call cost \$0\.0001\./)).toBeVisible();
  await expect(providers(page).getByText('Connected', { exact: true })).toBeVisible();
  await expect(
    providers(page).getByText(`Key ending ${KEY.slice(-4)} · added by ${person.name}`, {
      exact: false,
    }),
  ).toBeVisible();

  //    Both calls are on the business's record: the refused one at no known cost, the
  //    answered one at Claude Haiku 4.5's price for 25 tokens in and 15 out.
  expect(await recorded()).toEqual([
    {
      job: 'connection_test',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      key_source: 'own',
      status: 'error',
      error_code: 'authentication',
      cost_estimate: null,
    },
    {
      job: 'connection_test',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      key_source: 'own',
      status: 'ok',
      error_code: null,
      cost_estimate: '0.000100',
    },
  ]);
  const rows = calls(page).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Connection test');
  await expect(rows.first()).toContainText('Claude Haiku 4.5');
  await expect(rows.first()).toContainText('Answered');
  await expect(rows.first()).toContainText('Cost $0.0001');
  await expect(rows.nth(1)).toContainText("The provider didn't accept this key.");
  await expect(rows.nth(1)).toContainText('Cost unknown');
  await expect(
    page.getByRole('region', { name: 'Spending' }).getByText('$0.0001', { exact: true }),
  ).toBeVisible();

  //    Neither key is anywhere it should not be: not in the page, not in a row of the
  //    database as text or as sealed bytes, not in the audit log, and not in the server's log.
  const html = await page.content();
  for (const key of [KEY, WRONG_KEY]) {
    expect(html).not.toContain(key);
    const [found] = await query<{ found: boolean }>(
      `select (select count(*) from vault.secrets where position($2::bytea in ciphertext) > 0)
            + (select count(*) from ai.provider_keys k where row_to_json(k)::text like '%' || $1 || '%')
            + (select count(*) from audit.commands where input::text like '%' || $1 || '%')
            + (select count(*) from events.events where payload::text like '%' || $1 || '%')
            + (select count(*) from ai.requests where log::text like '%' || $1 || '%') > 0 as found`,
      [key, Buffer.from(key, 'utf8')],
    );
    expect(found).toEqual({ found: false });
    expect(await readFile(serverLog, 'utf8')).not.toContain(key);
  }
  //    One sealed secret is left: replacing the key destroyed the old one.
  expect(
    await query(
      `select s.purpose from vault.secrets s join tenancy.businesses b on b.id = s.business_id
       where b.slug = $1`,
      [modelDay.business.slug],
    ),
  ).toEqual([{ purpose: 'ai.provider_key' }]);

  // 2. A model server at a private address nobody listed is refused when it is saved, with
  //    what whoever runs the install has to do, and nothing of what they did list.
  const listed = new URL(address('modelServer'));
  await providers(page).getByRole('button', { name: 'Add server' }).click();
  await providers(page).getByLabel('Server address').fill('http://10.0.0.5:11434/v1');
  await providers(page).getByLabel('Model name').fill('fixture-model');
  await providers(page).getByRole('button', { name: 'Save and test' }).click();
  await expect(
    providers(page).getByText(
      "This install can't call that address. It calls addresses that start with https://, and model servers that whoever runs the install has listed.",
    ),
  ).toBeVisible();
  const step = providers(page).getByText(/ask whoever runs this install to add/);
  await expect(step).toContainText('10.0.0.5:11434');
  await expect(step).toContainText('AI_LOCAL_SERVERS');
  expect(await page.content()).not.toContain(listed.host);

  //    The address the operator did list is saved, and the worker calls the model there.
  //    Nobody has priced the model, so the call's cost is unknown, and is said to be.
  await providers(page).getByLabel('Server address').fill(listed.href);
  await providers(page).getByRole('button', { name: 'Save and test' }).click();
  const server = providers(page).getByRole('listitem').filter({ hasText: 'Your own model server' });
  await expect(server.getByText(/Working · answered in \d+\.\d seconds/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    server.getByText(/This test call's cost is unknown: the model has no price\./),
  ).toBeVisible();
  await expect(server.getByText(`fixture-model · ${listed.href}`)).toBeVisible();
  await expect(calls(page).getByRole('listitem').first()).toContainText('Cost unknown');
  // Two calls now have no known cost: this one, and the one the provider refused.
  await expect(
    page
      .getByRole('region', { name: 'Spending' })
      .getByText(/2 calls this month have no known cost/),
  ).toBeVisible();

  // 3. With a limit that pauses AI, a model with no price cannot be held to the limit, so
  //    its test is not made, and the page says how to clear that.
  const spending = page.getByRole('region', { name: 'Spending' });
  await spending.getByRole('button', { name: 'Change limit' }).click();
  await spending.getByLabel('Monthly limit in US dollars').fill('50');
  await spending.getByRole('button', { name: 'Save limit' }).click();
  await expect(spending.getByText('of $50.00 this month')).toBeVisible();
  await server.getByRole('button', { name: 'Test Your own model server' }).click();
  await expect(server.getByRole('alert')).toContainText(
    'Not tested: this model has no price, and your limit pauses AI, so no call was made.',
    { timeout: 30_000 },
  );
  expect(await recorded()).toHaveLength(3);

  //    The agency's staff say what the install's own server costs: nothing.
  const staffContext = await browser.newContext(asClient('203.0.113.181'));
  const staffPage = await staffContext.newPage();
  const staff = await newStaff();
  await staffPage.goto(`${address('modelDay')}/sign-in`);
  await signInByLink(staffPage, staff.email, 1);
  await staffPage.goto(`${address('modelDay')}/agency/settings/ai-models`);
  const prices = staffPage.getByRole('region', { name: 'Model prices' });
  await prices.getByRole('button', { name: 'Add a price' }).click();
  const form = prices.getByRole('form', { name: 'Add a price' });
  await form.getByLabel('Model name').fill('fixture-model');
  await form.getByLabel('Input, in US dollars for a million tokens').fill('0');
  await form.getByLabel('Output, in US dollars for a million tokens').fill('0');
  await form.getByLabel('Where this price comes from').fill('Runs on our own server');
  await form.getByRole('button', { name: 'Save price' }).click();
  await expect(
    prices.getByText('Set by your agency: Runs on our own server', { exact: false }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page: staffPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await staffContext.close();

  //    Now the test is made, under the limit, and its cost is known: nothing.
  await server.getByRole('button', { name: 'Test Your own model server' }).click();
  await expect(server.getByText(/This test call cost \$0\.00\./)).toBeVisible({
    timeout: 30_000,
  });
  expect((await recorded()).at(-1)).toEqual({
    job: 'connection_test',
    provider: 'openai_compatible',
    model: 'fixture-model',
    key_source: 'own',
    status: 'ok',
    error_code: null,
    cost_estimate: '0.000000',
  });

  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test('someone whose role does not allow it sees no key, no spend and no control', async ({
  page,
}) => {
  // A member: daily work, and no AI settings.
  const person = await newTeamMember();
  await query(
    `update tenancy.memberships m set role_id = r.id
     from tenancy.roles r
     where m.user_id = $1 and r.agency_id = m.agency_id and r.scope = 'business' and r.key = 'member'`,
    [person.id],
  );
  await page.goto(`${address('modelDay')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(models('/settings/ai-models'));
  await expect(page.getByText('You need permission to manage AI settings.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'Providers' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Spending' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Recent calls' })).toHaveCount(0);
  // The API itself refuses each of them, whatever the page shows.
  for (const path of ['connections', 'settings', 'usage', 'model-prices']) {
    const answer = await page.request.get(`${address('modelDay')}/api/v1/ai/${path}`);
    expect([path, answer.status()]).toEqual([path, 403]);
    expect(await answer.text()).toContain('ai.manage');
  }
});
