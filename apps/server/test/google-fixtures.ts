// What the two suites that try every endpoint need for Google Calendar: the options its
// routes are made with on an install that has Google set up, and a member's connection
// added directly. Nothing here reaches Google: connecting only makes the address of
// Google's consent page, and the commands that change a connection never call it.
import { randomUUID } from 'node:crypto';

import type { GoogleConnectionOptions } from '@repo/module-calendar';
import { readCalendarMemberMemberships } from '@repo/module-tenancy';
import type { SealingVault } from '@repo/module-vault';
import type { TestDatabase } from '@repo/testing';

/** Made up for these suites: no OAuth client of Google's has this id or secret. */
const CLIENT = {
  clientId: '000000000000-matrix.apps.googleusercontent.com',
  clientSecret: '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cret',
  redirectUri: 'https://crm.example.test/api/v1/integrations/google/callback',
} as const;

/**
 * A member of the business with their Google Calendar connected, as the callback stores
 * one: a sealed token no worker opens here. The account's address is the business's alone:
 * no answer to anyone else may hold it.
 */
export async function addGoogleRecords(
  database: TestDatabase,
  businessId: string,
): Promise<{ readonly google_account: string }> {
  const user = await database.fixtures.user();
  const account = `google-${randomUUID().slice(0, 8)}@example.test`;
  await database.as('crm_owner', (sql) =>
    sql.query(
      `with secret as (
         insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         select agency_id, id, 'calendar.google.refresh_token', 1,
                decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')
         from tenancy.businesses where id = $1
         returning business_id, id)
       insert into calendar.google_connections
         (business_id, user_id, status, google_sub, google_email, secret_id)
       select business_id, $2, 'connected', $3, $3, id from secret`,
      [businessId, user.id, account],
    ),
  );
  return { google_account: account };
}

/** Each Google connection of the business, as its status and account. */
export const googleConnectionsOf = (
  database: TestDatabase,
  businessId: string,
): Promise<{ status: string; google_email: string }[]> =>
  database.as('crm_owner', (sql) =>
    sql.query<{ status: string; google_email: string }>(
      `select status, google_email from calendar.google_connections
       where business_id = $1 order by google_email`,
      [businessId],
    ),
  );

export const googleRouteOptions = (vault: SealingVault): GoogleConnectionOptions => ({
  google: {
    client: CLIENT,
    transport: () => Promise.reject(new Error('These suites never reach Google.')),
  },
  vault,
  members: { memberships: readCalendarMemberMemberships },
});
