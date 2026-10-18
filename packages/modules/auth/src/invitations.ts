// Better Auth APIs verified in first-admin.ts and installed 1.7.7 session/cookie source.
import { createHash } from 'node:crypto';
import { APIError } from '@better-auth/core/error';
import type { Database } from '@repo/db';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { sql } from 'kysely';
import * as z from 'zod';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hashOf = (token: string): Buffer => createHash('sha256').update(token).digest();
const invalid = () =>
  APIError.from('BAD_REQUEST', {
    code: 'INVALID_INVITATION',
    message: 'This invitation has run out, was revoked or was already accepted.',
  });
const validLink = (db: Database, token: string) =>
  db
    .selectFrom('tenancy.invitations')
    .selectAll()
    .where('token_hash', '=', hashOf(token))
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`);

/** Consumes invitations in crm_auth's transaction; an invite never resets a password. */
export function invitations(
  db: Database,
  passwordLength: { readonly min: number; readonly max: number },
): BetterAuthPlugin {
  return {
    id: 'crm-invitations',
    endpoints: {
      checkInvitation: createAuthEndpoint(
        '/invitations/check',
        { method: 'GET', query: z.object({ token: tokenSchema }) },
        async (ctx) => {
          const link = await validLink(db, ctx.query.token).executeTakeFirst();
          if (link === undefined) return ctx.json({ valid: false });
          const user = await db
            .selectFrom('auth.users')
            .select('id')
            .where('email_normalized', '=', link.email_normalized)
            .executeTakeFirst();
          return ctx.json({ valid: true, email: link.email, existingAccount: user !== undefined });
        },
      ),
      acceptInvitation: createAuthEndpoint(
        '/invitations/accept',
        {
          method: 'POST',
          body: z.object({
            token: tokenSchema,
            email: z.string().trim().toLowerCase().pipe(z.email()),
            name: z.string().trim().min(1).max(200).optional(),
            password: z.string().min(passwordLength.min).max(passwordLength.max).optional(),
          }),
        },
        async (ctx) => {
          // The link first, without locking it: hashing a password is slow on purpose, so
          // only a link that works earns one. The transaction checks it again, locked.
          const preview = await validLink(db, ctx.body.token).executeTakeFirst();
          if (preview?.email_normalized !== ctx.body.email) throw invalid();
          const signedIn = await getSessionFromCtx(ctx);
          const hash =
            ctx.body.password === undefined
              ? undefined
              : await ctx.context.password.hash(ctx.body.password);
          const { user, created } = await db.transaction().execute(async (trx) => {
            const link = await validLink(trx, ctx.body.token).forUpdate().executeTakeFirst();
            if (link?.email_normalized !== ctx.body.email) throw invalid();
            const signedInEmail = signedIn?.user.email.toLowerCase();
            if (signedInEmail !== undefined && signedInEmail !== ctx.body.email) {
              throw APIError.from('FORBIDDEN', {
                code: 'WRONG_ACCOUNT',
                message: 'Sign in with the email address on this invitation.',
              });
            }
            const existing = await trx
              .selectFrom('auth.users')
              .selectAll()
              .where('email_normalized', '=', ctx.body.email)
              .executeTakeFirst();
            if (existing?.disabled_at instanceof Date) {
              throw APIError.from('FORBIDDEN', {
                code: 'ACCOUNT_DISABLED',
                message: 'This account is disabled.',
              });
            }
            if (existing !== undefined && signedIn?.user.id !== existing.id) {
              throw APIError.from('UNAUTHORIZED', {
                code: 'SIGN_IN_REQUIRED',
                message: 'Sign in with the invited email address before accepting.',
              });
            }
            if (existing === undefined && (hash === undefined || ctx.body.name === undefined)) {
              throw APIError.from('BAD_REQUEST', {
                code: 'DETAILS_REQUIRED',
                message: 'Give your name and choose a password.',
              });
            }
            const user =
              existing ??
              (await trx
                .insertInto('auth.users')
                .values({ email: ctx.body.email, name: ctx.body.name ?? '', email_verified: true })
                .returningAll()
                .executeTakeFirstOrThrow());
            if (existing === undefined) {
              await trx
                .insertInto('auth.accounts')
                .values({
                  user_id: user.id,
                  account_id: user.id,
                  provider_id: 'credential',
                  password: hash,
                })
                .execute();
            }
            await trx
              .insertInto('tenancy.memberships')
              .values({
                user_id: user.id,
                agency_id: link.agency_id,
                business_id: link.business_id,
                role_id: link.role_id,
              })
              .onConflict((oc) => oc.doNothing())
              .execute();
            // What "Add user" wrote of the person becomes their profile in this agency.
            await sql`select private.apply_invitation_profile(${link.id}, ${user.id})`.execute(trx);
            await trx
              .updateTable('tenancy.invitations')
              .set({ accepted_at: sql<Date>`now()` })
              .where('id', '=', link.id)
              .execute();
            return { user, created: existing === undefined };
          });
          if (created) {
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
          }
          return ctx.json({ status: true });
        },
      ),
    },
  };
}
