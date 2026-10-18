// sms.send: the step fills its text in for the enrolled contact and queues it through
// messaging's own outbound path, once, and only as messaging's policy allows: consent, do
// not contact and quiet hours. Real Postgres, the real step command, and no provider:
// queued is as far as this goes.
import { randomInt, randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { addPhoneNumber, type PhoneNumberState } from '../test/phone-number.js';
import { sendTextMessage } from './actions-sms.js';
import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';

// These automations create no tasks, so nothing here resolves an assignee.
const tasks = {
  actorNames: {},
  assignees: {
    resolve: () => Promise.resolve(null),
    read: () => Promise.resolve({ items: [], nextCursor: null }),
    memberships: () => Promise.resolve(new Map<string, string>()),
  },
};
/** The engine of an install that can deliver text messages, and of one that can't. */
const delivering = createRunStepCommand({ tasks, smsAvailable: true });
const undelivering = createRunStepCommand({ tasks });

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

interface Message {
  id: string;
  channel: string;
  status: string;
  error_code: string | null;
  body_text: string;
  to_addresses: string[];
  sender: string;
}

interface Scene {
  readonly context: TenantContext & { readonly businessId: string };
  readonly contactId: string;
  readonly phone: string;
  /** Adds a number able to send, unless told otherwise, and returns its ids. */
  number(name: string, state?: PhoneNumberState): Promise<{ id: string; publicId: string }>;
  consent(status: 'granted' | 'withdrawn'): Promise<void>;
  /** As a superuser, for what a test arranges outside any command. */
  arrange(text: string, values?: readonly unknown[]): Promise<void>;
  /** Publishes the automation, enrols the contact, and runs its first step. */
  run(
    config: { message: string; number?: string },
    command?: typeof delivering,
  ): Promise<{ status: string; exit_reason: string | null }>;
  messages(): Promise<Message[]>;
  stepRuns(): Promise<{ status: string; output: { messageId?: string }; explanation: string }[]>;
}

/**
 * A business with one contact, Ada, who has a phone number. Quiet hours are off unless a
 * test turns them on, so the time of day never matters.
 */
async function scene(as: { phone?: boolean; firstName?: string } = {}): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, businessId: business.id, correlationId: randomUUID() };
  // A possible US number: +1 555 and seven more digits.
  const phone = `+1202${String(randomInt(2, 10))}${String(randomInt(20, 100))}${String(randomInt(0, 10_000)).padStart(4, '0')}`;
  await runCommand(
    services,
    createContactCommand,
    {
      firstName: as.firstName ?? 'Ada',
      emails: [`${randomUUID()}@example.test`],
      ...(as.phone === false ? {} : { phones: [phone] }),
    },
    { context, permissions: 'all' },
  );
  const event = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow(),
  );
  const superuser = <T>(work: (sql: Sql) => Promise<T>) => database.as('postgres', work);
  const arrange: Scene['arrange'] = async (text, values = []) => {
    await superuser((sql) => sql.query(text, values));
  };
  await arrange(
    `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
     on conflict (business_id) do update set quiet_hours_enabled = false`,
    [business.id],
  );
  return {
    context,
    contactId: event.subject_id,
    phone,
    number: (name, state) => superuser((sql) => addPhoneNumber(sql, context, name, state)),
    consent: (status) =>
      arrange(
        `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
         values ($1, $2, 'sms', 'marketing', $3, 'user', 'user')`,
        [business.id, event.subject_id, status],
      ),
    arrange,
    run: async (config, command = delivering) => {
      const document: AutomationDocumentInput = {
        name: 'Check in',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'text',
        steps: { text: { type: 'sms.send', config } },
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
        await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
        const [first] = (await matchEvent(trx, context, event.id, contactValues)).enrolled;
        if (first === undefined) throw new Error('Nothing enrolled.');
        return first.enrolmentId;
      });
      await runCommand(
        services,
        command,
        { enrolmentId, sequence: 0 },
        { context, permissions: 'all' },
      );
      return withTenant(db, context, (trx) =>
        trx
          .selectFrom('automation.enrolments')
          .select(['status', 'exit_reason'])
          .where('id', '=', enrolmentId)
          .executeTakeFirstOrThrow(),
      );
    },
    messages: () =>
      database.withTenant(context, (sql) =>
        sql.query<Message>(
          `select id, channel, status, error_code, body_text, to_addresses,
                  channel_account_id as sender
           from messaging.messages order by created_at, id`,
        ),
      ),
    stepRuns: () =>
      database.withTenant(context, (sql) =>
        sql.query('select status, output, explanation from automation.step_runs'),
      ),
  };
}

const done = { status: 'completed', exit_reason: null };
const failed = (reason: string) => ({ status: 'failed', exit_reason: reason });

