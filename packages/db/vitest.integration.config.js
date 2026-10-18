import { defineConfig } from 'vitest/config';

// Integration tests run against a real Postgres 18 in Docker (Testcontainers). The global
// setup starts one server and migrates a template; each test file copies it.
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Starting the container can take a while on a cold Docker cache.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-integration.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      // @repo/testing is tested here, against the real migrations, so it's measured here.
      allowExternal: true,
      include: ['src/**/*.ts', '**/testing/src/**/*.ts'],
      // bin.ts only hands the process to cli.ts; a test runs the built file instead. The S3
      // and Mailpit/GreenMail servers are tested and measured with the storage/mail adapters,
      // and the test authenticator app and passkey with sign-in.
      exclude: [
        'src/**/*.test.ts',
        'src/bin.ts',
        '**/testing/src/s3.ts',
        '**/testing/src/mailpit.ts',
        '**/testing/src/greenmail.ts',
        '**/testing/src/totp.ts',
        '**/testing/src/passkey.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
