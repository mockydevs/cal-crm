// What template authoring asks of automations, against real Postgres: automations
// published through the real commands, so the stored documents are what production
// stores, and contact fields as the CRM defines them.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import {
  automationDocument,
  attributionPaths,
  contactMergeFields,
  type AutomationDocumentInput,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createDraftCommands, type ReadSetup } from './drafts.js';
import { publishAutomationVersion } from './enrolment.js';
import { createLifecycleCommands } from './lifecycle.js';
import { readAutomationSetup } from './setup.js';
import { readTemplateFields, readTemplateUses } from './template-uses.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

// The business's real setup, so a template named in a draft resolves to its real id. No
// mailbox is connected in these tests, which only publish: they never send.
const setup: ReadSetup = async (trx, context) => ({
  ...(await readAutomationSetup(trx, context, () => Promise.resolve([]), {
    webhookDelivery: false,
    smsDelivery: false,
  })),
  channels: { email: true, sms: false, whatsapp: false },
});
const drafts = createDraftCommands({ setup });
const lifecycle = createLifecycleCommands({ setup });

async function business(agencyId?: string): Promise<TenantContext & { businessId: string }> {
  const agency = agencyId === undefined ? await database.fixtures.agency() : { id: agencyId };
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, businessId: created.id, correlationId: randomUUID() };
}
const as = (context: TenantContext) => ({ context, permissions: 'all' as const });

const one = async (sql: Sql, text: string, values: readonly unknown[]): Promise<string> => {
  const [row] = await sql.query<{ id: string }>(text, values);
  if (row === undefined) throw new Error('The insert returns its id.');
  return row.id;
};

/** A template as authoring stores it, by its public id. */
const template = async (context: TenantContext, name: string): Promise<string> =>
  toPublicId(
    'template',
    await database.withTenant(context, (sql) =>
      one(
        sql,
        `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
         values (app.business_id(), $1, 'Hello', 'Hi {{contact.firstName}}', 'user') returning id`,
        [name],
      ),
    ),
  );

const sending = (name: string, ...templates: readonly string[]): AutomationDocumentInput => ({
  name,
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'send_0',
  steps: Object.fromEntries(
    templates.map((each, at) => [
      `send_${String(at)}`,
      {
        type: 'email.send',
        config: { template: each },
        ...(at + 1 < templates.length ? { next: `send_${String(at + 1)}` } : {}),
      },
    ]),
  ),
});

/** Saves a draft and publishes it through the real commands. */
async function publish(context: TenantContext, document: AutomationDocumentInput): Promise<string> {
  const { automation } = await runCommand(services, drafts.create, { document }, as(context));
  await runCommand(
    services,
    lifecycle.publish,
    { id: automation.id, baseDraftVersion: automation.draftVersion },
    as(context),
  );
  return automation.id;
}

const uses = (context: TenantContext, id: string) =>
  withTenant(db, context, (trx) => readTemplateUses(trx, context, id));

// Where the contact came from: its first and latest touch, leaf by leaf.
const contactAttribution = attributionPaths.filter((path) => path.startsWith('contact.'));

