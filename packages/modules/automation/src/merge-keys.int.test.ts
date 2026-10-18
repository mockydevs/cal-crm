// Where messages are filled in: a contact field under its merge key, a
// custom value under its, through the one reader every send uses (contactValues), the
// report of what no send can fill in (readTemplateFields), the validator's setup, and a
// real text message step. Fields and custom values are made by the CRM's own routes.
import { randomInt, randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  attributionPaths,
  automationDocument,
  contactMergeFields,
  customValue,
  fieldDefinition,
  renderMessageTemplate,
  validateAutomation,
  type AutomationDocumentInput,
  type ConditionValues,
  type CustomValue,
  type FieldDefinition,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand, crmRoutes } from '@repo/module-crm';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { addPhoneNumber } from '../test/phone-number.js';
import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { readAutomationSetup } from './setup.js';
import { readTemplateFields } from './template-uses.js';
import { contactValues } from './values.js';

// These automations create no tasks, so nothing here resolves an assignee.
const runStep = createRunStepCommand({
  tasks: {
    actorNames: {},
    assignees: {
      resolve: () => Promise.resolve(null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
  },
  smsAvailable: true,
});

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

type BusinessContext = TenantContext & { readonly businessId: string };

function crm(
  context: TenantContext,
  operationId: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<unknown> {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  const invocation: Invocation = { context, permissions: 'all' };
  return route.run({ invocation, body, params, query: {} }, services);
}

interface Scene {
  readonly context: BusinessContext;
  /** Ada, with an email address and a phone number. */
  readonly contactId: string;
  readonly email: string;
  field(
    key: string,
    change?: Record<string, unknown>,
    value?: { column: string; value: unknown },
  ): Promise<FieldDefinition>;
  rename(field: FieldDefinition, label: string, archived?: boolean): Promise<FieldDefinition>;
  value(name: string, text: string): Promise<CustomValue>;
  saveValue(current: CustomValue, change: Record<string, unknown>): Promise<CustomValue>;
  values(recordId?: string): Promise<ConditionValues>;
  fillable(): Promise<string[]>;
  /** A number able to send and marketing consent, so a text step can run. */
  canText(): Promise<void>;
  /** Publishes one text step as written, enrols Ada, runs it, and gives what came of it. */
  text(message: string): Promise<{ status: string; exit_reason: string | null; sent: string[] }>;
}

async function scene(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: BusinessContext = {
    ...business.context,
    businessId: business.id,
    correlationId: randomUUID(),
  };
  const email = `${randomUUID()}@example.test`;
  // A possible US number: +1 555 and seven more digits.
  const phone = `+1202${String(randomInt(2, 10))}${String(randomInt(20, 100))}${String(randomInt(0, 10_000)).padStart(4, '0')}`;
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', lastName: 'Lovelace', emails: [email], phones: [phone] },
    { context, permissions: 'all' },
  );
  const event = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow(),
  );
  const contactId = event.subject_id;
  const superuser = <T>(work: (sql: Sql) => Promise<T>) => database.as('postgres', work);
  const editing = (field: FieldDefinition) => ({
    label: field.label,
    description: field.description,
    options: field.options,
    aiFillSources: field.aiFillSources,
    aiOverwrite: field.aiOverwrite,
    archived: field.archived,
    revision: field.revision,
  });
  return {
    context,
    contactId,
    email,
    field: async (key, change = {}, value = { column: 'value_text', value: `the ${key}` }) => {
      const made = fieldDefinition.parse(
        await crm(context, 'createField', {
          objectKey: 'contact',
          key,
          label: key.replaceAll('_', ' '),
          description: 'What it means.',
          valueType: 'text',
          options: [],
          currency: null,
          aiFillSources: [],
          aiOverwrite: 'ask',
          archived: false,
          ...change,
        }),
      );
      // Ada's value for it, where the field is one of a contact's.
      if (made.objectKey === 'contact')
        await database.withTenant(context, (sql) =>
          sql.query(
            `insert into crm.field_values
               (business_id, record_id, field_id, value_type, ${value.column}, source_kind)
             values (app.business_id(), $1, $2, $3, $4, 'user')`,
            [contactId, parsePublicId('field', made.id), made.valueType, value.value],
          ),
        );
      return made;
    },
    rename: async (field, label, archived = field.archived) =>
      fieldDefinition.parse(
        await crm(
          context,
          'updateField',
          { ...editing(field), label, archived },
          { fieldId: field.id },
        ),
      ),
    value: async (name, text) =>
      customValue.parse(await crm(context, 'createCustomValue', { name, value: text })),
    saveValue: async (current, change) =>
      customValue.parse(
        await crm(
          context,
          'updateCustomValue',
          {
            name: current.name,
            value: current.value,
            folderId: current.folderId,
            revision: current.revision,
            ...change,
          },
          { valueId: current.id },
        ),
      ),
    values: (recordId = contactId) =>
      withTenant(db, context, (trx) => contactValues(trx, recordId)),
    fillable: () => withTenant(db, context, (trx) => readTemplateFields(trx)),
    canText: async () => {
      await superuser(async (sql) => {
        await addPhoneNumber(sql, context, 'Front desk');
        await sql.query(
          `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
           on conflict (business_id) do update set quiet_hours_enabled = false`,
          [business.id],
        );
        await sql.query(
          `insert into messaging.consents
             (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
           values ($1, $2, 'sms', 'marketing', 'granted', 'user', 'user')`,
          [business.id, contactId],
        );
      });
    },
    text: async (message) => {
      const document: AutomationDocumentInput = {
        name: `Text ${randomUUID().slice(0, 8)}`,
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'text',
        steps: { text: { type: 'sms.send', config: { message } } },
      };
      const enrolmentId = await withTenant(db, context, async (trx) => {
        const { id } = await trx
          .insertInto('automation.automations')
          .values({
            business_id: business.id,
            name: document.name,
            draft: JSON.stringify(document),
            created_by_kind: 'system',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        // Published as written: no validator has rewritten a path, so what fills the text
        // in is what the reader gives at the moment the step runs.
        await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
        const enrolled = (await matchEvent(trx, context, event.id, contactValues)).enrolled.find(
          (each) => each.automationId === id,
        );
        if (enrolled === undefined) throw new Error('Nothing enrolled.');
        return enrolled.enrolmentId;
      });
      await runCommand(
        services,
        runStep,
        { enrolmentId, sequence: 0 },
        { context, permissions: 'all' },
      );
      const outcome = await withTenant(db, context, (trx) =>
        trx
          .selectFrom('automation.enrolments')
          .select(['status', 'exit_reason'])
          .where('id', '=', enrolmentId)
          .executeTakeFirstOrThrow(),
      );
      const messages = await database.withTenant(context, (sql) =>
        sql.query<{ body_text: string }>(
          `select body_text from messaging.messages where channel = 'sms' order by created_at, id`,
        ),
      );
      return { ...outcome, sent: messages.map((each) => each.body_text) };
    },
  };
}

describe('what a send reads of a contact', () => {
  it('has a custom field under its merge key and its older path, and a custom value under both of its', async () => {
    const s = await scene();
    const field = await s.field(
      'event_date',
      { valueType: 'date' },
      {
        column: 'value_date',
        value: '2027-06-12',
      },
    );
    const reel = await s.value('Sample reel URL', 'https://harborlights.example/reel');
    expect([field.mergeKey, reel.mergeKey]).toEqual([
      'contact.event_date',
      'custom_values.sample_reel_url',
    ]);
    const values = await s.values();
    expect(values).toMatchObject({
      'contact.firstName': 'Ada',
      'contact.custom.event_date': '2027-06-12',
      'contact.event_date': '2027-06-12',
      'custom_values.sample_reel_url': 'https://harborlights.example/reel',
      'values.sample_reel_url': 'https://harborlights.example/reel',
    });
    // The keys the settings pages show are the paths that are read.
    expect(values[field.mergeKey ?? '']).toBe('2027-06-12');
    expect(values[reel.mergeKey]).toBe('https://harborlights.example/reel');
  });

  it('never lets a custom field take the place of a built-in one of the same name', async () => {
    const s = await scene();
    const name = await s.field('name', { label: 'Nickname' });
    const email = await s.field('email', { label: 'Second email' });
    expect([name.mergeKey, email.mergeKey]).toEqual([
      'contact.custom.name',
      'contact.custom.email',
    ]);
    expect(await s.values()).toMatchObject({
      'contact.name': 'Ada Lovelace',
      'contact.custom.name': 'the name',
      'contact.email': s.email,
      'contact.custom.email': 'the email',
    });
  });

  it('leaves out an archived field, a custom value with nothing in it, and a deleted one', async () => {
    const s = await scene();
    const venue = await s.field('venue');
    const hours = await s.value('Hours', '9 to 5');
    const blank = await s.value('Blank', ' \n\t ');
    await s.value('Empty', '');
    expect(Object.keys(await s.values()).filter((path) => !path.startsWith('contact.'))).toEqual([
      'custom_values.hours',
      'values.hours',
    ]);
    await s.rename(venue, 'Venue', true);
    await crm(s.context, 'deleteCustomValue', undefined, { valueId: hours.id });
    const later = await s.values();
    for (const path of [
      'contact.venue',
      'contact.custom.venue',
      'custom_values.hours',
      'values.hours',
      blank.mergeKey,
    ])
      expect(later).not.toHaveProperty([path]);
    expect(later['contact.firstName']).toBe('Ada');
  });

  it('reads a key that a merged field left behind from the field that survived it', async () => {
    const s = await scene();
    const survivor = await s.field('event_date');
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into crm.field_key_aliases (business_id, object_type_id, alias_key, field_id)
         select business_id, object_type_id, 'wedding_date', id from crm.field_definitions
         where id = $1`,
        [parsePublicId('field', survivor.id)],
      ),
    );
    expect(await s.values()).toMatchObject({
      'contact.custom.wedding_date': 'the event_date',
      'contact.wedding_date': 'the event_date',
      'contact.event_date': 'the event_date',
    });
    expect(await s.fillable()).toEqual([
      ...contactMergeFields,
      ...contactAttribution,
      'contact.custom.event_date',
      'contact.event_date',
      'contact.custom.wedding_date',
      'contact.wedding_date',
    ]);
  });

  it('gives a record that is not a contact the custom values alone, and another business none of it', async () => {
    const s = await scene();
    const other = await scene();
    await s.field('venue');
    await s.value('Hours', '9 to 5');
    expect(await s.values(randomUUID())).toEqual({
      'custom_values.hours': '9 to 5',
      'values.hours': '9 to 5',
    });
    expect(await other.values(s.contactId)).toEqual({});
    expect(await other.fillable()).toEqual([...contactMergeFields, ...contactAttribution]);
  });
});

// Where the contact came from: its first and latest touch, leaf by leaf.
const contactAttribution = attributionPaths.filter((path) => path.startsWith('contact.'));

describe('what no send can fill in', () => {
  it('is everything but the paths the reader gives a contact who has every value', async () => {
    const s = await scene();
    await s.field('event_date');
    await s.field('name', { label: 'Nickname' });
    const retired = await s.field('retired');
    await s.rename(retired, 'Retired', true);
    await s.field('quote_total', { objectKey: 'deal' });
    await s.field('city', { objectKey: 'company' });
    await s.value('Sample reel URL', 'https://harborlights.example/reel');
    await s.value('Not written yet', '');
    const fillable = await s.fillable();
    // One definition of the paths: the report and the reader can't disagree.
    expect([...fillable].sort()).toEqual(Object.keys(await s.values()).sort());
    expect(fillable).toEqual([
      ...contactMergeFields,
      ...contactAttribution,
      'contact.custom.event_date',
      'contact.event_date',
      'contact.custom.name',
      'custom_values.sample_reel_url',
      'values.sample_reel_url',
    ]);
    // A deal's and a company's fields have merge keys, and a template is told they can't
    // be filled in, exactly as it is for a key that is nobody's.
    const uses = [
      'contact.event_date',
      'contact.custom.event_date',
      'custom_values.sample_reel_url',
      'values.sample_reel_url',
      'opportunity.quote_total',
      'business.city',
      'contact.retired',
      'custom_values.not_written_yet',
      'custom_values.never_made',
    ];
    expect(uses.filter((path) => !fillable.includes(path))).toEqual([
      'opportunity.quote_total',
      'business.city',
      'contact.retired',
      'custom_values.not_written_yet',
      'custom_values.never_made',
    ]);
  });
});

describe('a text message step', () => {
  it('is sent with a field and a custom value filled in by their keys, renamed or not', async () => {
    const s = await scene();
    await s.canText();
    const field = await s.field(
      'event_date',
      { valueType: 'date' },
      {
        column: 'value_date',
        value: '2027-06-12',
      },
    );
    const reel = await s.value('Sample reel URL', 'https://harborlights.example/reel');
    const message =
      'Hi {{contact.firstName}}, your event on {{contact.event_date}} ({{ contact.custom.event_date }}): {{custom_values.sample_reel_url}} / {{values.sample_reel_url}}';
    const filled =
      'Hi Ada, your event on 2027-06-12 (2027-06-12): https://harborlights.example/reel / https://harborlights.example/reel';
    expect(await s.text(message)).toEqual({
      status: 'completed',
      exit_reason: null,
      sent: [filled],
    });

    // Renamed, both keep their keys, so the text written before still fills in.
    const renamedField = await s.rename(field, 'Day of the event');
    const renamedValue = await s.saveValue(reel, {
      name: 'Show reel',
      value: 'https://new.example/reel',
    });
    expect([renamedField.mergeKey, renamedValue.mergeKey]).toEqual([field.mergeKey, reel.mergeKey]);
    expect(await s.text(message)).toEqual({
      status: 'completed',
      exit_reason: null,
      sent: [
        filled,
        filled.replaceAll('https://harborlights.example/reel', 'https://new.example/reel'),
      ],
    });
  });

  it('stops, sending nothing, when a custom value it uses is empty, deleted or was never made', async () => {
    const s = await scene();
    await s.canText();
    const hours = await s.value('Hours', '9 to 5');
    const stopped = { status: 'failed', exit_reason: 'missing_values', sent: [] as string[] };
    expect(await s.text('We are open {{custom_values.never_made}}.')).toEqual(stopped);
    const emptied = await s.saveValue(hours, { value: '' });
    expect(await s.text('We are open {{custom_values.hours}}.')).toEqual(stopped);
    await crm(s.context, 'deleteCustomValue', undefined, { valueId: emptied.id });
    expect(await s.text('We are open {{values.hours}}.')).toEqual(stopped);
    expect(await s.text('We are open {{opportunity.quote_total}} {{business.city}}.')).toEqual(
      stopped,
    );
  });

  it('puts a custom value in as text: braces inside it are not filled in again', async () => {
    const s = await scene();
    await s.canText();
    await s.value('Signature', 'Ask {{contact.email}} or {{custom_values.signature}}');
    expect((await s.text('{{custom_values.signature}}')).sent).toEqual([
      'Ask {{contact.email}} or {{custom_values.signature}}',
    ]);
    // In a subject, a value with a line break still stops the message.
    await s.value('Two lines', 'One\nTwo');
    expect(
      renderMessageTemplate(
        { subject: 'About {{custom_values.two_lines}}', body: 'Hello' },
        await s.values(),
      ),
    ).toEqual({ ok: false, code: 'subject_line_break', fields: ['custom_values.two_lines'] });
  });
});

describe('the validator, with what this business has', () => {
  // AUTOMATIONS.md section 2, the step that could not be published while no business had
  // custom values.
  const reel = 'Here’s our video sample reel: {{values.sample_reel_url}}';
  const document = (message: string): AutomationDocumentInput => ({
    name: 'New lead follow-up',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'send_reel',
    steps: { send_reel: { type: 'sms.send', config: { message } } },
  });

  it('accepts the documented custom value once it exists, in either spelling, and the step then sends it', async () => {
    const s = await scene();
    await s.canText();
    const setup = () =>
      withTenant(db, s.context, (trx) =>
        readAutomationSetup(trx, s.context, () => Promise.resolve([]), {
          webhookDelivery: false,
          smsDelivery: true,
        }),
      );
    const errors = async (message: string) =>
      validateAutomation(document(message), await setup()).errors;
    expect((await setup()).values).toEqual([]);
    expect(await errors(reel)).toEqual([
      {
        path: '/steps/send_reel/config/message',
        code: 'unknown_merge_field',
        message: 'values.sample_reel_url is not a custom value.',
      },
    ]);

    await s.value('Sample reel URL', 'https://harborlights.example/reel');
    await s.value('Not written yet', '');
    // Listed by key, with or without text: a key that exists is not an unknown one.
    expect((await setup()).values).toEqual(['not_written_yet', 'sample_reel_url']);
    expect(await errors(reel)).toEqual([]);
    expect(await errors('Reel: {{custom_values.sample_reel_url}}')).toEqual([]);
    expect(await errors('Reel: {{custom_values.sample_reel_ur}}')).toEqual([
      {
        path: '/steps/send_reel/config/message',
        code: 'unknown_merge_field',
        message: 'custom_values.sample_reel_ur is not a custom value.',
        suggestion: 'Did you mean sample_reel_url?',
      },
    ]);
    expect((await s.text(reel)).sent).toEqual([
      'Here’s our video sample reel: https://harborlights.example/reel',
    ]);
  });

  it('knows a contact field by its merge key and stores the canonical path, which a send fills in', async () => {
    const s = await scene();
    await s.canText();
    await s.field(
      'event_date',
      { valueType: 'date' },
      { column: 'value_date', value: '2027-06-12' },
    );
    const result = await withTenant(db, s.context, async (trx) =>
      validateAutomation(
        document('See you on {{contact.event_date}}.'),
        await readAutomationSetup(trx, s.context, () => Promise.resolve([]), {
          webhookDelivery: false,
          smsDelivery: true,
        }),
      ),
    );
    expect(result.errors).toEqual([]);
    const stored = (result.document?.steps['send_reel']?.config as { message: string }).message;
    expect(stored).toBe('See you on {{contact.custom.event_date}}.');
    expect((await s.text(stored)).sent).toEqual(['See you on 2027-06-12.']);
  });
});
