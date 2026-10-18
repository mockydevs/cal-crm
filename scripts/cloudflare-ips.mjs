// Compares Cloudflare's published address lists with the copies TRUST_PROXY's `cloudflare`
// name is checked against (apps/server/src/cloudflare-ranges.ts).
//
//   node scripts/cloudflare-ips.mjs           exits 1 and prints the difference when they differ
//   node scripts/cloudflare-ips.mjs --write   replaces the copies with what Cloudflare publishes
//
// After --write, cloudflare-ranges.test.ts fails until apps/server/src/cloudflare-ranges.ts
// lists the same ranges; change it and its date, and release. Read-only towards Cloudflare:
// two GETs of public text files (https://www.cloudflare.com/ips/).
import { readFile, writeFile } from 'node:fs/promises';

const lists = [
  ['https://www.cloudflare.com/ips-v4', 'cloudflare-ips-v4.txt'],
  ['https://www.cloudflare.com/ips-v6', 'cloudflare-ips-v6.txt'],
];
const write = process.argv.includes('--write');
const ranges = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

let differs = false;
for (const [url, name] of lists) {
  const response = await fetch(url, { headers: { 'user-agent': 'crm-cloudflare-ips/1' } });
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  const published = await response.text();
  const copy = new URL(`../apps/server/test/${name}`, import.meta.url);
  const pinned = ranges(await readFile(copy, 'utf8'));
  const live = ranges(published);
  const added = live.filter((range) => !pinned.includes(range));
  const removed = pinned.filter((range) => !live.includes(range));
  if (added.length === 0 && removed.length === 0) {
    process.stdout.write(`${name}: the same as ${url}\n`);
    continue;
  }
  differs = true;
  process.stdout.write(
    `${name}: differs from ${url}\n  added: ${added.join(', ') || '-'}\n  removed: ${removed.join(', ') || '-'}\n`,
  );
  if (write) {
    await writeFile(copy, published);
    process.stdout.write(`  wrote ${name}\n`);
  }
}
process.exit(differs && !write ? 1 : 0);
