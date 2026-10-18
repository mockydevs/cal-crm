import { defineConfig } from 'vitest/config';

// What needs no database: the rules for autonomy and for proposals. Every other file is
// measured by the integration run (vitest.integration.config.js).
export const unitFiles = ['src/autonomy-rules.ts', 'src/proposal-rules.ts'];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      include: unitFiles,
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
