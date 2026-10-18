// Compares the disposable email domains the email checks flag
// (packages/adapters/email-checks/data/disposable-domains.txt) with the newest commit of
// the list they are copied from, https://github.com/disposable-email-domains/disposable-email-domains.
//
//   node scripts/update-disposable-domains.mjs           exits 1 and prints the difference when they differ
//   node scripts/update-disposable-domains.mjs --write   replaces the copy with that commit's list
//
// The licence is read at the same commit, and nothing is written unless it is still CC0.
// Domains on the allow list (disposable-allow.txt) are never flagged; the script names any
// the new list contains. Read-only towards GitHub: three public GETs.
import { readFile, writeFile } from 'node:fs/promises';

const REPOSITORY = 'disposable-email-domains/disposable-email-domains';
const data = new URL('../packages/adapters/email-checks/data/', import.meta.url);
const copy = new URL('disposable-domains.txt', data);
const write = process.argv.includes('--write');
const headers = { 'user-agent': 'crm-disposable-domains/1' };

async function get(url, accept) {
  const response = await fetch(url, { headers: { ...headers, accept } });
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  return response;
}

const entries = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== '' && !line.startsWith('#'));

const commit = await (
  await get(
    `https://api.github.com/repos/${REPOSITORY}/commits/main`,
    'application/vnd.github+json',
  )
).json();
const sha = String(commit.sha);
const date = String(commit.commit.committer.date);
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected commit id: ${sha}`);
const raw = (file) => `https://raw.githubusercontent.com/${REPOSITORY}/${sha}/${file}`;

const licence = await (await get(raw('LICENSE.txt'), 'text/plain')).text();
if (!licence.startsWith('CC0 1.0 Universal'))
  throw new Error(`The licence at ${sha} is no longer CC0 1.0; nothing was written.`);

const live = entries(
  await (await get(raw('disposable_email_blocklist.conf'), 'text/plain')).text(),
);
const malformed = live.filter((domain) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain));
if (malformed.length > 0)
  throw new Error(`Not domains, so nothing was written: ${malformed.slice(0, 10).join(', ')}`);

const current = await readFile(copy, 'utf8');
const pinned = entries(current);
const pinnedSet = new Set(pinned);
const liveSet = new Set(live);
const added = live.filter((domain) => !pinnedSet.has(domain));
const removed = pinned.filter((domain) => !liveSet.has(domain));
const allowed = entries(await readFile(new URL('disposable-allow.txt', data), 'utf8'));
const allowedListed = allowed.filter((domain) => liveSet.has(domain));

process.stdout.write(`${REPOSITORY} at ${sha} (${date}): ${String(live.length)} domains\n`);
if (allowedListed.length > 0)
  process.stdout.write(
    `  listed upstream but allowed here, so never flagged: ${allowedListed.join(', ')}\n`,
  );
if (added.length === 0 && removed.length === 0) {
  process.stdout.write('  the same domains as the copy\n');
  process.exit(0);
}
process.stdout.write(
  `  added (${String(added.length)}): ${added.join(', ') || '-'}\n` +
    `  removed (${String(removed.length)}): ${removed.join(', ') || '-'}\n`,
);
if (!write) process.exit(1);

// The copy's own header is kept, with the commit line brought up to date.
const header = current
  .split(/\r?\n/)
  .filter((line) => line.startsWith('#'))
  .map((line) => (line.startsWith('# Commit: ') ? `# Commit: ${sha} (${date})` : line));
await writeFile(copy, `${[...header, ...live].join('\n')}\n`);
process.stdout.write('  wrote disposable-domains.txt\n');
