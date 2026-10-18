// What the two suites that try every endpoint need for email campaigns: a campaign and a
// folder of a business, added directly so each test pays one round trip; an input for each
// operation that the business's own member could send and have accepted; and an example of
// every command for the permission matrix.
import { toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import type { LightMyRequestResponse } from 'fastify';

export interface CampaignRecords {
  readonly email_campaign: string;
  readonly email_campaign_folder: string;
}

type Status = 'draft' | 'scheduled' | 'sending' | 'paused';

/**
 * A campaign of the business in this status, at revision 1, that passes every check: its
 * own mailbox, switched on for campaigns with a finished setup check that passes, and one
 * contact in its audience who consented and whose time zone is known.
 */
export async function addCampaignRecords(
  database: TestDatabase,
  businessId: string,
  status: Status = 'draft',
): Promise<CampaignRecords> {
  const row = await database.as('crm_owner', async (sql) => {
    // Every campaign email ends with the business's postal address.
    await sql.query(
      `update tenancy.businesses
       set address = '{"line1":"12 High St","city":"Austin","region":"TX","postalCode":"78701","country":"US"}'::jsonb
       where id = $1`,
      [businessId],
    );
    const mailbox = await sql.one<{ id: string }>(
      `with secret as (
         insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         select b.agency_id, b.id, 'mailbox.credentials', 1,
           decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')
         from tenancy.businesses b where b.id = $1 returning id
       ), channel as (
         insert into messaging.channel_accounts (business_id, channel, name)
         values ($1, 'email', 'Campaign mailbox') returning id
       ), box as (
         insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
           smtp_port, smtp_security, smtp_username, secret_id, use_for_campaigns)
         select $1, channel.id, 'news-' || channel.id::text || '@example.test', 'password',
           'mail.example.test', 465, 'tls', 'news', secret.id, true
         from channel, secret returning id
       ), run as (
         insert into messaging.mailbox_check_runs (business_id, mailbox_id, trigger, method, score, finished_at)
         select $1, box.id, 'manual', 'self', 100, now() from box returning id
       ), results as (
         insert into messaging.mailbox_check_results
           (business_id, run_id, check_key, status, points_awarded, points_possible, details)
         select $1, run.id, c.key, 'pass', c.points, c.points, '{"reason":"fixture"}'::jsonb
         from run, (values ('spf', 15), ('dkim', 20), ('dmarc', 14), ('unsubscribe', 6)) c (key, points)
       )
       select id from box`,
      [businessId],
    );
    await sql.query(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         select $1, 'contact', id from crm.object_types where business_id = $1 and kind = 'contact'
         returning id
       ), person as (
         insert into crm.contacts (business_id, id, first_name, timezone, created_by_kind)
         select $1, id, 'Reader', 'UTC', 'system' from record returning id
       ), address as (
         insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
         select $1, id, 'email', 'reader-' || id::text || '@example.test',
           'reader-' || id::text || '@example.test', true from person
       )
       insert into messaging.consents
         (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       select $1, id, 'email', 'marketing', 'granted', 'user', 'system' from person`,
      [businessId],
    );
    return sql.one<{ campaign: string; folder: string }>(
      `with folder as (
         insert into messaging.template_folders (business_id, name, kind, created_by_kind)
         values ($1, 'Folder ' || uuidv7()::text, 'campaign', 'system') returning id
       ), campaign as (
         insert into messaging.email_campaigns
           (business_id, name, folder_id, mailbox_id, subject, body_text, audience, status,
            send_at, next_run_at, started_at, started_by_kind, created_by_kind)
         select $1, 'Business B only', folder.id, $2, 'Hello', 'Come along.', '{"kind":"all"}'::jsonb,
           $3,
           case when $3 = 'scheduled' then now() + interval '1 day' end,
           case when $3 = 'scheduled' then now() + interval '1 day' end,
           case when $3 in ('sending', 'paused') then now() end,
           case when $3 <> 'draft' then 'system' end,
           'system'
         from folder returning id
       )
       select campaign.id as campaign, folder.id as folder from campaign, folder`,
      [businessId, mailbox.id, status],
    );
  });
  return {
    email_campaign: toPublicId('email_campaign', row.campaign),
    email_campaign_folder: toPublicId('email_campaign_folder', row.folder),
  };
}

const draftOf = (records: Readonly<Record<string, string>>) => ({
  revision: 1,
  name: 'Reached from A',
  folderId: null,
  mailboxId: null,
  fromName: null,
  replyTo: null,
  subject: 'Hello',
  preheader: null,
  content: { format: 'text', text: 'Come along.' },
  audience: { kind: 'smart_list', viewId: records['saved_view'] },
});

const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString();

/** What B's own member could send about B's campaign and its folder and have accepted. */
export function campaignInputs(
  records: Readonly<Record<string, string>>,
): Readonly<Record<string, { payload?: unknown; query?: string }>> {
  return {
    listEmailCampaigns: { query: `?folder=${records['email_campaign_folder'] ?? ''}` },
    createEmailCampaign: {
      payload: {
        name: 'Reached from A',
        folderId: records['email_campaign_folder'],
        source: { kind: 'campaign', campaignId: records['email_campaign'] },
      },
    },
    updateEmailCampaign: { payload: draftOf(records) },
    deleteEmailCampaign: { payload: { revision: 1 } },
    moveEmailCampaign: { payload: { folderId: records['email_campaign_folder'] } },
    sendEmailCampaignTest: { payload: { to: ['me'], contactId: records['contact'] } },
    sendEmailCampaign: { payload: { revision: 1 } },
    scheduleEmailCampaign: { payload: { revision: 1, sendAt: inAnHour() } },
    createEmailCampaignFolder: {
      payload: { name: 'Reached from A', parentId: records['email_campaign_folder'] },
    },
    updateEmailCampaignFolder: { payload: { revision: 1, name: 'Reached from A' } },
    removeEmailCampaignFolder: { payload: { revision: 1 } },
    updateEmailCampaignSettings: { payload: { dailyLimit: 100 } },
  };
}

type Call = (
  method: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'DELETE',
  path: string,
  options: { payload: unknown; type?: string; inBusiness: boolean },
) => Promise<LightMyRequestResponse>;

interface Example {
  readonly run: (call: Call, run: number) => Promise<LightMyRequestResponse>;
}

/** An example of every campaign command, each on a campaign added for that try. */
export function campaignExamples(
  database: () => TestDatabase,
  business: () => string,
): Readonly<Record<string, Example>> {
  const fresh = (status: Status = 'draft') => addCampaignRecords(database(), business(), status);
  const here = (payload: unknown) => ({ inBusiness: true, payload });
  const on = async (status: Status, action: string, call: Call, payload: unknown = {}) =>
    call(
      'POST',
      `/email-campaigns/${(await fresh(status)).email_campaign}/${action}`,
      here(payload),
    );
  return {
    'campaign.create': {
      run: (call, run) => call('POST', '/email-campaigns', here({ name: `Matrix ${String(run)}` })),
    },
    'campaign.update': {
      run: async (call) =>
        call(
          'PUT',
          `/email-campaigns/${(await fresh()).email_campaign}`,
          here({ ...draftOf({}), audience: { kind: 'all' } }),
        ),
    },
    'campaign.delete': {
      run: async (call) =>
        call('DELETE', `/email-campaigns/${(await fresh()).email_campaign}`, here({ revision: 1 })),
    },
    'campaign.move': {
      run: async (call) =>
        call(
          'PUT',
          `/email-campaigns/${(await fresh()).email_campaign}/folder`,
          here({ folderId: null }),
        ),
    },
    // To the person's own address: what someone who may only write campaigns may do.
    'campaign.test': { run: (call) => on('draft', 'test', call, { to: ['me'] }) },
    'campaign.send': { run: (call) => on('draft', 'send', call, { revision: 1 }) },
    'campaign.schedule': {
      run: (call) => on('draft', 'schedule', call, { revision: 1, sendAt: inAnHour() }),
    },
    'campaign.pause': { run: (call) => on('sending', 'pause', call) },
    'campaign.resume': { run: (call) => on('paused', 'resume', call) },
    'campaign.cancel': { run: (call) => on('scheduled', 'cancel', call) },
    'campaign.settings': {
      run: (call) => call('PUT', '/email-campaign-settings', here({ dailyLimit: 500 })),
    },
    'campaign.create_folder': {
      run: (call, run) =>
        call('POST', '/email-campaign-folders', here({ name: `Matrix ${String(run)}` })),
    },
    'campaign.update_folder': {
      run: async (call, run) =>
        call(
          'PATCH',
          `/email-campaign-folders/${(await fresh()).email_campaign_folder}`,
          here({ revision: 1, name: `Renamed ${String(run)}` }),
        ),
    },
    'campaign.remove_folder': {
      run: async (call) =>
        call(
          'DELETE',
          `/email-campaign-folders/${(await fresh()).email_campaign_folder}`,
          here({ revision: 1 }),
        ),
    },
  };
}

/** Sending and its controls (campaigns.send) and the ceiling (mailboxes.manage): owners' and admins'. */
export const CAMPAIGN_SEND_COMMANDS: readonly string[] = [
  'campaign.send',
  'campaign.schedule',
  'campaign.pause',
  'campaign.resume',
  'campaign.cancel',
  'campaign.settings',
];

/** Writing campaigns and filing them (campaigns.manage): members' too, and not a viewer's. */
export const CAMPAIGN_DRAFT_COMMANDS: readonly string[] = [
  'campaign.create',
  'campaign.update',
  'campaign.delete',
  'campaign.move',
  'campaign.test',
  'campaign.create_folder',
  'campaign.update_folder',
  'campaign.remove_folder',
];
