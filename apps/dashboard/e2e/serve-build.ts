// Serves the built dashboard to the browser tests, from a copy of it.
//
// `vite preview` on `dist` itself serves whatever is there at each request. A build of the
// dashboard empties `dist` and writes it again, so one that runs while the tests do (another
// terminal, another check of the repository) left a moment in which a page's request got a
// 404 and its test a blank page. The tests are served from a copy taken when they start,
// which nothing else writes to.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { preview } from 'vite';

// playwright.config.ts gives the port, the build and where its copy goes (served-build.ts).
const [, , portText, builtDirectory, servedDirectory] = process.argv;
const port = Number(portText);
if (!Number.isInteger(port) || builtDirectory === undefined || servedDirectory === undefined)
  throw new Error('Usage: node e2e/serve-build.ts <port> <build> <copy>');

/** Whether the copy is a whole build: its page, and every file its manifest names. */
function whole(directory: string): boolean {
  const manifestFile = join(directory, '.vite', 'manifest.json');
  if (!existsSync(join(directory, 'index.html')) || !existsSync(manifestFile)) return false;
  const manifest: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null) return false;
  return Object.values(manifest).every(
    (chunk: unknown) =>
      typeof chunk === 'object' &&
      chunk !== null &&
      'file' in chunk &&
      typeof chunk.file === 'string' &&
      existsSync(join(directory, chunk.file)),
  );
}

/** Copies the build. A build being written just now is waited for, not served half done. */
async function copyBuild(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    try {
      cpSync(from, to, { recursive: true });
      if (whole(to)) return;
    } catch (error) {
      // A file listed a moment ago is gone: the build is being written. Try again.
      if (!(error instanceof Error)) throw error;
    }
    await wait(1000);
  }
  throw new Error(
    `There is no whole build of the dashboard in ${from}. Build it first (pnpm --filter @repo/dashboard build).`,
  );
}

await copyBuild(builtDirectory, servedDirectory);
const server = await preview({
  build: { outDir: servedDirectory },
  preview: { host: '127.0.0.1', port, strictPort: true },
});
server.printUrls();
