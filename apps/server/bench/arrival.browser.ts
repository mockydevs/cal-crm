// The arrival survives the funnel, in a real browser. Chromium opens step 1 of a published
// funnel at a Google ad's address, follows the page's own link to step 2, fills in the form
// the CRM's embed shows there and sends it. The server is the production start on a real
// Postgres (harness.ts); nothing between the page's script, the embed and the public routes
// is stood in for. (The embed is built here as the release builds it and handed to the
// browser at its address, and so is the CRM's page for a form, made by the function the
// server makes it with and sent under the same policy: a server started from source has no
// built embed beside it, and serves neither.) Then the touch is read: Google Ads, begun on
// step 1, taken on step 2.
//
// Also here, because only a browser can show them: that the page's strict policy lets the
// script run and reports no violation, that a link to the booking page is given the
// arrival when followed, that the CRM's own page for a form reads it from the address, and
// that a visitor whose browser sends the Global Privacy Control signal is left alone.
//
// The browser is the Chromium apps/dashboard's Playwright installed: it is that package's
// dependency, not this one's, and is found from there. Run on purpose, never with the
// suites, one browser at a time on this machine:
//   pnpm --filter @repo/server run browser:arrival
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  contactAttributions,
  EMPTY_PAGE_DOCUMENT,
  form as formContract,
  FORM_LIMITS,
  formSubmissionList,
  site as siteContract,
  sitePage,
  siteStep,
  type PageDocument,
} from '@repo/contracts';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { buildEmbed } from '../forms-embed/tools/build.js';
import { formPage, PAGE_POLICY } from '../src/forms-embed/page.js';
import { openBench, PUBLIC_URL, type Bench } from './harness.js';

