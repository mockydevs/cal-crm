// An email campaign from the API to the mail server, through the real HTTP composition and
// the real Graphile queue. Only the mail server is a stand-in: it keeps what it is handed.
// Module tests drive the campaign task by hand; only here do Send's own job, the sweep and
// the dispatch jobs meet, with a reply queued in between.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { allowEveryone } from '@repo/commands';
import {
  emailCampaign,
  emailCampaignChecks,
  emailCampaignRecipientList,
  emailCampaignStats,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import type { MailboxSubmitter } from '@repo/mail';
import {
  queueOutboundMessage,
  scheduleEmailCampaigns,
  type TwilioTransport,
} from '@repo/module-messaging';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';

import { apiRoutes } from '../api-routes.js';
import { campaignOptions } from '../campaign-options.js';
import type { Config } from '../config.js';
import { buildServer, type Server } from '../server.js';
import { createMessagingDeliveryTasks } from './messaging-tasks.js';
import { startWorker, type Worker } from './worker.js';

const ORIGIN = 'https://crm.example.test';
let database: TestDatabase;
let db: Database;
let vault: Vault;
const servers: Server[] = [];
const workers: Worker[] = [];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error('The campaign did not settle.');
    await delay(100);
  }
}

interface Handed {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly unsubscribeUrl: string | undefined;
}

