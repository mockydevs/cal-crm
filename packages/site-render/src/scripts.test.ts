// The small scripts a published page may load (runtime/), measured as they are served:
// built exactly as the release builds them (runtime/tools/build.ts), into a temporary
// folder. Each has a budget in bytes, is one file with nothing to load after it, and has
// no way to turn text into markup or code, to call any server, or to run what a page's
// author wrote.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPageScripts, PAGE_SCRIPT_NAMES as BUILT } from '../runtime/tools/build.js';
import { SCRIPTS } from './fixtures.js';
import { loadPageScripts, PAGE_SCRIPT_NAMES, pageScriptPaths } from './server.js';

/**
 * The most each may weigh, gzipped as a web server sends it, in bytes: about half as much
 * again as it weighed when the budget was set (countdown 661, popup 1,106), and both well
 * under the 2 KB the standard names. The arrival's script is on every page of a site that
 * takes leads, so it is held to 1 KB whatever it weighs. Raising one is a decision, not a
 * fix.
 */
const BUDGET = { arrival: 1024, countdown: 1024, popup: 1536 } as const;

let folder: string;
const code = new Map<string, string>();
beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'crm-page-scripts-'));
  const written = await buildPageScripts(folder);
  for (const name of PAGE_SCRIPT_NAMES) code.set(name, readFileSync(written[name], 'utf8'));
}, 120_000);
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const each = <Value>(check: (name: (typeof PAGE_SCRIPT_NAMES)[number], text: string) => Value) =>
  PAGE_SCRIPT_NAMES.map((name) => check(name, code.get(name) ?? ''));

describe('the small page scripts, as built', () => {
  it('are the three the renderer knows, one file each and nothing else', () => {
    expect([...BUILT]).toEqual([...PAGE_SCRIPT_NAMES]);
    expect(readdirSync(folder).sort()).toEqual(['arrival.js', 'countdown.js', 'popup.js']);
  });

  it('are each within their budget, gzipped as a web server would send them', () => {
    each((name, text) => {
      // Level 6 is what servers and proxies use by default; level 9 could only be smaller.
      const gzipped = gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).length;
      expect(gzipped, name).toBeGreaterThan(200);
      expect(gzipped, name).toBeLessThanOrEqual(BUDGET[name]);
      expect(BUDGET[name], name).toBeLessThan(2048);
    });
  });

  it('are each one function call that adds no name to the page and loads nothing', () => {
    each((name, text) => {
      expect(text.startsWith('(function(){'), name).toBe(true);
      expect(text.trimEnd().endsWith('})();'), name).toBe(true);
      expect(text, name).not.toMatch(
        /\bimport\s*\(|\bimport\s+[\w{*]|\bexport\s+[\w{*]|\brequire\s*\(/,
      );
      expect(text, name).not.toMatch(/\b(window|globalThis)\.[A-Za-z_$][\w$]*\s*=[^=]/);
    });
  });

  // What turns text into markup or code, and what calls a server or names a visitor.
  const FORBIDDEN = [
    ...['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser'],
    ...['createContextualFragment', 'srcdoc', 'eval(', 'new Function', 'javascript:'],
    ...['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'postMessage'],
    ...['document.cookie', 'localStorage', 'indexedDB', 'navigator.userAgent'],
  ];

  it('have no way to turn text into markup or code, or to call anything', () => {
    each((name, text) => {
      for (const sink of FORBIDDEN) expect(text, `${name}: ${sink}`).not.toContain(sink);
      // Timers are given functions, never strings; and nothing absolute is named.
      expect(text, name).not.toMatch(/setTimeout\(\s*[`'"]/);
      expect(text.match(/https?:\/\/[^\s`'"\\)]+/g) ?? [], name).toEqual([]);
    });
    // Only the popups and the arrival keep anything, and only for the browser tab: no
    // cookie, nothing lasting.
    expect(code.get('countdown')).not.toContain('sessionStorage');
    expect(code.get('popup')).toContain('sessionStorage');
    expect(code.get('arrival')).toContain('sessionStorage');
  });

  it('are built from sources that have none either', () => {
    const runtime = fileURLToPath(new URL('../runtime/', import.meta.url));
    const files = readdirSync(runtime).filter(
      (name) => name.endsWith('.ts') && !name.includes('domtest'),
    );
    expect(files.sort()).toEqual([
      'arrival.main.ts',
      'arrival.ts',
      'countdown.main.ts',
      'countdown.ts',
      'popup.main.ts',
      'popup.ts',
    ]);
    for (const file of files) {
      // Comments may name what is avoided; code may not use it.
      const source = readFileSync(path.join(runtime, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const sink of FORBIDDEN) expect(source, `${file}: ${sink}`).not.toContain(sink);
    }
  });
});

describe('the small page scripts, as the server loads them', () => {
  it('are named by the digest of their bytes, so an address never names other bytes', () => {
    const files = loadPageScripts(pathToFileURL(`${folder}${path.sep}`));
    expect(files.map((file) => file.name)).toEqual([...PAGE_SCRIPT_NAMES]);
    for (const file of files) {
      expect(file.file).toMatch(new RegExp(`^${file.name}\\.[0-9a-f]{16}\\.js$`));
      expect(file.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(file.etag.slice(1, 17)).toBe(file.file.slice(file.name.length + 1, -3));
      expect(file.body.toString('utf8')).toBe(code.get(file.name));
    }
    // The same bytes, the same names: a build of the same sources changes no address.
    expect(loadPageScripts(pathToFileURL(`${folder}${path.sep}`)).map((file) => file.file)).toEqual(
      files.map((file) => file.file),
    );
    const paths = pageScriptPaths(files, '/s/_js');
    expect(Object.keys(paths).sort()).toEqual(['arrival', 'countdown', 'popup']);
    for (const name of PAGE_SCRIPT_NAMES) {
      expect(paths[name]).toMatch(new RegExp(`^/s/_js/${name}\\.[0-9a-f]{16}\\.js$`));
      // The shape the fixtures stand in with, which is the shape the renderer takes.
      expect(SCRIPTS[name]).toMatch(new RegExp(`^/s/_js/${name}\\.[0-9a-f]{16}\\.js$`));
    }
  });
});
