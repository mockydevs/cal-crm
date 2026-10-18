import { expect, it } from 'vitest';
import { toPublicId } from '@repo/kernel';
import {
  emailAddressInput,
  updateEmailVerificationSettingsInput,
  connectEmailVerificationProviderInput,
} from './email-verification.js';
import { emailVerification } from './email-verification-status.js';

it('bounds verification settings and refuses a block-risky switch', () => {
  expect(updateEmailVerificationSettingsInput.safeParse({ dailyLimit: 100001 }).success).toBe(
    false,
  );
  expect(updateEmailVerificationSettingsInput.safeParse({ blockRisky: true }).success).toBe(false);
  expect(updateEmailVerificationSettingsInput.parse({ enabled: true, dailyLimit: 0 })).toEqual({
    enabled: true,
    dailyLimit: 0,
  });
});

it('takes contact and identity ids, never a raw address', () => {
  expect(
    emailAddressInput.safeParse({
      contactId: 'person@example.com',
      addressId: 'person@example.com',
    }).success,
  ).toBe(false);
  expect(
    emailAddressInput.parse({
      contactId: toPublicId('contact', '00000000-0000-7000-8000-000000000001'),
      addressId: toPublicId('contact_identity', '00000000-0000-7000-8000-000000000002'),
    }),
  ).toHaveProperty('addressId');
});

it('separates mailbox verification from domain checks and bounds provider keys', () => {
  expect(
    emailVerification.parse({
      status: 'unchecked',
      depth: null,
      reasons: [],
      checkedAt: null,
      expiresAt: null,
      excluded: false,
    }),
  ).toHaveProperty('depth', null);
  expect(connectEmailVerificationProviderInput.safeParse({ apiKey: '' }).success).toBe(false);
  expect(
    connectEmailVerificationProviderInput.safeParse({ apiKey: 'a'.repeat(1025) }).success,
  ).toBe(false);
});
