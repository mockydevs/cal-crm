// Forms' part in a contact merge, against a migrated Postgres as crm_app: the submissions of
// the contact merged away are the contact kept's afterwards, and a merge that fails later
// leaves them where they were.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { contactMerge, contactMergePreview } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { contactMergeRoutes, type ContactMergeParticipant } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { formsContactMerge } from './contact-merge.js';

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

async function submit(context: TenantContext, contactId: string): Promise<void> {
  await database.withTenant(context, async (sql) => {
    const form = await sql.one<{ id: string }>(
      `insert into forms.forms (business_id, name, definition, public_key)
       values (app.business_id(), 'Contact us', '{"questions": ["email"]}', $1) returning id`,
      [`key-${randomUUID()}`],
    );
    await sql.query(
      `insert into forms.submissions (business_id, form_id, contact_id, contact_outcome, data)
       values (app.business_id(), $1, $2, 'created', '{}')`,
      [form.id, contactId],
    );
  });
}

const submissionsOf = (context: TenantContext, contactId: string) =>
  database.withTenant(context, (sql) =>
    sql.one<{ count: number }>(
      'select count(*)::int as count from forms.submissions where contact_id = $1',
      [contactId],
    ),
  );

it("moves the merged contact's submissions to the contact kept, counted first", async () => {
  const { context, owner } = await space();
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  await submit(context, kept.id);
  await submit(context, merged.id);
  await submit(context, merged.id);

  const { preview, merged: result } = await merge(owner, kept.id, [merged.id], [formsContactMerge]);

  // External Tracking's rows of the contact are counted too: it has none here.
  const tracking = { externalSubmissions: 0, trackingEvents: 0, trackingVisitors: 0 };
  expect(preview.moved['forms']).toEqual({ submissions: 2, ...tracking });
  expect(result.moved['forms']).toEqual({ submissions: 2, ...tracking });
  expect(await submissionsOf(context, kept.id)).toEqual({ count: 3 });
  expect(await submissionsOf(context, merged.id)).toEqual({ count: 0 });
});

it('leaves every submission where it was when the merge fails after it', async () => {
  const { context, owner } = await space();
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  await submit(context, merged.id);
  const failing: ContactMergeParticipant = {
    name: 'failing',
    merge: () => Promise.reject(new Error('A later module failed.')),
  };

  await expect(merge(owner, kept.id, [merged.id], [formsContactMerge, failing])).rejects.toThrow(
    'A later module failed.',
  );

  expect(await submissionsOf(context, merged.id)).toEqual({ count: 1 });
  expect(await submissionsOf(context, kept.id)).toEqual({ count: 0 });
});

it("moves the merged contact's external form submissions, page views and visitor ids", async () => {
  const { context, owner } = await space();
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  await database.withTenant(context, async (sql) => {
    await sql.query(
      `insert into forms.external_submissions
         (business_id, contact_id, form_name, page_host, page_path, fields, client_submission_id, view_mark)
       values (app.business_id(), $1, 'Quote', 'www.acme.example', '/quote', '[]', uuidv7(), $2)`,
      [merged.id, 'm'.repeat(43)],
    );
    await sql.query(
      `insert into forms.tracking_events (business_id, kind, page_host, page_path, contact_id)
       values (app.business_id(), 'page_view', 'www.acme.example', '/', $1),
              (app.business_id(), 'page_view', 'www.acme.example', '/quote', $1)`,
      [merged.id],
    );
    await sql.query(
      `insert into forms.tracking_visitors (business_id, visitor_id, contact_id)
       values (app.business_id(), uuidv7(), $1)`,
      [merged.id],
    );
  });

  const { merged: result } = await merge(owner, kept.id, [merged.id], [formsContactMerge]);

  expect(result.moved['forms']).toEqual({
    submissions: 0,
    externalSubmissions: 1,
    trackingEvents: 2,
    trackingVisitors: 1,
  });
  expect(
    await database.withTenant(context, (sql) =>
      sql.one<{ count: number }>(
        `select ((select count(*) from forms.external_submissions where contact_id = $1)
              + (select count(*) from forms.tracking_events where contact_id = $1)
              + (select count(*) from forms.tracking_visitors where contact_id = $1))::int as count`,
        [kept.id],
      ),
    ),
  ).toEqual({ count: 4 });
});
