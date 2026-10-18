import { defineConfig } from 'vitest/config';

// The parts that need no database: signed links, type checks and receiving an upload.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The service and its routes need Postgres and storage: the integration run measures them.
      exclude: [
        'src/**/*.test.ts',
        'src/files.ts',
        'src/routes.ts',
        'src/media.ts',
        'src/media-folders.ts',
        'src/media-routes.ts',
        'src/business-logo.ts',
        'src/user-avatar.ts',
        'src/index.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
