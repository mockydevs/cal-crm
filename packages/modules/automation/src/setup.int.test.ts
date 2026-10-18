// The setup documents are validated against (AUTOMATIONS.md section 4), read from real
// tables under the tenant context: only what is live and usable is offered, each with its
// public id, and never anything of another business.
import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, type TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { addPhoneNumber } from '../test/phone-number.js';
import { readAutomationSetup, type InstallCapabilities } from './setup.js';

/** An install whose worker opens secrets and that Twilio can report delivery to. */
const install: InstallCapabilities = { webhookDelivery: true, smsDelivery: true };

it('offers team notifications only when the install composes their handler', async () => {
  const context = await business();
  const read = (teamNotifications: boolean) =>
    withTenant(db, context, (trx) =>
      readAutomationSetup(trx, context, () => Promise.resolve([]), {
        ...install,
        teamNotifications,
      }),
    );
  expect((await read(false)).unavailableSteps).toContain('team.notify');
  expect((await read(true)).unavailableSteps.toSorted()).toEqual([
    'ai.ask',
    'ai.classify',
    'ai.draft_reply',
    'whatsapp.send',
  ]);
});

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

type BusinessContext = TenantContext & { readonly businessId: string };

async function business(): Promise<BusinessContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, businessId: created.id, correlationId: randomUUID() };
}

const one = async (sql: Sql, text: string, values: readonly unknown[]): Promise<string> => {
  const [row] = await sql.query<{ id: string }>(text, values);
  if (row === undefined) throw new Error('The insert returns its id.');
  return row.id;
};

// A mailbox with its channel account, as connecting one leaves it.
async function mailbox(
  sql: Sql,
  context: TenantContext,
  name: string,
  status: string,
  conversations: boolean,
): Promise<void> {
  const b = context.businessId;
  const secret = await one(
    sql,
    `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
     values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
     returning id`,
    [context.agencyId, b],
  );
  const id = await one(
    sql,
    `insert into messaging.channel_accounts (business_id, channel, name, status)
     values ($1, 'email', $2, $3) returning id`,
    [b, name, status],
  );
  const address = `${randomUUID()}@example.test`;
  await sql.query(
    `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
       smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
       imap_username, secret_id, use_for_conversations)
     values ($1, $2, $3, 'password', 'mail.example.test', 587, 'starttls', $3,
       'mail.example.test', 993, 'tls', $3, $4, $5)`,
    [b, id, address, secret, conversations],
  );
}

