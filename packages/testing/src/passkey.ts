// A passkey on a software authenticator, for tests that register and sign in with one
// without a browser. It answers WebAuthn's two ceremonies as an authenticator would
// (W3C Web Authentication, level 3): a P-256 key (ES256), "none" attestation, and flags
// saying the person was present and, unless the test says otherwise, verified (a PIN or a
// fingerprint). Its responses are the JSON a browser library such as SimpleWebAuthn sends.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** What a registration ceremony needs from the server's options. */
export interface CreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
}

/** What a sign-in ceremony needs from the server's options. */
export interface RequestOptions {
  readonly challenge: string;
  readonly rpId?: string;
}

/**
 * How the authenticator checked the person. With userVerified false it says only that
 * someone was present, as a security key without a PIN does.
 */
export interface Ceremony {
  readonly userVerified?: boolean;
}

export interface Passkey {
  /** The credential's id, base64url, as the server stores it. */
  readonly id: string;
  /** Answers registration options: the credential, attested with "none". */
  register(options: CreationOptions, origin: string, ceremony?: Ceremony): Record<string, unknown>;
  /** Answers sign-in options: a signature over the challenge. */
  signIn(options: RequestOptions, origin: string, ceremony?: Ceremony): Record<string, unknown>;
}

// Authenticator data flags (WebAuthn section 6.1).
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

type Cbor = number | string | Uint8Array | ReadonlyMap<Cbor, Cbor>;

/** A CBOR item's head. Everything encoded here is shorter than 256 bytes. */
function cborHead(major: number, length: number): Buffer {
  return length < 24
    ? Buffer.from([(major << 5) | length])
    : Buffer.from([(major << 5) | 24, length]);
}

/** CBOR (RFC 8949) for what attestation needs: small integers, text, bytes and maps. */
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  return Buffer.concat([
    cborHead(5, value.size),
    ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();
const base64url = (data: Buffer): string => data.toString('base64url');

/** The public key as COSE (RFC 9053): an EC2 key on P-256, for ES256. */
function coseKey(publicKey: KeyObject): Buffer {
  const { x, y } = publicKey.export({ format: 'jwk' });
  if (x === undefined || y === undefined) throw new Error('Expected an EC public key.');
  return cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(x, 'base64url')],
      [-3, Buffer.from(y, 'base64url')],
    ]),
  );
}

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

function rpIdOf(rpId: string | undefined, origin: string): string {
  return rpId ?? new URL(origin).hostname;
}

const flagsFor = (ceremony: Ceremony): number =>
  USER_PRESENT | (ceremony.userVerified === false ? 0 : USER_VERIFIED);

/** A new passkey, on its own key. */
export function softPasskey(): Passkey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = randomBytes(16);
  const signCount = Buffer.alloc(4);

  return {
    id: base64url(credentialId),

    register(options, origin, ceremony = {}) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authenticatorData = Buffer.concat([
        sha256(rpIdOf(options.rp.id, origin)),
        Buffer.from([flagsFor(ceremony) | ATTESTED_CREDENTIAL]),
        signCount,
        Buffer.alloc(16), // The AAGUID: all zeros, as a privacy-preserving authenticator reports.
        idLength,
        credentialId,
        coseKey(publicKey),
      ]);
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authenticatorData],
        ]),
      );
      return {
        id: base64url(credentialId),
        rawId: base64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: base64url(clientData('webauthn.create', options.challenge, origin)),
          attestationObject: base64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    signIn(options, origin, ceremony = {}) {
      const authenticatorData = Buffer.concat([
        sha256(rpIdOf(options.rpId, origin)),
        Buffer.from([flagsFor(ceremony)]),
        signCount,
      ]);
      const data = clientData('webauthn.get', options.challenge, origin);
      // ES256 signs the authenticator data and the client data's hash; Node's signature
      // for an EC key is DER-encoded, as WebAuthn expects.
      const signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, sha256(data)]),
        privateKey,
      );
      return {
        id: base64url(credentialId),
        rawId: base64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: base64url(data),
          authenticatorData: base64url(authenticatorData),
          signature: base64url(signature),
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}
