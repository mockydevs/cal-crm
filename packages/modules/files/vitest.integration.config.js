import { defineConfig } from 'vitest/config';

// The files module against a real, migrated Postgres (@repo/testing) and local storage.
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
      // The unit run measures the rest.
      include: [
        'src/files.ts',
        'src/routes.ts',
        'src/business-logo.ts',
        'src/user-avatar.ts',
        'src/media.ts',
        'src/media-folders.ts',
        'src/media-routes.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