it('names the active and paused automations whose published version sends a template', async () => {
  const context = await business();
  const guide = await template(context, 'Pricing guide');
  const other = await template(context, 'Welcome pack');
  const unused = await template(context, 'Nobody sends this');

  // By name, as an author writes it: publishing stores the id.
  const welcome = await publish(context, sending('Welcome', 'pricing GUIDE'));
  const winBack = await publish(context, sending('Win back', guide));
  await runCommand(services, lifecycle.pause, { id: winBack }, as(context));
  // Twice in one automation is still one automation.
  const both = await publish(context, sending('Both', guide, other, guide));
  // A draft that was never published sends nothing.
  await runCommand(
    services,
    drafts.create,
    { document: sending('Draft only', guide) },
    as(context),
  );
  // Published with the guide, then republished without it: the live version counts.
  const { automation: moved } = await runCommand(
    services,
    drafts.create,
    { document: sending('Moved on', guide) },
    as(context),
  );
  await runCommand(
    services,
    lifecycle.publish,
    { id: moved.id, baseDraftVersion: moved.draftVersion },
    as(context),
  );
  const { automation: edited } = await runCommand(
    services,
    drafts.replace,
    { id: moved.id, baseDraftVersion: moved.draftVersion, document: sending('Moved on', other) },
    as(context),
  );
  await runCommand(
    services,
    lifecycle.publish,
    { id: moved.id, baseDraftVersion: edited.draftVersion },
    as(context),
  );
  // An archived automation runs nothing, though its published version remains.
  const retired = await publish(context, sending('Retired', guide));
  await database.as('crm_owner', (sql) =>
    sql.query(
      `update automation.automations set status = 'archived', archived_at = now()
       where id = (select id from automation.automations where name = 'Retired' and business_id = $1)`,
      [context.businessId],
    ),
  );
  expect(retired).toMatch(/^aut_/);

  expect(await uses(context, guide)).toEqual([
    { id: both, name: 'Both', status: 'active' },
    { id: welcome, name: 'Welcome', status: 'active' },
    { id: winBack, name: 'Win back', status: 'paused' },
  ]);
  expect(await uses(context, other)).toEqual([
    { id: both, name: 'Both', status: 'active' },
    { id: moved.id, name: 'Moved on', status: 'active' },
  ]);
  expect(await uses(context, unused)).toEqual([]);
  expect(await uses(context, 'not a template id')).toEqual([]);

  // The stored document is why: the name became the id when it was published.
  expect(
    await database.withTenant(context, (sql) =>
      sql.query(
        `select v.document #>> '{steps,send_0,config,template}' as template
         from automation.versions v join automation.automations a
           on a.business_id = v.business_id and a.published_version_id = v.id
         where a.name = 'Welcome'`,
      ),
    ),
  ).toEqual([{ template: guide }]);
});

