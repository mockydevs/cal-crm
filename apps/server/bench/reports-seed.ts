// The large business the reporting benchmark reads (reports.bench.ts), beside three small
// neighbours, written straight into the tables as the owner role (no row-level security),
// then vacuumed and analysed as autovacuum would have by the time a business is this size.
//
// The large business, and why (a large GoHighLevel-style sub-account, three years old):
//   250,000 contacts             a large agency client; 2 % in the trash
//   ~375,000 touches             every contact's first touch, half with a later one
//   ~370,000 tags on contacts    40 tags, up to three each
//   100,000 opportunities        3 pipelines of 6 stages, each with its primary contact
//   50,000 appointments          8 calendars, 20 people, some still to come
// Rows are written in the order of their dates, as a business accumulates them. Messages
// and workflow runs are not seeded: no report of the reporting module reads them.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import { connectPool } from '@repo/db';
import type { Sql, TestDatabase } from '@repo/testing';

const LARGE = {
  contacts: 250_000,
  opportunities: 100_000,
  appointments: 50_000,
  tags: 40,
  team: 20,
  calendars: 8,
};
const NEIGHBOUR = { contacts: 20_000, opportunities: 8_000, appointments: 4_000 };
const YEARS_DAYS = 1095;

export interface Business {
  readonly id: string;
  readonly invocation: Invocation;
  readonly pipelineId: string;
  readonly tagId: string;
  readonly calendarId: string;
}

/** A CASE that picks one of the values by a random number in [0, 1): weights in order. */
function pick(column: string, choices: readonly (readonly [number, string])[]): string {
  let edge = 0;
  const arms = choices.map(([weight, value]) => {
    edge += weight;
    return `when ${column} < ${edge.toFixed(4)} then ${value}`;
  });
  return `(case ${arms.join(' ')} else ${choices.at(-1)?.[1] ?? 'null'} end)`;
}

const SESSION_SOURCES: readonly (readonly [number, string])[] = [
  [0.24, `'paid_search'`],
  [0.16, `'paid_social'`],
  [0.1, `'social_media'`],
  [0.18, `'organic_search'`],
  [0.08, `'referral'`],
  [0.14, `'direct'`],
  [0.05, `'crm_ui'`],
  [0.03, `'third_party'`],
  [0.02, `'others'`],
];

interface Sizes {
  readonly contacts: number;
  readonly opportunities: number;
  readonly appointments: number;
}

