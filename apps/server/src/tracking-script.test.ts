// The external tracking script as it is built (tracking-script/tools/build.ts, into a
// temporary folder) and loaded: one small file, no names added to the page, no way to turn
// text into markup or code, and no address of its own baked in.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTrackingScript, TRACKING_SCRIPT_BUNDLE } from '../tracking-script/tools/build.js';
import { loadTrackingScript } from './external-tracking.js';

/** The most it may weigh gzipped: a page view, form capture and the SPA hook. */
const BUDGET = 2560;

let folder: string;
let code: string;
beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'crm-tracking-script-'));
  code = readFileSync(await buildTrackingScript(folder), 'utf8');
}, 60_000);
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the tracking script, as built', () => {
  it('is one file, within its budget gzipped', () => {
    expect(readdirSync(folder)).toEqual([TRACKING_SCRIPT_BUNDLE]);
    const gzipped = gzipSync(Buffer.from(code, 'utf8'), { level: 6 }).length;
    expect(gzipped).toBeGreaterThan(500);
    expect(gzipped).toBeLessThanOrEqual(BUDGET);
  });

  it('is one function call that adds no name to the page and loads nothing', () => {
    expect(code.startsWith('(function(){')).toBe(true);
    expect(code.trimEnd().endsWith('})();')).toBe(true);
    expect(code).not.toMatch(/\bimport\s*\(|\bimport\s+[\w{*]|\brequire\s*\(/);
    expect(code).not.toMatch(/\b(window|globalThis)\.[A-Za-z_$][\w$]*\s*=[^=]/);
  });

  it('has no way to turn text into markup or code, and keeps no cookie', () => {
    for (const sink of [
      ...['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser'],
      ...['eval(', 'new Function', 'document.cookie', 'sendBeacon', 'XMLHttpRequest'],
    ])
      expect(code, sink).not.toContain(sink);
    // The CRM it reports to is the one it was loaded from: no address is baked in.
    expect(code.match(/https?:\/\/[^\s`'"\\)]+/g) ?? []).toEqual([]);
  });

  it('is loaded from the folder it was built in, named by the digest of its bytes', () => {
    const script = loadTrackingScript(pathToFileURL(path.join(folder, TRACKING_SCRIPT_BUNDLE)));
    expect(script?.body.toString('utf8')).toBe(code);
    expect(script?.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(loadTrackingScript(pathToFileURL(path.join(folder, 'missing.js')))).toBeUndefined();
  });
});
