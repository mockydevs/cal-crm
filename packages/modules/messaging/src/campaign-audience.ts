// Who a campaign is for, and who of them cannot be sent it. One reading serves the preview
// a person sees before sending and the rows written when sending starts, so what the screen
// promised is what happens.
//
// The reasons are the outbound policy's own refusals (outbound-policy.ts), asked of every
// contact at once and in the policy's order. Each email is still decided again by the
// pipeline as it leaves; this only says so beforehand.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  EMAIL_CAMPAIGN_LIMITS,
  emailCampaignSkipReasons,
  type EmailCampaignAudience,
  type EmailCampaignAudiencePreview,
  type EmailCampaignSkipReason,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { contactAudienceTest, fixContactAudience, fixedContactAudience } from '@repo/module-crm';
import { toPublicId } from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import type { CampaignOptions, CampaignRow } from './campaign-store.js';
import { addressConsentStatus } from './consent-state.js';
import { quietHoursZone, quietHoursZoneJoins } from './outbound.js';

/** Contacts written to a campaign's audience in one transaction. */
export const AUDIENCE_BATCH = 2000;

/**
 * The contacts a test keeps, each with its address and why it cannot be sent to, in id
 * order. `test` is a condition on the contact `c`.
 */
function classified(
  test: RawBuilder<SqlBool>,
  page: { readonly after: string | null; readonly limit: number },
): RawBuilder<unknown> {
  return sql`
    select c.id as contact_id, c.display_name, i.value_normalized as email,
      case
        when i.id is null then 'no_email'
        when c.do_not_contact or 'email' = any(c.dnd_channels) then 'do_not_contact'
        when s.reason = 'unsubscribe' then 'unsubscribed'
        when s.reason = 'complaint' then 'complained'
        when s.reason in ('hard_bounce', 'invalid') then 'bounced'
        when s.reason is not null then 'suppressed'
        when consent.status = 'withdrawn' then 'unsubscribed'
        when consent.status = 'unknown' then 'no_consent'
        when coalesce(st.quiet_hours_enabled, true) and tz.name is null then 'no_time_zone'
      end as reason
    from crm.contacts c
    join tenancy.businesses b on b.id = c.business_id
    left join crm.contact_identities i
      on i.business_id = c.business_id and i.contact_id = c.id and i.kind = 'email' and i.is_primary
    left join messaging.suppressions s
      on s.business_id = c.business_id and s.channel = 'email'
      and s.address_normalized = i.value_normalized and (s.expires_at is null or s.expires_at > now())
    left join lateral (
      select ${addressConsentStatus(sql`c.business_id`, sql`c.id`, sql`i.value_normalized`, 'email', 'marketing')} as status
    ) consent on true
    left join messaging.settings st on st.business_id = c.business_id
    ${quietHoursZoneJoins}
    left join lateral (select ${quietHoursZone} as name) tz on true
    where ${test} and (${page.after}::uuid is null or c.id > ${page.after}::uuid)
    order by c.id
    limit ${page.limit}
  `;
}

const reasonOf = (reason: string | null): EmailCampaignSkipReason | null =>
  emailCampaignSkipReasons.find((each) => each === reason) ?? null;

interface PreviewRow {
  readonly contact_id: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly reason: string | null;
  readonly total: number;
}

function previewOf(rows: readonly PreviewRow[], limit: number): EmailCampaignAudiencePreview {
  const groups = new Map<string | null, PreviewRow[]>();
  for (const row of rows) groups.set(row.reason, [...(groups.get(row.reason) ?? []), row]);
  const sample = (group: readonly PreviewRow[]) =>
    group.map((row) => ({
      contactId: toPublicId('contact', row.contact_id),
      name: row.display_name,
      email: row.email,
    }));
  const count = (group: readonly PreviewRow[] | undefined) => group?.[0]?.total ?? 0;
  const reasons = [...groups.entries()].flatMap(([reason, group]) => {
    const named = reasonOf(reason);
    return named === null ? [] : [{ reason: named, count: count(group), sample: sample(group) }];
  });
  const willNot = reasons.reduce((sum, group) => sum + group.count, 0);
  const willReceive = count(groups.get(null));
  const total = willReceive + willNot;
  return {
    total: Math.min(total, limit),
    willReceive: Math.min(willReceive, limit),
    willNot,
    tooMany: total > limit,
    reasons: reasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    receiving: sample(groups.get(null) ?? []),
    countedAt: new Date().toISOString(),
  };
}

