import { defineConfig } from 'vitest/config';

// The live check against a real, local Ollama (src/ollama.live.test.ts). Not part of the
// ordinary runs: it needs OLLAMA_BASE_URL and OLLAMA_MODEL, and a model answering on a CPU
// takes its time.
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
