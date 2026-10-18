// Where a contact came from, as conditions and merge fields read it: the contact's first
// and latest touch, and the touch of the event that started a run. The CRM writes a touch
// once, in the transaction of the form submission or the booking it belongs to, and never
// rewrites it: a later touch is a new row, and only which row is the latest moves. So the
// touch of a run's own event reads the same for the life of the run, whatever the contact
// does afterwards.
//
// A click id never leaves the database here: only whether the touch holds one.
import {
  attributionLeaves,
  attributionPath,
  attributionTriggers,
  type AttributionLeafKey,
  type AttributionScope,
  type ConditionValue,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

import type { Arrival } from './triggers.js';

/** A touch as it is read here: its facts, and which click ids it holds as yes or no. */
export interface TouchRow {
  readonly touched_at: Date;
  readonly medium: string;
  readonly session_source: string;
  readonly source_label: string | null;
  readonly source_rule: string | null;
  readonly utm_source: string | null;
  readonly utm_medium: string | null;
  readonly utm_campaign: string | null;
  readonly utm_content: string | null;
  readonly utm_term: string | null;
  readonly match_type: string | null;
  readonly campaign_id: string | null;
  readonly ad_group_id: string | null;
  readonly ad_id: string | null;
  readonly referrer_domain: string | null;
  readonly landing_url: string | null;
  readonly page_url: string | null;
  readonly has_google: boolean;
  readonly has_meta: boolean;
  readonly has_microsoft: boolean;
  readonly has_tiktok: boolean;
  readonly has_linkedin: boolean;
}

// Every column a touch is read by. The click ids are compared in the database, so that no
// value of one is ever selected.
const columns = sql`
  touch.touched_at, touch.medium, touch.session_source, touch.source_label, touch.source_rule,
  touch.utm_source, touch.utm_medium, touch.utm_campaign, touch.utm_content, touch.utm_term,
  touch.match_type, touch.campaign_id, touch.ad_group_id, touch.ad_id, touch.referrer_domain,
  touch.landing_url, touch.page_url,
  (touch.gclid is not null or touch.gbraid is not null or touch.wbraid is not null) as has_google,
  (touch.fbclid is not null or touch.ctwa_clid is not null) as has_meta,
  (touch.msclkid is not null) as has_microsoft,
  (touch.ttclid is not null) as has_tiktok,
  (touch.li_fat_id is not null) as has_linkedin
`;

/**
 * A touch's values by path under one of the three prefixes. Without a touch every leaf is
 * there and empty, so a condition on one is judged rather than left unknown; the yes-or-no
 * leaves are no, since a touch that does not exist holds no click id.
 */
export function touchValues(
  scope: AttributionScope,
  touch: TouchRow | undefined,
): Record<string, ConditionValue> {
  const leaves: Readonly<Record<AttributionLeafKey, ConditionValue>> = {
    source: touch?.source_label ?? null,
    sourceKey: touch?.source_rule ?? null,
    sessionSource: touch?.session_source ?? null,
    medium: touch?.medium ?? null,
    utmSource: touch?.utm_source ?? null,
    utmMedium: touch?.utm_medium ?? null,
    utmCampaign: touch?.utm_campaign ?? null,
    utmContent: touch?.utm_content ?? null,
    utmTerm: touch?.utm_term ?? null,
    matchType: touch?.match_type ?? null,
    campaignId: touch?.campaign_id ?? null,
    adGroupId: touch?.ad_group_id ?? null,
    adId: touch?.ad_id ?? null,
    referrerDomain: touch?.referrer_domain ?? null,
    landingPage: touch?.landing_url ?? null,
    page: touch?.page_url ?? null,
    touchedAt: touch?.touched_at.toISOString() ?? null,
    hasGoogleClickId: touch?.has_google ?? false,
    hasMetaClickId: touch?.has_meta ?? false,
    hasMicrosoftClickId: touch?.has_microsoft ?? false,
    hasTikTokClickId: touch?.has_tiktok ?? false,
    hasLinkedInClickId: touch?.has_linkedin ?? false,
  };
  const values: Record<string, ConditionValue> = {};
  for (const leaf of Object.keys(leaves) as AttributionLeafKey[])
    values[attributionPath(scope, leaf)] = leaves[leaf];
  return values;
}

/**
 * A contact's first and latest touch, as contact.attribution.first.* and
 * contact.attribution.latest.*: one read of the two flagged rows, which are one row while
 * the contact has a single touch.
 */
export async function contactAttributionValues(
  trx: DatabaseTransaction,
  contactId: string,
): Promise<Record<string, ConditionValue>> {
  const { rows } = await sql<TouchRow & { is_first: boolean; is_latest: boolean }>`
    select ${columns}, touch.is_first, touch.is_latest
    from crm.contact_attributions touch
    where touch.contact_id = ${contactId} and (touch.is_first or touch.is_latest)
  `.execute(trx);
  return {
    ...touchValues(
      'first',
      rows.find((row) => row.is_first),
    ),
    ...touchValues(
      'latest',
      rows.find((row) => row.is_latest),
    ),
  };
}

/**
 * The latest touch read as the arrival of a run: what a test run, which no event started,
 * reads under trigger.attribution. Every leaf is there, empty where the latest touch is.
 */
export function arrivalFromLatest(
  values: Readonly<Record<string, ConditionValue | undefined>>,
): Record<string, ConditionValue> {
  const arrived = touchValues('trigger', undefined);
  for (const leaf of attributionLeaves) {
    const held = values[attributionPath('latest', leaf.key)];
    if (held !== undefined) arrived[attributionPath('trigger', leaf.key)] = held;
  }
  return arrived;
}

// What the CRM calls the subject of each event that comes with a touch of its own
// (crm.contact_attributions.subject_kind): the submission, and the appointment.
const TOUCH_SUBJECTS: Readonly<Record<string, string>> = {
  form_submission: 'form_submission',
  appointment: 'appointment',
};

/** Whether an event of this type comes with a touch of its own. */
export const hasArrival = (eventType: string): boolean =>
  (attributionTriggers as readonly string[]).includes(eventType);

/**
 * The touch an event recorded for one of the records it happened to: the row whose subject
 * is the event's own subject (the submission, the appointment). Nothing for an event that
 * records none, such as a booking a team member made by hand.
 */
export async function readEventTouch(
  trx: DatabaseTransaction,
  event: { readonly subject_kind: string; readonly subject_id: string },
  recordIds: readonly string[],
): Promise<TouchRow | undefined> {
  const kind = TOUCH_SUBJECTS[event.subject_kind];
  if (kind === undefined || recordIds.length === 0) return undefined;
  const { rows } = await sql<TouchRow>`
    select ${columns}
    from crm.contact_attributions touch
    where touch.contact_id = any(${[...recordIds]}::uuid[])
      and touch.subject_kind = ${kind} and touch.subject_id = ${event.subject_id}
    order by touch.touched_at, touch.id
    limit 1
  `.execute(trx);
  return rows[0];
}

/** A touch as a trigger's filters read it. */
export const arrivalOf = (touch: TouchRow | undefined): Arrival => ({
  source: touch?.source_label ?? null,
  sessionSource: touch?.session_source ?? null,
});
