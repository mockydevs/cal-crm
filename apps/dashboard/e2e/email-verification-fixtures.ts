// A business's email verification as the API holds it, for the component tests and the
// browser spec of the contact's email rows and Settings → Email Services → Email
// Verification. Every write and every answer is parsed by the contract's own schema; the
// refusals are the server's (its codes, paths and words).
// Nothing here imports the dashboard's code, so a test never checks the page against itself.
import {
  blockEmailAddressInput,
  connectEmailVerificationProviderInput,
  contactAddress,
  contactEmailCheckPreview,
  emailAddressInput,
  emailVerificationReceipt,
  emailVerificationSettings,
  unblockEmailAddressInput,
  updateEmailVerificationSettingsInput,
  type ContactAddress,
  type ContactEmailCheckPreview,
  type EmailVerification,
  type EmailVerificationSettings,
  type Permission,
} from '@repo/contracts';

export const verifiedAt = '2026-10-17T09:00:00.000Z';
export const verifiedContactId = 'con_01k8e2wzr0e008000000000301';
export const emailAddressId = (number: number): string =>
  `cid_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;

/** The key the fake provider accepts; any other is refused as the server refuses it. */
export const workingKey = 'test_working_key_for_fixtures';

export type Delivery = NonNullable<ContactAddress['delivery']>;

export interface VerifiedAddress {
  readonly id: string;
  readonly value: string;
  verification: EmailVerification;
  delivery: Delivery;
}

export interface VerificationWorld {
  settings: EmailVerificationSettings;
  addresses: VerifiedAddress[];
  /** What the signed-in person may do, as GET /me/permissions answers. */
  permissions: Permission[];
  /** Each write, as sent: the operation and its body. */
  writes: { readonly operationId: string; readonly body: unknown }[];
  /** Whether the next verify answers that a check is still to come. */
  pending: boolean;
}

export const unchecked = (rest: Partial<EmailVerification> = {}): EmailVerification => ({
  status: 'unchecked',
  depth: null,
  reasons: [],
  checkedAt: null,
  excluded: false,
  expiresAt: null,
  ...rest,
});

export const checked = (
  status: EmailVerification['status'],
  rest: Partial<EmailVerification> = {},
): EmailVerification =>
  unchecked({
    status,
    depth: 'mailbox',
    checkedAt: verifiedAt,
    expiresAt: '2027-01-15T09:00:00.000Z',
    ...rest,
  });

export const open: Delivery = { status: 'unchecked', reason: null, since: null };
export const blockedFor = (reason: NonNullable<Delivery['reason']>): Delivery => ({
  status: 'blocked',
  reason,
  since: verifiedAt,
});

export function addressOf(
  number: number,
  value: string,
  verification: EmailVerification = unchecked(),
  delivery: Delivery = open,
): VerifiedAddress {
  return { id: emailAddressId(number), value, verification, delivery };
}

export function verificationWorldOf(
  rest: Partial<Omit<VerificationWorld, 'settings'>> & {
    settings?: Partial<EmailVerificationSettings>;
  } = {},
): VerificationWorld {
  return {
    addresses: rest.addresses ?? [addressOf(1, 'maya@example.com')],
    permissions: rest.permissions ?? ['contacts.manage', 'email.verification.manage'],
    writes: [],
    pending: rest.pending ?? true,
    settings: {
      enabled: true,
      reverifyAfter90Days: true,
      dailyLimit: 1000,
      provider: null,
      availableCredits: null,
      testMode: null,
      ...rest.settings,
    },
  };
}

/** The contact's email rows as the contact details answer them. */
export function contactAddressesIn(world: VerificationWorld): ContactAddress[] {
  return world.addresses.map((address, index) =>
    contactAddress.parse({
      id: address.id,
      kind: 'email',
      value: address.value,
      display: address.value,
      label: null,
      primary: index === 0,
      verification: address.verification,
      delivery: address.delivery,
    }),
  );
}

/** A refusal as the server words it: its status, and the issue it names, if any. */
export interface Refusal {
  readonly refusal: true;
  readonly status: number;
  readonly detail: string;
  readonly errors?: { path: string; code: string; message: string }[];
}
export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'refusal' in value;
const invalid = (code: string, message: string, path = '/addressId'): Refusal => ({
  refusal: true,
  status: 422,
  detail: message,
  errors: [{ path, code, message }],
});

function addressIn(world: VerificationWorld, body: unknown): VerifiedAddress | Refusal {
  const { contactId, addressId } = (body ?? {}) as Record<string, unknown>;
  const input = emailAddressInput.parse({ contactId, addressId });
  const found = world.addresses.find((each) => each.id === input.addressId);
  return found ?? { refusal: true, status: 404, detail: 'No such email address.' };
}

/** What an address command answers: the address's verification, and whether a check is to come. */
export type Receipt = EmailVerification & { readonly pending: boolean };

const receipt = (address: VerifiedAddress, pending = false): Receipt =>
  emailVerificationReceipt.parse({ ...address.verification, pending });

function wrote(world: VerificationWorld, operationId: string, body: unknown): void {
  world.writes.push({ operationId, body });
}

export function verifyIn(world: VerificationWorld, body: unknown): Receipt | Refusal {
  wrote(world, 'verifyEmailAddress', emailAddressInput.parse(body));
  const address = addressIn(world, body);
  if (isRefusal(address)) return address;
  if (address.verification.excluded)
    return invalid('excluded', 'Include this address in verification first.');
  return receipt(address, world.pending);
}

export function excludeIn(
  world: VerificationWorld,
  body: unknown,
  excluded: boolean,
): Receipt | Refusal {
  wrote(
    world,
    excluded ? 'excludeEmailAddress' : 'includeEmailAddress',
    emailAddressInput.parse(body),
  );
  const address = addressIn(world, body);
  if (isRefusal(address)) return address;
  address.verification = { ...address.verification, excluded };
  return receipt(address);
}

export function blockIn(world: VerificationWorld, body: unknown): Receipt | Refusal {
  wrote(world, 'blockEmailAddress', blockEmailAddressInput.parse(body));
  const address = addressIn(world, body);
  if (isRefusal(address)) return address;
  if (address.delivery.status !== 'blocked') address.delivery = blockedFor('manual');
  return receipt(address);
}

export function unblockIn(world: VerificationWorld, body: unknown): Receipt | Refusal {
  const input = unblockEmailAddressInput.parse(body);
  wrote(world, 'unblockEmailAddress', input);
  const address = addressIn(world, body);
  if (isRefusal(address)) return address;
  const reason = address.delivery.reason;
  if (reason === 'complaint' || reason === 'unsubscribe')
    return invalid('consent_required', 'Record fresh consent instead of unblocking an opt-out.');
  if (reason === 'hard_bounce') {
    if (!world.permissions.includes('email.verification.manage'))
      return {
        refusal: true,
        status: 403,
        detail: 'Managing email verification is required to unblock a hard bounce.',
      } satisfies Refusal;
    if (input.confirm !== 'unblock')
      return invalid('confirmation_required', 'Type unblock to confirm.');
  }
  address.delivery = open;
  return receipt(address);
}

const settingsRefusal = (world: VerificationWorld): Refusal | undefined =>
  world.permissions.includes('email.verification.manage')
    ? undefined
    : {
        refusal: true,
        status: 403,
        detail: "Your role doesn't allow this: it needs email.verification.manage.",
      };

export function settingsIn(world: VerificationWorld): EmailVerificationSettings | Refusal {
  return settingsRefusal(world) ?? emailVerificationSettings.parse(world.settings);
}

export function updateSettingsIn(
  world: VerificationWorld,
  body: unknown,
): EmailVerificationSettings | Refusal {
  const input = updateEmailVerificationSettingsInput.parse(body);
  wrote(world, 'updateEmailVerificationSettings', input);
  const refused = settingsRefusal(world);
  if (refused !== undefined) return refused;
  world.settings = {
    ...world.settings,
    enabled: input.enabled ?? world.settings.enabled,
    reverifyAfter90Days: input.reverifyAfter90Days ?? world.settings.reverifyAfter90Days,
    dailyLimit: input.dailyLimit ?? world.settings.dailyLimit,
  };
  return emailVerificationSettings.parse(world.settings);
}

export function connectIn(
  world: VerificationWorld,
  body: unknown,
): EmailVerificationSettings | Refusal {
  const input = connectEmailVerificationProviderInput.parse(body);
  // The key itself is never kept, here as on the server.
  wrote(world, 'connectEmailVerificationProvider', { apiKey: '[sent]' });
  const refused = settingsRefusal(world);
  if (refused !== undefined) return refused;
  if (input.apiKey !== workingKey)
    return invalid(
      'connection_failed',
      'The verification provider could not confirm this key.',
      '/apiKey',
    );
  world.settings = {
    ...world.settings,
    provider: 'connected',
    availableCredits: 4800,
    testMode: true,
  };
  return emailVerificationSettings.parse(world.settings);
}

export function disconnectIn(world: VerificationWorld): EmailVerificationSettings | Refusal {
  wrote(world, 'disconnectEmailVerificationProvider', null);
  const refused = settingsRefusal(world);
  if (refused !== undefined) return refused;
  world.settings = {
    ...world.settings,
    provider: 'disconnected',
    availableCredits: null,
    testMode: null,
  };
  return emailVerificationSettings.parse(world.settings);
}

export function testIn(world: VerificationWorld): EmailVerificationSettings | Refusal {
  wrote(world, 'testEmailVerificationProvider', null);
  return settingsRefusal(world) ?? emailVerificationSettings.parse(world.settings);
}

/**
 * What verifying a selection's email addresses would do, as the bulk preview answers it:
 * 120 contacts, 8 without an email, 2 excluded, 30 current, 70 to check (60 by the
 * provider) and 10 over today's limit, with 60 provider checks left today.
 */
export function emailCheckPreviewOf(
  rest: Partial<ContactEmailCheckPreview> = {},
): ContactEmailCheckPreview {
  return contactEmailCheckPreview.parse({
    contacts: 120,
    noEmail: 8,
    excluded: 2,
    current: 30,
    checks: 70,
    providerCalls: 60,
    overLimit: 10,
    remainingToday: 60,
    provider: 'connected',
    enabled: true,
    ...rest,
  });
}
