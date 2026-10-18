import { defineConfig } from 'vitest/config';

// The page benchmark, the intake load test and the browser pass of the arrival
// (bench/README.md): the production start on a real Postgres, measured or driven. Run on purpose, one at a time, never with the test suites:
// what they measure is this machine with nothing else on it.
export default defineConfig({
  test: {
    include: ['bench/**/*.bench.ts', 'bench/**/*.load.ts', 'bench/**/*.browser.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 600_000,
    testTimeout: 900_000,
    fileParallelism: false,
    reporters: ['default'],
  },
});
