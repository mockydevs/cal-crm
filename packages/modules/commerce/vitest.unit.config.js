import { defineConfig } from 'vitest/config';

// The commerce module's pure parts: how stored amounts become a document's totals, what a
// due date is when none was given, who a document is from, and what a counter may be
// moved to; and what a document says when it is printed, as a PDF and as a page, and the
// words of the email that carries it. The arithmetic itself is the contract's
// (commerce-money.ts) and is measured there.
const PURE = [
  'src/rules.ts',
  'src/print.ts',
  'src/print-pdf.ts',
  'src/print-html.ts',
  'src/mail-text.ts',
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
