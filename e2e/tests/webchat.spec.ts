// The web chat widget on a test page: a real browser, a real website and the CRM's real
// public transport on another origin, so the same-origin policy, CORS and the page's
// Content-Security-Policy are enforced by the browser and not imitated.
//
// It lives in this suite, not the dashboard's, because it runs server code and the
// dashboard may not import the server (.dependency-cruiser.cjs). It uses none of this
// suite's servers or its database: its two sites are its own
// (apps/server/test/webchat-sites.ts), with sessions kept in memory behind the production
// transport, so a test can make the limiter refuse, or the team reply, at a chosen moment.
// The whole product (settings, the widget, Postgres, the Inbox) is in webchat-inbox.spec.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { startWebchatSites, type WebchatSites } from '../../apps/server/test/webchat-sites.js';

const PAGE = readFileSync(
  fileURLToPath(new URL('./webchat-test-page.html', import.meta.url)),
  'utf8',
);
const ATTACK = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script><b>bold</b>';

let sites: WebchatSites;
test.beforeEach(async () => {
  sites = await startWebchatSites({
    page: PAGE,
    marketingConsentWording: 'Email me news and offers.',
  });
});
test.afterEach(async () => {
  await sites.close();
});

/** What the page itself did wrong: thrown errors, and console errors other than the browser's own. */
function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  return problems;
}
const apiCalls = (): typeof sites.requests =>
  sites.requests.filter((request) => request.path.startsWith('/api/'));
const launcher = (page: Page) => page.getByRole('button', { name: 'Chat with us' });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Chat with us' });

async function startChat(page: Page, text = 'Do you deliver?'): Promise<void> {
  await launcher(page).click();
  await panel(page).getByRole('textbox', { name: 'Name' }).fill('Maya Thompson');
  await panel(page).getByRole('textbox', { name: 'Email' }).fill('maya@example.test');
  await panel(page).getByRole('textbox', { name: 'Message' }).fill(text);
  await panel(page).getByRole('button', { name: 'Start chat' }).click();
  await expect(panel(page).getByRole('log')).toContainText(text);
}

test('shows a launcher on an allowed website, and asks the CRM for nothing until it is used', async ({
  page,
}) => {
  const problems = problemsOf(page);
  await page.goto(`${sites.shop}/`);
  await expect(launcher(page)).toBeVisible();
  // Styled though the page allows no inline style: the launcher is round and filled.
  await expect(launcher(page)).toHaveCSS('border-radius', '50%');
  await expect(launcher(page)).toHaveCSS('background-color', 'rgb(15, 122, 104)');
  // One element and one name on the page, and the rest of the page untouched.
  expect(await page.locator('[data-crm-webchat]').count()).toBe(1);
  expect(
    await page.evaluate(() => Object.keys(Reflect.get(window, 'CRMWebchat') as object).sort()),
  ).toEqual(['close', 'open']);
  await expect(page.getByRole('heading', { name: 'Harbor Lights Bakery' })).toBeVisible();
  expect(sites.requests.map((request) => request.path)).toEqual(['/webchat/widget.js']);
  expect(problems).toEqual([]);
});

test('a visitor chats: the message reaches the CRM, and the reply comes back as text', async ({
  page,
}) => {
  const problems = problemsOf(page);
  await page.goto(`${sites.shop}/`);
  await startChat(page);
  expect(sites.sessions()).toEqual([
    {
      origin: sites.shop,
      name: 'Maya Thompson',
      email: 'maya@example.test',
      marketingConsent: false,
      ended: false,
    },
  ]);
  expect(sites.messages().map((message) => message.text)).toEqual(['Do you deliver?']);
  // Every API call came from the website's own origin, as the browser states it.
  for (const call of apiCalls()) expect(call.origin).toBe(sites.shop);

  sites.reply(ATTACK);
  const log = panel(page).getByRole('log');
  await expect(log).toContainText(ATTACK, { timeout: 15_000 });
  // The reply is characters, not elements, and none of it ran.
  expect(await log.locator('img, script, b, a, iframe').count()).toBe(0);
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false);

  await panel(page).getByRole('textbox', { name: 'Message' }).fill('Thank you');
  await panel(page).getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(log).toContainText('Thank you');
  expect(sites.messages().map((message) => message.from)).toEqual(['visitor', 'team', 'visitor']);
  expect(problems).toEqual([]);
});

