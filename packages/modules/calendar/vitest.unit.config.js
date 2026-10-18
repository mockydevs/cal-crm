import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'src/slots.test.ts',
      'src/slots-midnight.test.ts',
      'src/assignment-policy.test.ts',
      'src/user-availability.test.ts',
      'src/appointment-report-rules.test.ts',
      'src/invite.test.ts',
      'src/google/google-api.test.ts',
      'src/google/google-busy-rules.test.ts',
    ],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-unit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      include: [
        'src/slots.ts',
        'src/assignment-policy.ts',
        'src/user-availability.ts',
        'src/appointment-report-rules.ts',
        'src/invite.ts',
        'src/google/google-api.ts',
        'src/google/google-busy-rules.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
