// Which workflows start when a form is sent, against real Postgres: automations stored as
// publishing stores them, with the subscriptions matching reads.
import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { listensToForm, readFormListeners } from './form-listeners.js';

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}

const FORM = toPublicId('form', '01890a5d-ac96-774b-bcce-b302099a8057');
const OTHER_FORM = toPublicId('form', '01890a5d-ac96-774b-bcce-b302099a8058');

/** A "form submitted" trigger for this form, or for every form. */
const onForm = (form?: string) => ({
  triggers: [{ id: 'sent', type: 'form.submitted', config: form === undefined ? {} : { form } }],
});

/** A published automation with this document, subscribed to these events, in this status. */
const published = async (
  context: TenantContext,
  name: string,
  document: object,
  options: { readonly status?: 'active' | 'paused' | 'archived'; readonly events?: string[] } = {},
): Promise<string> => {
  const id = await database.withTenant(context, async (sql) => {
    const made = await sql.one<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values (app.business_id(), $1, $2::jsonb, 'user') returning id`,
      [name, JSON.stringify(document)],
    );
    const version = await sql.one<{ id: string }>(
      `insert into automation.versions
         (business_id, automation_id, version, document, published_by_kind)
       values (app.business_id(), $1, 1, $2::jsonb, 'user') returning id`,
      [made.id, JSON.stringify(document)],
    );
    await sql.query(
      `update automation.automations set published_version_id = $2, status = 'active'
       where id = $1`,
      [made.id, version.id],
    );
    for (const event of options.events ?? ['form.submitted'])
      await sql.query(
        `insert into automation.trigger_subscriptions
           (business_id, automation_id, version_id, event_type, conditions)
         values (app.business_id(), $1, $2, $3, '{"triggerId": "sent"}')`,
        [made.id, version.id, event],
      );
    if (options.status === 'paused')
      await sql.query(`update automation.automations set status = 'paused' where id = $1`, [
        made.id,
      ]);
    if (options.status === 'archived')
      await sql.query(
        `update automation.automations set status = 'archived', archived_at = now()
         where id = $1`,
        [made.id],
      );
    return made.id;
  });
  return toPublicId('automation', id);
};

const listeners = (context: TenantContext, form = FORM) =>
  withTenant(db, context, (trx) => readFormListeners(trx, form));

it('names the running workflows a form starts: those for this form, and those for every form', async () => {
  const ours = await business();
  const forThis = await published(ours, 'Wedding follow-up', onForm(FORM));
  const forAny = await published(ours, 'Any form', onForm());
  await published(ours, 'Another form', onForm(OTHER_FORM));
  // Two triggers on one workflow are one workflow.
  const twice = await published(ours, 'Twice', {
    triggers: [...onForm(FORM).triggers, { id: 'again', type: 'form.submitted', config: {} }],
  });
  expect(await listeners(ours)).toEqual([
    { id: forAny, name: 'Any form' },
    { id: twice, name: 'Twice' },
    { id: forThis, name: 'Wedding follow-up' },
  ]);
  expect((await listeners(ours, OTHER_FORM)).map((each) => each.name)).toEqual([
    'Another form',
    'Any form',
    'Twice',
  ]);
});

it('leaves out a workflow that is paused or deleted, one on another event, and another business’s', async () => {
  const ours = await business();
  await published(ours, 'Paused', onForm(FORM), { status: 'paused' });
  await published(ours, 'Deleted', onForm(FORM), { status: 'archived' });
  await published(
    ours,
    'On a tag',
    { triggers: [{ id: 'sent', type: 'tag.added', config: {} }] },
    { events: ['tag.assigned'] },
  );
  // Subscribed to the event by a document that no longer says so: the document decides.
  await published(ours, 'Stale subscription', {
    triggers: [{ id: 'sent', type: 'contact.created', config: {} }],
  });
  expect(await listeners(ours)).toEqual([]);

  const theirs = await business();
  await published(theirs, 'Theirs', onForm());
  expect(await listeners(ours)).toEqual([]);
  expect((await listeners(theirs)).map((each) => each.name)).toEqual(['Theirs']);
});

it('reads a stored document carefully: anything that is not a form trigger for this form is not one', () => {
  expect(listensToForm(onForm(FORM), FORM)).toBe(true);
  expect(listensToForm(onForm(), FORM)).toBe(true);
  for (const form of [null, ''])
    expect(listensToForm({ triggers: [{ type: 'form.submitted', config: { form } }] }, FORM)).toBe(
      true,
    );
  expect(listensToForm({ triggers: [{ type: 'form.submitted' }] }, FORM)).toBe(true);
  for (const document of [
    onForm(OTHER_FORM),
    { triggers: [{ type: 'tag.added', config: { form: FORM } }] },
    { triggers: ['form.submitted', null, 4] },
    { triggers: { type: 'form.submitted' } },
    { steps: {} },
    [],
    null,
    'form.submitted',
  ])
    expect(listensToForm(document, FORM), JSON.stringify(document)).toBe(false);
});