it('queues the text, filled in, to the contact from the only number, as marketing', async () => {
  const s = await scene();
  const number = await s.number('Front desk');
  await s.consent('granted');
  expect(await s.run({ message: 'Hi {{contact.firstName}}, still interested?' })).toEqual(done);
  const messages = await s.messages();
  expect(messages).toEqual([
    {
      id: expect.any(String) as string,
      channel: 'sms',
      status: 'queued',
      error_code: null,
      body_text: 'Hi Ada, still interested?',
      to_addresses: [s.phone],
      sender: number.id,
    },
  ]);
  const lanes = await database.withTenant(s.context, (sql) =>
    sql.query<{ purpose: string; lane: string }>(
      'select purpose, lane from messaging.outbound_dispatch',
    ),
  );
  // Marketing, so it needs the contact's consent; the automation lane, behind replies.
  expect(lanes).toEqual([{ purpose: 'marketing', lane: 'automation' }]);
  expect(await s.stepRuns()).toEqual([
    {
      status: 'succeeded',
      output: { messageId: messages[0]?.id },
      explanation: 'The text message was queued to send.',
    },
  ]);
  // Handed to the same dispatch job every other message goes through, on the business's queue.
  const jobs = await database.as('crm_owner', (sql) =>
    sql.query<{ queue_name: string }>(
      "select queue_name from graphile_worker.jobs where task_identifier = 'messaging.dispatch'",
    ),
  );
  expect(jobs).toEqual([{ queue_name: `outbound:${s.context.businessId}` }]);
});

it('queues one text per visit, however often the same visit is run', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.consent('granted');
  const send = (key: string) =>
    withTenant(db, s.context, (trx) =>
      sendTextMessage(trx, s.context, {
        contactId: s.contactId,
        message: 'Hi {{contact.firstName}}.',
        number: undefined,
        idempotencyKey: key,
        available: true,
      }),
    );
  const first = await send('automation:run:text:0');
  expect(first.ok).toBe(true);
  expect(await send('automation:run:text:0')).toEqual(first);
  expect(await s.messages()).toHaveLength(1);
  // A later visit, such as the next pass of a loop, is a new message.
  expect(await send('automation:run:text:1')).not.toEqual(first);
  expect(await s.messages()).toHaveLength(2);
});

it.each([
  ['no consent', undefined, 'consent_required'],
  ['withdrawn consent', 'withdrawn', 'consent_withdrawn'],
] as const)('fails the step and sends nothing with %s', async (_, consent, code) => {
  const s = await scene();
  await s.number('Front desk');
  if (consent !== undefined) await s.consent(consent);
  expect(await s.run({ message: 'Hi.' })).toEqual(failed(code));
  // Messaging keeps its own record of what it refused, and why; nothing is queued to send.
  expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: code }]);
  expect(await s.stepRuns()).toMatchObject([
    { status: 'failed', explanation: `Messaging refused the text message: ${code}.` },
  ]);
});

it('fails the step for a contact marked do not contact, even with consent', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.consent('granted');
  await s.arrange('update crm.contacts set do_not_contact = true where id = $1', [s.contactId]);
  expect(await s.run({ message: 'Hi.' })).toEqual(failed('do_not_contact'));
  expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: 'do_not_contact' }]);
});

it('holds the text during quiet hours instead of sending it, and the step says so', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.consent('granted');
  // Quiet all day in the contact's own time zone: the same start and end.
  await s.arrange(
    `update messaging.settings set quiet_hours_enabled = true,
       quiet_hours_start = '21:00', quiet_hours_end = '21:00' where business_id = $1`,
    [s.context.businessId],
  );
  await s.arrange("update crm.contacts set timezone = 'Africa/Nairobi' where id = $1", [
    s.contactId,
  ]);
  expect(await s.run({ message: 'Hi.' })).toEqual(done);
  const [message] = await database.withTenant(s.context, (sql) =>
    sql.query<{ status: string; error_code: string | null; later: boolean }>(
      'select status, error_code, scheduled_for > now() as later from messaging.messages',
    ),
  );
  // Still queued, not refused: messaging tries it again once the quiet hours are over.
  expect(message).toEqual({ status: 'queued', error_code: 'quiet_hours', later: true });
  expect(await s.stepRuns()).toMatchObject([
    {
      status: 'succeeded',
      explanation: "The text message was queued; it is held until the contact's quiet hours end.",
    },
  ]);
});

it('refuses a contact when neither it nor the business has a usable time zone while quiet hours apply, rather than guess', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.consent('granted');
  await s.arrange(
    'update messaging.settings set quiet_hours_enabled = true where business_id = $1',
    [s.context.businessId],
  );
  // A contact with no zone of its own is timed by the business's; here that one is no zone
  // either.
  await s.arrange("update tenancy.businesses set timezone = 'Nowhere/Zone' where id = $1", [
    s.context.businessId,
  ]);
  expect(await s.run({ message: 'Hi.' })).toEqual(failed('timing_unknown'));
});

