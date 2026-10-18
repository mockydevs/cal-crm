// The HPKE suite every secret is sealed with (RFC 9180): DHKEM(X25519, HKDF-SHA256),
// HKDF-SHA256 and AES-256-GCM, in base mode, on Node's Web Crypto.
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';

export const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

/** HPKE's info: what the sealed bytes are, so they can't be taken for anything else. */
export const info = new TextEncoder().encode('crm vault secret v1');
