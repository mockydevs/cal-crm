// Signing in, through Better Auth's endpoints at /api/auth. The server serves them on the
// same site, so the session cookie goes with every request.
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { queryOptions } from '@tanstack/react-query';
import * as z from 'zod';

const BASE = '/api/auth';

const session = z
  .looseObject({
    user: z.looseObject({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      twoFactorEnabled: z.boolean().nullish(),
    }),
  })
  .nullable();

export type Session = NonNullable<z.infer<typeof session>>;

/** A request to the sign-in endpoints that failed: its status, and Better Auth's code. */
export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`Signing in failed with ${String(status)}${code === undefined ? '' : ` (${code})`}.`);
  }
}

const errorCode = z.looseObject({ code: z.string() });

async function call(path: string, body?: object): Promise<unknown> {
  const response = await fetch(
    `${BASE}${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorCode.safeParse(data);
    throw new AuthError(response.status, parsed.success ? parsed.data.code : undefined);
  }
  return data;
}

/**
 * Who's signed in, or null. Asking also renews the session when it's a day old, and this
 * answer is the one that carries the renewed cookie.
 */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async () => session.parse(await call('/get-session')),
  staleTime: 60_000,
});

const security = z.looseObject({ twoFactorRequired: z.boolean(), hasPassword: z.boolean() });

/**
 * What signing in asks of the person signed in: whether their agency requires two-factor
 * sign-in, and whether they have a password, which changing their factors asks for.
 */
export const securityQuery = queryOptions({
  queryKey: ['session', 'security'],
  queryFn: async () => security.parse(await call('/security')),
  staleTime: 60_000,
});

/** A body with the password, when the person has one to confirm a change with. */
const confirmedBy = (password: string | undefined): object =>
  password === undefined ? {} : { password };

const passwordSignIn = z.looseObject({ twoFactorRedirect: z.boolean().optional() });

/** Signs in with a password. When the person also uses an app, a code is needed next. */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<{ codeNeeded: boolean }> {
  const answer = passwordSignIn.parse(await call('/sign-in/email', { email, password }));
  return { codeNeeded: answer.twoFactorRedirect === true };
}

/**
 * Emails a link that signs in once and goes on to next, a path on this site. A used or
 * expired one comes back to /sign-in, which Better Auth gives an error to show.
 */
export const sendSignInLink = (email: string, next: string): Promise<unknown> =>
  call('/sign-in/magic-link', {
    email,
    callbackURL: next,
    errorCallbackURL:
      next === '/' ? '/sign-in' : `/sign-in?${new URLSearchParams({ next }).toString()}`,
  });

/** Emails a link to /reset-password, which carries the token, or an error when it's spent. */
export const sendPasswordReset = (email: string): Promise<unknown> =>
  call('/request-password-reset', { email, redirectTo: '/reset-password' });

export const resetPassword = (token: string, newPassword: string): Promise<unknown> =>
  call('/reset-password', { token, newPassword });

export const signOut = (): Promise<unknown> => call('/sign-out', {});

/**
 * Checks a code from the person's authenticator app: to finish signing in, or to turn
 * two-factor sign-in on once it's set up.
 */
export const verifyCode = (code: string): Promise<unknown> =>
  call('/two-factor/verify-totp', { code: code.replace(/\s/g, '') });

/** Finishes signing in with a recovery code instead, which then stops working. */
export const verifyRecoveryCode = (code: string): Promise<unknown> =>
  call('/two-factor/verify-backup-code', { code: code.trim() });

const setUp = z.looseObject({ totpURI: z.string(), backupCodes: z.array(z.string()) });

export type TwoFactorSetUp = z.infer<typeof setUp>;

/**
 * Starts setting up an authenticator app: the link its QR code shows, and the recovery
 * codes. Two-factor sign-in turns on once verifyCode checks the app's first code.
 */
export const startTwoFactor = async (password?: string): Promise<TwoFactorSetUp> =>
  setUp.parse(await call('/two-factor/enable', confirmedBy(password)));

export const turnOffTwoFactor = (password?: string): Promise<unknown> =>
  call('/two-factor/disable', confirmedBy(password));

const recoveryCodes = z.looseObject({ backupCodes: z.array(z.string()) });

/** New recovery codes, which replace the old ones. */
export const newRecoveryCodes = async (password?: string): Promise<string[]> =>
  recoveryCodes.parse(await call('/two-factor/generate-backup-codes', confirmedBy(password)))
    .backupCodes;

const passkeys = z.array(
  z.looseObject({
    id: z.string(),
    name: z.string().nullish(),
    createdAt: z.coerce
      .date()
      .nullish()
      .transform((value) => value ?? undefined),
  }),
);

export type SavedPasskey = z.infer<typeof passkeys>[number];

export const passkeysQuery = queryOptions({
  queryKey: ['session', 'passkeys'],
  queryFn: async () => passkeys.parse(await call('/passkey/list-user-passkeys')),
});

// The server's options, which the browser's WebAuthn checks in full.
const creationOptions = z.custom<PublicKeyCredentialCreationOptionsJSON>(
  (value) => typeof value === 'object' && value !== null && 'challenge' in value,
);
const requestOptions = z.custom<PublicKeyCredentialRequestOptionsJSON>(
  (value) => typeof value === 'object' && value !== null && 'challenge' in value,
);

/** Makes a passkey on this device, or a security key, for the person signed in. */
export async function addPasskey(name: string): Promise<void> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const optionsJSON = creationOptions.parse(await call('/passkey/generate-register-options'));
  const response = await startRegistration({ optionsJSON });
  await call('/passkey/verify-registration', { response, ...(name === '' ? {} : { name }) });
}

export const removePasskey = (id: string): Promise<unknown> =>
  call('/passkey/delete-passkey', { id });

/** Signs in with a passkey: the device asks which one, and for a PIN or fingerprint. */
export async function signInWithPasskey(): Promise<void> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const optionsJSON = requestOptions.parse(await call('/passkey/generate-authenticate-options'));
  const response = await startAuthentication({ optionsJSON });
  await call('/passkey/verify-authentication', { response });
}

const setupLink = z.looseObject({ valid: z.boolean() });

/** Whether a first-admin setup link still works. */
export const checkSetupLink = async (token: string): Promise<boolean> =>
  setupLink.parse(await call(`/setup?${new URLSearchParams({ token }).toString()}`)).valid;

/** Creates the first admin from a setup link, and signs them in. */
export const setUpFirstAdmin = (details: {
  token: string;
  name: string;
  email: string;
  password: string;
}): Promise<unknown> => call('/setup', details);

const invitationLink = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(false) }),
  z.object({ valid: z.literal(true), email: z.string(), existingAccount: z.boolean() }),
]);

export async function checkInvitation(token: string): Promise<z.infer<typeof invitationLink>> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { valid: false } as const;
  return invitationLink.parse(
    await call(`/invitations/check?${new URLSearchParams({ token }).toString()}`),
  );
}

export const acceptInvitation = (details: {
  token: string;
  email: string;
  name?: string;
  password?: string;
}): Promise<unknown> => call('/invitations/accept', details);
