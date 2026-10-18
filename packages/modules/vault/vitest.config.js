import { defineConfig } from 'vitest/config';

// The parts that need no database: keys, sealing and opening.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The vault's storage and rotation need Postgres: the integration run measures them.
      exclude: ['src/**/*.test.ts', 'src/vault.ts', 'src/index.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