it('counts a workflow whose runs on an earlier version still send the template', async () => {
  const context = await business();
  const guide = await template(context, 'Pricing guide');
  const other = await template(context, 'Other');
  const drip = await publish(context, sending('Drip', guide));
  // A contact enrolled on version 1, waiting before the step that sends the guide.
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    as(context),
  );
  const enrolment = await database.as('crm_owner', (sql) =>
    one(
      sql,
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, reentry_key, status, correlation_id)
       select a.business_id, a.id, a.published_version_id, r.id, r.id, 'waiting', gen_random_uuid()
       from automation.automations a
       join crm.records r on r.business_id = a.business_id
       where a.business_id = $1 and a.name = 'Drip'
       returning id`,
      [context.businessId],
    ),
  );
  // Version 2 no longer sends it; the run that began on version 1 still will.
  const { automation } = await runCommand(
    services,
    drafts.replace,
    {
      id: drip,
      baseDraftVersion: 1,
      document: sending('Drip', other),
    },
    as(context),
  );
  await runCommand(
    services,
    lifecycle.publish,
    { id: drip, baseDraftVersion: automation.draftVersion },
    as(context),
  );
  expect(await uses(context, guide)).toEqual([
    { id: drip, name: 'Drip', status: 'active', runsInProgress: true },
  ]);
  // The version it now runs sends the other template, and no flag is set for that.
  expect(await uses(context, other)).toEqual([{ id: drip, name: 'Drip', status: 'active' }]);
  // Paused, the run still goes on, so it still counts.
  await database.as('crm_owner', (sql) =>
    sql.query(`update automation.automations set status = 'paused' where id = $1`, [
      parsePublicId('automation', drip),
    ]),
  );
  expect(await uses(context, guide)).toEqual([
    { id: drip, name: 'Drip', status: 'paused', runsInProgress: true },
  ]);
  // Once the run has finished, nothing sends the guide any more.
  await database.as('crm_owner', (sql) =>
    sql.query(
      `update automation.enrolments set status = 'completed', finished_at = now() where id = $1`,
      [enrolment],
    ),
  );
  expect(await uses(context, guide)).toEqual([]);
});

it('matches only an email step that sends the template, not other text that holds its id', async () => {
  const context = await business();
  const guide = await template(context, 'Pricing guide');
  // Published as stored documents, past the validator, to hold the id where it isn't sent.
  const store = (document: AutomationDocumentInput) =>
    withTenant(db, context, async (trx) => {
      const { id } = await trx
        .insertInto('automation.automations')
        .values({
          business_id: context.businessId,
          name: document.name,
          draft: JSON.stringify(document),
          created_by_kind: 'system',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
      return toPublicId('automation', id);
    });
  await store({
    name: 'Mentions it',
    description: `Used to send ${guide}`,
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'note',
    steps: { note: { type: 'sms.send', config: { message: `See ${guide}` } } },
  });
  await store({
    name: 'Whatsapp of the same id',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'send',
    steps: { send: { type: 'whatsapp.send', config: { template: guide } } },
  });
  const sends = await store(sending('Sends it', guide));
  expect(await uses(context, guide)).toEqual([{ id: sends, name: 'Sends it', status: 'active' }]);
});

it("never names another business's automations, even ones that hold the same template id", async () => {
  const ours = await business();
  const theirs = await business(ours.agencyId);
  const stranger = await business();
  const guide = await template(ours, 'Pricing guide');
  const welcome = await publish(ours, sending('Welcome', guide));
  for (const other of [theirs, stranger]) {
    // Their own template of the same name, sent by their own automation.
    const own = await template(other, 'Pricing guide');
    const sends = await publish(other, sending('Welcome', 'Pricing guide'));
    expect(await uses(other, own)).toEqual([{ id: sends, name: 'Welcome', status: 'active' }]);
    expect(await uses(other, guide)).toEqual([]);
    // Even a stored document of theirs that names our template's id stays theirs.
    await withTenant(db, other, async (trx) => {
      const { id } = await trx
        .insertInto('automation.automations')
        .values({
          business_id: other.businessId,
          name: 'Holds a foreign id',
          draft: '{}',
          created_by_kind: 'system',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await publishAutomationVersion(
        trx,
        other,
        id,
        automationDocument.parse(sending('Holds a foreign id', guide)),
        'v1',
      );
    });
  }
  expect(await uses(ours, guide)).toEqual([{ id: welcome, name: 'Welcome', status: 'active' }]);
});

it('lists the fields a template send can fill in: built-in contact fields and live custom ones', async () => {
  const context = await business();
  const elsewhere = await business(context.agencyId);
  const fields = (of: TenantContext) => withTenant(db, of, (trx) => readTemplateFields(trx));
  expect(await fields(context)).toEqual([...contactMergeFields, ...contactAttribution]);

  const define = (of: TenantContext, kind: string, key: string, archived = false) =>
    database.as('crm_owner', async (sql) => {
      const [existing] = await sql.query<{ id: string }>(
        'select id from crm.object_types where business_id = $1 and kind = $2',
        [of.businessId, kind],
      );
      const type =
        existing?.id ??
        (await one(
          sql,
          `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
           values ($1, $2, $2, $2, $2) returning id`,
          [of.businessId, kind],
        ));
      await sql.query(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, created_by_kind, archived_at)
         values ($1, $2, $3, $3, 'What it means.', 'text', 'user', $4)`,
        [of.businessId, type, key, archived ? new Date() : null],
      );
    });
  await define(context, 'contact', 'services');
  await define(context, 'contact', 'budget');
  await define(context, 'contact', 'retired', true);
  await define(context, 'deal', 'event_date');
  await define(context, 'company', 'industry');
  await define(elsewhere, 'contact', 'theirs_only');

  // Each live contact field under its older path and its merge key. The deal's and the
  // company's fields have merge keys too, and no send can fill those in.
  expect(await fields(context)).toEqual([
    ...contactMergeFields,
    ...contactAttribution,
    'contact.custom.budget',
    'contact.budget',
    'contact.custom.services',
    'contact.services',
  ]);
  expect(await fields(elsewhere)).toEqual([
    ...contactMergeFields,
    ...contactAttribution,
    'contact.custom.theirs_only',
    'contact.theirs_only',
  ]);
});
