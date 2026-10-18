import { defineConfig } from 'vitest/config';

// Harness contracts only, against loopback stand-ins. No Docker, CRM load or cloud traffic.
export default defineConfig({
  test: { include: ['bench/capacity*.test.ts'], maxWorkers: 1 },
});
