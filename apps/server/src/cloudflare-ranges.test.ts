// The `cloudflare` name's list against verbatim copies of Cloudflare's published lists
// (https://www.cloudflare.com/ips-v4, https://www.cloudflare.com/ips-v6). When Cloudflare
// changes them, `node scripts/cloudflare-ips.mjs --write` refreshes the copies and this
// test says what to change.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { proxyEntryProblem } from './client-address.js';
import { CLOUDFLARE_RANGES, CLOUDFLARE_RANGES_CHECKED } from './cloudflare-ranges.js';

async function published(name: string): Promise<string[]> {
  const text = await readFile(new URL(`../test/${name}`, import.meta.url), 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

describe("Cloudflare's ranges", () => {
  it('are exactly the pinned copies of the published lists, IPv4 then IPv6', async () => {
    const pinned = [
      ...(await published('cloudflare-ips-v4.txt')),
      ...(await published('cloudflare-ips-v6.txt')),
    ];
    expect(pinned.length).toBeGreaterThan(0);
    expect(CLOUDFLARE_RANGES).toEqual(pinned);
  });

  it('are each a usable proxy range, and the date they were checked is a date', () => {
    for (const range of CLOUDFLARE_RANGES) expect(proxyEntryProblem(range)).toBeUndefined();
    expect(CLOUDFLARE_RANGES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
