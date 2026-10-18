// The seven triggers of quotes, invoices and payments on real Postgres: an event shaped as
// the commerce module emits one (its document or payment as the subject, the contact among
// the records it happened to) enrols the contact once in an automation that listens for it,
// and hands the automation the document or the payment.
import { randomUUID } from 'node:crypto';

import { allowEveryone, defineCommand, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { contactValues, matchEvent, publishAutomationVersion } from './index.js';
import { triggerValues } from './trigger-values.js';

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

const TRIGGERS = [
  ['quote.sent', 'sales_document', 'documentId', 'sdoc_'],
  ['quote.accepted', 'sales_document', 'documentId', 'sdoc_'],
  ['quote.declined', 'sales_document', 'documentId', 'sdoc_'],
  ['invoice.issued', 'sales_document', 'documentId', 'sdoc_'],
  ['invoice.sent', 'sales_document', 'documentId', 'sdoc_'],
  ['invoice.paid', 'sales_document', 'documentId', 'sdoc_'],
  ['payment.recorded', 'payment', 'paymentId', 'pay_'],
] as const;

/** An event as commerce emits it: the document or the payment, on the contact's timeline. */
const happened = defineCommand({
  name: 'fixture.commerce_event',
  permission: 'payments.manage',
  input: z.strictObject({
    type: z.string(),
    subjectKind: z.enum(['sales_document', 'payment']),
    contactId: z.uuid(),
  }),
  async handle(trx, input, command): Promise<{ eventId: string; subjectId: string }> {
    const { id: subjectId } = await trx
      .selectNoFrom(sql<string>`uuidv7()`.as('id'))
      .executeTakeFirstOrThrow();
    const eventId = await command.emit({
      type: input.type,
      subject: { kind: input.subjectKind, id: subjectId },
      payload: { number: 'INV-0007', total: '1500.0000', currency: 'KES' },
      records: [input.contactId],
    });
    return { eventId, subjectId };
  },
});

it.each(TRIGGERS)(
  'enrols the contact on %s, once, and hands the automation what it happened to',
  async (type, subjectKind, key, prefix) => {
    const agency = await database.fixtures.agency();
    const created = await database.fixtures.business(agency.id);
    const context: TenantContext = { ...created.context, correlationId: randomUUID() };
    const invocation = { context, permissions: 'all' } as const;
    const document: AutomationDocumentInput = {
      name: 'After the paperwork',
      triggers: [{ id: 'commerce', type, config: {} }],
      start: 'tag_new',
      steps: { tag_new: { type: 'tag.add', config: { tag: 'Billed' } } },
    };
    const automationId = await withTenant(db, context, async (trx) => {
      const { id } = await trx
        .insertInto('automation.automations')
        .values({
          business_id: created.id,
          name: document.name,
          draft: JSON.stringify(document),
          created_by_kind: 'system',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await publishAutomationVersion(
        trx,
        context,
        id,
        automationDocument.parse(document),
        'First version',
      );
      return id;
    });
    await runCommand(
      services,
      createContactCommand,
      { firstName: 'Maya', emails: [`${randomUUID()}@example.test`] },
      invocation,
    );
    const contact = await withTenant(db, context, (trx) =>
      trx.selectFrom('crm.contacts').select('id').executeTakeFirstOrThrow(),
    );

    // Another commerce event is not this trigger's.
    const other = await runCommand(
      services,
      happened,
      { type: 'invoice.voided', subjectKind: 'sales_document', contactId: contact.id },
      invocation,
    );
    const match = (eventId: string) =>
      withTenant(db, context, (trx) => matchEvent(trx, context, eventId, contactValues));
    expect((await match(other.eventId)).enrolled).toEqual([]);

    const event = await runCommand(
      services,
      happened,
      { type, subjectKind, contactId: contact.id },
      invocation,
    );
    const { enrolled } = await match(event.eventId);
    expect(enrolled).toEqual([
      { automationId, recordId: contact.id, enrolmentId: expect.any(String) as string },
    ]);
    // Matched again, the same event enrols nobody twice.
    expect((await match(event.eventId)).enrolled).toEqual([]);

    const values = await withTenant(db, context, (trx) =>
      triggerValues(trx, contact.id, enrolled[0]?.enrolmentId ?? ''),
    );
    expect(values).toEqual({ [`trigger.${key}`]: toPublicId(subjectKind, event.subjectId) });
    expect(String(values[`trigger.${key}`])).toMatch(new RegExp(`^${prefix}`));
  },
);
