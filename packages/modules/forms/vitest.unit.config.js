import { defineConfig } from 'vitest/config';

// The forms module's pure rules: what a definition needs before it is published, what a
// submission's answers must be, the proof of when a form was shown, the link that previews
// a draft, its numbers and its limits.
const PURE = [
  'src/analytics-rules.ts',
  'src/answers.ts',
  // The same proof, lent to the public booking page.
  'src/booking-proof.ts',
  // What a form lacks, for the in-app assistant's page checks.
  'src/checks.ts',
  'src/definition.ts',
  'src/policy.ts',
  'src/preview-token.ts',
  'src/render-token.ts',
  // One submission of a form at a time, and the line behind it.
  'src/submit-gate.ts',
  // Who a submission comes from: an IPv4 address or an IPv6 /64.
  'src/visitor-source.ts',
];

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