test('the chat continues after a page load, and only in this website and widget', async ({
  page,
  context,
}) => {
  await page.goto(`${sites.shop}/`);
  await startChat(page, 'First visit');
  const stored = await page.evaluate(() =>
    Object.keys(window.localStorage).map((name) => [name, window.localStorage.getItem(name) ?? '']),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]?.[0]).toBe(`crm-webchat:${sites.widgetKey}`);
  // No cookie is set by the CRM, for any site.
  expect(await context.cookies()).toEqual([]);

  await page.reload();
  // Read at once on the next page load, before the visitor opens anything.
  await expect
    .poll(() => apiCalls().some((call) => call.path.includes('/messages?after=0')))
    .toBe(true);
  await launcher(page).click();
  await expect(panel(page).getByRole('log')).toContainText('First visit');
  expect(sites.sessions()).toHaveLength(1);

  // The same page on another origin has its own storage, so no session, and is refused.
  await page.goto(`${sites.elsewhere}/`);
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
});

test('a website that is not allowed is refused, and its visitor sees a short notice', async ({
  page,
}) => {
  const thrown: string[] = [];
  page.on('pageerror', (error) => thrown.push(error.message));
  await page.goto(`${sites.elsewhere}/`);
  await launcher(page).click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Chat is not available right now. Please try again later.',
  );
  const calls = apiCalls();
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.origin).toBe(sites.elsewhere);
    expect(call.status).toBe(403);
  }
  expect(sites.sessions()).toEqual([]);
  // The widget throws nothing into the page. (The browser itself logs the blocked request.)
  expect(thrown).toEqual([]);
});

test('a refused website gets no CORS header, and a token is useless from it', async ({
  page,
  request,
}) => {
  await page.goto(`${sites.shop}/`);
  await startChat(page);
  const token = await page.evaluate((name) => {
    const stored: unknown = JSON.parse(window.localStorage.getItem(name) ?? '{}');
    return typeof stored === 'object' && stored !== null && 'token' in stored
      ? String(stored.token)
      : '';
  }, `crm-webchat:${sites.widgetKey}`);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const base = `${sites.crm}/api/v1/public/webchat/${sites.widgetKey}`;
  // Outside a browser the Origin header is whatever the client says: this is the honest
  // limit of the check, and it still gets nothing without an allowed Origin.
  for (const origin of [sites.elsewhere, 'https://evil.test', `${sites.shop}.evil.test`, 'null']) {
    const answer = await request.get(`${base}/messages?after=0`, {
      headers: { origin, authorization: `Bearer ${token}` },
    });
    expect(answer.status()).toBe(403);
    expect(answer.headers()['access-control-allow-origin']).toBeUndefined();
  }
  const allowed = await request.get(`${base}/messages?after=0`, {
    headers: { origin: sites.shop, authorization: `Bearer ${token}` },
  });
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()['access-control-allow-origin']).toBe(sites.shop);

  // From a page of another origin, the browser itself keeps the answer from the script.
  await page.goto(`${sites.elsewhere}/`);
  const read = await page.evaluate(
    async ([url, bearer]) => {
      try {
        const answer = await fetch(url ?? '', {
          headers: { authorization: `Bearer ${bearer ?? ''}` },
        });
        return `answered ${String(answer.status)}`;
      } catch {
        return 'blocked';
      }
    },
    [`${base}/messages?after=0`, token],
  );
  expect(read).toBe('blocked');
});

