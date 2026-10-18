// The install's keys, as the worker (SECRETS_KEYS) and the app (SECRETS_PUBLIC_KEY) are
// given them. A key that's malformed, or of the wrong kind, stops the start, and no message
// repeats a key.
import { describe, expect, it } from 'vitest';

import { newSecretsKey, parseSecretsKeys, parseSecretsPublicKey, SecretsKeyError } from './keys.js';

const bytes = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const key = (byte: number) => `private-${bytes(byte)}`;
const publicKey = (byte: number) => `public-${bytes(byte)}`;

function refusal(parse: () => unknown): SecretsKeyError {
  try {
    parse();
  } catch (error) {
    if (error instanceof SecretsKeyError) return error;
    throw error;
  }
  throw new Error('expected the value to be refused');
}

describe('newSecretsKey', () => {
  it('makes a private key and its public key, both under the version given', async () => {
    const made = await newSecretsKey(3);

    expect(made.secretsKey).toMatch(/^3:private-[\w-]{43}$/);
    expect(made.publicKey).toMatch(/^3:public-[\w-]{43}$/);
    const [parsed] = parseSecretsKeys(made.secretsKey);
    expect(parsed.version).toBe(3);
    expect(parseSecretsPublicKey(made.publicKey).version).toBe(3);
  });

  it('makes a different key each time', async () => {
    const [first, second] = await Promise.all([newSecretsKey(1), newSecretsKey(1)]);

    expect(first.secretsKey).not.toBe(second.secretsKey);
    expect(first.publicKey).not.toBe(second.publicKey);
  });

  it("refuses a version the database can't store", async () => {
    await expect(newSecretsKey(0)).rejects.toThrow(SecretsKeyError);
    await expect(newSecretsKey(32_768)).rejects.toThrow(SecretsKeyError);
    await expect(newSecretsKey(1.5)).rejects.toThrow(SecretsKeyError);
  });
});

describe('parseSecretsKeys', () => {
  it('reads every key with its version, the current one first', () => {
    const keys = parseSecretsKeys(`2:${key(2)}, 1:${key(1)}`);

    expect(keys.map((entry) => entry.version)).toEqual([2, 1]);
    expect(keys.map((entry) => Buffer.from(entry.key))).toEqual([
      Buffer.alloc(32, 2),
      Buffer.alloc(32, 1),
    ]);
  });

  it('takes the versions in any order, since the first listed is the current one', () => {
    expect(parseSecretsKeys(`1:${key(1)},2:${key(2)}`).map((entry) => entry.version)).toEqual([
      1, 2,
    ]);
  });

  it.each([
    ['nothing', '', 'must hold at least one key'],
    ['a key with no version', key(1), 'version:private-key'],
    ['version 0', `0:${key(1)}`, 'from 1 to 32767'],
    ['a version beyond a smallint', `32768:${key(1)}`, 'from 1 to 32767'],
    ['a version with a leading zero', `01:${key(1)}`, 'from 1 to 32767'],
    ['a negative version', `-1:${key(1)}`, 'from 1 to 32767'],
    ['a key with no kind', `1:${bytes(1)}`, 'private- and 43 characters'],
    ['a short key', `1:${key(1).slice(0, -1)}`, 'private- and 43 characters'],
    ['a long key', `1:${key(1)}A`, 'private- and 43 characters'],
    [
      'a key in standard base64',
      `1:private-${Buffer.alloc(32, 0xfb).toString('base64')}`,
      'private- and 43 characters',
    ],
    // The last character holds two spare bits: only one spelling of each key is taken.
    ['a key spelled another way', `1:${key(1).slice(0, -1)}F`, 'private- and 43 characters'],
    ['an empty entry', `2:${key(2)},,1:${key(1)}`, 'version:private-key'],
  ])('refuses %s', (_case, value, message) => {
    const error = refusal(() => parseSecretsKeys(value));

    expect(error.message).toContain(message);
  });

  it('refuses a public key, which opens nothing', () => {
    expect(refusal(() => parseSecretsKeys(`2:${key(2)},1:${publicKey(1)}`)).message).toBe(
      'key version 1 is a public key: SECRETS_KEYS takes the private keys',
    );
  });

  it('refuses a version listed twice', () => {
    expect(refusal(() => parseSecretsKeys(`1:${key(1)},1:${key(2)}`)).message).toBe(
      'key version 1 is listed twice',
    );
  });

  it('never repeats a key in its message', () => {
    const secret = bytes(7).slice(0, 40);

    expect(refusal(() => parseSecretsKeys(`5:private-${secret}`)).message).not.toContain(secret);
    expect(refusal(() => parseSecretsKeys(secret)).message).not.toContain(secret);
  });
});

describe('parseSecretsPublicKey', () => {
  it('reads one public key with its version', () => {
    const parsed = parseSecretsPublicKey(`4:${publicKey(9)}`);

    expect(parsed.version).toBe(4);
    expect(Buffer.from(parsed.publicKey)).toEqual(Buffer.alloc(32, 9));
  });

  it('refuses a private key, which only the worker may hold, without repeating it', () => {
    const error = refusal(() => parseSecretsPublicKey(`2:${key(2)}`));

    expect(error.message).toBe(
      'holds a private key, which only the worker may have: give the app the public key printed beside it',
    );
    expect(error.message).not.toContain(bytes(2));
  });

  it('refuses more than one', () => {
    expect(
      refusal(() => parseSecretsPublicKey(`2:${publicKey(2)},1:${publicKey(1)}`)).message,
    ).toContain('one public key');
  });

  it('refuses a malformed key', () => {
    expect(refusal(() => parseSecretsPublicKey('2:public-short')).message).toContain(
      'public- and 43 characters',
    );
  });
});
