// A contact's touches (migration 0086): written when a contact is made, and by a form, a
// booking or a chat when it reaches one; read for the contact's page. A touch says where
// the contact came from; the rules are session-source.ts.
//
// Every contact has a first touch. The one written when a contact is made knows only how
// it came to be. A form, a booking or a chat that made the contact knows more, and says so
// in the same transaction: it fills that touch in rather than adding a second, so the first
// touch of a contact a form made is the form's visit. Any later interaction adds a touch,
// which becomes the latest; the first never changes.
//
// A touch that was a visit to a page also carries its lead source (lead-source.ts): the
// name and the rule that decided it, worked out here and nowhere else, so a form, a booking
// and a chat cannot name the same visit differently.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  attributionMediums,
  sessionSources,
  type AttributionMedium,
  type ClickIdName,
  type ContactAttribution,
  type ContactAttributions,
  type ContactSource,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { leadSourceOf } from './lead-source.js';
import { decideLeadSourceFor, type LeadDecision } from './lead-source-rules.js';
import { NO_VISIT, sessionSourceOf, type VisitFacts } from './session-source.js';

/** The interaction of each way a contact comes to be (crm.contacts.created_source). */
const mediumOfSource: Readonly<Record<ContactSource, AttributionMedium>> = {
  user: 'manual',
  api: 'api',
  import: 'import',
  automation: 'automation',
  assistant: 'assistant',
  email: 'message',
  sms: 'message',
  call: 'message',
  webchat: 'chat',
  form: 'form',
  booking: 'calendar',
  unknown: 'unknown',
};

const columnsOf = (
  medium: AttributionMedium,
  visit: VisitFacts,
  /** Where the lead was taken, when that is not the page the visit began on. */
  page?: { readonly url: string | null; readonly carried: boolean },
  /** How the lead was named, when the business's rules were asked: else the built-in name. */
  decision?: LeadDecision,
) => {
  const lead = leadSourceOf(medium, visit);
  return {
    medium,
    session_source: sessionSourceOf(medium, visit),
    source_label: decision?.label ?? lead?.label ?? null,
    source_rule: decision?.rule ?? lead?.key ?? null,
    utm_source: visit.utmSource,
    utm_medium: visit.utmMedium,
    utm_campaign: visit.utmCampaign,
    utm_content: visit.utmContent,
    utm_term: visit.utmTerm,
    match_type: visit.matchType,
    campaign_id: visit.campaignId,
    ad_group_id: visit.adGroupId,
    ad_id: visit.adId,
    gclid: visit.gclid,
    gbraid: visit.gbraid,
    wbraid: visit.wbraid,
    fbclid: visit.fbclid,
    msclkid: visit.msclkid,
    ctwa_clid: visit.ctwaClid,
    ttclid: visit.ttclid,
    li_fat_id: visit.liFatId,
    referrer_domain: visit.referrerDomain,
    landing_url: visit.landingUrl,
    // Where the interaction happened: the page the visit began on, unless how the visitor
    // arrived was handed on from another page (arrival.ts).
    page_url: page === undefined ? visit.landingUrl : page.url,
    arrival_carried: page?.carried ?? false,
  };
};

/** The touch a new contact starts with: how it came to be, and nothing of a visit. */
export async function recordCreationTouch(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
  source: ContactSource,
): Promise<void> {
  await trx
    .insertInto('crm.contact_attributions')
    .values({
      business_id: businessId,
      contact_id: contactId,
      ...columnsOf(mediumOfSource[source], NO_VISIT),
      subject_kind: 'contact',
      subject_id: contactId,
      is_first: true,
      is_latest: true,
    })
    .execute();
}

