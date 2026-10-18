import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The small page scripts run on a DOM: their test files ask for jsdom themselves.
    include: ['src/**/*.test.ts', 'runtime/**/*.domtest.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'runtime/arrival.ts', 'runtime/countdown.ts', 'runtime/popup.ts'],
      exclude: ['src/**/*.test.ts', 'src/fixtures.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
