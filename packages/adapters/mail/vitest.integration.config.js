import { defineConfig } from 'vitest/config';

// Full adapter coverage: network cases plus real Mailpit and authenticated GreenMail peers.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-integration.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      // @repo/testing's Mailpit is tested here, so it's measured here.
      allowExternal: true,
      include: ['src/**/*.ts', '**/testing/src/mailpit.ts', '**/testing/src/greenmail.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