/** A few of each group, each row carrying its group's size. */
const sampled = (source: RawBuilder<unknown>) => sql<PreviewRow>`
  select contact_id, display_name, email, reason, total from (
    select a.*, (count(*) over (partition by a.reason))::integer as total,
      row_number() over (partition by a.reason order by a.contact_id) as place
    from (${source}) a
  ) ranked where place <= ${EMAIL_CAMPAIGN_LIMITS.sample}
  order by reason nulls first, contact_id
`;

/**
 * Who would get the campaign and who would not, by reason. For a draft the audience is
 * read as it is now; once sending has started, it is the audience that was fixed. A draft
 * with no audience counts nobody; one that names a list, a tag or a field that is gone is
 * refused as the contact list refuses it.
 */
export async function readAudiencePreview(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaign: CampaignRow,
  audience: EmailCampaignAudience | null,
  options: CampaignOptions,
): Promise<EmailCampaignAudiencePreview> {
  const limit = EMAIL_CAMPAIGN_LIMITS.audience;
  if (campaign.audience_fixed_at !== null) {
    const { rows } = await sampled(sql`
      select r.contact_id, c.display_name, i.value_normalized as email, r.reason
      from messaging.email_campaign_recipients r
      join crm.contacts c on c.business_id = r.business_id and c.id = r.contact_id
      left join crm.contact_identities i
        on i.business_id = c.business_id and i.contact_id = c.id and i.kind = 'email' and i.is_primary
      where r.business_id = ${requireBusiness(invocation.context)} and r.campaign_id = ${campaign.id}
    `).execute(trx);
    return previewOf(rows, limit);
  }
  if (audience === null) return previewOf([], limit);
  const test = await contactAudienceTest(
    trx,
    invocation,
    await fixContactAudience(trx, audience),
    options.people,
  );
  // One more than the limit, so too many is told from exactly enough.
  const { rows } = await sampled(classified(test, { after: null, limit: limit + 1 })).execute(trx);
  return previewOf(rows, limit);
}

/**
 * Writes the next contacts of a campaign's fixed audience as recipient rows: pending, or
 * skipped with the reason known now. Gives how many were read and the last of them; fewer
 * than a full batch means the audience is whole. Writing the same contacts again changes
 * nothing.
 */
export async function writeAudienceBatch(
  trx: DatabaseTransaction,
  invocation: Invocation,
  campaign: Pick<CampaignRow, 'id' | 'audience_fixed' | 'audience_cursor'>,
  options: CampaignOptions,
): Promise<{ readonly read: number; readonly last: string | null }> {
  const businessId = requireBusiness(invocation.context);
  const test = await contactAudienceTest(
    trx,
    invocation,
    fixedContactAudience.parse(campaign.audience_fixed),
    options.people,
  );
  const {
    rows: [written],
  } = await sql<{ read: number; last: string | null }>`
    with batch as (${classified(test, { after: campaign.audience_cursor, limit: AUDIENCE_BATCH })}),
    added as (
      insert into messaging.email_campaign_recipients (business_id, campaign_id, contact_id, status, reason)
      select ${businessId}, ${campaign.id}, b.contact_id,
        case when b.reason is null then 'pending' else 'skipped' end, b.reason
      from batch b
      on conflict do nothing
    )
    select (select count(*) from batch)::integer as read,
      (select contact_id from batch order by contact_id desc limit 1) as last
  `.execute(trx);
  return { read: written?.read ?? 0, last: written?.last ?? null };
}