/** One business's rows, as the owner role writes them (no row-level security). */
async function seed(
  database: TestDatabase,
  businessId: string,
  sizes: Sizes,
  team: readonly string[],
  seedValue: number,
): Promise<{ pipelineId: string; tagId: string; calendarId: string }> {
  return database.as('crm_owner', async (sql: Sql) => {
    await sql.query('select setseed($1)', [seedValue]);
    // Contacts, oldest first, over three years.
    await sql.query(
      `with ot as (select id from crm.object_types where business_id = $1 and kind = 'contact'),
       made as (
         insert into crm.records (business_id, kind, object_type_id)
         select $1, 'contact', ot.id from ot, generate_series(1, $2) returning id),
       numbered as (
         select id, row_number() over (order by id) as n, random() as a, random() as b,
                random() as c, random() as d
         from made offset 0)
       insert into crm.contacts
         (business_id, id, first_name, last_name, created_by_kind, created_source, source,
          contact_type, owner_user_id, created_at, deleted_at)
       select $1, id, 'Lead', 'Number ' || n, 'user',
              ${pick('a', [
                [0.45, `'form'`],
                [0.15, `'booking'`],
                [0.1, `'webchat'`],
                [0.1, `'import'`],
                [0.1, `'user'`],
                [0.05, `'api'`],
                [0.05, `'sms'`],
              ])},
              ${pick('b', [
                [0.2, `'Google Ads'`],
                [0.15, `'Facebook Ad'`],
                [0.15, `'Website'`],
                [0.1, `'Referral'`],
                [0.1, `'Walk-in'`],
                [0.3, `null`],
              ])},
              case when c < 0.7 then 'lead' else 'customer' end,
              case when d < 0.15 then null
                   else ($3::uuid[])[1 + floor(d * cardinality($3::uuid[]))::int] end,
              now() - make_interval(days => ${String(YEARS_DAYS)}) +
                (n - 1 + a) * make_interval(days => ${String(YEARS_DAYS)}) / $2,
              null
       from numbered`,
      [businessId, sizes.contacts, team],
    );
    await sql.query(
      `update crm.contacts set deleted_at = least(created_at + interval '1 day', now())
       where business_id = $1 and random() < 0.02`,
      [businessId],
    );
    await sql.query(
      `create temporary table bench_contacts on commit drop as
       select id, created_at, row_number() over (order by created_at, id) as n,
              random() as a, random() as b, random() as c, random() as d, random() as e
       from crm.contacts where business_id = $1`,
      [businessId],
    );
    await sql.query('create index on bench_contacts (n)');
    // Touches: the first, at the contact's making; half have a later one.
    const touch = (when: string, first: string, latest: string, from: string) => `
      insert into crm.contact_attributions
        (business_id, contact_id, touched_at, medium, session_source, utm_source, utm_medium,
         utm_campaign, referrer_domain, landing_url, subject_kind, subject_id, is_first,
         is_latest, source_label, source_rule)
      select $1, id, ${when}, medium, ss,
             case ss when 'paid_search' then 'google' when 'paid_social'
                  then (case when e < 0.5 then 'facebook' else 'instagram' end) end,
             case when ss in ('paid_search', 'paid_social') then 'cpc' end,
             case when ss in ('paid_search', 'paid_social')
                  then 'campaign-' || (1 + floor(e * 60))::int end,
             case ss when 'organic_search' then (case when e < 0.8 then 'google.com' else 'bing.com' end)
                     when 'referral' then 'partner' || (1 + floor(e * 300))::int || '.example'
                     when 'social_media' then 'facebook.com' end,
             'https://www.example.com/lp/' || (1 + floor(d * 25))::int,
             'contact', id, ${first}, ${latest}, label,
             case when label is not null then 'bench' end
      from (select id, created_at, a, d, e,
                   ${pick('d', [
                     [0.2, `'Google Ads'`],
                     [0.15, `'Facebook Ads'`],
                     [0.15, `'Organic Search'`],
                     [0.1, `'Referral'`],
                     [0.4, `null::text`],
                   ])} as label,
                   ${pick(from, SESSION_SOURCES)} as ss,
                   ${pick('c', [
                     [0.55, `'form'`],
                     [0.2, `'calendar'`],
                     [0.1, `'chat'`],
                     [0.1, `'manual'`],
                     [0.05, `'import'`],
                   ])} as medium
            from bench_contacts ${from === 'e' ? 'where a < 0.5' : ''} offset 0) t`;
    await sql.query(touch('created_at', 'true', 'a >= 0.5', 'b'), [businessId]);
    await sql.query(touch('created_at + (now() - created_at) * d', 'false', 'true', 'e'), [
      businessId,
    ]);
    // Tags.
    await sql.query(
      `insert into crm.tags (business_id, name, created_by_kind)
       select $1, 'Tag ' || g, 'user' from generate_series(1, ${String(LARGE.tags)}) g`,
      [businessId],
    );
    await sql.query(
      `insert into crm.record_tags (business_id, record_id, tag_id, source_kind)
       select $1, x.id, t.id, 'user'
       from (select c.id, 1 + floor(random() * ${String(LARGE.tags)})::int as i
             from bench_contacts c, generate_series(1, 3) k where random() < 0.5 offset 0) x
       join (select id, row_number() over (order by id) as i from crm.tags where business_id = $1) t
         on t.i = x.i
       on conflict do nothing`,
      [businessId],
    );
    // Pipelines, stages, lost reasons.
    const pipelines: string[] = [];
    const stages: string[] = [];
    for (const [position, name] of ['Sales', 'Renewals', 'Partners'].entries()) {
      const { id } = await sql.one<{ id: string }>(
        'insert into crm.pipelines (business_id, name, position) values ($1, $2, $3) returning id',
        [businessId, name, position],
      );
      pipelines.push(id);
      for (const [index, stage] of [
        'New',
        'Contacted',
        'Qualified',
        'Proposal',
        'Negotiation',
        'Closing',
      ].entries())
        stages.push(
          (
            await sql.one<{ id: string }>(
              `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
               values ($1, $2, $3, $4) returning id`,
              [businessId, id, stage, index],
            )
          ).id,
        );
    }
    const reasons = await sql.query<{ id: string }>(
      `insert into crm.lost_reasons (business_id, label, position)
       select $1, 'Reason ' || g, g from generate_series(1, 6) g returning id`,
      [businessId],
    );
    await sql.query(
      `insert into crm.link_types
         (business_id, key, from_object_type_id, to_object_type_id, label, reverse_label, allows_primary)
       select $1, 'deal_contact', d.id, c.id, 'Contacts', 'Deals', true
       from crm.object_types d, crm.object_types c
       where d.business_id = $1 and d.kind = 'deal' and c.business_id = $1 and c.kind = 'contact'
       on conflict do nothing`,
      [businessId],
    );
    // Opportunities, oldest first, each with a contact made a little before it.
    await sql.query(
      `create temporary table bench_deals on commit drop as
       with ot as (select id from crm.object_types where business_id = $1 and kind = 'deal'),
       made as (
         insert into crm.records (business_id, kind, object_type_id)
         select $1, 'deal', ot.id from ot, generate_series(1, $2) returning id)
       select id, row_number() over (order by id) as n, random() as a, random() as b,
              random() as c, random() as d, random() as e, random() as f
       from made`,
      [businessId, sizes.opportunities],
    );
    await sql.query(
      `insert into crm.deals
         (business_id, id, name, pipeline_id, stage_id, status, amount, currency, source,
          owner_user_id, lost_reason_id, created_by_kind, created_at, closed_at)
       select $1, id, 'Deal ' || n, ($3::uuid[])[1 + pi], ($4::uuid[])[1 + pi * 6 + floor(c * 6)::int],
              status, case when f < 0.05 then null else round((500 + f * 19500)::numeric, 2) end,
              'USD', case when f < 0.5 then 'Inbound' else 'Outbound' end,
              ($5::uuid[])[1 + floor(e * cardinality($5::uuid[]))::int],
              case when status = 'lost' then ($6::uuid[])[1 + floor(f * 6)::int] end,
              'user', created_at,
              case when status <> 'open'
                   then created_at + least(now() - created_at, interval '60 days') * d end
       from (select id, n, c, d, e, f, created_at,
                    case when b < 0.6 then 0 when b < 0.85 then 1 else 2 end as pi,
                    case when now() - created_at > interval '90 days'
                         then (case when a < 0.3 then 'won' when a < 0.8 then 'lost' else 'open' end)
                         else (case when a < 0.12 then 'won' when a < 0.25 then 'lost' else 'open' end)
                    end as status
             from (select *, now() - make_interval(days => ${String(YEARS_DAYS)}) +
                     (n - 1 + a) * make_interval(days => ${String(YEARS_DAYS)}) / $2 as created_at
                   from bench_deals) dated offset 0) x`,
      [businessId, sizes.opportunities, pipelines, stages, team, reasons.map((each) => each.id)],
    );
    const contacts = sizes.contacts;
    await sql.query(
      `insert into crm.record_links
         (business_id, link_type_id, from_record_id, to_record_id, is_primary, source_kind)
       select $1, lt.id, d.id, c.id, true, 'user'
       from bench_deals d
       join bench_contacts c
         on c.n = greatest(1, floor(d.n::numeric / $2 * $3 * (0.9 + 0.1 * d.b)))::int
       cross join (select id from crm.link_types where business_id = $1 and key = 'deal_contact') lt`,
      [businessId, sizes.opportunities, contacts],
    );
    await sql.query(
      `update crm.deals d set deleted_at = d.created_at + interval '1 day'
       where d.business_id = $1 and random() < 0.01`,
      [businessId],
    );
    // Calendars and appointments: one each half hour, the team in turn, so nobody is double
    // booked; 2.85 years of them, ending about six weeks from now.
    const calendars = await sql.query<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       select $1, 'Calendar ' || g, 'personal', 'America/Chicago', 'cal-' || g || '-' || $2
       from generate_series(1, ${String(LARGE.calendars)}) g returning id`,
      [businessId, randomUUID().slice(0, 8)],
    );
    await sql.query(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at,
          status, source, cancelled_at, created_at)
       select $1, ($3::uuid[])[1 + floor(x.a * cardinality($3::uuid[]))::int], c.id,
              case when x.g % 10 = 0 then null
                   else ($4::uuid[])[1 + x.g % cardinality($4::uuid[])] end,
              'Visit', x.starts, x.starts + interval '30 minutes', x.status, x.source,
              case when x.status = 'cancelled'
                   then least(x.created + (x.starts - x.created) / 2, now()) end,
              x.created
       from (select g, a, starts, least(starts - interval '14 days' * b, now()) as created,
                    case when starts < now()
                         then ${pick('d', [
                           [0.55, `'completed'`],
                           [0.1, `'no_show'`],
                           [0.15, `'cancelled'`],
                           [0.02, `'invalid'`],
                           [0.1, `'confirmed'`],
                           [0.08, `'booked'`],
                         ])}
                         else ${pick('d', [
                           [0.5, `'booked'`],
                           [0.35, `'confirmed'`],
                           [0.15, `'cancelled'`],
                         ])} end as status,
                    ${pick('e', [
                      [0.5, `'booking_page'`],
                      [0.25, `'user'`],
                      [0.1, `'ai_agent'`],
                      [0.1, `'automation'`],
                      [0.05, `'api'`],
                    ])} as source,
                    greatest(1, floor(g::numeric / $2 * $5 * 0.95))::int as n
             from (select g, random() as a, random() as b, random() as d, random() as e,
                          now() - interval '1000 days' + g * interval '30 minutes' as starts
                   from generate_series(1, $2) g offset 0) r offset 0) x
       join bench_contacts c on c.n = x.n`,
      [businessId, sizes.appointments, calendars.map((each) => each.id), team, contacts],
    );
    const [pipelineId] = pipelines;
    const tag = await sql.one<{ id: string }>(
      `select id from crm.tags where business_id = $1 order by id limit 1`,
      [businessId],
    );
    const [calendar] = calendars;
    if (pipelineId === undefined || calendar === undefined) throw new Error('Nothing seeded.');
    return { pipelineId, tagId: tag.id, calendarId: calendar.id };
  });
}