export interface TouchInput {
  /** crm.contacts.id. */
  readonly contactId: string;
  readonly medium: 'form' | 'calendar' | 'chat';
  readonly visit: VisitFacts;
  /**
   * The page the lead was taken on, and whether `visit` was handed on from the page the
   * visit began on (readArrival). Left out: the visit's own page, and nothing was carried.
   */
  readonly page?: { readonly url: string | null; readonly carried: boolean } | undefined;
  /**
   * The address the facts were read from, with its query (readArrival): what a rule of the
   * business reads a parameter from by name. Used only when this function names the lead.
   */
  readonly address?: string | undefined;
  /**
   * How the lead was named, when the caller already asked (a form does, to write the
   * contact's Source before the touch). Left out, the business's rules are read here.
   */
  readonly decision?: LeadDecision | undefined;
  /** What recorded it, by its own id. */
  readonly subject: {
    readonly kind: 'form_submission' | 'appointment' | 'webchat_session' | 'external_submission';
    readonly id: string;
  };
}

/**
 * Records an interaction's touch on a contact of this business. The contact's row is held
 * first, so two interactions of one contact are written one after the other and exactly
 * one touch is the latest. A contact that is gone records nothing.
 *
 * The touch carries the lead source the business's own rules give it, else the built-in
 * one (lead-source-rules.ts): one read of the rules, unless the caller hands the decision
 * over. The decision is answered, for whoever applies the rules' tags and field values.
 */
export async function recordTouch(
  trx: DatabaseTransaction,
  businessId: string,
  input: TouchInput,
): Promise<LeadDecision | undefined> {
  const contact = await trx
    .selectFrom('crm.contacts')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', input.contactId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (contact === undefined) return undefined;
  const decision =
    input.decision ??
    (await decideLeadSourceFor(trx, businessId, {
      medium: input.medium,
      visit: input.visit,
      pageUrl: input.page === undefined ? input.visit.landingUrl : input.page.url,
      address: input.address,
    }));
  const values = {
    ...columnsOf(input.medium, input.visit, input.page, decision),
    subject_kind: input.subject.kind,
    subject_id: input.subject.id,
  };
  // The touch this same transaction made the contact with (now() is the transaction's own
  // start, and only that touch carries it with the contact as its subject): filled in.
  const filled = await trx
    .updateTable('crm.contact_attributions')
    .set(values)
    .where('business_id', '=', businessId)
    .where('contact_id', '=', input.contactId)
    .where('subject_kind', '=', 'contact')
    .where('is_first', '=', true)
    .where('is_latest', '=', true)
    .where('created_at', '=', sql<Date>`now()`)
    .returning('id')
    .executeTakeFirst();
  if (filled !== undefined) return decision;
  const before = await trx
    .updateTable('crm.contact_attributions')
    .set({ is_latest: false })
    .where('business_id', '=', businessId)
    .where('contact_id', '=', input.contactId)
    .where('is_latest', '=', true)
    .returning('id')
    .executeTakeFirst();
  await trx
    .insertInto('crm.contact_attributions')
    .values({
      business_id: businessId,
      contact_id: input.contactId,
      ...values,
      // A contact from before touches were kept, with none: this one is its first too.
      is_first: before === undefined,
      is_latest: true,
    })
    .execute();
  return decision;
}

const medium = z.enum(attributionMediums);
const sessionSource = z.enum(sessionSources);

/**
 * Which click ids a touch holds, asked of the database as the names of the columns that are
 * filled (the names are the columns' own). The values are never selected: a click id stays
 * where it is stored, and what is not read cannot be sent.
 */
const heldClickIds = sql<ClickIdName[]>`array_remove(array[
  case when gclid is not null then 'gclid' end,
  case when gbraid is not null then 'gbraid' end,
  case when wbraid is not null then 'wbraid' end,
  case when fbclid is not null then 'fbclid' end,
  case when msclkid is not null then 'msclkid' end,
  case when ctwa_clid is not null then 'ctwa_clid' end,
  case when ttclid is not null then 'ttclid' end,
  case when li_fat_id is not null then 'li_fat_id' end
], null)`;

