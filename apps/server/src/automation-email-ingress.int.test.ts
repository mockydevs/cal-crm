// A stored inbound email must reach its channel-filtered workflow, without a provider.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { parseInboundMessage } from '@repo/mail';
import { contactValues, matchEvent, publishAutomationVersion } from '@repo/module-automation';
import { createTagCommand } from '@repo/module-crm';
import { ingestInboundCommand } from '@repo/module-messaging';
import { createVault, newSecretsKey, parseSecretsKeys } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { workerTasks } from './worker-tasks.js';

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

it('enrols only the email workflow once and executes its native contact effect', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context, {
    firstName: 'Ada',
    email: 'ada@example.test',
  });
  const vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  const tag = await runCommand(
    services,
    createTagCommand,
    { name: 'Email reply received' },
    {
      context,
      permissions: 'all',
    },
  );
  const mailbox = await withTenant(db, context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
      JSON.stringify({ fixture: 'local ingestion only' }),
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: business.id, channel: 'email', name: 'Inbox' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        id: account.id,
        business_id: business.id,
        email_address: 'inbox@example.test',
        auth_method: 'password',
        smtp_host: 'localhost',
        smtp_port: 587,
        smtp_security: 'tls',
        smtp_username: 'fixture',
        imap_host: 'localhost',
        imap_port: 993,
        imap_security: 'tls',
        imap_username: 'fixture',
        secret_id: secretId,
        imap_uid_validity: '1',
        imap_last_uid: 0,
      })
      .execute();
    const secret = await trx
      .selectFrom('vault.secrets')
      .select(sql<string>`encode(sha256(enc || ciphertext), 'hex')`.as('sha256'))
      .where('id', '=', secretId)
      .executeTakeFirstOrThrow();
    return { id: account.id, secretId, sha256: secret.sha256 };
  });
  const publish = (channel: 'email' | 'sms') =>
    withTenant(db, context, async (trx) => {
      const document = automationDocument.parse({
        name: `Inbound ${channel}`,
        triggers: [{ id: 'received', type: 'message.received', config: { channel } }],
        start: 'tag',
        steps: {
          tag: { type: 'tag.add', config: { tag: tag.id }, next: 'follow_up' },
          follow_up: { type: 'task.create', config: { title: 'Reply to {{trigger.messageId}}' } },
        },
      });
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
      await publishAutomationVersion(trx, context, automation.id, document, 'First version');
      return automation.id;
    });
  const emailWorkflow = await publish('email');
  await publish('sms');
  const parsed = await parseInboundMessage(
    Buffer.from(
      'From: Ada <ada@example.test>\r\nTo: inbox@example.test\r\nSubject: Hello\r\n' +
        'Message-ID: <automation-ingress@example.test>\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\nHello.\r\n',
    ),
  );
  if (parsed.outcome !== 'parsed') throw new Error('Sanitized email fixture did not parse.');
  const invocation = { context, permissions: 'all' as const };
  expect(
    await runCommand(
      services,
      ingestInboundCommand,
      {
        mailboxId: mailbox.id,
        expected: { uidValidity: '1', lastUid: 0 },
        credentials: { secretId: mailbox.secretId, sha256: mailbox.sha256 },
        next: { uidValidity: '1', lastUid: 1 },
        startedAt: null,
        items: [{ uid: 1, outcome: 'parsed', message: parsed.message, receivedAt: new Date() }],
      },
      invocation,
    ),
  ).toEqual({ applied: true, stored: 1 });
  const event = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'message.received')
      .executeTakeFirstOrThrow(),
  );
  const matched = await withTenant(db, context, (trx) =>
    matchEvent(trx, context, event.id, contactValues),
  );
  expect(matched.enrolled).toHaveLength(1);
  const run = matched.enrolled[0];
  if (run === undefined) throw new Error('Email workflow did not enrol.');
  expect(run.automationId).toBe(emailWorkflow);
  expect(
    (await withTenant(db, context, (trx) => matchEvent(trx, context, event.id, contactValues)))
      .enrolled,
  ).toEqual([]);
  const task = workerTasks().find((candidate) => candidate.name === 'automations.run_step');
  if (task === undefined) throw new Error('Missing composed automation worker.');
  await task.run(task.data.parse({ enrolmentId: run.enrolmentId, sequence: 0 }), {
    services,
    invocation,
  });
  await task.run(task.data.parse({ enrolmentId: run.enrolmentId, sequence: 1 }), {
    services,
    invocation,
  });
  expect(
    await database.withTenant(context, (client) =>
      client.query('select status from automation.enrolments where id=$1 and record_id=$2', [
        run.enrolmentId,
        contact.id,
      ]),
    ),
  ).toEqual([{ status: 'completed' }]);
  expect(
    await database.withTenant(context, (client) =>
      client.query(
        `select tag.name from crm.record_tags as assigned join crm.tags as tag on tag.id=assigned.tag_id
     where assigned.record_id=$1`,
        [contact.id],
      ),
    ),
  ).toEqual([{ name: 'Email reply received' }]);
  expect(
    await database.withTenant(context, (client) =>
      client.query('select title from crm.tasks where record_id=$1', [contact.id]),
    ),
  ).toEqual([{ title: `Reply to ${toPublicId('message', event.subject_id)}` }]);
});
