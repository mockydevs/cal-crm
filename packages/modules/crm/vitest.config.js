import { defineConfig } from 'vitest/config';

// The CRM module's tests that need no database. Everything that reads or writes storage is
// in the integration run (vitest.integration.config.js), which also measures coverage.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts', 'src/**/*.budget.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
  },
});