/** Seeds a business with live and not-live rows of everything a document can refer to. */
async function seed(context: BusinessContext): Promise<void> {
  const b = context.businessId;
  await database.as('postgres', async (sql) => {
    const type = async (kind: string) => {
      const [existing] = await sql.query<{ id: string }>(
        'select id from crm.object_types where business_id = $1 and kind = $2',
        [b, kind],
      );
      return (
        existing?.id ??
        (await one(
          sql,
          `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
           values ($1, $2, $2, $2, $2) returning id`,
          [b, kind],
        ))
      );
    };
    const contact = await type('contact');
    const deal = await type('deal');
    const company = await type('company');
    const field = (
      objectType: string,
      key: string,
      valueType: string,
      options = '[]',
      extra = '',
    ) =>
      one(
        sql,
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, options, created_by_kind${extra === '' ? '' : ', archived_at'})
         values ($1, $2, $3, $3, 'What it means.', $4, $5::jsonb, 'user'${extra}) returning id`,
        [b, objectType, key, valueType, options],
      );
    const services = await field(
      contact,
      'services',
      'multi_choice',
      JSON.stringify([
        { key: 'opt_video', label: 'Video', description: '', archived: false },
        { key: 'opt_old', label: 'Old', description: '', archived: true },
      ]),
    );
    await sql.query(
      `insert into crm.field_key_aliases (business_id, object_type_id, alias_key, field_id)
       values ($1, $2, 'service_interest', $3)`,
      [b, contact, services],
    );
    await field(contact, 'retired', 'text', '[]', ', now()');
    await field(deal, 'event_date', 'date');
    await field(company, 'industry', 'text');

    await sql.query(
      // A published form serves the definition it was published with (0049).
      `insert into forms.forms
         (business_id, name, definition, status, public_key, published_definition, published_at)
       values
         ($1, 'Request a quote', '{"fields": []}', 'published', $2, '{"fields": []}', now()),
         ($1, 'Unfinished', '{"fields": []}', 'draft', $3, null, null),
         ($1, 'Retired', '{"fields": []}', 'archived', $4, null, null)`,
      [b, `pk_${randomUUID()}`, `pk_${randomUUID()}`, `pk_${randomUUID()}`],
    );
    await sql.query(
      `insert into messaging.templates (business_id, name, subject, body, created_by_kind, archived_at) values
         ($1, 'Pricing guide', 'Your guide', 'Hi', 'user', null),
         ($1, 'Old guide', 'Your guide', 'Hi', 'user', now())`,
      [b],
    );
    await mailbox(sql, context, 'Sales', 'active', true);
    await mailbox(sql, context, 'Campaigns only', 'active', false);
    await mailbox(sql, context, 'Broken', 'failing', true);
    await addPhoneNumber(sql, context, 'Front desk');
    await addPhoneNumber(sql, context, 'Switched off', { status: 'paused' });
    await addPhoneNumber(sql, context, 'Lost connection', { connection: 'disconnected' });
    await addPhoneNumber(sql, context, 'Voice only', { capabilities: ['voice'] });
    await sql.query(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug, is_active) values
         ($1, 'Consultations', 'personal', 'Africa/Nairobi', $2, true),
         ($1, 'Closed', 'personal', 'Africa/Nairobi', $3, false)`,
      [b, `c-${randomUUID()}`, `c-${randomUUID()}`],
    );
    const pipeline = await one(
      sql,
      `insert into crm.pipelines (business_id, name, position) values ($1, 'Events', 900) returning id`,
      [b],
    );
    await sql.query(
      `insert into crm.pipeline_stages (business_id, pipeline_id, name, position, archived_at) values
         ($1, $2, 'Quote sent', 0, null), ($1, $2, 'Booked', 1, null), ($1, $2, 'Dropped', 2, now())`,
      [b, pipeline],
    );
    await sql.query(
      `insert into crm.pipelines (business_id, name, position, archived_at)
       values ($1, 'Old pipeline', 901, now())`,
      [b],
    );
    await sql.query(
      `insert into crm.lost_reasons (business_id, label, position, archived_at) values
         ($1, 'Price', 900, null), ($1, 'Retired reason', 901, now())`,
      [b],
    );
    await sql.query(
      `insert into crm.tags (business_id, name, created_by_kind) values ($1, 'VIP', 'user')`,
      [b],
    );
    await sql.query(
      `insert into automation.automations (business_id, name, draft, created_by_kind, status, archived_at) values
         ($1, 'Welcome', '{}', 'user', 'draft', null),
         ($1, 'Retired', '{}', 'user', 'archived', now())`,
      [b],
    );
  });
}

const names = (list: readonly { name: string }[]) => list.map((item) => item.name);

