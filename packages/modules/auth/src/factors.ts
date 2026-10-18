// Two-factor sign-in and passkeys: what Better Auth's two-factor and passkey plugins leave
// to us. Each piece was read in their 1.7.7 sources.
import { randomBytes } from 'node:crypto';

import { APIError } from '@better-auth/core/error';
import type { BetterAuthPlugin } from 'better-auth';
import {
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';

/** The two-factor plugin's challenge cookie (its constant.mjs), and how long it lasts. */
const TWO_FACTOR_COOKIE = 'two_factor';
const CHALLENGE_SECONDS = 10 * 60;

/**
 * How recently someone without a password must have signed in to change their factors.
 * Someone with one confirms it instead, as the two-factor plugin asks.
 */
const FRESH_SIGN_IN_SECONDS = 15 * 60;

/**
 * The two-factor plugin's endpoints that change, or show, someone's second factor. With
 * allowPasswordless, the plugin asks nothing of someone without a password here.
 */
const FACTOR_CHANGES = new Set([
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
  '/two-factor/get-totp-uri',
]);

/** Where someone halfway through signing in enters their code: the dashboard's page. */
export const TWO_FACTOR_PAGE = '/sign-in/two-factor';

export interface SignInRules {
  /** The address people use, PUBLIC_URL. */
  readonly publicUrl: string;
  /** The agency's name: authenticator apps show it beside the code. */
  readonly agencyName: () => Promise<string>;
  /** Whether the person's agency requires them to sign in with two factors. */
  readonly twoFactorRequired: (userId: string) => Promise<boolean>;
  /** Whether the person has a password, which changing their factors then asks for. */
  readonly hasPassword: (userId: string) => Promise<boolean>;
}

/** Where to go once signed in: only the address's path, so it stays on this site. */
function pathOf(target: string, publicUrl: string): string {
  const url = new URL(target, publicUrl);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Our plugin beside Better Auth's:
 * - GET /security tells the dashboard what signing in asks of the person;
 * - authenticator apps name the agency, whatever the page asks for;
 * - two-factor sign-in stays on while the agency requires it;
 * - someone without a password changes their factors only within 15 minutes of signing
 *   in, so a stolen session can't read their app's secret, make recovery codes, or turn
 *   two-factor sign-in off or on;
 * - a sign-in link asks for a code as a password does. The two-factor plugin checks only
 *   password sign-in, so this ends the link's session and starts the plugin's challenge
 *   instead, exactly as the plugin does after a password.
 */
export function signInRules(rules: SignInRules): BetterAuthPlugin {
  return {
    id: 'crm-sign-in-rules',
    endpoints: {
      security: createAuthEndpoint(
        '/security',
        { method: 'GET', use: [sessionMiddleware] },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          return ctx.json({
            twoFactorRequired: await rules.twoFactorRequired(userId),
            hasPassword: await rules.hasPassword(userId),
          });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path !== undefined && FACTOR_CHANGES.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session === null || (await rules.hasPassword(session.user.id))) return;
            const age = Date.now() - new Date(session.session.createdAt).getTime();
            if (age >= FRESH_SIGN_IN_SECONDS * 1000) {
              throw APIError.from('FORBIDDEN', {
                code: 'SIGN_IN_AGAIN',
                message: 'Sign in again to change how you sign in.',
              });
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/two-factor/enable',
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown = ctx.body;
            return {
              context: { body: Object.assign({}, body, { issuer: await rules.agencyName() }) },
            };
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/two-factor/disable',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session !== null && (await rules.twoFactorRequired(session.user.id))) {
              throw APIError.from('FORBIDDEN', {
                code: 'TWO_FACTOR_REQUIRED',
                message: 'Your agency requires two-factor sign-in.',
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === '/magic-link/verify',
          handler: createAuthMiddleware(async (ctx) => {
            const signedIn = ctx.context.newSession;
            const user: { id: string; twoFactorEnabled?: unknown } | undefined = signedIn?.user;
            if (signedIn === null || user?.twoFactorEnabled !== true) return;
            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(signedIn.session.token);
            ctx.context.setNewSession(null);
            const identifier = `2fa-${randomBytes(15).toString('base64url')}`;
            const expiresAt = new Date(Date.now() + CHALLENGE_SECONDS * 1000);
            await ctx.context.internalAdapter.createVerificationValue({
              value: user.id,
              identifier,
              expiresAt,
            });
            await ctx.context.internalAdapter.createVerificationValue({
              value: '0',
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, {
              maxAge: CHALLENGE_SECONDS,
            });
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            );
            const callback: unknown = ctx.query?.['callbackURL'];
            const next = pathOf(typeof callback === 'string' ? callback : '/', rules.publicUrl);
            throw ctx.redirect(
              `${rules.publicUrl}${TWO_FACTOR_PAGE}?${new URLSearchParams({ next }).toString()}`,
            );
          }),
        },
      ],
    },
  };
}

/**
 * A passkey counts as two factors only when the authenticator checked who it was, with a
 * PIN or a fingerprint. SimpleWebAuthn reports it; Better Auth's plugin doesn't require it.
 */
export function requireUserVerified(
  verified: boolean,
  status: 'BAD_REQUEST' | 'UNAUTHORIZED',
): void {
  if (!verified) {
    throw APIError.from(status, {
      code: 'USER_NOT_VERIFIED',
      message: 'Use a passkey that asks for your PIN, fingerprint or face.',
    });
  }
}
