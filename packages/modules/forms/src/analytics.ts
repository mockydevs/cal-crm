// A form's numbers against Postgres (migration 0078): counting a view and a timed
// submission into the day's row, and reading a range of days for the Analytics tab.
//
// A view is the published form's questions being served. It is counted once for each
// request, whoever makes it: nothing tells one visitor from another, so a page loaded
// twice is two views. Responses are the stored submissions, by the day they were sent.
import { requireBusiness, type Invocation } from '@repo/commands';
import type { FormAnalytics } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';

import { analyticsRange, formNumbers } from './analytics-rules.js';

/**
 * Adds to the row of this form and today, making the row when it is the day's first. The
 * day is the business's own calendar day, by the database's clock.
 */
async function count(
  trx: DatabaseTransaction,
  businessId: string,
  formId: string,
  add: { readonly views: number; readonly timed: number; readonly seconds: number },
): Promise<void> {
  await sql`
    insert into forms.daily_stats (business_id, form_id, day, views, timed_submissions, fill_seconds)
    select b.id, ${formId}::uuid, (clock_timestamp() at time zone b.timezone)::date,
           ${add.views}::integer, ${add.timed}::integer, ${add.seconds}::integer
    from tenancy.businesses b
    where b.id = ${businessId}::uuid
    on conflict (business_id, form_id, day) do update
      set views = forms.daily_stats.views + excluded.views,
          timed_submissions = forms.daily_stats.timed_submissions + excluded.timed_submissions,
          fill_seconds = forms.daily_stats.fill_seconds + excluded.fill_seconds
  `.execute(trx);
}

/** The published form was shown once more. */
export const countView = (
  trx: DatabaseTransaction,
  businessId: string,
  formId: string,
): Promise<void> => count(trx, businessId, formId, { views: 1, timed: 0, seconds: 0 });

/** A submission was stored, this many seconds after its form was shown. */
export const countTimedSubmission = (
  trx: DatabaseTransaction,
  businessId: string,
  formId: string,
  seconds: number,
): Promise<void> => count(trx, businessId, formId, { views: 0, timed: 1, seconds });

/** A form's numbers over a range of days, as anyone in the business may read them. */
export async function readFormAnalytics(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  query: { readonly from?: string | undefined; readonly to?: string | undefined },
): Promise<FormAnalytics> {
  const businessId = requireBusiness(invocation.context);
  const id = parsePublicId('form', publicId);
  const form =
    id === undefined
      ? undefined
      : await trx.selectFrom('forms.forms').select('id').where('id', '=', id).executeTakeFirst();
  if (form === undefined) throw new NotFoundError('Form', publicId);
  const {
    rows: [zone],
  } = await sql<{ time_zone: string; today: string }>`
    select b.timezone as time_zone,
           to_char((now() at time zone b.timezone)::date, 'YYYY-MM-DD') as today
    from tenancy.businesses b
    where b.id = ${businessId}::uuid
  `.execute(trx);
  if (zone === undefined) throw new Error('The business of this request is not there.');
  const range = analyticsRange(query, zone.today);
  if (!range.ok) throw new ValidationError([range.issue]);

  const counted = await trx
    .selectFrom('forms.daily_stats')
    .select([
      sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'),
      'views',
      'timed_submissions',
      'fill_seconds',
    ])
    .where('business_id', '=', businessId)
    .where('form_id', '=', form.id)
    .where('day', '>=', sql<Date>`${range.from}::date`)
    .where('day', '<=', sql<Date>`${range.to}::date`)
    .execute();
  // The submissions of those days as the business's calendar has them, read through the
  // index on the form and the time it was sent (0008). The time zone is the business's own
  // row's, as it is where a view is counted.
  const { rows: sent } = await sql<{ day: string; count: number }>`
    select to_char((s.submitted_at at time zone b.timezone)::date, 'YYYY-MM-DD') as day,
           count(*)::integer as count
    from forms.submissions s
    join tenancy.businesses b on b.id = s.business_id
    where s.business_id = ${businessId}::uuid
      and s.form_id = ${form.id}::uuid
      and s.submitted_at >= (${range.from}::date::timestamp at time zone b.timezone)
      and s.submitted_at < ((${range.to}::date + 1)::timestamp at time zone b.timezone)
    group by 1
  `.execute(trx);
  return formNumbers(
    { from: range.from, to: range.to, timeZone: zone.time_zone },
    counted.map((row) => ({
      day: row.day,
      views: row.views,
      timedSubmissions: row.timed_submissions,
      fillSeconds: row.fill_seconds,
    })),
    new Map(sent.map((row) => [row.day, row.count])),
  );
}