test('a visitor who is asked to slow down is told so, and can go on afterwards', async ({
  page,
}) => {
  const thrown: string[] = [];
  page.on('pageerror', (error) => thrown.push(error.message));
  await page.goto(`${sites.shop}/`);
  await launcher(page).click();
  await panel(page).getByRole('textbox', { name: 'Email' }).fill('maya@example.test');
  await panel(page).getByRole('textbox', { name: 'Message' }).fill('Do you deliver?');
  // The limiter refuses before it knows the website, so its answer names no origin. The
  // browser must still let the widget read the status and the wait, or it would look like
  // a lost connection and be tried again at once.
  sites.limit(2);
  const refused = page.waitForResponse(
    (response) => response.url().endsWith('/sessions') && response.request().method() === 'POST',
  );
  await panel(page).getByRole('button', { name: 'Start chat' }).click();
  const answer = await refused;
  expect(answer.status()).toBe(429);
  expect(answer.headers()['retry-after']).toBe('2');
  expect(answer.headers()['access-control-allow-origin']).toBe('*');
  expect(answer.headers()['access-control-expose-headers']).toBe('Retry-After');
  await expect(panel(page).getByRole('alert')).toHaveText(
    'You are sending messages quickly. Wait a moment and try again.',
  );
  await expect(panel(page)).not.toContainText('Could not reach the chat');
  expect(sites.sessions()).toEqual([]);
  // What the visitor typed is still there, and goes once the limiter lets it through.
  await expect(panel(page).getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Do you deliver?',
  );
  sites.limit(null);
  await panel(page).getByRole('button', { name: 'Start chat' }).click();
  await expect(panel(page).getByRole('log')).toContainText('Do you deliver?');
  expect(sites.sessions()).toHaveLength(1);
  expect(thrown).toEqual([]);
});

test('marketing consent is given only by ticking the box', async ({ page }) => {
  await page.goto(`${sites.shop}/`);
  await launcher(page).click();
  const box = panel(page).getByRole('checkbox', { name: 'Email me news and offers.' });
  await expect(box).not.toBeChecked();
  await box.check();
  await panel(page).getByRole('textbox', { name: 'Email' }).fill('maya@example.test');
  await panel(page).getByRole('textbox', { name: 'Message' }).fill('Hello');
  await panel(page).getByRole('button', { name: 'Start chat' }).click();
  await expect(panel(page).getByRole('log')).toContainText('Hello');
  expect(sites.sessions()[0]?.marketingConsent).toBe(true);
});

