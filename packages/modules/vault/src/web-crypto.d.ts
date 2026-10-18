// @hpke/core's declarations name the DOM's CryptoKey and CryptoKeyPair types. A Node build
// has neither: @types/node declares them under webcrypto, and CryptoKey only as a value.
// These name Node's types, which describe the same objects.
import type { webcrypto } from 'node:crypto';

declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
}
