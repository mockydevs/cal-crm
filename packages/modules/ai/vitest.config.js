import { defineConfig } from 'vitest/config';

// What needs no database: the pure helpers, and the transport against servers the tests
// start on loopback. Every other file is measured by the integration run.
export const unitFiles = [
  'src/addresses.ts',
  // The in-app assistant's turn and its tools: the loop is driven by a scripted model, and
  // a tool is a route the test hands it. Neither needs a database.
  'src/assistant-loop.ts',
  'src/assistant-checkpoint.ts',
  'src/assistant-journey.ts',
  'src/assistant-cancellation.ts',
  'src/assistant-permissions.ts',
  'src/assistant-toolbox.ts',
  // The eval harness: it has no database, and its model is a local stand-in.
  'src/evals/checks.ts',
  'src/evals/cli.ts',
  'src/evals/dataset.ts',
  'src/evals/entry.ts',
  'src/evals/eval-gateway.ts',
  'src/evals/fixtures/scripted.ts',
  'src/evals/fixtures/suite.ts',
  'src/evals/fixtures/workspace.ts',
  'src/evals/gate.ts',
  'src/evals/paths.ts',
  'src/evals/read.ts',
  'src/evals/record.ts',
  'src/evals/recording.ts',
  'src/evals/registry.ts',
  'src/evals/replay.ts',
  'src/evals/report.ts',
  'src/evals/runner.ts',
  'src/evals/suites.ts',
  'src/evals/tested.gen.ts',
  'src/evals/tested.ts',
  'src/evals/types.ts',
  'src/evals/verify.ts',
  // The extraction job's one call and what may be kept as a fact: no database, and the
  // model is a scripted answer or a local stand-in.
  'src/extraction.ts',
  'src/extraction-evals.ts',
  'src/json.ts',
  'src/masking.ts',
  'src/memory-rules.ts',
  'src/pricing.ts',
  'src/provider.ts',
  // The inbox agent's one job and its eval suite: no database, and the model is a scripted
  // answer or a local stand-in.
  'src/reply-draft.ts',
  'src/reply-draft-evals.ts',
  'src/sse.ts',
  'src/transport.ts',
];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts', 'src/**/*.live.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      include: unitFiles,
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