/** What a contact's page reads of a touch: every column but the click ids. */
const SHOWN = [
  'is_first',
  'is_latest',
  'touched_at',
  'medium',
  'session_source',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'match_type',
  'campaign_id',
  'ad_group_id',
  'ad_id',
  'referrer_domain',
  'landing_url',
  'page_url',
  'source_label',
  'source_rule',
  'arrival_carried',
] as const;

interface ShownTouch {
  readonly touched_at: Date;
  readonly medium: string;
  readonly session_source: string;
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
  readonly source_label: string | null;
  readonly source_rule: string | null;
  readonly arrival_carried: boolean;
  readonly click_ids: readonly ClickIdName[];
}

const present = (row: ShownTouch): ContactAttribution => ({
  touchedAt: row.touched_at.toISOString(),
  // The table's own constraints allow nothing else.
  medium: medium.parse(row.medium),
  sessionSource: sessionSource.parse(row.session_source),
  utmSource: row.utm_source,
  utmMedium: row.utm_medium,
  utmCampaign: row.utm_campaign,
  utmContent: row.utm_content,
  utmTerm: row.utm_term,
  matchType: row.match_type,
  campaignId: row.campaign_id,
  adGroupId: row.ad_group_id,
  adId: row.ad_id,
  referrerDomain: row.referrer_domain,
  landingUrl: row.landing_url,
  pageUrl: row.page_url,
  source: row.source_label,
  sourceRule: row.source_rule,
  arrivalCarried: row.arrival_carried,
  // Which are held: what a screen shows, in place of the values.
  clickIds: [...row.click_ids],
});

/** A contact's first and latest touch, also of a contact in the trash. */
export async function readContactAttribution(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<ContactAttributions> {
  const businessId = requireBusiness(invocation.context);
  const contactId = parsePublicId('contact', id);
  const contact =
    contactId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.contacts')
          .select('id')
          .where('business_id', '=', businessId)
          .where('id', '=', contactId)
          .executeTakeFirst();
  if (contact === undefined) throw new NotFoundError('Contact', id);
  const rows = await trx
    .selectFrom('crm.contact_attributions')
    .select(SHOWN)
    .select(heldClickIds.as('click_ids'))
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contact.id)
    .where((eb) => eb.or([eb('is_first', '=', true), eb('is_latest', '=', true)]))
    .execute();
  const first = rows.find((row) => row.is_first);
  const latest = rows.find((row) => row.is_latest);
  return {
    first: first === undefined ? null : present(first),
    latest: latest === undefined ? null : present(latest),
  };
}

/**
 * The source a new opportunity takes when nobody names one: the lead source of the
 * touch a form submission or a booking recorded, when one is named and has one; else the
 * contact's own Source; else nothing. Nothing is written.
 */
export async function readLeadSourceDefault(
  trx: DatabaseTransaction,
  businessId: string,
  input: {
    /** crm.contacts.id. */
    readonly contactId: string;
    /** What started it, by its own id: the touch it recorded is read. */
    readonly subject?:
      | {
          readonly kind: 'form_submission' | 'appointment' | 'webchat_session';
          readonly id: string;
        }
      | undefined;
  },
): Promise<string | null> {
  if (input.subject !== undefined) {
    const touch = await trx
      .selectFrom('crm.contact_attributions')
      .select('source_label')
      .where('business_id', '=', businessId)
      .where('contact_id', '=', input.contactId)
      .where('subject_kind', '=', input.subject.kind)
      .where('subject_id', '=', input.subject.id)
      .executeTakeFirst();
    const label = touch?.source_label ?? null;
    if (label !== null) return label;
  }
  const contact = await trx
    .selectFrom('crm.contacts')
    .select('source')
    .where('business_id', '=', businessId)
    .where('id', '=', input.contactId)
    .executeTakeFirst();
  const source = contact?.source?.trim() ?? '';
  return source === '' ? null : source;
}
