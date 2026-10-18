import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-integration.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      include: ['src/**/*.ts'],
      // The pure parts are measured by the unit run; everything here needs Postgres.
      exclude: [
        'src/**/*.test.ts',
        'src/rules.ts',
        'src/print.ts',
        'src/print-pdf.ts',
        'src/print-html.ts',
        'src/mail-text.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
