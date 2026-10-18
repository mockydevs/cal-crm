// The install's keys. The worker holds the private keys, each with its version, as
// SECRETS_KEYS=2:private-<key>,1:private-<key>, the current one first. The app holds only
// the current public key, as SECRETS_PUBLIC_KEY=2:public-<key>. Each key is 32 bytes in
// base64url; its kind is spelled out, so neither setting takes the other's key.
import { randomBytes } from 'node:crypto';

import { suite } from './suite.js';

/** A private key: the 32 random bytes HPKE's DeriveKeyPair makes an X25519 pair from. */
export interface SecretsKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export interface SecretsPublicKey {
  readonly version: number;
  /** The X25519 public key. */
  readonly publicKey: Uint8Array;
}

/** A key setting that can't be read. Its message never repeats a key. */
export class SecretsKeyError extends Error {
  override readonly name = 'SecretsKeyError';
}

type Kind = 'private' | 'public';

const KEY_BYTES = 32;
/** vault.secrets.key_version is a smallint above 0. */
const MAX_VERSION = 32_767;
const versionPattern = /^[1-9]\d{0,4}$/;
const keyPattern = /^(private|public)-([\w-]{43})$/;

function checkVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new SecretsKeyError("a key's version must be a whole number from 1 to 32767");
  }
}

function parseEntry(entry: string, kind: Kind): { version: number; kind: Kind; bytes: Uint8Array } {
  const [version, key, ...rest] = entry.trim().split(':');
  if (version === undefined || key === undefined || rest.length > 0) {
    throw new SecretsKeyError(
      `each key must be version:${kind}-key, as node dist/vault.js new-key prints it`,
    );
  }
  if (!versionPattern.test(version)) {
    throw new SecretsKeyError("a key's version must be a whole number from 1 to 32767");
  }
  const parsed = Number(version);
  checkVersion(parsed);
  const [, found, text] = keyPattern.exec(key) ?? [];
  const bytes = Buffer.from(text ?? '', 'base64url');
  if ((found !== 'private' && found !== 'public') || bytes.toString('base64url') !== text) {
    throw new SecretsKeyError(
      `key version ${version} must be ${kind}- and 43 characters of base64url, 32 bytes, as node dist/vault.js new-key ${version} prints it`,
    );
  }
  return { version: parsed, kind: found, bytes: new Uint8Array(bytes) };
}

/** Reads SECRETS_KEYS: every private key with its version, the current one first. */
export function parseSecretsKeys(value: string): readonly [SecretsKey, ...SecretsKey[]] {
  if (value.trim() === '') {
    throw new SecretsKeyError('must hold at least one key, as version:private-key');
  }
  const keys = value.split(',').map((entry) => {
    const { version, kind, bytes } = parseEntry(entry, 'private');
    if (kind !== 'private') {
      throw new SecretsKeyError(
        `key version ${String(version)} is a public key: SECRETS_KEYS takes the private keys`,
      );
    }
    return { version, key: bytes };
  });
  const seen = new Set<number>();
  for (const { version } of keys) {
    if (seen.has(version)) {
      throw new SecretsKeyError(`key version ${String(version)} is listed twice`);
    }
    seen.add(version);
  }
  const [current, ...older] = keys;
  if (current === undefined) {
    throw new SecretsKeyError('must hold at least one key, as version:private-key');
  }
  return [current, ...older];
}

/** Reads SECRETS_PUBLIC_KEY: the current key's public key, with its version. */
export function parseSecretsPublicKey(value: string): SecretsPublicKey {
  if (value.includes(',')) {
    throw new SecretsKeyError("must be one public key, as version:public-key: the current key's");
  }
  const { version, kind, bytes } = parseEntry(value, 'public');
  if (kind !== 'public') {
    throw new SecretsKeyError(
      'holds a private key, which only the worker may have: give the app the public key printed beside it',
    );
  }
  return { version, publicKey: bytes };
}

/** A new private key and its public key, as the two settings take them. */
export async function newSecretsKey(
  version: number,
): Promise<{ secretsKey: string; publicKey: string }> {
  checkVersion(version);
  const key = randomBytes(KEY_BYTES);
  const pair = await suite.kem.deriveKeyPair(key);
  const publicKey = Buffer.from(await suite.kem.serializePublicKey(pair.publicKey));
  return {
    secretsKey: `${String(version)}:private-${key.toString('base64url')}`,
    publicKey: `${String(version)}:public-${publicKey.toString('base64url')}`,
  };
}
