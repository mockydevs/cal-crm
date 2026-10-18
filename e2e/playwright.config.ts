import { defineConfig, devices } from '@playwright/test';

const inCi = process.env['CI'] !== undefined;

// The whole product, as an install runs it: the built server serving the built dashboard,
// against a migrated Postgres. global-setup.ts starts them; tests read their addresses from
// the environment it sets (servers.ts).
export default defineConfig({
  testDir: 'tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  // Keep Windows serial after a production chunk failed with ERR_NO_BUFFER_SPACE at two.
  workers: process.platform === 'win32' ? 1 : inCi ? 2 : 4,
  forbidOnly: inCi,
  // A test of many steps takes about 8 s here and over 30 s on the CI server, where two
  // browsers share four cores with the server and Postgres: no step is slow, every one is a
  // little slower (the saved-views trace of 2026-10-15: 186 steps, none over 1.8 s).
  timeout: inCi ? 90_000 : 30_000,
  reporter: [
    ['list'],
    ['junit', { outputFile: 'reports/e2e-junit.xml' }],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    trace: 'retain-on-failure',
    // Colours settle at once (globals.css ends every transition under reduced motion), so
    // an accessibility check right after a click or a hover reads the hover colours
    // themselves. With the 150 ms colour transition running, a fast machine checked the
    // colours from before the hover and a slow one (CI) the ones after: the same fault
    // passed here and failed there.
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
