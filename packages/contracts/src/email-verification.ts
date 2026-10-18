import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { emailVerification } from './email-verification-status.js';

export const emailAddressInput = z.strictObject({
  contactId: publicId('contact'),
  addressId: publicId('contact_identity'),
});
export const blockEmailAddressInput = emailAddressInput.extend({
  reason: z.string().trim().max(200).optional(),
});
export const unblockEmailAddressInput = emailAddressInput.extend({
  confirm: z.literal('unblock').optional(),
});
export const emailVerificationSettings = z.strictObject({
  enabled: z.boolean(),
  reverifyAfter90Days: z.boolean(),
  dailyLimit: z.int().min(0).max(100000),
  provider: z.enum(['connected', 'failing', 'disconnected']).nullable(),
  availableCredits: z.int().min(0).nullable(),
  testMode: z.boolean().nullable(),
});
export type EmailVerificationSettings = z.output<typeof emailVerificationSettings>;
export const updateEmailVerificationSettingsInput = z
  .strictObject({
    enabled: z.boolean().optional(),
    reverifyAfter90Days: z.boolean().optional(),
    dailyLimit: z.int().min(0).max(100000).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'Choose a setting to change.');
export const connectEmailVerificationProviderInput = z.strictObject({
  apiKey: z.string().trim().min(1).max(1024),
});
export const emailVerificationReceipt = emailVerification.extend({ pending: z.boolean() });
const group = 'Email';
const settingsResponse = {
  status: 200,
  description: 'Email verification settings and connection state.',
  schema: emailVerificationSettings,
} as const;
export const getEmailVerificationSettings = defineEndpoint({
  operationId: 'getEmailVerificationSettings',
  method: 'get',
  path: '/email-verification/settings',
  summary: 'Read email verification settings',
  group,
  response: settingsResponse,
});
export const updateEmailVerificationSettings = defineEndpoint({
  operationId: 'updateEmailVerificationSettings',
  method: 'put',
  path: '/email-verification/settings',
  summary: 'Update email verification settings',
  group,
  body: updateEmailVerificationSettingsInput,
  response: settingsResponse,
});
export const connectEmailVerificationProvider = defineEndpoint({
  operationId: 'connectEmailVerificationProvider',
  method: 'put',
  path: '/email-verification/provider',
  summary: 'Connect the verification provider',
  group,
  body: connectEmailVerificationProviderInput,
  response: settingsResponse,
});
export const disconnectEmailVerificationProvider = defineEndpoint({
  operationId: 'disconnectEmailVerificationProvider',
  method: 'delete',
  path: '/email-verification/provider',
  summary: 'Disconnect the verification provider',
  group,
  response: settingsResponse,
});
export const testEmailVerificationProvider = defineEndpoint({
  operationId: 'testEmailVerificationProvider',
  method: 'post',
  path: '/email-verification/provider/test',
  summary: 'Test the verification provider',
  group,
  response: settingsResponse,
});
export const verifyEmailAddress = defineEndpoint({
  operationId: 'verifyEmailAddress',
  method: 'post',
  path: '/email-verification/verify',
  summary: 'Verify a contact email address',
  group,
  body: emailAddressInput,
  response: {
    status: 200,
    description: 'Current result and queued check.',
    schema: emailVerificationReceipt,
  },
});
export const excludeEmailAddress = defineEndpoint({
  operationId: 'excludeEmailAddress',
  method: 'post',
  path: '/email-verification/exclude',
  summary: 'Exclude an email address from verification',
  group,
  body: emailAddressInput,
  response: { status: 200, description: 'Verification state.', schema: emailVerificationReceipt },
});
export const includeEmailAddress = defineEndpoint({
  operationId: 'includeEmailAddress',
  method: 'post',
  path: '/email-verification/include',
  summary: 'Include an email address in verification',
  group,
  body: emailAddressInput,
  response: { status: 200, description: 'Verification state.', schema: emailVerificationReceipt },
});
export const blockEmailAddress = defineEndpoint({
  operationId: 'blockEmailAddress',
  method: 'post',
  path: '/email-verification/block',
  summary: 'Block a contact email address',
  group,
  body: blockEmailAddressInput,
  response: {
    status: 200,
    description: 'Verification state. Delivery is read on contact details.',
    schema: emailVerificationReceipt,
  },
});
export const unblockEmailAddress = defineEndpoint({
  operationId: 'unblockEmailAddress',
  method: 'post',
  path: '/email-verification/unblock',
  summary: 'Unblock a contact email address',
  group,
  body: unblockEmailAddressInput,
  response: {
    status: 200,
    description: 'Verification state. Consent blocks cannot be lifted here.',
    schema: emailVerificationReceipt,
  },
});
export const emailVerificationEndpoints = [
  getEmailVerificationSettings,
  updateEmailVerificationSettings,
  connectEmailVerificationProvider,
  disconnectEmailVerificationProvider,
  testEmailVerificationProvider,
  verifyEmailAddress,
  excludeEmailAddress,
  includeEmailAddress,
  blockEmailAddress,
  unblockEmailAddress,
] as const;
