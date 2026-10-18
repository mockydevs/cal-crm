import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      // Pure planning, trigger matching, merge text, deal choice, the values a step works
      // out, webhook delivery and the task list need no database; integration measures every other source file.
      include: [
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
