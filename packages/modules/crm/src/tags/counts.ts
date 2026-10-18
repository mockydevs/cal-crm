// A report rollup: how many tags each business creates a day. A consumer of tag.created, as
// ARCHITECTURE.md section 5.3 has report rollups kept up to date.
import { defineTask } from '@repo/commands';
import { withTenant } from '@repo/db';
import { sql } from 'kysely';
import * as z from 'zod';

/** The metric in reporting.daily_metrics. */
export const TAGS_CREATED = 'crm.tags_created';

/**
 * Recounts the tags created on the day this one was, in the business's time zone. It counts
 * the day's tag.created events rather than adding one, so a job that runs twice leaves the
 * same number.
 */
export const countTagsCreated = defineTask({
  name: 'tags.count_created',
  data: z.strictObject({ tagId: z.uuid() }),
  async run({ tagId }, { invocation, services }) {
    await withTenant(services.db, invocation.context, async (trx) => {
      await sql`
        with created as (
          select (e.occurred_at at time zone b.timezone)::date as day, b.timezone
          from events.events e
          join tenancy.businesses b on b.id = e.business_id
          where e.subject_id = ${tagId} and e.type = 'tag.created'
            and e.business_id = app.business_id()
        ),
        bounds as (
          select day,
                 day::timestamp at time zone timezone as starts,
                 (day + 1)::timestamp at time zone timezone as ends
          from created
        )
        insert into reporting.daily_metrics (business_id, metric, day, value)
        select app.business_id(), ${TAGS_CREATED}, bounds.day, day_events.tags
        from bounds
        cross join lateral (
          select count(*) as tags
          from events.events e
          -- An event is recorded when it's stored, never before it happened (DATABASE.md
          -- section 10), so none of the day's is recorded before the day starts. With the
          -- start as a lateral parameter, the scan prunes earlier partitions at run time
          -- and reads each one's index from the day's start.
          where e.agency_id = app.agency_id() and e.business_id = app.business_id()
            and e.recorded_at >= bounds.starts
            and e.type = 'tag.created'
            and e.occurred_at >= bounds.starts and e.occurred_at < bounds.ends
        ) as day_events
        -- Two jobs for one day can run at once, and the one that counted first can write
        -- last. A day's count only grows (events are never deleted), so the higher wins.
        on conflict (business_id, metric, dimension, day)
          do update set value = greatest(reporting.daily_metrics.value, excluded.value)`.execute(
        trx,
      );
    });
  },
});
