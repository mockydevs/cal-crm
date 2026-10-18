import { defineConfig } from 'vitest/config';

// The notifications module's pure rules: who is left to tell, who holds a permission,
// what a preference is when nobody chose, and how an event's payload is read.
const PURE = ['src/rules.ts'];

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
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
