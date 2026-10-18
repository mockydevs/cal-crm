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
      // The pure rules are measured by the unit run; everything here needs Postgres.
      exclude: [
        'src/**/*.test.ts',
        'src/analytics-rules.ts',
        'src/answers.ts',
        'src/checks.ts',
        'src/definition.ts',
        'src/policy.ts',
        'src/preview-token.ts',
        'src/render-token.ts',
        'src/submit-gate.ts',
        'src/booking-proof.ts',
        'src/visitor-source.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
