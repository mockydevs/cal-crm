// Signing in: Better Auth on our own tables in the auth schema. This module is
// the only code that uses crm_auth, which finds people before any tenant context exists.
import { runWithTransaction } from '@better-auth/core/context';
import { passkey } from '@better-auth/passkey';
import { permissionsOf, type Permission, type RoleGrant } from '@repo/contracts';
import { connectDatabase, explainUniqueViolation } from '@repo/db';
import { ValidationError } from '@repo/kernel';
import { betterAuth } from 'better-auth';
import { getSessionCookie } from 'better-auth/cookies';
import { magicLink } from 'better-auth/plugins/magic-link';
import { twoFactor } from 'better-auth/plugins/two-factor';

import { invitationEmail, passwordResetEmail, signInLinkEmail, type Email } from './emails.js';
import { requireUserVerified, signInRules } from './factors.js';
import { firstAdmin, firstAdminLink, type FirstStart } from './first-admin.js';
import { findApiKey, type ApiKeyAccess, type ApiKeyTarget } from './api-keys.js';
import {
  exchangeOAuthToken,
  findAppToken,
  revokeOAuthToken,
  type OAuthRevokeOutcome,
  type OAuthRevokeRequest,
  type OAuthTokenOutcome,
  type OAuthTokenRequest,
} from './app-tokens.js';
import { invitations } from './invitations.js';

/** Where Better Auth's endpoints are served, beside the API's /api/v1. */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * The header carrying the client's IP, as the server worked it out (TRUST_PROXY). The
 * server sets it on every request it passes on, replacing any the client sent; Better
 * Auth's rate limits read nothing else.
 */
export const CLIENT_IP_HEADER = 'x-crm-client-ip';

/** Better Auth's own bounds (emailAndPassword.minPasswordLength and maxPasswordLength). */
const PASSWORD_LENGTH = { min: 8, max: 128 };

/** Our cookies' names start with it, such as crm.session_token. */
const COOKIE_PREFIX = 'crm';

/** How long an emailed link works, once. */
const MAGIC_LINK_MINUTES = 15;
const PASSWORD_RESET_MINUTES = 60;

export interface AuthenticationOptions {
  /** crm_auth's connection string. */
  readonly connectionString: string;
  /** Signs session cookies and tokens: 32 characters or more. */
  readonly secret: string;
  /**
   * The address people use, such as https://crm.example.com. Session cookies are Secure
   * when it's HTTPS, and only pages from it may post to the endpoints.
   */
  readonly publicUrl: string;
  /**
   * Whether attempts are counted and limited: on unless the server was started with
   * DEV_SIGN_IN_LIMIT=off, which its configuration refuses in production.
   */
  readonly signInLimit?: boolean;
  /** Called for each connection that fails, so it can be logged. */
  readonly onConnectionError: (error: Error) => void;
  /** Where Better Auth's own messages go, such as a refused origin: the server's log. */
  readonly log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    ...details: unknown[]
  ) => void;
  /** Sends the install's own mail: magic links and password resets (@repo/mail). */
  readonly sendMail: (email: Email) => Promise<void>;
}

/** Who a request is signed in as, and where they work. */
export interface SignedIn {
  readonly userId: string;
  readonly sessionId: string;
  /** The agency of the person's memberships; undefined until they have one. */
  readonly agencyId: string | undefined;
  /** The businesses they're members of themselves, not through the agency. */
  readonly memberOf: readonly string[];
  /**
   * Whether they're agency staff: a membership of the agency itself, not of one of its
   * businesses. Only agency staff may act without a business, which sees every business
   * in the agency.
   */
  readonly agencyStaff: boolean;
  /**
   * The role of each membership: the agency's, for its staff, and each business's
   * by its id.
   */
  readonly roles: {
    readonly agency: RoleGrant | undefined;
    readonly businesses: ReadonlyMap<string, RoleGrant>;
  };
  /** Whether they also sign in with a code from an authenticator app. */
  readonly twoFactorEnabled: boolean;
  /**
   * Whether their agency requires that of them: it requires it of its staff. Until they've
   * set it up, the API answers them with nothing else.
   */
  readonly twoFactorRequired: boolean;
}

/**
 * Where a request works: at the agency, in one business, or nowhere, with the
 * status and words to refuse it with. Working somewhere comes with what the person's role
 * there allows.
 */
export type Workplace =
  | { readonly at: 'agency'; readonly permissions: ReadonlySet<Permission> }
  | {
      readonly at: 'business';
      readonly businessId: string;
      readonly permissions: ReadonlySet<Permission>;
    }
  | {
      readonly at: 'refused';
      readonly status: 403 | 404;
      /** Why, for code: choose_business is the only one a person can fix by choosing. */
      readonly code: 'no_agency' | 'choose_business' | 'not_found' | 'not_a_member' | 'unavailable';
      readonly message: string;
    };

