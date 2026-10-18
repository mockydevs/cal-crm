import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import {
  fixtureResolver,
  type FixtureZone,
  type FixtureResolver,
} from '../src/fixture-resolver.js';

// Disposable identities; never production signing keys or captured customer messages.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`;

export const baseHeaders = ['from', 'to', 'subject', 'date', 'message-id'];
export const unsubscribeHeaders = ['list-unsubscribe', 'list-unsubscribe-post'];
export const campaignSource = Buffer.from(
  [
    'From: Harbor <sender@example.com>',
    'To: sender@example.com',
    'Date: Fri, 09 Oct 2026 00:00:00 +0000',
    'Message-ID: <probe@example.com>',
    'Subject: Mailbox setup check',
    'List-Unsubscribe: <https://example.com/unsubscribe/opaque-test-id>',
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    '',
    'This is a mailbox setup check.',
    '',
  ].join('\r\n'),
);

export function messageResolver(zone: FixtureZone = {}): FixtureResolver {
  return fixtureResolver({
    'probe._domainkey.example.com': { TXT: [key] },
    'probe._domainkey.example.net': { TXT: [key] },
    '_dmarc.example.com': { TXT: ['v=DMARC1; p=none'] },
    ...zone,
  });
}

export async function signedMessage(
  source: Buffer = campaignSource,
  headerList = [...baseHeaders, ...unsubscribeHeaders],
  fixture: {
    readonly signingDomain?: string;
    readonly maxBodyLength?: number;
    readonly signTime?: Date;
    readonly expires?: Date;
  } = {},
): Promise<Buffer> {
  // Installed signer source/README require signatureData; its declaration instead
  // requires unused top-level identity fields. Keep that mismatch at this fixture boundary.
  const options = {
    signatureData: [
      {
        signingDomain: fixture.signingDomain ?? 'example.com',
        selector: 'probe',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        ...(fixture.maxBodyLength === undefined ? {} : { maxBodyLength: fixture.maxBodyLength }),
      },
    ],
    headerList,
    strict: true,
    ...(fixture.signTime === undefined ? {} : { signTime: fixture.signTime }),
    ...(fixture.expires === undefined ? {} : { expires: fixture.expires }),
  };
  const result = await dkimSign(source, options as Parameters<typeof dkimSign>[1]);
  if (result.errors.length !== 0 || result.signatures === '')
    throw new Error('The disposable message fixture could not be signed.');
  return Buffer.concat([Buffer.from(result.signatures), source]);
}