it('offers only what is live and usable, each by its public id', async () => {
  const context = await business();
  await seed(context);
  const users = [{ id: 'mem_stub', name: 'Amina' }];
  const setup = await withTenant(db, context, (trx) =>
    readAutomationSetup(trx, context, () => Promise.resolve(users), install),
  );

  expect(setup.fields.contact.filter((field) => field.key !== 'retired')).toContainEqual({
    key: 'services',
    aliases: ['service_interest'],
    type: 'multi_choice',
    options: [{ key: 'opt_video', label: 'Video' }],
    // The seed gives a field its key as its label; its folder is the one every object has.
    label: 'services',
    folder: { id: expect.stringMatching(/^ffld_/) as unknown, name: 'Additional Info' },
  });
  expect(setup.fields.contact.map((field) => field.key)).not.toContain('retired');
  expect(setup.fields.contact.map((field) => field.key)).not.toContain('industry');
  expect(setup.fields.deal).toContainEqual({
    key: 'event_date',
    aliases: [],
    type: 'date',
    options: [],
    label: 'event_date',
    folder: { id: expect.stringMatching(/^ffld_/) as unknown, name: 'Additional Info' },
  });

  // Published forms and drafts, each saying which it is: a trigger that names a draft is
  // told to publish it. An archived form is not offered.
  expect(setup.forms.map((form) => [form.name, form.status])).toEqual([
    ['Request a quote', 'published'],
    ['Unfinished', 'draft'],
  ]);
  // The fixture's business has no address on its profile.
  expect(setup.postalAddress).toBe(false);
  expect(names(setup.emailTemplates)).toEqual(['Pricing guide']);
  expect(setup.whatsappTemplates).toEqual([]);
  // Not the mailbox kept for campaigns, nor the one that is failing.
  expect(names(setup.mailboxes)).toEqual(['Sales']);
  expect(names(setup.calendars)).toEqual(['Consultations']);
  const events = setup.pipelines.find((pipeline) => pipeline.name === 'Events');
  expect(names(events?.stages ?? [])).toEqual(['Quote sent', 'Booked']);
  expect(names(setup.pipelines)).not.toContain('Old pipeline');
  expect(names(setup.lostReasons)).toContain('Price');
  expect(names(setup.lostReasons)).not.toContain('Retired reason');
  expect(names(setup.tags)).toContain('VIP');
  expect(names(setup.automations)).toEqual(['Welcome']);
  expect(setup.users).toEqual(users);
  expect(setup.values).toEqual([]);
  // Not the number switched off, the one whose provider is disconnected, or the voice line.
  expect(names(setup.phoneNumbers)).toEqual(['Front desk']);
  // Email and text messages are offered because something usable can send each.
  expect(setup.channels).toEqual({ email: true, sms: true, whatsapp: false });
  expect(setup.ai).toBe(false);
  // What the catalog lists but nothing here runs or fires yet, so the validator refuses it.
  expect(setup.unavailableSteps.toSorted()).toEqual([
    'ai.ask',
    'ai.classify',
    'ai.draft_reply',
    'team.notify',
    'whatsapp.send',
  ]);
  expect(setup.unavailableTriggers.toSorted()).toEqual(['schedule', 'webhook.received']);
  // No signing secret yet, so webhook steps can't run, whatever the worker can do.
  expect(setup.webhooks).toBe(false);

  const kinds = [
    ['form', setup.forms],
    ['template', setup.emailTemplates],
    ['mailbox', setup.mailboxes],
    ['phone_number', setup.phoneNumbers],
    ['calendar', setup.calendars],
    ['pipeline', setup.pipelines],
    ['stage', events?.stages ?? []],
    ['lost_reason', setup.lostReasons],
    ['tag', setup.tags],
    ['automation', setup.automations],
  ] as const;
  for (const [kind, list] of kinds) {
    expect(list.length).toBeGreaterThan(0);
    for (const item of list)
      expect(parsePublicId(kind, item.id), `${kind} ${item.id}`).toBeDefined();
  }
});

it("offers nothing of another business's", async () => {
  const context = await business();
  await seed(context);
  const other = await business();
  const setup = await withTenant(db, other, (trx) =>
    readAutomationSetup(trx, other, () => Promise.resolve([]), install),
  );
  expect(setup.fields.contact.map((field) => field.key)).not.toContain('services');
  expect(setup.forms).toEqual([]);
  expect(setup.emailTemplates).toEqual([]);
  expect(setup.mailboxes).toEqual([]);
  expect(setup.phoneNumbers).toEqual([]);
  expect(setup.calendars).toEqual([]);
  expect(names(setup.pipelines)).not.toContain('Events');
  expect(names(setup.lostReasons)).not.toContain('Price');
  expect(names(setup.tags)).not.toContain('VIP');
  expect(setup.automations).toEqual([]);
  // A business with no usable mailbox is not offered email.
  expect(setup.channels).toEqual({ email: false, sms: false, whatsapp: false });
});

it('offers no text messages on an install that cannot deliver them, whatever is connected', async () => {
  const context = await business();
  await database.as('postgres', (sql) => addPhoneNumber(sql, context, 'Front desk'));
  const read = (smsDelivery: boolean) =>
    withTenant(db, context, (trx) =>
      readAutomationSetup(trx, context, () => Promise.resolve([]), {
        webhookDelivery: true,
        smsDelivery,
      }),
    );
  // No vault, or no public https address for the provider's delivery reports.
  const without = await read(false);
  expect(without.channels.sms).toBe(false);
  expect(without.phoneNumbers).toEqual([]);
  const withDelivery = await read(true);
  expect(withDelivery.channels.sms).toBe(true);
  expect(names(withDelivery.phoneNumbers)).toEqual(['Front desk']);
});