export type BusinessStatus = 'active' | 'suspended' | 'archived';

/** Who someone is, and where they may work: what GET /api/v1/me answers. */
export interface Profile {
  readonly name: string;
  readonly email: string;
  readonly agency: { readonly name: string; readonly slug: string };
  readonly agencyStaff: boolean;
  /** By name: all of the agency's for agency staff, and the active ones they belong to otherwise. */
  readonly businesses: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: BusinessStatus;
    /** From the business profile's address, for the line under its name; null when blank. */
    readonly city: string | null;
    readonly region: string | null;
    /** The business's own zone, which its calendar is drawn in. */
    readonly timezone: string;
  }[];
}

export interface Authentication {
  /** Sends an already-committed invitation. A failure leaves it pending for resend. */
  sendInvitation(email: string, token: string): Promise<boolean>;
  /** Answers a request to Better Auth's endpoints, under AUTH_BASE_PATH. */
  handle(request: Request): Promise<Response>;
  /** The person a request's session cookie signs in, or undefined. */
  signedIn(headers: Headers): Promise<SignedIn | undefined>;
  /**
   * What a request signed with an API key may do, or undefined for a key that
   * doesn't work. Read every time, so a revoked key fails on its next request.
   */
  apiKey(key: string, target?: ApiKeyTarget): Promise<ApiKeyAccess | undefined>;
  /**
   * What a request signed with an installed app's access token may do: its app
   * key's access in the install's business, or undefined for a token that doesn't work.
   */
  appToken(token: string, target?: ApiKeyTarget): Promise<ApiKeyAccess | undefined>;
  /** The OAuth token endpoint's work: a code or a refresh token for a new pair. */
  oauthToken(request: OAuthTokenRequest): Promise<OAuthTokenOutcome>;
  /** The OAuth revocation endpoint's work (RFC 7009). */
  oauthRevoke(request: OAuthRevokeRequest): Promise<OAuthRevokeOutcome>;
  /**
   * Where the person may work for one request: the business it names, or with
   * none, the agency for agency staff and the only business of a business user. A business
   * user is never put at the agency, which shows every business.
   */
  workplace(person: SignedIn, businessId: string | undefined): Promise<Workplace>;
  /** Who the person is, their agency, and the businesses they may enter. */
  whoIs(person: SignedIn): Promise<Profile>;
  /**
   * Creates someone who signs in with an email and password: the first admin
   * and invited people. Nobody signs themselves up.
   *
   * emailVerified says whether they've proven the address, as by following an invitation's
   * link. Until they have, Better Auth treats what was set up for them as unproven: their
   * first magic link removes their password and sessions, then marks the address verified.
   */
  createUser(user: {
    email: string;
    name: string;
    password: string;
    emailVerified: boolean;
  }): Promise<{ id: string }>;
  /**
   * What to do about the first admin as the app starts: while nobody runs
   * the agency, a new one-time setup link to print, valid for 24 hours.
   */
  firstAdminLink(): Promise<FirstStart>;
  /** Settles once the mail being sent has gone, or failed. */
  idle(): Promise<void>;
  /** Waits for the mail being sent, then closes the crm_auth connections. */
  close(): Promise<void>;
}

function refuse(
  status: 403 | 404,
  code: Extract<Workplace, { at: 'refused' }>['code'],
  message: string,
): Workplace {
  return { at: 'refused', status, code, message };
}

const statuses: readonly BusinessStatus[] = ['active', 'suspended', 'archived'];

/** A business's status, which the database's check limits to these. */
function statusOf(value: string): BusinessStatus {
  const status = statuses.find((each) => each === value);
  if (status === undefined) throw new Error(`Unknown business status: ${value}`);
  return status;
}

/**
 * One line of a business's stored address (tenancy.businesses.address, which the business
 * profile writes), or null when there is no address or the line is blank.
 */
