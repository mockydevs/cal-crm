// Builds the script websites load from ../main.ts into one minified file with no imports.
// It uses Vite, which this app already has for its tests: no new dependency.
//
//   node webchat-widget/tools/build.ts            writes dist/webchat-widget/widget.bundle.js
//   node webchat-widget/tools/build.ts <folder>   writes it into another folder
//
// Node runs this file as it is (it has only type annotations to strip). It lives in a
// folder of its own because it is Node code beside browser code: this folder's tsconfig
// has Node's types, and the widget's has the DOM's and nothing of Node.
//
// size.test.ts calls buildWidget with a temporary folder and measures the result, so the
// file that is measured is made exactly as the file that is served.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

/** The bundle's file name inside the folder it is written to. */
export const WIDGET_BUNDLE = 'widget.bundle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const widget = path.join(here, '..');

/**
 * Writes the bundle into `outDir` and returns its path. Nothing else in `outDir` is touched.
 * The output is one classic script wrapped in a function: it adds no global of its own
 * (the widget defines `CRMWebchat` itself) and works on browsers from 2020 on. No file of
 * the environment is read: the bundle is the same wherever it is built.
 */
export async function buildWidget(outDir: string): Promise<string> {
  await build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    root: widget,
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
        input: path.join(widget, 'main.ts'),
        output: { format: 'iife', entryFileNames: WIDGET_BUNDLE },
      },
    },
  });
  return path.join(outDir, WIDGET_BUNDLE);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // By default the server's dist folder, beside the compiled transport that serves the file.
  const written = await buildWidget(
    path.resolve(process.argv[2] ?? path.join(widget, '..', 'dist', 'webchat-widget')),
  );
  process.stdout.write(`${written}\n`);
}
