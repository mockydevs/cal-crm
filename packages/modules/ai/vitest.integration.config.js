import { defineConfig } from 'vitest/config';

import { unitFiles } from './vitest.config.js';

// The AI module against a real, migrated Postgres (@repo/testing), and its adapters against
// local stand-ins for the providers (test/fake-*.ts). The files the unit run measures are
// left to it, so every source file is held to one of the two gates.
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
