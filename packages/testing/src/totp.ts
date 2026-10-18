// The code an authenticator app shows, for tests that sign in with two factors. It reads
// an otpauth:// link as Google Authenticator and others do (RFC 6238: a base32 secret,
// HMAC-SHA-1, 6 digits every 30 seconds unless the link says otherwise), so a test that
// passes with it shows a real app would work.
import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fromBase32(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error(`The secret isn't base32: it has "${char}".`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** The code an authenticator app shows for this otpauth:// link at a time: now by default. */
export function totpCode(otpauthLink: string, at: number = Date.now()): string {
  const link = new URL(otpauthLink);
  const secret = link.searchParams.get('secret');
  if (link.protocol !== 'otpauth:' || secret === null) {
    throw new Error('Expected an otpauth:// link with a secret.');
  }
  const digits = Number(link.searchParams.get('digits') ?? '6');
  const period = Number(link.searchParams.get('period') ?? '30');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const hmac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
