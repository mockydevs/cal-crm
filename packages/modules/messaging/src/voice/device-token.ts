// https://www.twilio.com/docs/iam/access-tokens ; installed twilio@6.1.2 AccessToken.js.
// Standard JWT HS256 using Node crypto; no new runtime dependency. The official SDK
// remains the test oracle for the provider's header and grant structure.
import { createHmac, randomUUID } from 'node:crypto';
import * as z from 'zod';

const configuration = z
  .strictObject({
    accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
    keySid: z.string().regex(/^SK[0-9a-fA-F]{32}$/),
    keySecret: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^\p{Cc}\s]+$/u),
    // Twilio does not support access tokens signed with Restricted API keys.
    // The worker must obtain this verified metadata before calling the minter.
    keyType: z.enum(['standard', 'main']),
    applicationSid: z
      .string()
      .regex(/^AP[0-9a-fA-F]{32}$/)
      .optional(),
    identity: z.string().regex(/^[A-Za-z0-9_]{1,121}$/),
    incomingAllowed: z.boolean(),
    // Our product lifetime ceiling is deliberately shorter than the provider's.
    ttlSeconds: z.number().int().min(60).max(3600).default(300),
  })
  .refine((value) => value.incomingAllowed || value.applicationSid !== undefined);
export type VoiceDeviceTokenConfiguration = z.input<typeof configuration>;

/**
 * Worker-only primitive. The caller must recheck the person's current business,
 * calling permission and provider setup; identity is server-derived, never user input.
 * Minting a JWT alone proves neither provider entitlement nor device registration.
 */
export function mintVoiceDeviceToken(input: unknown): {
  readonly token: string;
  readonly expiresAt: string;
} {
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new Error('Voice device configuration is invalid.');
  const value = parsed.data;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + value.ttlSeconds;
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    // Provider docs allow an application-chosen unique ID; avoid same-second reuse.
    jti: `${value.keySid}-${randomUUID()}`,
    iss: value.keySid,
    sub: value.accountSid,
    iat: issuedAt,
    exp: expiresAt,
    grants: {
      identity: value.identity,
      voice: {
        ...(value.incomingAllowed ? { incoming: { allow: true } } : {}),
        ...(value.applicationSid === undefined
          ? {}
          : { outgoing: { application_sid: value.applicationSid } }),
      },
    },
  };
  const unsigned = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}`;
  const signature = createHmac('sha256', value.keySecret).update(unsigned).digest('base64url');
  return { token: `${unsigned}.${signature}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
}
