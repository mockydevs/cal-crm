// The catalogue's sources as SQL: for each source the table it counts, the dates a range
// reads, and the column behind every dimension and number field the catalogue lists. This
// file and the catalogue (packages/contracts: reporting-sources.ts) are the only places a
// column is named; the engine joins them with values that are always parameters. A test
// holds the two to each other, key for key.
//
// The reporting module reads other modules' tables and writes none of them: it is the one
// reader across schemas, as a read model is. Every statement runs in the request's tenant
// transaction, so row-level security decides the rows.
import type { ReportSourceKey } from '@repo/contracts';
import { sql, type RawBuilder } from 'kysely';

export type Sql = RawBuilder<unknown>;

export interface SourceShape {
  /** The table counted, with its alias. */
  readonly from: Sql;
  /** The alias's business column. */
  readonly business: Sql;
  /** What is always left out, such as rows in the trash. */
  readonly fixed: Sql;
  readonly dates: Readonly<Record<string, Sql>>;
  /** The column of each dimension that is the source's own. Text, or a uuid for a reference. */
  readonly columns: Readonly<Record<string, Sql>>;
  readonly numbers: Readonly<Record<string, Sql>>;
  /**
   * How the contact's touch `ca` is joined, given the test of which touch; null when the
   * source is the touches themselves.
   */
  readonly touch: ((which: Sql) => Sql) | null;
  /** The amount and currency money measures add up; null for a source without money. */
  readonly money: { readonly amount: Sql; readonly currency: Sql } | null;
}

/** The contact's attribution, by dimension: columns of the touch joined as `ca`. */
export const touchColumns: Readonly<Record<string, Sql>> = {
  leadSource: sql`ca.source_label`,
  sessionSource: sql`ca.session_source`,
  medium: sql`ca.medium`,
  utmSource: sql`ca.utm_source`,
  utmMedium: sql`ca.utm_medium`,
  utmCampaign: sql`ca.utm_campaign`,
  utmContent: sql`ca.utm_content`,
  utmTerm: sql`ca.utm_term`,
  campaignId: sql`ca.campaign_id`,
  referrerDomain: sql`ca.referrer_domain`,
  landingPage: sql`ca.landing_url`,
};

const touchOf =
  (business: Sql, contact: Sql, before: Sql = sql``) =>
  (which: Sql): Sql => sql`${before}
    left join crm.contact_attributions ca
      on ca.business_id = ${business} and ca.contact_id = ${contact} and ${which}`;

export const sourceShapes: Readonly<Record<ReportSourceKey, SourceShape>> = {
  contacts: {
    from: sql`crm.contacts c`,
    business: sql`c.business_id`,
    fixed: sql`c.deleted_at is null`,
    dates: { created: sql`c.created_at` },
    columns: {
      createdSource: sql`c.created_source`,
      source: sql`nullif(btrim(c.source), '')`,
      type: sql`c.contact_type`,
      owner: sql`c.owner_user_id`,
      // Joined only when a query groups by it (engine.ts): one row for each tag.
      tag: sql`rt.tag_id`,
    },
    numbers: {},
    touch: touchOf(sql`c.business_id`, sql`c.id`),
    money: null,
  },
  opportunities: {
    from: sql`crm.deals d`,
    business: sql`d.business_id`,
    fixed: sql`d.deleted_at is null`,
    dates: {
      created: sql`d.created_at`,
      statusChanged: sql`d.status_changed_at`,
      closed: sql`d.closed_at`,
    },
    columns: {
      status: sql`d.status`,
      pipeline: sql`d.pipeline_id`,
      stage: sql`d.stage_id`,
      owner: sql`d.owner_user_id`,
      source: sql`nullif(btrim(d.source), '')`,
      lostReason: sql`d.lost_reason_id`,
    },
    numbers: { value: sql`d.amount` },
    // An opportunity's attribution is its primary contact's: the one primary link of the
    // deal_contact type (crm: deals/contacts.ts).
    touch: touchOf(
      sql`d.business_id`,
      sql`pl.to_record_id`,
      sql`
    left join crm.link_types lt on lt.business_id = d.business_id and lt.key = 'deal_contact'
    left join crm.record_links pl
      on pl.business_id = d.business_id and pl.from_record_id = d.id
     and pl.link_type_id = lt.id and pl.is_primary`,
    ),
    money: { amount: sql`d.amount`, currency: sql`d.currency` },
  },
  appointments: {
    from: sql`calendar.appointments a`,
    business: sql`a.business_id`,
    fixed: sql`true`,
    dates: {
      starts: sql`a.starts_at`,
      created: sql`a.created_at`,
      cancelled: sql`a.cancelled_at`,
    },
    columns: {
      status: sql`a.status`,
      calendar: sql`a.calendar_id`,
      assignee: sql`a.assigned_user_id`,
      bookingSource: sql`a.source`,
    },
    numbers: {},
    touch: touchOf(sql`a.business_id`, sql`a.contact_id`),
    money: null,
  },
  attribution: {
    from: sql`crm.contact_attributions ca`,
    business: sql`ca.business_id`,
    // A touch's contact is always there (a foreign key), so "its contact is not in the trash"
    // is "no contact of it is in the trash": a lookup in the few trashed ones
    // (contacts_trash_idx), rather than a join with every contact of the business.
    fixed: sql`not exists (select 1 from crm.contacts c
      where c.business_id = ca.business_id and c.id = ca.contact_id and c.deleted_at is not null)`,
    dates: { touched: sql`ca.touched_at` },
    columns: {},
    numbers: {},
    touch: null,
    money: null,
  },
};
