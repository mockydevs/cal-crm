import { defineConfig } from 'vitest/config';

// The sites module's pure rules: copying a document with its references renamed, signing
// and reading a share bundle, the DNS record a domain needs and how a lookup is judged,
// the templates that ship with the product, the checks a page passes before it is
// published, and the link that previews a draft.
const PURE = [
  'src/remap.ts',
  'src/bundle-signature.ts',
  'src/dns.ts',
  'src/builtin-templates.ts',
  'src/checks.ts',
  'src/elements.ts',
  'src/preview-token.ts',
  'src/page-cache.ts',
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
