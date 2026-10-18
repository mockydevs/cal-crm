// Commerce's part in a contact merge, against a migrated Postgres as crm_app: the documents of
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

import { commerceContactMerge } from './contact-merge.js';

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

async function invoice(context: TenantContext, contactId: string): Promise<void> {
  await database.withTenant(context, (sql) =>
    sql.query(
      `insert into commerce.documents (business_id, kind, currency, created_by_kind, contact_id)
       values (app.business_id(), 'invoice', 'USD', 'user', $1)`,
      [contactId],
    ),
  );
}

const documentsOf = (context: TenantContext, contactId: string) =>
  database.withTenant(context, (sql) =>
    sql.one<{ count: number }>(
      'select count(*)::int as count from commerce.documents where contact_id = $1',
      [contactId],
    ),
  );

it("moves the merged contact's invoices to the contact kept, counted first", async () => {
  const { context, owner } = await space();
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  await invoice(context, kept.id);
  await invoice(context, merged.id);
  await invoice(context, merged.id);

  const { preview, merged: result } = await merge(
    owner,
    kept.id,
    [merged.id],
    [commerceContactMerge],
  );

  expect(preview.moved['commerce']).toEqual({ documents: 2 });
  expect(result.moved['commerce']).toEqual({ documents: 2 });
  expect(await documentsOf(context, kept.id)).toEqual({ count: 3 });
  expect(await documentsOf(context, merged.id)).toEqual({ count: 0 });
});

it('leaves every invoice where it was when the merge fails after it', async () => {
  const { context, owner } = await space();
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  await invoice(context, merged.id);
  const failing: ContactMergeParticipant = {
    name: 'failing',
    merge: () => Promise.reject(new Error('A later module failed.')),
  };

  await expect(merge(owner, kept.id, [merged.id], [commerceContactMerge, failing])).rejects.toThrow(
    'A later module failed.',
  );

  expect(await documentsOf(context, merged.id)).toEqual({ count: 1 });
  expect(await documentsOf(context, kept.id)).toEqual({ count: 0 });
});
