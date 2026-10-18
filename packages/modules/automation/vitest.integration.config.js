import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Contact updates and webhook visits combine pure checks with database composition.
    // Measure their existing boundary tests alongside the integration tests for those files.
    include: ['src/**/*.int.test.ts', 'src/actions-contact.test.ts', 'src/webhook-task.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-integration.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      include: ['src/**/*.ts'],
      // Pure planning, trigger matching, merge text, deal choice, the values a step works
      // out, webhook delivery and the task list are measured by the required unit gate; these paths need actual storage.
      exclude: [
        'src/**/*.test.ts',
        'src/steps.ts',
        'src/zoned-dates.ts',
        'src/triggers.ts',
        'src/simulate.ts',
        'src/webhook.ts',
        'src/actions-text.ts',
        'src/actions-deal-choice.ts',
        'src/contact-values.ts',
        'src/simulate-deals.ts',
        'src/trigger-evaluation-words.ts',
        'src/compared-fields.ts',
        'src/tracking-trigger.ts',
        'src/index.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
