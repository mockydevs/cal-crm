// Applied migrations never change. Every install records the SHA-256 of each migration it
// applied, and the migration runner refuses to start when a file no longer matches, so an
// edited migration stops the next deploy at `migrate`. This check stops it in CI instead.
//
// migrations.lock holds one line per migration: its SHA-256 and its file name, in order.
//   node scripts/migration-lock.mjs        checks every migration against the lock
//   node scripts/migration-lock.mjs --add  adds new migrations to the lock; it never
//                                          changes a line that is already there
//
// Hashes are of the file with LF line endings, as the repository stores it and as an
// install reads it, whatever a Windows checkout has on disk.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = join(root, 'migrations');
const lockFile = join(root, 'migrations.lock');

const hashOf = (name) =>
  createHash('sha256')
    .update(readFileSync(join(directory, name), 'utf8').replaceAll('\r\n', '\n'))
    .digest('hex');

const files = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const locked = new Map(
  readFileSync(lockFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [hash, name] = line.split(/\s+/);
      return [name, hash];
    }),
);

if (process.argv.includes('--add')) {
  const added = files.filter((name) => !locked.has(name));
  for (const name of added) locked.set(name, hashOf(name));
  const lines = [...locked].map(([name, hash]) => `${hash}  ${name}`);
  writeFileSync(lockFile, `${lines.join('\n')}\n`);
  process.stdout.write(added.length === 0 ? 'Nothing to add.\n' : `Added ${added.join(', ')}.\n`);
  process.exit(0);
}

const problems = [];
for (const [name, hash] of locked) {
  if (!files.includes(name)) problems.push(`${name} is gone. Applied migrations stay.`);
  else if (hashOf(name) !== hash)
    problems.push(
      `${name} changed after it was locked. Applied migrations never change: put the change in a new migration.`,
    );
}
for (const name of files.filter((file) => !locked.has(file)))
  problems.push(`${name} is new: add it with \`pnpm --filter @repo/db migrations:lock\`.`);

if (problems.length > 0) {
  process.stderr.write(
    `migrations.lock:\n${problems.map((problem) => `  ${problem}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(`migrations.lock: ${locked.size} migrations unchanged.\n`);
