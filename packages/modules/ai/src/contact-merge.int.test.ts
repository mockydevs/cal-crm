// The AI module's part in a contact merge, against a migrated Postgres as crm_app: facts and
// extractions move, the kept contact's summary and autonomy rules win and fill in from the
// merged contact's, pending proposals that name the merged contact expire while decided ones
// stay, and nothing changes when the merge fails later.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { contactMerge, contactMergePreview } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { contactMergeRoutes, type ContactMergeParticipant } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { aiContactMerge } from './contact-merge.js';

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

interface Space {
  readonly context: TenantContext;
  readonly owner: Invocation;
  readonly kept: string;
  readonly merged: string;
}

async function space(): Promise<Space> {
  const agency = await database.fixtures.agency();
  const { context } = await database.fixtures.business(agency.id);
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  return {
    context,
    owner: {
      context: { ...context, actorKind: 'user', correlationId: randomUUID() },
      permissions: 'all',
    },
    kept: kept.id,
    merged: merged.id,
  };
}

async function merge(where: Space, participants: readonly ContactMergeParticipant[]) {
  const routes = contactMergeRoutes({ participants });
  const route = (id: string) => routes.find((each) => each.endpoint.operationId === id);
  const id = toPublicId('contact', where.kept);
  const mergeIds = [toPublicId('contact', where.merged)];
  const preview = contactMergePreview.parse(
    await route('previewContactMerge')?.run(
      {
        invocation: where.owner,
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
      { invocation: where.owner, params: { id }, query: {}, body: { mergeIds, revisions } },
      services,
    ),
  );
  return { preview, merged };
}

const sql = <Row extends object>(where: Space, text: string, values: unknown[] = []) =>
  database.withTenant(where.context, (each) => each.query<Row>(text, values));

const fact = (where: Space, contactId: string, statement: string) =>
  sql(
    where,
    `insert into ai.contact_facts (business_id, contact_id, statement)
     values (app.business_id(), $1, $2)`,
    [contactId, statement],
  );
const summary = (where: Space, contactId: string, text: string) =>
  sql(
    where,
    `insert into ai.contact_summaries (business_id, contact_id, summary, model)
     values (app.business_id(), $1, $2, 'test')`,
    [contactId, text],
  );
const rule = (where: Space, contactId: string, action: string, level: string) =>
  sql(
    where,
    `insert into ai.autonomy_rules (business_id, agent, action, level, contact_id)
     values (app.business_id(), 'inbox', $2, $3, $1)`,
    [contactId, action, level],
  );

describe('memory', () => {
  it('moves facts and extractions, and fills in the summary and rules the kept one lacks', async () => {
    const where = await space();
    await fact(where, where.kept, 'Prefers mornings.');
    await fact(where, where.merged, 'Has two dogs.');
    await summary(where, where.kept, 'A regular since 2024.');
    await summary(where, where.merged, 'Asked about June.');
    await rule(where, where.kept, 'send_message', 'ask');
    await rule(where, where.merged, 'send_message', 'act');
    await rule(where, where.merged, 'update_contact', 'suggest');
    const [conversation] = await sql<{ id: string }>(
      where,
      `insert into messaging.conversations (business_id, contact_id)
       values (app.business_id(), $1) returning id`,
      [where.merged],
    );
    await sql(
      where,
      `insert into ai.extractions (business_id, conversation_id, contact_id, revision)
       values (app.business_id(), $1, $2, 'r1')`,
      [conversation?.id, where.merged],
    );

    const { preview, merged: result } = await merge(where, [aiContactMerge]);

    expect(preview.moved['ai']).toEqual({
      facts: 1,
      extractions: 1,
      summaries: 1,
      autonomyRules: 2,
    });
    expect(result.moved['ai']).toEqual({
      facts: 1,
      extractions: 1,
      summaries: 0,
      autonomyRules: 1,
      proposalsExpired: 0,
    });
    expect(
      await sql(
        where,
        'select statement from ai.contact_facts where contact_id = $1 order by statement',
        [where.kept],
      ),
    ).toEqual([{ statement: 'Has two dogs.' }, { statement: 'Prefers mornings.' }]);
    expect(
      await sql(where, 'select contact_id, summary from ai.contact_summaries order by summary'),
    ).toEqual([{ contact_id: where.kept, summary: 'A regular since 2024.' }]);
    expect(
      await sql(where, 'select contact_id, action, level from ai.autonomy_rules order by action'),
    ).toEqual([
      { contact_id: where.kept, action: 'send_message', level: 'ask' },
      { contact_id: where.kept, action: 'update_contact', level: 'suggest' },
    ]);
    expect(await sql(where, 'select contact_id from ai.extractions')).toEqual([
      { contact_id: where.kept },
    ]);
  });

  it("takes the merged contact's summary when the kept one has none", async () => {
    const where = await space();
    await summary(where, where.merged, 'Asked about June.');
    const { merged: result } = await merge(where, [aiContactMerge]);
    expect(result.moved['ai']).toMatchObject({ summaries: 1 });
    expect(await sql(where, 'select contact_id from ai.contact_summaries')).toEqual([
      { contact_id: where.kept },
    ]);
  });
});

describe('proposals', () => {
  const propose = (
    where: Space,
    values: { recordId?: string; input?: Record<string, unknown>; status?: string },
  ) =>
    sql<{ id: string }>(
      where,
      `insert into ai.proposals (business_id, agent, kind, summary, command, autonomy, revision,
         record_id, status, decided_at, decided_by_kind)
       values (app.business_id(), 'copilot', 'update_contact', 'Fix the name', $1, 'suggest',
         'r1', $2, $3, case when $3 = 'pending' then null else now() end,
         case when $3 = 'pending' then null else 'user' end)
       returning id`,
      [
        JSON.stringify({ name: 'contact.update', input: values.input ?? {} }),
        values.recordId ?? null,
        values.status ?? 'pending',
      ],
    );

  it('expires the pending ones that name the merged contact, and leaves decided ones', async () => {
    const where = await space();
    const [about] = await propose(where, { recordId: where.merged });
    const [naming] = await propose(where, {
      input: { contactId: toPublicId('contact', where.merged) },
    });
    const [byUuid] = await propose(where, { input: { contact: where.merged } });
    const [elsewhere] = await propose(where, { recordId: where.kept });
    const [decided] = await propose(where, { recordId: where.merged, status: 'dismissed' });

    const { merged: result } = await merge(where, [aiContactMerge]);

    expect(result.moved['ai']).toMatchObject({ proposalsExpired: 3 });
    const statuses = await sql<{ id: string; status: string; record_id: string | null }>(
      where,
      'select id, status, record_id from ai.proposals',
    );
    const of = (id: string | undefined) => statuses.find((each) => each.id === id);
    expect(of(about?.id)).toMatchObject({ status: 'expired', record_id: where.merged });
    expect(of(naming?.id)).toMatchObject({ status: 'expired' });
    expect(of(byUuid?.id)).toMatchObject({ status: 'expired' });
    expect(of(elsewhere?.id)).toMatchObject({ status: 'pending' });
    expect(of(decided?.id)).toMatchObject({ status: 'dismissed', record_id: where.merged });
  });
});

it('leaves everything where it was when the merge fails after it', async () => {
  const where = await space();
  await fact(where, where.merged, 'Has two dogs.');
  await summary(where, where.merged, 'Asked about June.');
  const failing: ContactMergeParticipant = {
    name: 'failing',
    merge: () => Promise.reject(new Error('A later module failed.')),
  };
  await expect(merge(where, [aiContactMerge, failing])).rejects.toThrow('A later module failed.');
  expect(
    await sql(
      where,
      `select (select contact_id from ai.contact_facts) as fact,
         (select contact_id from ai.contact_summaries) as summary`,
    ),
  ).toEqual([{ fact: where.merged, summary: where.merged }]);
});
