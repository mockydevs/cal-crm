// Differential test: our port must agree with the official SDK on random input. It needs
// the SDK as a development dependency of this package, pinned to twilio@6.1.2 (the version
// the port was made from). Without the SDK this file FAILS: a run that could not compare
// must never pass for a proof. Nothing here ever calls Twilio.
import { describe, expect, it } from 'vitest';

import {
  expectedBodyHash,
  expectedSignature,
  validateBody,
  validateSignature,
  validateSignatureWithBody,
  type SignedParams,
} from './twilio-signature.js';

interface Sdk {
  getExpectedTwilioSignature(authToken: string, url: string, params: object): string;
  validateRequest(authToken: string, header: string, url: string, params: object): boolean;
  getExpectedBodyHash(body: string): string;
  validateBody(body: string, bodyHash: string): boolean;
  validateRequestWithBody(authToken: string, header: string, url: string, body: string): boolean;
}

const isSdk = (value: unknown): value is Sdk =>
  typeof value === 'object' &&
  value !== null &&
  'getExpectedTwilioSignature' in value &&
  typeof value.getExpectedTwilioSignature === 'function' &&
  'validateRequest' in value &&
  typeof value.validateRequest === 'function' &&
  'validateRequestWithBody' in value &&
  typeof value.validateRequestWithBody === 'function';

async function loadSdk(): Promise<Sdk | undefined> {
  // Not a literal, so the package compiles and the other tests run without the SDK.
  const name = ['twilio', 'lib', 'webhooks', 'webhooks.js'].join('/');
  try {
    const loaded: unknown = await import(name);
    if (isSdk(loaded)) return loaded;
    const inner: unknown =
      typeof loaded === 'object' && loaded !== null && 'default' in loaded
        ? loaded.default
        : undefined;
    return isSdk(inner) ? inner : undefined;
  } catch {
    return undefined;
  }
}

const sdk = await loadSdk();
const MISSING =
  'The official SDK could not be loaded, so the signature port was NOT compared with it. ' +
  'Install twilio@6.1.2 as a devDependency of @repo/module-messaging.';

// A small seeded generator (mulberry32, by Tommy Ettinger, released to the public domain),
// so a failure can be reproduced.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'a',
  'B',
  'z',
  '0',
  '9',
  ' ',
  '  ',
  '+',
  '%2B',
  '%20',
  '&',
  '=',
  "'",
  '"',
  '/',
  '?',
  '#',
  'é',
  'ß',
  '中',
  '\u{1F600}',
  '\n',
  '\t',
  '~',
  '*',
  '(',
  ')',
  '!',
  ',',
  ';',
  ':',
  '@',
  '$',
  'To',
  'From',
  'Body',
  'MessageSid',
  'STOP',
];
const QUERY_PIECES = [
  'a',
  'b',
  '1',
  "'",
  '%27',
  '%20',
  '+',
  '~',
  '*',
  '(',
  ')',
  '!',
  'é',
  '%C3%A9',
  ',',
];

function sample(random: () => number): {
  token: string;
  url: string;
  params: Record<string, string | string[]>;
} {
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) throw new Error('empty choice');
    return item;
  };
  const text = (pieces: readonly string[], max: number) =>
    Array.from({ length: Math.floor(random() * (max + 1)) }, () => pick(pieces)).join('');
  const scheme = pick(['https', 'https', 'http']);
  const host = pick(['example.com', 'crm.example.test', 'sub.domain.example.org', '203.0.113.7']);
  const port = pick(['', '', ':443', ':80', ':8443', ':8080']);
  const user = pick(['', '', '', 'user@', 'user:pass@']);
  const path = pick(['', '/', '/hook', '/webhooks/twilio/abc_DEF-123/status', '/a%20b/', '/é']);
  const pairs = Array.from(
    { length: Math.floor(random() * 4) },
    () => `${text(QUERY_PIECES, 3) || 'k'}=${text(QUERY_PIECES, 4)}`,
  );
  const query = pairs.length === 0 ? '' : `?${pairs.join('&')}`;
  const params: Record<string, string | string[]> = {};
  for (let index = Math.floor(random() * 8); index > 0; index -= 1) {
    const name = text(PIECES, 3) || 'n';
    params[name] =
      random() < 0.2
        ? Array.from({ length: 1 + Math.floor(random() * 3) }, () => text(PIECES, 3))
        : text(PIECES, 6);
  }
  return {
    token: text(PIECES, 8) || 't',
    url: `${scheme}://${user}${host}${port}${path}${query}`,
    params,
  };
}

// The other spellings of a URL that Twilio might have signed.
function spellings(url: string, random: () => number): string {
  const parsed = new URL(url);
  const choice = Math.floor(random() * 4);
  if (choice === 0) return url;
  if (choice === 1) {
    parsed.port = '';
    return parsed.toString();
  }
  if (choice === 2 && parsed.port === '')
    return url.replace(
      parsed.host,
      `${parsed.host}:${parsed.protocol === 'https:' ? '443' : '80'}`,
    );
  return url.replaceAll("'", '%27');
}

describe('the port agrees with twilio@6.1.2', () => {
  // Every case fails, with the reason, when there is no SDK to compare with.
  const required = (): Sdk => {
    if (sdk === undefined) throw new Error(MISSING);
    return sdk;
  };

  it('has the official SDK to compare with', () => {
    expect(sdk, MISSING).toBeDefined();
  });

  it('for the signature of 5,000 random requests', () => {
    const official = required();
    const random = generator(20261009);
    for (let round = 0; round < 5000; round += 1) {
      const { token, url, params } = sample(random);
      const ours: SignedParams = params;
      expect(expectedSignature(token, url, ours), `${url} ${JSON.stringify(params)}`).toBe(
        official.getExpectedTwilioSignature(token, url, params),
      );
    }
  });

  it('for accepting and refusing 5,000 random requests, across URL spellings', () => {
    const official = required();
    const random = generator(137);
    let accepted = 0;
    let refused = 0;
    for (let round = 0; round < 5000; round += 1) {
      const { token, url, params } = sample(random);
      const signedUrl = spellings(url, random);
      let signature = official.getExpectedTwilioSignature(token, signedUrl, params);
      if (random() < 0.3) signature = signature.slice(0, -2) + (random() < 0.5 ? 'A=' : 'B=');
      if (random() < 0.05) signature = signature.slice(1);
      const theirs = official.validateRequest(token, signature, url, params);
      expect(validateSignature(token, signature, url, params), `${signedUrl} -> ${url}`).toBe(
        theirs,
      );
      if (theirs) accepted += 1;
      else refused += 1;
    }
    // Both answers must be exercised, or agreement proves little.
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
    // 5,000 requests through both implementations take over five seconds on a two-core CI
    // runner (CI run 38051791904), a second or two on a developer machine.
  }, 30_000);

  it('for the body hash of 1,000 random JSON bodies', () => {
    const official = required();
    const random = generator(4096);
    for (let round = 0; round < 1000; round += 1) {
      const { token, params } = sample(random);
      const body = JSON.stringify(params);
      const hash = official.getExpectedBodyHash(body);
      expect(expectedBodyHash(body)).toBe(hash);
      const given = random() < 0.3 ? hash.replace(/.$/, '0') : hash;
      expect(validateBody(body, given)).toBe(official.validateBody(body, given));
      const url = `https://example.com/hook?bodySHA256=${given}`;
      const signature = official.getExpectedTwilioSignature(token, url, {});
      expect(validateSignatureWithBody(token, signature, url, body)).toBe(
        official.validateRequestWithBody(token, signature, url, body),
      );
    }
  });
});
