import { defineConfig } from 'vitest/config';

// Runs the built server (turbo builds it first) as a process, and the API against a real,
// migrated Postgres (@repo/testing).
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 600_000,
    testTimeout: 120_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-integration.xml' },
    // The unit run measures the rest; the worker needs Postgres.
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      include: [
        'src/worker/**/*.ts',
        'src/cli.ts',
        'src/install-cli.ts',
        'src/vault-cli.ts',
        'src/realtime.ts',
        'src/unsubscribe.ts',
      ],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
