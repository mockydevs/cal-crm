// Calendar's part in a contact merge, against a migrated Postgres as crm_app: the appointments
// of the contact merged away are the contact kept's afterwards, with their invite sequence
// unchanged, and a merge that fails later leaves them where they were.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { contactMerge, contactMergePreview } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { contactMergeRoutes, type ContactMergeParticipant } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { calendarContactMerge } from './contact-merge.js';

let database: TestDatabase;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});

async function space(): Promise<{ context: TenantContext; owner: Invocation }> {
  const agency = await database.fixtures.agency();
  const { context } = await database.fixtures.business(agency.id);
  return {
    context,
    owner: { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
  };
}

/** Merges `losers` into `kept` with the revisions the preview gives, as the dialog does. */
async function merge(
  owner: Invocation,
  kept: string,
  losers: string[],
  participants: readonly ContactMergeParticipant[],
) {
  const routes = contactMergeRoutes({ participants });
  const route = (id: string) => routes.find((each) => each.endpoint.operationId === id);
  const id = toPublicId('contact', kept);
  const mergeIds = losers.map((each) => toPublicId('contact', each));
  const preview = contactMergePreview.parse(
    await route('previewContactMerge')?.run(
      {
        invocation: owner,
        params: { id },
        query: { mergeIds: mergeIds.join(',') },
        body: undefined,
      },
      services,
    ),
  );
  const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
  const merged = contactMerge.parse(
    await route('mergeContacts')?.run(
      { invocation: owner, params: { id }, query: {}, body: { mergeIds, revisions } },
      services,
    ),
  );
  return { preview, merged };
}

async function book(context: TenantContext, contactId: string): Promise<void> {
  await database.withTenant(context, async (sql) => {
    const calendar = await sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       values (app.business_id(), 'Consultations', 'personal', 'America/New_York', $1)
       returning id`,
      [`c-${randomUUID().slice(0, 8)}`],
    );
    await sql.query(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
       values (app.business_id(), $1, $2, 'Fitting', now() + interval '1 day',
         now() + interval '25 hours', 'user')`,
      [calendar.id, contactId],
    );
  });
}

const appointmentsOf = (context: TenantContext, contactId: string) =>
  database.withTenant(context, (sql) =>
    sql.one<{ count: number }>(
      `select count(*)::int as count from calendar.appointments
       where contact_id = $1 and sequence = 0`,
      [contactId],
    ),
  );

it("moves the merged contact's appointments to the contact kept, counted first", async () => {
  const { context, owner } = await space();
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  await book(context, kept.id);
  await book(context, merged.id);
  await book(context, merged.id);

  const { preview, merged: result } = await merge(
    owner,
    kept.id,
    [merged.id],
    [calendarContactMerge],
  );

  expect(preview.moved['calendar']).toEqual({ appointments: 2 });
  expect(result.moved['calendar']).toEqual({ appointments: 2 });
  expect(await appointmentsOf(context, kept.id)).toEqual({ count: 3 });
  expect(await appointmentsOf(context, merged.id)).toEqual({ count: 0 });
});

it('leaves every appointment where it was when the merge fails after it', async () => {
  const { context, owner } = await space();
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  await book(context, merged.id);
  const failing: ContactMergeParticipant = {
    name: 'failing',
    merge: () => Promise.reject(new Error('A later module failed.')),
  };

  await expect(merge(owner, kept.id, [merged.id], [calendarContactMerge, failing])).rejects.toThrow(
    'A later module failed.',
  );

  expect(await appointmentsOf(context, merged.id)).toEqual({ count: 1 });
  expect(await appointmentsOf(context, kept.id)).toEqual({ count: 0 });
});
