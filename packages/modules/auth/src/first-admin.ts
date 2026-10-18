// The first admin. While nobody runs the agency yet, the app prints a one-time setup link
// at each start; the dashboard's setup page uses one to create the first admin, as agency
// staff with the built-in owner role, and signs them in. Links work once, within 24 hours,
// and creating the admin ends every other one. Only each token's SHA-256 is stored.
import { createHash, randomBytes } from 'node:crypto';

import { APIError, BASE_ERROR_CODES } from '@better-auth/core/error';
import { explainUniqueViolation, type Database } from '@repo/db';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { sql } from 'kysely';
import * as z from 'zod';

const SETUP_HOURS = 24;

/** The dashboard's page that a setup link opens. */
export const SETUP_PAGE = '/setup';

/** What the app does about the first admin as it starts. */
export type FirstStart =
  /** A new setup link to print. */
  | { readonly kind: 'link'; readonly url: string }
  /** Someone already runs the agency: nothing to do. */
  | { readonly kind: 'admin_exists' }
  /** The install step hasn't made the agency and its roles, so a link couldn't work. */
  | { readonly kind: 'no_agency' };

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Whether anyone runs the agency yet: agency staff, members of the agency itself. */
async function adminExists(db: Database): Promise<boolean> {
  const staff = await db
    .selectFrom('tenancy.memberships')
    .select('id')
    .where('business_id', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return staff !== undefined;
}

/** The agency's built-in owner role, which the first admin gets. */
const ownerRole = (db: Database) =>
  db
    .selectFrom('tenancy.roles')
    .select(['id', 'agency_id'])
    .where('scope', '=', 'agency')
    .where('key', '=', 'owner')
    .where('is_builtin', '=', true)
    .orderBy('created_at')
    .limit(1);

/**
 * A new setup link while nobody runs the agency, valid for 24 hours. Each start adds one,
 * since a link already printed can't be shown again; expired ones are cleared as it does.
 */
export async function firstAdminLink(db: Database, publicUrl: string): Promise<FirstStart> {
  if (await adminExists(db)) return { kind: 'admin_exists' };
  if ((await ownerRole(db).executeTakeFirst()) === undefined) return { kind: 'no_agency' };
  const token = randomBytes(32).toString('base64url');
  await db
    .deleteFrom('auth.setup_links')
    .where('expires_at', '<=', sql<Date>`now()`)
    .execute();
  await db
    .insertInto('auth.setup_links')
    .values({
      token_hash: hashOf(token),
      expires_at: sql<Date>`now() + make_interval(hours => ${SETUP_HOURS})`,
    })
    .execute();
  return {
    kind: 'link',
    url: `${publicUrl}${SETUP_PAGE}?${new URLSearchParams({ token }).toString()}`,
  };
}

async function validLink(db: Database, token: string): Promise<boolean> {
  const link = await db
    .selectFrom('auth.setup_links')
    .select('id')
    .where('token_hash', '=', hashOf(token))
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return link !== undefined;
}

export interface FirstAdminOptions {
  readonly db: Database;
  /** Better Auth's bounds for a password, as emailAndPassword sets them. */
  readonly passwordLength: { readonly min: number; readonly max: number };
}

/**
 * GET /setup?token= says whether a link still works; POST /setup creates the first admin
 * from one and signs them in.
 */
export function firstAdmin({ db, passwordLength }: FirstAdminOptions): BetterAuthPlugin {
  return {
    id: 'crm-first-admin',
    endpoints: {
      checkSetupLink: createAuthEndpoint(
        '/setup',
        { method: 'GET', query: z.object({ token: z.string() }) },
        async (ctx) =>
          ctx.json({
            valid: !(await adminExists(db)) && (await validLink(db, ctx.query.token)),
          }),
      ),
      setUpFirstAdmin: createAuthEndpoint(
        '/setup',
        {
          method: 'POST',
          body: z.object({
            token: z.string(),
            name: z.string().trim().min(1).max(200),
            email: z.string().trim().pipe(z.email()),
            password: z.string(),
          }),
        },
        async (ctx) => {
          const { token, name, email, password } = ctx.body;
          if (password.length < passwordLength.min) {
            throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.PASSWORD_TOO_SHORT);
          }
          if (password.length > passwordLength.max) {
            throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.PASSWORD_TOO_LONG);
          }
          const hash = await ctx.context.password.hash(password);
          const user = await db.transaction().execute(async (trx) => {
            // One at a time, so two links can't make two first admins.
            await sql`select pg_advisory_xact_lock(hashtext('crm.first-admin'))`.execute(trx);
            if (await adminExists(trx)) {
              throw APIError.from('FORBIDDEN', {
                code: 'SETUP_DONE',
                message: 'The agency already has its first admin.',
              });
            }
            const link = await trx
              .deleteFrom('auth.setup_links')
              .where('token_hash', '=', hashOf(token))
              .where('expires_at', '>', sql<Date>`now()`)
              .returning('id')
              .executeTakeFirst();
            if (link === undefined) {
              throw APIError.from('BAD_REQUEST', {
                code: 'INVALID_TOKEN',
                message: 'This setup link has run out or was already used.',
              });
            }
            const role = await ownerRole(trx).executeTakeFirstOrThrow();
            // Whoever has the link runs the install, so the address they give is trusted.
            const created = await trx
              .insertInto('auth.users')
              .values({ email: email.toLowerCase(), name, email_verified: true })
              .returning(['id', 'email', 'name', 'email_verified', 'created_at', 'updated_at'])
              .executeTakeFirstOrThrow()
              .catch(
                explainUniqueViolation({
                  users_email_unique: () =>
                    APIError.from('BAD_REQUEST', {
                      code: 'EMAIL_TAKEN',
                      message: 'Someone already uses this email address.',
                    }),
                }),
              );
            await trx
              .insertInto('auth.accounts')
              .values({
                user_id: created.id,
                account_id: created.id,
                provider_id: 'credential',
                password: hash,
              })
              .execute();
            await trx
              .insertInto('tenancy.memberships')
              .values({ user_id: created.id, agency_id: role.agency_id, role_id: role.id })
              .execute();
            await trx.deleteFrom('auth.setup_links').execute();
            return created;
          });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, {
            session,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              emailVerified: user.email_verified,
              createdAt: user.created_at,
              updatedAt: user.updated_at,
            },
          });
          return ctx.json({ status: true });
        },
      ),
    },
  };
}
