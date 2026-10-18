// Sealing secrets for the worker, and opening them there. The app holds a sealer, made from
// the current public key, which can't open anything. The worker holds an opener, made from
// its private keys. What's sealed is bound to its row in vault.secrets: its id, agency,
// business and purpose are the AEAD's associated data, so a sealed secret moved to another
// row fails to open, just as one with a changed byte does.
import { SecretsKeyError, type SecretsKey, type SecretsPublicKey } from './keys.js';
import { info, suite } from './suite.js';

/** Where a secret is stored: its row, and whose and what it is. */
export interface SecretAddress {
  readonly id: string;
  readonly agencyId: string;
  /** Null for a secret the whole agency uses, such as its AI key. */
  readonly businessId: string | null;
  /** What it's for, such as mailbox.password. */
  readonly purpose: string;
}

export interface SealedSecret {
  readonly keyVersion: number;
  /** HPKE's encapsulated key: 32 bytes. */
  readonly enc: Uint8Array;
  /** The sealed secret with its 16-byte tag. */
  readonly ciphertext: Uint8Array;
}

/** The largest secret taken, in UTF-8 bytes; OAuth tokens run to a few kilobytes. */
export const MAX_SECRET_BYTES = 65_536;

export interface Sealer {
  /** The version of the key it seals under. */
  readonly keyVersion: number;
  /** Seals a secret for its row. */
  seal(address: SecretAddress, plaintext: string): Promise<SealedSecret>;
}

export interface Opener extends Sealer {
  /** Opens a sealed secret, checking it hasn't changed and belongs to its row. */
  open(address: SecretAddress, sealed: SealedSecret): Promise<string>;
}

/** A secret that can't be opened: a key no longer held, or a failed integrity check. */
export class SecretUnreadableError extends Error {
  override readonly name = 'SecretUnreadableError';

  constructor(
    readonly secretId: string,
    readonly reason: 'unknown_key_version' | 'tampered',
    keyVersion: number,
  ) {
    super(
      reason === 'unknown_key_version'
        ? `Secret ${secretId} is sealed under key version ${String(keyVersion)}, which SECRETS_KEYS doesn't hold.`
        : `Secret ${secretId} failed its integrity check: it was changed, or moved from another row.`,
    );
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The associated data: the row a secret belongs to, as JSON, which can't make two
 * addresses look alike. UUIDs are compared in lower case, as Postgres writes them.
 */
function associatedData(address: SecretAddress): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      address.id.toLowerCase(),
      address.agencyId.toLowerCase(),
      address.businessId?.toLowerCase() ?? null,
      address.purpose,
    ]),
  );
}

function sealWith(recipientPublicKey: CryptoKey, keyVersion: number): Sealer {
  return {
    keyVersion,
    seal: async (address, plaintext) => {
      const bytes = encoder.encode(plaintext);
      if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) {
        throw new RangeError(
          `A secret must be 1 to ${String(MAX_SECRET_BYTES)} bytes long; this one is ${String(bytes.length)}.`,
        );
      }
      const { ct, enc } = await suite.seal(
        { recipientPublicKey, info },
        bytes,
        associatedData(address),
      );
      return { keyVersion, enc: new Uint8Array(enc), ciphertext: new Uint8Array(ct) };
    },
  };
}

/**
 * A sealer for the app: it seals under the current public key, and opens nothing. It seals
 * once to check the key, so a key that can't be used stops the start, not the first save.
 */
export async function createSealer(key: SecretsPublicKey): Promise<Sealer> {
  const sealer = sealWith(await suite.kem.deserializePublicKey(key.publicKey), key.version);
  try {
    await sealer.seal({ id: '', agencyId: '', businessId: null, purpose: '' }, 'check');
  } catch {
    throw new SecretsKeyError(
      `public key version ${String(key.version)} can't seal: it isn't a usable X25519 public key`,
    );
  }
  return sealer;
}

/** An opener for the worker: it opens under any key it holds, and seals under the first. */
export async function createOpener(keys: readonly [SecretsKey, ...SecretsKey[]]): Promise<Opener> {
  const [current, ...older] = keys;
  const currentPair = await suite.kem.deriveKeyPair(current.key);
  const pairs = new Map([[current.version, currentPair]]);
  for (const { version, key } of older) {
    pairs.set(version, await suite.kem.deriveKeyPair(key));
  }
  const sealer = sealWith(currentPair.publicKey, current.version);
  return {
    keyVersion: sealer.keyVersion,
    seal: (address, plaintext) => sealer.seal(address, plaintext),
    open: async (address, sealed) => {
      const pair = pairs.get(sealed.keyVersion);
      if (pair === undefined) {
        throw new SecretUnreadableError(address.id, 'unknown_key_version', sealed.keyVersion);
      }
      try {
        const opened = await suite.open(
          { recipientKey: pair, enc: sealed.enc, info },
          sealed.ciphertext,
          associatedData(address),
        );
        // Text, as the sealer seals it: anything else was sealed by someone else.
        return decoder.decode(opened);
      } catch {
        throw new SecretUnreadableError(address.id, 'tampered', sealed.keyVersion);
      }
    },
  };
}