/** A business of the agency, its team on it, as reporting-fixtures.ts makes one. */
async function business(
  database: TestDatabase,
  agencyId: string,
  sizes: Sizes,
  seedValue: number,
): Promise<Business> {
  const made = await database.fixtures.business(agencyId);
  const team: string[] = [];
  for (let index = 0; index < LARGE.team; index += 1)
    team.push((await database.fixtures.user({ name: `Member ${String(index + 1)}` })).id);
  await database.as('crm_owner', async (sql) => {
    await sql.query(`update tenancy.businesses set timezone = 'America/Chicago' where id = $1`, [
      made.id,
    ]);
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name)
       values ($1, 'business', $2, 'Member') returning id`,
      [agencyId, `member_${randomUUID().slice(0, 8)}`],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select unnest($1::uuid[]), $2, $3, $4`,
      [team, agencyId, made.id, role.id],
    );
  });
  const seeded = await seed(database, made.id, sizes, team, seedValue);
  const [viewer] = team;
  if (viewer === undefined) throw new Error('No team.');
  return {
    id: made.id,
    ...seeded,
    invocation: {
      context: {
        ...made.context,
        actorKind: 'user',
        actorId: viewer,
        userId: viewer,
        correlationId: randomUUID(),
      },
      permissions: 'all',
    },
  };
}

/** The large business and its neighbours, vacuumed and analysed: the large one. */
export async function seedReporting(database: TestDatabase): Promise<Business> {
  const agency = await database.fixtures.agency();
  const large = await business(database, agency.id, LARGE, 0.42);
  for (const [index, value] of [0.1, 0.2, 0.3].entries())
    await business(database, agency.id, NEIGHBOUR, value + index / 100);
  // What autovacuum would have done by the time a business is this size. VACUUM cannot run
  // in a transaction, so it has a connection of its own.
  const ownerPool = connectPool({
    connectionString: database.url('crm_owner'),
    onConnectionError: () => undefined,
  });
  try {
    for (const table of [
      'crm.records',
      'crm.contacts',
      'crm.contact_attributions',
      'crm.record_tags',
      'crm.deals',
      'crm.record_links',
      'calendar.appointments',
    ])
      await ownerPool.query(`vacuum (analyze) ${table}`);
  } finally {
    await ownerPool.end();
  }
  return large;
}
