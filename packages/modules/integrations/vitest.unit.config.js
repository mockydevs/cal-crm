import { defineConfig } from 'vitest/config';

// The integrations module's pure parts: the OAuth requests and answers, webhook signatures,
// and how a card's state and a check's time are worked out.
const PURE = ['src/rules.ts', 'src/oauth.ts'];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-unit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      include: PURE,
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
