// Builds the small scripts a published page may load from
// ../arrival.main.ts, ../countdown.main.ts and ../popup.main.ts: one minified file each,
// with no imports, made the way the form embed is (apps/server/forms-embed/tools/build.ts),
// with Vite, which this package already has for its tests.
//
//   node runtime/tools/build.ts            writes dist/runtime/arrival.js, countdown.js and popup.js
//   node runtime/tools/build.ts <folder>   writes them into another folder
//
// Node runs this file as it is (it has only type annotations to strip). It lives in a
// folder of its own because it is Node code beside browser code.
//
// src/scripts.test.ts calls buildPageScripts with a temporary folder and measures the
// result, so the files that are measured are made exactly as the files that are served.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

/** The scripts there are, by the name a page's renderer knows each by. */
export const PAGE_SCRIPT_NAMES = ['arrival', 'countdown', 'popup'] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(here, '..');

/**
 * Writes `<name>.js` for each script into `outDir` and returns their paths by name. Nothing
 * else in `outDir` is touched. Each is one classic script wrapped in a function: it adds
 * no global, and works on browsers from 2020 on. No file of the environment is read: a
 * script is the same wherever it is built, so its digest is too.
 */
export async function buildPageScripts(
  outDir: string,
): Promise<Record<(typeof PAGE_SCRIPT_NAMES)[number], string>> {
  for (const name of PAGE_SCRIPT_NAMES)
    await build({
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      root: runtime,
      publicDir: false,
      build: {
        outDir,
        emptyOutDir: false,
        write: true,
        minify: true,
        sourcemap: false,
        target: 'es2020',
        modulePreload: false,
        reportCompressedSize: false,
        rolldownOptions: {
          input: path.join(runtime, `${name}.main.ts`),
          output: { format: 'iife', entryFileNames: `${name}.js` },
        },
      },
    });
  return {
    arrival: path.join(outDir, 'arrival.js'),
    countdown: path.join(outDir, 'countdown.js'),
    popup: path.join(outDir, 'popup.js'),
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // By default this package's dist folder, beside the compiled loader that reads the files.
  const written = await buildPageScripts(
    path.resolve(process.argv[2] ?? path.join(runtime, '..', 'dist', 'runtime')),
  );
  process.stdout.write(`${Object.values(written).join('\n')}\n`);
}
