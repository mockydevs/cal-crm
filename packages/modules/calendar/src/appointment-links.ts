// A reminder's link to reschedule or cancel (migration 0107). The booking's own management
// token is kept only as a digest, so no message sent later can carry it. A reminder carries
// this link instead: /appointments/manage/<token>, the same page, one link an appointment.
//
// The token is never stored. It is a keyed digest of the link's own row id (HMAC-SHA-256
// under the install's public intake secret, 256 bits), so every reminder writes the same
// address and a copy of the database alone opens nothing. The row keeps the SHA-256 of the
// token, which finds it when the link is opened. The link opens only while its appointment
// is booked or confirmed and has not ended: a cancelled or past appointment's link opens
// nothing, and it can never reach any other appointment.
import { createHash, createHmac } from 'node:crypto';

import type { Database, DatabaseTransaction } from '@repo/db';
import { sql, type RawBuilder } from 'kysely';

/** Separates these digests from any other use of the same key. */
const LABEL = 'crm.calendar.appointment-link.v1';

/** The token of the link whose row has this id. */
export const appointmentLinkToken = (secret: string, linkId: string): string =>
  createHmac('sha256', secret).update(LABEL).update('\0').update(linkId).digest('base64url');

/** What a row keeps of its token, and what an opened address is looked up by. */
export const appointmentLinkDigest = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** What the install makes links with: its public intake secret and its PUBLIC_URL. */
export interface AppointmentLinkInstall {
  readonly secret: string;
  readonly publicUrl: string;
}

/** Where addresses start, or nothing when the install has no usable public address. */
function addressBase(publicUrl: string): URL | undefined {
  if (!URL.canParse(publicUrl)) return undefined;
  const base = new URL(publicUrl);
  const web = base.protocol === 'https:' || base.protocol === 'http:';
  return web && base.username === '' && base.password === '' ? base : undefined;
}

/**
 * The appointment's reschedule-or-cancel address, made if it has none: null when the
 * install serves no public pages, or the appointment is not booked or confirmed or has
 * ended. A row made under a secret the install no longer has is replaced. Call it in the
 * business's tenant transaction.
 */
export async function appointmentManageUrl(
  trx: DatabaseTransaction,
  install: AppointmentLinkInstall | undefined,
  appointmentId: string,
): Promise<string | null> {
  if (install === undefined || install.secret === '') return null;
  const base = addressBase(install.publicUrl);
  if (base === undefined) return null;
  const appointment = await trx
    .selectFrom('calendar.appointments')
    .select('business_id')
    .where('id', '=', appointmentId)
    .where('status', 'in', ['booked', 'confirmed'])
    .where('ends_at', '>', sql<Date>`statement_timestamp()`)
    .executeTakeFirst();
  if (appointment === undefined) return null;
  const addressOf = (token: string) => new URL(`/appointments/manage/${token}`, base).href;
  const existing = await trx
    .selectFrom('calendar.appointment_links')
    .select(['id', 'digest'])
    .where('appointment_id', '=', appointmentId)
    .executeTakeFirst();
  if (existing !== undefined) {
    const token = appointmentLinkToken(install.secret, existing.id);
    if (appointmentLinkDigest(token) === existing.digest) return addressOf(token);
    // Made under a secret the install no longer has: it opens nothing, so it is replaced.
    await trx
      .deleteFrom('calendar.appointment_links')
      .where('appointment_id', '=', appointmentId)
      .execute();
  }
  // The id comes first: the token is made from it.
  const { id } = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow();
  const token = appointmentLinkToken(install.secret, id);
  const made = await trx
    .insertInto('calendar.appointment_links')
    .values({
      business_id: appointment.business_id,
      id,
      appointment_id: appointmentId,
      digest: appointmentLinkDigest(token),
    })
    // Two reminders of one appointment at once: the one that came second uses the first's.
    .onConflict((conflict) => conflict.columns(['business_id', 'appointment_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (made !== undefined) return addressOf(token);
  const other = await trx
    .selectFrom('calendar.appointment_links')
    .select('id')
    .where('appointment_id', '=', appointmentId)
    .executeTakeFirstOrThrow();
  return addressOf(appointmentLinkToken(install.secret, other.id));
}

/** The tenant an opened management address belongs to, before any session exists. */
export interface ManagementScope {
  readonly agency_id: string;
  readonly business_id: string;
  readonly appointment_id: string;
}

/**
 * The scope of a management address: the booking's own token, or a reminder link whose
 * appointment is booked or confirmed and has not ended. Undefined for anything else.
 */
export async function managementScope(
  db: Database,
  digest: string,
): Promise<ManagementScope | undefined> {
  const { rows } =
    await sql<ManagementScope>`select * from private.appointment_scope(${digest})`.execute(db);
  return rows[0];
}

/**
 * Whether an appointment row (calendar.appointments, or the alias given) is the one the
 * address with this digest opens, read again in the tenant's transaction: its own token
 * within its time, or its reminder link while it is booked or confirmed and not ended.
 */
export function heldBy(digest: string, table = 'calendar.appointments'): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${table}.${name}`);
  return sql<boolean>`((${column('management_digest')} = ${digest}
      and ${column('management_expires_at')} > statement_timestamp())
    or (${column('status')} in ('booked', 'confirmed')
      and ${column('ends_at')} > statement_timestamp()
      and exists (select from calendar.appointment_links link
        where link.business_id = ${column('business_id')}
          and link.appointment_id = ${column('id')} and link.digest = ${digest})))`;
}
