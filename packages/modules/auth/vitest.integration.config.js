import { defineConfig } from 'vitest/config';

// The CRM module against a real, migrated Postgres (@repo/testing).
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
      // @repo/testing's authenticator app and passkey are tested here, where sign-in uses them.
      allowExternal: true,
      include: ['src/**/*.ts', '**/testing/src/totp.ts', '**/testing/src/passkey.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
