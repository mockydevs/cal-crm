// A business ready to send campaigns, for the integration tests: a mailbox whose setup
// checks pass, contacts with and without consent, a stand-in for the mail server that keeps
// what it was handed, and helpers that run the campaign task and the dispatch task by hand.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import type { EmailCampaign, Permission, UpdateEmailCampaignInput } from '@repo/contracts';
import { withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import type { MailboxSubmitter } from '@repo/mail';
import type { Vault } from '@repo/module-vault';
import type { TestDatabase } from '@repo/testing';
import { sql } from 'kysely';

import { createCampaignTestCommand, createSendCampaignTestTask } from '../src/campaign-tests.js';
import { runEmailCampaign } from '../src/campaign-run.js';
import type { CampaignOptions, CampaignRow } from '../src/campaign-store.js';
import { createCampaignCommands } from '../src/campaigns.js';
import { createSmtpDispatchTask } from '../src/smtp-outbound.js';

export const PUBLIC_URL = 'https://crm.example.test';

export interface Handed {
  readonly from: { readonly address: string; readonly name: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
  readonly unsubscribeUrl?: string | undefined;
  readonly replyTo?: string | undefined;
}

export interface ContactOptions {
  readonly firstName?: string;
  readonly email?: string | null;
  readonly consent?: 'granted' | 'withdrawn' | 'none';
  readonly tagged?: boolean;
  readonly timezone?: string;
}

export type CampaignWorld = Awaited<ReturnType<typeof buildWorld>>;
interface WorldSetup {
  readonly publicUrl?: string | undefined;
  readonly agencyDailyLimit?: number;
}

/** A business with a campaign mailbox, and the helpers the tests drive it with. */
export function campaignWorld(
  database: TestDatabase,
  db: Database,
  vault: Vault,
  setup: WorldSetup = {},
): Promise<CampaignWorld> {
  return buildWorld(database, db, vault, setup);
}

async function buildWorld(database: TestDatabase, db: Database, vault: Vault, setup: WorldSetup) {
  const services: Services = { db, authorize: allowEveryone };
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  // Every campaign email ends with the business's postal address.
  await database.as('postgres', (sql) =>
    sql.query(`update tenancy.businesses set address = $1::jsonb where id = $2`, [
      JSON.stringify({
        line1: '12 High St',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
      }),
      business.id,
    ]),
  );
  const user = await database.fixtures.user();
  const context = {
    ...business.context,
    actorKind: 'user' as const,
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  const as = (granted: readonly Permission[] | 'all' = 'all'): Invocation => ({
    context: { ...context, correlationId: randomUUID() },
    permissions: granted === 'all' ? 'all' : new Set(granted),
  });
  const system: Invocation = {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: 'all',
  };
  const inTenant = <Result>(work: Parameters<typeof withTenant<Result>>[2]) =>
    withTenant(db, context, work);

  const handed: Handed[] = [];
  /** What the stand-in answers next; 'accepted' unless a test says otherwise. */
  const mailServer = { outcome: 'accepted' as 'accepted' | 'rejected' | 'throws' };
  const submitter: MailboxSubmitter = {
    submit(_login, from, message) {
      if (mailServer.outcome === 'throws') return Promise.reject(new Error('connection lost'));
      if (mailServer.outcome === 'rejected')
        return Promise.resolve({ outcome: 'rejected', temporary: false });
      handed.push({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        unsubscribeUrl: message.unsubscribeUrl,
        replyTo: message.replyTo,
      });
      return Promise.resolve({ outcome: 'accepted', messageId: message.messageId });
    },
  };

  const credentials = {
    name: 'Campaign mailbox',
    email: 'news@example.test',
    displayName: 'Harbor Lights',
    smtp: { host: 'localhost', port: 465, security: 'tls', username: 'u', password: 'p' },
    imap: { host: 'localhost', port: 993, security: 'tls', username: 'u', password: 'p' },
  };
  const { mailboxId, tagId } = await inTenant(async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
      JSON.stringify(credentials),
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: business.id, channel: 'email', name: credentials.name })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        business_id: business.id,
        id: account.id,
        email_address: credentials.email,
        display_name: credentials.displayName,
        auth_method: 'password',
        smtp_host: 'localhost',
        smtp_port: 465,
        smtp_security: 'tls',
        smtp_username: 'u',
        secret_id: secretId,
        use_for_campaigns: true,
        use_for_conversations: false,
        warmup_enabled: false,
        daily_limit: 1000,
        pacing_per_minute: 600,
      })
      .execute();
    await trx
      .insertInto('messaging.settings')
      .values({ business_id: business.id, quiet_hours_enabled: false })
      .execute();
    const tag = await trx
      .insertInto('crm.tags')
      .values({ business_id: business.id, name: 'VIP', created_by_kind: 'user' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { mailboxId: account.id, tagId: tag.id };
  });

  /** The latest finished setup check of the mailbox, with these verdicts. */
  async function setupChecked(
    verdicts: Readonly<Record<string, string>> = {
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      unsubscribe: 'pass',
    },
  ): Promise<void> {
    await inTenant(async (trx) => {
      const run = await trx
        .insertInto('messaging.mailbox_check_runs')
        .values({
          business_id: business.id,
          mailbox_id: mailboxId,
          trigger: 'manual',
          method: 'self',
          score: 90,
          finished_at: sql`now()`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const points: Readonly<Record<string, number>> = {
        spf: 15,
        dkim: 20,
        dmarc: 14,
        unsubscribe: 6,
      };
      for (const [key, status] of Object.entries(verdicts))
        await trx
          .insertInto('messaging.mailbox_check_results')
          .values({
            business_id: business.id,
            run_id: run.id,
            check_key: key,
            status,
            points_possible: points[key] ?? 0,
            points_awarded: status === 'pass' ? (points[key] ?? 0) : 0,
            details: JSON.stringify({ reason: 'fixture' }),
          })
          .execute();
    });
  }
  await setupChecked();

  async function contact(options: ContactOptions = {}): Promise<string> {
    const email =
      options.email === null ? undefined : (options.email ?? `c.${randomUUID()}@example.test`);
    const created = await database.fixtures.contact(context, {
      firstName: options.firstName ?? 'Ada',
      ...(email === undefined ? {} : { email }),
    });
    await inTenant(async (trx) => {
      if (options.timezone !== undefined)
        await trx
          .updateTable('crm.contacts')
          .set({ timezone: options.timezone })
          .where('id', '=', created.id)
          .execute();
      if (options.tagged !== false)
        await trx
          .insertInto('crm.record_tags')
          .values({
            business_id: business.id,
            record_id: created.id,
            tag_id: tagId,
            source_kind: 'user',
          })
          .execute();
      if ((options.consent ?? 'granted') !== 'none')
        await trx
          .insertInto('messaging.consents')
          .values({
            business_id: business.id,
            contact_id: created.id,
            channel: 'email',
            purpose: 'marketing',
            status: options.consent ?? 'granted',
            source: 'user',
            recorded_by_kind: 'system',
          })
          .execute();
    });
    return created.id;
  }

  const options: CampaignOptions & { failOn?: string } = {
    async values(trx, contactId) {
      if (options.failOn === contactId) {
        delete options.failOn;
        throw new Error('the worker died');
      }
      const row = await trx
        .selectFrom('crm.contacts')
        .select(['first_name', 'last_name'])
        .where('id', '=', contactId)
        .executeTakeFirstOrThrow();
      return { 'contact.firstName': row.first_name, 'contact.lastName': row.last_name };
    },
    fields: () => Promise.resolve(['contact.firstName', 'contact.lastName']),
    publicUrl: 'publicUrl' in setup ? setup.publicUrl : PUBLIC_URL,
    team: () => Promise.resolve(new Map([[user.id, { email: user.email }]])),
    ...(setup.agencyDailyLimit === undefined ? {} : { agencyDailyLimit: setup.agencyDailyLimit }),
  };
  const commands = createCampaignCommands(options);
  const test = createCampaignTestCommand(options);
  const testTask = createSendCampaignTestTask(vault, submitter, options);
  const dispatchTask = createSmtpDispatchTask(vault, submitter, db, PUBLIC_URL);

  const tagAudience = {
    kind: 'tags' as const,
    tagIds: [toPublicId('tag', tagId)],
    match: 'any' as const,
  };

  /** A draft that passes its checks, unless the changes say otherwise. */
  async function draft(
    changes: Partial<Omit<UpdateEmailCampaignInput, 'revision'>> = {},
    invocation: Invocation = as(),
  ): Promise<EmailCampaign> {
    const created = await runCommand(
      services,
      commands.create,
      { name: 'Spring open day' },
      invocation,
    );
    return runCommand(
      services,
      commands.update,
      {
        id: created.id,
        revision: created.revision,
        name: created.name,
        folderId: null,
        mailboxId: toPublicId('mailbox', mailboxId),
        fromName: null,
        replyTo: null,
        subject: 'Hello {{contact.firstName}}',
        preheader: null,
        content: { format: 'text', text: 'Dear {{contact.firstName}}, come along.' },
        audience: tagAudience,
        ...changes,
      },
      invocation,
    );
  }

  const uuidOf = (campaign: Pick<EmailCampaign, 'id'>): string =>
    parsePublicId('email_campaign', campaign.id) ?? '';

  /** One run of the campaign task. */
  const tick = (campaign: Pick<EmailCampaign, 'id'>) =>
    runEmailCampaign(services, system, uuidOf(campaign), options);

  /**
   * Runs the dispatch task for every queued message, replies first as the queue would, one
   * pacing interval apart. Gives how many it ran.
   */
  async function dispatch(): Promise<number> {
    const queued = await inTenant((trx) =>
      trx
        .selectFrom('messaging.messages')
        .select('id')
        .where('direction', '=', 'outbound')
        .where('status', '=', 'queued')
        .orderBy('priority')
        .orderBy('id')
        .execute(),
    );
    for (const { id } of queued) {
      await dispatchTask.run({ messageId: id }, { invocation: system, services });
      await delay(110);
    }
    return queued.length;
  }

  /** Runs the task and the dispatch in turn until the campaign rests in `status`. */
  async function drive(campaign: Pick<EmailCampaign, 'id'>, status = 'sent'): Promise<void> {
    for (let round = 0; round < 40; round += 1) {
      await tick(campaign);
      if ((await row(campaign)).status === status) return;
      await dispatch();
    }
    throw new Error(`The campaign did not reach ${status}.`);
  }

  const row = (campaign: Pick<EmailCampaign, 'id'>): Promise<CampaignRow> =>
    inTenant((trx) =>
      trx
        .selectFrom('messaging.email_campaigns')
        .selectAll()
        .where('id', '=', uuidOf(campaign))
        .executeTakeFirstOrThrow(),
    );

  const recipients = (campaign: Pick<EmailCampaign, 'id'>) =>
    inTenant((trx) =>
      trx
        .selectFrom('messaging.email_campaign_recipients')
        .select(['contact_id', 'status', 'reason', 'batch', 'message_id', 'fields'])
        .where('campaign_id', '=', uuidOf(campaign))
        .orderBy('contact_id')
        .execute(),
    );

  /** Moves a campaign's own clock back, as if this much time had passed since it started. */
  const elapse = (campaign: Pick<EmailCampaign, 'id'>, interval: string) =>
    inTenant((trx) =>
      sql`update messaging.email_campaigns
          set started_at = started_at - ${interval}::interval, send_at = send_at - ${interval}::interval
          where id = ${uuidOf(campaign)}`.execute(trx),
    );

  return {
    services,
    agency,
    business,
    user,
    context,
    as,
    system,
    inTenant,
    handed,
    mailServer,
    submitter,
    mailboxId,
    tagId,
    tagAudience,
    setupChecked,
    contact,
    options,
    commands,
    test,
    testTask,
    dispatchTask,
    draft,
    uuidOf,
    tick,
    dispatch,
    drive,
    row,
    recipients,
    elapse,
    send: (campaign: EmailCampaign, batches: unknown = null, invocation: Invocation = as()) =>
      runCommand(
        services,
        commands.send,
        { id: campaign.id, revision: campaign.revision, batches },
        invocation,
      ),
  };
}