test('the form says what is missing before anything is sent', async ({ page }) => {
  await page.goto(`${sites.shop}/`);
  await launcher(page).click();
  await panel(page).getByRole('textbox', { name: 'Message' }).fill('Hello');
  await panel(page).getByRole('button', { name: 'Start chat' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('Enter your email address.');
  await panel(page).getByRole('textbox', { name: 'Email' }).fill('not-an-address');
  await panel(page).getByRole('button', { name: 'Start chat' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('Enter a valid email address.');
  expect(sites.sessions()).toEqual([]);
});

test('ending a chat forgets it in this browser and ends it in the CRM', async ({ page }) => {
  await page.goto(`${sites.shop}/`);
  await startChat(page, 'Something private');
  await panel(page).getByRole('button', { name: 'End chat' }).click();
  await expect(panel(page).getByRole('textbox', { name: 'Name' })).toBeVisible();
  await expect(panel(page)).not.toContainText('Something private');
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  await expect.poll(() => sites.sessions()[0]?.ended).toBe(true);
});

test('works with a keyboard alone', async ({ page }) => {
  await page.goto(`${sites.shop}/`);
  await launcher(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page).getByRole('textbox', { name: 'Name' })).toBeFocused();
  await page.keyboard.type('Maya');
  await page.keyboard.press('Tab');
  await page.keyboard.type('maya@example.test');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Sent without a mouse');
  // To the box, to the button, and press it.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('log')).toContainText('Sent without a mouse');
  await expect(panel(page).getByRole('textbox', { name: 'Message' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(launcher(page)).toBeFocused();
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');
});

test('has no accessibility violations, closed, on the form and in a chat', async ({ page }) => {
  await page.goto(`${sites.shop}/`);
  await expect(launcher(page)).toBeVisible();
  const audit = async () => (await new AxeBuilder({ page }).analyze()).violations;
  expect(await audit()).toEqual([]);
  await launcher(page).click();
  await expect(panel(page).getByRole('textbox', { name: 'Name' })).toBeVisible();
  expect(await audit()).toEqual([]);
  await page.keyboard.press('Escape');
  await startChat(page);
  sites.reply('We deliver on weekdays.');
  await expect(panel(page).getByRole('log')).toContainText('We deliver on weekdays.', {
    timeout: 15_000,
  });
  expect(await audit()).toEqual([]);
});

test('fits a 320 pixel screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${sites.shop}/`);
  await launcher(page).click();
  await expect(panel(page).getByRole('textbox', { name: 'Name' })).toBeVisible();
  for (const part of [panel(page), launcher(page)]) {
    const box = await part.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(320);
    expect((box?.y ?? 0) + (box?.height ?? 999)).toBeLessThanOrEqual(568);
  }
  // The page does not scroll sideways because of the widget.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('honours reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${sites.shop}/`);
  await launcher(page).click();
  await expect(panel(page)).toHaveCSS('transition-duration', '0s');
});

test("is not styled by the website's CSS, and does not style the website", async ({ page }) => {
  await page.goto(`${sites.shop}/`);
  // A page with rules as hostile as a page can write. Added through the style sheet
  // interface, which the page's policy allows, as the widget's own sheet is.
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      'button{display:none!important;background:red!important} *{font-size:40px!important;color:red!important} div{position:static!important}',
    );
    document.adoptedStyleSheets = [sheet];
  });
  await expect(launcher(page)).toBeVisible();
  await expect(launcher(page)).toHaveCSS('background-color', 'rgb(15, 122, 104)');
  await launcher(page).click();
  await expect(panel(page).getByRole('textbox', { name: 'Name' })).toHaveCSS('font-size', '16px');
  // The page's rules do reach the one element the widget adds to the page, and what they
  // set there would be inherited. Text that sets no size of its own is still the widget's.
  await expect(panel(page).getByText('Hello. How can we help?')).toHaveCSS('font-size', '15px');
  await expect(panel(page).getByText('Hello. How can we help?')).toHaveCSS(
    'color',
    'rgb(29, 42, 36)',
  );
  // And it stays in its corner, though the page made every div static.
  const corner = await launcher(page).boundingBox();
  const viewport = page.viewportSize();
  expect(corner).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect((corner?.x ?? 0) + (corner?.width ?? 0)).toBeGreaterThan((viewport?.width ?? 0) - 40);
  expect((corner?.y ?? 0) + (corner?.height ?? 0)).toBeGreaterThan((viewport?.height ?? 0) - 40);
  // And the page's own button keeps the page's rule, not the widget's.
  await expect(page.locator('main button')).toBeHidden();
});

test('says so quietly when the CRM cannot be reached', async ({ page }) => {
  const thrown: string[] = [];
  page.on('pageerror', (error) => thrown.push(error.message));
  await page.goto(`${sites.shop}/`);
  await expect(launcher(page)).toBeVisible();
  await page.route(`${sites.crm}/api/**`, (route) => route.abort('connectionrefused'));
  await launcher(page).click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Chat is not available right now. Please try again later.',
  );
  expect(thrown).toEqual([]);
  // The rest of the page still works.
  await page.getByRole('link', { name: 'See the menu' }).click();
  await expect(page).toHaveURL(/#menu$/);
});
