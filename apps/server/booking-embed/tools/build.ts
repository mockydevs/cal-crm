// Builds the booking embed's script from ../main.ts into one minified file with no imports,
// exactly as the form embed is built (forms-embed/tools/build.ts), with Vite, which this
// app already has for its tests.
//
//   node booking-embed/tools/build.ts            writes dist/booking-embed/booking-embed.bundle.js
//   node booking-embed/tools/build.ts <folder>   writes it into another folder
//
// Node runs this file as it is (it has only type annotations to strip). It lives in a
// folder of its own because it is Node code beside browser code.
//
// src/booking-embed.test.ts calls buildBookingEmbed with a temporary folder and measures
// the result, so the file that is measured is made exactly as the file that is served.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

/** The bundle's file name inside the folder it is written to. */
export const BOOKING_EMBED_BUNDLE = 'booking-embed.bundle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const embed = path.join(here, '..');

/**
 * Writes the bundle into `outDir` and returns its path. Nothing else in `outDir` is touched.
 * One classic script wrapped in a function: it adds no global, and works on browsers from
 * 2020 on.
 */
export async function buildBookingEmbed(outDir: string): Promise<string> {
  await build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    root: embed,
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
        input: path.join(embed, 'main.ts'),
        output: { format: 'iife', entryFileNames: BOOKING_EMBED_BUNDLE },
      },
    },
  });
  return path.join(outDir, BOOKING_EMBED_BUNDLE);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // By default the server's dist folder, beside the compiled module that serves the file.
  const written = await buildBookingEmbed(
    path.resolve(process.argv[2] ?? path.join(embed, '..', 'dist', 'booking-embed')),
  );
  process.stdout.write(`${written}\n`);
}
