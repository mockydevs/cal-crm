import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      include: [
        'src/mailbox-network.ts',
        'src/mailbox-discovery.ts',
        'src/delivery-report.ts',
        'src/reply-headers.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
