import { defineConfig } from 'vitest/config';

import { unitFiles } from './vitest.config.js';

// The command layer against a real, migrated Postgres (@repo/testing). The rules that need
// no database are measured by the unit run instead (vitest.config.js).
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
      exclude: ['src/**/*.test.ts', ...unitFiles],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