it('sends a campaign from the API through the queue, a reply first, each contact once', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  // Every campaign email ends with the business's postal address.
  await database.as('postgres', (sql) =>
    sql.query(
      `update tenancy.businesses set address = '{"line1":"12 High St","city":"Austin"}'::jsonb where id = $1`,
      [business.id],
    ),
  );
  const user = await database.fixtures.user();
  const context: TenantContext = {
    ...business.context,
    actorKind: 'user',
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  const services = { db, authorize: allowEveryone };
  const names = ['Ada', 'Grace', 'Edsger'];
  const contacts: string[] = [];
  for (const firstName of names)
    contacts.push(
      (
        await database.fixtures.contact(context, {
          firstName,
          email: `${firstName.toLowerCase()}.${randomUUID()}@example.test`,
        })
      ).id,
    );
  const mailboxId = await withTenant(db, context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
      JSON.stringify({
        name: 'Campaigns',
        email: 'news@example.test',
        displayName: 'Harbor Lights',
        smtp: { host: 'localhost', port: 465, security: 'tls', username: 'u', password: 'p' },
        imap: { host: 'localhost', port: 993, security: 'tls', username: 'u', password: 'p' },
      }),
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: business.id, channel: 'email', name: 'Campaigns' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        business_id: business.id,
        id: account.id,
        email_address: 'news@example.test',
        display_name: 'Harbor Lights',
        auth_method: 'password',
        smtp_host: 'localhost',
        smtp_port: 465,
        smtp_security: 'tls',
        smtp_username: 'u',
        secret_id: secretId,
        use_for_campaigns: true,
        warmup_enabled: false,
        pacing_per_minute: 600,
      })
      .execute();
    await trx
      .insertInto('messaging.settings')
      .values({ business_id: business.id, quiet_hours_enabled: false })
      .execute();
    // These recipients are already checked. This worker runs campaign/SMTP tasks only;
    // the production worker also runs the separate address-verification task.
    await sql`insert into messaging.email_verifications
      (business_id,address_normalized,status,depth,checked_at)
      select business_id,value_normalized,'valid','mailbox',now()
      from crm.contact_identities where business_id=${business.id}::uuid
        and kind='email' and contact_id=any(${contacts}::uuid[])`.execute(trx);
    const run = await trx
      .insertInto('messaging.mailbox_check_runs')
      .values({
        business_id: business.id,
        mailbox_id: account.id,
        trigger: 'manual',
        method: 'self',
        score: 100,
        finished_at: sql`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [key, points] of [
      ['spf', 15],
      ['dkim', 20],
      ['dmarc', 14],
      ['unsubscribe', 6],
    ] as const)
      await trx
        .insertInto('messaging.mailbox_check_results')
        .values({
          business_id: business.id,
          run_id: run.id,
          check_key: key,
          status: 'pass',
          points_possible: points,
          points_awarded: points,
          details: JSON.stringify({ reason: 'fixture' }),
        })
        .execute();
    for (const purpose of ['marketing', 'transactional'])
      await trx
        .insertInto('messaging.consents')
        .values(
          contacts.map((contactId) => ({
            business_id: business.id,
            contact_id: contactId,
            channel: 'email',
            purpose,
            status: 'granted',
            source: 'user',
            recorded_by_kind: 'system',
          })),
        )
        .execute();
    return account.id;
  });

  const handed: Handed[] = [];
  const smtp: MailboxSubmitter = {
    submit(_login, _from, message) {
      handed.push({
        to: message.to,
        subject: message.subject,
        text: message.text,
        unsubscribeUrl: message.unsubscribeUrl,
      });
      return Promise.resolve({ outcome: 'accepted', messageId: message.messageId });
    },
  };
  const noTexts: TwilioTransport = () => Promise.reject(new Error('No text message is sent here.'));
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 2,
    shutdownTimeoutMs: 1000,
    dashboardDir: undefined,
    devTenantContext: { agencyId: agency.id, businessId: business.id, userId: user.id },
    publicUrl: ORIGIN,
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const server = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes: apiRoutes(undefined, undefined, false, ORIGIN),
    services,
    readinessChecks: {},
  });
  servers.push(server);
  const call = async (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) => {
    const response = await server.app.inject({
      method,
      url: `/api/v1${path}`,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, `${method} ${path}: ${response.body}`).toBeLessThan(300);
    return response.json<unknown>();
  };

  const created = emailCampaign.parse(await call('POST', '/email-campaigns', { name: 'Open day' }));
  const draft = emailCampaign.parse(
    await call('PUT', `/email-campaigns/${created.id}`, {
      revision: created.revision,
      name: 'Open day',
      folderId: null,
      mailboxId: toPublicId('mailbox', mailboxId),
      fromName: null,
      replyTo: null,
      subject: 'Come on Saturday, {{contact.firstName}}',
      preheader: null,
      content: { format: 'text', text: 'Dear {{contact.firstName}}, doors open at ten.' },
      audience: { kind: 'all' },
    }),
  );
  expect(
    emailCampaignChecks.parse(await call('GET', `/email-campaigns/${draft.id}/checks`)),
  ).toMatchObject({ canSend: true });

  workers.push(
    await startWorker({
      connectionString: database.url('crm_worker'),
      services,
      tasks: createMessagingDeliveryTasks(
        vault,
        noTexts,
        smtp,
        db,
        ORIGIN,
        undefined,
        campaignOptions({ publicUrl: ORIGIN }),
      ),
      logger: pino({ level: 'silent' }),
      shutdownTimeoutMs: 1000,
    }),
  );

  // A test to the person's own address goes by the worker and reaches nobody else.
  expect(await call('POST', `/email-campaigns/${draft.id}/test`, { to: ['me'] })).toEqual({
    queued: 1,
    to: [user.email],
  });
  await eventually(() => Promise.resolve(handed.length === 1 ? true : undefined));
  expect(handed[0]).toMatchObject({
    to: user.email,
    subject: '[Test] Come on Saturday, {{contact.firstName}}',
    unsubscribeUrl: undefined,
  });

  // Send queues the campaign's own job: the worker fixes the audience and releases the
  // first batch, two of three.
  expect(
    emailCampaign.parse(
      await call('POST', `/email-campaigns/${draft.id}/send`, {
        revision: draft.revision,
        batches: { size: 2, every: 1, unit: 'hours' },
      }),
    ).status,
  ).toBe('sending');
  await eventually(() => Promise.resolve(handed.length === 3 ? true : undefined));
  const waiting = emailCampaign.parse(await call('GET', `/email-campaigns/${draft.id}`));
  expect(waiting.status).toBe('sending');

  // A reply queued now leaves at once, while the campaign's third email waits its batch.
  const reply = await withTenant(db, context, async (trx) => {
    const identity = await trx
      .selectFrom('crm.contact_identities')
      .select('id')
      .where('contact_id', '=', contacts[0] ?? '')
      .executeTakeFirstOrThrow();
    return queueOutboundMessage(trx, context, {
      identityId: identity.id,
      accountId: mailboxId,
      channel: 'email',
      purpose: 'transactional',
      lane: 'reply',
      idempotencyKey: randomUUID(),
      subject: 'Re: parking',
      text: 'Yes, there is parking.',
    });
  });
  expect(reply).toEqual(expect.any(String));
  await eventually(() =>
    Promise.resolve(handed.some((mail) => mail.subject === 'Re: parking') ? true : undefined),
  );

  expect(handed).toHaveLength(4);

  // An hour on, the sweep, as the worker's cron runs it each minute, takes the campaign up
  // again until everyone has been sent to and it is finished.
  await withTenant(db, context, (trx) =>
    sql`update messaging.email_campaigns set started_at = started_at - interval '61 minutes'`.execute(
      trx,
    ),
  );
  const sent = await eventually(async () => {
    await withTenant(db, context, (trx) =>
      sql`update messaging.email_campaigns set next_run_at = now() where next_run_at is not null`.execute(
        trx,
      ),
    );
    await scheduleEmailCampaigns(services);
    const now = emailCampaign.parse(await call('GET', `/email-campaigns/${draft.id}`));
    return now.status === 'sent' ? now : undefined;
  });
  expect(sent.counts).toMatchObject({ audience: 3, sent: 3, skipped: 0, failed: 0, pending: 0 });

  const campaignMail = handed.filter((mail) => mail.subject.startsWith('Come on Saturday'));
  expect(campaignMail.map((mail) => mail.subject).sort()).toEqual(
    names.map((name) => `Come on Saturday, ${name}`).sort(),
  );
  expect(new Set(campaignMail.map((mail) => mail.to)).size).toBe(3);
  for (const mail of campaignMail) {
    expect(mail.unsubscribeUrl).toMatch(new RegExp(`^${ORIGIN}/unsubscribe/[A-Za-z0-9_-]{43}$`));
    expect(mail.text).toContain(`Unsubscribe: ${mail.unsubscribeUrl ?? ''}`);
  }
  // The test, two of the campaign, the reply, then the campaign's last.
  expect(handed.map((mail) => mail.subject).indexOf('Re: parking')).toBe(3);
  expect(handed).toHaveLength(5);

  expect(
    emailCampaignStats.parse(await call('GET', `/email-campaigns/${draft.id}/stats`)),
  ).toMatchObject({ audience: 3, sent: 3, skipped: 0, unsubscribed: 0, bounced: 0 });
  const listed = emailCampaignRecipientList.parse(
    await call('GET', `/email-campaigns/${draft.id}/recipients?status=sent`),
  );
  expect(listed.items).toHaveLength(3);
});