it('fails the step, and makes no message, when it cannot be written or addressed', async () => {
  const missing = await scene();
  await missing.number('Front desk');
  await missing.consent('granted');
  expect(await missing.run({ message: 'About your {{contact.custom.event_date}} event.' })).toEqual(
    failed('missing_values'),
  );
  expect(await missing.messages()).toEqual([]);

  const noPhone = await scene({ phone: false });
  await noPhone.number('Front desk');
  expect(await noPhone.run({ message: 'Hi.' })).toEqual(failed('no_phone_number'));
  expect(await noPhone.messages()).toEqual([]);

  // 1,600 characters is the most a text holds. As written this one fits exactly; filled in
  // with a name longer than its merge field, it no longer does.
  const long = await scene({ firstName: 'Wilhelmina-Alexandrina' });
  await long.number('Front desk');
  await long.consent('granted');
  const written = `${'x'.repeat(1579)}{{contact.firstName}}`;
  expect(written).toHaveLength(1600);
  expect(await long.run({ message: written })).toEqual(failed('sms_body_too_long'));
  expect(await long.messages()).toEqual([]);
});

it('needs the step to name a number when more than one could send, and uses the one named', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.number('Events line');
  await s.consent('granted');
  expect(await s.run({ message: 'Hi.' })).toEqual(failed('number_required'));
  expect(await s.messages()).toEqual([]);

  const named = await scene();
  await named.number('Front desk');
  const chosen = await named.number('Events line');
  await named.consent('granted');
  expect(await named.run({ message: 'Hi.', number: chosen.publicId })).toEqual(done);
  expect((await named.messages()).map((message) => message.sender)).toEqual([chosen.id]);
});

it('sends only from a number that can send now, named or not, and never another business’s', async () => {
  const unusable: readonly PhoneNumberState[] = [
    { status: 'paused' },
    { connection: 'disconnected' },
    { capabilities: ['voice'] },
  ];
  for (const state of unusable) {
    const s = await scene();
    await s.number('Unusable', state);
    await s.consent('granted');
    // It is not picked as the only number, and naming it does not help.
    expect(await s.run({ message: 'Hi.' })).toEqual(failed('number_required'));
    const named = await scene();
    const theirs = await named.number('Unusable', state);
    await named.consent('granted');
    expect(await named.run({ message: 'Hi.', number: theirs.publicId })).toEqual(
      failed('number_unavailable'),
    );
    expect(await s.messages()).toEqual([]);
    expect(await named.messages()).toEqual([]);
  }
  // Beside a usable one, the unusable number doesn't make the choice ambiguous.
  const s = await scene();
  const desk = await s.number('Front desk');
  await s.number('Voice only', { capabilities: ['voice'] });
  await s.consent('granted');
  expect(await s.run({ message: 'Hi.' })).toEqual(done);
  expect((await s.messages()).map((message) => message.sender)).toEqual([desk.id]);

  const other = await scene();
  const theirNumber = await other.number('Theirs');
  const mine = await scene();
  await mine.consent('granted');
  expect(await mine.run({ message: 'Hi.', number: theirNumber.publicId })).toEqual(
    failed('number_unavailable'),
  );
  expect(await mine.messages()).toEqual([]);
});

it('fails the step on an install that cannot deliver text messages, queueing nothing', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.consent('granted');
  expect(await s.run({ message: 'Hi.' }, undelivering)).toEqual(failed('sms_unavailable'));
  expect(await s.messages()).toEqual([]);
});

// A trigger link in the step's text.
const linking = createRunStepCommand({
  tasks,
  smsAvailable: true,
  publicUrl: 'https://crm.example',
});

it('sends a trigger link as the contact’s own address for it, and stops without one', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.consent('granted');
  await s.arrange(
    `insert into messaging.trigger_links (business_id, name, key, url, created_by_kind)
     values ($1, 'Offer', 'offer', 'https://harbor.example/offer', 'system')`,
    [s.context.businessId],
  );
  const tokens = () =>
    database.withTenant(s.context, (sql) =>
      sql.query<{ contact_id: string }>('select contact_id from messaging.trigger_link_tokens'),
    );
  // An install with no public address has nowhere to point the link: nothing is sent.
  expect(await s.run({ message: 'See {{trigger_link.offer}}' })).toEqual(failed('missing_values'));
  // A link the business does not have stops the text too, and issues nothing.
  expect(await s.run({ message: 'See {{trigger_link.gone}}' }, linking)).toEqual(
    failed('missing_values'),
  );
  expect(await s.messages()).toEqual([]);
  expect(await tokens()).toEqual([]);

  expect(
    await s.run({ message: 'Hi {{contact.firstName}}: {{trigger_link.offer}}' }, linking),
  ).toEqual(done);
  const [message] = await s.messages();
  expect(message?.body_text).toMatch(/^Hi Ada: https:\/\/crm\.example\/l\/[A-Za-z0-9_-]{43}$/);
  expect(await tokens()).toEqual([{ contact_id: s.contactId }]);
});
