// The date trigger at volume: one date shared by 5,000 contacts enrols them all in one
// sweep, each in its own transaction, inside a stated time; contacts on other dates cost
// the sweep nothing. Real Postgres.
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness } from '../test/workflows.js';
import { sweepDateTriggers } from './date-triggers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const ON_THE_DAY = 5000;
const ON_OTHER_DAYS = 5000;
/** What one sweep of 5,000 enrolments may take. The whole test, seeding too, ran in 32 s. */
const BUDGET_MS = 120_000;

it(
  'enrols 5,000 contacts whose date came round in one sweep, within its budget',
  async () => {
    const tenant = await h.business();
    await h.database.as('postgres', (sql) =>
      sql.query(`update tenancy.businesses set timezone = 'Africa/Nairobi' where id = $1`, [
        tenant.businessId,
      ]),
    );
    await h.database.withTenant(tenant, async (sql) => {
      const field = await sql.one<{ id: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, created_by_kind)
         select app.business_id(), id, 'the_date', 'The date', 'A date to remember.', 'date', 'system'
         from crm.object_types where kind = 'contact'
         returning id`,
      );
      // The first 5,000 hold the date; the rest are spread over the 300 days after it.
      await sql.query(
        `with made as (
           insert into crm.records (business_id, kind, object_type_id)
           select app.business_id(), 'contact', type.id
           from crm.object_types type, generate_series(1, $2::integer)
           where type.kind = 'contact'
           returning id
         ), numbered as (
           select id, row_number() over (order by id) as n from made
         ), contacts as (
           insert into crm.contacts (business_id, id, first_name, created_by_kind)
           select app.business_id(), id, 'Contact ' || n, 'system' from numbered
         )
         insert into crm.field_values
           (business_id, record_id, field_id, value_type, value_date, source_kind)
         select app.business_id(), id, $1::uuid, 'date',
                case when n <= $3::integer then date '2026-10-20'
                     else date '2026-10-21' + (n % 300)::integer end,
                'system'
         from numbered`,
        [field.id, ON_THE_DAY + ON_OTHER_DAYS, ON_THE_DAY],
      );
    });
    const { automationId } = await h.publish(tenant, {
      name: 'Reminder',
      triggers: [
        {
          id: 'the_day',
          type: 'date.reached',
          config: { field: 'contact.custom.the_date', repeat: 'never' },
        },
      ],
      start: 'pause',
      steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
    });
    await sweepDateTriggers(h.services, new Date('2026-10-20T04:59:00Z'));

    const began = performance.now();
    const swept = await sweepDateTriggers(h.services, new Date('2026-10-20T05:00:00Z'));
    const took = performance.now() - began;

    expect(swept).toEqual({ enrolled: ON_THE_DAY, late: 0 });
    const [counted] = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ runs: number; contacts: number; firings: number }>(
        `select (select count(*)::int from automation.enrolments where automation_id = $1) as runs,
                (select count(distinct record_id)::int from automation.enrolments
                 where automation_id = $1) as contacts,
                (select count(*)::int from automation.trigger_firings
                 where automation_id = $1) as firings`,
        [automationId],
      ),
    );
    expect(counted).toEqual({ runs: ON_THE_DAY, contacts: ON_THE_DAY, firings: ON_THE_DAY });
    expect(took, `the sweep took ${took.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);

    // The minute after, with 10,000 contacts in the business, there is nothing to read.
    const idleBegan = performance.now();
    expect(await sweepDateTriggers(h.services, new Date('2026-10-20T05:01:00Z'))).toEqual({
      enrolled: 0,
      late: 0,
    });
    expect(performance.now() - idleBegan).toBeLessThan(2000);
  },
  BUDGET_MS + 120_000,
);
