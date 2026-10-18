// The numbers of the Dashboard's email widgets over a range of dates. Each thing is counted
// on the day it happened, in the business's time zone, by PostgreSQL: the emails sent by
// sent_at, the ones refused or bounced by failed_at, the ones received by created_at and
// the withdrawals of consent by recorded_at, each read from an index on the business and
// that date (0077). Only the counts leave the database: the numbers are put together from
// them in email-report-rules.ts. Nothing is stored.
//
// What a message does not record is not answered: a mail server never confirms delivery
// (delivered_at is only ever set for a text message), and opens and clicks are not tracked.
import { requireBusiness, type Invocation } from '@repo/commands';
import type { EmailReport, emailReportQuery } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';
import * as z from 'zod';

import { emailMetrics, emailNumbers } from './email-report-rules.js';

const metric = z.enum(emailMetrics);

export async function readEmailReport(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof emailReportQuery>,
): Promise<EmailReport> {
  const businessId = requireBusiness(invocation.context);
  // The range's ends go to PostgreSQL as written: a JavaScript Date would cut them to the
  // millisecond. The last day is the one the range's last microsecond falls on.
  const from = sql`${query.from}::timestamptz`;
  const to = sql`${query.to}::timestamptz`;
  const {
    rows: [range],
  } = await sql<{ time_zone: string; days: string[] }>`
    select b.timezone as time_zone,
      array(
        select to_char(day, 'YYYY-MM-DD')
        from generate_series(
          (${from} at time zone b.timezone)::date::timestamp,
          ((${to} - interval '1 microsecond') at time zone b.timezone)::date::timestamp,
          interval '1 day'
        ) as day
        order by day
      ) as days
    from tenancy.businesses b
    where b.id = ${businessId}
  `.execute(trx);
  if (range === undefined) throw new Error('The business of this request is not there.');

  const day = (moment: string) => sql`(${sql.ref(moment)} at time zone z.tz)::date`;
  const within = (moment: string) =>
    sql`${sql.ref(moment)} >= ${from} and ${sql.ref(moment)} < ${to}`;
  const { rows } = await sql<{ day: string; metric: string; detail: string | null; count: number }>`
    with zone as (select b.timezone as tz from tenancy.businesses b where b.id = ${businessId})
    select to_char(counted.day, 'YYYY-MM-DD') as day, counted.metric, counted.detail,
           counted.count
    from (
      -- Sent: a mail server accepted it. A workflow's email is known by its lane; the
      -- assistant's by its author, or by the proposal a person approved.
      select ${day('m.sent_at')} as day, 'sent' as metric,
             case when d.lane = 'automation' then 'workflow'
                  when m.author_kind = 'ai_agent' or m.proposal_id is not null then 'assistant'
                  when m.author_kind = 'user' then 'person'
                  else 'other' end as detail,
             count(*)::integer as count
      from messaging.messages m
      cross join zone z
      left join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
      where m.business_id = ${businessId} and m.channel = 'email' and m.direction = 'outbound'
        and ${within('m.sent_at')}
      group by 1, 3
      union all
      -- Refused before or at the mail server, by its reason; or bounced, hard or soft.
      select ${day('m.failed_at')}, case when m.status = 'bounced' then 'bounced' else 'not_sent' end,
             coalesce(m.error_code, 'unknown'), count(*)::integer
      from messaging.messages m
      cross join zone z
      where m.business_id = ${businessId} and m.channel = 'email' and m.direction = 'outbound'
        and m.status in ('failed', 'bounced') and ${within('m.failed_at')}
      group by 1, 2, 3
      union all
      -- Received. A reply answers a stored email of ours (inbound.ts proves the parent),
      -- and is not an automatic answer.
      select ${day('m.created_at')}, 'received',
             case when p.id is not null and not m.automated then 'reply' else 'other' end,
             count(*)::integer
      from messaging.messages m
      cross join zone z
      left join messaging.messages p
        on p.business_id = m.business_id and p.id = m.parent_message_id
       and p.direction = 'outbound'
      where m.business_id = ${businessId} and m.channel = 'email' and m.direction = 'inbound'
        and ${within('m.created_at')}
      group by 1, 3
      union all
      -- Unsubscribed: marketing email consent withdrawn, where the consent before it was
      -- not already withdrawn. An import's row records history, not that day.
      select ${day('c.recorded_at')}, 'unsubscribed', null, count(*)::integer
      from messaging.consents c
      cross join zone z
      where c.business_id = ${businessId} and c.channel = 'email' and c.status = 'withdrawn'
        and c.purpose = 'marketing' and c.source <> 'import' and ${within('c.recorded_at')}
        and coalesce((
          select earlier.status from messaging.consents earlier
          where earlier.business_id = c.business_id and earlier.contact_id = c.contact_id
            and earlier.channel = c.channel and earlier.purpose = c.purpose
            and (earlier.recorded_at, earlier.id) < (c.recorded_at, c.id)
          order by earlier.recorded_at desc, earlier.id desc limit 1), 'unknown') <> 'withdrawn'
      group by 1
    ) counted
  `.execute(trx);

  return {
    from: query.from,
    to: query.to,
    timeZone: range.time_zone,
    ...emailNumbers(
      range.days,
      rows.map((row) => ({
        day: row.day,
        // The statement above names nothing else.
        metric: metric.parse(row.metric),
        detail: row.detail,
        count: row.count,
      })),
    ),
  };
}
