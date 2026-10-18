import { defineConfig } from 'vitest/config';

// The checks run against fixture DNS zones and a local HTTP server: no network. The live
// provider test is skipped unless EMAILABLE_TEST_API_KEY holds a test key.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
