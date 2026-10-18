// Sealing and opening. The app seals with the public key and can't open; the worker opens
// with its private keys. Any changed byte fails to open, and so does a sealed secret moved
// to another row, business, agency or purpose: that's the tamper check.
import { describe, expect, it } from 'vitest';

import { newSecretsKey, parseSecretsKeys, parseSecretsPublicKey, SecretsKeyError } from './keys.js';
import {
  createOpener,
  createSealer,
  MAX_SECRET_BYTES,
  SecretUnreadableError,
  type Opener,
  type SealedSecret,
  type SecretAddress,
} from './sealing.js';
import { info, suite } from './suite.js';

const address: SecretAddress = {
  id: '01920000-0000-7000-8000-000000000001',
  agencyId: '01920000-0000-7000-8000-0000000000a1',
  businessId: '01920000-0000-7000-8000-0000000000b1',
  purpose: 'mailbox.password',
};

async function keys(version: number) {
  const made = await newSecretsKey(version);
  return {
    secretsKey: parseSecretsKeys(made.secretsKey)[0],
    publicKey: parseSecretsPublicKey(made.publicKey),
  };
}

function flipped(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

async function refusal(opener: Opener, at: SecretAddress, sealed: SealedSecret) {
  try {
    await opener.open(at, sealed);
  } catch (error) {
    if (error instanceof SecretUnreadableError) return error;
    throw error;
  }
  throw new Error('expected the secret not to open');
}

describe('sealing and opening', () => {
  it('opens what the public key sealed, with the version it was sealed under', async () => {
    const { secretsKey, publicKey } = await keys(2);
    const sealer = await createSealer(publicKey);
    const opener = await createOpener([secretsKey]);

    const sealed = await sealer.seal(address, 'correct horse battery staple, ünïcödé ✓');

    expect(sealer.keyVersion).toBe(2);
    expect(sealed.keyVersion).toBe(2);
    expect(sealed.enc).toHaveLength(32);
    await expect(opener.open(address, sealed)).resolves.toBe(
      'correct horse battery staple, ünïcödé ✓',
    );
  });

  it('gives the sealer nothing that opens', async () => {
    const sealer = await createSealer((await keys(1)).publicKey);

    expect(Object.keys(sealer).sort()).toEqual(['keyVersion', 'seal']);
  });

  it('seals the same secret differently each time, and never in the clear', async () => {
    const { publicKey } = await keys(1);
    const sealer = await createSealer(publicKey);

    const [first, second] = await Promise.all([
      sealer.seal(address, 'hunter2-hunter2'),
      sealer.seal(address, 'hunter2-hunter2'),
    ]);

    expect(Buffer.from(first.enc)).not.toEqual(Buffer.from(second.enc));
    expect(Buffer.from(first.ciphertext)).not.toEqual(Buffer.from(second.ciphertext));
    expect(Buffer.from(first.ciphertext).includes('hunter2')).toBe(false);
  });

  it('seals under the current key and opens under any key it holds', async () => {
    const old = await keys(1);
    const current = await keys(2);
    const before = await createSealer(old.publicKey);
    const opener = await createOpener([current.secretsKey, old.secretsKey]);

    const sealedBefore = await before.seal(address, 'sealed under version 1');
    const sealedNow = await opener.seal(address, 'sealed under version 2');

    expect(opener.keyVersion).toBe(2);
    expect(sealedNow.keyVersion).toBe(2);
    await expect(opener.open(address, sealedBefore)).resolves.toBe('sealed under version 1');
    await expect(opener.open(address, sealedNow)).resolves.toBe('sealed under version 2');
  });

  it('names the version it no longer holds', async () => {
    const old = await keys(1);
    const sealed = await (await createSealer(old.publicKey)).seal(address, 'a secret');
    const opener = await createOpener([(await keys(2)).secretsKey]);

    const error = await refusal(opener, address, sealed);

    expect(error.reason).toBe('unknown_key_version');
    expect(error.message).toBe(
      `Secret ${address.id} is sealed under key version 1, which SECRETS_KEYS doesn't hold.`,
    );
  });

  it('refuses a secret sealed under one version and labelled with another', async () => {
    const one = await keys(1);
    const two = await keys(2);
    const sealed = await (await createSealer(one.publicKey)).seal(address, 'a secret');
    const opener = await createOpener([two.secretsKey, one.secretsKey]);

    expect((await refusal(opener, address, { ...sealed, keyVersion: 2 })).reason).toBe('tampered');
  });

  describe('detects tampering', () => {
    it('in every byte of the ciphertext and the encapsulated key', async () => {
      const { secretsKey, publicKey } = await keys(1);
      const sealed = await (await createSealer(publicKey)).seal(address, 'p@ss');
      const opener = await createOpener([secretsKey]);

      for (let index = 0; index < sealed.ciphertext.length; index += 1) {
        const changed = { ...sealed, ciphertext: flipped(sealed.ciphertext, index) };
        expect((await refusal(opener, address, changed)).reason).toBe('tampered');
      }
      for (let index = 0; index < sealed.enc.length; index += 1) {
        const changed = { ...sealed, enc: flipped(sealed.enc, index) };
        expect((await refusal(opener, address, changed)).reason).toBe('tampered');
      }
    });

    it('in a ciphertext cut short or lengthened', async () => {
      const { secretsKey, publicKey } = await keys(1);
      const sealed = await (await createSealer(publicKey)).seal(address, 'p@ss');
      const opener = await createOpener([secretsKey]);

      const cut = { ...sealed, ciphertext: sealed.ciphertext.subarray(0, -1) };
      const lengthened = { ...sealed, ciphertext: Uint8Array.of(...sealed.ciphertext, 0) };

      expect((await refusal(opener, address, cut)).reason).toBe('tampered');
      expect((await refusal(opener, address, lengthened)).reason).toBe('tampered');
    });

    it.each([
      ['another row', { id: '01920000-0000-7000-8000-000000000002' }],
      ['another agency', { agencyId: '01920000-0000-7000-8000-0000000000a2' }],
      ['another business', { businessId: '01920000-0000-7000-8000-0000000000b2' }],
      ['the agency as a whole', { businessId: null }],
      ['another purpose', { purpose: 'ai.anthropic_key' }],
    ])('when it is moved to %s', async (_case, moved) => {
      const { secretsKey, publicKey } = await keys(1);
      const sealed = await (await createSealer(publicKey)).seal(address, 'p@ss');
      const opener = await createOpener([secretsKey]);

      const error = await refusal(opener, { ...address, ...moved }, sealed);

      expect(error.reason).toBe('tampered');
      expect(error.message).toContain('failed its integrity check');
    });
  });

  it('refuses bytes that are not text, as anyone holding the public key could seal', async () => {
    const { secretsKey, publicKey } = await keys(1);
    // Sealed directly, as the sealer would, but over bytes that aren't UTF-8.
    const { ct, enc } = await suite.seal(
      { recipientPublicKey: await suite.kem.deserializePublicKey(publicKey.publicKey), info },
      Uint8Array.of(0xc3, 0x28),
      new TextEncoder().encode(
        JSON.stringify([address.id, address.agencyId, address.businessId, address.purpose]),
      ),
    );
    const sealed = { keyVersion: 1, enc: new Uint8Array(enc), ciphertext: new Uint8Array(ct) };

    const error = await refusal(await createOpener([secretsKey]), address, sealed);

    expect(error.reason).toBe('tampered');
  });

  it('reads ids in any case, as the database writes them in lower case', async () => {
    const { secretsKey, publicKey } = await keys(1);
    const upper = {
      ...address,
      id: address.id.toUpperCase(),
      agencyId: address.agencyId.toUpperCase(),
    };
    const sealed = await (await createSealer(publicKey)).seal(upper, 'a secret');

    await expect((await createOpener([secretsKey])).open(address, sealed)).resolves.toBe(
      'a secret',
    );
  });

  it('refuses an empty secret, and one over the limit', async () => {
    const sealer = await createSealer((await keys(1)).publicKey);

    await expect(sealer.seal(address, '')).rejects.toThrow(RangeError);
    await expect(sealer.seal(address, 'é'.repeat(MAX_SECRET_BYTES / 2 + 1))).rejects.toThrow(
      RangeError,
    );
    await expect(sealer.seal(address, 'x'.repeat(MAX_SECRET_BYTES))).resolves.toBeDefined();
  });

  it("refuses a public key that can't seal, when the sealer is made", async () => {
    // Web Crypto imports the all-zero X25519 public key, a low-order point, but the shared
    // secret it gives is all zeros, which X25519 refuses: only sealing shows it.
    await expect(createSealer({ version: 3, publicKey: new Uint8Array(32) })).rejects.toThrow(
      new SecretsKeyError("public key version 3 can't seal: it isn't a usable X25519 public key"),
    );
  });
});
