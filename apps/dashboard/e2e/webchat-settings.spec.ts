// Settings > Web chat, against a stand-in for the API that keeps the widgets in memory and
// checks every write against the contract.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { webchatWidgetInput, type WebchatWidget, type WebchatWidgetInput } from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';

const widgetId = 'wcw_01k8e2wzr0e008000000000001';
const firstKey = 'A'.repeat(32);
const secondKey = 'B'.repeat(32);
const at = '2026-10-09T00:00:00.000Z';
const snippetOf = (key: string): string =>
  `<script async src="https://crm.example/webchat/widget.js" data-widget-key="${key}"></script>`;

interface World {
  widgets: WebchatWidget[];
  writes: WebchatWidgetInput[];
  rotations: number;
}

/** Stands in for the web chat API. Every write is parsed with the contract's own schema. */
async function webchatApi(page: Page, state: World): Promise<void> {
  await page.route(/\/api\/v1\/webchat\/widgets(?:\/[^/?]+)?(?:\/rotate-key)?$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await route.fulfill({ json: { data: state.widgets } });
      return;
    }
    if (path.endsWith('/rotate-key')) {
      state.rotations += 1;
      state.widgets = state.widgets.map((widget) => ({
        ...widget,
        publicKey: secondKey,
        embedSnippet: snippetOf(secondKey),
      }));
      await route.fulfill({ json: state.widgets[0] });
      return;
    }
    const input = webchatWidgetInput.parse(request.postDataJSON());
    state.writes.push(input);
    const current = state.widgets[0];
    const saved: WebchatWidget = {
      id: widgetId,
      publicKey: current?.publicKey ?? firstKey,
      embedSnippet: current?.embedSnippet ?? snippetOf(firstKey),
      createdAt: at,
      updatedAt: at,
      ...input,
    };
    state.widgets = [saved];
    await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: saved });
  });
}

for (const width of [360, 1280]) {
  test(`adds a chat widget, shows its code, turns it off and replaces its key at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const state: World = { widgets: [], writes: [], rotations: 0 };
    await webchatApi(page, state);
    // The chat widget is a page of Sites: reached from its tabs, at the address it always had.
    await page.goto(inHarbor('/settings/business'));
    // On a phone the sidebar is behind the menu button.
    if (width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('link', { name: 'Go Back', exact: true }).click();
    if (width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('link', { name: 'Sites', exact: true }).click();
    await page.getByRole('link', { name: 'Chat Widget', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/webchat$/);
    await expect(page.getByRole('heading', { name: 'Web chat', exact: true })).toBeVisible();
    await expect(
      page.getByText('No chat widget yet. Add one to get the code for your website.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add a chat widget', exact: true }).click();
    const form = page.getByRole('region', { name: 'New chat widget', exact: true });
    await form.getByLabel('Name', { exact: true }).fill('Harbor website');
    // A website that isn't an address is refused before anything is sent.
    await form
      .getByLabel('Websites that may show this chat', { exact: true })
      .fill('harbor lights dot example');
    await form.getByRole('button', { name: 'Add the widget', exact: true }).click();
    await expect(
      form.getByText('harbor lights dot example: Enter a website address', { exact: false }),
    ).toBeVisible();
    expect(state.writes).toHaveLength(0);
    await form
      .getByLabel('Websites that may show this chat', { exact: true })
      .fill('https://www.harborlights.example\nhttps://harborlights.example');
    await form.getByRole('button', { name: 'Add the widget', exact: true }).click();

    const card = page.getByRole('region', { name: 'Harbor website', exact: true });
    await expect(card).toBeVisible();
    expect(state.writes).toEqual([
      {
        name: 'Harbor website',
        allowedOrigins: ['https://www.harborlights.example', 'https://harborlights.example'],
        enabled: true,
        settings: {
          title: 'Chat with us',
          greeting: 'Hello. How can we help?',
          emailRequired: true,
          marketingConsentWording: null,
        },
      },
    ]);
    await expect(card.getByText('On', { exact: true })).toBeVisible();
    await expect(card.getByText('https://www.harborlights.example', { exact: true })).toBeVisible();
    // The code is shown as text: it is never part of this page.
    await expect(card.getByText(snippetOf(firstKey), { exact: true })).toBeVisible();
    expect(await page.locator('script[data-widget-key]').count()).toBe(0);

    await card.getByRole('button', { name: 'Turn chat off', exact: true }).click();
    await expect(card.getByRole('status').filter({ hasText: 'Chat is off.' })).toBeVisible();
    await expect(card.getByText('Off', { exact: true })).toBeVisible();
    expect(state.writes.at(-1)).toMatchObject({ name: 'Harbor website', enabled: false });

    // Replacing the key asks first, and says what stops working.
    await card.getByRole('button', { name: 'Replace key…', exact: true }).click();
    await expect(card.getByText(/stops\s+working at once/)).toBeVisible();
    expect(state.rotations).toBe(0);
    await card.getByRole('button', { name: 'Replace the key now', exact: true }).click();
    await expect(
      card.getByRole('status').filter({ hasText: 'The key was replaced.' }),
    ).toBeVisible();
    expect(state.rotations).toBe(1);
    await expect(card.getByText(snippetOf(secondKey), { exact: true })).toBeVisible();
    await expect(card.getByText(snippetOf(firstKey), { exact: true })).toHaveCount(0);

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
    await page.screenshot({ path: testInfo.outputPath('webchat-settings.png'), fullPage: true });
  });
}

test('edits a widget, and passes axe with the form open', async ({ page }) => {
  await signedIn(page);
  const state: World = {
    widgets: [
      {
        id: widgetId,
        name: 'Harbor website',
        publicKey: firstKey,
        enabled: true,
        allowedOrigins: ['https://www.harborlights.example'],
        settings: {
          title: 'Chat with us',
          greeting: 'Hello. How can we help?',
          emailRequired: true,
          marketingConsentWording: null,
        },
        embedSnippet: snippetOf(firstKey),
        createdAt: at,
        updatedAt: at,
      },
    ],
    writes: [],
    rotations: 0,
  };
  await webchatApi(page, state);
  await page.goto(inHarbor('/settings/webchat'));
  await page
    .getByRole('region', { name: 'Harbor website', exact: true })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const form = page.getByRole('region', { name: 'Edit Harbor website', exact: true });
  await form.getByLabel('Heading of the chat', { exact: true }).fill('Ask Harbor Lights');
  await form.getByLabel('Ask every visitor for an email address before they write').uncheck();
  await form.getByLabel('Offer visitors a box to tick for marketing email').check();
  await form.getByLabel('Words beside the box', { exact: true }).fill('Email me news and offers.');
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Harbor website', exact: true })).toBeVisible();
  expect(state.writes).toEqual([
    {
      name: 'Harbor website',
      allowedOrigins: ['https://www.harborlights.example'],
      enabled: true,
      settings: {
        title: 'Ask Harbor Lights',
        greeting: 'Hello. How can we help?',
        emailRequired: false,
        marketingConsentWording: 'Email me news and offers.',
      },
    },
  ]);
});

test('shows the permission refusal without any widget controls', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/v1/webchat/widgets', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      json: {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Web chat management is not granted.',
      },
    }),
  );
  await page.goto(inHarbor('/settings/webchat'));
  await expect(page.getByText('You need permission to manage web chat.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Add a chat widget' })).toHaveCount(0);
});
