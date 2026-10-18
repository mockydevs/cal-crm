import * as z from 'zod';
import { timestamp } from './timestamps.js';

/**
 * What the checks found about an email address, as a contact's details show it. Kept apart
 * from the verification endpoints so pages that read contacts carry only this schema.
 */
export const emailVerification = z.strictObject({
  status: z.enum(['unchecked', 'valid', 'risky', 'invalid', 'unknown']),
  depth: z.enum(['domain', 'mailbox']).nullable(),
  reasons: z.array(z.string().max(80)).max(18),
  checkedAt: timestamp.nullable(),
  excluded: z.boolean(),
  expiresAt: timestamp.nullable(),
});
export type EmailVerification = z.output<typeof emailVerification>;

export {
  contactEmailVerifications,
  type ContactEmailVerification,
} from './contact-email-verifications.js';
