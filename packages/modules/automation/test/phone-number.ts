// A registered phone number as connecting Twilio and registering a number leaves it: a
// sealed secret, the provider connection, the channel account and the number. For tests
// that need a number to exist, not a provider to talk to.
import { randomBytes, randomInt } from 'node:crypto';

import { toPublicId, type TenantContext } from '@repo/kernel';
import type { Sql } from '@repo/testing';

export interface PhoneNumberState {
  /** The channel account's status; anything but active can't send. */
  readonly status?: string;
  /** The provider connection's status; anything but connected can't send. */
  readonly connection?: string;
  readonly capabilities?: readonly string[];
}

const one = async (sql: Sql, text: string, values: readonly unknown[]): Promise<string> => {
  const [row] = await sql.query<{ id: string }>(text, values);
  if (row === undefined) throw new Error('The insert returns its id.');
  return row.id;
};

/** Adds a number, as a superuser, and returns its stored id and its public id. */
export async function addPhoneNumber(
  sql: Sql,
  context: TenantContext & { readonly businessId: string },
  name: string,
  state: PhoneNumberState = {},
): Promise<{ readonly id: string; readonly publicId: string; readonly e164: string }> {
  const secret = await one(
    sql,
    `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
     values ($1, $2, 'sms.credentials', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
     returning id`,
    [context.agencyId, context.businessId],
  );
  const connection = await one(
    sql,
    `insert into messaging.provider_connections
       (agency_id, business_id, provider, label, account_ref, secret_id, status)
     values ($1, $2, 'twilio', $3, $4, $5, $6) returning id`,
    [
      context.agencyId,
      context.businessId,
      `Twilio for ${name}`,
      `AC${randomBytes(16).toString('hex')}`,
      secret,
      state.connection ?? 'connected',
    ],
  );
  const id = await one(
    sql,
    `insert into messaging.channel_accounts (business_id, channel, name, status)
     values ($1, 'sms', $2, $3) returning id`,
    [context.businessId, name, state.status ?? 'active'],
  );
  // A number is registered once in the whole install, so each gets digits of its own.
  const e164 = `+1444${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
  await sql.query(
    `insert into messaging.phone_numbers
       (business_id, id, e164, provider_connection_id, provider_number_ref, capabilities)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      context.businessId,
      id,
      e164,
      connection,
      `PN${randomBytes(16).toString('hex')}`,
      state.capabilities ?? ['sms'],
    ],
  );
  return { id, publicId: toPublicId('phone_number', id), e164 };
}
