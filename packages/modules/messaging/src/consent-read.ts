import { requireBusiness, type Invocation } from '@repo/commands';
import {
  CONSENT_HISTORY_LIMIT,
  consentChannels,
  consentPurposes,
  contactConsent,
  type ContactConsent,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { ActorNames } from '@repo/module-crm';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';
import { presentProof } from './consent-proof.js';
import { latestConsentFirst } from './consent-state.js';

interface CurrentRow {
  readonly channel: string;
  readonly purpose: string;
  readonly status: string | null;
  readonly source: string | null;
  readonly recorded_at: Date | null;
}

/** Each distinct recorder's name, found with one lookup per kind. */
async function namesOf(
  trx: DatabaseTransaction,
  rows: readonly { readonly recorded_by_kind: string; readonly recorded_by_id: string | null }[],
  actorNames: ActorNames,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [kind, lookup] of Object.entries(actorNames)) {
    const ids = new Set(
      rows.flatMap((row) =>
        row.recorded_by_kind === kind && row.recorded_by_id !== null ? [row.recorded_by_id] : [],
      ),
    );
    if (ids.size === 0) continue;
    for (const [id, name] of await lookup(trx, [...ids])) names.set(`${kind}:${id}`, name);
  }
  return names;
}

/**
 * A contact's consent as sending checks it, with every change behind it and the other
 * things that stop a message: do not contact, and addresses that can't be sent to.
 * A contact in the trash can be read but not changed.
 */
export async function readContactConsent(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  actorNames: ActorNames = {},
): Promise<ContactConsent> {
  const businessId = requireBusiness(invocation.context);
  const contactId = parsePublicId('contact', publicId);
  if (contactId === undefined) throw new NotFoundError('Contact', publicId);
  const contact = await trx
    .selectFrom('crm.contacts')
    .select(['id', 'deleted_at', 'do_not_contact', 'timezone'])
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    .executeTakeFirst();
  if (contact === undefined) throw new NotFoundError('Contact', publicId);
  // One row per channel and purpose, each the ledger's latest by the shared rule.
  const { rows: current } = await sql<CurrentRow>`
    select ch.channel, pu.purpose, latest.status, latest.source, latest.recorded_at
    from unnest(${[...consentChannels]}::text[]) with ordinality as ch (channel, position)
    cross join unnest(${[...consentPurposes]}::text[]) with ordinality as pu (purpose, position)
    left join lateral (
      select status, source, recorded_at from messaging.consents
      where business_id=${businessId}::uuid and contact_id=${contactId}::uuid
        and channel=ch.channel and purpose=pu.purpose
      order by ${latestConsentFirst} limit 1
    ) latest on true
    order by ch.position, pu.position
  `.execute(trx);
  const changes = await trx
    .selectFrom('messaging.consents')
    .select([
      'channel',
      'purpose',
      'status',
      'source',
      'proof',
      'recorded_at',
      'recorded_by_kind',
      'recorded_by_id',
    ])
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .orderBy(latestConsentFirst)
    .limit(CONSENT_HISTORY_LIMIT + 1)
    .execute();
  const history = changes.slice(0, CONSENT_HISTORY_LIMIT);
  const names = await namesOf(trx, history, actorNames);
  const suppressions = await trx
    .selectFrom('crm.contact_identities as i')
    .innerJoin('messaging.suppressions as s', (join) =>
      join
        .onRef('s.business_id', '=', 'i.business_id')
        .onRef('s.address_normalized', '=', 'i.value_normalized'),
    )
    .select(['s.channel', 'i.value', 's.reason', 's.created_at', 's.expires_at'])
    .where('i.business_id', '=', businessId)
    .where('i.contact_id', '=', contactId)
    // As sending matches them: an email address by email, a phone number by SMS.
    .where(
      sql<boolean>`s.channel = case i.kind when 'email' then 'email' when 'phone' then 'sms' end`,
    )
    .where(sql<boolean>`(s.expires_at is null or s.expires_at > now())`)
    .orderBy('s.created_at')
    .orderBy('s.id')
    .execute();
  return contactConsent.parse({
    canManage:
      contact.deleted_at === null &&
      (invocation.permissions === 'all' || invocation.permissions.has('contacts.manage')),
    doNotContact: contact.do_not_contact,
    timeZone: contact.timezone,
    current: current.map((row) => ({
      channel: row.channel,
      purpose: row.purpose,
      status: row.status ?? 'unknown',
      source: row.source,
      recordedAt: row.recorded_at?.toISOString() ?? null,
    })),
    suppressions: suppressions.map((row) => ({
      channel: row.channel,
      address: row.value,
      reason: row.reason,
      since: row.created_at.toISOString(),
      until: row.expires_at?.toISOString() ?? null,
    })),
    history: history.map((row) => ({
      channel: row.channel,
      purpose: row.purpose,
      status: row.status,
      source: row.source,
      recordedAt: row.recorded_at.toISOString(),
      recordedBy: {
        kind: row.recorded_by_kind,
        name: names.get(`${row.recorded_by_kind}:${row.recorded_by_id ?? ''}`) ?? null,
        you:
          invocation.context.actorKind === 'user' &&
          row.recorded_by_kind === 'user' &&
          row.recorded_by_id === invocation.context.userId,
      },
      proof: presentProof(row.proof),
    })),
    historyTruncated: changes.length > CONSENT_HISTORY_LIMIT,
  });
}
