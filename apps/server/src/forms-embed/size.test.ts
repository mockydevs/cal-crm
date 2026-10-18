// The embed is under 30 KB gzipped. This builds it
// exactly as the release does (forms-embed/tools/build.ts), into a temporary folder, and
// measures the file. It also reads the built file for what must never be in it.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildEmbed, EMBED_BUNDLE } from '../../forms-embed/tools/build.js';
import { strings } from './strings.js';

const BUDGET = 30 * 1024;
const SOURCES = [
  fileURLToPath(new URL('.', import.meta.url)),
  fileURLToPath(new URL('../../forms-embed/', import.meta.url)),
];

let folder: string;
let bundle: Buffer;
let code: string;
beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'crm-form-embed-size-'));
  bundle = readFileSync(await buildEmbed(folder));
  code = bundle.toString('utf8');
}, 60_000);
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

it('is under 30 KB gzipped, as a web server would send it', () => {
  // Level 6 is what servers and proxies use by default; level 9 could only be smaller.
  const gzipped = gzipSync(bundle, { level: 6 }).length;
  expect(gzipped).toBeGreaterThan(1024);
  expect(gzipped).toBeLessThan(BUDGET);
});

it('is one file with nothing to load after it', () => {
  expect(readdirSync(folder)).toEqual([EMBED_BUNDLE]);
  expect(code).not.toMatch(/\bimport\s*\(|\bimport\s+[\w{*]|\bexport\s+[\w{*]|\brequire\s*\(/);
});

it('is one function call that adds no name to the page', () => {
  expect(code.startsWith('(function(){')).toBe(true);
  expect(code.trimEnd().endsWith('})();')).toBe(true);
  expect(code).not.toMatch(/\bwindow\.[A-Za-z_$][\w$]*\s*=[^=]/);
  expect(code).not.toMatch(/\bglobalThis\.[A-Za-z_$][\w$]*\s*=[^=]/);
  expect(code).not.toContain('defineProperty(window');
});

// What turns text into markup or code. None may be in the bundle, or in any source file
// it is built from.
const FORBIDDEN = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'DOMParser',
  'createContextualFragment',
  'srcdoc',
  'eval(',
  'new Function',
  'setAttribute("on',
  "setAttribute('on",
  'javascript:',
];

it('has no way to turn text into markup or code', () => {
  for (const sink of FORBIDDEN) expect(code).not.toContain(sink);
  // Timers are given functions, never strings.
  expect(code).not.toMatch(/setTimeout\(\s*[`'"]/);
});

it('is built from sources that have none either', () => {
  const files = SOURCES.flatMap((source) =>
    readdirSync(source)
      .filter(
        (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.includes('domtest'),
      )
      .map((name) => path.join(source, name)),
  );
  // api, strings, styles and transport here; entry, main and view beside the build.
  expect(files.length).toBeGreaterThanOrEqual(7);
  for (const file of files) {
    // Comments may name what is avoided; code may not use it.
    const source = readFileSync(file, 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    for (const sink of FORBIDDEN) expect(source, `${file}: ${sink}`).not.toContain(sink);
  }
});

it('asks nothing of any other host, and keeps nothing in the browser', () => {
  // Nothing absolute: the CRM's address is read from the script's own URL when it runs.
  expect(code.match(/https?:\/\/[^\s`'"\\)]+/g) ?? []).toEqual([]);
  for (const tracker of [
    'sendBeacon',
    'document.cookie',
    'navigator.userAgent',
    'XMLHttpRequest',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'postMessage',
  ])
    expect(code).not.toContain(tracker);
});

it('carries every word it shows, so none is fetched or built from data', () => {
  for (const text of Object.values(strings)) expect(code).toContain(text);
});
