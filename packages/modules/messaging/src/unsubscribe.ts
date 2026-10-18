import { createHash, randomBytes } from 'node:crypto';
import { allowEveryone, defineCommand, requireBusiness, runCommand } from '@repo/commands';
import { unsubscribeToken } from '@repo/contracts';
import type { Database, DatabaseTransaction } from '@repo/db';
import { NotFoundError, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import {
  addressConsentStatus,
  lockAddressConsent,
  lockContactConsent,
  type CurrentConsent,
} from './consent-state.js';

const digestOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Worker-only issuance, within the original message's tenant transaction. The link is kept
 * with the address the email goes to: it works for as long as the business exists, whatever
 * later happens to the message, the address or the contact.
 */
export async function createUnsubscribeLink(
  trx: DatabaseTransaction,
  context: TenantContext,
  messageId: string,
  publicUrl: string,
): Promise<string> {
  const businessId = requireBusiness(context);
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '')
    throw new Error('One-click unsubscribe requires a public HTTPS address.');
  const message = await trx
    .selectFrom('messaging.outbound_dispatch as d')
    .innerJoin('messaging.messages as m', (join) =>
      join.onRef('m.business_id', '=', 'd.business_id').onRef('m.id', '=', 'd.id'),
    )
    .innerJoin('messaging.conversations as v', (join) =>
      join.onRef('v.business_id', '=', 'm.business_id').onRef('v.id', '=', 'm.conversation_id'),
    )
    .select(['m.id', 'm.to_addresses', 'v.contact_id'])
    .where('d.business_id', '=', businessId)
    .where('d.id', '=', z.uuid().parse(messageId))
    .where('d.purpose', '=', 'marketing')
    .where('m.channel', '=', 'email')
    .where('m.direction', '=', 'outbound')
    .executeTakeFirst();
  const address = message?.to_addresses.at(0);
  if (message === undefined || address === undefined)
    throw new NotFoundError('marketing message', messageId);
  // Node24 crypto.randomBytes is a CSPRNG; RFC8058 requires a hard-to-forge URI.
  const token = randomBytes(32).toString('base64url');
  const row = await trx
    .insertInto('messaging.unsubscribe_links')
    .values({
      business_id: businessId,
      digest: digestOf(token),
      address_normalized: address,
      message_id: message.id,
      contact_id: message.contact_id,
    })
    // One link per message: a second issuance never replaces the first.
    .onConflict((oc) =>
      oc.columns(['business_id', 'message_id']).where('message_id', 'is not', null).doNothing(),
    )
    .returning('digest')
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('marketing message', messageId);
  return new URL(`/unsubscribe/${token}`, base).toString();
}

const withdraw = defineCommand({
  name: 'consents.unsubscribe',
  permission: 'contacts.manage',
  input: z.strictObject({ digest: z.string().regex(/^[0-9a-f]{64}$/) }),
  audit: () => ({ channel: 'email', purpose: 'marketing', source: 'unsubscribe_link' }),
  async handle(trx, { digest }, command) {
    const businessId = requireBusiness(command.context);
    // Serialize with dispatch: a queued message rechecks this withdrawal before SMTP.
    await trx
      .selectFrom('tenancy.businesses')
      .select('id')
      .where('id', '=', businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const link = await trx
      .selectFrom('messaging.unsubscribe_links as l')
      .leftJoin('crm.contacts as c', (join) =>
        join.onRef('c.business_id', '=', 'l.business_id').onRef('c.id', '=', 'l.contact_id'),
      )
      .select(['l.digest', 'l.address_normalized', 'l.message_id', 'c.id as contact_id'])
      .where('l.digest', '=', digest)
      .forUpdate('l')
      .executeTakeFirst();
    if (link === undefined) return false;
    const address = link.address_normalized;
    const contactId = link.contact_id;
    // Whoever holds the address now: a send to it reads that contact's grants, so the link
    // is judged as that send would be. Without one, the contact the email went to.
    const holder = await trx
      .selectFrom('crm.contact_identities')
      .select('contact_id')
      .where('kind', '=', 'email')
      .where('value_normalized', '=', address)
      .executeTakeFirst();
    const judged = holder?.contact_id ?? contactId;
    // The withdrawal is the address's: it holds whoever has the address now or later, and
    // every address of the contact the email was sent to, if that contact is still here.
    // Contacts are locked in one order, then the address (consent-state.ts).
    for (const each of [...new Set([contactId, judged])].filter((id) => id !== null).sort())
      await lockContactConsent(trx, each);
    await lockAddressConsent(trx, businessId, 'email', address);
    const {
      rows: [current],
    } = await sql<{ status: CurrentConsent }>`
      select ${addressConsentStatus(sql`${businessId}::uuid`, sql`${judged}::uuid`, sql`${address}::text`, 'email', 'marketing')} as status
    `.execute(trx);
    // Already opted out: the link says so again and changes nothing. A grant made after an
    // earlier use (a re-subscribe) is not a reason to ignore the link: the latest act wins.
    if (current?.status !== 'withdrawn') {
      await trx
        .insertInto('messaging.consents')
        .values({
          business_id: businessId,
          contact_id: contactId,
          channel: 'email',
          purpose: 'marketing',
          status: 'withdrawn',
          address_normalized: address,
          source: 'unsubscribe_link',
          proof: sql`${JSON.stringify(link.message_id === null ? {} : { messageId: link.message_id })}::jsonb`,
          // The time it is written, under the locks: now() is the transaction's start.
          recorded_at: sql`clock_timestamp()`,
          recorded_by_kind: 'contact',
          recorded_by_id: contactId,
        })
        .execute();
      if (contactId !== null)
        await command.emit({
          type: 'consent.withdrawn',
          subject: { kind: 'contact', id: contactId },
          records: [contactId],
          payload: { channel: 'email', purpose: 'marketing', source: 'unsubscribe_link' },
        });
    }
    await trx
      .updateTable('messaging.unsubscribe_links')
      .set({ last_used_at: sql`now()` })
      .where('digest', '=', digest)
      .execute();
    // The message's own statistics count the first use.
    if (link.message_id !== null)
      await trx
        .updateTable('messaging.outbound_dispatch')
        .set({ unsubscribe_used_at: sql`coalesce(unsubscribe_used_at, now())` })
        .where('id', '=', link.message_id)
        .execute();
    return true;
  },
});

/** The capability alone determines scope; session headers and tenant IDs are never used. */
export async function unsubscribeFromLink(
  db: Database,
  token: string,
  correlationId: string,
): Promise<boolean> {
  if (!unsubscribeToken.safeParse(token).success) return false;
  const digest = digestOf(token);
  const {
    rows: [scope],
  } = await sql<{ agency_id: string; business_id: string; contact_id: string | null }>`
    select * from private.unsubscribe_scope(${digest})
  `.execute(db);
  if (scope === undefined) return false;
  // The unexported command is entered only after capability scope resolution and
  // validates that capability again under RLS. It grants no signed-in user's powers.
  return runCommand(
    { db, authorize: allowEveryone },
    withdraw,
    { digest },
    {
      context: {
        agencyId: scope.agency_id,
        businessId: scope.business_id,
        actorKind: 'contact',
        ...(scope.contact_id === null ? {} : { actorId: scope.contact_id }),
        correlationId: z.uuid().parse(correlationId),
      },
      permissions: 'all',
    },
  );
}
