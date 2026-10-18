// The script websites load is under 30 KB gzipped. This
// builds it exactly as the release does (webchat-widget/tools/build.ts), into a temporary
// folder, and measures the file. It also reads the built file for what must never be in it.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildWidget, WIDGET_BUNDLE } from '../../webchat-widget/tools/build.js';
import { strings } from './strings.js';

const BUDGET = 30 * 1024;
const SOURCES = [
  fileURLToPath(new URL('.', import.meta.url)),
  fileURLToPath(new URL('../../webchat-widget/', import.meta.url)),
];

let folder: string;
let bundle: Buffer;
let code: string;
beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'crm-webchat-size-'));
  bundle = readFileSync(await buildWidget(folder));
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
  expect(readdirSync(folder)).toEqual([WIDGET_BUNDLE]);
  expect(code).not.toMatch(/\bimport\s*\(|\bimport\s+[\w{*]|\bexport\s+[\w{*]|\brequire\s*\(/);
});

it('is one function call that adds no name of its own to the page', () => {
  expect(code.startsWith('(function(){')).toBe(true);
  expect(code.trimEnd().endsWith('})();')).toBe(true);
  // The only name the widget defines on the window, and it defines it once.
  expect(code.match(/CRMWebchat/g)).toHaveLength(2);
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
  expect(files.length).toBeGreaterThanOrEqual(9);
  for (const file of files) {
    // Comments may name what is avoided; code may not use it.
    const source = readFileSync(file, 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    for (const sink of FORBIDDEN) expect(source, `${file}: ${sink}`).not.toContain(sink);
  }
});

it('asks nothing of any other host', () => {
  // The SVG namespace is a name, not an address that is fetched. Nothing else is absolute.
  const addresses = code.match(/https?:\/\/[^\s`'"\\)]+/g) ?? [];
  expect(addresses).toEqual(['http://www.w3.org/2000/svg']);
  for (const tracker of ['sendBeacon', 'document.cookie', 'navigator.userAgent', 'XMLHttpRequest'])
    expect(code).not.toContain(tracker);
});

it('carries every word it shows, so none is fetched or built from data', () => {
  for (const text of Object.values(strings)) expect(code).toContain(text);
});
