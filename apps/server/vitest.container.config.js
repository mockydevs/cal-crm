import { defineConfig } from 'vitest/config';

// The image, in Docker (pnpm test:container). CI's image job runs it against the image it
// built and is about to scan and publish.
export default defineConfig({
  test: {
    include: ['src/**/*.container.test.ts'],
    hookTimeout: 900_000,
    testTimeout: 120_000,
    fileParallelism: false,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-container.xml' },
  },
});
