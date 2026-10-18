// Fails the build when the dashboard grows past its budgets: at most 200 KB of gzipped
// JavaScript on first load, and at most 100 KB for each route chunk on top of that. Reads
// the manifest Vite writes with `build.manifest`.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const FIRST_LOAD_BUDGET = 200 * 1024;
const ROUTE_BUDGET = 100 * 1024;

// The one named line: the page editor. It stands on a canvas library (Puck) that alone is
// larger than a route's budget, so its entries have a limit of their own; every other limit
// is unchanged. The editor is two entries that are asked for together when it opens and
// arrive side by side: its canvas (src/site-editor/canvas.tsx: Puck, its drag-and-drop, the
// page's own renderer) and its panels (src/site-editor/editor.tsx: the fields, on the
// dashboard's UI kit). Measured on 2026-10-13: canvas 150.7 KB, panels 126.8 KB. The limit
// is the next round number above the larger. As one entry the same code counted 289.4 KB
// before three cuts (Puck's stylesheet kept out of its code, its popover left out, the
// dialogs fetched when opened); what a first opening downloads in all is printed below as
// "page editor, in all".
const EDITOR_ENTRY = /^src\/site-editor\//;
const EDITOR_BUDGET = 160 * 1024;
// Entries of the editor that are asked for as soon as it opens, for the "in all" row.
const EDITOR_OPENS_WITH = [
  'src/site-editor/editor.tsx',
  'src/site-editor/canvas.tsx',
  'src/site-editor/locales/en/messages.po',
];

// The second named line: the formatted-text editor of an email
// (src/email-editor/rich-text.tsx). It stands on an editing library (tiptap 3 on
// ProseMirror, MIT) that alone is 93.8 KB of this entry, so it cannot be held to a route's
// 100 KB whatever else is taken out; every other limit is unchanged. The entry is the
// library and the editor's own pieces and toolbar and nothing else: its two menus are the
// browser's own lists and its list of merge fields is handed in, so no popup code is in it
// (with them it measured 167.4 KB). It is fetched only when an email's formatted text is
// edited, never by the builder or the Templates page themselves. Measured on 2026-10-14:
// 113.5 KB. The limit is the next round ten above that.
const RICH_TEXT_ENTRY = 'src/email-editor/rich-text.tsx';
const RICH_TEXT_BUDGET = 120 * 1024;

// Puck's own lazy chunks (its rich text editor: Editor, Render, full, loaded) are in the
// manifest because Puck would fetch them for a `richtext` field. The page editor has none:
// text is runs, never HTML, and Puck's rich text popover is left out of the build
// (vite.config.ts), so they are never requested. They are left out of the count by name
// rather than given a limit that nothing they do could be held to; a browser test
// (e2e/site-editor.spec.ts) fails if one is ever requested.
const NEVER_REQUESTED = /\/node_modules\/@puckeditor\/core\/dist\//;

const dist = new URL('../dist/', import.meta.url);

/** @type {Record<string, { file: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[] }>} */
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist), 'utf8'));

/** A chunk plus everything it imports statically. */
function closure(key, seen = new Set()) {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const imported of manifest[key]?.imports ?? []) closure(imported, seen);
  return seen;
}

function gzipBytes(keys) {
  let total = 0;
  for (const key of keys) {
    const { file } = manifest[key];
    if (file.endsWith('.js')) total += gzipSync(readFileSync(new URL(file, dist))).length;
  }
  return total;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const firstLoad = new Set();
for (const [key, chunk] of Object.entries(manifest)) {
  if (chunk.isEntry) closure(key, firstLoad);
}
const firstLoadBytes = gzipBytes(firstLoad);
const failures = [];
if (firstLoadBytes > FIRST_LOAD_BUDGET) {
  failures.push(`first load is ${kb(firstLoadBytes)}, over ${kb(FIRST_LOAD_BUDGET)}`);
}

const rows = [['first load', firstLoadBytes, FIRST_LOAD_BUDGET]];
for (const [key, chunk] of Object.entries(manifest)) {
  if (!chunk.isDynamicEntry || NEVER_REQUESTED.test(key)) continue;
  const own = [...closure(key)].filter((dependency) => !firstLoad.has(dependency));
  const bytes = gzipBytes(own);
  const budget = EDITOR_ENTRY.test(key)
    ? EDITOR_BUDGET
    : key === RICH_TEXT_ENTRY
      ? RICH_TEXT_BUDGET
      : ROUTE_BUDGET;
  rows.push([key, bytes, budget]);
  if (bytes > budget) failures.push(`${key} is ${kb(bytes)}, over ${kb(budget)}`);
}

for (const [name, bytes, budget] of rows) {
  process.stdout.write(`${kb(bytes).padStart(9)} of ${kb(budget).padStart(8)}  ${name}\n`);
}

// What a first opening of the page editor downloads on top of the first load: its entries
// together, each shared chunk counted once. Printed, not limited: the limits are per entry.
const editorOpens = new Set();
for (const key of EDITOR_OPENS_WITH) if (manifest[key] !== undefined) closure(key, editorOpens);
const editorAll = gzipBytes([...editorOpens].filter((dependency) => !firstLoad.has(dependency)));
process.stdout.write(`${kb(editorAll).padStart(9)}              page editor, in all\n`);

if (failures.length > 0) {
  process.stderr.write(`Over budget:\n${failures.map((failure) => `  ${failure}`).join('\n')}\n`);
  process.exit(1);
}
