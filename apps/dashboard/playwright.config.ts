import { defineConfig, devices } from '@playwright/test';
import { builtDirectory, servedDirectory } from './e2e/served-build';

const port = 4173;
const inCi = process.env['CI'] !== undefined;

// Runs against the production build, served by `vite preview` from a copy of it taken when
// the run starts (e2e/serve-build.ts), so a build made meanwhile changes nothing under it.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // Windows once ran one browser at a time: two exhausted its socket buffers while the suite
  // was served by the dev server. Served from a copy of the build, four run the whole suite
  // clean (837 tests in 8 minutes on 2026-10-12, against about 30). CI keeps its two.
  workers: inCi ? 2 : 4,
  forbidOnly: inCi,
  reporter: [
    ['list'],
    ['junit', { outputFile: 'reports/e2e-junit.xml' }],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    trace: 'retain-on-failure',
    // Colours settle at once (globals.css ends every transition under reduced motion), so
    // an accessibility check right after a click or a hover reads the hover colours
    // themselves. With the 150 ms colour transition running, a fast machine checked the
    // colours from before the hover and a slow one (CI) the ones after: the same fault
    // passed here and failed there.
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node e2e/serve-build.ts ${String(port)} ${JSON.stringify(builtDirectory)} ${JSON.stringify(servedDirectory)}`,
    url: `http://127.0.0.1:${String(port)}`,
    // Never a server that was already there: it would be serving an earlier copy.
    reuseExistingServer: false,
  },
});