function addressPart(address: unknown, part: 'city' | 'region'): string | null {
  if (typeof address !== 'object' || address === null) return null;
  const value: unknown = (address as Readonly<Record<string, unknown>>)[part];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** An error's name and codes, such as nodemailer's EAUTH and 535, but never its message. */
function failureKind(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return { name: typeof error };
  return {
    name: error instanceof Error ? error.name : 'unknown',
    ...('code' in error ? { code: error.code } : {}),
    ...('responseCode' in error ? { responseCode: error.responseCode } : {}),
  };
}

export function createAuthentication(options: AuthenticationOptions): Authentication {
  const db = connectDatabase({
    connectionString: options.connectionString,
    onConnectionError: options.onConnectionError,
    // Better Auth does arithmetic on rate_limits.last_request, a bigint.
    bigintAsNumber: true,
  });

  // Mail goes out after the answer, so how long the answer takes says nothing about whether
  // an address belongs to anyone.
  const sending = new Set<Promise<void>>();
  const inBackground = (work: () => Promise<void>): void => {
    const sent: Promise<void> = work()
      .catch((error: unknown) => {
        options.log('error', 'sending a sign-in email failed', error);
      })
      .finally(() => sending.delete(sent));
    sending.add(sent);
  };
  const idle = async (): Promise<void> => {
    while (sending.size > 0) await Promise.all(sending);
  };

  /** Whether this address belongs to someone who may sign in. */
  const canSignIn = async (address: string): Promise<boolean> =>
    (await db
      .selectFrom('auth.users')
      .select('id')
      .where('email', '=', address.trim().toLowerCase())
      .where('disabled_at', 'is', null)
      .executeTakeFirst()) !== undefined;

  /** The person's memberships, with whether each one's agency requires two factors. */
  const membershipsOf = (userId: string) =>
    db
      .selectFrom('tenancy.memberships as m')
      .innerJoin('tenancy.agencies as a', 'a.id', 'm.agency_id')
      .innerJoin('tenancy.roles as r', 'r.id', 'm.role_id')
      .select([
        'm.agency_id',
        'm.business_id',
        'a.two_factor_required',
        'r.scope',
        'r.key',
        'r.is_builtin',
        'r.permissions',
      ])
      .where('m.user_id', '=', userId)
      .execute();

  type Membership = Awaited<ReturnType<typeof membershipsOf>>[number];

  const roleOf = (membership: Membership): RoleGrant => ({
    scope: membership.scope === 'agency' ? 'agency' : 'business',
    key: membership.key,
    isBuiltin: membership.is_builtin,
    permissions: membership.permissions,
  });

  /** What a role allows where the person works; nothing without one. */
  const allowed = (role: RoleGrant | undefined, at: 'agency' | 'business') =>
    role === undefined ? new Set<Permission>() : permissionsOf(role, at);

  /** An agency's requirement covers its staff: members of the agency itself. */
  const requiresTwoFactor = (memberships: Awaited<ReturnType<typeof membershipsOf>>): boolean =>
    memberships.some((each) => each.business_id === null && each.two_factor_required);

  const hasPassword = async (userId: string): Promise<boolean> =>
    (await db
      .selectFrom('auth.accounts')
      .select('id')
      .where('user_id', '=', userId)
      .where('provider_id', '=', 'credential')
      .where('password', 'is not', null)
      .executeTakeFirst()) !== undefined;

  /** The agency's name, which the emails are from. An install serves one agency. */
  const agencyName = async (): Promise<string> =>
    (
      await db
        .selectFrom('tenancy.agencies')
        .select('name')
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst()
    )?.name ?? 'your CRM';

  const auth = betterAuth({
    appName: 'CRM',
    baseURL: options.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
    // Each table and column, as 0015_auth_sessions.sql names them.
    database: { db, type: 'postgres', schemaName: 'auth', transaction: true },
    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        image: 'image_url',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'accounts',
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
      // Links' tokens are kept only as hashes, so a copy of the table opens nothing.
      storeIdentifier: 'hashed',
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_MINUTES * 60,
      revokeSessionsOnPasswordReset: true,
      // The reset link came by email, so it proves the address as a sign-in link does.
      // Otherwise the person's first sign-in link would remove the password they just set.
      onPasswordReset: async ({ user }) => {
        if (user.emailVerified) return;
        const context = await auth.$context;
        await context.internalAdapter.updateUser(user.id, { emailVerified: true });
      },
      sendResetPassword: ({ user, url }) => {
        inBackground(async () => {
          if (!(await canSignIn(user.email))) return;
          await options.sendMail(
            passwordResetEmail(user.email, await agencyName(), url, PASSWORD_RESET_MINUTES),
          );
        });
        return Promise.resolve();
      },
    },
    plugins: [
      invitations(db, PASSWORD_LENGTH),
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        // A link signs in someone who's already here; it never makes an account.
        disableSignUp: true,
        sendMagicLink: ({ email: address, url }) => {
          // Better Auth sends to any address asked for; mail goes only to people who exist.
          inBackground(async () => {
            if (!(await canSignIn(address))) return;
            await options.sendMail(
              signInLinkEmail(address, await agencyName(), url, MAGIC_LINK_MINUTES),
            );
          });
        },
      }),
      twoFactor({
        // People who sign in only with emailed links have no password to confirm with.
        allowPasswordless: true,
        // Each 0017_two_factor_and_passkeys.sql column.
        schema: {
          user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
          twoFactor: {
            modelName: 'two_factors',
            fields: {
              userId: 'user_id',
              backupCodes: 'backup_codes',
              failedVerificationCount: 'failed_verification_count',
              lockedUntil: 'locked_until',
            },
          },
        },
      }),
      passkey({
        rpID: new URL(options.publicUrl).hostname,
        // Only the install's own pages, not whatever origin a request claims.
        origin: options.publicUrl,
        // Discoverable, so the sign-in page needs no email; and verified, so a passkey is
        // two factors on its own.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: {
          afterVerification: ({ verification }) => {
            requireUserVerified(
              verification.registrationInfo?.userVerified === true,
              'BAD_REQUEST',
            );
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            requireUserVerified(verification.authenticationInfo.userVerified, 'UNAUTHORIZED');
          },
        },
        schema: {
          passkey: {
            modelName: 'passkeys',
            fields: {
              publicKey: 'public_key',
              userId: 'user_id',
              credentialID: 'credential_id',
              deviceType: 'device_type',
              backedUp: 'backed_up',
              createdAt: 'created_at',
            },
          },
        },
      }),
      firstAdmin({ db, passwordLength: PASSWORD_LENGTH }),
      signInRules({
        publicUrl: options.publicUrl,
        agencyName,
        twoFactorRequired: async (userId) => requiresTwoFactor(await membershipsOf(userId)),
        hasPassword,
      }),
    ],
    rateLimit: {
      enabled: options.signInLimit ?? true,
      // In the database, so every app container counts the same attempts.
      storage: 'database',
      modelName: 'rate_limits',
      fields: { lastRequest: 'last_request' },
      customRules: { '/sign-in/email': { window: 15 * 60, max: 10 } },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // The tables' uuidv7() defaults make the ids.
      database: { generateId: false },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Better Auth skips this check under tests by default; ours test it.
      disableOriginCheck: false,
    },
    telemetry: { enabled: false },
    logger: { level: 'info', log: options.log },
  });

  const workplace = async (
    person: SignedIn,
    businessId: string | undefined,
  ): Promise<Workplace> => {
    const { agencyId } = person;
    if (agencyId === undefined)
      return refuse(403, 'no_agency', "You aren't a member of an agency yet.");
    if (businessId === undefined) {
      if (person.agencyStaff) {
        return { at: 'agency', permissions: allowed(person.roles.agency, 'agency') };
      }
      const [only] = person.memberOf;
      if (only === undefined || person.memberOf.length > 1) {
        return refuse(403, 'choose_business', 'Choose a business first.');
      }
      return workplace(person, only);
    }
    const business = await db
      .selectFrom('tenancy.businesses')
      .select(['id', 'status'])
      .where('id', '=', businessId)
      .where('agency_id', '=', agencyId)
      .executeTakeFirst();
    if (business === undefined) return refuse(404, 'not_found', "There's no such business.");
    if (!person.agencyStaff) {
      if (!person.memberOf.includes(business.id)) {
        return refuse(403, 'not_a_member', "You don't work in this business.");
      }
      if (business.status !== 'active')
        return refuse(403, 'unavailable', `This business is ${business.status}.`);
    }
    // Agency staff work in every business by their agency role.
    const role = person.agencyStaff
      ? person.roles.agency
      : person.roles.businesses.get(business.id);
    return { at: 'business', businessId: business.id, permissions: allowed(role, 'business') };
  };

  /** The businesses someone may enter: the agency's for its staff, their own active ones otherwise. */
  const enterable = async (person: SignedIn, agencyId: string) => {
    const all = db
      .selectFrom('tenancy.businesses')
      .select(['id', 'name', 'slug', 'status', 'address', 'timezone'])
      .where('agency_id', '=', agencyId);
    if (!person.agencyStaff && person.memberOf.length === 0) return [];
    const query = person.agencyStaff
      ? all
      : all.where('id', 'in', person.memberOf).where('status', '=', 'active');
    const rows = await query.orderBy('name').orderBy('id').execute();
    // The address itself stays in the profile: only its town and region are named here.
    return rows.map(({ address, ...each }) => ({
      ...each,
      status: statusOf(each.status),
      city: addressPart(address, 'city'),
      region: addressPart(address, 'region'),
    }));
  };

  const whoIs = async (person: SignedIn): Promise<Profile> => {
    const { agencyId } = person;
    if (agencyId === undefined) throw new Error(`${person.userId} isn't a member of an agency.`);
    const user = await db
      .selectFrom('auth.users')
      .select(['name', 'email'])
      .where('id', '=', person.userId)
      .executeTakeFirstOrThrow();
    const agency = await db
      .selectFrom('tenancy.agencies')
      .select(['name', 'slug'])
      .where('id', '=', agencyId)
      .executeTakeFirstOrThrow();
    return {
      name: user.name,
      email: user.email,
      agency,
      agencyStaff: person.agencyStaff,
      businesses: await enterable(person, agencyId),
    };
  };

  return {
    handle: (request) => auth.handler(request),

    apiKey: (key, target) => findApiKey(db, key, target),
    appToken: (token, target) => findAppToken(db, token, target),
    oauthToken: (request) => exchangeOAuthToken(db, request),
    oauthRevoke: (request) => revokeOAuthToken(db, request),

    async signedIn(headers) {
      // No session cookie, nobody to find: Better Auth would still take a connection.
      if (getSessionCookie(headers, { cookiePrefix: COOKIE_PREFIX }) === null) return undefined;
      // Read only: renewing would move the session's expiry in the database and set a cookie
      // nothing here can pass on. Better Auth's own get-session renews it, cookie and all.
      const found = await auth.api.getSession({ headers, query: { disableRefresh: true } });
      if (found === null) return undefined;
      const memberships = await membershipsOf(found.user.id);
      const agencies = new Set(memberships.map((each) => each.agency_id));
      const [agencyId] = agencies.size === 1 ? agencies : [];
      return {
        userId: found.user.id,
        sessionId: found.session.id,
        agencyId,
        memberOf: memberships.flatMap((each) =>
          each.business_id === null ? [] : [each.business_id],
        ),
        agencyStaff:
          agencyId !== undefined && memberships.some((each) => each.business_id === null),
        roles: {
          agency: memberships
            .filter((each) => each.business_id === null)
            .map(roleOf)
            .at(0),
          businesses: new Map(
            memberships.flatMap((each) =>
              each.business_id === null ? [] : [[each.business_id, roleOf(each)] as const],
            ),
          ),
        },
        twoFactorEnabled: found.user.twoFactorEnabled === true,
        twoFactorRequired: requiresTwoFactor(memberships),
      };
    },

    workplace,

    whoIs,

    async createUser({ email, name, password, emailVerified }) {
      if (password.length < PASSWORD_LENGTH.min || password.length > PASSWORD_LENGTH.max) {
        throw new ValidationError([
          {
            path: '/password',
            code: password.length < PASSWORD_LENGTH.min ? 'too_short' : 'too_long',
            message: `Use ${String(PASSWORD_LENGTH.min)} to ${String(PASSWORD_LENGTH.max)} characters.`,
          },
        ]);
      }
      const context = await auth.$context;
      const hash = await context.password.hash(password);
      // As Better Auth's own sign-up does it: the user and their password, or neither.
      return runWithTransaction(context.adapter, async () => {
        const user = await context.internalAdapter
          .createUser(
            { email: email.trim().toLowerCase(), name, emailVerified },
            { method: 'email-password' },
          )
          .catch(
            explainUniqueViolation({
              users_email_unique: () =>
                new ValidationError([
                  {
                    path: '/email',
                    code: 'taken',
                    message: 'Someone already uses this email address.',
                  },
                ]),
            }),
          );
        await context.internalAdapter.linkAccount({
          userId: user.id,
          providerId: 'credential',
          accountId: user.id,
          password: hash,
        });
        return { id: user.id };
      });
    },

    firstAdminLink: () => firstAdminLink(db, options.publicUrl),

    async sendInvitation(email, token) {
      try {
        const url = `${options.publicUrl}/accept-invitation?${new URLSearchParams({ token }).toString()}`;
        await options.sendMail(invitationEmail(email, await agencyName(), url));
        return true;
      } catch (error: unknown) {
        // A transport's message can echo the email, link and all, so only what kind of
        // failure it was is logged: enough to tell a login problem from a DNS one.
        options.log(
          'error',
          'invitation email delivery failed; the pending invitation can be resent',
          failureKind(error),
        );
        return false;
      }
    },

    idle,

    async close() {
      // Better Auth1.7.7 starts this cached check without awaiting it (auth/base.mjs).
      // Join startup before destroying the shared pool, including a never-used service.
      try {
        const context = await auth.$context;
        await context.checkSchema?.();
      } catch (error: unknown) {
        options.log('error', 'authentication startup failed before shutdown', failureKind(error));
      }
      await idle();
      await db.destroy();
    },
  };
}
