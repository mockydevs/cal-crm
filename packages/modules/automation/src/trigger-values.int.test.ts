// Event-backed native output mapping and immutable run/record/version boundaries.
import { randomUUID } from 'node:crypto';

import { allowEveryone, defineCommand, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationTriggerType } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { triggerValues } from './trigger-values.js';
import { contactValues } from './values.js';

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

// Fixed UUIDv7 and its literal base32 public suffix, independent of the runtime mapper.
const subjectId = '00000000-0000-7000-8000-000000000001';
const reference = '00000000-0000-7000-8000-000000000002';
const cases: readonly {
  trigger: AutomationTriggerType;
  event: string;
  kind: string;
  config: Record<string, string>;
  payload: Record<string, string>;
  output: Record<string, string>;
}[] = [
  {
    trigger: 'message.received',
    event: 'message.received',
    kind: 'message',
    config: { channel: 'email' },
    payload: { channel: 'email', messageId: reference, body: 'Sanitized private text' },
    output: { 'trigger.messageId': 'msg_0000000000e008000000000001' },
  },
  {
    trigger: 'form.submitted',
    event: 'form.submitted',
    kind: 'form_submission',
    config: { form: reference },
    payload: { formId: reference, submissionId: subjectId },
    output: { 'trigger.submissionId': 'fsub_0000000000e008000000000001' },
  },
  {
    trigger: 'appointment.booked',
    event: 'appointment.booked',
    kind: 'appointment',
    config: {},
    payload: {},
    output: { 'trigger.appointmentId': 'appt_0000000000e008000000000001' },
  },
  {
    trigger: 'appointment.status_changed',
    event: 'appointment.status_changed',
    kind: 'appointment',
    config: { status: 'cancelled' },
    payload: { status: 'cancelled' },
    output: { 'trigger.appointmentId': 'appt_0000000000e008000000000001' },
  },
  {
    trigger: 'deal.stage_changed',
    event: 'deal.stage_changed',
    kind: 'deal',
    config: {},
    payload: {},
    output: { 'trigger.dealId': 'deal_0000000000e008000000000001' },
  },
  {
    trigger: 'deal.closed',
    event: 'deal.won',
    kind: 'deal',
    config: { outcome: 'won' },
    payload: {},
    output: { 'trigger.dealId': 'deal_0000000000e008000000000001' },
  },
  {
    trigger: 'trigger_link.clicked',
    event: 'trigger_link.clicked',
    kind: 'trigger_link',
    config: { link: subjectId },
    payload: { linkId: subjectId },
    output: { 'trigger.linkId': 'tlnk_0000000000e008000000000001' },
  },
  {
    trigger: 'contact.created',
    event: 'contact.created',
    kind: 'contact',
    config: {},
    payload: {},
    output: {},
  },
];

it.each(cases)(
  'provides only the declared $trigger output from the enrolled version',
  async (at) => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const context = { ...business.context, correlationId: randomUUID() };
    const contact = await database.fixtures.contact(context, { firstName: 'Ada' });
    const other = await database.fixtures.contact(context, { firstName: 'Grace' });
    const document = automationDocument.parse({
      name: 'Native outputs',
      triggers: [{ id: 'received', type: at.trigger, config: at.config }],
      start: 'pause',
      steps: { pause: { type: 'wait', config: { duration: 'PT1M' } } },
    });
    const automationId = await withTenant(db, context, async (trx) => {
      const automation = await trx
        .insertInto('automation.automations')
        .values({
          business_id: business.id,
          name: document.name,
          draft: JSON.stringify(document),
          created_by_kind: 'system',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await publishAutomationVersion(trx, context, automation.id, document, 'First');
      return automation.id;
    });
    const eventId = await runCommand(
      services,
      defineCommand({
        name: 'test.native_trigger_output',
        permission: 'contacts.manage',
        input: z.strictObject({}),
        handle: (_trx, _input, command) =>
          command.emit({
            type: at.event,
            subject: { kind: at.kind, id: subjectId },
            records: [contact.id],
            payload: at.payload,
          }),
      }),
      {},
      { context, permissions: 'all' },
    );
    const result = await withTenant(db, context, (trx) =>
      matchEvent(trx, context, eventId, contactValues),
    );
    expect(result.enrolled).toHaveLength(1);
    const run = result.enrolled[0];
    if (run === undefined) throw new Error('Fixture did not enrol.');
    // A later publication no longer has this trigger: the old run must keep its event data.
    await withTenant(db, context, (trx) =>
      publishAutomationVersion(
        trx,
        context,
        automationId,
        automationDocument.parse({
          ...document,
          triggers: [{ id: 'different', type: 'contact.created', config: {} }],
        }),
        'Second',
      ),
    );
    expect(
      await withTenant(db, context, (trx) => triggerValues(trx, contact.id, run.enrolmentId)),
    ).toEqual(at.output);
    expect(
      await withTenant(db, context, (trx) => triggerValues(trx, other.id, run.enrolmentId)),
    ).toEqual({});
    const outsider = await database.fixtures.business(agency.id);
    expect(
      await withTenant(db, { ...outsider.context, correlationId: randomUUID() }, (trx) =>
        triggerValues(trx, contact.id, run.enrolmentId),
      ),
    ).toEqual({});
  },
);