/** What this file uses of Playwright, which is not a dependency of this package. */
interface BrowserPage {
  goto(url: string): Promise<unknown>;
  url(): string;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  waitForURL(url: string | RegExp): Promise<void>;
  waitForSelector(selector: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  /** Runs an expression in the page. A string: this package is not compiled for a browser. */
  evaluate(expression: string): Promise<unknown>;
  on(event: 'console', listener: (message: { type(): string; text(): string }) => void): void;
}
interface BrowserRoute {
  request(): { url(): string };
  fetch(options: { url: string }): Promise<unknown>;
  fulfill(options: {
    response?: unknown;
    status?: number;
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
  }): Promise<void>;
}
interface BrowserContext {
  route(url: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<BrowserPage>;
  addInitScript(script: { content: string }): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newContext(options?: { extraHTTPHeaders?: Record<string, string> }): Promise<BrowserContext>;
  close(): Promise<void>;
}
const fromDashboard = createRequire(
  new URL('../../../apps/dashboard/package.json', import.meta.url),
);
const { chromium } = fromDashboard('@playwright/test') as {
  chromium: { launch(): Promise<Browser> };
};

const AD = '?utm_source=google&utm_medium=cpc&utm_campaign=spring&campaign_id=111&gclid=Cj0abc';

let bench: Bench;
let browser: Browser;
let embedFolder: string;
let embed: string;
let funnel: { key: string; formId: string; formKey: string; siteId: string };

async function api<T>(
  parse: { parse: (value: unknown) => T },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${bench.app.address}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)} ${text}`);
  return parse.parse(JSON.parse(text));
}

const page = (children: unknown[]): PageDocument =>
  ({
    ...EMPTY_PAGE_DOCUMENT,
    sections: [
      {
        id: 'top',
        type: 'section',
        props: { width: 'medium' },
        rows: [
          {
            id: 'row',
            type: 'row',
            columns: [{ id: 'col', type: 'column', props: { span: 12 }, children }],
          },
        ],
      },
    ],
  }) as PageDocument;

beforeAll(async () => {
  bench = await openBench(inject('databaseServer'));
  embedFolder = mkdtempSync(path.join(tmpdir(), 'crm-arrival-browser-'));
  embed = readFileSync(await buildEmbed(embedFolder), 'utf8');
  browser = await chromium.launch();
  const draft = await api(formContract, 'POST', '/forms', { name: 'Enquiry' });
  const live = await api(formContract, 'POST', `/forms/${draft.id}/publish`, {
    revision: draft.revision,
  });
  const made = await api(siteContract, 'POST', '/sites', { kind: 'funnel', name: 'Spring' });
  // Both steps first, in the funnel's order; then each page, the last step's first, so
  // the link to the next step has a published step to lead to.
  const add = async (name: string, path: string): Promise<string> =>
    (await api(siteStep, 'POST', `/sites/${made.id}/steps`, { name, path })).pages[0]?.id ?? '';
  const pages = { offer: await add('Offer', 'offer'), details: await add('Details', 'details') };
  const step = async (pageId: string, children: unknown[]) => {
    const empty = await api(sitePage, 'GET', `/site-pages/${pageId}`);
    const saved = await api(sitePage, 'PUT', `/site-pages/${pageId}/draft`, {
      baseVersion: empty.currentVersion,
      document: page(children),
    });
    await api(sitePage, 'POST', `/site-pages/${pageId}/publish`, { revision: saved.revision });
  };
  const link = (id: string, label: string, action: unknown) => ({
    id,
    type: 'button',
    props: { label, subLabel: '', action },
  });
  const offer = [
    { id: 'title', type: 'headline', props: { text: [{ text: 'The spring offer' }], level: 1 } },
    link('next', 'Tell me more', { type: 'next_step' }),
    // The booking page and the hosted form of this same address, and a page elsewhere.
    link('book', 'Book a tour', {
      type: 'url',
      href: `${PUBLIC_URL}/book/agency/events/tour`,
      newTab: false,
    }),
    link('hosted', 'Open the form', {
      type: 'url',
      href: `${PUBLIC_URL}/f/${live.publicKey}`,
      newTab: false,
    }),
    link('away', 'Elsewhere', {
      type: 'url',
      href: 'https://other.example/book/x/y/z',
      newTab: false,
    }),
  ];
  await step(pages.details, [{ id: 'signup', type: 'form', props: { formId: live.id } }]);
  await step(pages.offer, offer);
  const site = await api(siteContract, 'GET', `/sites/${made.id}`);
  funnel = {
    key: site.publicKey ?? '',
    formId: live.id,
    formKey: live.publicKey,
    siteId: made.id,
  };
});
afterAll(async () => {
  await (browser as Browser | undefined)?.close();
  await (bench as Bench | undefined)?.close();
  rmSync(embedFolder, { recursive: true, force: true });
});

/**
 * A visitor's browser. The install's public address is answered by the server under test,
 * so every address the pages name is the one a visitor's browser would be on; the booking
 * page (the dashboard's, which this server does not serve) and every other site answer an
 * empty page.
 */
async function visitor(headers: Record<string, string> = {}) {
  const context = await browser.newContext({ extraHTTPHeaders: headers });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== PUBLIC_URL || url.pathname.startsWith('/book/')) {
      await route.fulfill({ status: 200, body: '<!doctype html><title>Stand-in</title>' });
      return;
    }
    if (url.pathname === '/forms/embed.js') {
      await route.fulfill({ status: 200, body: embed, contentType: 'text/javascript' });
      return;
    }
    if (url.pathname.startsWith('/f/')) {
      await route.fulfill({
        status: 200,
        body: formPage('/forms/embed.js', url.pathname.slice(3)) ?? '',
        contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': PAGE_POLICY, 'referrer-policy': 'no-referrer' },
      });
      return;
    }
    const response = await route.fetch({
      url: `${bench.app.address}${url.pathname}${url.search}`,
    });
    await route.fulfill({ response });
  });
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  return { context, tab, problems };
}

const step = (path: string): string => `${PUBLIC_URL}/s/${funnel.key}/${path}`;

/** The newest lead of the form, by its first touch. */
async function newestTouch() {
  const listed = await api(formSubmissionList, 'GET', `/forms/${funnel.formId}/submissions`);
  const contactId = listed.items[0]?.contactId;
  if (contactId === undefined || contactId === null)
    return { count: listed.items.length, touch: null };
  const touches = await api(contactAttributions, 'GET', `/contacts/${contactId}/attribution`);
  return { count: listed.items.length, touch: touches.first };
}

/** Fills in the form the embed shows on the page and sends it. */
async function sendForm(tab: BrowserPage, email: string): Promise<void> {
  // The embed draws the form in a shadow root, which Playwright's selectors pierce.
  await tab.waitForSelector('input[type="email"]');
  await tab.fill('input[type="email"]', email);
  // A person takes a moment to fill a form in; one sent at once is refused.
  await tab.waitForTimeout(FORM_LIMITS.minFillSeconds * 1000 + 500);
  await tab.click('button[type="submit"]');
  await tab.waitForSelector('.done:not([hidden])');
}

it('lands on step 1 from a Google ad, sends the form on step 2, and the lead is Google Ads', async () => {
  const { context, tab, problems } = await visitor();
  await tab.goto(`${step('offer')}${AD}`);
  // The landing page ran its one script under its policy: the arrival is in the tab.
  const kept = (await tab.evaluate('Object.entries(window.sessionStorage)')) as [string, string][];
  expect(kept.map(([key]) => key)).toEqual([`arr:${funnel.key}`]);
  expect((JSON.parse(kept[0]?.[1] ?? '[]') as unknown[]).slice(0, 2)).toEqual([
    `${step('offer')}${AD}`,
    '',
  ]);
  expect(await tab.evaluate('document.cookie')).toBe('');
  expect(await tab.evaluate('window.localStorage.length')).toBe(0);

  await tab.click('text=Tell me more');
  await tab.waitForURL(step('details'));
  // Step 2's own address says nothing of the ad.
  expect(new URL(tab.url()).search).toBe('');
  const before = (await newestTouch()).count;
  await sendForm(tab, `maya-${randomUUID().slice(0, 8)}@example.test`);
  const after = await newestTouch();
  expect(after.count).toBe(before + 1);
  expect(after.touch).toMatchObject({
    medium: 'form',
    source: 'Google Ads',
    sourceRule: 'google_ads',
    sessionSource: 'paid_search',
    utmCampaign: 'spring',
    campaignId: '111',
    landingUrl: step('offer'),
    pageUrl: step('details'),
    arrivalCarried: true,
    clickIds: ['gclid'],
  });
  // Nothing was refused by either page's policy, and nothing was logged as an error.
  expect(problems).toEqual([]);
  await context.close();
});

it('gives a link to the booking page the arrival when it is followed, and no other link', async () => {
  const { context, tab, problems } = await visitor();
  await tab.goto(`${step('offer')}${AD}`);
  await tab.click('text=Elsewhere');
  await tab.waitForURL('https://other.example/book/x/y/z');
  expect(new URL(tab.url()).search).toBe('');
  await tab.goto(step('offer'));
  await tab.click('text=Book a tour');
  await tab.waitForURL(/\/book\/agency\/events\/tour\?/);
  const carried = new URL(tab.url()).searchParams;
  expect(carried.get('arr')).toBe(`${step('offer')}${AD}`);
  expect(Number(carried.get('arr_at'))).toBeGreaterThan(Date.now() - 60_000);
  expect(problems).toEqual([]);
  await context.close();
});

it('carries it to the CRM’s own page for a form, which sends it from its address', async () => {
  const { context, tab, problems } = await visitor();
  await tab.goto(`${step('offer')}${AD}`);
  await tab.click('text=Open the form');
  await tab.waitForURL(/\/f\/[A-Za-z0-9_-]+\?arr=/);
  const before = (await newestTouch()).count;
  await sendForm(tab, `noor-${randomUUID().slice(0, 8)}@example.test`);
  const after = await newestTouch();
  expect(after.count).toBe(before + 1);
  expect(after.touch).toMatchObject({
    source: 'Google Ads',
    landingUrl: step('offer'),
    pageUrl: `${PUBLIC_URL}/f/${funnel.formKey}`,
    arrivalCarried: true,
  });
  expect(problems).toEqual([]);
  await context.close();
});

it('leaves a visitor who sends the Global Privacy Control signal alone: the lead is Direct', async () => {
  const { context, tab } = await visitor();
  // What a browser with the signal on answers to a page's script (https://www.w3.org/TR/gpc/),
  // there before any script of a page runs.
  await context.addInitScript({
    content:
      "Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { configurable: true, get: () => true });",
  });
  expect(await (await context.newPage()).evaluate('navigator.globalPrivacyControl')).toBe(true);
  await tab.goto(`${step('offer')}${AD}`);
  expect(await tab.evaluate('window.sessionStorage.length')).toBe(0);
  await tab.click('text=Tell me more');
  await tab.waitForURL(step('details'));
  expect(await tab.evaluate('window.sessionStorage.length')).toBe(0);
  await sendForm(tab, `gil-${randomUUID().slice(0, 8)}@example.test`);
  expect((await newestTouch()).touch).toMatchObject({
    source: 'Direct',
    landingUrl: step('details'),
    arrivalCarried: false,
  });
  await context.close();
});
