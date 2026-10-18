// What a browser measures on a rendered page, by script: largest contentful paint, layout
// shift and blocking time, the lab measures behind the Core Web Vitals, under the conditions
// Lighthouse calls mobile: a phone's screen, a processor four times slower, and a slow 4G line.
//
// It is not Lighthouse and gives no score: Lighthouse is not a dependency of this
// repository. It uses the Chromium that apps/dashboard's Playwright already installed, and
// touches nothing of the dashboard.
//
// Run, after `pnpm --filter @repo/site-render run build`:
//   node packages/site-render/bench/page-metrics.mjs
// One browser at a time on this machine.
/* global window, document -- the functions given to the page run in the browser */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

import { renderPage } from '../dist/index.js';
import { pagePolicy } from '../dist/server.js';
import { longPage } from '../dist/testing.js';

// Playwright is the dashboard's dependency, not this package's: it is found from there.
const fromDashboard = createRequire(
  new URL('../../../apps/dashboard/package.json', import.meta.url),
);
const { chromium } = fromDashboard('@playwright/test');

/** A PNG of one colour, this wide and this high: a picture whose size the page was not told. */
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, 0x9a);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const context = {
  siteBase: '',
  title: 'Measured',
  index: false,
  steps: new Map(),
  sections: new Map(),
  forms: new Map(),
  formScriptUrl: '/forms/embed.js',
  calendars: new Map(),
  now: 0,
  baseRules: 'used',
};

/** The long page as it is, and the same page with no pictures. */
const withPictures = longPage();
const textOnly = structuredClone(withPictures);
for (const section of textOnly.sections)
  for (const row of section.rows)
    for (const column of row.columns)
      column.children = column.children.filter((child) => child.type !== 'image');
const pages = { 'long page, 60 pictures': withPictures, 'long page, text only': textOnly };

const picture = png(800, 450);
const server = createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '').slice(1));
  const document = pages[name];
  if (document === undefined) {
    response.writeHead(404).end();
    return;
  }
  const rendered = renderPage(document, context);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // The policy a live page is sent with, so what is measured is what a visitor runs.
    'content-security-policy': pagePolicy(rendered, { frameAncestors: 'none' }),
  });
  response.end(rendered.html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${String(server.address().port)}`;

const browser = await chromium.launch();
const results = {};
try {
  for (const name of Object.keys(pages)) {
    const page = await browser.newPage({
      viewport: { width: 412, height: 823 },
      deviceScaleFactor: 1.75,
      isMobile: true,
      hasTouch: true,
    });
    // The pictures are another website's: answered here, after a moment, at their own size.
    await page.route('https://img.example/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ contentType: 'image/png', body: picture });
    });
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await session.send('Network.enable');
    // Lighthouse's "slow 4G": 150 ms there and back, 1.6 Mbit/s down, 750 kbit/s up.
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await page.addInitScript(() => {
      window.measured = { lcp: 0, cls: 0, blocking: 0, scripts: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.measured.lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (!entry.hadRecentInput) window.measured.cls += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.measured.blocking += Math.max(0, entry.duration - 50);
      }).observe({ type: 'longtask', buffered: true });
    });
    const failures = [];
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(message.text());
    });
    await page.goto(`${origin}/${encodeURIComponent(name)}`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const first = await page.evaluate(() => ({ ...window.measured }));
    // To the foot of the page and back, as a reader goes: pictures further down arrive.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    });
    await page.waitForTimeout(1500);
    const all = await page.evaluate(() => ({
      ...window.measured,
      scripts: document.scripts.length,
      requests: performance.getEntriesByType('resource').length,
      elements: document.querySelectorAll('body *').length,
    }));
    results[name] = {
      largestContentfulPaintMs: Math.round(first.lcp),
      layoutShiftOnLoad: Number(first.cls.toFixed(4)),
      layoutShiftWhileReading: Number(all.cls.toFixed(4)),
      totalBlockingTimeMs: Math.round(all.blocking),
      scripts: all.scripts,
      requests: all.requests,
      elements: all.elements,
      policyRefusals: failures.length,
    };
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
