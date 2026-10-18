import { defineConfig } from 'vitest/config';

// Every check runs against fixture zones through an injected resolver: no network.
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
