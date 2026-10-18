import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// The page editor's canvas library (Puck, src/site-editor/canvas.tsx) brings a popover
// (Radix) for one thing only, the drop-downs of its rich text menu, and with it
// @floating-ui, which the dashboard's own popups (Base UI) use too. Left to the bundler,
// the two share one chunk that then holds what either needs, and every page with a popup
// downloads the part only Puck uses: about 110 pages grew by 1.4 KB when the library was
// added, and two of them passed their budget. The editor has no rich text field (text is
// runs, never HTML), so Puck is given a stand-in for the popover that
// refuses to be drawn (src/site-editor/puck-popover-off.ts): the popover and its
// positioning code are in no chunk at all, and no other page changes.
function puckWithoutPopover(): Plugin {
  const standIn = fileURLToPath(new URL('./src/site-editor/puck-popover-off.ts', import.meta.url));
  return {
    name: 'crm:puck-without-popover',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== '@radix-ui/react-popover' || importer === undefined) return null;
      return /[\\/]node_modules[\\/]@puckeditor[\\/]core[\\/]/.test(importer) ? standIn : null;
    },
  };
}

// Puck carries its whole stylesheet twice: as a CSS file, which the editor imports, and as
// text inside its code, which it adds to the page itself when the file is not there (the
// text starts by fetching a font from another site, which this dashboard never does). With
// the file imported the text is never used (lib/use-inject-css.ts, hasStaticPuckCss), so
// it is left out of the build: 89 KB less code for the editor to download.
const PUCK_UI_CSS = 'var defaultUiStyles = `';
function puckStylesFromFile(): Plugin {
  return {
    name: 'crm:puck-styles-from-file',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/@puckeditor[\\/]core[\\/]dist[\\/]/.test(id)) return null;
      const start = code.indexOf(PUCK_UI_CSS);
      const end = start === -1 ? -1 : code.indexOf('`;', start + PUCK_UI_CSS.length);
      if (end === -1) return null;
      return {
        code: `${code.slice(0, start)}var defaultUiStyles = "";${code.slice(end + 2)}`,
        map: null,
      };
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    // Must come before the React plugin. Each route's code becomes its own chunk.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    // Compiles Lingui's macros natively and the .po catalogs when they're imported. The
    // parser is set explicitly because the plugin infers it from the module's file name,
    // query string included (@lingui/vite-plugin 6.9.0), and so reads TanStack's split
    // route chunks ("inbox.tsx?tsr-split=component") as plain JavaScript. Every file that
    // uses Lingui's macros here is TypeScript. Fixed upstream by lingui/js-lingui#2703, not
    // yet released.
    lingui({ macroTransform: { parser: { syntax: 'typescript', tsx: true } } }),
    tailwindcss(),
    puckWithoutPopover(),
    puckStylesFromFile(),
  ],
  build: {
    // scripts/check-budget.mjs reads it to measure what each page loads.
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // What every page needs, in one chunk that arrives with the first load
              // because the entry needs part of it: the schema library the API's contracts
              // are written in, and the class-name helpers every component of the UI kit
              // calls. Left to the bundler, the helpers sat in a chunk of their own that
              // each route loaded, and was counted, again. Nothing page-specific belongs
              // here: @repo/contracts is side-effect free (its package.json), so each page
              // carries only the contract modules it uses.
              name: 'core',
              test: /[\\/]node_modules[\\/](?:zod|tailwind-merge|clsx)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    // In development the API runs on its own port (PORT in the repository's .env); in
    // production the server serves the dashboard itself.
    proxy: {
      '/api': `http://127.0.0.1:${loadEnv(mode, '../..', '')['PORT'] ?? '3000'}`,
      // A media file's public and preview addresses: /m/<key>/<name>, /m/p/<id>. A pattern,
      // so that /main.tsx and the like stay Vite's own.
      '^/m/': `http://127.0.0.1:${loadEnv(mode, '../..', '')['PORT'] ?? '3000'}`,
      // A site's published pages and the signed preview of a draft: /s/<key>/…,
      // /s/_preview/<token>, and the form embed a page loads. Patterns, so that /src and
      // /settings stay Vite's own.
      '^/s/': `http://127.0.0.1:${loadEnv(mode, '../..', '')['PORT'] ?? '3000'}`,
      '^/forms/embed\\.js': `http://127.0.0.1:${loadEnv(mode, '../..', '')['PORT'] ?? '3000'}`,
      '/socket.io': {
        target: `http://127.0.0.1:${loadEnv(mode, '../..', '')['PORT'] ?? '3000'}`,
        ws: true,
      },
    },
  },
  preview: {
    // `vite preview` serves the built dashboard for the browser tests (playwright.config.ts)
    // and takes the development proxy above unless told otherwise. The tests answer the
    // API themselves, so nothing is passed on: before, every page's realtime socket went
    // through to whatever listened on the API's port (a developer's running server), and
    // each test that ended mid-answer logged "ws proxy error: write ECONNABORTED".
    proxy: {},
  },
}));
