import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The web chat widget's view and the form embed's run on a DOM: their files ask for
    // jsdom themselves.
    include: [
      'src/**/*.test.ts',
      'webchat-widget/**/*.domtest.ts',
      'forms-embed/**/*.domtest.ts',
      'booking-embed/**/*.domtest.ts',
    ],
    exclude: ['src/**/*.int.test.ts', 'src/**/*.container.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      include: [
        'src/**/*.ts',
        'webchat-widget/entry.ts',
        'webchat-widget/view.ts',
        'forms-embed/entry.ts',
        'forms-embed/view.ts',
        'booking-embed/sizer.ts',
      ],
      // main.ts and instrumentation.ts only run as a process: process.int.test.ts runs the
      // built files. The worker needs Postgres: the integration run measures it.
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/install.ts',
        'src/vault.ts',
        'src/instrumentation.ts',
        // Measured by the integration tests, against Postgres.
        'src/cli.ts',
        'src/install-cli.ts',
        'src/vault-cli.ts',
        'src/worker/**',
        'src/realtime.ts',
        // Public capability handler is measured against real Postgres in integration.
        'src/unsubscribe.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
