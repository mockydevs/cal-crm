import { defineConfig } from 'vitest/config';

// The CRM's performance budgets against a real, migrated Postgres, run alone:
// `pnpm --filter @repo/module-crm test:budget`.
export default defineConfig({
  test: {
    include: ['src/**/*.budget.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 300_000,
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
