import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newStaff, query, signInByLink } from '../signing-in.js';

// The App Marketplace against the real stack: the agency adds an app as a draft, which no
// business sees; it lists it; the business installs it with consent, the install survives a
// reload, and uninstalling keeps it as history. Then an app connects with OAuth: a person
// allows it on the consent page, the app trades the code for tokens, calls the API as its
// install, refreshes, and loses its access when it is uninstalled.
test.use(asClient('203.0.113.171'));

test('the agency lists an app, and a business installs and uninstalls it with consent', async ({
  page,
}) => {
  // Agency staff: they publish at agency level and work inside the agency's businesses.
  const person = await newStaff();
  const app = `Harbor Sync ${randomUUID().slice(0, 8)}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);

  await test.step('the agency adds the app as a draft', async () => {
    await page.goto(`${address('app')}/agency/settings/marketplace-apps`);
    await expect(page.getByRole('heading', { level: 1, name: 'Marketplace apps' })).toBeVisible();
    await page.getByRole('button', { name: 'Add app' }).click();
    const form = page.getByRole('region', { name: 'Add app' });
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill(app);
    await form.getByRole('textbox', { name: 'Developer', exact: true }).fill('Harbor Labs');
    await form.getByRole('checkbox', { name: 'Productivity' }).check();
    await form.getByRole('checkbox', { name: 'Manage tags' }).check();
    await form.getByRole('button', { name: 'Add app' }).click();
    await expect(page.getByRole('row').filter({ hasText: app })).toContainText('Draft');
  });

  await test.step('a draft is the agency’s alone', async () => {
    await page.goto(inOurs('/app-marketplace'));
    await page.getByRole('searchbox', { name: 'Search apps' }).fill(app);
    await expect(page.getByRole('link', { name: app })).toHaveCount(0);
  });

  await test.step('listed, the business sees it and installs it with consent', async () => {
    await page.goto(`${address('app')}/agency/settings/marketplace-apps`);
    const row = page.getByRole('row').filter({ hasText: app });
    await row.getByRole('button', { name: `List ${app}` }).click();
    await expect(row).toContainText('Listed');

    await page.goto(inOurs('/app-marketplace'));
    await page.getByRole('searchbox', { name: 'Search apps' }).fill(app);
    await page.getByRole('link', { name: app }).click();
    await expect(page.getByRole('heading', { level: 1, name: app })).toBeVisible();
    await page.getByRole('button', { name: 'Install App' }).click();
    const review = page.getByRole('dialog', { name: `Install ${app}?` });
    await expect(review.getByRole('listitem')).toHaveText(['Manage tags']);
    await review.getByRole('button', { name: 'Allow & Install' }).click();
    await expect(page.getByRole('button', { name: 'Uninstall' })).toBeVisible();
  });

  await test.step('the install is saved: it is under Installed after a reload', async () => {
    await page.goto(inOurs('/app-marketplace?tab=installed'));
    await expect(
      page.getByRole('list', { name: 'Apps' }).getByRole('link', { name: app }),
    ).toBeVisible();
    const [install] = await query<{ granted_scopes: string[]; uninstalled_at: Date | null }>(
      `select i.granted_scopes, i.uninstalled_at
         from tenancy.marketplace_installs i
         join tenancy.marketplace_apps a on a.agency_id = i.agency_id and a.id = i.app_id
        where a.name = $1`,
      [app],
    );
    expect(install).toEqual({ granted_scopes: ['tags.manage'], uninstalled_at: null });
  });

  await test.step('uninstalling asks first, and keeps the install as history', async () => {
    await page.getByRole('link', { name: app }).click();
    await page.getByRole('button', { name: 'Uninstall' }).click();
    await page
      .getByRole('dialog', { name: `Uninstall ${app}?` })
      .getByRole('button', { name: 'Uninstall' })
      .click();
    await expect(page.getByRole('button', { name: 'Install App' })).toBeVisible();
    const rows = await query<{ uninstalled_at: Date | null }>(
      `select i.uninstalled_at from tenancy.marketplace_installs i
         join tenancy.marketplace_apps a on a.agency_id = i.agency_id and a.id = i.app_id
        where a.name = $1`,
      [app],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.uninstalled_at).not.toBeNull();
  });
});

test('an app connects with OAuth, calls the API as its install, and loses access on uninstall', async ({
  page,
  request,
}) => {
  const person = await newStaff();
  const app = `Sync Bridge ${randomUUID().slice(0, 8)}`;
  const redirect = 'https://sync.example/oauth/callback';
  const hook = 'https://sync.example/hooks';
  const server = address('app');
  await page.goto(`${server}/sign-in`);
  await signInByLink(page, person.email, 1);

  let secret = '';
  let clientId = '';
  await test.step('the agency lists the app and gives its developer a client secret', async () => {
    await page.goto(`${server}/agency/settings/marketplace-apps`);
    await page.getByRole('button', { name: 'Add app' }).click();
    const form = page.getByRole('region', { name: 'Add app' });
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill(app);
    await form.getByRole('textbox', { name: 'Developer', exact: true }).fill('Bridge Labs');
    await form.getByRole('checkbox', { name: 'Manage tags' }).check();
    await form.getByRole('checkbox', { name: 'Configure tags and creation rules' }).check();
    await form
      .getByRole('group', { name: 'What it may read' })
      .getByRole('checkbox', { name: 'Tags', exact: true })
      .check();
    await form.getByRole('textbox', { name: 'Redirect addresses' }).fill(redirect);
    await form.getByRole('textbox', { name: 'Webhook address' }).fill(hook);
    await form
      .getByRole('group', { name: 'Events it is told of' })
      .getByRole('checkbox', { name: 'A tag is added to a record' })
      .check();
    await form.getByRole('button', { name: 'Add app' }).click();
    const row = page.getByRole('row').filter({ hasText: app });
    await row.getByRole('button', { name: `List ${app}` }).click();
    await expect(row).toContainText('Listed');
    await row.getByRole('button', { name: `Connection for ${app}` }).click();
    const panel = page.getByRole('region', { name: `Connect ${app}` });
    clientId = await panel.getByRole('textbox', { name: 'Client ID' }).inputValue();
    await panel.getByRole('button', { name: 'Generate client secret' }).click();
    const shown = panel.getByRole('textbox', { name: 'New client secret' });
    await expect(shown).toHaveValue(/^crm_cs_[0-9a-f]{64}$/);
    secret = await shown.inputValue();
    await panel.getByRole('button', { name: 'Generate webhook secret' }).click();
    await expect(panel.getByRole('textbox', { name: 'New webhook secret' })).toHaveValue(/^whsec_/);
    await expect(panel.getByText('Nothing sent yet.')).toBeVisible();
  });

  const verifier = randomBytes(32).toString('base64url');
  let code = '';
  await test.step('a person allows it in our business, and the app gets a code', async () => {
    // The app's own page, which the person is sent back to.
    await page.route('https://sync.example/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Back in Sync Bridge</h1>' }),
    );
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      state: 'opaque-123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    await page.goto(`${server}/oauth/authorize?${query.toString()}`);
    await page.getByLabel('Business').selectOption({ label: ours.name });
    await expect(page.getByText(`${app} wants to connect to ${ours.name}`)).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveText([
      'Configure tags and creation rules',
      'Manage tags',
      'Tags',
      'A tag is added to a record',
    ]);
    await page.getByRole('button', { name: 'Allow & Install' }).click();
    await expect(page.getByRole('heading', { name: 'Back in Sync Bridge' })).toBeVisible();
    const back = new URL(page.url());
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get('state')).toBe('opaque-123');
    expect(back.searchParams.get('iss')).toBe(server);
    code = back.searchParams.get('code') ?? '';
  });

  await test.step('the worker tries to tell the app it was installed, and the agency sees it', async () => {
    // The trigger queued a dispatch, the worker wrote the delivery and tried it. The
    // address has no DNS (.example), so the attempt fails and waits to be tried again.
    await expect
      .poll(
        async () => {
          const [delivery] = await query<{ event_type: string; attempts: number }>(
            `select d.event_type, d.attempts from tenancy.marketplace_webhook_deliveries d
               join tenancy.marketplace_apps a on a.agency_id = d.agency_id and a.id = d.app_id
              where a.name = $1`,
            [app],
          );
          return delivery;
        },
        { timeout: 20_000 },
      )
      .toMatchObject({ event_type: 'app.installed', attempts: 1 });
    await page.goto(`${server}/agency/settings/marketplace-apps`);
    await page
      .getByRole('row')
      .filter({ hasText: app })
      .getByRole('button', { name: `Connection for ${app}` })
      .click();
    const deliveries = page.getByRole('table', { name: 'Latest deliveries' });
    await expect(deliveries.getByRole('row').nth(1)).toContainText('The app is installed');
    await expect(deliveries.getByRole('row').nth(1)).toContainText(ours.name);
  });

  let basic = '';
  let tokens = { access_token: '', refresh_token: '' };
  await test.step('the app trades the code and calls the API as its install', async () => {
    basic = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
    const answer = await request.post(`${server}/oauth/token`, {
      headers: { authorization: basic },
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
      },
    });
    expect(answer.status(), await answer.text()).toBe(200);
    expect(answer.headers()['cache-control']).toBe('no-store');
    tokens = (await answer.json()) as typeof tokens;
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    const made = await request.post(`${server}/api/v1/tags`, {
      headers: bearer,
      data: { name: `From ${app}` },
    });
    expect(made.status(), await made.text()).toBe(201);
    expect((await request.get(`${server}/api/v1/tags`, { headers: bearer })).status()).toBe(200);
    // Nothing else, not even a read.
    expect((await request.get(`${server}/api/v1/contacts`, { headers: bearer })).status()).toBe(
      403,
    );
    const [event] = await query<{ actor_kind: string; name: string; business: string }>(
      `select e.actor_kind, k.name, b.slug as business from events.events e
         join tenancy.api_keys k on k.id = e.actor_id
         join tenancy.businesses b on b.id = e.business_id
        where e.type = 'tag.created' and k.name = $1`,
      [app],
    );
    expect(event).toEqual({ actor_kind: 'api_key', name: app, business: ours.slug });
  });

  await test.step('it refreshes, and uninstalling ends its access at once', async () => {
    const refreshed = await request.post(`${server}/oauth/token`, {
      headers: { authorization: basic },
      form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
    });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    const next = (await refreshed.json()) as typeof tokens;
    const bearer = { authorization: `Bearer ${next.access_token}` };
    expect((await request.get(`${server}/api/v1/tags`, { headers: bearer })).status()).toBe(200);

    await page.goto(inOurs('/app-marketplace?tab=installed'));
    await page.getByRole('link', { name: app }).click();
    await page.getByRole('button', { name: 'Uninstall' }).click();
    await page
      .getByRole('dialog', { name: `Uninstall ${app}?` })
      .getByRole('button', { name: 'Uninstall' })
      .click();
    await expect(page.getByRole('button', { name: 'Install App' })).toBeVisible();
    expect((await request.get(`${server}/api/v1/tags`, { headers: bearer })).status()).toBe(401);
    const again = await request.post(`${server}/oauth/token`, {
      headers: { authorization: basic },
      form: { grant_type: 'refresh_token', refresh_token: next.refresh_token },
    });
    expect(again.status()).toBe(400);
  });
});
