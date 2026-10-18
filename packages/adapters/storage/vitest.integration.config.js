import { defineConfig } from 'vitest/config';

// Both backends: a temporary directory, and Garage in Docker for S3 (@repo/testing's
// startS3, called by the test file itself).
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-integration.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      // @repo/testing's S3 server is tested here, so it's measured here.
      allowExternal: true,
      include: ['src/**/*.ts', '**/testing/src/s3.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
