import { defineConfig } from 'vitest/config';

// The reporting module's pure parts: how a range of days is worked out and compared, how
// rows from the database become an answer, the per-person limit, and the templates.
const PURE = ['src/range.ts', 'src/fold.ts', 'src/rate-limit.ts', 'src/templates/**/*.ts'];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-unit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      include: PURE,
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
