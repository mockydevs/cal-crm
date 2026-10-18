import { describe, expect, it } from 'vitest';

import { emailableProvider } from './emailable.js';

// Runs against Emailable itself only when EMAILABLE_TEST_API_KEY holds a test key (it
// starts with test_): answers are simulated and use no credits. A live key is refused,
// because it would spend credits. Only the test addresses Emailable documents are used
// (https://emailable.com/docs/api/emails/#test-email-addresses): any other address gets a
// random sample answer, and each fixed address fixes only the one attribute named.
const key = process.env['EMAILABLE_TEST_API_KEY'] ?? '';

describe.skipIf(!key.startsWith('test_'))('Emailable with a test key', () => {
  // Made per test: the describe body runs even when it is skipped.
  const provider = () => emailableProvider({ apiKey: key, slowRetries: 0 });

  it.each([
    ['deliverable@example.com', 'deliverable'],
    ['undeliverable@example.com', 'undeliverable'],
    ['risky@example.com', 'risky'],
    ['unknown@example.com', 'unknown'],
  ])('answers %s with the state %s, at no charge', async (address, state) => {
    const outcome = await provider().verify(address);
    expect(outcome).toMatchObject({ kind: 'result', raw: { state }, charged: false });
  });

  it.each([
    ['role@example.com', 'role'],
    ['free@example.com', 'free_provider'],
    ['accept-all@example.com', 'catch_all'],
    ['disposable@example.com', 'disposable'],
  ])('flags %s as %s', async (address, reason) => {
    const outcome = await provider().verify(address);
    expect(outcome.kind === 'result' ? outcome.reasons : []).toContain(reason);
  });

  it('answers slow@example.com with a 249, read as slow', async () => {
    await expect(provider().verify('slow@example.com')).resolves.toMatchObject({
      kind: 'failed',
      problem: 'slow',
    });
  });

  it('reads the account in test mode', async () => {
    await expect(provider().account()).resolves.toMatchObject({ kind: 'ok', testMode: true });
  });
});
